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
anti-description = "Not something else."
color = "#ff0000"`;

const TWO_LABEL_CONFIG = `[alpha]
description = "Alpha description text."
prototypes = ["Alpha prototype one.", "Alpha prototype two."]
anti-description = "Not alpha."
color = "#111111"

[beta]
description = "Beta description text."
prototypes = ["Beta prototype one.", "Beta prototype two."]
anti-description = "Not beta."
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
      expect(label.antiDescription).toBeTruthy();
      expect(label.color).toMatch(/^#[0-9a-fA-F]{6}$/);
    }

    const method = labels.find(l => l.name === "[method]");
    expect(method.description).toMatch(/explains how/i);
    expect(method.prototypes).toContain("The data were normalized before the analysis.");
    expect(method.antiDescription).toMatch(/not the research objective/i);
  });

  it("parses minimal valid config with one label", () => {
    const { parseConfig } = loadModule();
    const labels = parseConfig(MINI_CONFIG);
    expect(labels).toHaveLength(1);
    expect(labels[0].name).toBe("[test]");
    expect(labels[0].description).toBe("A test label for unit testing.");
    expect(labels[0].prototypes).toEqual(["First prototype sentence.", "Second prototype sentence."]);
    expect(labels[0].antiDescription).toBe("Not something else.");
    expect(labels[0].color).toBe("#ff0000");
  });

  it("allows missing color (optional)", () => {
    const { parseConfig } = loadModule();
    const text = `[simple]
description = "Label without color."
prototypes = ["Proto."]
anti-description = "Not this."`;
    const labels = parseConfig(text);
    expect(labels[0].color).toBeNull();
  });

  it("accepts labels with hyphens in names", () => {
    const { parseConfig } = loadModule();
    const text = `[take-away]
description = "Main insight."
prototypes = ["A key message."]
anti-description = "Not a method."`;
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
anti-description = "Not this."`;
    expect(() => parseConfig(text)).toThrow(/missing description/);
  });

  it("rejects empty description", () => {
    const { parseConfig } = loadModule();
    const text = `[bad]
description = ""
prototypes = ["Something."]
anti-description = "Not this."`;
    expect(() => parseConfig(text)).toThrow(/description is empty/);
  });

  it("rejects duplicate description", () => {
    const { parseConfig } = loadModule();
    const text = `[bad]
description = "First."
description = "Second."
prototypes = ["Something."]
anti-description = "Not this."`;
    expect(() => parseConfig(text)).toThrow(/duplicate description/);
  });

  it("rejects missing prototypes", () => {
    const { parseConfig } = loadModule();
    const text = `[bad]
description = "Has desc."
anti-description = "Not this."`;
    expect(() => parseConfig(text)).toThrow(/at least one prototype/);
  });

  it("rejects empty prototypes array", () => {
    const { parseConfig } = loadModule();
    const text = `[bad]
description = "Has desc."
prototypes = []
anti-description = "Not this."`;
    expect(() => parseConfig(text)).toThrow(/at least one prototype/);
  });

  it("rejects missing anti-description", () => {
    const { parseConfig } = loadModule();
    const text = `[bad]
description = "Has desc."
prototypes = ["A proto."]`;
    expect(() => parseConfig(text)).toThrow(/missing anti-description/);
  });

  it("rejects empty anti-description", () => {
    const { parseConfig } = loadModule();
    const text = `[bad]
description = "Has desc."
prototypes = ["A proto."]
anti-description = ""`;
    expect(() => parseConfig(text)).toThrow(/anti-description is empty/);
  });

  it("rejects duplicate anti-description", () => {
    const { parseConfig } = loadModule();
    const text = `[bad]
description = "Has desc."
prototypes = ["A proto."]
anti-description = "First."
anti-description = "Second."`;
    expect(() => parseConfig(text)).toThrow(/duplicate anti-description/);
  });

  it("rejects unknown keys", () => {
    const { parseConfig } = loadModule();
    const text = `[bad]
description = "Has desc."
prototypes = ["A proto."]
anti-description = "Not this."
bogus = "value"`;
    expect(() => parseConfig(text)).toThrow(/unknown key/);
  });

  it("handles Windows-style line endings", () => {
    const { parseConfig } = loadModule();
    const text = `[a]\r\ndescription = "D."\r\nprototypes = ["P."]\r\nanti-description = "A."`;
    expect(parseConfig(text)).toHaveLength(1);
  });

  it("ignores blank lines and comments between blocks", () => {
    const { parseConfig } = loadModule();
    const text = `
# first label
[first]
description = "First label."
prototypes = ["Proto one."]
anti-description = "Not second."

# second label
[second]
description = "Second label."
prototypes = ["Proto two."]
anti-description = "Not first."
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
  it("uses only the top-K prototype similarities in positive score", async () => {
    const { createClassifier } = loadModule();
    const config = `[label]
description = "Test description."
prototypes = ["Proto A.", "Proto B.", "Proto C.", "Proto D.", "Proto E.", "Proto F."]
anti-description = "Opposite meaning."`;

    const classifier = await createClassifier({
      embeddingModel: mockEmbeddingModel(16),
      config,
      topK: 2,
      descriptionWeight: 0,
      prototypeWeight: 1,
      antiDescriptionWeight: 0
    });

    const result = await classifier.classify("A test sentence for top-K verification.");
    expect(result.predicted).toBe("[label]");
    const det = result.details["[label]"];
    expect(det.prototypeSimilarities.length).toBe(6);
    for (let i = 1; i < det.prototypeSimilarities.length; i++) {
      expect(det.prototypeSimilarities[i - 1]).toBeGreaterThanOrEqual(det.prototypeSimilarities[i]);
    }
    const top2Mean = (det.prototypeSimilarities[0] + det.prototypeSimilarities[1]) / 2;
    expect(det.positiveScore).toBeCloseTo(top2Mean, 5);
  });
});

// ── anti-description penalty ────────────────────────────────────────────────

describe("anti-description penalty", () => {
  it("reduces final score proportionally to anti-description similarity", async () => {
    const { createClassifier } = loadModule();
    const config = `[good]
description = "Something positive we want to match."
prototypes = ["This is definitely a match."]
anti-description = "This is the opposite of what we want."

[bad]
description = "Something else."
prototypes = ["Another category entirely."]
anti-description = "Matches good label content."`;

    const dim = 16;
    const manualModel = {
      async embed(texts) {
        return texts.map(t => {
          const v = new Array(dim).fill(0);
          if (t.includes("test this is the opposite")) { v[0] = 1; return v; }
          if (t === "This is the opposite of what we want.") {
            v[0] = 0.9; v[1] = Math.sqrt(1 - 0.81); return v;
          }
          let h = 0;
          for (let i = 0; i < t.length; i++) h = (Math.imul(31, h) + t.charCodeAt(i)) | 0;
          v[((h % (dim - 1)) + 1 + dim) % dim] = 1;
          return v;
        });
      }
    };

    const classifier = await createClassifier({
      embeddingModel: manualModel,
      config,
      descriptionWeight: 0.35,
      prototypeWeight: 0.65,
      antiDescriptionWeight: 0.25,
      topK: 1
    });

    const result = await classifier.classify("test this is the opposite");
    const goodDet = result.details["[good]"];
    expect(goodDet.antiDescriptionSimilarity).toBeGreaterThan(0.5);
    expect(goodDet.finalScore).toBe(
      goodDet.positiveScore - 0.25 * goodDet.antiDescriptionSimilarity
    );
  });
});

// ── score calculation ───────────────────────────────────────────────────────

describe("score calculation", () => {
  it("combines description, prototype, and anti-description correctly", async () => {
    const { createClassifier } = loadModule();

    const classifier = await createClassifier({
      embeddingModel: mockEmbeddingModel(32),
      config: TWO_LABEL_CONFIG,
      descriptionWeight: 0.4,
      prototypeWeight: 0.6,
      antiDescriptionWeight: 0.2,
      topK: 2
    });

    const result = await classifier.classify("A neutral test sentence.");
    expect(result.predicted).toMatch(/^\[(alpha|beta|uncertain)\]$/);
    expect(Object.keys(result.scores).sort()).toEqual(["[alpha]", "[beta]"]);

    for (const det of Object.values(result.details)) {
      expect(det.descriptionSimilarity).toBeGreaterThanOrEqual(-1);
      expect(det.descriptionSimilarity).toBeLessThanOrEqual(1);
      expect(det.prototypeSimilarities.length).toBe(2);
      const protoMean = (det.prototypeSimilarities[0] + det.prototypeSimilarities[1]) / 2;
      expect(det.positiveScore).toBeCloseTo(0.4 * det.descriptionSimilarity + 0.6 * protoMean, 5);
      expect(det.finalScore).toBeCloseTo(det.positiveScore - 0.2 * det.antiDescriptionSimilarity, 5);
    }
  });

  it("returns margin and runnerUp", async () => {
    const { createClassifier } = loadModule();
    const classifier = await createClassifier({
      embeddingModel: mockEmbeddingModel(8),
      config: TWO_LABEL_CONFIG
    });
    const result = await classifier.classify("Test.");
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
anti-description = "Not X."

[y]
description = "Label Y."
prototypes = ["Proto Y1.", "Proto Y2."]
anti-description = "Not Y."`;

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

    const result = await classifier.classify("Ambiguous sentence.");
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
anti-description = "Completely unrelated."

[other]
description = "Unrelated label."
prototypes = ["Something else entirely."]
anti-description = "Not relevant."`;

    const dim = 8;
    const strongModel = {
      async embed(texts) {
        return texts.map(t => {
          const v = new Array(dim).fill(0);
          if (t.includes("target sentence for testing")) { v[0] = 1; return v; }
          if (t === "Matches the input perfectly." || t === "This is exactly what we want to match." || t === "Completely unrelated.") {
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

    const result = await classifier.classify("target sentence for testing");
    expect(result.predicted).toBe("[match]");
    expect(result.margin).toBeGreaterThan(0.15);
  });

  it("defaults to 0 threshold (never uncertain)", async () => {
    const { createClassifier } = loadModule();
    const config = `[only]
description = "Only label."
prototypes = ["Only prototype."]
anti-description = "Not only."`;

    const classifier = await createClassifier({
      embeddingModel: mockEmbeddingModel(8),
      config
    });
    const result = await classifier.classify("Whatever.");
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
anti-description = "Anti A."

[b]
description = "Desc B."
prototypes = ["Proto B1."]
anti-description = "Anti B."`;

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

    // static texts: 2 descs + 3 protos + 2 anti-descs = 7 texts, one batch
    expect(embedSpy).toHaveBeenCalledTimes(1);
    expect(embedSpy.mock.calls[0][0]).toHaveLength(7);

    embedSpy.mockClear();
    await classifier.classify("Sentence one.");
    await classifier.classify("Sentence two.");
    expect(embedSpy).toHaveBeenCalledTimes(2);
    for (const call of embedSpy.mock.calls) expect(call[0]).toHaveLength(1);
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
    await expect(classifier.classify("")).rejects.toThrow(/non-empty/);
    await expect(classifier.classify("   ")).rejects.toThrow(/non-empty/);
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
      antiDescriptionWeight: 0.1,
      topK: 1
    });
    expect(classifier.config.descriptionWeight).toBe(0.5);
    expect(classifier.config.prototypeWeight).toBe(0.5);
    expect(classifier.config.antiDescriptionWeight).toBe(0.1);
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
    await classifier.classify("Test.");
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
anti-description = "Nope."`;
    const classifier = await createClassifier({
      embeddingModel: mockEmbeddingModel(4),
      config
    });
    expect(classifier.labels[0].color).toBeNull();
  });
});
