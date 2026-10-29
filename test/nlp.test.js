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

function vectorNorm(vector) {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

function nlp(models) {
  const ctx = {};
  if (models) ctx.FastKeySentenceModels = models;
  ctx.FastKeySentenceRemote = models?.remote || null;
  ctx.FastKeySentenceSummaryLabels = {
    DEFAULT_CONFIG: "# config",
    parseConfig(text) {
      const labels = [];
      const labelRe = /^\[([a-z][a-z0-9-]*)\]$/im;
      const descRe = /^description\s*=\s*"(.+)"$/im;
      const m = labelRe.exec(text);
      if (m) {
        const desc = descRe.exec(text);
        labels.push({ name: `[${m[1]}]`, description: desc ? desc[1] : "", color: m[1] === "method" ? "#112233" : "#445566" });
      }
      if (!labels.length) {
        // fallback: produce dummy labels so tag classification runs
        ["literature", "method", "goal", "result", "conclusion", "contribution", "take-away"].forEach(name =>
          labels.push({ name: `[${name}]`, description: `${name} description`, color: null })
        );
      }
      return labels;
    }
  };
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
    expect(api.roleFor).toBeUndefined();
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
    expect(selected.every(item => item.importance >= 0 && item.role === undefined)).toBe(true);
  });
  it("aligns the selected sequence with the summary order", () => {
    const api = nlp();
    const input = [
      { ...sentence("Alpha introduction.", 0), position: 0 },
      { ...sentence("Background detail.", 1), position: 0.2 },
      { ...sentence("Supporting context.", 2), position: 0.4 },
      { ...sentence("Beta result.", 3), position: 0.6 },
      { ...sentence("Gamma conclusion.", 4), position: 0.8 },
      { ...sentence("Alpha conclusion.", 5), position: 1 }
    ];
    const vectors = [
      [0.9, 0.1, 0, 0],
      [0.1, 0, 0.9, 0],
      [0.1, 0.9, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 0, 1],
      [1, 0, 0, 0]
    ];
    const summaryParts = [
      { vector: [1, 0, 0, 0], norm: 1, text: "Alpha." },
      { vector: [0, 1, 0, 0], norm: 1, text: "Beta." },
      { vector: [0, 0, 0, 1], norm: 1, text: "Gamma." }
    ];
    const selected = api.selectSequence(input, vectors, vectors.map(vectorNorm), 3, summaryParts);
    expect(selected.map(item => item.order)).toEqual([0, 3, 4]);
  });

  it("skips summary sentences when the highlight budget is smaller", () => {
    const api = nlp();
    const input = [
      { ...sentence("Alpha early.", 0), position: 0 },
      { ...sentence("Beta middle.", 1), position: 0.5 },
      { ...sentence("Gamma late.", 2), position: 1 }
    ];
    const vectors = [
      [0.8, 0.6, 0],
      [0, 1, 0],
      [0, 0.6, 0.8]
    ];
    const summaryParts = [
      { vector: [0, 1, 0], norm: 1, text: "Beta." },
      { vector: [1, 0, 0], norm: 1, text: "Alpha." },
      { vector: [0, 0, 1], norm: 1, text: "Gamma." }
    ];
    const selected = api.selectSequence(input, vectors, vectors.map(vectorNorm), 1, summaryParts);
    expect(selected.map(item => item.order)).toEqual([1]);
  });

  it("skips unmatched summary sentences while preserving sequence order", () => {
    const api = nlp();
    const input = [0, 1, 2, 3].map(index => ({
      ...sentence(`Sentence ${index} with enough words to pass noise.`, index),
      position: index / 3
    }));
    const vectors = [
      [1, 0, 0],
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, 1]
    ];
    const summaryParts = [
      { vector: [0, 0, 0], norm: 0, text: "Unmatched first." },
      { vector: [0, 1, 0], norm: 1, text: "Matched second." },
      { vector: [0, 0, 0], norm: 0, text: "Unmatched third." },
      { vector: [0, 0, 1], norm: 1, text: "Matched fourth." }
    ];
    const selected = api.selectSequence(input, vectors, vectors.map(vectorNorm), 2, summaryParts);
    expect(selected.map(item => item.order)).toEqual([1, 3]);
  });

  it("uses position to spread matches across the paper", () => {
    const api = nlp();
    const input = [
      { ...sentence("Alpha early.", 0), position: 0 },
      { ...sentence("Beta middle.", 1), position: 0.5 },
      { ...sentence("Alpha late.", 2), position: 0.9 },
      { ...sentence("Beta late.", 3), position: 0.95 },
      { ...sentence("Gamma late.", 4), position: 1 }
    ];
    const vectors = [
      [0.99, 0.141, 0],
      [0, 1, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1]
    ];
    const summaryParts = [
      { vector: [1, 0, 0], norm: 1, text: "Alpha." },
      { vector: [0, 1, 0], norm: 1, text: "Beta." },
      { vector: [0, 0, 1], norm: 1, text: "Gamma." }
    ];
    const selected = api.selectSequence(input, vectors, vectors.map(vectorNorm), 3, summaryParts);
    expect(selected.map(item => item.order)).toEqual([0, 1, 4]);
  });

  it("runs the sequence selector through the asynchronous pipeline", async () => {
    const embed = vi.fn(async texts => texts.map(raw => {
      const text = String(raw).toLowerCase();
      if (text.includes("alpha concept") && text.includes("beta concept")) return [1, 1, 1];
      if (text.includes("alpha")) return [1, 0, 0];
      if (text.includes("beta")) return [0, 1, 0];
      if (text.includes("gamma")) return [0, 0, 1];
      return [1, -1, 0];
    }));
    const input = [
      sentence("Alpha introduction explains the main goal.", 0),
      sentence("Background detail provides supporting context here.", 1),
      sentence("Supporting context describes the broader setting.", 2),
      sentence("Beta result reports the measured outcome.", 3),
      sentence("Gamma conclusion summarizes the final takeaway.", 4),
      sentence("Alpha conclusion restates the main goal.", 5)
    ];
    const selected = await nlp({
      supportsInference: () => true,
      summarize: async () => "Alpha concept. Beta concept. Gamma concept.",
      embeddings: embed
    }).analyzeAsync(input, 3, { summarySource: "local", localRelevance: true });
    expect(selected.filter(item => item._selected).map(item => item.order)).toEqual([0, 3, 4]);
    expect(selected.filter(item => item._selected).every(item => item.importance === 1)).toBe(true);
    expect(selected.filter(item => !item._selected).every(item => item.importance <= 0.5)).toBe(true);
    expect(embed).toHaveBeenCalledTimes(2);
  });

  it("keeps section coverage when the candidate list exceeds the shortlist", async () => {
    const api = nlp();
    const input = Array.from({ length: 120 }, (_, order) => {
      const section = order < 100 ? "methods" : order < 110 ? "results" : "discussion";
      return sentence(`We present a detailed approach for concept${order} that improves analysis across several practical research settings.`, order, section);
    });
    const selected = await api.analyzeAsync(input, 20, { summarySource: "local" });
    expect(selected).toHaveLength(120);
    expect(new Set(selected.map(item => item.section))).toEqual(new Set(["methods", "results", "discussion"]));
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

  it("uses the model-free baseline when model features are disabled", async () => {
    const summarize = vi.fn(async () => "A paper synopsis.");
    const embeddings = vi.fn(async texts => texts.map(() => [1, 0]));
    const selected = await nlp({
      supportsInference: () => true,
      summarize,
      embeddings
    }).analyzeAsync(prose.map((text, order) => sentence(text, order)), 3, { summarySource: "local" });
    expect(selected).toHaveLength(prose.length);
    expect(summarize).not.toHaveBeenCalled();
    expect(embeddings).not.toHaveBeenCalled();
    expect(selected.every(item => item.tag === undefined && item._paperSummary === "")).toBe(true);
    expect(selected.every(item => item.importance >= 0 && item.importance <= 1)).toBe(true);
  });

  it("assigns labels from the closest summary sentence when enabled", async () => {
    const embeddings = vi.fn(async texts => texts.map(text => {
      if (String(text).includes("method")) return [10, 0];
      if (String(text).includes("result")) return [0, 10];
      return [1, 1];
    }));
    const selected = await nlp({
      supportsInference: () => true,
      summarize: async () => "1. [method] A concise method sentence. 2. [result] A concise result sentence.",
      embeddings
    }).analyzeAsync(prose.map((text, order) => sentence(text, order)), 2, {
      summarySource: "local",
      summaryLabels: true,
      summaryLabelConfigV2: `[method]\ndescription = "Explains how the current study was carried out."\n\n[result]\ndescription = "Reports evidence or outcomes."`
    });
    expect(embeddings).toHaveBeenCalledOnce();
    expect(selected.every(item => item.tag === "method" || item.tag === "result")).toBe(true);
    expect(selected.every(item => !item._paperSummary.includes("[") && !item._paperSummary.match(/\d+\./))).toBe(true);
    expect(selected.every(item => [0, 1].includes(item.tagIndex))).toBe(true);
    expect(selected.every(item => ["#112233", "#445566"].includes(item.tagColor))).toBe(true);
  });

  it("classifies from label descriptions when the summary omits labels", async () => {
    const embeddings = vi.fn(async texts => texts.map(text => String(text).includes("carried out") ? [10, 0] : [9, 1]));
    const selected = await nlp({
      supportsInference: () => true,
      summarize: async () => "1. A plain summary sentence without a label.",
      embeddings
    }).analyzeAsync(prose.map((text, order) => sentence(text, order)), 2, {
      summarySource: "local",
      summaryLabels: true,
      summaryLabelConfigV2: `[method]\ndescription = "Explains how the current study was carried out."`
    });
    expect(selected.every(item => item.tag === "method")).toBe(true);
    expect(selected.every(item => item.tagColor === "#112233")).toBe(true);
  });

  it("parses line-delimited and collapsed labeled summaries", () => {
    const api = nlp();
    const labels = [{ name: "[method]" }, { name: "[result]" }];
    expect(api.parseLabeledSummary("1. [method] A concise method.\n2. [result] A concise result.", labels)).toEqual([
      { label: "[method]", sentence: "A concise method." },
      { label: "[result]", sentence: "A concise result." }
    ]);
    expect(api.parseLabeledSummary("1. [method] A concise method. 2. [result] A concise result.", labels)).toEqual([
      { label: "[method]", sentence: "A concise method." },
      { label: "[result]", sentence: "A concise result." }
    ]);
    expect(api.parseLabeledSummary("1. [unknown] Ignore this.", labels)).toEqual([]);
  });

  it("builds summary input from body prose only", () => {
    const api = nlp();
    const paperText = api.paperTextForSummary([
      { ...sentence("Title and metadata.", 0, "title"), frontMatter: true },
      sentence("Abstract claim.", 1, "abstract"),
      sentence("Body result one.", 2, "results"),
      sentence("Body result two.", 3, "results")
    ]);
    expect(paperText).toBe("Body result one. Body result two.");
  });

  it("scores sentences via dense summary relevance and relays progress", async () => {
    const progress = vi.fn();
    const embeddings = vi.fn(async texts => texts.map((_, index) => [index + 1, 1]));
    const models = {
      supportsInference: () => true,
      remote: { summarize: vi.fn(async (_text, _title, _count, callback) => { callback({ stage: "sending" }); return "A compact paper synopsis."; }) },
      embeddings
    };
    const selected = await nlp(models).analyzeAsync(prose.map((text, order) => sentence(text, order, order < 2 ? "abstract" : "results")), 3, {
      summarySource: "remote",
      localRelevance: true, documentTitle: "A study", onModelProgress: progress, summaryLabels: true
    });
    expect(selected.length).toBeGreaterThanOrEqual(1);
    expect(models.remote.summarize).toHaveBeenCalledWith(expect.any(String), "A study", 3, expect.any(Function), expect.any(Array));
    expect(embeddings).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenCalled();
  });

  it("uses local Qwen summarization without contacting the remote API", async () => {
    const summarize = vi.fn(async () => "A local paper synopsis.");
    const remote = { summarize: vi.fn() };
    const embeddings = vi.fn(async texts => texts.map(() => [0.5, 0.5]));
    const selected = await nlp({ supportsInference: () => true, summarize, embeddings, remote }).analyzeAsync(
      prose.map((text, order) => sentence(text, order)), 2, { summarySource: "local", localRelevance: true, summaryLabels: true }
    );
    expect(summarize).toHaveBeenCalledOnce();
    expect(remote.summarize).not.toHaveBeenCalled();
    expect(selected.every(item => item._paperSummary === "A local paper synopsis.")).toBe(true);
  });

  it("falls back to baseline ranking after local Qwen summarization fails", async () => {
    const progress = vi.fn();
    const selected = await nlp({ supportsInference: () => true, summarize: async () => { throw new Error("model unavailable"); }, remote: { summarize: vi.fn() } }).analyzeAsync(
      prose.map((text, order) => sentence(text, order)), 2, { summarySource: "local", localRelevance: true, onModelProgress: progress }
    );
    expect(selected).toHaveLength(prose.length);
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ stage: "unavailable", operation: "summarization" }));
  });

  it("falls back cleanly when local Ollama relevance is unavailable", async () => {
    const unavailable = nlp({ supportsInference: () => false, remote: { summarize: async () => "A synopsis." } });
    const progress = vi.fn();
    await expect(unavailable.analyzeAsync(prose.map((text, order) => sentence(text, order)), 2, { localRelevance: true, onModelProgress: progress })).resolves.toHaveLength(prose.length);
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ stage: "unavailable" }));
  });

  it("rejects requested local relevance when the model manager is absent", async () => {
    await expect(nlp().analyzeAsync(prose.map((text, order) => sentence(text, order)), 1, { localRelevance: true })).rejects.toThrow("not loaded");
  });
});
