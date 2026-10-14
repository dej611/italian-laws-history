import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { TalkData } from "../data/types";
import type { ChartPhase } from "../content/steps";
import { formatNumber, useI18n } from "../i18n";
import "./StepChart.css";

const TYPE_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
  "var(--chart-8)",
];

/** Parliament vs government vs residual — `altro` drawn last (on top). */
const CHANNEL_KEYS = ["parlamento", "governo", "altro"] as const;
type ChannelKey = (typeof CHANNEL_KEYS)[number];

const CHANNEL_COLORS: Record<ChannelKey, string> = {
  parlamento: "var(--chart-1)",
  governo: "var(--chart-7)",
  altro: "color-mix(in srgb, var(--ink-faint) 55%, var(--paper-deep))",
};

const CHANNEL_OPACITY: Record<ChannelKey, number> = {
  parlamento: 1,
  governo: 1,
  altro: 0.32,
};

const GOVERNO_TYPES = new Set([
  "DECRETO-LEGGE",
  "DECRETO LEGISLATIVO",
  "REGIO DECRETO-LEGGE",
  "DECRETO LUOGOTENENZIALE",
]);

const ERA_YEARS = [
  { year: 1861, key: "unita" as const },
  { year: 1922, key: "fascismo" as const },
  { year: 1946, key: "repubblica" as const },
  { year: 1990, key: "seconda" as const },
];

const STACK_MS = 550;

type Props = {
  data: TalkData;
  phase: ChartPhase;
};

type Tip = {
  x: number;
  y: number;
  year: number;
  total: number;
  parts: { label: string; count: number; pct?: number; color: string }[];
  refs?: number;
  percentMode?: boolean;
};

type BarSeg = {
  key: string;
  y: number;
  height: number;
  fill: string;
  opacity: number;
};

function shortType(type: string) {
  const map: Record<string, string> = {
    "REGIO DECRETO": "R.D.",
    "DECRETO DEL PRESIDENTE DELLA REPUBBLICA": "D.P.R.",
    LEGGE: "Legge",
    "REGIO DECRETO-LEGGE": "R.D.L.",
    "DECRETO LUOGOTENENZIALE": "D. Luog.",
    "DECRETO-LEGGE": "D.L.",
    "DECRETO LEGISLATIVO": "D.Lgs.",
    DECRETO: "Decreto",
  };
  return map[type] ?? type.slice(0, 10);
}

function channelOf(type: string): ChannelKey {
  if (type === "LEGGE") return "parlamento";
  if (GOVERNO_TYPES.has(type)) return "governo";
  return "altro";
}

function stackByYear(data: TalkData) {
  const types = data.byYear.types.slice(0, 8);
  const years = [...new Set(data.byYear.rows.map((r) => r.year))].sort((a, b) => a - b);
  const byKey = new Map(data.byYear.rows.map((r) => [`${r.year}|${r.type}`, r.count]));
  return { types, years, byKey };
}

function channelStacks(
  years: number[],
  byKey: Map<string, number>,
  allTypes: string[],
) {
  const byYearChannel = new Map<string, number>();
  for (const y of years) {
    for (const ch of CHANNEL_KEYS) byYearChannel.set(`${y}|${ch}`, 0);
    for (const type of allTypes) {
      const c = byKey.get(`${y}|${type}`) || 0;
      if (!c) continue;
      const ch = channelOf(type);
      const k = `${y}|${ch}`;
      byYearChannel.set(k, (byYearChannel.get(k) || 0) + c);
    }
  }
  return byYearChannel;
}

function prefersReducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function easeInOut(t: number) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/** Absolute stack, percent stack, or blend (0=abs … 1=percent) for the stretch. */
function stackSegments(
  counts: { key: string; count: number; fill: string; opacity: number }[],
  baseY: number,
  ih: number,
  absMax: number,
  blend = 0,
): BarSeg[] {
  const total = counts.reduce((s, c) => s + c.count, 0);
  const heights = counts.map((c) => {
    const absH = (c.count / absMax) * ih;
    const pctH = total > 0 ? (c.count / total) * ih : 0;
    return absH * (1 - blend) + pctH * blend;
  });
  let y0 = baseY;
  return counts.map((c, i) => {
    const bh = heights[i];
    y0 -= bh;
    return {
      key: c.key,
      y: y0,
      height: bh,
      fill: c.fill,
      opacity: c.opacity,
    };
  });
}

export function StepChart({ data, phase }: Props) {
  const { t, locale } = useI18n();
  const fmt = (n: number) => formatNumber(n, locale);
  const fmtMean = (n: number) =>
    n.toLocaleString(locale === "en" ? "en-GB" : "it-IT", { maximumFractionDigits: 2 });

  const { types, years, byKey } = stackByYear(data);
  const allTypes = data.byYear.types;
  const sampled = years.filter(
    (y) => y % 2 === 0 || y === years[0] || y === years[years.length - 1],
  );

  const showChannels = phase === "channels" || phase === "close";
  const showTypes = phase !== "volume" && !showChannels;
  const showEras =
    phase === "eras" ||
    phase === "republic" ||
    phase === "refs" ||
    phase === "taglio" ||
    showChannels;
  const dimPreRepublic =
    phase === "republic" || phase === "refs" || phase === "taglio";
  const showRefs = phase === "refs" || phase === "taglio";
  const highlightStory = phase === "taglio";
  const showLegend = showTypes || showChannels;

  /** 0 = absolute counts, 1 = 100% stack. Animated only on first channels entry. */
  const [channelBlend, setChannelBlend] = useState(0);
  const [overlaysIn, setOverlaysIn] = useState(true);
  const channelsArmed = useRef(false);

  useEffect(() => {
    const reduce = prefersReducedMotion();
    setOverlaysIn(false);

    if (!showChannels) {
      channelsArmed.current = false;
      setChannelBlend(0);
      const t = window.setTimeout(() => setOverlaysIn(true), 20);
      return () => window.clearTimeout(t);
    }

    if (channelsArmed.current) {
      setChannelBlend(1);
      const t = window.setTimeout(() => setOverlaysIn(true), 20);
      return () => window.clearTimeout(t);
    }

    // First entry: absolute, then rAF-lerp to percent (no WAAPI on SVG geometry).
    if (reduce) {
      channelsArmed.current = true;
      setChannelBlend(1);
      setOverlaysIn(true);
      return;
    }

    setChannelBlend(0);
    setOverlaysIn(true);
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / STACK_MS);
      setChannelBlend(easeInOut(t));
      if (t < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        channelsArmed.current = true;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase, showChannels]);

  const channelByKey = channelStacks(sampled, byKey, allTypes);

  const typeTotals = sampled.map((y) =>
    types.reduce((s, type) => s + (byKey.get(`${y}|${type}`) || 0), 0),
  );
  const channelTotals = sampled.map((y) =>
    CHANNEL_KEYS.reduce((s, ch) => s + (channelByKey.get(`${y}|${ch}`) || 0), 0),
  );
  const totals = showChannels ? channelTotals : typeTotals;
  const max = Math.max(...totals, 1);

  const w = 720;
  const h = 340;
  const pad = { l: 28, r: 12, t: showEras ? 28 : 16, b: 28 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;
  const barW = iw / sampled.length;
  const baseY = pad.t + ih;

  const refs = data.refsByYear;
  const refByYear = new Map(refs.map((r) => [r.year, r.mean]));
  const refMax = Math.max(...refs.map((r) => r.mean), 0.01);
  const refPts = sampled
    .map((y, i) => {
      const mean = refByYear.get(y);
      if (mean == null) return null;
      const x = pad.l + i * barW + barW / 2;
      const yPix = pad.t + ih - (mean / refMax) * ih * 0.85;
      return `${x},${yPix}`;
    })
    .filter(Boolean)
    .join(" ");

  const xForYear = (year: number) => {
    const i = sampled.findIndex((y) => y >= year);
    if (i < 0) return pad.l + iw;
    return pad.l + i * barW;
  };

  const [tip, setTip] = useState<Tip | null>(null);

  const moveTip = (
    e: MouseEvent<SVGRectElement>,
    year: number,
    total: number,
  ) => {
    const wrap = e.currentTarget.closest(".step-chart-wrap");
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    let parts: Tip["parts"] = [];
    if (showChannels) {
      parts = CHANNEL_KEYS.map((ch) => {
        const count = channelByKey.get(`${year}|${ch}`) || 0;
        return {
          label: t(`chart.channels.${ch}`),
          count,
          pct: total > 0 ? (100 * count) / total : 0,
          color: CHANNEL_COLORS[ch],
        };
      }).filter((p) => p.count > 0);
    } else if (showTypes) {
      parts = types
        .map((typeName, ti) => ({
          label: shortType(typeName),
          count: byKey.get(`${year}|${typeName}`) || 0,
          color: TYPE_COLORS[ti % TYPE_COLORS.length],
        }))
        .filter((p) => p.count > 0);
    }
    const mean = refByYear.get(year);
    setTip({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      year,
      total,
      parts,
      refs: showRefs && mean != null ? mean : undefined,
      percentMode: showChannels && channelBlend > 0.5,
    });
  };

  return (
    <div className="step-chart-wrap">
      <svg
        className="step-chart"
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label={t("chart.ariaLabel")}
      >
        <g
          className={`chart-overlay${showEras && overlaysIn ? " is-in" : ""}`}
          aria-hidden={!showEras}
        >
          {ERA_YEARS.map((m) => {
            const x = xForYear(m.year);
            return (
              <g key={m.year} className="era-mark">
                <line
                  x1={x}
                  x2={x}
                  y1={pad.t - 4}
                  y2={pad.t + ih}
                  stroke="var(--ink-faint)"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  opacity={0.7}
                />
                <text x={x + 4} y={pad.t - 10} className="step-chart-label era-label">
                  {t(`chart.eras.${m.key}`)}
                </text>
              </g>
            );
          })}
        </g>

        {sampled.map((y, i) => {
          const pre = dimPreRepublic && y < 1946;
          const story = highlightStory && (y === 2008 || y === 2009);
          const muted = highlightStory && !story;
          let groupOpacity = 1;
          if (pre) groupOpacity = 0.22;
          if (muted) groupOpacity = 0.28;
          if (story) groupOpacity = 1;

          let segs: BarSeg[];
          if (showChannels) {
            segs = stackSegments(
              CHANNEL_KEYS.map((ch) => ({
                key: ch,
                count: channelByKey.get(`${y}|${ch}`) || 0,
                fill: CHANNEL_COLORS[ch],
                opacity: CHANNEL_OPACITY[ch],
              })),
              baseY,
              ih,
              max,
              channelBlend,
            );
          } else if (showTypes) {
            segs = stackSegments(
              types.map((typeName, ti) => ({
                key: typeName,
                count: byKey.get(`${y}|${typeName}`) || 0,
                fill: TYPE_COLORS[ti % TYPE_COLORS.length],
                opacity: 1,
              })),
              baseY,
              ih,
              max,
              0,
            );
          } else {
            segs = stackSegments(
              [
                {
                  key: "volume",
                  count: totals[i],
                  fill: "var(--chart-volume)",
                  opacity: 1,
                },
              ],
              baseY,
              ih,
              max,
              0,
            );
          }

          return (
            <g key={y} opacity={groupOpacity} className="bar-year">
              {segs.map((seg) => (
                <rect
                  key={seg.key}
                  className="bar-seg"
                  x={pad.l + i * barW + 0.6}
                  y={seg.y}
                  width={Math.max(1, barW - 1.2)}
                  height={Math.max(0, seg.height)}
                  fill={seg.fill}
                  opacity={seg.opacity}
                />
              ))}
            </g>
          );
        })}

        <polyline
          className={`refs-line${showRefs && overlaysIn ? " is-in" : ""}`}
          fill="none"
          stroke="var(--chart-refs)"
          strokeWidth={2.2}
          points={refPts || undefined}
          pointerEvents="none"
        />

        <g className={`chart-overlay${highlightStory && overlaysIn ? " is-in" : ""}`}>
          <text
            x={xForYear(2008) + barW}
            y={pad.t + 18}
            className="story-callout cut"
          >
            {t("chart.story.dl112")}
          </text>
          <text
            x={xForYear(2009) + barW}
            y={pad.t + 34}
            className="story-callout restore"
          >
            {t("chart.story.dlgs179")}
          </text>
        </g>

        {sampled.map((y, i) =>
          i % Math.ceil(sampled.length / 7) === 0 ? (
            <text
              key={`lbl-${y}`}
              x={pad.l + i * barW + barW / 2}
              y={h - 8}
              textAnchor="middle"
              className="step-chart-label"
            >
              {y}
            </text>
          ) : null,
        )}

        {sampled.map((y, i) => (
          <rect
            key={`hit-${y}`}
            className="bar-hit"
            x={pad.l + i * barW}
            y={pad.t}
            width={barW}
            height={ih}
            fill="transparent"
            onMouseEnter={(e) => moveTip(e, y, totals[i])}
            onMouseMove={(e) => moveTip(e, y, totals[i])}
            onMouseLeave={() => setTip(null)}
          />
        ))}
      </svg>

      {tip ? (
        <div
          className="step-chart-tip"
          style={{ left: tip.x, top: tip.y }}
          role="tooltip"
        >
          <strong>{tip.year}</strong>
          <div>{t("chart.tipActs", { count: fmt(tip.total) })}</div>
          {tip.parts.length ? (
            <ul>
              {tip.parts.map((p) => (
                <li key={p.label}>
                  <span style={{ background: p.color }} />
                  {tip.percentMode && p.pct != null
                    ? t("chart.tipShare", {
                        label: p.label,
                        pct: String(Math.round(p.pct)),
                        count: fmt(p.count),
                      })
                    : `${p.label}: ${fmt(p.count)}`}
                </li>
              ))}
            </ul>
          ) : null}
          {tip.refs != null ? (
            <div className="tip-refs">
              {t("chart.refsMean")}: {fmtMean(tip.refs)}
            </div>
          ) : null}
        </div>
      ) : null}

      {showChannels ? (
        <p
          className={`step-chart-caption chart-fade${overlaysIn ? " is-in" : ""}`}
        >
          {t("chart.captionChannels")}
        </p>
      ) : null}
      {showLegend ? (
        <ul
          className={`step-chart-legend chart-fade${overlaysIn ? " is-in" : ""}`}
          aria-hidden
        >
          {showChannels
            ? CHANNEL_KEYS.map((ch) => (
                <li
                  key={ch}
                  style={ch === "altro" ? { opacity: 0.55 } : undefined}
                >
                  <span style={{ background: CHANNEL_COLORS[ch] }} />
                  {t(`chart.channels.${ch}`)}
                </li>
              ))
            : types.slice(0, 6).map((typeName, i) => (
                <li key={typeName}>
                  <span style={{ background: TYPE_COLORS[i % TYPE_COLORS.length] }} />
                  {shortType(typeName)}
                </li>
              ))}
          {showRefs ? (
            <li className="refs-legend">
              <span className="refs-swatch" />
              {t("chart.refsMean")}
            </li>
          ) : null}
        </ul>
      ) : (
        <p className="step-chart-caption">{t("chart.captionVolume")}</p>
      )}
    </div>
  );
}
