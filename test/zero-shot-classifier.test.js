import { describe, expect, it, vi } from "vitest";
import { loadScript } from "./helpers.js";

// ── helpers ─────────────────────────────────────────────────────────────────

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
