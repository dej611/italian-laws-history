import { useEffect, useState } from "react";
import type { PartialTheme } from "@elastic/charts";
import "@elastic/charts/dist/theme_only_light.css";
import "@elastic/charts/dist/theme_only_dark.css";
import { THEME_EVENT, type ResolvedTheme } from "../theme";

/** Resolved `--chart-*` tokens. Canvas fills cannot use CSS variables. */
const PALETTE = {
  light: {
    volume: "#3a5f78",
    refs: "#c45c26",
    types: ["#2c5f7c", "#3d8f7a", "#c9a227", "#8b5e3c", "#5a6b7d", "#2f7d6d", "#b54a4a", "#6a7d4e"],
    altro: "#b3beca",
    inkFaint: "#8a9aab",
    paper: "#eef2f5",
  },
  dark: {
    volume: "#6a92ad",
    refs: "#e08a55",
    types: ["#6a9bb8", "#5cb39a", "#d4b04a", "#c48a5a", "#8a9aab", "#4fa892", "#d46a6a", "#8fa36a"],
    altro: "#424d5a",
    inkFaint: "#6e7f92",
    paper: "#121820",
  },
} as const;

export type ChartPalette = {
  dark: boolean;
  volume: string;
  refs: string;
  types: readonly string[];
  altro: string;
  inkFaint: string;
  paper: string;
};

export function useChartPalette(): ChartPalette {
  const [theme, setTheme] = useState<ResolvedTheme>(() =>
    typeof document !== "undefined" && document.documentElement.dataset.theme === "dark"
      ? "dark"
      : "light",
  );
  useEffect(() => {
    const sync = () =>
      setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
    sync();
    window.addEventListener(THEME_EVENT, sync);
    return () => window.removeEventListener(THEME_EVENT, sync);
  }, []);
  return { ...PALETTE[theme], dark: theme === "dark" };
}

export function chartTheme(p: ChartPalette): PartialTheme {
  return {
    background: { color: "transparent", fallbackColor: p.paper },
    chartMargins: { left: 4, right: 8, top: 16, bottom: 0 },
    chartPaddings: { left: 0, right: 0, top: 0, bottom: 0 },
    colors: { vizColors: [...p.types] },
    barSeriesStyle: { rect: { widthRatio: 0.9 } },
    axes: {
      axisLine: { visible: false },
      tickLine: { visible: false },
      gridLine: {
        horizontal: { visible: false },
        vertical: { visible: false },
      },
      tickLabel: { fill: p.inkFaint, fontSize: 10, fontFamily: "Figtree, sans-serif" },
    },
  };
}

/** First sampled year at or after `year`, matching the old SVG x lookup. */
export function snapYear(year: number, years: number[]): number | null {
  return years.find((y) => y >= year) ?? null;
}
