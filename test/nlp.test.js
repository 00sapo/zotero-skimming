import { describe, expect, it, vi } from "vitest";
import { loadScript, sentence } from "./helpers.js";

const prose = [
  "We propose a robust method that improves accuracy by 12% on benchmark tasks.",
  "The results demonstrate substantial improvements over existing approaches.",
  "Our objective is to evaluate the framework under realistic conditions.",
  "However, the method has limitations on very small datasets.",
  "Future work could extend the approach to multilingual corpora.",
  "The dataset contains samples collected from three independent sites.",
  "This paragraph provides supporting context for the experimental design.",
  "We conclude that the proposed pipeline is effective and reliable."
];

function nlp(models) {
  const ctx = {};
  if (models) ctx.FastKeySentenceModels = models;
  ctx.FastKeySentenceRemote = models?.remote || null;
  return loadScript("content/nlp.js", ctx).FastKeySentenceNLP;
}

describe("FastKeySentenceNLP", () => {
  it("normalizes text, splits sentences, and identifies headings and references", () => {
    const api = nlp();
    expect(api.normalizeText("ﬁrst soft\u00adware —  spaced")).toBe("first software — spaced");
    expect(api.sentenceRanges("Dr. Smith wrote this. Results show improvement! e.g. this remains.")).toEqual([[0, 21], [22, 66]]);
    expect(api.detectHeading("2.3 Related Work")).toBe("related work");
    expect(api.detectHeading("ALL UPPERCASE HEADING")).toBeNull();
    expect(api.detectHeading("this is a full sentence with ordinary lowercase prose.")).toBeNull();
    expect(api.isReferenceHeading("Bibliography")).toBe(true);
    expect(api.isReferenceEntry("[4] Smith, J., 2021. Proceedings of the Conference. doi:10.1/x")).toBe(true);
    expect(api.isReferenceEntry("This is ordinary research prose without a citation.")).toBe(false);
    expect(api.roleFor(prose[0])).toBe("contribution");
    expect(api.roleFor("unmarked background prose")).toBe("background");
  });

  it("covers sentence boundaries, heading variants, and reference forms", () => {
    const api = nlp();
    expect(api.normalizeText("ﬀ ﬁ ﬂ ﬃ ﬄ A- word ‘x’ “y”")).toBe("ff fi fl ffi ffl Aword 'x' \"y\"");
    expect(api.sentenceRanges("No terminator")).toEqual([[0, 13]]);
    expect(api.sentenceRanges("One. lower tail")).toEqual([[0, 15]]);
    expect(api.sentenceRanges("One.\" Next? [Two!] 3rd.")).toEqual([[0, 4], [6, 11], [12, 17], [19, 23]]);
    expect(api.detectHeading("")).toBeNull();
    expect(api.detectHeading("x".repeat(91))).toBeNull();
    expect(api.detectHeading("Results")).toBe("results");
    expect(api.detectHeading("Overview")).toBeNull();
    expect(api.detectHeading("2 Bad Heading:")).toBeNull();
    expect(api.detectHeading("2 this has far too many ordinary lowercase words to qualify as a heading here")).toBeNull();
    expect(api.detectHeading("2 1234")).toBeNull();
    expect(api.detectHeading("2 and the")).toBeNull();
    expect(api.detectHeading("2 Related Methods.")).toBe("related methods");
    expect(api.isReferenceEntry("")).toBe(false);
    expect(api.isReferenceEntry("Smith, J., A., 2020. A paper")).toBe(true);
    expect(api.isReferenceEntry("2. A reference 2020")).toBe(true);
    expect(api.isReferenceEntry("https://example.test/paper")).toBe(true);
    expect(api.isReferenceEntry("Smith and Jones (2020) wrote this")).toBe(true);
    expect(api.isReferenceEntry("A journal proceedings paper from 2020")).toBe(true);
  });

  it("filters noise and selects salient prose with the baseline ranker", () => {
    const api = nlp();
    const input = prose.map((text, order) => sentence(text, order)).concat([
      sentence("References", 8, "references"),
      sentence("[1] Smith, J., 2020. Journal pp. 1-4.", 9),
      sentence("Table 1 2 3 4 5 6 7 8 9", 10)
    ]);
    const selected = api.analyze(input, 4);
    expect(selected).toHaveLength(4);
    expect(selected).toEqual([...selected].sort((a, b) => a.order - b.order));
    expect(selected.every(item => item.importance >= 0 && item.role)).toBe(true);
    expect(selected.some(item => item.role !== "background")).toBe(true);
  });

  it("exercises noise filters while retaining prose", () => {
    const api = nlp();
    const noise = [
      sentence("Author contributions: these words are long enough to be treated as administrative material.", 1),
      sentence("References", 2, "references"), { ...sentence("One two three four five six seven.", 3), frontMatter: true },
      { ...sentence("One two three four five six seven eight.", 3), inTable: true },
      { ...sentence("One two three four five six seven eight.", 3), reference: true },
      sentence("123456789 123456789 this contains enough words for numerical filtering now.", 4),
      sentence("Figure 4 depicts a sufficiently detailed experimental result for filtering purposes.", 5),
      sentence("1 2 3 4 5 values without any ordinary prose predicate whatsoever today.", 6),
      sentence("[1] Smith A useful article published in 2020 with enough text here.", 7),
      sentence("This source has doi:10.1000/example and enough ordinary words to exclude it now.", 8),
      sentence("Contact author@example.test for sufficient additional details about this study today.", 9),
      sentence("© Copyright statement with enough additional words to satisfy the length requirement today.", 10),
      sentence("Smith, Jones, Brown, Taylor, Wilson, Garcia, Miller, Davis", 11)
    ];
    const kept = sentence("We propose a reliable approach that improves outcomes across several realistic experiments.", 12);
    expect(api.analyze([...noise, kept], 20)).toContainEqual(expect.objectContaining({ order: 12 }));
    expect(api.analyze([], 1)).toEqual([]);
    expect(api.analyze([sentence("Short prose.", 13), sentence("123 Smith wrote enough ordinary prose in 2020 without citation terms here today.", 14, "")], 2)).toEqual([]);
  });

  it("scores structural sections and an empty asynchronous input", async () => {
    const api = nlp();
    const input = [
      { ...sentence(prose[0], 0, "abstract"), sectionStart: true },
      sentence(prose[1], 1, "methods"),
      sentence(prose[2], 2, "architecture")
    ];
    expect(api.analyze(input, 2)).toHaveLength(2);
    await expect(api.analyzeAsync([], 2)).resolves.toEqual([]);
  });

  it("handles partial model classification results", async () => {
    const models = {
      supportsInference: () => true,
      remote: { summarize: async () => "A compact paper synopsis." },
      classify: async () => [{ role: "unknown", score: 0 }]
    };
    const selected = await nlp(models).analyzeAsync(prose.map((text, order) => sentence(text, order)), 3, {
      llmClassification: true
    });
    expect(selected.length).toBeGreaterThanOrEqual(1);
  });

  it("uses local models and relays progress", async () => {
    const progress = vi.fn();
    const classify = vi.fn(async () => [{ role: "result", score: 0.9 }]);
    const models = {
      supportsInference: () => true,
      remote: { summarize: vi.fn(async (_text, _title, _count, callback) => { callback({ stage: "sending" }); callback({ stage: "done" }); return "A compact paper synopsis."; }) },
      embeddings: async () => prose.map((_, i) => [i + 1, 1]),
      classify
    };
    const selected = await nlp(models).analyzeAsync(prose.map((text, order) => sentence(text, order, order < 2 ? "abstract" : "results")), 3, {
      llmEmbeddings: true, llmClassification: true, classificationBatchSize: 12, multilingual: true, documentTitle: "A study", onModelProgress: progress
    });
    expect(selected.length).toBeGreaterThanOrEqual(1);
    expect(models.remote.summarize).toHaveBeenCalledWith(expect.stringContaining("A study"), "A study", 3, expect.any(Function));
    expect(classify).toHaveBeenCalled();
    expect(progress).toHaveBeenCalled();
  });

  it("falls back cleanly when local models are unavailable", async () => {
    const unavailable = nlp({ supportsInference: () => false, remote: { summarize: async () => "A synopsis." } });
    const progress = vi.fn();
    await expect(unavailable.analyzeAsync(prose.map((text, order) => sentence(text, order)), 2, { llmEmbeddings: true, onModelProgress: progress })).resolves.toHaveLength(2);
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ stage: "unavailable" }));
  });

  it("rejects requested models when the remote module is absent", async () => {
    await expect(nlp().analyzeAsync(prose.map((text, order) => sentence(text, order)), 1, { llmEmbeddings: true })).rejects.toThrow("not loaded");
  });
});
