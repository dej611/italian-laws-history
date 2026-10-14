import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GOLD } from "./query.gold";
import {
  executeSpec,
  formatAnswer,
  formatCount,
  numberLockHolds,
  parseJsonSpec,
  parseQuery,
  isTextSearchQuery,
  stripInstructionLeak,
  validateSpec,
  type QuerySpec,
  type YearRow,
} from "./query";

const dataPath = join(dirname(fileURLToPath(import.meta.url)), "../../public/data/data.json");
const talk = JSON.parse(readFileSync(dataPath, "utf8")) as {
  dateRange: { lastEnactYear: number };
  byYear: { rows: YearRow[] };
};
const rows = talk.byYear.rows;
const lastYear = talk.dateRange.lastEnactYear;

function parseTurns(turns: string[]): QuerySpec | null {
  let spec: QuerySpec | null = null;
  for (const turn of turns) {
    spec = parseQuery(turn, spec);
  }
  return spec;
}

describe("gold parseQuery (no model)", () => {
  for (const item of GOLD) {
    it(`#${item.id} ${item.turns[item.turns.length - 1]}`, () => {
      expect(parseTurns(item.turns)).toEqual(item.spec);
    });
  }
});

describe("executeSpec vs by_year", () => {
  it("compare LEGGE monarchy vs republic has two counts and a winner", () => {
    const spec: QuerySpec = {
      intent: "compare",
      eras: ["monarchy", "republic"],
      measure: "LEGGE",
    };
    const executed = executeSpec(spec, rows, lastYear);
    expect(executed.numbers).toHaveLength(2);
    expect(executed.numbers[0]).toBeGreaterThan(0);
    expect(executed.numbers[1]).toBeGreaterThan(0);
    const it = formatAnswer(executed, "it");
    expect(numberLockHolds(it, executed.numbers, "it")).toBe(true);
    expect(it).toMatch(/monarchia/i);
    expect(it).toMatch(/Repubblica/);
  });

  it("decreti_bare republic returns governo and family, family >= governo", () => {
    const spec: QuerySpec = {
      intent: "count",
      eras: ["republic"],
      measure: "decreti_bare",
    };
    const executed = executeSpec(spec, rows, lastYear);
    expect(executed.numbers).toHaveLength(2);
    expect(executed.numbers[1]).toBeGreaterThanOrEqual(executed.numbers[0]);
    const text = formatAnswer(executed, "it");
    expect(text).toMatch(/esecutivo/);
    expect(text).toMatch(/decreto/);
    expect(numberLockHolds(text, executed.numbers, "it")).toBe(true);
  });

  it("regio decreto under republic is a small positive count", () => {
    const spec: QuerySpec = {
      intent: "count",
      eras: ["republic"],
      measure: "REGIO DECRETO",
    };
    const executed = executeSpec(spec, rows, lastYear);
    expect(executed.numbers[0]).toBeGreaterThan(0);
    expect(executed.numbers[0]).toBeLessThan(100);
  });

  it("second_rep LEGGE matches from-1990 LEGGE", () => {
    const a = executeSpec(
      { intent: "count", eras: ["second_rep"], measure: "LEGGE" },
      rows,
      lastYear,
    );
    const b = executeSpec(
      { intent: "count", eras: [], measure: "DECRETO-LEGGE", from: 1990 },
      rows,
      lastYear,
    );
    const laws1990 = executeSpec(
      { intent: "count", eras: [], measure: "LEGGE", from: 1990 },
      rows,
      lastYear,
    );
    expect(a.numbers[0]).toBe(laws1990.numbers[0]);
    expect(b.numbers[0]).toBeGreaterThan(0);
  });
});

describe("DPR vs republic era", () => {
  it("does not treat ‘presidente della repubblica’ as the Republic era", () => {
    expect(
      parseQuery(
        "Quanti decreto del presidente della repubblica (DPR) sono stati emanati sotto la monarchia?",
      ),
    ).toEqual({
      intent: "count",
      eras: ["monarchy"],
      measure: "DECRETO DEL PRESIDENTE DELLA REPUBBLICA",
    });
  });
});

describe("instruction leak", () => {
  it("strips echoed rephrase instructions before the real sentence", () => {
    const leaked =
      "Rephrase in italian, 1–2 dry sentences. Keep All Numbers As Read. Do not add or drop Numbers.  Sotto la Repubblica (1946–2026) risultano 43.376 D.P.R. (DECRETO DEL PRESIDENTE DELLA REPUBBLICA) emanati nel corpus.";
    expect(stripInstructionLeak(leaked)).toBe(
      "Sotto la Repubblica (1946–2026) risultano 43.376 D.P.R. (DECRETO DEL PRESIDENTE DELLA REPUBBLICA) emanati nel corpus.",
    );
  });
});

describe("text search vs analytics", () => {
  it("does not treat decreto counts as text search", () => {
    expect(isTextSearchQuery("Quanti decreti durante la Repubblica?")).toBe(false);
    expect(isTextSearchQuery("How many regio decreto under the republic?")).toBe(false);
    expect(isTextSearchQuery("cosa dice l'articolo 1")).toBe(true);
  });
});

describe("JSON slot fill + number-lock", () => {
  it("accepts valid enum JSON", () => {
    expect(
      parseJsonSpec(
        '{"intent":"count","eras":["republic"],"measure":"decreti_bare"}',
      ),
    ).toEqual({
      intent: "count",
      eras: ["republic"],
      measure: "decreti_bare",
    });
  });

  it("rejects unknown keys and unknown enums", () => {
    expect(parseJsonSpec('{"intent":"count","eras":["republic"],"measure":"LEGGE","foo":1}')).toBeNull();
    expect(parseJsonSpec('{"intent":"count","eras":["empire"],"measure":"LEGGE"}')).toBeNull();
    expect(validateSpec(null)).toBeNull();
  });

  it("keeps a paraphrase that preserves formatted numbers", () => {
    const numbers = [15577, 9];
    const locale = "it" as const;
    const a = formatCount(numbers[0], locale);
    const b = formatCount(numbers[1], locale);
    expect(numberLockHolds(`Sotto la Repubblica risultano ${a} e ${b} atti.`, numbers, locale)).toBe(
      true,
    );
    expect(numberLockHolds(`Sotto la Repubblica risultano ${a} atti.`, numbers, locale)).toBe(false);
    expect(numberLockHolds(`Sotto la Repubblica risultano 15577 e 9 atti.`, numbers, locale)).toBe(
      false,
    );
  });
});
