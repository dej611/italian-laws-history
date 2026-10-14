import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildChart } from "./chart";
import { executeSpec, type QuerySpec, type YearRow } from "./query";

const dataPath = join(dirname(fileURLToPath(import.meta.url)), "../../public/data/data.json");
const talk = JSON.parse(readFileSync(dataPath, "utf8")) as {
  dateRange: { lastEnactYear: number };
  byYear: { rows: YearRow[] };
};
const rows = talk.byYear.rows;
const lastYear = talk.dateRange.lastEnactYear;

describe("buildChart", () => {
  it("compare eras → bars", () => {
    const spec: QuerySpec = {
      intent: "compare",
      eras: ["monarchy", "republic"],
      measure: "LEGGE",
    };
    const chart = buildChart(executeSpec(spec, rows, lastYear), rows, "it");
    expect(chart?.type).toBe("compare");
    if (chart?.type !== "compare") return;
    expect(chart.bars).toHaveLength(2);
    expect(chart.bars[0].value).toBeGreaterThan(0);
  });

  it("multi-year count → series", () => {
    const spec: QuerySpec = {
      intent: "count",
      eras: ["fascism"],
      measure: "all",
    };
    const chart = buildChart(executeSpec(spec, rows, lastYear), rows, "en");
    expect(chart?.type).toBe("series");
    if (chart?.type !== "series") return;
    expect(chart.series[0].points.length).toBeGreaterThan(10);
  });

  it("single-year count → no chart", () => {
    const spec: QuerySpec = {
      intent: "count",
      eras: [],
      measure: "LEGGE",
      from: 2001,
      to: 2001,
    };
    expect(buildChart(executeSpec(spec, rows, lastYear), rows, "it")).toBeUndefined();
  });
});
