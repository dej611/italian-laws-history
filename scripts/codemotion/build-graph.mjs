#!/usr/bin/env node
// Build graph.json: the reference network from sidecars on the history branch.
//
// Two edge sources (same direction: source touches target):
//   *.modifiedby          — Normattiva modifier(code) → modified(slug)
//   *.allegato-N.refs     — allegato parent(slug) → listed URN→slug
//     (keep/repeal elenchi; not the same legal relation as multivigenza, but
//     the talk hubs — taglia/salva — only show up as annex lists)
//
// Positions ARE baked, per component and relative to that component's own
// centroid — see the layout note in graph-mount.js for why the split with the
// deck's packer, and LAYOUT below for the parameters.
//
// IDENTITY RECONCILIATION
// A .modifiedby file is named by the MODIFIED act's slug and contains the
// MODIFYING act's codiceRedazionale, so the raw relation is
//   modifier(code)  ->  modified(slug)
// Those two ID spaces are disjoint, so leaving them as-is makes the graph
// perfectly bipartite: every path is one hop and the output degenerates into a
// forest of stars (circuit rank 0, degeneracy 1, empty 2-core).
//
// A metadata join can't fix it — progress-rs.json has no act number, and its
// `date` is the last-processed date, not the act date. The commit log can: a
//   GU <n> - <date> - <TYPE> <CODE>
// commit touches that act's own <slug>.txt, which pins code to slug. We resolve
// every modifier through that bridge so one act is one node.
//
// Allegato .refs already name the parent by slug; listed rows are URNs mapped
// to the same `{tipo}-{num}-del-{DD}-{MM}-{YYYY}.txt` form the scraper uses.
//
// Cost note: `git log --name-only` over the whole branch is ~65 commits/sec
// because the repo is a flat directory of ~248k files, so every commit diff
// parses two ~10MB tree objects (83 min for the full walk). We avoid that by
// reading subjects with no diff at all (~3s), selecting only the GU commits for
// codes we actually need (~17k of 324k), and resolving those with `diff-tree`
// across parallel workers — about a minute.
//
// Residual: ~13% of modifiers have no GU commit (acts cited as amenders that
// were never scraped as acts). Those stay in code space and are labelled as
// such. Note the relation is a DAG regardless — amendment follows time's arrow,
// so no reconciliation can produce a cycle, and k-core stays useless.
//
// Selection: every connected component with >= MIN_COMPONENT nodes, no cap.

import { writeFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAWS_REPO, PROGRESS_PATH, HISTORY_BRANCH, assertRepo, git } from './repo-config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(here, 'graph.json');

const MIN_COMPONENT = 5; // keep clusters of at least this many connected laws
const HUB_MIN_DEGREE = 2; // label nodes at/above this out-degree

// --- read .modifiedby + .allegato-N.refs via a single `git cat-file --batch` ---

const ALLEGATO_REFS_RE = /^(.+)\.allegato-\d+\.refs$/;
// urn:nir:stato:legge:1861-04-21;1  →  legge-1-del-21-04-1861.txt
const URN_RE = /^urn:nir:[^:]+:([^:]+):(\d{4})-(\d{2})-(\d{2});([^\s\t@!~]+)$/i;

function urnToSlug(urn) {
  const m = URN_RE.exec(urn.trim());
  if (!m) return null;
  const denom = m[1].toLowerCase().replace(/\./g, '-');
  const [, , yyyy, mm, dd, num] = m;
  return `${denom}-${num}-del-${dd}-${mm}-${yyyy}.txt`;
}

function parseRefsContent(content) {
  const urns = [];
  for (const line of content.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const urn = line.split('\t')[0].trim().toLowerCase();
    if (urn.startsWith('urn:nir:')) urns.push(urn);
  }
  return urns;
}

async function readSidecarBlobs() {
  // `<mode> <type> <sha>\t<path>` for every tree entry; filter sidecars here.
  // (A `*.modifiedby` pathspec is unreliable via execFile, so we filter here.)
  const listing = git(['ls-tree', '-r', HISTORY_BRANCH], {
    maxBuffer: 1024 * 1024 * 512,
  });
  const modifiedby = [];
  const refs = [];
  for (const line of listing.split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const file = line.slice(tab + 1);
    const meta = line.slice(0, tab).split(/\s+/); // [mode, type, sha]
    const sha = meta[2];
    if (!sha) continue;
    if (file.endsWith('.modifiedby')) modifiedby.push({ sha, file });
    else if (ALLEGATO_REFS_RE.test(file)) refs.push({ sha, file });
  }

  const all = modifiedby.concat(refs);
  const contents = await catFileBatch(all.map((e) => e.sha));
  const wrap = (entries, offset) =>
    entries.map((e, i) => ({ file: e.file, content: contents[offset + i] ?? '' }));
  return {
    modifiedby: wrap(modifiedby, 0),
    refs: wrap(refs, modifiedby.length),
  };
}

function catFileBatch(shas) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', LAWS_REPO, 'cat-file', '--batch'], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const out = [];
    let buf = Buffer.alloc(0);
    let expecting = null; // { size } while reading a body

    child.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (!expecting) {
          const nl = buf.indexOf(0x0a);
          if (nl < 0) break;
          const header = buf.slice(0, nl).toString('utf8'); // "<sha> <type> <size>"
          buf = buf.slice(nl + 1);
          const parts = header.split(' ');
          const size = parseInt(parts[2], 10);
          if (parts[1] === 'missing' || Number.isNaN(size)) {
            out.push('');
            continue;
          }
          expecting = { size };
        }
        if (buf.length < expecting.size + 1) break; // body + trailing LF
        const body = buf.slice(0, expecting.size).toString('utf8');
        buf = buf.slice(expecting.size + 1);
        out.push(body);
        expecting = null;
      }
    });
    child.stdout.on('end', () => resolve(out));
    child.on('error', reject);

    for (const sha of shas) child.stdin.write(sha + '\n');
    child.stdin.end();
  });
}

// --- identity reconciliation: codiceRedazionale -> filename slug ---

const CPUS = Math.max(1, Math.min(8, os.cpus().length));

// `git diff-tree --stdin` prints a 40-hex commit line followed by its touched
// paths. Split the work across workers, and always attach the stdout reader
// before writing stdin: feeding a large sha list into a 64KB pipe while nobody
// drains the output deadlocks.
function diffTreeWorker(hashes) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', LAWS_REPO, 'diff-tree', '-r', '--stdin', '--name-only'], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    child.stdout.on('end', () => resolve(out));
    child.on('error', reject);
    child.stdin.end(hashes.join('\n') + '\n');
  });
}

async function diffTreeParallel(hashes) {
  const size = Math.ceil(hashes.length / CPUS);
  const chunks = [];
  for (let i = 0; i < hashes.length; i += size) chunks.push(hashes.slice(i, i + size));
  const outs = await Promise.all(chunks.map(diffTreeWorker));
  return outs.join('');
}

const SHA_RE = /^[0-9a-f]{40}$/;
const SLUG_RE = /^(?<pre>.+)-(?<num>\d+)-del-(?<d>\d{2})-(?<m>\d{2})-(?<y>\d{4})\.txt$/;
// Two commit subjects name an act by code and touch that act's own file:
// a first-publication `GU <n> - <date> - <TYPE> <CODE>` and a later
// `Modifica: <TYPE> <CODE> @ <date>` version bump. Acts old enough that their
// original GU issue was never digitised only ever appear as the latter, so we
// fall back to it rather than leaving them stranded in code space.
const GU_RE = /^GU\s+\S+\s+-\s+\d{4}-\d{2}-\d{2}\s+-\s+(.*?)\s+(\S+)$/;
const MOD_RE = /^Modifica:\s+(.*?)\s+(\S+)\s+@\s+\d{4}-\d{2}-\d{2}$/;

async function buildCodeToSlug(needed, actMeta) {
  // Subjects only — no --name-only, so git never computes a diff (~3s).
  const subjects = git(['log', HISTORY_BRANCH, '--format=%H\x01%s'], {
    maxBuffer: 1024 * 1024 * 512,
  });
  const wanted = new Map(); // hash -> { code, type }
  const claimed = new Set();
  const fallback = new Map(); // code -> { hash, type }, used only if no GU commit
  for (const line of subjects.split('\n')) {
    const sep = line.indexOf('\x01');
    if (sep < 0) continue;
    const hash = line.slice(0, sep);
    const subject = line.slice(sep + 1);
    const gu = GU_RE.exec(subject);
    if (gu) {
      const code = gu[2];
      // Keep the newest GU commit per code; the log walks newest-first.
      if (!needed.has(code) || claimed.has(code)) continue;
      claimed.add(code);
      wanted.set(hash, { code, type: gu[1] });
      continue;
    }
    const mod = MOD_RE.exec(subject);
    if (mod) {
      const code = mod[2];
      if (!needed.has(code) || fallback.has(code)) continue;
      fallback.set(code, { hash, type: mod[1] });
    }
  }
  let fellBack = 0;
  for (const [code, f] of fallback) {
    if (claimed.has(code)) continue;
    claimed.add(code);
    wanted.set(f.hash, { code, type: f.type });
    fellBack += 1;
  }
  console.log(
    `  ${claimed.size.toLocaleString()} of ${needed.size.toLocaleString()} modifier codes ` +
      `have a naming commit (${fellBack.toLocaleString()} via Modifica: fallback)`,
  );

  const raw = await diffTreeParallel([...wanted.keys()]);

  const map = new Map();
  let ambiguous = 0;
  let current = null;
  let files = [];
  const flush = () => {
    if (!current) return;
    const want = wanted.get(current);
    if (!want) return;
    const cands = files.filter((f) => f.endsWith('.txt'));
    if (cands.length === 0) return;
    if (cands.length === 1) { map.set(want.code, cands[0]); return; }
    // A GU commit can touch more than one act file; score candidates on the
    // subject's act type and the enactment year from progress-rs.
    const prefix = want.type.trim().toLowerCase().replace(/\s+/g, '-');
    const year = actMeta.get(want.code)?.year;
    const scored = [];
    for (const f of cands) {
      const m = SLUG_RE.exec(f);
      if (!m) continue;
      let s = 0;
      if (m.groups.pre === prefix) s += 2;
      if (year && m.groups.y === String(year)) s += 1;
      scored.push([s, f]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    if (scored.length === 0) return;
    if (scored.length > 1 && scored[0][0] === scored[1][0]) { ambiguous += 1; return; }
    map.set(want.code, scored[0][1]);
  };
  for (const line of raw.split('\n')) {
    if (SHA_RE.test(line)) { flush(); current = line; files = []; }
    else if (line) files.push(line);
  }
  flush();

  console.log(
    `  resolved ${map.size.toLocaleString()} code->slug ` +
      `(${ambiguous.toLocaleString()} ambiguous, ` +
      `${(needed.size - map.size).toLocaleString()} left in code space)`,
  );
  return map;
}

// --- labels ---

const TYPE_ABBR = [
  ['decreto-del-presidente-del-consiglio-dei-ministri', 'D.P.C.M.'],
  ['decreto-del-presidente-della-repubblica', 'D.P.R.'],
  ['decreto-legislativo-luogotenenziale', 'D.Lgs.Lgt.'],
  ['decreto-legislativo', 'D.Lgs.'],
  ['decreto-luogotenenziale', 'D.Lgt.'],
  ['regio-decreto-legislativo', 'R.D.Lgs.'],
  ['regio-decreto-legge', 'R.D.L.'],
  ['regio-decreto', 'R.D.'],
  ['decreto-legge', 'D.L.'],
  ['decreto-ministeriale', 'D.M.'],
  ['decreto', 'D.'],
  ['legge-costituzionale', 'L.Cost.'],
  ['legge', 'L.'],
];

// "decreto-legge-112-del-25-06-2008.txt" -> "D.L. 112/2008"
function actLabel(slug) {
  const m = SLUG_RE.exec(slug);
  if (!m) return slug.replace(/\.txt$/, '').replace(/-/g, ' ');
  const { pre, num, y } = m.groups;
  const hit = TYPE_ABBR.find(([k]) => pre === k) ?? TYPE_ABBR.find(([k]) => pre.startsWith(k));
  return `${hit ? hit[1] : pre.replace(/-/g, ' ')} ${num}/${y}`;
}

// --- progress-rs labels (code -> "TYPE year") ---

function loadCodeLabels() {
  const progress = JSON.parse(readFileSync(PROGRESS_PATH, 'utf8'));
  const acts = progress.actVersions ?? {};
  const labels = new Map();
  for (const [code, v] of Object.entries(acts)) {
    if (!v || typeof v === 'string') continue;
    const type = (v.type ?? '').toString();
    const year = v.year ?? (v.date ?? '').slice(0, 4);
    labels.set(code, `${type} ${year}`.trim());
  }
  return labels;
}

// code -> { year, type } — used to disambiguate multi-file GU commits.
function loadActMeta() {
  const progress = JSON.parse(readFileSync(PROGRESS_PATH, 'utf8'));
  const acts = progress.actVersions ?? {};
  const meta = new Map();
  for (const [code, v] of Object.entries(acts)) {
    if (!v || typeof v === 'string') continue;
    meta.set(code, { year: v.year ?? (v.date ?? '').slice(0, 4), type: v.type ?? '' });
  }
  return meta;
}

// --- LAYOUT: fcose per component, normalised to a uniform density ---
//
// fcose runs on each component ON ITS OWN, on a worker pool (see
// graph-layout-worker.mjs), with its own packComponents off.
// Handed the whole graph it packs the components into a single mass and the
// result is an unreadable hairball; run per component it finds the real
// structure, and the deck's spiral packer places the components instead. The
// deck can't run the force layout itself (45s), and the build can't do the
// packing (it depends on the container's aspect ratio), so each node is stored
// relative to its component's centroid and the two halves meet at render time.
//
// Normalisation matters as much as the layout. fcose picks its own scale per
// component, and it varies wildly with shape — a 539-node chain sprawls to
// r=509 while 6,819 nodes fit in r=804. Left alone, the packed extent is huge,
// the fit zoom collapses, and every leaf renders sub-pixel: faint nebulae. So
// each component is scaled to the radius that gives NODE_SPACING² of area per
// node, r = NODE_SPACING * sqrt(n / π), which fixes density across components
// and leaves only fcose's shape. Scaling up is not allowed: a component fcose
// already drew tighter than target is tight for a reason.

const NODE_SPACING = 9; // target centre-to-centre spacing, in model units

// Components are laid out on a small pool of worker threads — the work is
// perfectly independent and fcose is pure CPU-bound JS, so threads buy real
// parallelism. Two, because more doesn't help: the two largest components take
// 19.5s and 17.2s and the other 27 together take under 8s, and a bag of
// independent tasks can never finish faster than its longest single task. Two
// workers take the stage from ~45s to ~23s; a third would save about 3s more.
const LAYOUT_WORKERS = 2;

const FCOSE = {
  name: 'fcose',
  quality: 'default',
  randomize: true,
  animate: false,
  nodeRepulsion: 6000,
  idealEdgeLength: 50,
  numIter: 2500,
  packComponents: false, // the deck packs; see above
};

// Send one task to an idle worker and wait for its reply. Each worker runs one
// task at a time, which the dispatch loop below guarantees by awaiting.
function runOn(worker, task) {
  return new Promise((resolve, reject) => {
    const done = (fn) => (arg) => {
      worker.off('message', ok);
      worker.off('error', fail);
      fn(arg);
    };
    const ok = done(resolve);
    const fail = done(reject);
    worker.once('message', ok);
    worker.once('error', fail);
    worker.postMessage(task, [task.edges.buffer]);
  });
}

// FNV-1a over the component's root id. Seeding per component rather than from
// one shared stream is what keeps the output independent of the order the
// workers happen to finish in.
function seedFor(id) {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

async function layoutComponents(nodes, edges) {
  const dsu = new DSU();
  for (const n of nodes) dsu.find(n.id);
  for (const e of edges) dsu.union(e.source, e.target);

  const comps = new Map();
  for (const n of nodes) {
    const root = dsu.find(n.id);
    if (!comps.has(root)) comps.set(root, { nodes: [], edges: [] });
    comps.get(root).nodes.push(n);
  }
  for (const e of edges) comps.get(dsu.find(e.source)).edges.push(e);

  // Biggest first. Handing the longest jobs out earliest is what stops a
  // worker picking up a 19s component when everything else is already done.
  const order = [...comps.entries()].sort((a, b) => b[1].nodes.length - a[1].nodes.length);

  // Index the nodes per component so the workers can talk in integers.
  const tasks = order.map(([root, comp]) => {
    const index = new Map(comp.nodes.map((n, i) => [n.id, i]));
    const pairs = new Int32Array(comp.edges.length * 2);
    comp.edges.forEach((e, i) => {
      pairs[2 * i] = index.get(e.source);
      pairs[2 * i + 1] = index.get(e.target);
    });
    return { root, count: comp.nodes.length, edges: pairs, seed: seedFor(root), ids: comp.nodes.map((n) => n.id) };
  });

  const pos = new Map();
  const radius = new Map();
  const workerPath = path.join(here, 'graph-layout-worker.mjs');
  const pool = Array.from(
    { length: Math.min(LAYOUT_WORKERS, tasks.length) },
    () => new Worker(workerPath, { workerData: { fcose: FCOSE, nodeSpacing: NODE_SPACING } }),
  );

  let next = 0;
  const started = Date.now();
  try {
    await Promise.all(pool.map(async (worker) => {
      for (let i = next++; i < tasks.length; i = next++) {
        const { root, count, edges: pairs, seed, ids } = tasks[i];
        const out = await runOn(worker, { root, count, edges: pairs, seed });
        for (let k = 0; k < ids.length; k += 1) pos.set(ids[k], [out.xy[2 * k], out.xy[2 * k + 1]]);
        radius.set(root, out.radius);
      }
    }));
  } finally {
    await Promise.all(pool.map((w) => w.terminate()));
  }

  console.log(
    `  laid out ${comps.size} components on ${pool.length} threads in ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s (largest r=${Math.max(...radius.values())})`,
  );
  return { comp: (id) => dsu.find(id), pos, radius };
}

// --- union-find for connected components ---

class DSU {
  constructor() {
    this.parent = new Map();
  }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    while (this.parent.get(x) !== root) {
      const next = this.parent.get(x);
      this.parent.set(x, root);
      x = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

async function main() {
  assertRepo();
  console.log(`Reading .modifiedby + .refs blobs from ${HISTORY_BRANCH}…`);
  const { modifiedby: blobs, refs: refBlobs } = await readSidecarBlobs();
  console.log(
    `  ${blobs.length.toLocaleString()} .modifiedby files, ` +
      `${refBlobs.length.toLocaleString()} .allegato-*.refs files`,
  );

  // Pass 1: collect the modifier codes so we know what needs resolving.
  const parsed = blobs.map(({ file, content }) => ({
    modified: file.replace(/\.modifiedby$/, ''),
    modifiers: content.split(/\s+/).filter(Boolean),
  }));
  const needed = new Set();
  for (const { modifiers } of parsed) for (const m of modifiers) needed.add(m);

  console.log(`Reconciling identities via the commit log…`);
  const actMeta = loadActMeta();
  const codeToSlug = await buildCodeToSlug(needed, actMeta);

  // Pass 2: build edges with every act as a single node.
  const edges = [];
  const outDegree = new Map();
  const degree = new Map();
  const nodeIsCode = new Map();
  const dsu = new DSU();
  const seen = new Set();
  let selfLoops = 0;
  let collapsed = 0;
  let refsEdges = 0;
  let refsSkipped = 0;

  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

  const addEdge = (source, target, sourceIsCode) => {
    if (source === target) { selfLoops += 1; return false; }
    const key = `${source}\u0000${target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (!nodeIsCode.has(source)) nodeIsCode.set(source, !!sourceIsCode);
    nodeIsCode.set(target, false);
    edges.push([source, target]);
    bump(outDegree, source);
    bump(degree, source);
    bump(degree, target);
    dsu.union(source, target);
    return true;
  };

  for (const { modified, modifiers } of parsed) {
    nodeIsCode.set(modified, false);
    for (const mod of modifiers) {
      const resolved = codeToSlug.get(mod);
      if (resolved) collapsed += 1;
      const source = resolved ?? mod;
      addEdge(source, modified, !resolved);
    }
  }

  for (const { file, content } of refBlobs) {
    const m = ALLEGATO_REFS_RE.exec(file);
    if (!m) continue;
    const source = `${m[1]}.txt`;
    nodeIsCode.set(source, false);
    for (const urn of parseRefsContent(content)) {
      const target = urnToSlug(urn);
      if (!target) { refsSkipped += 1; continue; }
      if (addEdge(source, target, false)) refsEdges += 1;
    }
  }

  console.log(
    `  ${edges.length.toLocaleString()} edges, ${nodeIsCode.size.toLocaleString()} nodes ` +
      `(${collapsed.toLocaleString()} edges remapped, ${selfLoops.toLocaleString()} self-loops dropped, ` +
      `${refsEdges.toLocaleString()} from .refs, ${refsSkipped.toLocaleString()} refs URNs unparsed)`,
  );

  // Keep components with >= MIN_COMPONENT nodes.
  const compSize = new Map();
  for (const node of nodeIsCode.keys()) bump(compSize, dsu.find(node));
  const keepNode = (n) => (compSize.get(dsu.find(n)) ?? 0) >= MIN_COMPONENT;

  const codeLabels = loadCodeLabels();
  const keptNodes = [];
  const keptIds = new Set();
  for (const [id, isCode] of nodeIsCode) {
    if (!keepNode(id)) continue;
    keptIds.add(id);
    const out = outDegree.get(id) ?? 0;
    const isHub = out >= HUB_MIN_DEGREE;
    let label = '';
    if (isHub) label = isCode ? codeLabels.get(id) ?? id : actLabel(id);
    keptNodes.push({
      id, label, degree: degree.get(id) ?? 0, outDegree: out, hub: isHub, unresolved: isCode,
    });
  }
  const keptEdges = edges
    .filter(([s, t]) => keptIds.has(s) && keptIds.has(t))
    .map(([source, target]) => ({ source, target }));
  console.log(
    `  kept ${keptNodes.length.toLocaleString()} nodes / ${keptEdges.length.toLocaleString()} edges ` +
      `(components >= ${MIN_COMPONENT})`,
  );

  if (keptNodes.length === 0) {
    writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), nodes: [], edges: [] }, null, 2));
    console.log('No components met the threshold; wrote empty graph.');
    return;
  }

  console.log('Laying out each component with fcose…');
  const laid = await layoutComponents(keptNodes, keptEdges);

  const hubs = keptNodes.filter((n) => n.hub).length;
  // Minified, and flags/labels only where they're true or non-empty: the deck
  // fetches this on slide entry, and 20k pretty-printed records carrying a
  // "hub": false each cost 5.9MB against 3.1MB here. The remainder is mostly
  // the slug IDs, which repeat once per node and once per edge endpoint.
  const slim = keptNodes.map((n) => {
    const root = laid.comp(n.id);
    const [x, y] = laid.pos.get(n.id) ?? [0, 0];
    const out = { id: n.id, degree: n.degree, x, y, comp: root, compR: laid.radius.get(root) ?? 1 };
    if (n.label) out.label = n.label;
    if (n.hub) out.hub = 1;
    if (n.unresolved) out.unresolved = 1;
    return out;
  });
  writeFileSync(
    outPath,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      minComponent: MIN_COMPONENT,
      layout: 'fcose-per-component',
      nodes: slim,
      edges: keptEdges,
    }),
  );
  console.log(`\nWrote ${outPath} — ${slim.length} nodes, ${keptEdges.length} edges, ${hubs} labelled hubs`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
