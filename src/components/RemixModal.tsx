import { useEffect, useMemo, useState, type MouseEvent } from "react";
import type { ActsIndex, GraphData, TalkData } from "../data/types";
import { loadActs, loadGraph } from "../data/load";
import {
  barHeight,
  clusterYears,
  DEFAULT_REMIX,
  inRemixEra,
  STORY_COLOR,
  storyYear,
  yearTotals,
  type RemixSpec,
} from "../digesto/remix";
import { formatNumber, useI18n } from "../i18n";
import "./RemixModal.css";

type Props = {
  data: TalkData;
  initialSpec?: RemixSpec;
  clusterComp?: string;
  onClose: () => void;
};

export function RemixModal({ data, initialSpec, clusterComp, onClose }: Props) {
  const { t, locale } = useI18n();
  const [spec, setSpec] = useState<RemixSpec>(() => ({
    ...DEFAULT_REMIX,
    ...initialSpec,
    cluster: clusterComp,
  }));
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [acts, setActs] = useState<ActsIndex | null>(null);
  const [tip, setTip] = useState<{
    year: number;
    count: number;
    parlamento: number;
    governo: number;
    altro: number;
    share: boolean;
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    if (!clusterComp) return;
    let cancelled = false;
    Promise.all([loadGraph(), loadActs()]).then(([g, a]) => {
      if (cancelled) return;
      setGraph(g);
      setActs(a);
    });
    return () => {
      cancelled = true;
    };
  }, [clusterComp]);

  const rows = useMemo(() => yearTotals(data, spec.measure), [data, spec.measure]);
  const sampled = useMemo(() => {
    const inEra = rows.filter((r) => inRemixEra(r.year, spec.era));
    if (spec.era && spec.era !== "all") return inEra;
    return inEra.filter((r, i, arr) => r.year % 2 === 0 || i === 0 || i === arr.length - 1);
  }, [rows, spec.era]);
  const share = spec.normalize === "share" && spec.measure === "channels";
  const max = Math.max(1, ...sampled.map((r) => r.count));
  const scale = share ? "linear" : spec.scale;
  const marks = useMemo(() => {
    const years: { year: number; color: string }[] = [];
    if (spec.cluster && clusterComp && graph && acts) {
      for (const y of clusterYears(graph, acts, clusterComp)) {
        years.push({ year: y, color: "#a14b52" });
      }
    }
    if (spec.story === "dl112") years.push({ year: storyYear("dl112"), color: STORY_COLOR.dl112 });
    if (spec.story === "dlgs179") years.push({ year: storyYear("dlgs179"), color: STORY_COLOR.dlgs179 });
    return years;
  }, [spec.cluster, spec.story, clusterComp, graph, acts]);

  const w = 720;
  const h = 280;
  const pad = { l: 28, r: 12, t: 16, b: 28 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;
  const barW = sampled.length ? iw / sampled.length : iw;
  const fmt = (n: number) => formatNumber(n, locale);

  const patch = (next: Partial<RemixSpec>) => setSpec((s) => ({ ...s, ...next }));

  return (
    <div
      className="remix-modal"
      role="dialog"
      aria-label={t("explore.remixTitle")}
      onClick={onClose}
    >
      <div
        className="remix-modal-sheet"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2>{t("explore.remixTitle")}</h2>
          <button type="button" onClick={onClose} aria-label={t("common.close")}>
            {t("common.close")}
          </button>
        </header>
        <div className="remix-chips">
          <button
            type="button"
            className={spec.scale === "log" && !share ? "is-on" : undefined}
            onClick={() => {
              if (share) patch({ normalize: "count", scale: "log" });
              else patch({ scale: spec.scale === "log" ? "linear" : "log" });
            }}
          >
            {spec.scale === "log" ? t("explore.remixLinear") : t("explore.remixLog")}
          </button>
          <button type="button" className={spec.measure === "all" ? "is-on" : undefined} onClick={() => patch({ measure: "all", normalize: "count" })}>
            {t("explore.remixAll")}
          </button>
          <button type="button" className={spec.measure === "LEGGE" ? "is-on" : undefined} onClick={() => patch({ measure: "LEGGE", normalize: "count" })}>
            {t("explore.remixLegge")}
          </button>
          <button type="button" className={spec.measure === "governo" ? "is-on" : undefined} onClick={() => patch({ measure: "governo", normalize: "count" })}>
            {t("explore.remixGoverno")}
          </button>
          <button type="button" className={spec.measure === "channels" && !share ? "is-on" : undefined} onClick={() => patch({ measure: "channels", normalize: "count" })}>
            {t("explore.remixChannels")}
          </button>
          <button
            type="button"
            className={share ? "is-on" : undefined}
            onClick={() => {
              if (share) patch({ normalize: "count" });
              else patch({ measure: "channels", normalize: "share", scale: "linear" });
            }}
          >
            {t("explore.remixShare")}
          </button>
          <button
            type="button"
            className={spec.era === "unita" ? "is-on" : undefined}
            onClick={() => patch({ era: spec.era === "unita" ? "all" : "unita" })}
          >
            {t("chart.eras.unita")}
          </button>
          <button
            type="button"
            className={spec.era === "fascismo" ? "is-on" : undefined}
            onClick={() => patch({ era: spec.era === "fascismo" ? "all" : "fascismo" })}
          >
            {t("chart.eras.fascismo")}
          </button>
          <button
            type="button"
            className={spec.era === "repubblica" ? "is-on" : undefined}
            onClick={() => patch({ era: spec.era === "repubblica" ? "all" : "repubblica" })}
          >
            {t("chart.eras.repubblica")}
          </button>
          <button
            type="button"
            className={spec.era === "seconda" ? "is-on" : undefined}
            onClick={() => patch({ era: spec.era === "seconda" ? "all" : "seconda" })}
          >
            {t("chart.eras.seconda")}
          </button>
          {clusterComp ? (
            <button
              type="button"
              className={spec.cluster ? "is-on" : undefined}
              onClick={() => patch({ cluster: spec.cluster ? undefined : clusterComp })}
            >
              {t("explore.remixCluster")}
            </button>
          ) : null}
          <button
            type="button"
            className={spec.story === "dl112" ? "is-on" : undefined}
            onClick={() => patch({ story: spec.story === "dl112" ? "none" : "dl112" })}
          >
            {t("explore.remixStory112")}
          </button>
          <button
            type="button"
            className={spec.story === "dlgs179" ? "is-on" : undefined}
            onClick={() => patch({ story: spec.story === "dlgs179" ? "none" : "dlgs179" })}
          >
            {t("explore.remixStory179")}
          </button>
        </div>
        <div className="remix-chart-wrap">
          <svg viewBox={`0 0 ${w} ${h}`} className="remix-chart" role="img">
            {sampled.map((r, i) => {
              const totalH = barHeight(r.count, max, scale, ih, share);
              const x = pad.l + i * barW;
              const bw = Math.max(0.4, barW - 0.8);
              const showTip = (e: MouseEvent<SVGElement>) => {
                const box = e.currentTarget.closest(".remix-chart-wrap")?.getBoundingClientRect();
                if (!box) return;
                setTip({
                  year: r.year,
                  count: r.count,
                  parlamento: r.parlamento,
                  governo: r.governo,
                  altro: r.altro,
                  share,
                  x: e.clientX - box.left,
                  y: e.clientY - box.top,
                });
              };
              if (spec.measure === "channels" && r.count > 0) {
                const segs = [
                  { k: "parlamento", c: r.parlamento, fill: "var(--chart-1)" },
                  { k: "governo", c: r.governo, fill: "var(--chart-7)" },
                  { k: "altro", c: r.altro, fill: "var(--chart-3)" },
                ];
                let y = pad.t + ih;
                return (
                  <g key={r.year} onMouseEnter={showTip} onMouseLeave={() => setTip(null)}>
                    {segs.map((s) => {
                      const bh = (s.c / r.count) * totalH;
                      y -= bh;
                      return (
                        <rect
                          key={s.k}
                          x={x + 0.4}
                          y={y}
                          width={bw}
                          height={bh}
                          fill={s.fill}
                        />
                      );
                    })}
                  </g>
                );
              }
              const y = pad.t + ih - totalH;
              return (
                <rect
                  key={r.year}
                  x={x + 0.4}
                  y={y}
                  width={bw}
                  height={totalH}
                  fill="var(--chart-1)"
                  onMouseEnter={showTip}
                  onMouseLeave={() => setTip(null)}
                />
              );
            })}
            {marks.map((m, i) => {
              const idx = sampled.findIndex((r) => r.year >= m.year);
              if (idx < 0) return null;
              const x = pad.l + idx * barW + barW / 2;
              return (
                <g key={`${m.year}-${i}`}>
                  <line x1={x} x2={x} y1={pad.t} y2={pad.t + ih} stroke={m.color} strokeWidth={1.5} />
                </g>
              );
            })}
          </svg>
          {tip ? (
            <div className="remix-tip" style={{ left: tip.x, top: tip.y }}>
              <strong>{tip.year}</strong>
              <div>{t("chart.tipActs", { count: fmt(tip.count) })}</div>
              {tip.share && tip.count > 0 ? (
                <ul>
                  {(
                    [
                      ["parlamento", tip.parlamento],
                      ["governo", tip.governo],
                      ["altro", tip.altro],
                    ] as const
                  ).map(([k, n]) => (
                    <li key={k}>
                      {t("chart.tipShare", {
                        label: t(`chart.channels.${k}`),
                        pct: Math.round((n / tip.count) * 100),
                        count: fmt(n),
                      })}
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="remix-tip-chips">
                <button type="button" onClick={() => patch({ scale: spec.scale === "log" ? "linear" : "log" })}>
                  {t("explore.remixLog")}
                </button>
                {clusterComp ? (
                  <button type="button" onClick={() => patch({ cluster: spec.cluster ? undefined : clusterComp })}>
                    {t("explore.remixCluster")}
                  </button>
                ) : null}
                <button type="button" onClick={() => patch({ measure: "governo" })}>
                  {t("explore.remixGoverno")}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
