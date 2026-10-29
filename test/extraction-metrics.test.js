import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { characterConfusionMetrics, compareBaseline, evaluateCorpus, exactSentenceRecall, excludedLeakage, orderInversions, recoveredSentenceCount, sentenceBalancedMetrics, validRectangleFraction, wordMetrics } from "../scripts/evaluate-extraction.mjs";

const rect = [0, 0, 10, 5];

describe("extraction evaluation metrics", () => {
  it("computes exact sentence recall without reusing duplicate matches", () => {
    expect(exactSentenceRecall(["A repeated sentence.", "A repeated sentence."], ["A repeated sentence.", "A repeated sentence.", "Missing."])).toMatchObject({ recall: 2 / 3, matchedSentences: 2 });
  });

  it("balances exact sentence recovery against false-positive negative units", () => {
    const result = sentenceBalancedMetrics(1, 2, [
      { charIndices: [4, 5] },
      { charIndices: [9] },
      { charIndices: [12, 13] }
    ], new Set([4, 9]));
    expect(result).toMatchObject({
      sensitivity: 0.5,
      specificity: 1 / 3,
      counts: { truePositive: 1, falseNegative: 1, falsePositive: 2, trueNegative: 1 }
    });
    expect(result.balancedAccuracy).toBeCloseTo(5 / 12, 12);
  });

  it("counts character confusion including empty predictions and keeps short sentences legitimate", () => {
    expect(characterConfusionMetrics([1, 2], [{ charIndices: [3] }], [])).toEqual({
      sensitivity: 0,
      specificity: 1,
      balancedAccuracy: 0.5,
      counts: { truePositive: 0, falseNegative: 2, falsePositive: 0, trueNegative: 1 }
    });
    expect(exactSentenceRecall(["Hi."], ["Hi."])).toMatchObject({ recall: 1, matchedSentences: 1 });
  });

  it("recovers sentences that continue across pages without matching unrelated text", () => {
    const actual = [
      { text: "The first sentence continues across", pageIndex: 0 },
      { text: "the page boundary with its final words.", pageIndex: 1 },
      { text: "An unrelated sentence sits between pages.", pageIndex: 1 },
      { text: "A separate complete sentence.", pageIndex: 2 }
    ];
    const expected = [
      { text: "The first sentence continues across the page boundary with its final words.", pageIndex: 0, endPageIndex: 1 },
      { text: "A separate complete sentence.", pageIndex: 2 }
    ];
    expect(recoveredSentenceCount(actual, expected)).toEqual({ recall: 1, matchedSentences: 2, expectedSentences: 2 });
    expect(recoveredSentenceCount([actual[0]], expected).matchedSentences).toBe(0);
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
  it("meets the balanced accuracy target without regressing the reviewed baseline", async () => {
    const baseline = JSON.parse(fs.readFileSync(new URL("./fixtures/pdf-extraction/baseline.json", import.meta.url), "utf8"));
    const current = await evaluateCorpus();
    expect(compareBaseline(current, baseline)).toEqual([]);
    expect(current.totals.balancedAccuracy).toBeGreaterThanOrEqual(0.99);
    expect(current.totals.sentenceSensitivity).toBeGreaterThanOrEqual(0.99);
    expect(current.totals.negativeSpecificity).toBeGreaterThanOrEqual(0.99);
  }, 30000);
});
