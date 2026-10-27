import { useEffect, useRef, useState } from "react";
import {
  Axis,
  BarSeries,
  Chart,
  DARK_THEME,
  LIGHT_THEME,
  LineSeries,
  Position,
  ScaleType,
  Settings,
  StackMode,
  Tooltip,
  TooltipType,
  type CustomTooltipProps,
  type DataSeriesDatum,
  type TooltipValue,
} from "@elastic/charts";
import type { TalkData } from "../data/types";
import type { ChartPhase } from "../content/steps";
import { formatNumber, useI18n } from "../i18n";
import { chartTheme, snapYear, useChartPalette } from "./chartPalette";
import "./StepChart.css";

const CHANNEL_KEYS = ["parlamento", "governo", "altro"] as const;
type ChannelKey = (typeof CHANNEL_KEYS)[number];

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

type YearDatum = { x: number; y: number };

type Props = {
  data: TalkData;
  phase: ChartPhase;
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

function channelStacks(years: number[], byKey: Map<string, number>, allTypes: string[]) {
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

function yearOf(value: TooltipValue<YearDatum> | undefined): number | null {
  const raw = value?.datum?.x;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

export function StepChart({ data, phase }: Props) {
  const { t, locale } = useI18n();
  const palette = useChartPalette();
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
  const dimPreRepublic = phase === "republic" || phase === "refs" || phase === "taglio";
  const showRefs = phase === "refs" || phase === "taglio";
  const highlightStory = phase === "taglio";
  const showLegend = showTypes || showChannels;

  const [percentStack, setPercentStack] = useState(false);
  const [overlaysIn, setOverlaysIn] = useState(true);
  const channelsArmed = useRef(false);

  useEffect(() => {
    const reduce = prefersReducedMotion();
    setOverlaysIn(false);

    if (!showChannels) {
      channelsArmed.current = false;
      setPercentStack(false);
      const id = window.setTimeout(() => setOverlaysIn(true), 20);
      return () => window.clearTimeout(id);
    }

    if (channelsArmed.current || reduce) {
      channelsArmed.current = true;
      setPercentStack(true);
      const id = window.setTimeout(() => setOverlaysIn(true), 20);
      return () => window.clearTimeout(id);
    }

    setPercentStack(false);
    setOverlaysIn(true);
    const id = window.setTimeout(() => {
      setPercentStack(true);
      channelsArmed.current = true;
    }, 40);
    return () => window.clearTimeout(id);
  }, [phase, showChannels]);

  const channelByKey = channelStacks(sampled, byKey, allTypes);
  const channelColor: Record<ChannelKey, string> = {
    parlamento: palette.types[0],
    governo: palette.types[6],
    altro: palette.altro,
  };

  const refByYear = new Map(data.refsByYear.map((r) => [r.year, r.mean]));
  const refData: YearDatum[] = sampled.flatMap((y) => {
    const mean = refByYear.get(y);
    return mean == null ? [] : [{ x: y, y: mean }];
  });

  const barOpacity = (year: number) => {
    let opacity = 1;
    if (dimPreRepublic && year < 1946) opacity = 0.22;
    if (highlightStory && year !== 2008 && year !== 2009) opacity = 0.28;
    if (highlightStory && (year === 2008 || year === 2009)) opacity = 1;
    return opacity;
  };

  const styleFor =
    (extra = 1) =>
    (datum: DataSeriesDatum<YearDatum>) => {
      const opacity = barOpacity(datum.datum.x) * extra;
      return opacity === 1 ? null : { rect: { opacity } };
    };

  const renderTip = ({ header, values }: CustomTooltipProps<YearDatum>) => {
    const bars = values.filter((v) => v.seriesIdentifier.specId !== "refs");
    const refs = values.find((v) => v.seriesIdentifier.specId === "refs");
    const year = yearOf(values[0]) ?? Number(header?.value);
    const total = bars.reduce((s, v) => s + (v.datum?.y ?? 0), 0);
    return (
      <div className="step-chart-tip" role="tooltip">
        <strong>{Number.isFinite(year) ? year : header?.formattedValue}</strong>
        <div>{t("chart.tipActs", { count: fmt(total) })}</div>
        {bars.some((v) => (v.datum?.y ?? 0) > 0) ? (
          <ul>
            {bars
              .filter((v) => (v.datum?.y ?? 0) > 0)
              .map((v) => {
                const count = v.datum?.y ?? 0;
                const label = String(v.label);
                return (
                  <li key={String(v.seriesIdentifier.key)}>
                    <span style={{ background: v.color }} />
                    {percentStack
                      ? t("chart.tipShare", {
                          label,
                          pct: String(Math.round(total > 0 ? (100 * count) / total : 0)),
                          count: fmt(count),
                        })
                      : `${label}: ${fmt(count)}`}
                  </li>
                );
              })}
          </ul>
        ) : null}
        {showRefs && refs?.datum ? (
          <div className="tip-refs">
            {t("chart.refsMean")}: {fmtMean(refs.datum.y)}
          </div>
        ) : null}
      </div>
    );
  };

  const eraMarks = ERA_YEARS.flatMap((m) => {
    const snapped = snapYear(m.year, sampled);
    return snapped == null ? [] : [{ dataValue: snapped, header: t(`chart.eras.${m.key}`) }];
  });
  const storyMarks = [
    { year: 2008, header: t("chart.story.dl112"), tone: "cut" },
    { year: 2009, header: t("chart.story.dlgs179"), tone: "restore" },
  ].flatMap((m) => {
    const snapped = snapYear(m.year, sampled);
    return snapped == null ? [] : [{ ...m, dataValue: snapped }];
  });

  const seriesProps = {
    xScaleType: ScaleType.Ordinal,
    yScaleType: ScaleType.Linear,
    xAccessor: "x" as const,
    yAccessors: ["y" as const],
  };

  return (
    <div className="step-chart-wrap">
      <div className="step-chart">
        <Chart size={{ height: "100%", width: "100%" }}>
          <Settings
            baseTheme={palette.dark ? DARK_THEME : LIGHT_THEME}
            theme={chartTheme(palette)}
            showLegend={false}
            animateData={!prefersReducedMotion()}
            ariaLabel={t("chart.ariaLabel")}
          />
          <Tooltip type={TooltipType.VerticalCursor} customTooltip={renderTip} />
          <Axis id="bottom" position={Position.Bottom} tickFormat={(d) => String(d)} />
          <Axis id="left" position={Position.Left} hide />
          {showRefs ? <Axis id="refs-y" groupId="refs" position={Position.Right} hide /> : null}

          {showChannels
            ? CHANNEL_KEYS.map((ch) => (
                <BarSeries
                  key={ch}
                  id={ch}
                  name={t(`chart.channels.${ch}`)}
                  {...seriesProps}
                  stackAccessors={["x"]}
                  stackMode={percentStack ? StackMode.Percentage : undefined}
                  color={channelColor[ch]}
                  styleAccessor={styleFor(ch === "altro" ? 0.32 : 1)}
                  data={sampled.map((y) => ({
                    x: y,
                    y: channelByKey.get(`${y}|${ch}`) || 0,
                  }))}
                />
              ))
            : null}

          {showTypes
            ? types.map((typeName, ti) => (
                <BarSeries
                  key={typeName}
                  id={typeName}
                  name={shortType(typeName)}
                  {...seriesProps}
                  stackAccessors={["x"]}
                  color={palette.types[ti % palette.types.length]}
                  styleAccessor={styleFor()}
                  data={sampled.map((y) => ({
                    x: y,
                    y: byKey.get(`${y}|${typeName}`) || 0,
                  }))}
                />
              ))
            : null}

          {!showChannels && !showTypes ? (
            <BarSeries
              id="volume"
              name={t("chart.captionVolume")}
              {...seriesProps}
              color={palette.volume}
              styleAccessor={styleFor()}
              data={sampled.map((y) => ({
                x: y,
                y: types.reduce((s, typeName) => s + (byKey.get(`${y}|${typeName}`) || 0), 0),
              }))}
            />
          ) : null}

          {showRefs ? (
            <LineSeries
              id="refs"
              name={t("chart.refsMean")}
              groupId="refs"
              xScaleType={ScaleType.Ordinal}
              yScaleType={ScaleType.Linear}
              xAccessor="x"
              yAccessors={["y"]}
              data={refData}
              color={palette.refs}
              hideInLegend
              lineSeriesStyle={{
                line: { strokeWidth: 2.2 },
                point: { visible: "never" },
              }}
            />
          ) : null}
        </Chart>
        {showEras && overlaysIn ? (
          <div className="chart-overlay is-in" aria-hidden>
            {eraMarks.map((m) => {
              const i = sampled.indexOf(m.dataValue);
              if (i < 0) return null;
              return (
                <span
                  key={m.header}
                  className="era-mark"
                  style={{ left: `${((i + 0.5) / sampled.length) * 100}%` }}
                >
                  <span className="era-label">{m.header}</span>
                </span>
              );
            })}
          </div>
        ) : null}
        {highlightStory && overlaysIn
          ? storyMarks.map((m) => {
              const i = sampled.indexOf(m.dataValue);
              if (i < 0) return null;
              return (
                <span
                  key={m.tone}
                  className={`story-callout ${m.tone}`}
                  style={{ left: `${((i + 0.5) / sampled.length) * 100}%` }}
                >
                  {m.header}
                </span>
              );
            })
          : null}
      </div>

      {showChannels ? (
        <p className={`step-chart-caption chart-fade${overlaysIn ? " is-in" : ""}`}>
          {t("chart.captionChannels")}
        </p>
      ) : null}
      {showLegend ? (
        <ul className={`step-chart-legend chart-fade${overlaysIn ? " is-in" : ""}`} aria-hidden>
          {showChannels
            ? CHANNEL_KEYS.map((ch) => (
                <li key={ch} style={ch === "altro" ? { opacity: 0.55 } : undefined}>
                  <span style={{ background: channelColor[ch] }} />
                  {t(`chart.channels.${ch}`)}
                </li>
              ))
            : types.slice(0, 6).map((typeName, i) => (
                <li key={typeName}>
                  <span style={{ background: palette.types[i % palette.types.length] }} />
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
