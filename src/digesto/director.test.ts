import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { TalkData } from "../data/types";
import { SCROLLY_STEP_IDS } from "../content/steps";
import { formatCount } from "./query";
import {
  cannedCue,
  cannedWhisper,
  cueOrCanned,
  factsForStep,
  parseDirectorCue,
  whisperAccepts,
} from "./director";
import { changeArc, hashSlug, printParams, revisionSpiral, spiralGridPoints, spiralGridSteps } from "./fingerprint";
import { cannedClusterLine, clusterFacts, parseEpithet } from "./clusters";
import { barHeight, DEFAULT_REMIX, inRemixEra, specFromStep, yearTotals } from "./remix";
import { extractiveSummary, parseActBlurb } from "./act-blurb";

const dataPath = join(dirname(fileURLToPath(import.meta.url)), "../../public/data/data.json");
const talk = JSON.parse(readFileSync(dataPath, "utf8")) as TalkData;

describe("factsForStep", () => {
  it("counts the whole corpus on archivio", () => {
    const f = factsForStep("archivio", talk);
    expect(f.total).toBeGreaterThan(10000);
    expect(f.firstYear).toBe(talk.dateRange.firstEnactYear);
    expect(f.monarchy + f.republic).toBe(f.total);
    expect(f.peakYear).toBeGreaterThanOrEqual(f.firstYear);
    expect(f.peakCount).toBeGreaterThan(f.quietCount);
    expect(f.leggePct + f.regiPct + f.decretiPct).toBeGreaterThan(50);
    expect(f.peakRatio).toBeGreaterThan(1);
    expect(f.spanYears).toBeGreaterThan(100);
  });
});

describe("canned cues", () => {
  it("covers every scrolly step", () => {
    const f = factsForStep("archivio", talk);
    for (const id of SCROLLY_STEP_IDS) {
      const line = cannedCue(id, f, "it");
      expect(line).not.toContain("{");
      expect(line.length).toBeGreaterThan(8);
      const w = cannedWhisper(id, f, "it");
      expect(w).not.toContain("{");
      expect(w.length).toBeGreaterThan(4);
    }
  });
  it("interpolates Italian numbers", () => {
    const f = factsForStep("volume", talk);
    const line = cannedCue("volume", f, "it");
    expect(line).toContain(String(f.peakYear));
    expect(line).toContain(String(f.quietYear));
    expect(line.length).toBeGreaterThan(10);
    expect(line).not.toContain("{peakCount}");
    expect(cannedCue("archivio", f, "it")).not.toBe(line);
  });

  it("whisper is shorter than the cue", () => {
    const f = factsForStep("taglio", talk);
    const w = cannedWhisper("taglio", f, "it");
    expect(w).toMatch(/2008/);
    expect(w.length).toBeLessThan(cannedCue("taglio", f, "it").length + 5);
  });
});

describe("parseDirectorCue", () => {
  it("accepts JSON that keeps a fact number", () => {
    const f = factsForStep("archivio", talk);
    const n = formatCount(f.total, "it");
    const parsed = parseDirectorCue(
      JSON.stringify({ animation: "Speak", line: `Nel corpus risultano ${n} atti.` }),
      f,
      "it",
    );
    expect(parsed?.animation).toBe("Speak");
    expect(parsed?.line).toContain(n);
  });

  it("rejects a line with no numbers", () => {
    const f = factsForStep("archivio", talk);
    expect(
      parseDirectorCue(JSON.stringify({ animation: "Speak", line: "Tutto bene." }), f, "it"),
    ).toBeNull();
  });

  it("cueOrCanned falls back", () => {
    const f = factsForStep("close", talk);
    const cue = cueOrCanned(null, "close", f, "it");
    expect(cue.animation).toBe("Congratulate");
    expect(cue.line.length).toBeGreaterThan(5);
  });

  it("accepts vision JSON with event and a FACT year", () => {
    const f = factsForStep("taglio", talk);
    const n = formatCount(f.deltaAbs, "it");
    const parsed = parseDirectorCue(
      JSON.stringify({
        animation: "GetAttention",
        event: "cliff",
        year: 2009,
        line: `Dal 2008 al 2009 il volume perde ${n} atti.`,
      }),
      f,
      "it",
    );
    expect(parsed?.animation).toBe("GetAttention");
    expect(parsed?.line).toContain(n);
  });

  it("rejects a year that is not in the facts", () => {
    const f = factsForStep("taglio", talk);
    const n = formatCount(f.deltaAbs, "it");
    expect(
      parseDirectorCue(
        JSON.stringify({
          animation: "Speak",
          event: "cliff",
          year: 1111,
          line: `Il grafico perde ${n} atti.`,
        }),
        f,
        "it",
      ),
    ).toBeNull();
  });
});

describe("whisperAccepts", () => {
  it("keeps an Italian line that cites a count", () => {
    const f = factsForStep("volume", talk);
    const n = formatCount(f.total, "it");
    expect(whisperAccepts(`Nel corpus ci sono ${n} atti.`, f, "it")).toBe(true);
  });

  it("drops English on IT locale", () => {
    const f = factsForStep("volume", talk);
    const n = formatCount(f.total, "it");
    expect(whisperAccepts(`The corpus has ${n} acts.`, f, "it")).toBe(false);
  });
});

describe("fingerprint", () => {
  it("is stable for a slug", () => {
    expect(hashSlug("legge-473-del-17-04-1925.txt")).toBe(
      hashSlug("legge-473-del-17-04-1925.txt"),
    );
    const a = printParams({
      slug: "legge-473-del-17-04-1925.txt",
      enactYear: 1925,
      degree: 40,
      revisionCount: 14,
      wearIndex: 3,
    });
    const b = printParams({
      slug: "legge-473-del-17-04-1925.txt",
      enactYear: 1925,
      degree: 40,
      revisionCount: 14,
      wearIndex: 3,
    });
    expect(a.seed).toBe(b.seed);
    expect(a.rings).toBe(4);
    expect(a.era).toBe("fascismo");
  });

  it("wear increases rings", () => {
    const base = {
      slug: "x.txt",
      enactYear: 2008,
      revisionCount: 5,
      wearIndex: 0 as number,
    };
    expect(printParams(base).rings).toBe(1);
    expect(printParams({ ...base, wearIndex: 4 }).rings).toBe(5);
  });

  it("revision spiral uses a fixed angle and era colour", () => {
    const marks = [
      { year: 1925, kind: "gu" as const },
      { year: 1926, kind: "modifica" as const },
      { year: 1948, kind: "modifica" as const },
      { year: 2008, kind: "decaduto" as const },
    ];
    const segs = revisionSpiral(marks);
    expect(segs).toHaveLength(4);
    expect(segs[0].era).toBe("fascismo");
    expect(segs[2].era).toBe("repubblica");
    const a0 = Math.atan2(segs[0].cy - 100, segs[0].cx - 100);
    const a1 = Math.atan2(segs[1].cy - 100, segs[1].cx - 100);
    const step = ((a1 - a0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    expect(Math.abs(Math.abs(step) - Math.PI / 5)).toBeLessThan(0.05);
    const grid = spiralGridPoints(50);
    expect(grid).toHaveLength(50);
    expect(spiralGridSteps(4)).toBe(50);
    expect(spiralGridSteps(10)).toBe(100);
    expect(segs[0].cx).toBeCloseTo(grid[0].x, 5);
    expect(segs[0].cy).toBeCloseTo(grid[0].y, 5);
    expect(segs[3].cx).toBeCloseTo(grid[3].x, 5);
    const arc = changeArc(marks);
    expect(arc.modifica).toBe(2);
    expect(arc.byEra.fascismo).toBe(1);
    expect(arc.byEra.repubblica).toBe(1);
    expect(arc.decadutoYear).toBe(2008);
  });
});

describe("clusters", () => {
  it("names a component from its hub", () => {
    const facts = clusterFacts(
      {
        nodes: [
          { id: "a.txt", degree: 2, x: 0, y: 0, comp: "c1", compR: 10, label: "L. 1/1900" },
          { id: "b.txt", degree: 9, x: 0, y: 0, comp: "c1", compR: 10, label: "L. 473/1925", hub: 1 },
        ],
        edges: [],
      },
      { acts: [{ slug: "a.txt", enactDate: "1900-01-01", enactYear: 1900, decadutoDate: null }, { slug: "b.txt", enactDate: "1925-04-17", enactYear: 1925, decadutoDate: null }] },
    );
    const line = cannedClusterLine(facts.get("c1")!, "it");
    expect(line).toMatch(/473/);
    expect(line).toMatch(/2 atti/);
    expect(line).toMatch(/1900/);
  });

  it("parseEpithet rejects topics that are too long", () => {
    expect(parseEpithet('{"epithet":"nodo del 1925"}')).toBe("nodo del 1925");
    expect(parseEpithet('{"epithet":"diritto del lavoro previdenza e agricoltura oggi"}')).toBeNull();
  });
});

describe("remix", () => {
  it("yearTotals all matches TalkData total", () => {
    const rows = yearTotals(talk, "all");
    const sum = rows.reduce((s, r) => s + r.count, 0);
    const expected = talk.byYear.rows.reduce((s, r) => s + r.count, 0);
    expect(sum).toBe(expected);
    expect(barHeight(0, 100, "linear", 200)).toBe(0);
    expect(barHeight(100, 100, "log", 200)).toBe(200);
    expect(DEFAULT_REMIX.scale).toBe("linear");
    expect(inRemixEra(1930, "fascismo")).toBe(true);
    expect(inRemixEra(1930, "repubblica")).toBe(false);
    expect(specFromStep("urgenze").measure).toBe("governo");
    expect(specFromStep("taglio").story).toBe("dl112");
    expect(specFromStep("canali").measure).toBe("channels");
    expect(specFromStep("canali").normalize).toBe("share");
    expect(barHeight(40, 100, "linear", 200, true)).toBe(200);
  });
});

describe("act blurb", () => {
  it("keeps Art. abbreviations in extractive sentences", () => {
    const text =
      "Art. 1 disciplina l’ordinamento degli enti. Il decreto fissa i termini di attuazione. Resta ferma la disciplina transitoria. Si abrogano le norme incompatibili.";
    const s = extractiveSummary(text, 3);
    expect(s).toContain("Art. 1");
    expect(s).toContain("termini di attuazione");
    expect(s.split(/(?<=[.!?])\s+(?=[A-ZÀÈÉÌÒÙ])/).length).toBe(3);
  });

  it("parses a grounded Italian JSON blurb", () => {
    const parsed = parseActBlurb(
      JSON.stringify({
        summary:
          "Il decreto disciplina l’organizzazione degli enti locali e fissa i termini di attuazione sul territorio. Resta ferma la disciplina transitoria per gli atti già adottati. Si abrogano le norme incompatibili.",
        changes: "Dal 2008 al 2012: tre modifiche in Repubblica.",
      }),
      "it",
    );
    expect(parsed?.summary).toMatch(/decreto/);
    expect(parsed?.changes).toMatch(/2008/);
  });

  it("rejects an English summary on IT locale", () => {
    expect(
      parseActBlurb(
        JSON.stringify({
          summary:
            "The act regulates local bodies and sets implementation deadlines across the country. Transitional rules stay in force. Incompatible provisions are repealed.",
          changes: "Three amendments from 2008 to 2012.",
        }),
        "it",
      ),
    ).toBeNull();
  });
});
