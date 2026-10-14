#!/usr/bin/env node
// Build blame JSON WITHOUT per-path git log (too slow on flat history-rs).
// Strategy: one subject scan + match by act number/year from the slug.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import {
  assertRepo,
  git,
  HISTORY_BRANCH,
  PUBLIC_DATA,
  CACHE_DIR,
} from "./repo-config.mjs";

assertRepo();

const graphPath = path.join(PUBLIC_DATA, "graph.json");
if (!existsSync(graphPath)) throw new Error("graph.json missing");

const graph = JSON.parse(readFileSync(graphPath, "utf8"));
const blameDir = path.join(PUBLIC_DATA, "blame");
const cacheDir = path.join(CACHE_DIR, "blame-subjects");
mkdirSync(blameDir, { recursive: true });
mkdirSync(cacheDir, { recursive: true });

const CURATED = [
  "decreto-legge-112-del-25-06-2008.txt",
  "decreto-legislativo-179-del-01-12-2009.txt",
  "legge-473-del-17-04-1925.txt",
  "costituzione-0-del-00-00-0.txt",
];

/** Known codiceRedazionale overrides when number≠codice (Normattiva). */
const CURATED_CODES = {
  "decreto-legge-112-del-25-06-2008.txt": ["008G0135"],
  "legge-473-del-17-04-1925.txt": ["025U0473"],
};

const TYPE_FROM_PREFIX = [
  ["decreto-legge-", "DECRETO-LEGGE"],
  ["decreto-legislativo-", "DECRETO LEGISLATIVO"],
  ["regio-decreto-legge-", "REGIO DECRETO-LEGGE"],
  ["regio-decreto-", "REGIO DECRETO"],
  ["legge-", "LEGGE"],
  ["costituzione-", "COSTITUZIONE"],
];

function codeCandidates(num, year) {
  if (!num || year == null) return [];
  const yy = String(year).slice(-2);
  const n = String(num);
  const padded = n.padStart(4, "0");
  const short = n.padStart(3, "0");
  return [
    `${yy}G${padded}`,
    `${yy}G0${short}`,
    `${yy}G${n}`,
    `${yy}U${padded}`,
    `0${yy}G${padded}`,
    `0${yy}G0${short}`,
    `0${yy}U${padded}`,
  ];
}

function parseSlug(slug) {
  const base = slug.replace(/\.txt$/, "");
  let type = null;
  let rest = base;
  for (const [prefix, t] of TYPE_FROM_PREFIX) {
    if (base.startsWith(prefix)) {
      type = t;
      rest = base.slice(prefix.length);
      break;
    }
  }
  const m = rest.match(/^(\d+)-del-(\d{2})-(\d{2})-(\d{4}|0)$/);
  if (!m) return { type, num: null, date: null, year: null };
  const num = m[1];
  const dd = m[2];
  const mm = m[3];
  const yyyy = m[4];
  const enactFixed =
    yyyy === "0" || yyyy === "0000" ? null : `${yyyy}-${mm}-${dd}`;
  return {
    type,
    num,
    date: enactFixed,
    year: yyyy === "0" || yyyy === "0000" ? null : parseInt(yyyy, 10),
  };
}

const LIMIT = Number(process.env.BLAME_LIMIT ?? 400);
const hubSlugs = graph.nodes
  .filter((n) => n.hub && !n.unresolved)
  .sort((a, b) => (b.degree || 0) - (a.degree || 0));

const slugs = new Set(CURATED);
for (const n of hubSlugs.slice(0, LIMIT)) slugs.add(n.id);

const cachePath = path.join(cacheDir, "subjects.tsv");
let subjects;
if (existsSync(cachePath) && !process.env.BLAME_REFRESH_SUBJECTS) {
  subjects = readFileSync(cachePath, "utf8");
  console.log("Using cached subjects.tsv");
} else {
  console.log("Scanning commit subjects…");
  subjects = git(["log", HISTORY_BRANCH, "--format=%aI%x09%s"]);
  writeFileSync(cachePath, subjects);
  console.log(`Cached ${subjects.split("\n").length} subjects`);
}

const lines = subjects.split("\n").filter(Boolean);

function classify(subject) {
  if (/^GU\s/.test(subject)) return "gu";
  if (/^Modifica:/.test(subject)) return "modifica";
  if (/DECADUTO|Marcatore:/.test(subject)) return "decaduto";
  if (/Convertito|SANATORIA/.test(subject)) return "convertito";
  return "other";
}

/** Prefer the legal date in the commit subject over git author date. */
function dateFromSubject(subject, fallback) {
  const at = subject.match(/@\s*(\d{4}-\d{2}-\d{2})\b/);
  if (at) return at[1];
  const gu = subject.match(/^GU\s+\S+\s+-\s+(\d{4}-\d{2}-\d{2})\b/);
  if (gu) return gu[1];
  const any = subject.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (any) return any[1];
  return fallback.slice(0, 10);
}

let wrote = 0;
const withData = [];

/** One pass over the subject log: index jobs by codice, extract codes from each line. */
const jobs = new Map();
const byCode = new Map();
for (const slug of slugs) {
  const meta = parseSlug(slug);
  const codes = [
    ...codeCandidates(meta.num, meta.year),
    ...(CURATED_CODES[slug] || []),
  ];
  jobs.set(slug, { slug, meta, codes, entries: [], seen: new Set() });
  for (const c of codes) {
    const list = byCode.get(c);
    if (list) list.push(slug);
    else byCode.set(c, [slug]);
  }
}

const CODE_RE = /\d{2,3}[GU]\d{3,5}/g;
const TYPE_OK = /SANATORIA|COSTITUZIONE|LEGGE 025U0473/i;

function acceptHit(job, subject) {
  const { meta } = job;
  if (meta.type === "COSTITUZIONE" && /COSTITUZIONE|costituzione/i.test(subject)) {
    return true;
  }
  if (!meta.type || subject.includes(meta.type) || TYPE_OK.test(subject)) return true;
  return false;
}

function addEntry(job, date, subject) {
  if (!acceptHit(job, subject)) return;
  const key = `${date}|${subject}`;
  if (job.seen.has(key)) return;
  job.seen.add(key);
  job.entries.push({ date, subject, kind: classify(subject) });
}

for (const line of lines) {
  const tab = line.indexOf("\t");
  if (tab < 0) continue;
  const iso = line.slice(0, tab);
  const subject = line.slice(tab + 1);
  const date = dateFromSubject(subject, iso);

  const hitSlugs = new Set();
  for (const m of subject.matchAll(CODE_RE)) {
    const owners = byCode.get(m[0]);
    if (!owners) continue;
    for (const slug of owners) hitSlugs.add(slug);
  }
  if (/COSTITUZIONE|costituzione/i.test(subject)) {
    for (const [slug, job] of jobs) {
      if (job.meta.type === "COSTITUZIONE") hitSlugs.add(slug);
    }
  }
  for (const slug of hitSlugs) addEntry(jobs.get(slug), date, subject);
}

for (const job of jobs.values()) {
  const entries = job.entries;
  entries.sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : 0));
  const kept =
    entries.length > 100 ? entries.slice(0, 20).concat(entries.slice(-80)) : entries;
  if (!kept.length) continue;
  const payload = JSON.stringify({
    slug: job.slug,
    source: "subject-scan",
    codes: job.codes,
    entries: kept,
  });
  writeFileSync(path.join(blameDir, `${job.slug}.json`), payload);
  wrote += 1;
  withData.push(job.slug);
}

writeFileSync(
  path.join(blameDir, "index.json"),
  JSON.stringify({ slugs: withData.sort() }, null, 2) + "\n",
);
const keep = new Set([...withData, "index.json"]);
for (const name of readdirSync(blameDir)) {
  if (!name.endsWith(".json")) continue;
  const key = name === "index.json" ? "index.json" : name.replace(/\.json$/, "");
  if (keep.has(key)) continue;
  unlinkSync(path.join(blameDir, name));
}
console.log(`Blame: wrote ${wrote} files via subject scan (${withData.length} with data)`);
