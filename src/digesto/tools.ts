import { dataUrl } from "../data/load";
import { getLocale } from "../i18n";
import type { TalkData } from "../data/types";
import { buildChart, type DigestoChart } from "./chart";
import { executeSpec, formatAnswer, type QuerySpec } from "./query";

export type ToolResult = {
  name: string;
  ok: boolean;
  content: string;
  /** Human summary when the tool can answer without the LLM. */
  risposta?: string;
  /** Chart DSL when analytics can visualize the result. */
  chart?: DigestoChart;
};

let talkCache: TalkData | null = null;
let ragCache: {
  vocab: string[];
  docs: { slug: string; label: string; excerpt: string; embedding: number[] }[];
} | null = null;

async function getTalk(): Promise<TalkData> {
  if (talkCache) return talkCache;
  const r = await fetch(dataUrl("/data/data.json"));
  talkCache = (await r.json()) as TalkData;
  return talkCache;
}

async function getRag() {
  if (ragCache) return ragCache;
  const r = await fetch(dataUrl("/data/rag/index.json"));
  if (!r.ok) throw new Error("RAG index missing");
  ragCache = await r.json();
  return ragCache!;
}

function tokenize(text: string) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length > 2);
}

function cosine(a: number[], b: number[]) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export function looksLikeLegalAdvice(q: string) {
  const s = q.toLowerCase();
  return /posso\b|devo\b|è legale|e legale|nel mio caso|consiglio|avvocato|mi conviene|posso fare/.test(
    s,
  );
}

async function runSelect(sql: string) {
  const { runSelect: run } = await import("./duckdb");
  return run(sql);
}

export async function toolAnalytics(spec: QuerySpec): Promise<ToolResult> {
  const data = await getTalk();
  const executed = executeSpec(spec, data.byYear.rows, data.dateRange.lastEnactYear);
  const locale = getLocale();
  const risposta = formatAnswer(executed, locale);
  const chart = buildChart(executed, data.byYear.rows, locale);
  return {
    name: "sql_query",
    ok: true,
    risposta,
    chart,
    content: JSON.stringify({ spec, parts: executed.parts }),
  };
}

export async function toolSqlQuery(sql: string): Promise<ToolResult> {
  const q = sql.trim();
  if (/^(select|with)\b/i.test(q)) {
    try {
      const rows = await runSelect(q);
      return { name: "sql_query", ok: true, content: JSON.stringify(rows) };
    } catch (e) {
      return {
        name: "sql_query",
        ok: false,
        content: e instanceof Error ? e.message : "Errore SQL",
      };
    }
  }
  return {
    name: "sql_query",
    ok: false,
    content: "Domanda non interpretata come SELECT.",
  };
}

export async function toolSearchLaws(query: string, k = 4): Promise<ToolResult> {
  const rag = await getRag();
  const tokens = tokenize(query);
  const tf: Record<string, number> = {};
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  const qVec = new Array(rag.vocab.length).fill(0);
  const index = new Map(rag.vocab.map((t, i) => [t, i]));
  for (const [t, c] of Object.entries(tf)) {
    const i = index.get(t);
    if (i != null) qVec[i] = c;
  }
  let norm = Math.sqrt(qVec.reduce((s, v) => s + v * v, 0)) || 1;
  for (let i = 0; i < qVec.length; i++) qVec[i] /= norm;

  const scored = rag.docs
    .map((d) => ({
      slug: d.slug,
      label: d.label,
      excerpt: d.excerpt.slice(0, 400),
      score: cosine(qVec, d.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  const top = scored[0];
  const risposta =
    top && top.score > 0.05
      ? `Tra i testi locali, il più vicino è «${top.label}».`
      : undefined;

  return {
    name: "search_laws",
    ok: true,
    risposta,
    content: JSON.stringify(scored),
  };
}
