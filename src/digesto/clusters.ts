/** Grounded cluster labels from graph + act years. No invented topics. */

import type { ActsIndex, GraphData, GraphNode } from "../data/types";
import { formatCount } from "./query";
import type { Locale } from "../i18n";

export type ClusterFacts = {
  comp: string;
  size: number;
  hubId: string;
  hubLabel: string;
  fromYear: number | null;
  toYear: number | null;
};

function prettySlug(id: string) {
  return id
    .replace(/\.txt$/i, "")
    .replace(/-/g, " ")
    .replace(/\bdel\b/g, "del")
    .trim();
}

function shortHub(label: string): string {
  const s = label.replace(/\.txt$/i, "").trim();
  if (s.length <= 28) return s;
  return `${s.slice(0, 26)}…`;
}

export function clusterFacts(
  graph: GraphData,
  acts: ActsIndex | null,
  yearBySlug?: Map<string, number | null>,
): Map<string, ClusterFacts> {
  const years =
    yearBySlug ??
    new Map((acts?.acts ?? []).map((a) => [a.slug, a.enactYear] as const));
  const byComp = new Map<string, GraphNode[]>();
  for (const n of graph.nodes) {
    const list = byComp.get(n.comp) ?? [];
    list.push(n);
    byComp.set(n.comp, list);
  }
  const out = new Map<string, ClusterFacts>();
  for (const [comp, nodes] of byComp) {
    let hub = nodes[0];
    for (const n of nodes) {
      if ((n.degree || 0) > (hub.degree || 0)) hub = n;
      if (n.hub && !hub.hub) hub = n;
    }
    let fromYear: number | null = null;
    let toYear: number | null = null;
    for (const n of nodes) {
      const y = years.get(n.id) ?? null;
      if (y == null) continue;
      if (fromYear == null || y < fromYear) fromYear = y;
      if (toYear == null || y > toYear) toYear = y;
    }
    out.set(comp, {
      comp,
      size: nodes.length,
      hubId: hub.id,
      hubLabel: hub.label || prettySlug(hub.id),
      fromYear,
      toYear,
    });
  }
  return out;
}

export function cannedClusterLine(facts: ClusterFacts, locale: Locale): string {
  const hub = shortHub(facts.hubLabel);
  const n = formatCount(facts.size, locale);
  if (facts.fromYear != null && facts.toYear != null && facts.fromYear !== facts.toYear) {
    return locale === "en"
      ? `Around ${hub} · ${n} acts · ${facts.fromYear}–${facts.toYear}`
      : `Intorno a ${hub} · ${n} atti · ${facts.fromYear}–${facts.toYear}`;
  }
  if (facts.fromYear != null) {
    return locale === "en"
      ? `Around ${hub} · ${n} acts · ${facts.fromYear}`
      : `Intorno a ${hub} · ${n} atti · ${facts.fromYear}`;
  }
  return locale === "en" ? `Around ${hub} · ${n} acts` : `Intorno a ${hub} · ${n} atti`;
}

export function clusterEpithetSystem(locale: Locale): string {
  return locale === "en"
    ? `Reply JSON only: {"epithet":"..."}. At most 4 words. Use only the hub label given. Do not invent a legal topic.`
    : `Rispondi solo JSON: {"epithet":"..."}. Al massimo 4 parole. Usa solo l’etichetta del hub. Non inventare una materia giuridica.`;
}

export function parseEpithet(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(raw.slice(start, end + 1)) as { epithet?: unknown };
    if (typeof o.epithet !== "string") return null;
    const s = o.epithet.trim().replace(/\s+/g, " ");
    if (!s || s.length > 48) return null;
    if (s.split(" ").length > 6) return null;
    return s;
  } catch {
    return null;
  }
}
