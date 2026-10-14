// One component in, its laid-out node positions out. Driven by
// build-graph.mjs, which owns the fcose options and the density target and
// passes them in via workerData so the parameters live in exactly one place.
//
// Nodes arrive as a plain count and edges as index pairs, never as slugs: the
// caller knows the id for every index, so keeping strings out of the messages
// halves what gets structure-cloned across the thread boundary. Positions go
// back in the same index order.
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cytoscape = require('cytoscape');
cytoscape.use(require('cytoscape-fcose'));

const { fcose, nodeSpacing } = workerData;

// fcose draws its starting positions from Math.random and takes no seed, so a
// build would otherwise deal a different picture every time. The caller sends
// a seed derived from the component itself, which means a component's layout
// depends only on that component — not on which worker picked it up or in what
// order, as a single shared stream would.
function seeded(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function layout({ count, edges, seed }) {
  const nodes = new Array(count);
  for (let i = 0; i < count; i += 1) nodes[i] = { data: { id: String(i) } };
  const links = new Array(edges.length / 2);
  for (let i = 0; i < links.length; i += 1) {
    links[i] = { data: { id: `e${i}`, source: String(edges[2 * i]), target: String(edges[2 * i + 1]) } };
  }

  const cy = cytoscape({ headless: true, styleEnabled: false, elements: { nodes, edges: links } });
  const real = Math.random;
  Math.random = seeded(seed);
  try {
    // animate:false makes this synchronous in practice, but wait on the event
    // rather than bet the positions on that.
    await new Promise((resolve, reject) => {
      const run = cy.layout(fcose);
      run.one('layoutstop', resolve);
      try { run.run(); } catch (err) { reject(err); }
    });
  } finally {
    Math.random = real;
  }

  const xy = new Float64Array(count * 2);
  cy.nodes().forEach((n) => {
    const i = Number(n.id());
    const p = n.position();
    xy[2 * i] = p.x;
    xy[2 * i + 1] = p.y;
  });
  cy.destroy();

  let cx = 0;
  let cy0 = 0;
  for (let i = 0; i < count; i += 1) { cx += xy[2 * i]; cy0 += xy[2 * i + 1]; }
  cx /= count;
  cy0 /= count;

  let raw = 0;
  for (let i = 0; i < count; i += 1) raw = Math.max(raw, Math.hypot(xy[2 * i] - cx, xy[2 * i + 1] - cy0));

  // Normalise to a fixed area per node so every component reads at the same
  // density; see the LAYOUT note in build-graph.mjs.
  const scale = Math.min(1, (nodeSpacing * Math.sqrt(count / Math.PI)) / (raw || 1));
  for (let i = 0; i < count; i += 1) {
    xy[2 * i] = Math.round((xy[2 * i] - cx) * scale * 10) / 10;
    xy[2 * i + 1] = Math.round((xy[2 * i + 1] - cy0) * scale * 10) / 10;
  }

  return { xy, radius: Math.round(raw * scale) };
}

parentPort.on('message', async (task) => {
  const { xy, radius } = await layout(task);
  parentPort.postMessage({ root: task.root, xy, radius }, [xy.buffer]);
});
