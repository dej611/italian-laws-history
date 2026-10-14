import { stripInstructionLeak } from "./query";
import type { Locale } from "../i18n";

export type ActBlurb = { summary: string; changes: string };

const IT_MARK = /[àèéìòù]|\b(atto|atti|legge|leggi|decreto|decreti|articolo|modific|dal|nel|della|delle|sulla|sulle)\b/i;
const EN_OPEN = /^(the|this|during|from)\b/i;

export function extractiveSummary(raw: string, maxSentences = 4): string {
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s) return "";
  const parts = s
    .split(/(?<=[.!?])\s+(?=[A-ZÀÈÉÌÒÙ"«])/)
    .map((p) => p.trim())
    .filter((p) => p.replace(/[.!?]/g, "").trim().length > 12);
  if (!parts.length) {
    return s.length > 480 ? `${s.slice(0, 477).trim()}…` : s;
  }
  return parts.slice(0, maxSentences).join(" ");
}

export function actBlurbSystem(locale: Locale): string {
  return locale === "en"
    ? `You summarize one Italian legal act from a short excerpt plus revision facts.
Reply with JSON only: {"summary":"...","changes":"..."}.
summary: 3 or 4 dry English sentences on what the act is about. Use only the excerpt. Do not invent articles, dates, or numbers.
changes: 1 or 2 sentences on how the act changed, using ONLY the revision facts. If there is a single version, say so.
No legal advice. No 19th-century costume.`
    : `Riassumi un atto normativo italiano da un estratto breve e dai fatti di revisione.
Rispondi solo JSON: {"summary":"...","changes":"..."}.
summary: 3 o 4 frasi secche in italiano su cosa disciplina l’atto. Usa solo l’estratto. Non inventare articoli, date o numeri.
changes: 1 o 2 frasi su come è cambiato, usando SOLO i fatti di revisione. Se c’è una sola versione, dillo.
Niente consulenza legale. Niente italiano ottocentesco.`;
}

export function actBlurbUser(input: {
  title: string;
  excerpt: string;
  arc: string;
  locale: Locale;
}): string {
  if (input.locale === "en") {
    return `Act: ${input.title}\n\nEXCERPT:\n${input.excerpt}\n\nREVISION FACTS:\n${input.arc}\nWrite JSON only.`;
  }
  return `Atto: ${input.title}\n\nESTRATTO:\n${input.excerpt}\n\nFATTI DI REVISIONE:\n${input.arc}\nScrivi solo JSON.`;
}

export function parseActBlurb(raw: string, locale: Locale): ActBlurb | null {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof o.summary !== "string" || typeof o.changes !== "string") return null;
    const summary = stripInstructionLeak(o.summary).replace(/\s+/g, " ").trim();
    const changes = stripInstructionLeak(o.changes).replace(/\s+/g, " ").trim();
    if (summary.length < 60 || summary.length > 900) return null;
    if (changes.length < 18 || changes.length > 450) return null;
    if (locale === "it") {
      if (EN_OPEN.test(summary) || !IT_MARK.test(summary)) return null;
      if (EN_OPEN.test(changes)) return null;
    }
    return { summary, changes };
  } catch {
    return null;
  }
}

export const ACT_BLURB_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "changes"],
  properties: {
    summary: { type: "string" },
    changes: { type: "string" },
  },
} as const;
