#!/usr/bin/env node
// Build data.json for the deck from the read-only italian-laws-history repo:
//   - progress-rs.json           -> act aggregates (by year / by type / refs)
//   - git history             -> commit-subject families, DL conversions
//   - *.decaduto tree markers    -> lapsed decrees by year
//   - *.modifiedby tree blobs    -> octopus (L.473/1925) hub degree
//   - processing-*.log        -> HTTP request volume + fetch-error mix
//                                   (reused from refs-trends.json when present)
// Pure Node built-ins only. All access to the source repo is read-only.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  createReadStream,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LAWS_REPO,
  PROGRESS_PATH,
  HISTORY_BRANCH,
  processingLogs,
  assertRepo,
  git,
} from './repo-config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(here, 'data.json');
const refsTrendsPath = path.join(here, 'refs-trends.json');
const dlConvertitiPath = path.join(here, 'dl-convertiti-2016.json');

const OCTOPUS_CODE = '025U0473'; // L. 473/1925 — the fascist bulk-ratification hub.
const TOP_TYPES = 8; // stacked charts keep the N largest types, rest -> ALTRO.

// Historical eras for the per-era breakdown.
const ERAS = [
  { id: 'liberal', label: 'Liberal Italy', range: '1861 – 1921', from: 1861, to: 1921 },
  { id: 'fascism', label: 'Fascism', range: '1922 – 1945', from: 1922, to: 1945 },
  { id: 'first_rep', label: 'First Republic', range: '1946 – 1989', from: 1946, to: 1989 },
  { id: 'second_rep', label: 'Second Republic', range: '1990 → today', from: 1990, to: 9999 },
];

function eraIdForYear(year) {
  for (const e of ERAS) if (year >= e.from && year <= e.to) return e.id;
  return null;
}

// Two-digit codiceRedazionale year prefix (e.g. 25G… -> 2025, 44UU… -> 1944).
// Pivot at the current 2-digit year: <= pivot is 2000s, otherwise 1900s.
const YEAR_PIVOT = new Date().getFullYear() % 100;
function yearFromCode(code) {
  const m = code.match(/^(\d{2})/);
  if (!m) return null;
  const yy = parseInt(m[1], 10);
  return yy <= YEAR_PIVOT ? 2000 + yy : 1900 + yy;
}

function enactYearOf(v) {
  if (v.year != null && String(v.year).trim() !== '') {
    const y = parseInt(String(v.year), 10);
    if (!Number.isNaN(y) && y >= 1800 && y <= 2100) return y;
  }
  const date = v.date ?? '';
  if (date.length >= 4 && /^\d{4}-/.test(date)) {
    const y = parseInt(date.slice(0, 4), 10);
    if (!Number.isNaN(y) && y >= 1800 && y <= 2100) return y;
  }
  return null;
}

// --- progress-rs.json aggregates ---

function aggregateProgress(progress) {
  const acts = progress.actVersions ?? {};
  const codeYear = new Map(); // code -> enactment year (for decaduto lookup)
  const typeCounts = new Map();
  const yearType = new Map(); // year -> Map(type -> count)
  const eraType = new Map(ERAS.map((e) => [e.id, new Map()]));
  const refDistBuckets = [
    { label: '0', min: 0, max: 0 },
    { label: '1', min: 1, max: 1 },
    { label: '2', min: 2, max: 2 },
    { label: '3–5', min: 3, max: 5 },
    { label: '6–10', min: 6, max: 10 },
    { label: '11–20', min: 11, max: 20 },
    { label: '21+', min: 21, max: Infinity },
  ].map((b) => ({ ...b, count: 0 }));
  const refByYear = new Map(); // year -> number[] of refs

  let firstDate = '9999-99-99';
  let lastDate = '0000-00-00';
  let firstEnactYear = 9999;
  let lastEnactYear = 0;

  for (const [code, v] of Object.entries(acts)) {
    if (!v || typeof v === 'string') continue;
    const type = (v.type ?? 'ALTRO').toUpperCase();
    const refs = Number(v.refs ?? 0) || 0;
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);

    const date = v.date ?? '';
    if (date && /^\d{4}-/.test(date)) {
      if (date < firstDate) firstDate = date;
      if (date > lastDate) lastDate = date;
    }
    const ey = enactYearOf(v);
    if (ey != null) codeYear.set(code, ey);

    const bucket = refDistBuckets.find((b) => refs >= b.min && refs <= b.max);
    if (bucket) bucket.count++;

    if (ey != null) {
      if (ey < firstEnactYear) firstEnactYear = ey;
      if (ey > lastEnactYear) lastEnactYear = ey;
      let yt = yearType.get(ey);
      if (!yt) yearType.set(ey, (yt = new Map()));
      yt.set(type, (yt.get(type) ?? 0) + 1);
      const eraId = eraIdForYear(ey);
      if (eraId) {
        const et = eraType.get(eraId);
        et.set(type, (et.get(type) ?? 0) + 1);
      }
      if (!refByYear.has(ey)) refByYear.set(ey, []);
      refByYear.get(ey).push(refs);
    }
  }

  // Top types (rest collapse into ALTRO) so the stacks stay legible.
  const typesSorted = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]);
  const topTypes = typesSorted.slice(0, TOP_TYPES).map(([t]) => t);
  const topSet = new Set(topTypes);
  const orderedTypes = [...topTypes, 'ALTRO'];
  const canon = (t) => (topSet.has(t) ? t : 'ALTRO');

  const byYearRows = [];
  for (const [year, yt] of [...yearType.entries()].sort((a, b) => a[0] - b[0])) {
    const merged = new Map();
    for (const [t, n] of yt) merged.set(canon(t), (merged.get(canon(t)) ?? 0) + n);
    for (const t of orderedTypes) {
      const n = merged.get(t) ?? 0;
      if (n > 0) byYearRows.push({ year, type: t, count: n });
    }
  }

  const byTypeRows = [];
  for (const e of ERAS) {
    const et = eraType.get(e.id);
    const merged = new Map();
    for (const [t, n] of et) merged.set(canon(t), (merged.get(canon(t)) ?? 0) + n);
    for (const t of orderedTypes) {
      const n = merged.get(t) ?? 0;
      if (n > 0) byTypeRows.push({ era: e.id, type: t, count: n });
    }
  }

  const refsByYear = [...refByYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, vals]) => {
      const sorted = vals.slice().sort((a, b) => a - b);
      const sum = sorted.reduce((a, b) => a + b, 0);
      return {
        year,
        count: sorted.length,
        mean: Number((sum / sorted.length).toFixed(3)),
        median: sorted[Math.floor(sorted.length / 2)],
        max: sorted[sorted.length - 1],
      };
    });

  return {
    totalActs: Object.keys(acts).length,
    codeYear,
    dateRange: { first: firstDate, last: lastDate, firstEnactYear, lastEnactYear },
    types: typesSorted.map(([type, count]) => ({ type, count })),
    byYear: { types: orderedTypes, rows: byYearRows },
    byType: {
      eras: ERAS.map(({ id, label, range }) => ({ id, label, range })),
      types: orderedTypes,
      rows: byTypeRows,
    },
    refsByYear,
    refDist: refDistBuckets.map(({ label, count }) => ({ bucket: label, count })),
  };
}

// --- git history-rs: commit-subject families + conversions ---

function streamGitLog(onSubject) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'git',
      ['-C', LAWS_REPO, 'log', HISTORY_BRANCH, '--no-color', '--pretty=format:%s'],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const rl = createInterface({ input: child.stdout });
    rl.on('line', onSubject);
    rl.on('close', resolve);
    child.on('error', reject);
  });
}

async function commitStats() {
  let gu = 0;
  let modifica = 0;
  let modificaOn19470923 = 0;
  const convertitoByYear = new Map();

  // The 1947 case study counts amendments by the date encoded in the subject
  // (`Modifica: … @ YYYY-MM-DD`), not the git author date.
  await streamGitLog((subject) => {
    if (subject.startsWith('GU ')) gu++;
    else if (subject.startsWith('Modifica:')) {
      modifica++;
      if (subject.endsWith('@ 1947-09-23')) modificaOn19470923++;
    } else if (subject.startsWith('Convertito')) {
      const ym = subject.match(/\b(1[89]\d\d|20\d\d)\b/);
      if (ym) {
        const y = parseInt(ym[1], 10);
        convertitoByYear.set(y, (convertitoByYear.get(y) ?? 0) + 1);
      }
    }
  });

  const commits = parseInt(git(['rev-list', '--count', HISTORY_BRANCH]).trim(), 10);
  return { commits, gu, modifica, modificaOn19470923, convertitoByYear };
}

// --- *.decaduto markers: lapsed decrees grouped by year ---

function decadutoByYear(codeYear) {
  const out = git(['ls-tree', '-r', '--name-only', HISTORY_BRANCH], {
    maxBuffer: 1024 * 1024 * 512,
  });
  const byYear = new Map();
  for (const name of out.split('\n')) {
    if (!name.endsWith('.decaduto')) continue;
    // strip ".decaduto" and an optional ".rdl" qualifier to recover the code.
    const base = name.replace(/\.decaduto$/, '').replace(/\.rdl$/, '');
    const year = codeYear.get(base) ?? yearFromCode(base);
    if (year == null) continue;
    byYear.set(year, (byYear.get(year) ?? 0) + 1);
  }
  return byYear;
}

// --- octopus hub: out-degree of L.473/1925 in the .modifiedby graph ---

function octopusDegree() {
  // Count .modifiedby blobs whose content references the hub code.
  const out = git(
    ['grep', '-l', '-w', OCTOPUS_CODE, HISTORY_BRANCH, '--', '*.modifiedby'],
    { maxBuffer: 1024 * 1024 * 128 },
  );
  return out.split('\n').filter(Boolean).length;
}

// --- fetch stats: reuse refs-trends.json, else scan the logs ---

async function fetchStats() {
  if (existsSync(refsTrendsPath)) {
    try {
      const rt = JSON.parse(readFileSync(refsTrendsPath, 'utf8'));
      const l = rt.logs;
      if (l && l.requests != null) {
        return {
          requests: l.requests,
          successPct: l.successPct,
          http404Pct: l.http404Pct,
          http400Pct: l.http400Pct,
          testoNonDisponibilePct:
            l.requests > 0 ? Number(((l.urnEndpointVuoto / l.requests) * 100).toFixed(2)) : null,
        };
      }
    } catch {
      /* fall through to a fresh scan */
    }
  }

  const RE_FETCH = /\[fetch\]\s+(\d{3})\b/;
  const RE_URN_VUOTO = /URN endpoint vuoto per /;
  let requests = 0;
  let urnEndpointVuoto = 0;
  const status = {};
  for (const f of processingLogs()) {
    const rl = createInterface({ input: createReadStream(f.path, { encoding: 'utf8' }) });
    for await (const line of rl) {
      const m = line.match(RE_FETCH);
      if (m) {
        requests++;
        status[m[1]] = (status[m[1]] ?? 0) + 1;
      } else if (RE_URN_VUOTO.test(line)) urnEndpointVuoto++;
    }
  }
  const pct = (n) => (requests > 0 ? Number(((n / requests) * 100).toFixed(2)) : null);
  return {
    requests,
    successPct: pct(status['200'] ?? 0),
    http404Pct: pct(status['404'] ?? 0),
    http400Pct: pct(status['400'] ?? 0),
    testoNonDisponibilePct: pct(urnEndpointVuoto),
  };
}

// --- assemble dlOutcomes ---

function buildDlOutcomes(convertitoByYear, decadutoByYearMap) {
  // Supplement convertito with the hand-verified 2016 cohort (the processor's
  // conversion detection under-reported 2016 — see dl-convertiti-2016.json).
  const conv = new Map(convertitoByYear);
  if (existsSync(dlConvertitiPath)) {
    try {
      const dc = JSON.parse(readFileSync(dlConvertitiPath, 'utf8'));
      const verified2016 = (dc.dl_emanated_2016 ?? []).length;
      if (verified2016 > (conv.get(2016) ?? 0)) conv.set(2016, verified2016);
    } catch {
      /* ignore malformed supplement */
    }
  }
  const years = new Set([...conv.keys(), ...decadutoByYearMap.keys()]);
  return [...years]
    .filter((y) => y >= 1861 && y <= 2100)
    .sort((a, b) => a - b)
    .map((year) => ({
      year,
      convertito: conv.get(year) ?? 0,
      decaduto: decadutoByYearMap.get(year) ?? 0,
    }));
}

// --- main ---

assertRepo();
console.log(`Reading ${PROGRESS_PATH}…`);
const progress = JSON.parse(readFileSync(PROGRESS_PATH, 'utf8'));
const agg = aggregateProgress(progress);
console.log(`  ${agg.totalActs.toLocaleString()} acts`);

console.log(`Scanning git ${HISTORY_BRANCH} commit subjects…`);
const commits = await commitStats();
console.log(`  ${commits.commits.toLocaleString()} commits (${commits.gu} GU, ${commits.modifica} Modifica)`);

console.log('Counting .decaduto markers…');
const decaduto = decadutoByYear(agg.codeYear);

console.log(`Measuring octopus hub (${OCTOPUS_CODE})…`);
const octopus = octopusDegree();
console.log(`  degree ${octopus}`);

console.log('Reading fetch stats…');
const fetch = await fetchStats();

const data = {
  generatedAt: new Date().toISOString(),
  totals: { acts: agg.totalActs, commits: commits.commits, requests: fetch.requests },
  dateRange: agg.dateRange,
  fetchErrors: {
    successPct: fetch.successPct,
    http404Pct: fetch.http404Pct,
    testoNonDisponibilePct: fetch.testoNonDisponibilePct,
    http400Pct: fetch.http400Pct,
  },
  commitSubjects: {
    gu: commits.gu,
    modifica: commits.modifica,
    modificaOn19470923: commits.modificaOn19470923,
  },
  caseStudies: { octopus1925: { code: OCTOPUS_CODE, degree: octopus } },
  types: agg.types,
  byYear: agg.byYear,
  byType: agg.byType,
  refsByYear: agg.refsByYear,
  refDist: agg.refDist,
  dlOutcomes: buildDlOutcomes(commits.convertitoByYear, decaduto),
};

writeFileSync(outPath, JSON.stringify(data, null, 2));
console.log(`\nWrote ${outPath}`);
console.log(
  `  requests=${(data.totals.requests ?? 0).toLocaleString()} ` +
    `success=${data.fetchErrors.successPct}% 404=${data.fetchErrors.http404Pct}% ` +
    `TND=${data.fetchErrors.testoNonDisponibilePct}% 400=${data.fetchErrors.http400Pct}%`,
);
console.log(`  dlOutcomes years: ${data.dlOutcomes.length}, octopus degree: ${octopus}`);
