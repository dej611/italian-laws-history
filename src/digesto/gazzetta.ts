/** Year souvenir facts. Mix from TalkData; featured act from the graph. No model. */

import type { ActsIndex, GraphData, TalkData } from "../data/types";
import { eraFromYear, type PrintParams } from "./fingerprint";
import { yearTotals } from "./remix";
import { formatCount, stripInstructionLeak } from "./query";
import { t, type Locale } from "../i18n";

export const GAZZETTA_CHIPS = [1861, 1948, 1975, 1992, 2008] as const;

export type FeaturedAct = {
  label: string;
  slug: string;
  degree: number;
  enactDate: string | null;
};

export type YearFacts = {
  year: number;
  era: PrintParams["era"];
  total: number;
  parlamento: number;
  governo: number;
  altro: number;
  leggePct: number;
  dlConvertito: number;
  dlDecaduto: number;
  refsMean: number;
  corpusMean: number;
  spark: { year: number; n: number }[];
};

export function clampGazzettaYear(year: number, first: number, last: number): number {
  const fallback = Math.min(Math.max(1975, first), last);
  if (!Number.isFinite(year)) return fallback;
  return Math.min(last, Math.max(first, Math.round(year)));
}

export function yearFacts(data: TalkData, year: number): YearFacts {
  const y = clampGazzettaYear(year, data.dateRange.firstEnactYear, data.dateRange.lastEnactYear);
  const rows = yearTotals(data, "channels");
  const span = Math.max(1, data.dateRange.lastEnactYear - data.dateRange.firstEnactYear + 1);
  const corpusMean = Math.round(rows.reduce((s, r) => s + r.count, 0) / span);
  const row = rows.find((r) => r.year === y) ?? {
    year: y,
    count: 0,
    parlamento: 0,
    governo: 0,
    altro: 0,
  };
  const spark = rows
    .filter((r) => r.year >= y - 5 && r.year <= y + 5)
    .map((r) => ({ year: r.year, n: r.count }));
  const dl = data.dlOutcomes.find((r) => r.year === y);
  const refs = data.refsByYear.find((r) => r.year === y);
  const total = row.count;
  return {
    year: y,
    era: eraFromYear(y),
    total,
    parlamento: row.parlamento,
    governo: row.governo,
    altro: row.altro,
    leggePct: total > 0 ? Math.round((100 * row.parlamento) / total) : 0,
    dlConvertito: dl?.convertito ?? 0,
    dlDecaduto: dl?.decaduto ?? 0,
    refsMean: refs?.mean ?? 0,
    corpusMean,
    spark,
  };
}

export function featuredForYear(
  graph: GraphData,
  acts: ActsIndex,
  year: number,
): { act: FeaturedAct | null; hubs: number } {
  const bySlug = new Map(acts.acts.map((a) => [a.slug, a]));
  let best: FeaturedAct | null = null;
  let hubs = 0;
  for (const n of graph.nodes) {
    const a = bySlug.get(n.id);
    if (!a || a.enactYear !== year) continue;
    if (n.hub) hubs += 1;
    const degree = n.degree || 0;
    if (!best || degree > best.degree) {
      best = {
        label: a.label || n.label || n.id.replace(/\.txt$/i, ""),
        slug: n.id,
        degree,
        enactDate: a.enactDate,
      };
    }
  }
  return { act: best, hubs };
}

export function gazzettaFactNumbers(facts: YearFacts, featured: FeaturedAct | null): number[] {
  const out = [
    facts.year,
    facts.total,
    facts.parlamento,
    facts.governo,
    facts.altro,
    facts.leggePct,
    facts.dlConvertito,
    facts.dlDecaduto,
    facts.corpusMean,
  ];
  if (featured) out.push(featured.degree);
  return out;
}

function vars(facts: YearFacts, featured: FeaturedAct | null, locale: Locale) {
  const n = (x: number) => formatCount(x, locale);
  const dlAll = facts.dlConvertito + facts.dlDecaduto;
  return {
    year: facts.year,
    total: n(facts.total),
    parlamento: n(facts.parlamento),
    governo: n(facts.governo),
    altro: n(facts.altro),
    leggePct: facts.leggePct,
    corpusMean: n(facts.corpusMean),
    dlConvertito: n(facts.dlConvertito),
    dlDecaduto: n(facts.dlDecaduto),
    dlLapsePct: dlAll > 0 ? Math.round((100 * facts.dlDecaduto) / dlAll) : 0,
    featured: featured?.label ?? "",
    degree: featured ? n(featured.degree) : "0",
  };
}

export function cannedRubrica(
  facts: YearFacts,
  featured: FeaturedAct | null,
  locale: Locale,
): string {
  const v = vars(facts, featured, locale);
  const key = featured ? "gazzetta.cannedFeatured" : "gazzetta.canned";
  return t(key, v, locale);
}

const IT_MARK =
  /[àèéìòù]|\b(atto|atti|legge|leggi|decreto|decreti|gazzetta|parlamento|esecutivo|dal|nel)\b/i;
const EN_OPEN = /^(the|this|during|from)\b/i;

export function gazzettaRubricaSystem(locale: Locale): string {
  return locale === "en"
    ? `You write a 3-sentence archival caption for one year of the Italian law corpus.
Reply with JSON only: {"rubrica":"..."}.
Use only the FACTS. Every numeral must match the facts. Do not mention graph subset size as the year’s volume. No legal advice. No “in force”. Dry English.`
    : `Scrivi una didascalia d’archivio di 3 frasi per un anno del corpus normativo italiano.
Rispondi solo JSON: {"rubrica":"..."}.
Usa solo i FATTI. Ogni numerale deve coincidere con i fatti. Non usare la dimensione del grafo come volume dell’anno. Niente consulenza legale. Niente «vigente». Italiano secco.`;
}

export function gazzettaRubricaUser(input: {
  facts: YearFacts;
  featured: FeaturedAct | null;
  locale: Locale;
}): string {
  const body = JSON.stringify({
    year: input.facts.year,
    total: input.facts.total,
    parlamento: input.facts.parlamento,
    governo: input.facts.governo,
    altro: input.facts.altro,
    leggePct: input.facts.leggePct,
    corpusMean: input.facts.corpusMean,
    dlConvertito: input.facts.dlConvertito,
    dlDecaduto: input.facts.dlDecaduto,
    featured: input.featured
      ? { label: input.featured.label, degree: input.featured.degree }
      : null,
  });
  if (input.locale === "en") {
    return `FACTS:\n${body}\nWrite JSON only.`;
  }
  return `FATTI:\n${body}\nScrivi solo JSON.`;
}

export function parseGazzettaRubrica(
  raw: string,
  facts: YearFacts,
  featured: FeaturedAct | null,
  locale: Locale,
): string | null {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof o.rubrica !== "string") return null;
    const line = stripInstructionLeak(o.rubrica).replace(/\s+/g, " ").trim();
    if (line.length < 48 || line.length > 900) return null;
    const nums = gazzettaFactNumbers(facts, featured).map((n) => formatCount(n, locale));
    if (!nums.some((n) => n !== "0" && line.includes(n))) return null;
    if (locale === "it") {
      if (EN_OPEN.test(line) || !IT_MARK.test(line)) return null;
    }
    return line;
  } catch {
    return null;
  }
}

export const GAZZETTA_RUBRICA_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rubrica"],
  properties: { rubrica: { type: "string" } },
} as const;
