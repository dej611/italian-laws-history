import { useEffect, useMemo, useState } from "react";
import {
  AnnotationDomainType,
  Axis,
  BarSeries,
  Chart,
  DARK_THEME,
  LIGHT_THEME,
  LineAnnotation,
  Position,
  ScaleType,
  Settings,
  StackMode,
  Tooltip,
  TooltipType,
  type CustomTooltipProps,
  type TooltipAction,
} from "@elastic/charts";
import type { ActsIndex, GraphData, TalkData } from "../data/types";
import { loadActs, loadGraph } from "../data/load";
import {
  clusterYears,
  DEFAULT_REMIX,
  inRemixEra,
  STORY_COLOR,
  storyYear,
  yearTotals,
  type RemixSpec,
} from "../digesto/remix";
import { formatNumber, useI18n } from "../i18n";
import { chartTheme, snapYear, useChartPalette } from "./chartPalette";
import "./RemixModal.css";

type RemixDatum = { x: number; y: number | null };

const REMIX_CHANNELS = [
  { key: "parlamento", colorIndex: 0 },
  { key: "governo", colorIndex: 6 },
  { key: "altro", colorIndex: 2 },
] as const;

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
  const palette = useChartPalette();

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
  const scale = share ? "linear" : spec.scale;
  const log = scale === "log" && spec.measure !== "channels";
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

  const fmt = (n: number) => formatNumber(n, locale);
  const yOf = (n: number) => (log && n <= 0 ? null : n);
  const sampledYears = sampled.map((r) => r.year);
  const markGroups = new Map<string, number[]>();
  for (const m of marks) {
    const snapped = snapYear(m.year, sampledYears);
    if (snapped == null) continue;
    const list = markGroups.get(m.color) ?? [];
    if (!list.includes(snapped)) list.push(snapped);
    markGroups.set(m.color, list);
  }

  const patch = (next: Partial<RemixSpec>) => setSpec((s) => ({ ...s, ...next }));

  const renderTip = ({ header, values }: CustomTooltipProps<RemixDatum>) => {
    const year = Number(values[0]?.datum?.x ?? header?.value);
    const parts = REMIX_CHANNELS.map((ch) => {
      const hit = values.find((v) => v.seriesIdentifier.specId === ch.key);
      return { key: ch.key, n: hit?.datum?.y ?? 0 };
    });
    const total = spec.measure === "channels"
      ? parts.reduce((s, p) => s + (p.n ?? 0), 0)
      : (values[0]?.datum?.y ?? 0);
    return (
      <div className="remix-tip">
        <strong>{Number.isFinite(year) ? year : header?.formattedValue}</strong>
        <div>{t("chart.tipActs", { count: fmt(total ?? 0) })}</div>
        {share && total ? (
          <ul>
            {parts.map((p) => (
              <li key={p.key}>
                {t("chart.tipShare", {
                  label: t(`chart.channels.${p.key}`),
                  pct: Math.round(((p.n ?? 0) / total) * 100),
                  count: fmt(p.n ?? 0),
                })}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  };

  const tipActions: TooltipAction<RemixDatum>[] = [
    {
      label: t("explore.remixLog"),
      onSelect: () => patch({ scale: spec.scale === "log" ? "linear" : "log" }),
    },
    ...(clusterComp
      ? [
          {
            label: t("explore.remixCluster"),
            onSelect: () => patch({ cluster: spec.cluster ? undefined : clusterComp }),
          },
        ]
      : []),
    {
      label: t("explore.remixGoverno"),
      onSelect: () => patch({ measure: "governo" }),
    },
  ];

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
          <div className="remix-chart">
            <Chart
              key={`${spec.measure}-${scale}-${share ? "share" : "count"}-${spec.era}-${spec.story}`}
              size={{ height: 280, width: "100%" }}
            >
              <Settings
                baseTheme={palette.dark ? DARK_THEME : LIGHT_THEME}
                theme={chartTheme(palette)}
                showLegend={false}
                animateData={false}
                ariaLabel={t("explore.remixTitle")}
              />
              <Tooltip
                type={TooltipType.VerticalCursor}
                customTooltip={renderTip}
                actions={tipActions}
              />
              <Axis id="bottom" position={Position.Bottom} tickFormat={(d) => String(d)} />
              <Axis id="left" position={Position.Left} hide />
              {spec.measure === "channels"
                ? REMIX_CHANNELS.map((ch) => (
                    <BarSeries
                      key={ch.key}
                      id={ch.key}
                      name={t(`chart.channels.${ch.key}`)}
                      xScaleType={ScaleType.Ordinal}
                      yScaleType={log ? ScaleType.Log : ScaleType.Linear}
                      xAccessor="x"
                      yAccessors={["y"]}
                      stackAccessors={["x"]}
                      stackMode={share ? StackMode.Percentage : undefined}
                      color={palette.types[ch.colorIndex]}
                      data={sampled.map((r) => ({ x: r.year, y: yOf(r[ch.key]) }))}
                    />
                  ))
                : (
                    <BarSeries
                      id="volume"
                      name={t("chart.captionVolume")}
                      xScaleType={ScaleType.Ordinal}
                      yScaleType={log ? ScaleType.Log : ScaleType.Linear}
                      xAccessor="x"
                      yAccessors={["y"]}
                      color={palette.types[0]}
                      data={sampled.map((r) => ({ x: r.year, y: yOf(r.count) }))}
                    />
                  )}
              {[...markGroups.entries()].map(([color, years]) => (
                <LineAnnotation
                  key={color}
                  id={`mark-${color}`}
                  domainType={AnnotationDomainType.XDomain}
                  dataValues={years.map((year) => ({ dataValue: year }))}
                  hideTooltips
                  marker={<span />}
                  style={{ line: { stroke: color, strokeWidth: 1.5, opacity: 1 } }}
                />
              ))}
            </Chart>
          </div>
        </div>
      </div>
    </div>
  );
}
