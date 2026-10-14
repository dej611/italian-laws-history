#!/usr/bin/env node
// Build RAG pack: curated + hub excerpts via batched git cat-file.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  assertRepo,
  git,
  HISTORY_BRANCH,
  PUBLIC_DATA,
  LAWS_REPO,
} from "./repo-config.mjs";

assertRepo();

const graphPath = path.join(PUBLIC_DATA, "graph.json");
if (!existsSync(graphPath)) throw new Error("graph.json missing");

const graph = JSON.parse(readFileSync(graphPath, "utf8"));
const ragDir = path.join(PUBLIC_DATA, "rag");
mkdirSync(ragDir, { recursive: true });

const CURATED = [
  {
    slug: "decreto-legge-112-del-25-06-2008.txt",
    label: "D.L. 112/2008",
  },
  {
    slug: "decreto-legislativo-179-del-01-12-2009.txt",
    label: "D.Lgs. 179/2009",
  },
  {
    slug: "legge-473-del-17-04-1925.txt",
    label: "L. 473/1925",
  },
  {
    slug: "costituzione-0-del-00-00-0.txt",
    label: "Costituzione",
  },
];

const HUB_LIMIT = Number(process.env.RAG_HUB_LIMIT ?? 400);
const hubSlugs = graph.nodes
  .filter((n) => n.hub && !n.unresolved)
  .sort((a, b) => (b.degree || 0) - (a.degree || 0))
  .slice(0, HUB_LIMIT);

/** @type {Map<string, { slug: string, label: string }>} */
const wanted = new Map();
for (const c of CURATED) wanted.set(c.slug, c);
for (const n of hubSlugs) {
  if (!wanted.has(n.id)) {
    wanted.set(n.id, {
      slug: n.id,
      label: n.label || n.id.replace(/\.txt$/, ""),
    });
  }
}

// Resolve tip SHAs for wanted paths
const listing = git(["ls-tree", "-r", HISTORY_BRANCH], {
  maxBuffer: 1024 * 1024 * 512,
});
/** @type {{ slug: string, label: string, sha: string }[]} */
const entries = [];
for (const line of listing.split("\n")) {
  if (!line) continue;
  const tab = line.indexOf("\t");
  if (tab < 0) continue;
  const file = line.slice(tab + 1);
  const meta = wanted.get(file);
  if (!meta) continue;
  const sha = line.slice(0, tab).split(/\s+/)[2];
  if (sha) entries.push({ ...meta, sha });
}

function catFileBatch(shas) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", LAWS_REPO, "cat-file", "--batch"], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const out = [];
    let buf = Buffer.alloc(0);
    let expecting = null;

    child.stdout.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (!expecting) {
          const nl = buf.indexOf(0x0a);
          if (nl < 0) break;
          const header = buf.slice(0, nl).toString("utf8");
          buf = buf.slice(nl + 1);
          const parts = header.split(" ");
          const size = parseInt(parts[2], 10);
          if (parts[1] === "missing" || Number.isNaN(size)) {
            out.push("");
            continue;
          }
          expecting = { size };
        }
        if (buf.length < expecting.size + 1) break;
        const body = buf.slice(0, expecting.size).toString("utf8");
        buf = buf.slice(expecting.size + 1);
        out.push(body);
        expecting = null;
      }
    });
    child.stdout.on("end", () => resolve(out));
    child.on("error", reject);
    for (const sha of shas) child.stdin.write(sha + "\n");
    child.stdin.end();
  });
}

const bodies = await catFileBatch(entries.map((e) => e.sha));

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .split(/[^a-z0-9àèéìòù]+/i)
    .filter((t) => t.length > 2);
}

/** @type {Map<string, number>} */
const df = new Map();
const docs = [];

for (let i = 0; i < entries.length; i++) {
  const excerpt = (bodies[i] || "").slice(0, 1800).trim();
  if (!excerpt) continue;
  const { slug, label } = entries[i];
  const tokens = tokenize(`${label} ${excerpt}`);
  /** @type {Map<string, number>} */
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  docs.push({ id: slug, slug, label, excerpt, tf: Object.fromEntries(tf) });
}

const N = docs.length || 1;
const vocab = [...df.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 4000)
  .map(([t]) => t);
const vocabIndex = new Map(vocab.map((t, i) => [t, i]));

function vectorize(tfObj) {
  const vec = new Array(vocab.length).fill(0);
  let norm = 0;
  for (const [t, c] of Object.entries(tfObj)) {
    const i = vocabIndex.get(t);
    if (i == null) continue;
    const idf = Math.log(1 + N / (1 + (df.get(t) || 0)));
    const v = c * idf;
    vec[i] = v;
    norm += v * v;
  }
  norm = Math.sqrt(norm) || 1;
  return vec.map((v) => Math.round((v / norm) * 1e6) / 1e6);
}

const outDocs = docs.map((d) => ({
  id: d.id,
  slug: d.slug,
  label: d.label,
  excerpt: d.excerpt,
  embedding: vectorize(d.tf),
}));

writeFileSync(
  path.join(ragDir, "index.json"),
  JSON.stringify({
    kind: "tfidf-hash",
    vocab,
    docs: outDocs,
  }),
);
console.log(`RAG: ${outDocs.length} docs, vocab ${vocab.length}`);
