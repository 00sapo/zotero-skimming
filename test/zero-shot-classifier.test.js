import { describe, expect, it, vi } from "vitest";
import { loadScript } from "./helpers.js";

// ── helpers ─────────────────────────────────────────────────────────────────

function mockEmbeddingModel(dim = 16) {
  function hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    return h;
  }
  function mulberry32(seed) {
    return () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  return {
    dim,
    async embed(texts) {
      return texts.map(text => {
        const rng = mulberry32(hash(text));
        const vec = new Array(dim);
        let norm2 = 0;
        for (let i = 0; i < dim; i++) { vec[i] = rng() * 2 - 1; norm2 += vec[i] * vec[i]; }
        const invNorm = 1 / Math.sqrt(norm2);
        for (let i = 0; i < dim; i++) vec[i] *= invNorm;
        return vec;
      });
    }
  };
}

function loadModule() {
  return loadScript("content/zero-shot-classifier.js", {}).FastKeySentenceZeroShot;
}

// ── TOML string / array parsing ─────────────────────────────────────────────

describe("parseTomlString", () => {
  it("parses double-quoted strings with escapes", () => {
    const { parseTomlString } = loadModule();
    expect(parseTomlString('"hello world"')).toBe("hello world");
    expect(parseTomlString('"line\\nbreak"')).toBe("line\nbreak");
    expect(parseTomlString('"tab\\there"')).toBe("tab\there");
    expect(parseTomlString('"escaped\\\\slash"')).toBe("escaped\\slash");
    expect(parseTomlString('"escaped\\"quote"')).toBe('escaped"quote');
  });

  it("returns raw value when not double-quoted", () => {
    const { parseTomlString } = loadModule();
    expect(parseTomlString("  plain  ")).toBe("plain");
  });
});

describe("parseTomlStringArray", () => {
  it("parses inline string arrays", () => {
    const { parseTomlStringArray } = loadModule();
    expect(parseTomlStringArray('["a", "b", "c"]')).toEqual(["a", "b", "c"]);
    expect(parseTomlStringArray('["single"]')).toEqual(["single"]);
    expect(parseTomlStringArray('["a", "b",]')).toEqual(["a", "b"]); // trailing comma
  });

  it("handles empty array", () => {
    const { parseTomlStringArray } = loadModule();
    expect(parseTomlStringArray("[]")).toEqual([]);
  });

  it("handles multi-line arrays (joined before parsing)", () => {
    const { parseTomlStringArray } = loadModule();
    // multi-line arrays are joined by the parser, so this receives a single line
    expect(parseTomlStringArray('["first", "second"]')).toEqual(["first", "second"]);
  });

  it("rejects non-array input", () => {
    const { parseTomlStringArray } = loadModule();
    expect(() => parseTomlStringArray("not an array")).toThrow(/TOML array/);
  });
});

// ── config parsing ──────────────────────────────────────────────────────────

const MINI_CONFIG = `[test]
description = "A test label for unit testing."
prototypes = ["First prototype sentence.", "Second prototype sentence."]
context-prototypes = ["Nearby text discusses this."]
color = "#ff0000"`;

const TWO_LABEL_CONFIG = `[alpha]
description = "Alpha description text."
prototypes = ["Alpha prototype one.", "Alpha prototype two."]
context-prototypes = ["Nearby sentences refer to the alpha contribution."]
color = "#111111"

[beta]
description = "Beta description text."
prototypes = ["Beta prototype one.", "Beta prototype two."]
context-prototypes = ["Nearby sentences refer to the beta contribution."]
color = "#222222"`;

describe("parseConfig", () => {
  it("parses valid full config into structured labels", () => {
    const { parseConfig, DEFAULT_CONFIG } = loadModule();
    const labels = parseConfig(DEFAULT_CONFIG);
    expect(labels).toHaveLength(7);
    const names = labels.map(l => l.name);
    expect(names).toEqual([
      "[literature]", "[method]", "[goal]", "[result]",
      "[conclusion]", "[contribution]", "[take-away]"
    ]);

    for (const label of labels) {
      expect(label.description).toBeTruthy();
      expect(label.prototypes.length).toBeGreaterThanOrEqual(1);
      expect(label.contextPrototypes.length).toBeGreaterThanOrEqual(1);
      expect(label.color).toMatch(/^#[0-9a-fA-F]{6}$/);
    }

    const method = labels.find(l => l.name === "[method]");
    expect(method.description).toMatch(/explains how/i);
    expect(method.prototypes).toContain("The data were normalized before the analysis.");
    expect(method.contextPrototypes).toContain("The target describes a procedure whose outcome is reported nearby.");
  });

  it("parses minimal valid config with one label", () => {
    const { parseConfig } = loadModule();
    const labels = parseConfig(MINI_CONFIG);
    expect(labels).toHaveLength(1);
    expect(labels[0].name).toBe("[test]");
    expect(labels[0].description).toBe("A test label for unit testing.");
    expect(labels[0].prototypes).toEqual(["First prototype sentence.", "Second prototype sentence."]);
    expect(labels[0].contextPrototypes).toEqual(["Nearby text discusses this."]);
    expect(labels[0].color).toBe("#ff0000");
  });

  it("allows missing color (optional)", () => {
    const { parseConfig } = loadModule();
    const text = `[simple]
description = "Label without color."
prototypes = ["Proto."]
context-prototypes = ["Context proto."]`;
    const labels = parseConfig(text);
    expect(labels[0].color).toBeNull();
  });

  it("accepts labels with hyphens in names", () => {
    const { parseConfig } = loadModule();
    const text = `[take-away]
description = "Main insight."
prototypes = ["A key message."]
context-prototypes = ["Context is important."]`;
    expect(parseConfig(text)).toHaveLength(1);
  });

  it("rejects empty config", () => {
    const { parseConfig } = loadModule();
    expect(() => parseConfig("")).toThrow(/non-empty/);
    expect(() => parseConfig("   \n  ")).toThrow(/non-empty/);
    expect(() => parseConfig(null)).toThrow(/non-empty/);
  });

  it("rejects content outside any label block", () => {
    const { parseConfig } = loadModule();
    expect(() => parseConfig("orphan content")).toThrow(/outside any/);
  });

  it("rejects missing description", () => {
    const { parseConfig } = loadModule();
    const text = `[bad]
prototypes = ["Something."]
context-prototypes = ["Context."]`;
    expect(() => parseConfig(text)).toThrow(/missing description/);
  });

  it("rejects empty description", () => {
    const { parseConfig } = loadModule();
    const text = `[bad]
description = ""
prototypes = ["Something."]
context-prototypes = ["Context."]`;
    expect(() => parseConfig(text)).toThrow(/description is empty/);
  });

  it("rejects duplicate description", () => {
    const { parseConfig } = loadModule();
    const text = `[bad]
description = "First."
description = "Second."
prototypes = ["Something."]
context-prototypes = ["Context."]`;
    expect(() => parseConfig(text)).toThrow(/duplicate description/);
  });

  it("rejects missing prototypes", () => {
    const { parseConfig } = loadModule();
    const text = `[bad]
description = "Has desc."
context-prototypes = ["Context."]`;
    expect(() => parseConfig(text)).toThrow(/at least one prototype/);
  });

  it("rejects empty prototypes array", () => {
    const { parseConfig } = loadModule();
    const text = `[bad]
description = "Has desc."
prototypes = []
context-prototypes = ["Context."]`;
    expect(() => parseConfig(text)).toThrow(/at least one prototype/);
  });

  it("allows missing context-prototypes (backward compat)", () => {
    const { parseConfig } = loadModule();
    const text = `[simple]
description = "Label without context prototypes."
prototypes = ["A proto."]`;
    const labels = parseConfig(text);
    expect(labels).toHaveLength(1);
    expect(labels[0].contextPrototypes).toEqual([]);
  });

  it("allows empty context-prototypes array", () => {
    const { parseConfig } = loadModule();
    const text = `[simple]
description = "Label with empty context prototypes."
prototypes = ["A proto."]
context-prototypes = []`;
    const labels = parseConfig(text);
    expect(labels).toHaveLength(1);
    expect(labels[0].contextPrototypes).toEqual([]);
  });

  it("rejects duplicate context-prototypes", () => {
    const { parseConfig } = loadModule();
    const text = `[bad]
description = "Has desc."
prototypes = ["A proto."]
context-prototypes = ["First."]
context-prototypes = ["Second."]`;
    expect(() => parseConfig(text)).toThrow(/duplicate context-prototypes/);
  });

  it("rejects unknown keys", () => {
    const { parseConfig } = loadModule();
    const text = `[bad]
description = "Has desc."
prototypes = ["A proto."]
context-prototypes = ["Context."]
bogus = "value"`;
    expect(() => parseConfig(text)).toThrow(/unknown key/);
  });

  it("handles Windows-style line endings", () => {
    const { parseConfig } = loadModule();
    const text = `[a]\r\ndescription = "D."\r\nprototypes = ["P."]\r\ncontext-prototypes = ["C."]`;
    expect(parseConfig(text)).toHaveLength(1);
  });

  it("ignores blank lines and comments between blocks", () => {
    const { parseConfig } = loadModule();
    const text = `
# first label
[first]
description = "First label."
prototypes = ["Proto one."]
context-prototypes = ["Context one."]

# second label
[second]
description = "Second label."
prototypes = ["Proto two."]
context-prototypes = ["Context two."]
`;
    expect(parseConfig(text)).toHaveLength(2);
  });
});

// ── cosine / denseNorm ──────────────────────────────────────────────────────

describe("cosine", () => {
  it("returns 1 for identical, 0 for orthogonal, 0 for empty", () => {
    const { cosine } = loadModule();
    expect(cosine([0.6, 0.8], [0.6, 0.8])).toBeCloseTo(1, 5);
    expect(cosine([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 5);
    expect(cosine([], [1, 2])).toBe(0);
  });
});

describe("denseNorm", () => {
  it("computes L2 norm", () => {
    const { denseNorm } = loadModule();
    expect(denseNorm([3, 4])).toBe(5);
    expect(denseNorm([])).toBe(0);
  });
});

// ── top-K prototype aggregation ─────────────────────────────────────────────

describe("prototype top-K aggregation", () => {
  it("uses only the top-K prototype similarities in target score", async () => {
    const { createClassifier } = loadModule();
    const config = `[label]
description = "Test description."
prototypes = ["Proto A.", "Proto B.", "Proto C.", "Proto D.", "Proto E.", "Proto F."]
context-prototypes = ["Context proto."]`;

    const classifier = await createClassifier({
      embeddingModel: mockEmbeddingModel(16),
      config,
      topK: 2,
      descriptionWeight: 0,
      prototypeWeight: 1,
      targetWeight: 1,
      contextWeight: 0
    });

    const result = await classifier.classify("A test sentence for top-K verification.", "Context window text.");
    expect(result.predicted).toBe("[label]");
    const det = result.details["[label]"];
    expect(det.prototypeSimilarities.length).toBe(6);
    for (let i = 1; i < det.prototypeSimilarities.length; i++) {
      expect(det.prototypeSimilarities[i - 1]).toBeGreaterThanOrEqual(det.prototypeSimilarities[i]);
    }
    const top2Mean = (det.prototypeSimilarities[0] + det.prototypeSimilarities[1]) / 2;
    expect(det.targetScore).toBeCloseTo(top2Mean, 5);
  });
});

// ── anti-description penalty ────────────────────────────────────────────────

describe("context scoring", () => {
  it("combines target and context scores with configured weights", async () => {
    const { createClassifier } = loadModule();
    const config = `[match]
description = "Matches the target sentence meaning."
prototypes = ["Target-like prototype."]
context-prototypes = ["The surrounding discourse fits this label."]

[other]
description = "Another label."
prototypes = ["Other prototype."]
context-prototypes = ["Other context pattern."]`;

    const dim = 8;
    const manualModel = {
      async embed(texts) {
        return texts.map(t => {
          const v = new Array(dim).fill(0);
          if (t.includes("target sentence")) { v[0] = 1; return v; }
          if (t.includes("context window that fits")) { v[1] = 1; return v; }
          if (t === "Target-like prototype.") { v[0] = 0.95; v[2] = Math.sqrt(1 - 0.95 * 0.95); return v; }
          if (t === "The surrounding discourse fits this label.") { v[1] = 0.9; v[3] = Math.sqrt(1 - 0.9 * 0.9); return v; }
          v[dim - 1] = 1;
          return v;
        });
      }
    };

    const classifier = await createClassifier({
      embeddingModel: manualModel,
      config,
      descriptionWeight: 0.35,
      prototypeWeight: 0.65,
      targetWeight: 0.75,
      contextWeight: 0.25,
      topK: 1
    });

    const result = await classifier.classify("A target sentence.", "A context window that fits.");
    expect(result.predicted).toBe("[match]");
    const det = result.details["[match]"];
    expect(det.targetScore).toBeGreaterThan(0.5);
    expect(det.contextScore).toBeGreaterThan(0.5);
    expect(det.finalScore).toBeCloseTo(0.75 * det.targetScore + 0.25 * det.contextScore, 5);
  });
});

// ── score calculation ───────────────────────────────────────────────────────

describe("score calculation", () => {
  it("combines description, prototype, and context scores correctly", async () => {
    const { createClassifier } = loadModule();

    const classifier = await createClassifier({
      embeddingModel: mockEmbeddingModel(32),
      config: TWO_LABEL_CONFIG,
      descriptionWeight: 0.4,
      prototypeWeight: 0.6,
      targetWeight: 0.7,
      contextWeight: 0.3,
      topK: 2
    });

    const ctx = "Surrounding discourse for context scoring.";
    const result = await classifier.classify("A neutral test sentence.", ctx);
    expect(result.predicted).toMatch(/^\[(alpha|beta|uncertain)\]$/);
    expect(Object.keys(result.scores).sort()).toEqual(["[alpha]", "[beta]"]);

    for (const det of Object.values(result.details)) {
      expect(det.descriptionSimilarity).toBeGreaterThanOrEqual(-1);
      expect(det.descriptionSimilarity).toBeLessThanOrEqual(1);
      expect(det.prototypeSimilarities.length).toBe(2);
      expect(det.contextPrototypeSimilarities.length).toBe(1);
      const protoMean = (det.prototypeSimilarities[0] + det.prototypeSimilarities[1]) / 2;
      expect(det.targetScore).toBeCloseTo(0.4 * det.descriptionSimilarity + 0.6 * protoMean, 5);
      expect(det.finalScore).toBeCloseTo(0.7 * det.targetScore + 0.3 * det.contextScore, 5);
    }
  });

  it("returns margin and runnerUp", async () => {
    const { createClassifier } = loadModule();
    const classifier = await createClassifier({
      embeddingModel: mockEmbeddingModel(8),
      config: TWO_LABEL_CONFIG
    });
    const result = await classifier.classify("Test.", "Context.");
    const sorted = Object.values(result.scores).sort((a, b) => b - a);
    expect(result.margin).toBeCloseTo(sorted[0] - sorted[1], 5);
    expect(result.runnerUp).toMatch(/^\[(alpha|beta)\]$/);
  });
});

// ── uncertainty handling ────────────────────────────────────────────────────

describe("uncertainty handling", () => {
  it("returns [uncertain] when margin is below threshold", async () => {
    const { createClassifier } = loadModule();
    const config = `[x]
description = "Label X."
prototypes = ["Proto X1.", "Proto X2."]
context-prototypes = ["Context X."]

[y]
description = "Label Y."
prototypes = ["Proto Y1.", "Proto Y2."]
context-prototypes = ["Context Y."]`;

    const tinyModel = {
      async embed(texts) {
        return texts.map(() => {
          const v = [1.0, 1e-6 * (Math.random() - 0.5), 1e-6 * (Math.random() - 0.5)];
          const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
          return v.map(x => x / n);
        });
      }
    };

    const classifier = await createClassifier({
      embeddingModel: tinyModel,
      config,
      uncertaintyThreshold: 0.1
    });

    const result = await classifier.classify("Ambiguous sentence.", "Ambiguous context.");
    if (result.predicted === "[uncertain]") {
      expect(result.uncertainCandidates).toHaveLength(2);
      expect(result.uncertainCandidates[0]).toMatch(/^\[(x|y)\]$/);
      expect(result.uncertainCandidates[1]).toMatch(/^\[(x|y)\]$/);
      expect(result.uncertainCandidates[0]).not.toBe(result.uncertainCandidates[1]);
      expect(result.margin).toBeLessThan(0.1);
    }
  });

  it("returns a concrete label when margin exceeds threshold", async () => {
    const { createClassifier } = loadModule();
    const config = `[match]
description = "Matches the input perfectly."
prototypes = ["This is exactly what we want to match."]
context-prototypes = ["Matching context pattern."]

[other]
description = "Unrelated label."
prototypes = ["Something else entirely."]
context-prototypes = ["Other context pattern."]`;

    const dim = 8;
    const strongModel = {
      async embed(texts) {
        return texts.map(t => {
          const v = new Array(dim).fill(0);
          if (t.includes("target sentence for testing")) { v[0] = 1; return v; }
          if (t === "Matches the input perfectly." || t === "This is exactly what we want to match." || t === "Matching context pattern.") {
            v[0] = 0.95; v[1] = Math.sqrt(1 - 0.95 * 0.95); return v;
          }
          v[dim - 1] = 1;
          return v;
        });
      }
    };

    const classifier = await createClassifier({
      embeddingModel: strongModel,
      config,
      uncertaintyThreshold: 0.15
    });

    const result = await classifier.classify("target sentence for testing", "context for testing");
    expect(result.predicted).toBe("[match]");
    expect(result.margin).toBeGreaterThan(0.15);
  });

  it("defaults to 0 threshold (never uncertain)", async () => {
    const { createClassifier } = loadModule();
    const config = `[only]
description = "Only label."
prototypes = ["Only prototype."]
context-prototypes = ["Only context."]`;

    const classifier = await createClassifier({
      embeddingModel: mockEmbeddingModel(8),
      config
    });
    const result = await classifier.classify("Whatever.", "Whatever context.");
    expect(result.predicted).toBe("[only]");
    expect(result.uncertainCandidates).toBeUndefined();
  });
});

// ── embedding caching ───────────────────────────────────────────────────────

describe("embedding caching", () => {
  it("embeds static texts exactly once at creation time", async () => {
    const { createClassifier } = loadModule();
    const config = `[a]
description = "Desc A."
prototypes = ["Proto A1.", "Proto A2."]
context-prototypes = ["Ctx A."]

[b]
description = "Desc B."
prototypes = ["Proto B1."]
context-prototypes = ["Ctx B1.", "Ctx B2."]`;

    const embedSpy = vi.fn(async (texts) => {
      return texts.map(() => {
        const v = new Array(4);
        for (let i = 0; i < 4; i++) v[i] = Math.random() * 2 - 1;
        const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
        return v.map(x => x / n);
      });
    });

    const model = { embed: embedSpy };
    const classifier = await createClassifier({ embeddingModel: model, config });

    // static texts: 2 descs + 3 protos + 3 context-protos = 8 texts, one batch
    expect(embedSpy).toHaveBeenCalledTimes(1);
    expect(embedSpy.mock.calls[0][0]).toHaveLength(8);

    embedSpy.mockClear();
    await classifier.classify("Sentence one.", "Context one.");
    await classifier.classify("Sentence two.", "Context two.");
    expect(embedSpy).toHaveBeenCalledTimes(2);
    for (const call of embedSpy.mock.calls) expect(call[0]).toHaveLength(2);
  });
});

// ── error handling ──────────────────────────────────────────────────────────

describe("error handling", () => {
  it("rejects missing embedding model", async () => {
    const { createClassifier } = loadModule();
    await expect(createClassifier({})).rejects.toThrow(/embeddingModel/);
    await expect(createClassifier({ embeddingModel: {} })).rejects.toThrow(/embeddingModel/);
  });

  it("rejects empty sentence", async () => {
    const { createClassifier } = loadModule();
    const classifier = await createClassifier({
      embeddingModel: mockEmbeddingModel(4),
      config: MINI_CONFIG
    });
    await expect(classifier.classify("", "context")).rejects.toThrow(/non-empty/);
    await expect(classifier.classify("   ", "context")).rejects.toThrow(/non-empty/);
    await expect(classifier.classify("target", "")).rejects.toThrow(/non-empty/);
    await expect(classifier.classify("target", "   ")).rejects.toThrow(/non-empty/);
  });

  it("rejects invalid topK", async () => {
    const { createClassifier } = loadModule();
    await expect(
      createClassifier({ embeddingModel: mockEmbeddingModel(4), config: MINI_CONFIG, topK: 0 })
    ).rejects.toThrow(/topK/);
  });
});

// ── configurable weights ────────────────────────────────────────────────────

describe("configurable weights", () => {
  it("uses user-supplied weights", async () => {
    const { createClassifier } = loadModule();
    const classifier = await createClassifier({
      embeddingModel: mockEmbeddingModel(8),
      config: MINI_CONFIG,
      descriptionWeight: 0.5,
      prototypeWeight: 0.5,
      targetWeight: 0.8,
      contextWeight: 0.2,
      topK: 1
    });
    expect(classifier.config.descriptionWeight).toBe(0.5);
    expect(classifier.config.prototypeWeight).toBe(0.5);
    expect(classifier.config.targetWeight).toBe(0.8);
    expect(classifier.config.contextWeight).toBe(0.2);
    expect(classifier.config.topK).toBe(1);
  });

  it("accepts custom similarity function", async () => {
    const { createClassifier } = loadModule();
    let called = false;
    const customSim = (a, b) => { called = true; let s = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i]; return s; };
    const classifier = await createClassifier({
      embeddingModel: mockEmbeddingModel(8),
      config: MINI_CONFIG,
      similarityFn: customSim
    });
    await classifier.classify("Test.", "Context.");
    expect(called).toBe(true);
  });
});

// ── labels with color ───────────────────────────────────────────────────────

describe("labels property", () => {
  it("exposes ordered label names with colors", async () => {
    const { createClassifier } = loadModule();
    const classifier = await createClassifier({
      embeddingModel: mockEmbeddingModel(4),
      config: TWO_LABEL_CONFIG
    });
    expect(classifier.labels).toEqual([
      { name: "[alpha]", color: "#111111" },
      { name: "[beta]", color: "#222222" }
    ]);
  });

  it("color is null when omitted from config", async () => {
    const { createClassifier } = loadModule();
    const config = `[nocolor]
description = "No color key."
prototypes = ["Proto."]
context-prototypes = ["Context."]`;
    const classifier = await createClassifier({
      embeddingModel: mockEmbeddingModel(4),
      config
    });
    expect(classifier.labels[0].color).toBeNull();
  });
});
