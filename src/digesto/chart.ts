/** Digesto chart DSL — built by tools, never by the LLM. */

import {
  ERA_IDS,
  GOVERNO_TYPES,
  isDecretoType,
  type EraId,
  type ExecutedQuery,
  type YearRow,
  typePredicate,
} from "./query";

export type DigestoChart =
  | { type: "compare"; title?: string; bars: { label: string; value: number }[] }
  | {
      type: "series";
      title?: string;
      xLabel?: string;
      series: { name: string; points: { x: number; y: number }[] }[];
    };

const ERA_SET = new Set<string>(ERA_IDS);

const ERA_LABEL = {
  it: {
    monarchy: "Monarchia",
    liberal: "Italia liberale",
    fascism: "Fascismo",
    republic: "Repubblica",
    first_rep: "I Repubblica",
    second_rep: "II Repubblica",
  },
  en: {
    monarchy: "Monarchy",
    liberal: "Liberal Italy",
    fascism: "Fascism",
    republic: "Republic",
    first_rep: "1st Republic",
    second_rep: "2nd Republic",
  },
} as const;

function partLabel(key: string, locale: "it" | "en"): string {
  if (key === "parlamento") return locale === "en" ? "Parliament" : "Parlamento";
  if (key === "governo") return locale === "en" ? "Executive" : "Governo";
  if (key === "family") return locale === "en" ? "All “decreto”" : "Tutti i «decreto»";
  if (ERA_SET.has(key)) return ERA_LABEL[locale][key as EraId];
  if (key === "all") return locale === "en" ? "Acts" : "Atti";
  if (key === "LEGGE" || key === "parlamento") {
    return locale === "en" ? "Statutes" : "Leggi";
  }
  return key;
}

/** Yearly totals for a type predicate (gaps filled with 0). */
export function yearSeries(
  rows: YearRow[],
  from: number,
  to: number,
  pred: (type: string) => boolean,
): { x: number; y: number }[] {
  const byYear = new Map<number, number>();
  for (let y = from; y <= to; y++) byYear.set(y, 0);
  for (const r of rows) {
    if (r.year >= from && r.year <= to && pred(r.type)) {
      byYear.set(r.year, (byYear.get(r.year) ?? 0) + r.count);
    }
  }
  return [...byYear.entries()].map(([x, y]) => ({ x, y }));
}

/**
 * Map an executed analytics query to a chart.
 * Compare / dual totals → bars; multi-year single measure → series.
 */
export function buildChart(
  executed: ExecutedQuery,
  rows: YearRow[],
  locale: "it" | "en",
): DigestoChart | undefined {
  const { spec, parts } = executed;

  if (parts.length >= 2) {
    return {
      type: "compare",
      bars: parts.map((p) => ({
        label: partLabel(p.key, locale),
        value: p.count,
      })),
    };
  }

  const p = parts[0];
  if (!p || p.to - p.from < 2) return undefined;

  const pred =
    spec.measure === "decreti_bare"
      ? isDecretoType
      : spec.measure === "channels"
        ? (t: string) => t === "LEGGE" || GOVERNO_TYPES.has(t)
        : typePredicate(spec.measure);

  const points = yearSeries(rows, p.from, p.to, pred);
  if (!points.some((pt) => pt.y > 0)) return undefined;

  return {
    type: "series",
    xLabel: locale === "en" ? "Year" : "Anno",
    series: [{ name: partLabel(p.key, locale), points }],
  };
}
