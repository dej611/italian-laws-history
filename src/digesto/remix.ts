/** Remix studio spec — applied by the renderer, never invented as Vega. */

import { GOVERNO_TYPES, type Measure } from "./query";
import type { ActsIndex, GraphData, TalkData } from "../data/types";

export type RemixSpec = {
  scale: "linear" | "log";
  measure: "all" | "LEGGE" | "governo" | "channels";
  /** 100% stack (percentile / share). Only meaningful with measure "channels". */
  normalize?: "count" | "share";
  era?: "all" | "unita" | "fascismo" | "repubblica" | "seconda";
  cluster?: string;
  story?: "dl112" | "dlgs179" | "none";
  ghost?: "regi" | "none";
};

export const DEFAULT_REMIX: RemixSpec = {
  scale: "linear",
  measure: "all",
  normalize: "count",
  era: "all",
  story: "none",
  ghost: "none",
};

export function specFromStep(stepId: string): RemixSpec {
  const base: RemixSpec = { ...DEFAULT_REMIX };
  if (stepId === "canali" || stepId === "close") {
    return { ...base, measure: "channels", normalize: "share" };
  }
  if (stepId === "tipi" || stepId === "regi") {
    return { ...base, measure: "channels" };
  }
  if (stepId === "repubblica") return { ...base, era: "repubblica" };
  if (stepId === "urgenze") return { ...base, measure: "governo" };
  if (stepId === "taglio") return { ...base, story: "dl112" };
  if (stepId === "memoria") return { ...base, story: "dlgs179" };
  return base;
}

const STORY_SLUG: Record<"dl112" | "dlgs179", string> = {
  dl112: "decreto-legge-112-del-25-06-2008.txt",
  dlgs179: "decreto-legislativo-179-del-01-12-2009.txt",
};

export const STORY_COLOR: Record<"dl112" | "dlgs179", string> = {
  dl112: "#a14b52",
  dlgs179: "#3d7a6a",
};

export function yearTotals(
  data: TalkData,
  measure: RemixSpec["measure"],
): { year: number; count: number; parlamento: number; governo: number; altro: number }[] {
  const years = [...new Set(data.byYear.rows.map((r) => r.year))].sort((a, b) => a - b);
  const out: { year: number; count: number; parlamento: number; governo: number; altro: number }[] =
    [];
  for (const year of years) {
    let parlamento = 0;
    let governo = 0;
    let altro = 0;
    for (const r of data.byYear.rows) {
      if (r.year !== year) continue;
      if (r.type === "LEGGE") parlamento += r.count;
      else if (GOVERNO_TYPES.has(r.type)) governo += r.count;
      else altro += r.count;
    }
    const all = parlamento + governo + altro;
    let count = all;
    if (measure === "LEGGE") count = parlamento;
    else if (measure === "governo") count = governo;
    else if (measure === "channels") count = all;
    out.push({ year, count, parlamento, governo, altro });
  }
  return out;
}

export function clusterYears(
  graph: GraphData,
  acts: ActsIndex,
  comp: string,
): number[] {
  const ids = new Set(graph.nodes.filter((n) => n.comp === comp).map((n) => n.id));
  const years = new Set<number>();
  for (const a of acts.acts) {
    if (!ids.has(a.slug) || a.enactYear == null) continue;
    years.add(a.enactYear);
  }
  return [...years].sort((a, b) => a - b);
}

export function storyYear(id: "dl112" | "dlgs179"): number {
  return id === "dl112" ? 2008 : 2009;
}

export function storySlug(id: "dl112" | "dlgs179"): string {
  return STORY_SLUG[id];
}

export function inRemixEra(year: number, era: RemixSpec["era"]): boolean {
  if (!era || era === "all") return true;
  if (era === "unita") return year < 1922;
  if (era === "fascismo") return year >= 1922 && year <= 1945;
  if (era === "repubblica") return year >= 1946 && year < 1990;
  return year >= 1990;
}

export function barHeight(
  count: number,
  max: number,
  scale: RemixSpec["scale"],
  ih: number,
  share = false,
) {
  if (share) return count > 0 ? ih : 0;
  if (max <= 0) return 0;
  if (scale === "log") {
    const t = Math.log1p(count) / Math.log1p(max);
    return t * ih;
  }
  return (count / max) * ih;
}

export function measureOf(m: Measure | string): RemixSpec["measure"] | null {
  if (m === "all" || m === "LEGGE" || m === "governo" || m === "channels") return m;
  if (m === "parlamento") return "LEGGE";
  return null;
}
