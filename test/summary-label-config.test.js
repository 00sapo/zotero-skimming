import { describe, expect, it } from "vitest";
import { loadScript } from "./helpers.js";

function loadModule() {
  return loadScript("content/summary-label-config.js", {}).FastKeySentenceSummaryLabels;
}

describe("summary label config", () => {
  it("parses the seven default labels with descriptions and colors", () => {
    const { parseConfig, DEFAULT_CONFIG } = loadModule();
    const labels = parseConfig(DEFAULT_CONFIG);
    expect(labels.map(label => label.name)).toEqual([
      "[literature]", "[method]", "[goal]", "[result]",
      "[conclusion]", "[contribution]", "[take-away]"
    ]);
    expect(labels.every(label => label.description && /^#[0-9a-f]{6}$/i.test(label.color))).toBe(true);
    expect(labels[1]).toEqual({
      name: "[method]",
      description: "Explains how the current study, analysis, system, dataset, or experiment was carried out.",
      color: "#5b9bd5"
    });
  });

  it("accepts a minimal label and an optional color", () => {
    const { parseConfig } = loadModule();
    expect(parseConfig('[custom]\ndescription = "A custom role."')).toEqual([
      { name: "[custom]", description: "A custom role.", color: null }
    ]);
  });

  it("rejects empty, incomplete, duplicate, and invalid definitions", () => {
    const { parseConfig } = loadModule();
    expect(() => parseConfig("")).toThrow(/non-empty/);
    expect(() => parseConfig("orphan content")).toThrow(/outside any/);
    expect(() => parseConfig("[bad]\ncolor = \"#ffffff\"")).toThrow(/missing description/);
    expect(() => parseConfig('[bad]\ndescription = ""')).toThrow(/description is empty/);
    expect(() => parseConfig('[bad]\ndescription = "One."\ndescription = "Two."')).toThrow(/duplicate description/);
    expect(() => parseConfig('[bad]\ndescription = "One."\ncolor = "red"')).toThrow(/invalid color/);
  });

  it("rejects keys from the retired classifier schema", () => {
    const { parseConfig } = loadModule();
    expect(() => parseConfig('[bad]\ndescription = "One."\nprototypes = ["Old."]')).toThrow(/unknown key "prototypes"/);
    expect(() => parseConfig('[bad]\ndescription = "One."\nanti-description = "Old."')).toThrow(/unknown key "anti-description"/);
  });

  it("parses strings and Windows line endings", () => {
    const { parseConfig, parseTomlString } = loadModule();
    expect(parseTomlString('"line\\nbreak"')).toBe("line\nbreak");
    expect(parseTomlString('"escaped\\"quote"')).toBe('escaped"quote');
    expect(parseConfig('[a]\r\ndescription = "A label."\r\ncolor = "#123abc"')).toHaveLength(1);
  });
});
