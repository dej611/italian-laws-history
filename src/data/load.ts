import type { ActsIndex, GraphData, Manifest, TalkData } from "./types";

/** Honor Vite `base` so /data works on a GitHub Pages subpath. */
export function dataUrl(path: string): string {
  const base = import.meta.env.BASE_URL || "/";
  return `${base}${path.replace(/^\//, "")}`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to load ${url}: ${resp.status}`);
  return resp.json() as Promise<T>;
}

function cached<T>(load: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => {
    if (!p) p = load();
    return p;
  };
}

export const loadTalkData = cached(() => fetchJson<TalkData>(dataUrl("/data/data.json")));

export const loadGraph = cached(() => fetchJson<GraphData>(dataUrl("/data/graph.json")));

export const loadActs = cached(() => fetchJson<ActsIndex>(dataUrl("/data/acts.json")));

export const loadManifest = cached(() =>
  fetchJson<Manifest>(dataUrl("/data/manifest.json")).catch(() => null),
);

export const loadBlameIndex = cached(() =>
  fetchJson<{ slugs: string[] }>(dataUrl("/data/blame/index.json"))
    .then((d) => new Set(d.slugs || []))
    .catch(() => new Set<string>()),
);

type RagIndex = { docs: { slug: string; excerpt: string }[] };

const loadRagIndex = cached(() =>
  fetchJson<RagIndex>(dataUrl("/data/rag/index.json")).catch(() => ({ docs: [] })),
);

export async function loadRagExcerpt(slug: string): Promise<string | null> {
  const idx = await loadRagIndex();
  const doc = idx.docs.find((d) => d.slug === slug);
  const text = doc?.excerpt?.trim();
  return text || null;
}

/** Warm graph/explore fetches without mounting UI. */
export function prefetchExploreData() {
  void loadGraph();
  void loadActs();
  void loadBlameIndex();
}
