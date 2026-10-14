/** Scrolly director: facts from TalkData, canned cues, optional JSON from the SLM. */

import type { TalkData } from "../data/types";
import { SCROLLY_STEP_IDS } from "../content/steps";
import { formatCount, GOVERNO_TYPES, stripInstructionLeak } from "./query";
import { t, type Locale } from "../i18n";

export const DIRECTOR_ANIMATIONS = [
  "Speak",
  "GetAttention",
  "LookLeft",
  "LookRight",
  "Congratulate",
  "Confused",
  "Thinking",
] as const;
export type DirectorAnimation = (typeof DIRECTOR_ANIMATIONS)[number];

export type DirectorCue = {
  animation: DirectorAnimation;
  line: string;
};

export const DIRECTOR_EVENTS = ["peak", "hole", "cliff", "share", "flat"] as const;
export type DirectorEvent = (typeof DIRECTOR_EVENTS)[number];

export type StepFacts = {
  stepId: string;
  firstYear: number;
  lastYear: number;
  total: number;
  legge: number;
  regi: number;
  decreti: number;
  monarchy: number;
  republic: number;
  fascism: number;
  secondRep: number;
  unita: number;
  parlamento: number;
  governo: number;
  y2008: number;
  y2009: number;
  deltaAbs: number;
  refsMean: number;
  peakYear: number;
  peakCount: number;
  quietYear: number;
  quietCount: number;
  perYear: number;
  leggePct: number;
  regiPct: number;
  decretiPct: number;
  peakRefsYear: number;
  peakRefsMean: number;
  dlConvertito: number;
  dlDecaduto: number;
  peakRatio: number;
  fascismPct: number;
  republicPct: number;
  dlLapsePct: number;
  regiOneIn: number;
  govOneIn: number;
  spanYears: number;
};

const ANIM_SET = new Set<string>(DIRECTOR_ANIMATIONS);
const EVENT_SET = new Set<string>(DIRECTOR_EVENTS);

export const DIRECTOR_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["animation", "line"],
  properties: {
    animation: { type: "string", enum: [...DIRECTOR_ANIMATIONS] },
    line: { type: "string" },
    event: { type: "string", enum: [...DIRECTOR_EVENTS] },
    year: { type: "integer" },
  },
} as const;

function sumRows(
  rows: TalkData["byYear"]["rows"],
  pred: (r: { year: number; type: string; count: number }) => boolean,
): number {
  let n = 0;
  for (const r of rows) if (pred(r)) n += r.count;
  return n;
}

function inYears(year: number, from: number, to: number) {
  return year >= from && year <= to;
}

function pct(part: number, total: number) {
  if (total <= 0) return 0;
  return Math.round((100 * part) / total);
}

function countsByYear(rows: TalkData["byYear"]["rows"]): { year: number; count: number }[] {
  const m = new Map<number, number>();
  for (const r of rows) m.set(r.year, (m.get(r.year) ?? 0) + r.count);
  return [...m.entries()]
    .map(([year, count]) => ({ year, count }))
    .sort((a, b) => a.year - b.year);
}

export function factsForStep(stepId: string, data: TalkData): StepFacts {
  const rows = data.byYear.rows;
  const firstYear = data.dateRange.firstEnactYear;
  const lastYear = data.dateRange.lastEnactYear;
  const total = sumRows(rows, () => true);
  const legge = sumRows(rows, (r) => r.type === "LEGGE");
  const regi = sumRows(rows, (r) => r.type === "REGIO DECRETO" || r.type === "REGIO DECRETO-LEGGE");
  const decreti = sumRows(rows, (r) => GOVERNO_TYPES.has(r.type));
  const monarchy = sumRows(rows, (r) => inYears(r.year, 1861, 1945));
  const republic = sumRows(rows, (r) => inYears(r.year, 1946, lastYear));
  const fascism = sumRows(rows, (r) => inYears(r.year, 1922, 1945));
  const secondRep = sumRows(rows, (r) => inYears(r.year, 1990, lastYear));
  const unita = sumRows(rows, (r) => inYears(r.year, 1861, 1921));
  const parlamento = legge;
  const governo = decreti;
  const y2008 = sumRows(rows, (r) => r.year === 2008);
  const y2009 = sumRows(rows, (r) => r.year === 2009);
  const refsMean =
    data.refsByYear.length > 0
      ? data.refsByYear.reduce((s, r) => s + r.mean, 0) / data.refsByYear.length
      : 0;
  const years = countsByYear(rows);
  let peak = years[0] ?? { year: firstYear, count: 0 };
  let quiet = years.find((y) => y.count > 0) ?? peak;
  for (const y of years) {
    if (y.count > peak.count) peak = y;
    if (y.count > 0 && y.count < quiet.count) quiet = y;
  }
  let peakRefs = data.refsByYear[0] ?? { year: firstYear, mean: 0 };
  for (const r of data.refsByYear) {
    if (r.mean > peakRefs.mean) peakRefs = r;
  }
  let dlConvertito = 0;
  let dlDecaduto = 0;
  for (const r of data.dlOutcomes) {
    dlConvertito += r.convertito;
    dlDecaduto += r.decaduto;
  }
  const span = Math.max(1, lastYear - firstYear + 1);
  const dlAll = dlConvertito + dlDecaduto;
  return {
    stepId,
    firstYear,
    lastYear,
    total,
    legge,
    regi,
    decreti,
    monarchy,
    republic,
    fascism,
    secondRep,
    unita,
    parlamento,
    governo,
    y2008,
    y2009,
    deltaAbs: Math.abs(y2009 - y2008),
    refsMean,
    peakYear: peak.year,
    peakCount: peak.count,
    quietYear: quiet.year,
    quietCount: quiet.count,
    perYear: Math.round(total / span),
    leggePct: pct(legge, total),
    regiPct: pct(regi, total),
    decretiPct: pct(decreti, total),
    peakRefsYear: peakRefs.year,
    peakRefsMean: peakRefs.mean,
    dlConvertito,
    dlDecaduto,
    peakRatio: Math.max(1, Math.round(peak.count / Math.max(1, quiet.count))),
    fascismPct: pct(fascism, total),
    republicPct: pct(republic, total),
    dlLapsePct: pct(dlDecaduto, dlAll),
    regiOneIn: Math.max(1, Math.round(total / Math.max(1, regi))),
    govOneIn: Math.max(1, Math.round(total / Math.max(1, governo))),
    spanYears: span,
  };
}

export function factYears(facts: StepFacts): number[] {
  return [
    facts.firstYear,
    facts.lastYear,
    facts.peakYear,
    facts.quietYear,
    2008,
    2009,
    facts.peakRefsYear,
  ];
}

export function factNumbers(facts: StepFacts): number[] {
  return [
    facts.total,
    facts.legge,
    facts.regi,
    facts.decreti,
    facts.monarchy,
    facts.republic,
    facts.fascism,
    facts.secondRep,
    facts.unita,
    facts.parlamento,
    facts.governo,
    facts.y2008,
    facts.y2009,
    facts.deltaAbs,
    facts.firstYear,
    facts.lastYear,
    facts.peakYear,
    facts.peakCount,
    facts.quietYear,
    facts.quietCount,
    facts.perYear,
    facts.leggePct,
    facts.regiPct,
    facts.decretiPct,
    facts.peakRefsYear,
    facts.dlConvertito,
    facts.dlDecaduto,
    facts.peakRatio,
    facts.fascismPct,
    facts.republicPct,
    facts.dlLapsePct,
    facts.regiOneIn,
    facts.govOneIn,
    facts.spanYears,
  ];
}

function vars(facts: StepFacts, locale: Locale): Record<string, string | number> {
  const n = (x: number) => formatCount(x, locale);
  return {
    total: n(facts.total),
    legge: n(facts.legge),
    regi: n(facts.regi),
    decreti: n(facts.decreti),
    monarchy: n(facts.monarchy),
    republic: n(facts.republic),
    fascism: n(facts.fascism),
    secondRep: n(facts.secondRep),
    parlamento: n(facts.parlamento),
    governo: n(facts.governo),
    y2008: n(facts.y2008),
    y2009: n(facts.y2009),
    deltaAbs: n(facts.deltaAbs),
    first: facts.firstYear,
    last: facts.lastYear,
    unita: n(facts.unita),
    peakYear: facts.peakYear,
    peakCount: n(facts.peakCount),
    quietYear: facts.quietYear,
    quietCount: n(facts.quietCount),
    perYear: n(facts.perYear),
    leggePct: facts.leggePct,
    regiPct: facts.regiPct,
    decretiPct: facts.decretiPct,
    peakRefsYear: facts.peakRefsYear,
    peakRefs: facts.peakRefsMean.toLocaleString(locale === "en" ? "en-GB" : "it-IT", {
      maximumFractionDigits: 1,
    }),
    dlConvertito: n(facts.dlConvertito),
    dlDecaduto: n(facts.dlDecaduto),
    peakRatio: n(facts.peakRatio),
    fascismPct: facts.fascismPct,
    republicPct: facts.republicPct,
    dlLapsePct: facts.dlLapsePct,
    regiOneIn: n(facts.regiOneIn),
    govOneIn: n(facts.govOneIn),
    span: n(facts.spanYears),
    refs: facts.refsMean.toLocaleString(locale === "en" ? "en-GB" : "it-IT", {
      maximumFractionDigits: 1,
    }),
  };
}

export function cannedCue(stepId: string, facts: StepFacts, locale: Locale): string {
  const id = SCROLLY_STEP_IDS.includes(stepId as (typeof SCROLLY_STEP_IDS)[number])
    ? stepId
    : "archivio";
  return t(`digesto.cues.${id}`, vars(facts, locale), locale);
}

export function factParagraph(facts: StepFacts, locale: Locale): string {
  const v = vars(facts, locale);
  if (locale === "en") {
    return `Step ${facts.stepId}. Span ${v.first}–${v.last}. Peak year ${v.peakYear} with ${v.peakCount} acts; quietest ${v.quietYear} with ${v.quietCount}. About ${v.perYear} acts per year. Mix: statutes ${v.leggePct}%, royal decrees ${v.regiPct}%, executive decrees ${v.decretiPct}%. Unification ${v.unita}, fascism ${v.fascism}, Republic ${v.republic} (of which ${v.secondRep} from 1990). 2008: ${v.y2008}. 2009: ${v.y2009} (gap ${v.deltaAbs}). Mean refs ${v.refs}; peak refs in ${v.peakRefsYear} (${v.peakRefs}). Decree-laws: ${v.dlConvertito} converted, ${v.dlDecaduto} lapsed.`;
  }
  return `Passo ${facts.stepId}. Intervallo ${v.first}–${v.last}. Anno di picco ${v.peakYear} con ${v.peakCount} atti; il più magro ${v.quietYear} con ${v.quietCount}. Circa ${v.perYear} atti l’anno. Mix: leggi ${v.leggePct}%, regi ${v.regiPct}%, decreti ${v.decretiPct}%. Unità ${v.unita}, fascismo ${v.fascism}, Repubblica ${v.republic} (di cui ${v.secondRep} dal 1990). 2008: ${v.y2008}. 2009: ${v.y2009} (scarto ${v.deltaAbs}). Rinvii medi ${v.refs}; picco nel ${v.peakRefsYear} (${v.peakRefs}). DL: ${v.dlConvertito} convertiti, ${v.dlDecaduto} decaduti.`;
}

export function cannedWhisper(stepId: string, facts: StepFacts, locale: Locale): string {
  const id = SCROLLY_STEP_IDS.includes(stepId as (typeof SCROLLY_STEP_IDS)[number])
    ? stepId
    : "archivio";
  return t(`digesto.whispers.${id}`, vars(facts, locale), locale);
}

const IT_MARK = /[àèéìòù]|\b(atti|leggi|decreti|dal|nel|sotto|repubblica|monarchia)\b/i;
const EN_MARK = /\b(the|acts|laws|decrees|under|republic|monarchy|from)\b/i;

export function whisperAccepts(
  line: string,
  facts: StepFacts,
  locale: Locale,
): boolean {
  const s = stripInstructionLeak(line).trim();
  if (!s || s.length > 220) return false;
  const formatted = factNumbers(facts).map((n) => formatCount(n, locale));
  const hasNum = formatted.some((n) => n !== "0" && s.includes(n));
  if (!hasNum) return false;
  if (locale === "it") return IT_MARK.test(s) && !/^(the|during|from)\b/i.test(s);
  return EN_MARK.test(s);
}

export function directorSystemPrompt(locale: Locale, withImage = false): string {
  const visionEn = withImage
    ? ` The attached image is the chart on screen. Name the visual event (peak, hole, cliff, share, or flat). Optional JSON fields: "event" and "year" (year only if it is a FACT year). Describe the bars, not the step title.`
    : "";
  const visionIt = withImage
    ? ` L’immagine è il grafico in pagina. Nomina l’evento visivo (peak, hole, cliff, share o flat). Campi JSON opzionali: "event" e "year" (year solo se è un anno dei FATTI). Parla delle barre, non del titolo del passo.`
    : "";
  return locale === "en"
    ? `You are Digesto directing a scrollytelling page about the Italian law corpus.
Reply with JSON only: {"animation": one of ${DIRECTOR_ANIMATIONS.join("|")}, "line": "..."}.
The line is at most 160 characters, dry, in English. Use only the FACTS for this step. Prefer a contrast: ratio, share, or before/after. Do not restate a single total. Do not repeat the corpus grand total unless the step is archivio. Keep every numeral as given. No legal advice.${visionEn}`
    : `Sei Digesto, regista di una pagina scrolly sul corpus normativo italiano.
Rispondi solo JSON: {"animation": uno tra ${DIRECTOR_ANIMATIONS.join("|")}, "line": "..."}.
La riga ha al massimo 160 caratteri, secca, in italiano. Usa solo i FATTI di questo passo. Preferisci un contrasto: rapporto, quota o prima/dopo. Non ripetere un solo totale. Non ripetere il totale del corpus se il passo non è archivio. Conserva ogni numerali così come sono. Niente consulenza legale.${visionIt}`;
}

export function parseDirectorCue(raw: string, facts: StepFacts, locale: Locale): DirectorCue | null {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof o.animation !== "string" || !ANIM_SET.has(o.animation)) return null;
    if (typeof o.line !== "string") return null;
    if (o.event != null && (typeof o.event !== "string" || !EVENT_SET.has(o.event))) return null;
    if (o.year != null) {
      if (typeof o.year !== "number" || !Number.isInteger(o.year)) return null;
      if (!factYears(facts).includes(o.year)) return null;
    }
    const line = stripInstructionLeak(o.line).trim();
    if (!line || line.length > 190) return null;
    const nums = factNumbers(facts).map((n) => formatCount(n, locale));
    const mentioned = nums.filter((n) => n !== "0" && line.includes(n));
    if (mentioned.length === 0) return null;
    return { animation: o.animation as DirectorAnimation, line };
  } catch {
    return null;
  }
}

export function defaultAnimation(stepId: string): DirectorAnimation {
  if (stepId === "taglio") return "GetAttention";
  if (stepId === "close") return "Congratulate";
  if (stepId === "memoria") return "LookLeft";
  return "Speak";
}

export function cueOrCanned(
  parsed: DirectorCue | null,
  stepId: string,
  facts: StepFacts,
  locale: Locale,
): DirectorCue {
  if (parsed) return parsed;
  return { animation: defaultAnimation(stepId), line: cannedCue(stepId, facts, locale) };
}
