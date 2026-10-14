import { useEffect, useRef, useState } from "react";
import type { Core, ElementDefinition } from "cytoscape";
import type { GraphData } from "../data/types";
import { cssVar, THEME_EVENT } from "../theme";
import { useI18n } from "../i18n";
import { BootSplash } from "./BootSplash";
import "./GraphView.css";

type Props = {
  full: GraphData;
  visibleIds: Set<string>;
  selected: string | null;
  withData: Set<string>;
  onSelect: (id: string | null) => void;
  /** Fired once after the full graph has been painted and fitted. */
  onReady?: () => void;
  clusterLine?: (comp: string) => string;
};

const STORY: Record<string, string> = {
  "decreto-legge-112-del-25-06-2008.txt": "#a14b52",
  "decreto-legislativo-179-del-01-12-2009.txt": "#3d7a6a",
};

const REST = ["#3d6a8a", "#5a86a4", "#6a7a8a", "#7a9a6a", "#8a6a8a", "#9a6b2f"];

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

function prettySlug(id: string) {
  return id
    .replace(/\.txt$/i, "")
    .replace(/-/g, " ")
    .replace(/\bdel\b/g, "del")
    .trim();
}

function packComponents(
  clusters: {
    id: string;
    radius: number;
    cx?: number;
    cy?: number;
    local: Record<string, { dx: number; dy: number }>;
  }[],
  aspect: number,
) {
  const placed: typeof clusters = [];
  for (const c of clusters) {
    if (placed.length === 0) {
      c.cx = 0;
      c.cy = 0;
      placed.push(c);
      continue;
    }
    const step = Math.max(8, c.radius * 0.3);
    let done = false;
    for (let t = 1; t < 40000; t += 1) {
      const ang = t * GOLDEN;
      const rad = step * Math.sqrt(t);
      const cx = Math.cos(ang) * rad * aspect;
      const cy = Math.sin(ang) * rad;
      let ok = true;
      for (const p of placed) {
        const dx = cx - (p.cx || 0);
        const dy = cy - (p.cy || 0);
        const need = c.radius + p.radius + 26;
        if (dx * dx + dy * dy < need * need) {
          ok = false;
          break;
        }
      }
      if (ok) {
        c.cx = cx;
        c.cy = cy;
        placed.push(c);
        done = true;
        break;
      }
    }
    if (!done) {
      c.cx = 0;
      c.cy = 0;
      placed.push(c);
    }
  }
}

/** One-time placement: JSON x/y are local to each component; pack components once. */
function bakedPositions(g: GraphData, aspect: number) {
  const byComp: Record<
    string,
    {
      id: string;
      radius: number;
      cx?: number;
      cy?: number;
      local: Record<string, { dx: number; dy: number }>;
    }
  > = {};
  for (const n of g.nodes) {
    let c = byComp[n.comp];
    if (!c) {
      c = { id: n.comp, radius: n.compR || 1, local: {} };
      byComp[n.comp] = c;
    }
    c.local[n.id] = { dx: n.x || 0, dy: n.y || 0 };
  }
  const clusters = Object.values(byComp).sort((a, b) => b.radius - a.radius);
  packComponents(clusters, aspect);
  const pos: Record<string, { x: number; y: number }> = {};
  for (const cl of clusters) {
    for (const [id, loc] of Object.entries(cl.local)) {
      pos[id] = { x: (cl.cx || 0) + loc.dx, y: (cl.cy || 0) + loc.dy };
    }
  }
  return pos;
}

function componentColors(g: GraphData) {
  const parent: Record<string, string> = {};
  const find = (x: string): string => {
    if (parent[x] === undefined) parent[x] = x;
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };
  for (const n of g.nodes) find(n.id);
  for (const e of g.edges) {
    const a = find(e.source);
    const b = find(e.target);
    if (a !== b) parent[a] = b;
  }
  const members: Record<string, string[]> = {};
  for (const n of g.nodes) {
    const r = find(n.id);
    (members[r] ||= []).push(n.id);
  }
  const roots = Object.keys(members).sort(
    (a, b) => members[b].length - members[a].length,
  );
  const colourOf: Record<string, string> = {};
  let restIdx = 0;
  for (const r of roots) {
    let story: string | null = null;
    for (const id of members[r]) {
      if (STORY[id]) {
        story = STORY[id];
        break;
      }
    }
    colourOf[r] = story ?? REST[restIdx++ % REST.length];
  }
  const byNode: Record<string, string> = {};
  for (const n of g.nodes) byNode[n.id] = colourOf[find(n.id)];
  return byNode;
}

function buildAllElements(
  full: GraphData,
  withData: Set<string>,
  aspect: number,
): ElementDefinition[] {
  const pos = bakedPositions(full, aspect);
  const colours = componentColors(full);
  const ordered = [...full.nodes].sort(
    (a, b) => Number(withData.has(a.id)) - Number(withData.has(b.id)),
  );

  return [
    ...ordered.map((n) => {
      const clickable = withData.has(n.id);
      const base = n.hub
        ? 14 + Math.min(26, Math.log(Math.max(n.degree, 2)) * 4)
        : 5;
      const size = clickable ? Math.max(base, n.hub ? base : 11) : base;
      return {
        data: {
          id: n.id,
          label: n.hub && n.label ? n.label : "",
          name: n.label || prettySlug(n.id),
          comp: n.comp,
          hasData: clickable ? 1 : 0,
          degree: n.degree,
          color: colours[n.id] || REST[0],
          size,
        },
        position: pos[n.id] || { x: n.x, y: n.y },
      };
    }),
    ...full.edges.map((e, i) => ({
      data: { id: `e${i}`, source: e.source, target: e.target },
    })),
  ];
}

function cyThemeStyle() {
  const ink = cssVar("--ink", "#1a2433");
  const line = cssVar("--line", "#b7c4d0");
  return [
    {
      selector: "node",
      style: {
        label: "data(label)",
        "background-color": "data(color)",
        width: "data(size)",
        height: "data(size)",
        color: ink,
        "font-size": 10,
        "font-family": "Figtree, sans-serif",
        "text-valign": "top",
        "text-margin-y": -6,
        "border-width": 0,
        cursor: "default",
        "z-index-compare": "manual",
        "z-index": 5,
      },
    },
    {
      selector: "node[hasData = 1]",
      style: {
        cursor: "pointer",
        "border-width": 3.5,
        "border-color": "#fffef8",
        "border-opacity": 1,
        "background-opacity": 1,
        "z-index": 20,
      },
    },
    {
      selector: "edge",
      style: {
        width: 0.6,
        "line-color": line,
        "curve-style": "haystack",
        "haystack-radius": 0.4,
        "z-index-compare": "manual",
        "z-index": 1,
      },
    },
    {
      selector: "node:selected",
      style: {
        "border-width": 2.5,
        "border-color": ink,
        "z-index": 30,
      },
    },
    {
      selector: ".hidden",
      style: {
        display: "none",
      },
    },
  ];
}

function applyVisibility(cy: Core, visibleIds: Set<string>) {
  cy.batch(() => {
    cy.nodes().forEach((n) => {
      n.toggleClass("hidden", !visibleIds.has(n.id()));
    });
    cy.edges().forEach((e) => {
      const show =
        visibleIds.has(e.source().id()) && visibleIds.has(e.target().id());
      e.toggleClass("hidden", !show);
    });
  });
}

/** Fit the full baked layout (including currently filtered-out nodes). */
function fitEntireGraph(cy: Core, visibleIds: Set<string>) {
  cy.batch(() => {
    cy.elements().removeClass("hidden");
  });
  cy.fit(undefined, 24);
  applyVisibility(cy, visibleIds);
}

type Tip = { text: string; x: number; y: number };

export function GraphView({
  full,
  visibleIds,
  selected,
  withData,
  onSelect,
  onReady,
  clusterLine,
}: Props) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const clusterLineRef = useRef(clusterLine);
  clusterLineRef.current = clusterLine;
  const blameNodeRef = useRef(t("explore.blameNode"));
  blameNodeRef.current = t("explore.blameNode");
  const visibleRef = useRef(visibleIds);
  visibleRef.current = visibleIds;
  const loadedRef = useRef(false);
  const [tip, setTip] = useState<Tip | null>(null);
  const [busy, setBusy] = useState(true);

  // Create cytoscape once; bind events once.
  useEffect(() => {
    let cancelled = false;
    let cy: Core | null = null;

    async function create() {
      const el = ref.current;
      if (!el) return;
      const cytoscape = (await import("cytoscape")).default;
      if (cancelled || !ref.current) return;

      cy = cytoscape({
        container: el,
        elements: [],
        layout: { name: "preset" },
        style: cyThemeStyle() as never,
        wheelSensitivity: 0.25,
      });

      const placeTip = (node: {
        renderedPosition: () => { x: number; y: number };
        data: (k: string) => unknown;
        id: () => string;
      }) => {
        const rp = node.renderedPosition();
        const name = String(node.data("name") || node.id());
        const comp = String(node.data("comp") || "");
        const cluster = comp && clusterLineRef.current ? clusterLineRef.current(comp) : "";
        const click = node.data("hasData") === 1 ? `\n${blameNodeRef.current}` : "";
        setTip({
          text: cluster ? `${cluster}\n${name}${click}` : `${name}${click}`,
          x: rp.x,
          y: Math.max(8, rp.y - 14),
        });
      };

      cy.on("mouseover", "node", (evt) => placeTip(evt.target));
      cy.on("mousemove", "node", (evt) => placeTip(evt.target));
      cy.on("mouseout", "node", () => setTip(null));
      cy.on("tap", "node", (evt) => {
        if (evt.target.data("hasData") !== 1) return;
        onSelectRef.current(evt.target.id());
      });
      cy.on("tap", (evt) => {
        if (evt.target === cy) onSelectRef.current(null);
      });

      cyRef.current = cy;
    }

    void create();
    return () => {
      cancelled = true;
      setTip(null);
      loadedRef.current = false;
      cy?.destroy();
      cyRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onTheme = () => {
      const cy = cyRef.current;
      if (!cy || cy.destroyed()) return;
      cy.style().fromJson(cyThemeStyle() as never).update();
    };
    window.addEventListener(THEME_EVENT, onTheme);
    return () => window.removeEventListener(THEME_EVENT, onTheme);
  }, []);

  // Load full graph once — JSON positions, preset layout, fit once.
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    loadedRef.current = false;

    async function load() {
      const el = ref.current;
      let tries = 0;
      while (!cyRef.current && tries < 80) {
        await new Promise((r) => setTimeout(r, 25));
        tries += 1;
        if (cancelled) return;
      }
      const cy = cyRef.current;
      if (!cy || cy.destroyed() || !el) return;

      const aspect = Math.max(1, el.clientWidth / Math.max(el.clientHeight, 1));
      const elements = buildAllElements(full, withData, aspect);

      cy.batch(() => {
        cy.elements().remove();
        cy.add(elements);
      });
      // Fit while everything is visible so the camera covers the full baked layout;
      // year filters only toggle display and must not re-fit.
      cy.fit(undefined, 24);
      applyVisibility(cy, visibleRef.current);

      if (!cancelled) {
        loadedRef.current = true;
        setBusy(false);
        onReadyRef.current?.();
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
    // withData is stable after load; full is the graph payload
  }, [full, withData]);

  // Year / filter changes: show/hide only — never re-layout or re-fit.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || cy.destroyed() || !loadedRef.current || busy) return;
    setTip(null);
    applyVisibility(cy, visibleIds);
  }, [visibleIds, busy]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || cy.destroyed() || busy) return;
    cy.nodes().unselect();
    if (selected) cy.getElementById(selected).select();
  }, [selected, busy]);

  const fitGraph = () => {
    const cy = cyRef.current;
    if (!cy || cy.destroyed() || !loadedRef.current || busy) return;
    fitEntireGraph(cy, visibleRef.current);
  };

  return (
    <div className="graph-view-wrap" ref={wrapRef}>
      <div className="graph-view" ref={ref} />
      {!busy ? (
        <button
          type="button"
          className="graph-fit-btn"
          onClick={fitGraph}
          aria-label={t("explore.fitGraph")}
          title={t("explore.fitGraph")}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"
            />
          </svg>
        </button>
      ) : null}
      {tip && !busy ? (
        <div
          className="graph-tip"
          style={{ left: tip.x, top: tip.y }}
          role="tooltip"
        >
          {tip.text}
        </div>
      ) : null}
      {busy ? (
        <div className="graph-busy">
          <BootSplash compact quiet message={t("explore.loadingGraph")} />
        </div>
      ) : null}
    </div>
  );
}
