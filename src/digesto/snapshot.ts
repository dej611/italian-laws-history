/** Rasterize the sticky StepChart for Prompt API image-in. No model. */

export const STEP_CHART_SELECTOR = "svg.step-chart";
export const STEP_CHART_CANVAS_SELECTOR = ".step-chart canvas.echCanvasRenderer";

const DRAWABLE = "rect, line, path, polyline, polygon, circle, ellipse";

export type QueryRoot = {
  querySelector: (selectors: string) => { querySelector: (s: string) => unknown } | null;
};

export function prefersReducedData(
  nav: { connection?: { saveData?: boolean } } | undefined =
    typeof navigator !== "undefined"
      ? (navigator as Navigator & { connection?: { saveData?: boolean } })
      : undefined,
  matchMedia: ((q: string) => { matches: boolean }) | undefined =
    typeof window !== "undefined" ? (q) => window.matchMedia(q) : undefined,
): boolean {
  if (nav?.connection?.saveData) return true;
  try {
    return matchMedia?.("(prefers-reduced-data: reduce)")?.matches === true;
  } catch {
    return false;
  }
}

/** Live charts canvas if it has a bitmap; otherwise null. Node-safe. */
export function findStepChartCanvas(
  root: { querySelector: (selectors: string) => unknown } | null | undefined,
): { width: number; height: number } | null {
  if (!root) return null;
  const el = root.querySelector(STEP_CHART_CANVAS_SELECTOR);
  if (!el || typeof el !== "object") return null;
  const box = el as { width?: number; height?: number };
  if (!box.width || !box.height) return null;
  return el as { width: number; height: number };
}

/** Live SVG if it has marks; otherwise null. Node-safe (no DOM types required). */
export function findStepChartSvg(root: QueryRoot | null | undefined): {
  querySelector: (s: string) => unknown;
} | null {
  if (!root) return null;
  const el = root.querySelector(STEP_CHART_SELECTOR);
  if (!el) return null;
  if (!el.querySelector(DRAWABLE)) return null;
  return el;
}

function inlineComputedPaint(src: Element, dst: Element) {
  if (typeof getComputedStyle === "undefined") return;
  const cs = getComputedStyle(src);
  const fill = cs.getPropertyValue("fill");
  const stroke = cs.getPropertyValue("stroke");
  const sw = cs.getPropertyValue("stroke-width");
  const op = cs.getPropertyValue("opacity");
  if (fill && fill !== "none") dst.setAttribute("fill", fill);
  if (stroke && stroke !== "none") dst.setAttribute("stroke", stroke);
  if (sw) dst.setAttribute("stroke-width", sw);
  if (op && op !== "1") dst.setAttribute("opacity", op);
  const kids = src.children;
  const dstKids = dst.children;
  for (let i = 0; i < kids.length && i < dstKids.length; i++) {
    inlineComputedPaint(kids[i], dstKids[i]);
  }
}

/** Offscreen bitmap of the on-screen chart, or null. */
export async function snapshotStepChart(
  root: ParentNode | null | undefined =
    typeof document !== "undefined" ? document : undefined,
): Promise<ImageBitmap | null> {
  if (!root || prefersReducedData()) return null;
  const canvas = findStepChartCanvas(root);
  if (canvas instanceof HTMLCanvasElement) {
    try {
      return await createImageBitmap(canvas);
    } catch {
      return null;
    }
  }
  const found = findStepChartSvg(root);
  if (!found || !(found instanceof SVGSVGElement)) return null;
  const clone = found.cloneNode(true) as SVGSVGElement;
  inlineComputedPaint(found, clone);
  const vb = found.viewBox.baseVal;
  const w = Math.max(1, Math.round(vb.width || found.clientWidth || 720));
  const h = Math.max(1, Math.round(vb.height || found.clientHeight || 280));
  clone.setAttribute("width", String(w));
  clone.setAttribute("height", String(h));
  const xml = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("svg"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    return await createImageBitmap(canvas);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
