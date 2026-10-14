/** Geometric parts of a recognizable upright gavel (viewBox 0 0 80 120). */
export const GAVEL_PARTS = {
  head: { x: 12, y: 16, width: 56, height: 30, rx: 11 },
  shaft: { x: 35, y: 44, width: 10, height: 46, rx: 2.5 },
  pommel: { cx: 40, cy: 100, r: 11 },
} as const;

/** Head band lines (local cues). */
export const GAVEL_BANDS = [
  { x1: 24, y1: 20, x2: 24, y2: 42 },
  { x1: 56, y1: 20, x2: 56, y2: 42 },
  { x1: 32, y1: 19, x2: 32, y2: 43 },
  { x1: 48, y1: 19, x2: 48, y2: 43 },
] as const;
