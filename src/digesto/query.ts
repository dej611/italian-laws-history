/** Frozen analytics ontology for Digesto. No model, no DuckDB. */

export const ERA_IDS = [
  "monarchy",
  "liberal",
  "fascism",
  "republic",
  "first_rep",
  "second_rep",
] as const;
export type EraId = (typeof ERA_IDS)[number];

export const EXACT_TYPES = [
  "REGIO DECRETO-LEGGE",
  "DECRETO LEGISLATIVO",
  "DECRETO DEL PRESIDENTE DELLA REPUBBLICA",
  "DECRETO LUOGOTENENZIALE",
  "DECRETO-LEGGE",
  "REGIO DECRETO",
  "DECRETO",
  "LEGGE",
  "ALTRO",
] as const;
export type ExactType = (typeof EXACT_TYPES)[number];

export const CHANNEL_IDS = ["parlamento", "governo"] as const;
export type ChannelId = (typeof CHANNEL_IDS)[number];

export const MEASURES = [
  "all",
  "decreti_bare",
  "channels",
  "parlamento",
  "governo",
  ...EXACT_TYPES,
] as const;
export type Measure = (typeof MEASURES)[number];

export type QuerySpec = {
  intent: "count" | "compare";
  eras: EraId[];
  measure: Measure;
  from?: number;
  to?: number;
};

export type YearRow = { year: number; type: string; count: number };

export type ExecutedPart = {
  key: string;
  from: number;
  to: number;
  count: number;
};

export type ExecutedQuery = {
  spec: QuerySpec;
  numbers: number[];
  parts: ExecutedPart[];
};

export const GOVERNO_TYPES = new Set([
  "DECRETO-LEGGE",
  "DECRETO LEGISLATIVO",
  "REGIO DECRETO-LEGGE",
  "DECRETO LUOGOTENENZIALE",
]);

const ERA_FIXED: Record<EraId, { from: number; to: number | null }> = {
  monarchy: { from: 1861, to: 1945 },
  liberal: { from: 1861, to: 1921 },
  fascism: { from: 1922, to: 1945 },
  republic: { from: 1946, to: null },
  first_rep: { from: 1946, to: 1989 },
  second_rep: { from: 1990, to: null },
};

const ERA_LABEL = {
  it: {
    monarchy: "monarchia (Regno d’Italia)",
    liberal: "Italia liberale",
    fascism: "periodo fascista",
    republic: "Repubblica",
    first_rep: "Prima Repubblica",
    second_rep: "Seconda Repubblica",
  },
  en: {
    monarchy: "monarchy (Kingdom of Italy)",
    liberal: "Liberal Italy",
    fascism: "Fascist period",
    republic: "Republic",
    first_rep: "First Republic",
    second_rep: "Second Republic",
  },
} as const;

const GOVERNO_LIST = {
  it: "D.L., D.Lgs., R.D.L., luogotenenziale",
  en: "decree-laws, legislative decrees, royal decree-laws, lieutenant decrees",
} as const;

const FAMILY_LIST = {
  it: "incluso D.P.R. e regio decreto",
  en: "including presidential decrees and royal decrees",
} as const;

export const QUERY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "eras", "measure"],
  properties: {
    intent: { type: "string", enum: ["count", "compare"] },
    eras: {
      type: "array",
      items: { type: "string", enum: [...ERA_IDS] },
    },
    measure: { type: "string", enum: [...MEASURES] },
    from: { type: "integer" },
    to: { type: "integer" },
  },
} as const;

export function normalizeQueryText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/['’]/g, "'")
    .trim();
}

export function formatCount(n: number, locale: "it" | "en"): string {
  return new Intl.NumberFormat(locale === "en" ? "en-GB" : "it-IT").format(n);
}

function capTo(to: number | null, lastEnactYear: number): number {
  return Math.min(to ?? lastEnactYear, lastEnactYear);
}

export function eraBounds(era: EraId, lastEnactYear: number): { from: number; to: number } {
  const b = ERA_FIXED[era];
  return { from: b.from, to: capTo(b.to, lastEnactYear) };
}

export function isDecretoType(type: string): boolean {
  return type.includes("DECRETO");
}

export function typePredicate(measure: Measure): (type: string) => boolean {
  if (measure === "all" || measure === "decreti_bare" || measure === "channels") {
    return () => true;
  }
  if (measure === "parlamento" || measure === "LEGGE") return (t) => t === "LEGGE";
  if (measure === "governo") return (t) => GOVERNO_TYPES.has(t);
  return (t) => t === measure;
}

export function sumRows(
  rows: YearRow[],
  from: number,
  to: number,
  pred: (type: string) => boolean,
): number {
  let n = 0;
  for (const r of rows) {
    if (r.year >= from && r.year <= to && pred(r.type)) n += r.count;
  }
  return n;
}

export function specBounds(
  spec: QuerySpec,
  lastEnactYear: number,
): { from: number; to: number } {
  if (spec.from != null && spec.to != null) {
    return { from: spec.from, to: Math.min(spec.to, lastEnactYear) };
  }
  if (spec.from != null) {
    return { from: spec.from, to: lastEnactYear };
  }
  if (spec.eras.length === 1) return eraBounds(spec.eras[0], lastEnactYear);
  return { from: 1861, to: lastEnactYear };
}

export function executeSpec(
  spec: QuerySpec,
  rows: YearRow[],
  lastEnactYear: number,
): ExecutedQuery {
  const parts: ExecutedPart[] = [];

  if (spec.intent === "compare" && spec.measure === "channels") {
    const era = spec.eras[0] ?? "republic";
    const b = eraBounds(era, lastEnactYear);
    parts.push({
      key: "parlamento",
      ...b,
      count: sumRows(rows, b.from, b.to, (t) => t === "LEGGE"),
    });
    parts.push({
      key: "governo",
      ...b,
      count: sumRows(rows, b.from, b.to, (t) => GOVERNO_TYPES.has(t)),
    });
  } else if (spec.intent === "compare" && spec.eras.length >= 2) {
    for (const era of spec.eras.slice(0, 2)) {
      const b = eraBounds(era, lastEnactYear);
      parts.push({
        key: era,
        ...b,
        count: sumRows(rows, b.from, b.to, typePredicate(spec.measure)),
      });
    }
  } else if (spec.measure === "decreti_bare") {
    const b = specBounds(spec, lastEnactYear);
    parts.push({
      key: "governo",
      ...b,
      count: sumRows(rows, b.from, b.to, (t) => GOVERNO_TYPES.has(t)),
    });
    parts.push({
      key: "family",
      ...b,
      count: sumRows(rows, b.from, b.to, isDecretoType),
    });
  } else {
    const b = specBounds(spec, lastEnactYear);
    parts.push({
      key: spec.measure,
      ...b,
      count: sumRows(rows, b.from, b.to, typePredicate(spec.measure)),
    });
  }

  return { spec, parts, numbers: parts.map((p) => p.count) };
}

function cosa(measure: Measure, locale: "it" | "en"): string {
  if (locale === "en") {
    if (measure === "LEGGE" || measure === "parlamento") return "statutes (type LEGGE)";
    if (measure === "all") return "acts";
    if (measure === "REGIO DECRETO") return "royal decrees (REGIO DECRETO)";
    if (measure === "DECRETO-LEGGE") return "decree-laws (DECRETO-LEGGE)";
    if (measure === "DECRETO DEL PRESIDENTE DELLA REPUBBLICA") {
      return "presidential decrees (D.P.R.)";
    }
    return `acts of type ${measure}`;
  }
  if (measure === "LEGGE" || measure === "parlamento") return "leggi (tipo LEGGE)";
  if (measure === "all") return "atti";
  if (measure === "REGIO DECRETO") return "regi decreti (REGIO DECRETO)";
  if (measure === "DECRETO-LEGGE") return "decreti-legge (DECRETO-LEGGE)";
  if (measure === "DECRETO DEL PRESIDENTE DELLA REPUBBLICA") {
    return "D.P.R. (DECRETO DEL PRESIDENTE DELLA REPUBBLICA)";
  }
  return `atti di tipo ${measure}`;
}

function caveat(locale: "it" | "en"): string {
  return locale === "en"
    ? "Count by year of enactment; not “in force” status."
    : "Conteggio per anno di emanazione; non è lo status “vigente”.";
}

export function formatAnswer(executed: ExecutedQuery, locale: "it" | "en"): string {
  const { spec, parts } = executed;
  const n = (c: number) => formatCount(c, locale);
  const eraL = (id: EraId) => ERA_LABEL[locale][id];

  if (spec.measure === "decreti_bare" && parts.length >= 2) {
    const gov = parts[0];
    const fam = parts[1];
    const where =
      spec.eras[0] != null
        ? locale === "en"
          ? `under the ${eraL(spec.eras[0])}`
          : `sotto la ${eraL(spec.eras[0])}`
        : locale === "en"
          ? "in the corpus"
          : "nel corpus";
    if (locale === "en") {
      return `${where.charAt(0).toUpperCase() + where.slice(1)} (${gov.from}–${gov.to}), executive acts (${GOVERNO_LIST.en}) number ${n(gov.count)}. All types with “decreto” in the name (${FAMILY_LIST.en}) number ${n(fam.count)}. ${caveat(locale)}`;
    }
    return `${where.charAt(0).toUpperCase() + where.slice(1)} (${gov.from}–${gov.to}), gli atti dell’esecutivo (${GOVERNO_LIST.it}) sono ${n(gov.count)}. Tutti i tipi con «decreto» nel nome (${FAMILY_LIST.it}) sono ${n(fam.count)}. ${caveat(locale)}`;
  }

  if (spec.intent === "compare" && spec.measure === "channels" && parts.length >= 2) {
    const p = parts[0];
    const g = parts[1];
    const winner =
      p.count === g.count
        ? locale === "en"
          ? "Neither side is larger."
          : "Stesso numero per entrambi."
        : p.count > g.count
          ? locale === "en"
            ? "Parliament produced more."
            : "Ha prodotto di più il parlamento."
          : locale === "en"
            ? "The executive produced more."
            : "Ha prodotto di più il governo.";
    const era = spec.eras[0];
    const where = era
      ? locale === "en"
        ? `In the ${eraL(era)} (${p.from}–${p.to})`
        : `Nella ${eraL(era)} (${p.from}–${p.to})`
      : locale === "en"
        ? `In ${p.from}–${p.to}`
        : `Nel periodo ${p.from}–${p.to}`;
    if (locale === "en") {
      return `${where}, parliament (statutes) enacted ${n(p.count)} acts; the executive (${GOVERNO_LIST.en}) enacted ${n(g.count)}. ${winner} ${caveat(locale)}`;
    }
    return `${where} il parlamento (leggi) ha emanato ${n(p.count)} atti, il governo (${GOVERNO_LIST.it}) ${n(g.count)}. ${winner} ${caveat(locale)}`;
  }

  if (spec.intent === "compare" && parts.length >= 2) {
    const a = parts[0];
    const b = parts[1];
    const ea = spec.eras[0];
    const eb = spec.eras[1];
    const thing = cosa(spec.measure, locale);
    const winner =
      a.count === b.count
        ? locale === "en"
          ? "The two periods are tied."
          : "Stesso numero nei due periodi."
        : a.count > b.count
          ? locale === "en"
            ? `More were enacted under the ${eraL(ea)}.`
            : `Ne sono state emanate di più sotto la ${eraL(ea)}.`
          : locale === "en"
            ? `More were enacted under the ${eraL(eb)}.`
            : `Ne sono state emanate di più sotto la ${eraL(eb)}.`;
    if (locale === "en") {
      return `Under the ${eraL(ea)} (${a.from}–${a.to}) there are ${n(a.count)} ${thing}; under the ${eraL(eb)} (${b.from}–${b.to}) there are ${n(b.count)}. ${winner} ${caveat(locale)}`;
    }
    return `Sotto la ${eraL(ea)} (${a.from}–${a.to}) risultano ${n(a.count)} ${thing}; sotto la ${eraL(eb)} (${b.from}–${b.to}) risultano ${n(b.count)}. ${winner} ${caveat(locale)}`;
  }

  const p = parts[0];
  const thing = cosa(spec.measure, locale);
  const when =
    spec.eras[0] != null
      ? locale === "en"
        ? `Under the ${eraL(spec.eras[0])} (${p.from}–${p.to})`
        : `Sotto la ${eraL(spec.eras[0])} (${p.from}–${p.to})`
      : p.from === p.to
        ? locale === "en"
          ? `In ${p.from}`
          : `Nel ${p.from}`
        : locale === "en"
          ? `From ${p.from} to ${p.to}`
          : `Dal ${p.from} al ${p.to}`;
  if (locale === "en") {
    return `${when} the corpus has ${n(p.count)} ${thing}. ${caveat(locale)}`;
  }
  return `${when} risultano ${n(p.count)} ${thing} emanati nel corpus. ${caveat(locale)}`;
}

export function stripInstructionLeak(text: string): string {
  const instruction =
    /^(sei (martello|digesto)|you are digesto|rephrase\b|rispondi in |answer in |keep (all )?numbers|keep every numeral|do not (add|drop|repeat)|non (ripetere|dire|aggiungere)|usa solo i fatti|use only the facts|write only the final|scrivi solo la risposta|non informare|risultati tool)/i;

  let s = text.trim();
  s = s
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!instruction.test(t)) return true;
      return t.length > 120;
    })
    .join("\n")
    .trim();

  for (let i = 0; i < 8; i++) {
    const m = s.match(/^([^.!?\n]+[.!?])\s*/);
    if (!m || !instruction.test(m[1].trim())) break;
    s = s.slice(m[0].length).trim();
  }
  return s;
}

export function numberLockHolds(
  paraphrase: string,
  numbers: number[],
  locale: "it" | "en",
): boolean {
  return numbers.every((num) => {
    const formatted = formatCount(num, locale);
    const escaped = formatted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![\\d.,])${escaped}(?![\\d.,]\\d)`);
    return re.test(paraphrase);
  });
}

const MEASURE_SET = new Set<string>(MEASURES);
const ERA_SET = new Set<string>(ERA_IDS);

export function validateSpec(raw: unknown): QuerySpec | null {
  if (raw == null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.intent !== "count" && o.intent !== "compare") return null;
  if (!Array.isArray(o.eras)) return null;
  const eras: EraId[] = [];
  for (const e of o.eras) {
    if (typeof e !== "string" || !ERA_SET.has(e)) return null;
    eras.push(e as EraId);
  }
  if (typeof o.measure !== "string" || !MEASURE_SET.has(o.measure)) return null;
  const spec: QuerySpec = {
    intent: o.intent,
    eras,
    measure: o.measure as Measure,
  };
  if (o.from != null) {
    if (typeof o.from !== "number" || !Number.isInteger(o.from)) return null;
    spec.from = o.from;
  }
  if (o.to != null) {
    if (typeof o.to !== "number" || !Number.isInteger(o.to)) return null;
    spec.to = o.to;
  }
  if (Object.keys(o).some((k) => !["intent", "eras", "measure", "from", "to"].includes(k))) {
    return null;
  }
  if (spec.intent === "compare" && spec.measure === "channels" && spec.eras.length < 1) {
    return null;
  }
  if (spec.intent === "compare" && spec.measure !== "channels" && spec.eras.length < 2) {
    return null;
  }
  return spec;
}

export function parseJsonSpec(text: string): QuerySpec | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return validateSpec(JSON.parse(body.slice(start, end + 1)));
  } catch {
    return null;
  }
}

export function isTextSearchQuery(text: string): boolean {
  const s = normalizeQueryText(text);
  return /testo|articolo|costituz|taglia|taglio|legge\s+\d|modifica|abrog|ripristin|cerca|cosa dice|estratt|what does|search for|excerpt/.test(
    s,
  );
}

type EraHit = { id: EraId; index: number };

function findEras(lower: string): EraId[] {
  const hits: EraHit[] = [];
  const add = (id: EraId, re: RegExp) => {
    const copy = new RegExp(re.source, "gi");
    for (const m of lower.matchAll(copy)) {
      hits.push({ id, index: m.index ?? 0 });
    }
  };
  add("second_rep", /seconda\s+repubblic|second\s+republ/);
  add("first_rep", /prima\s+repubblic|first\s+republ/);
  add("liberal", /italia\s+liberale|liberal\s+italy|periodo\s+liberale/);
  add("fascism", /fascis|ventennio|mussolini/);
  add("monarchy", /monarch|regno(?:\s+d'italia)?|savoia/);
  add("republic", /repubblic|republ/);

  hits.sort((a, b) => a.index - b.index);
  const out: EraId[] = [];
  const seen = new Set<EraId>();
  for (const h of hits) {
    if (h.id === "republic") {
      const before = lower.slice(Math.max(0, h.index - 28), h.index);
      if (/prima\s+$|seconda\s+$|first\s+$|second\s+$/.test(before)) continue;
      if (/presidente della\s+$|president of the\s+$/.test(before)) continue;
    }
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    out.push(h.id);
  }
  return out;
}

function findMeasure(lower: string): Measure | null {
  const channelAsk =
    !/government status|forma di stato|forma di governo/.test(lower) &&
    /parlament|parliament/.test(lower) &&
    /govern|esecutiv|executive/.test(lower);
  if (channelAsk) return "channels";

  if (/regio\s+decreto[\s-]*legge|r\.?\s*d\.?\s*l\.?|royal\s+decree[\s-]*law/.test(lower)) {
    return "REGIO DECRETO-LEGGE";
  }
  if (/decreto\s+legislativ|d\.?\s*lgs|legislative\s+decree/.test(lower)) {
    return "DECRETO LEGISLATIVO";
  }
  if (
    /decreto\s+del\s+presidente|d\.?\s*p\.?\s*r\.?|\bdpr\b|presidential\s+decree/.test(lower)
  ) {
    return "DECRETO DEL PRESIDENTE DELLA REPUBBLICA";
  }
  if (/decreto\s+luogotenenzial|lieutenant\s+decree/.test(lower)) {
    return "DECRETO LUOGOTENENZIALE";
  }
  if (
    /decret[oi][\s-]+legge|decree[\s-]+law|decree[\s-]+laws/.test(lower) ||
    /(?<![a-z])d\.?\s*l\.?(?!\s*gs)/.test(lower)
  ) {
    return "DECRETO-LEGGE";
  }
  if (/regio\s+decret|regi\s+decret|royal\s+decree|\br\.?\s*d\.?\b/.test(lower)) {
    return "REGIO DECRETO";
  }
  if (/\bleggi?\b|\blaws?\b|\bstatutes?\b/.test(lower)) return "LEGGE";
  if (/\bdecreti\b|\bdecrees\b|\bdecree\b/.test(lower)) return "decreti_bare";
  if (/\batti\b|\bacts\b|\bnorme\b|\bcorpus\b/.test(lower)) return "all";
  return null;
}

function findYearRange(lower: string): { from: number; to?: number } | null {
  const tra =
    lower.match(/tra\s+(?:il\s+)?(\d{4})\s+e\s+(?:il\s+)?(\d{4})/) ||
    lower.match(/dal\s+(\d{4})\s+al\s+(\d{4})/) ||
    lower.match(/from\s+(\d{4})\s+to\s+(\d{4})/) ||
    lower.match(/between\s+(\d{4})\s+and\s+(\d{4})/) ||
    lower.match(/(\d{4})\s*[-–]\s*(\d{4})/);
  if (tra) return { from: Number(tra[1]), to: Number(tra[2]) };

  const since = lower.match(/\b(?:dal|since|from)\s+(\d{4})\b/);
  if (since) return { from: Number(since[1]) };

  const single =
    lower.match(/\b(?:nel|nella|anno|in)\s+(\d{4})\b/) ||
    lower.match(/\b(18\d{2}|19\d{2}|20\d{2})\b/);
  if (single && /quant|how many|contegg|emanat|fatte|leggi|atti|laws|acts/.test(lower)) {
    const y = Number(single[1]);
    return { from: y, to: y };
  }
  return null;
}

function hasCountCue(lower: string): boolean {
  return /quant[ieoa]?|how many|numero|contegg|emanat|prodot|delivered|produced|approvat|risultan/.test(
    lower,
  );
}

function hasCompareCue(lower: string): boolean {
  return /piu\b|more\b|which\b|who\b|vs\.?|versus|oppure|\bo\b|\bor\b|dove sono|produced more|delivered more/.test(
    lower,
  );
}

function isFullInterrogative(lower: string): boolean {
  return /quant[ieoa]?|how many|which\b|who\b|what\b|dove\b|ha prodotto|in (?:the )?repubblic|in (?:the )?republic/.test(
    lower,
  );
}

function isFragment(lower: string): boolean {
  if (/^\s*(e|ed|and|anche)\b/.test(lower)) return true;
  if (isFullInterrogative(lower)) return false;
  const stripped = lower
    .replace(/[?!.,:;]/g, " ")
    .replace(/\b(sotto|la|il|lo|the|durante|during|in|nel|nella|di|del|e|and)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length === 0 || stripped.length > 40) return false;
  return findEras(lower).length > 0 || findMeasure(lower) != null;
}

function eraAfterPrep(lower: string): EraId | null {
  const matches = [...lower.matchAll(/\b(?:sotto|durante|under|during)\s+(?:la\s+|il\s+|lo\s+|the\s+)?/g)];
  const last = matches.at(-1);
  if (last?.index == null) return null;
  const tail = lower.slice(last.index + last[0].length);
  return findEras(tail)[0] ?? null;
}

export function parseQuery(text: string, lastSpec?: QuerySpec | null): QuerySpec | null {
  const lower = normalizeQueryText(text);
  if (!lower) return null;

  const years = findYearRange(lower);
  const eras = findEras(lower);
  const prepEra = eraAfterPrep(lower);
  let measure = findMeasure(lower);

  if (lastSpec && isFragment(lower) && !isFullInterrogative(lower)) {
    const next: QuerySpec = {
      intent: "count",
      eras: eras.length ? eras.slice(0, 1) : [...lastSpec.eras],
      measure: measure ?? lastSpec.measure,
    };
    if (years?.from != null) next.from = years.from;
    if (years?.to != null) next.to = years.to;
    else if (lastSpec.from != null && !eras.length && years == null) next.from = lastSpec.from;
    if (lastSpec.to != null && !eras.length && years == null) next.to = lastSpec.to;
    return next;
  }

  if (measure === "channels" && (hasCompareCue(lower) || eras.length >= 1)) {
    return {
      intent: "compare",
      eras: eras.length ? eras.slice(0, 1) : ["republic"],
      measure: "channels",
    };
  }

  if (eras.length >= 2 && (hasCompareCue(lower) || measure === "LEGGE")) {
    return {
      intent: "compare",
      eras: eras.slice(0, 2),
      measure: measure ?? "all",
    };
  }

  const counting = hasCountCue(lower) || measure != null || years != null;
  if (!counting) return null;

  if (measure == null) {
    if (/\batti\b|\bacts\b|\bcorpus\b/.test(lower)) measure = "all";
    else if (eras.length || years) measure = "all";
    else return null;
  }

  const spec: QuerySpec = {
    intent: "count",
    eras: years != null ? [] : prepEra ? [prepEra] : eras.slice(0, 1),
    measure,
  };
  if (years?.from != null) spec.from = years.from;
  if (years?.to != null) spec.to = years.to;
  return spec;
}

export function slotFillSystemPrompt(locale: "it" | "en"): string {
  const lang = locale === "en" ? "English" : "Italian";
  return `You map a user question about the Italian legal corpus to JSON.
Reply with JSON only, no markdown.
Schema: {"intent":"count"|"compare","eras":[${ERA_IDS.map((e) => `"${e}"`).join(",")}],"measure":one of ${MEASURES.map((m) => `"${m}"`).join(", ")},"from"?:year,"to"?:year}
Rules:
- laws/leggi → "LEGGE". acts/atti → "all". Bare decrees/decreti → "decreti_bare".
- parliament vs government → intent compare, measure "channels".
- monarchy vs republic → intent compare, two eras, measure LEGGE if they say laws.
- Second Republic starts 1990. First Republic is 1946–1989. Fascism is 1922–1945.
- Do not invent fields. Language of the question: ${lang}.`;
}
