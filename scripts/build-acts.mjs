#!/usr/bin/env node
// Build acts.json for graph nodes: enact date from slug + decaduto markers.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import {
  assertRepo,
  git,
  HISTORY_BRANCH,
  PROGRESS_PATH,
  PUBLIC_DATA,
} from "./repo-config.mjs";

assertRepo();
mkdirSync(PUBLIC_DATA, { recursive: true });

const graphPath = path.join(PUBLIC_DATA, "graph.json");
if (!existsSync(graphPath)) {
  throw new Error("public/data/graph.json missing — run copy-codemotion-data first");
}

const graph = JSON.parse(readFileSync(graphPath, "utf8"));
const progress = JSON.parse(readFileSync(PROGRESS_PATH, "utf8"));
const asOf = progress.lastFullyScannedDate ?? progress.lastRun?.slice?.(0, 10) ?? null;

/** @param {string} slug */
function enactFromSlug(slug) {
  const base = slug.replace(/\.txt$/, "");
  const m = base.match(/-del-(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return { enactDate: null, enactYear: null };
  const dd = m[1];
  const mm = m[2];
  const yyyy = m[3];
  if (yyyy === "0000" || yyyy === "0") return { enactDate: null, enactYear: null };
  if (dd === "00" || mm === "00") {
    return { enactDate: `${yyyy}-01-01`, enactYear: parseInt(yyyy, 10) };
  }
  return {
    enactDate: `${yyyy}-${mm}-${dd}`,
    enactYear: parseInt(yyyy, 10),
  };
}

/** Infer date for unresolved codici redazionali / hub labels. */
function inferEnact(slug, label) {
  const fromLabel = (label || "").match(/\b((?:18|19|20)\d{2})\b/);
  if (fromLabel) {
    const y = parseInt(fromLabel[1], 10);
    return { enactDate: `${y}-01-01`, enactYear: y };
  }

  const t = slug.match(/^T-?(\d{2})\d*$/i);
  if (t) {
    const yy = parseInt(t[1], 10);
    const y = yy <= 30 ? 2000 + yy : 1900 + yy;
    return { enactDate: `${y}-01-01`, enactYear: y };
  }

  const two = slug.match(/^(\d{2})[A-Za-z]/);
  if (two) {
    const yy = parseInt(two[1], 10);
    const y = yy <= 30 ? 2000 + yy : 1900 + yy;
    return { enactDate: `${y}-01-01`, enactYear: y };
  }

  const three = slug.match(/^(\d{3})([A-Za-z])/);
  if (three) {
    const n = parseInt(three[1], 10);
    const letter = three[2].toUpperCase();
    let y = null;
    if (n <= 30) y = 2000 + n;
    else if (letter === "U") y = 1800 + n;
    else if (n < 100) y = 1900 + n;
    if (y != null) return { enactDate: `${y}-01-01`, enactYear: y };
  }

  return { enactDate: null, enactYear: null };
}

// Map codice -> decaduto info from tree markers + commit subjects is heavy;
// use *.decaduto listing + content date from progress when possible.
const listing = git(["ls-tree", "-r", "--name-only", HISTORY_BRANCH], {
  maxBuffer: 1024 * 1024 * 512,
});
const decadutoFiles = listing.split("\n").filter((f) => f.endsWith(".decaduto"));

/** @type {Map<string, string>} slugWithoutTxt -> decadutoDate guess */
const decadutoByCode = new Map();
for (const file of decadutoFiles) {
  const code = path.basename(file).replace(/\.decaduto$/, "").replace(/\.(dl|rdl|dll|dlcps)$/, "");
  // Prefer progress pending / actVersions date as proxy when present
  const v = progress.actVersions?.[code];
  const date = v?.date ?? null;
  if (date) decadutoByCode.set(code, date);
  else decadutoByCode.set(code, "1970-01-01");
}

// Resolve code↔slug via graph node ids that look like files; decaduto markers
// are often by codice. For brush we mainly need decaduto on provisional acts
// present in the graph — match by scanning actVersions year+type is weak.
// Simpler: parse DECADUTO commits for codes (cheap subject scan).
const log = git([
  "log",
  HISTORY_BRANCH,
  "--format=%aI%x09%s",
  "--grep=^DECADUTO:",
]);
/** @type {Map<string, string>} */
const decadutoBySubjectCode = new Map();
for (const line of log.split("\n")) {
  if (!line) continue;
  const [iso, subject] = line.split("\t");
  const date = (iso || "").slice(0, 10);
  const m = subject?.match(/DECADUTO:\s+\S+\s+(\S+)/);
  if (m && date) decadutoBySubjectCode.set(m[1], date);
}

function labelFromSlug(slug, graphLabel) {
  if (graphLabel) return graphLabel;
  return slug.replace(/\.txt$/, "").replace(/-/g, " ");
}

const acts = graph.nodes.map((n) => {
  let { enactDate, enactYear } = enactFromSlug(n.id);
  if (!enactDate) {
    ({ enactDate, enactYear } = inferEnact(n.id, n.label));
  }
  // Try match decaduto by unresolved code id or by filename stem heuristics
  let decadutoDate = null;
  if (n.unresolved && decadutoBySubjectCode.has(n.id)) {
    decadutoDate = decadutoBySubjectCode.get(n.id);
  }
  // Also: if id is a .txt slug, no direct code — leave null unless we find later
  return {
    slug: n.id,
    label: labelFromSlug(n.id, n.label),
    enactDate,
    enactYear,
    decadutoDate,
    degree: n.degree,
    hub: Boolean(n.hub),
  };
});

// Second pass: for hubs, try to find codice from progress by matching year in slug
// Skip — brush works with enactDate alone for most nodes; decaduto sparse is OK.

const out = {
  asOf,
  count: acts.length,
  acts,
};

writeFileSync(path.join(PUBLIC_DATA, "acts.json"), JSON.stringify(out));
console.log(`Wrote acts.json (${acts.length} graph acts, asOf=${asOf})`);
