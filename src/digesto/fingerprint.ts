/** Deterministic DNA print params from act metadata. No model. */

export type PrintKind = "gu" | "modifica" | "decaduto" | "convertito" | "other";

export type PrintParams = {
  slug: string;
  seed: number;
  ridges: number;
  rings: number;
  ink: number;
  era: "unita" | "fascismo" | "repubblica" | "seconda";
  strike: boolean;
  wear: number;
};

export function hashSlug(slug: string): number {
  let h = 2166136261;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function eraFromYear(year: number | null): PrintParams["era"] {
  if (year == null || year < 1922) return "unita";
  if (year < 1946) return "fascismo";
  if (year < 1990) return "repubblica";
  return "seconda";
}

export function printParams(opts: {
  slug: string;
  enactYear: number | null;
  degree?: number;
  revisionCount: number;
  wearIndex: number;
  decaduto?: boolean;
  wearKind?: PrintKind;
}): PrintParams {
  const seed = hashSlug(opts.slug);
  const revisionCount = Math.max(0, opts.revisionCount);
  const wear = revisionCount === 0 ? 0 : Math.min(opts.wearIndex, Math.max(0, revisionCount - 1));
  const rings = Math.max(1, wear + 1);
  const ridges = 10 + (seed % 9);
  const deg = Math.min(40, Math.max(1, opts.degree ?? 1));
  const ink = Math.min(1, 0.35 + Math.log(deg + 1) / 8);
  const strike = Boolean(opts.decaduto) || opts.wearKind === "decaduto";
  return {
    slug: opts.slug,
    seed,
    ridges,
    rings,
    ink,
    era: eraFromYear(opts.enactYear),
    strike,
    wear,
  };
}

/** Seeded 0–1. */
export function rand(seed: number, i: number): number {
  const x = Math.imul(seed ^ Math.imul(i + 1, 1597334677), 2246822519);
  return ((x >>> 0) % 10000) / 10000;
}

export type TreeEntry = { year: number; kind: PrintKind };

export type TreeSeg = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  cx: number;
  cy: number;
  era: PrintParams["era"];
  kind: PrintKind;
  year: number;
  i: number;
};

/** Fixed angle per version; radius grows. Colour comes from the caller (era). */
const SPIRAL_STEP = Math.PI / 5;
export const SPIRAL_GRID_DENSE = 100;
export const SPIRAL_GRID_SPARSE = 50;

/** Sparse lattice under 10 versions; dense from 10 up. */
export function spiralGridSteps(versionCount: number): 50 | 100 {
  return versionCount >= 10 ? SPIRAL_GRID_DENSE : SPIRAL_GRID_SPARSE;
}

export function spiralLatticePoint(
  i: number,
  steps: number = SPIRAL_GRID_DENSE,
  size = 200,
): { x: number; y: number } {
  const cx = size / 2;
  const cy = size / 2;
  const r0 = 14;
  const rMax = size / 2 - 14;
  const dr = (rMax - r0) / Math.max(1, steps - 1);
  const theta = -Math.PI / 2 + i * SPIRAL_STEP;
  const r = r0 + dr * i;
  return { x: cx + Math.cos(theta) * r, y: cy + Math.sin(theta) * r };
}

export function spiralGridPoints(
  steps: number = SPIRAL_GRID_DENSE,
  size = 200,
): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < steps; i++) pts.push(spiralLatticePoint(i, steps, size));
  return pts;
}

export function revisionSpiral(
  entries: TreeEntry[],
  size = 200,
): TreeSeg[] {
  const list =
    entries.length > 0 ? entries : [{ year: 1861, kind: "gu" as const }];
  const steps = spiralGridSteps(list.length);
  const n = Math.min(list.length, steps);
  const segs: TreeSeg[] = [];
  for (let i = 0; i < n; i++) {
    const e = list[i];
    const p = spiralLatticePoint(i, steps, size);
    const prev = i === 0 ? p : spiralLatticePoint(i - 1, steps, size);
    segs.push({
      x1: prev.x,
      y1: prev.y,
      x2: p.x,
      y2: p.y,
      cx: p.x,
      cy: p.y,
      era: eraFromYear(e.year),
      kind: e.kind,
      year: e.year,
      i,
    });
  }
  return segs;
}

export type ChangeArc = {
  firstYear: number | null;
  lastYear: number | null;
  decadutoYear: number | null;
  modifica: number;
  convertito: number;
  byEra: Record<PrintParams["era"], number>;
};

/** How the act moved through the archive — counts from blame, not from the text. */
export function changeArc(entries: TreeEntry[]): ChangeArc {
  const byEra: ChangeArc["byEra"] = {
    unita: 0,
    fascismo: 0,
    repubblica: 0,
    seconda: 0,
  };
  let decadutoYear: number | null = null;
  let modifica = 0;
  let convertito = 0;
  for (const e of entries) {
    if (e.kind === "decaduto") decadutoYear = e.year || decadutoYear;
    if (e.kind === "modifica" || e.kind === "convertito") {
      byEra[eraFromYear(e.year)] += 1;
      if (e.kind === "modifica") modifica += 1;
      else convertito += 1;
    }
  }
  return {
    firstYear: entries[0]?.year ?? null,
    lastYear: entries[entries.length - 1]?.year ?? null,
    decadutoYear,
    modifica,
    convertito,
    byEra,
  };
}
