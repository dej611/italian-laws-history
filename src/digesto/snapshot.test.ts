import { describe, expect, it } from "vitest";
import { findStepChartSvg, prefersReducedData } from "./snapshot";

function rootWith(svg: { querySelector: (s: string) => unknown } | null) {
  return {
    querySelector: (sel: string) => (sel === "svg.step-chart" ? svg : null),
  };
}

describe("findStepChartSvg", () => {
  it("returns null when the node is missing", () => {
    expect(findStepChartSvg(rootWith(null))).toBeNull();
    expect(findStepChartSvg(null)).toBeNull();
  });

  it("returns null for an empty svg", () => {
    const empty = { querySelector: () => null };
    expect(findStepChartSvg(rootWith(empty))).toBeNull();
  });

  it("keeps an svg that has marks", () => {
    const mark = { tag: "rect" };
    const svg = { querySelector: (s: string) => (s.includes("rect") ? mark : null) };
    expect(findStepChartSvg(rootWith(svg))).toBe(svg);
  });
});

describe("prefersReducedData", () => {
  it("is true when saveData is on", () => {
    expect(prefersReducedData({ connection: { saveData: true } }, () => ({ matches: false }))).toBe(
      true,
    );
  });

  it("is false by default", () => {
    expect(prefersReducedData({}, () => ({ matches: false }))).toBe(false);
  });
});
