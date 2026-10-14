import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActsIndex, GraphData, TalkData } from "../data/types";
import { resolveEnactDate } from "../data/enact";
import { loadActs, loadBlameIndex, loadGraph } from "../data/load";
import { cannedClusterLine, clusterFacts } from "../digesto/clusters";
import type { RemixSpec } from "../digesto/remix";
import { formatNumber, useI18n } from "../i18n";
import { GraphView } from "./GraphView";
import { TimeBrush } from "./TimeBrush";
import { RevisionDrawer } from "./RevisionDrawer";
import { BootSplash } from "./BootSplash";
import "./Explore.css";

type Props = {
  data: TalkData;
  onRemix?: (spec: RemixSpec, clusterComp?: string) => void;
};

/** Must match MIN_COMPONENT in codemotion-milan/build-graph.mjs */
const GRAPH_MIN_COMPONENT = 5;

const PLAY_MS = 500;

function visibleSlugs(acts: ActsIndex, asOfDate: string): Set<string> {
  const out = new Set<string>();
  for (const a of acts.acts) {
    const enactDate = resolveEnactDate(a);
    // No date → omit (unresolved codes used to leak into every year).
    if (!enactDate || enactDate > asOfDate) continue;
    if (a.decadutoDate && a.decadutoDate <= asOfDate) continue;
    out.add(a.slug);
  }
  return out;
}

function clampYear(y: number, min: number, max: number) {
  return Math.min(max, Math.max(min, y));
}

export function Explore({ data, onRemix }: Props) {
  const { t, locale } = useI18n();
  const minYear = data.dateRange.firstEnactYear;
  const maxYear = data.dateRange.lastEnactYear;
  const corpusActs = data.totals.acts;
  const [year, setYear] = useState(minYear);
  const [playing, setPlaying] = useState(false);
  const [graphReady, setGraphReady] = useState(false);
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [acts, setActs] = useState<ActsIndex | null>(null);
  const [withData, setWithData] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const autoplayStarted = useRef(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadGraph(), loadActs(), loadBlameIndex()])
      .then(([g, a, blame]) => {
        if (cancelled) return;
        setGraph(g);
        setActs(a);
        setWithData(blame);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const asOfDate = `${year}-12-31`;
  const visible = useMemo(() => {
    if (!acts) return null;
    return visibleSlugs(acts, asOfDate);
  }, [acts, asOfDate]);

  const counts = useMemo(() => {
    if (!graph || !visible) return { nodes: 0, edges: 0 };
    let nodes = 0;
    for (const n of graph.nodes) {
      if (visible.has(n.id)) nodes += 1;
    }
    let edges = 0;
    for (const e of graph.edges) {
      if (visible.has(e.source) && visible.has(e.target)) edges += 1;
    }
    return { nodes, edges };
  }, [graph, visible]);

  const clusters = useMemo(
    () => (graph && acts ? clusterFacts(graph, acts) : new Map()),
    [graph, acts],
  );

  const selectedNode = graph && selected ? graph.nodes.find((n) => n.id === selected) : null;
  const selectedAct = acts && selected ? acts.acts.find((a) => a.slug === selected) : null;

  const clusterLine = useCallback(
    (comp: string) => {
      const facts = clusters.get(comp);
      if (!facts) return "";
      return cannedClusterLine(facts, locale);
    },
    [clusters, locale],
  );

  const onGraphReady = useCallback(() => {
    setGraphReady(true);
  }, []);

  // After first paint, start autoplay once (1 year / tick).
  useEffect(() => {
    if (!graphReady || autoplayStarted.current) return;
    autoplayStarted.current = true;
    setPlaying(true);
  }, [graphReady]);

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      setYear((y) => {
        if (y >= maxYear) {
          setPlaying(false);
          return maxYear;
        }
        return y + 5;
      });
    }, PLAY_MS);
    return () => window.clearInterval(id);
  }, [playing, maxYear]);

  const scrubTo = useCallback(
    (y: number) => {
      setPlaying(false);
      setYear(clampYear(y, minYear, maxYear));
    },
    [minYear, maxYear],
  );

  const step = useCallback(
    (delta: number) => {
      setPlaying(false);
      setYear((y) => clampYear(y + delta, minYear, maxYear));
    },
    [minYear, maxYear],
  );

  return (
    <section className="explore" id="esplora" aria-label={t("explore.ariaLabel")}>
      <header className="explore-head">
        <div className="explore-head-row">
          <div className="section-title-row">
            <h2>{t("explore.title")}</h2>
          </div>
        </div>
        <p>{t("explore.lede")}</p>
        {graph ? (
          <p className="explore-graph-note">
            {t("explore.graphNote", {
              minComp: GRAPH_MIN_COMPONENT,
              nodes: formatNumber(graph.nodes.length, locale),
              corpus: formatNumber(corpusActs, locale),
              omitted: formatNumber(Math.max(0, corpusActs - graph.nodes.length), locale),
            })}
          </p>
        ) : null}
      </header>

      <TimeBrush
        minYear={minYear}
        maxYear={maxYear}
        year={year}
        onChange={scrubTo}
        playing={playing}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onStep={step}
        nodeCount={counts.nodes}
        edgeCount={counts.edges}
      />

      <div className="explore-stage">
        {error ? <p className="explore-error">{error}</p> : null}
        {graph && acts && visible ? (
          <>
            <GraphView
              full={graph}
              visibleIds={visible}
              selected={selected}
              withData={withData}
              onSelect={setSelected}
              onReady={onGraphReady}
              clusterLine={clusterLine}
            />
            {withData.size > 0 ? (
              <p className="explore-blame-hint">
                {t("explore.blameHint", { count: formatNumber(withData.size, locale) })}
              </p>
            ) : null}
          </>
        ) : !error ? (
          <BootSplash compact message={t("explore.loadingGraph")} />
        ) : null}
      </div>

      <RevisionDrawer
        slug={selected}
        act={selectedAct}
        node={selectedNode}
        onClose={() => setSelected(null)}
        onRemix={onRemix}
      />
    </section>
  );
}
