import { describe, expect, it } from "vitest";
import type { TalkData } from "../data/types";
import { formatCount } from "./query";
import {
  cannedRubrica,
  clampGazzettaYear,
  featuredForYear,
  parseGazzettaRubrica,
  yearFacts,
} from "./gazzetta";

const talk: TalkData = {
  totals: { acts: 1000, commits: 1, requests: 1 },
  dateRange: {
    first: "1861-04-23",
    last: "2026-07-29",
    firstEnactYear: 1861,
    lastEnactYear: 2026,
  },
  byYear: {
    types: ["LEGGE", "DECRETO-LEGGE", "DECRETO DEL PRESIDENTE DELLA REPUBBLICA"],
    rows: [
      { year: 1974, type: "LEGGE", count: 100 },
      { year: 1975, type: "LEGGE", count: 288 },
      { year: 1975, type: "DECRETO-LEGGE", count: 24 },
      { year: 1975, type: "DECRETO DEL PRESIDENTE DELLA REPUBBLICA", count: 865 },
      { year: 2008, type: "LEGGE", count: 61 },
      { year: 2008, type: "DECRETO-LEGGE", count: 27 },
    ],
  },
  refsByYear: [{ year: 1975, mean: 0.99, median: 0, max: 18, count: 1177 }],
  refDist: [],
  dlOutcomes: [
    { year: 1975, convertito: 1, decaduto: 23 },
    { year: 2008, convertito: 7, decaduto: 18 },
  ],
};

describe("yearFacts", () => {
  it("uses byYear volume, not a graph subset", () => {
    const f = yearFacts(talk, 1975);
    expect(f.total).toBe(1177);
    expect(f.parlamento).toBe(288);
    expect(f.governo).toBe(24);
    expect(f.altro).toBe(865);
    expect(f.dlDecaduto).toBe(23);
    expect(f.leggePct).toBe(24);
  });

  it("clamps to the corpus span", () => {
    expect(clampGazzettaYear(1800, 1861, 2026)).toBe(1861);
    expect(clampGazzettaYear(3000, 1861, 2026)).toBe(2026);
  });
});

describe("featuredForYear", () => {
  it("picks the highest-degree node enacted that year", () => {
    const { act, hubs } = featuredForYear(
      {
        nodes: [
          { id: "a.txt", degree: 2, x: 0, y: 0, comp: "c", compR: 1, label: "L. 1/1975" },
          {
            id: "decreto-legge-112-del-25-06-2008.txt",
            degree: 3722,
            x: 0,
            y: 0,
            comp: "c",
            compR: 1,
            label: "D.L. 112/2008",
            hub: 1,
          },
        ],
        edges: [],
      },
      {
        acts: [
          { slug: "a.txt", enactDate: "1975-01-01", enactYear: 1975, decadutoDate: null },
          {
            slug: "decreto-legge-112-del-25-06-2008.txt",
            label: "D.L. 112/2008",
            enactDate: "2008-06-25",
            enactYear: 2008,
            decadutoDate: null,
          },
        ],
      },
      2008,
    );
    expect(act?.label).toBe("D.L. 112/2008");
    expect(act?.degree).toBe(3722);
    expect(hubs).toBe(1);
  });
});

describe("parseGazzettaRubrica", () => {
  it("keeps an Italian line that cites the year volume", () => {
    const f = yearFacts(talk, 1975);
    const n = formatCount(f.total, "it");
    const parsed = parseGazzettaRubrica(
      JSON.stringify({
        rubrica:
          `Nel 1975 lo Stato mette in Gazzetta ${n} atti. Il parlamento ne firma 288. I decreti-legge decaduti sono 23.`,
      }),
      f,
      null,
      "it",
    );
    expect(parsed).toContain(n);
  });

  it("rejects English on IT locale", () => {
    const f = yearFacts(talk, 1975);
    expect(
      parseGazzettaRubrica(
        JSON.stringify({
          rubrica:
            "The state put 1.177 acts in the gazette in 1975. Parliament signed 288. Twenty-three decree-laws lapsed.",
        }),
        f,
        null,
        "it",
      ),
    ).toBeNull();
  });

  it("canned copy interpolates the year total", () => {
    const f = yearFacts(talk, 1975);
    const line = cannedRubrica(f, null, "it");
    expect(line).toContain(formatCount(f.total, "it"));
    expect(line).not.toContain("{total}");
  });
});
