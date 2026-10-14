import {
  Axis,
  BarSeries,
  Chart,
  LIGHT_THEME,
  DARK_THEME,
  LineSeries,
  Position,
  ScaleType,
  Settings,
} from "@elastic/charts";
import "@elastic/charts/dist/theme_only_light.css";
import "@elastic/charts/dist/theme_only_dark.css";
import type { DigestoChart } from "./chart";
import "./DigestoChart.css";

const VIZ = ["#2c5f7c", "#b54a4a", "#3d8f7a", "#c9a227"];
const VIZ_DARK = ["#6a9bb8", "#d46a6a", "#5cb39a", "#d4b04a"];

type Props = { chart: DigestoChart };

function resolvedTheme(): "light" | "dark" {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "dark" || attr === "light") return attr;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function DigestoChartView({ chart }: Props) {
  const dark = resolvedTheme() === "dark";
  const theme = {
    colors: { vizColors: dark ? VIZ_DARK : VIZ },
  };

  if (chart.type === "compare") {
    const data = chart.bars.map((b) => ({ x: b.label, y: b.value }));
    return (
      <div className="digesto-chart" role="img" aria-label={chart.title ?? "chart"}>
        <Chart size={{ height: 160 }}>
          <Settings
            baseTheme={dark ? DARK_THEME : LIGHT_THEME}
            theme={theme}
            showLegend={false}
          />
          <Axis id="bottom" position={Position.Bottom} />
          <Axis
            id="left"
            position={Position.Left}
            tickFormat={(d) =>
              typeof d === "number" ? new Intl.NumberFormat().format(d) : String(d)
            }
          />
          <BarSeries
            id="compare"
            name={chart.title ?? "compare"}
            xScaleType={ScaleType.Ordinal}
            yScaleType={ScaleType.Linear}
            xAccessor="x"
            yAccessors={["y"]}
            data={data}
          />
        </Chart>
      </div>
    );
  }

  return (
    <div className="digesto-chart" role="img" aria-label={chart.title ?? "chart"}>
      <Chart size={{ height: 160 }}>
        <Settings
          baseTheme={dark ? DARK_THEME : LIGHT_THEME}
          theme={theme}
          showLegend={chart.series.length > 1}
        />
        <Axis
          id="bottom"
          position={Position.Bottom}
          title={chart.xLabel}
          tickFormat={(d) => String(d)}
        />
        <Axis
          id="left"
          position={Position.Left}
          tickFormat={(d) =>
            typeof d === "number" ? new Intl.NumberFormat().format(d) : String(d)
          }
        />
        {chart.series.map((s) => (
          <LineSeries
            key={s.name}
            id={s.name}
            name={s.name}
            xScaleType={ScaleType.Linear}
            yScaleType={ScaleType.Linear}
            xAccessor="x"
            yAccessors={["y"]}
            data={s.points}
          />
        ))}
      </Chart>
    </div>
  );
}
