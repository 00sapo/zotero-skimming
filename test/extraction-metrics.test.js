import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { compareBaseline, evaluateCorpus, exactSentenceRecall, excludedLeakage, orderInversions, validRectangleFraction, wordMetrics } from "../scripts/evaluate-extraction.mjs";

const rect = [0, 0, 10, 5];

describe("extraction evaluation metrics", () => {
  it("computes exact sentence recall without reusing duplicate matches", () => {
    expect(exactSentenceRecall(["A repeated sentence.", "A repeated sentence."], ["A repeated sentence.", "A repeated sentence.", "Missing."])).toMatchObject({ recall: 2 / 3, matchedSentences: 2 });
  });

  it("normalizes word tokens and uses multiset overlap", () => {
    expect(wordMetrics(["Alpha beta beta"], ["alpha beta gamma"])).toMatchObject({ precision: 2 / 3, recall: 2 / 3, matchedWords: 2 });
    expect(wordMetrics([], ["words"])).toMatchObject({ precision: 0, recall: 0 });
  });

  it("counts matched sentence order inversions", () => {
    const expected = ["The first sufficiently descriptive sentence appears here.", "The second sufficiently descriptive sentence appears here."];
    expect(orderInversions(expected.slice().reverse(), expected).inversions).toBe(1);
    expect(orderInversions(["unmatched filler"], expected).inversions).toBe(0);
    expect(orderInversions(
      ["Repeated sentence.", "Unique sentence.", "Repeated sentence."],
      ["Unique sentence.", "Repeated sentence.", "Repeated sentence."]
    )).toEqual({ inversions: 0, matchedSentences: 1 });
  });

  it("checks rectangle validity and excluded phrase leakage", () => {
    expect(validRectangleFraction([{ rects: [rect, [0, 0, 0, 5], [1, 1]] }])).toMatchObject({ fraction: 1 / 3, validRectangles: 1 });
    expect(excludedLeakage(["The table reports the final outcome."], [{ text: "table reports the final outcome", kind: "table", pageIndex: 0 }, { text: "not present", kind: "caption", pageIndex: 0 }])).toBe(1);
    expect(excludedLeakage(
      ["The control group receives the treatment."],
      [{ text: "Control", kind: "table", pageIndex: 0 }],
      ["The control group receives the treatment."]
    )).toBe(0);
  });

  it("gates only semantic regression metrics", () => {
    const baseline = { cases: [{ id: "one", exactSentenceRecall: 1, wordPrecision: 1, wordRecall: 1, excludedLeakageCount: 0, readingOrderInversions: 0, validRectangleFraction: 1 }] };
    const unchanged = { cases: [{ ...baseline.cases[0] }] };
    expect(compareBaseline(unchanged, baseline)).toEqual([]);
    expect(compareBaseline({ cases: [{ ...baseline.cases[0], wordPrecision: 0.9, excludedLeakageCount: 1, validRectangleFraction: 0.2 }] }, baseline)).toHaveLength(3);
  });
});

describe("academic PDF extraction corpus", () => {
  it("does not lose prose or admit more excluded content than the reviewed baseline", async () => {
    const baseline = JSON.parse(fs.readFileSync(new URL("./fixtures/pdf-extraction/baseline.json", import.meta.url), "utf8"));
    const current = await evaluateCorpus();
    expect(compareBaseline(current, baseline)).toEqual([]);
  }, 30000);
});
