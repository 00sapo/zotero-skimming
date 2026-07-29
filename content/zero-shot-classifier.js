/* global FastKeySentenceModels, FastKeySentenceZeroShotConfig */

var FastKeySentenceZeroShot = (() => {
  "use strict";

  // ── user-editable label config (TOML) ─────────────────────────────────────

  const DEFAULT_CONFIG = `# Zero-shot rhetorical label definitions.
# Edit this file to tune descriptions, prototypes, context-prototypes, and colors.

[literature]
description = "Describes prior knowledge, previous studies, established theories, earlier methods, or unresolved gaps that existed before the current work."
anti-description = "Explains techniques, methods, results used by the authors or introduces, interprets, presents novel contribution by the present article"
prototypes = [
  "Earlier research examined the same problem under different assumptions.",
  "Existing evidence does not fully explain the observed behavior.",
  "Several approaches already address this task.",
  "The field still lacks a reliable solution for this setting.",
]
context-prototypes = [
  "Nearby attribution or citations indicate that the target refers to previous research.",
  "The target describes existing knowledge that motivates the current study.",
  "The following sentence contrasts the target with the current paper.",
]
color = "#8b9dc3"

[method]
description = "Explains how the current study, analysis, system, dataset, or experiment was carried out."
anti-description = "States what the current paper newly introduces or the paper's main high-level insight, re-usable take-away."
prototypes = [
  "The data were normalized before the analysis.",
  "Predictions were evaluated against manually assigned labels.",
  "The system combines representations from multiple sources.",
  "Each condition was tested using the same evaluation procedure.",
]
context-prototypes = [
  "The target describes a procedure whose outcome is reported nearby.",
  "The surrounding sentences place the target within the study's implementation or experiment.",
  "The target explains how the analysis or system was carried out.",
]
color = "#5b9bd5"

[goal]
description = "States the problem, motivation, objective, hypothesis, or research question addressed by the current paper."
anti-description = "Describes numerical results, facts, discoveries emerging from experiments, or present existing knowledge."
prototypes = [
  "Highlights a gap that must be filled.",
  "Expresses the goal of the research.",
  "The analysis is intended to identify the factors affecting performance.",
]
context-prototypes = [
  "The target identifies the problem that the following sentences attempt to solve.",
  "The target states an objective whose implementation is described afterward.",
  "The surrounding text presents the target as something the study seeks to accomplish.",
]
color = "#ed7d31"

[result]
description = "Reports evidence, observations, measurements, comparisons, or outcomes produced by the current study."
anti-description = "States what the current paper newly introduces or the paper's main high-level insight, re-usable take-away."
prototypes = [
  "Performance was consistently higher under the second condition.",
  "The two groups displayed substantially different behavior.",
  "Additional information reduced the number of incorrect predictions.",
  "No meaningful association was observed between the variables.",
]
context-prototypes = [
  "The target reports evidence that the surrounding sentences explain or interpret.",
  "The target states an observed outcome of the procedure described nearby.",
  "The following sentence discusses the meaning of the finding reported in the target.",
]
color = "#a5a5a5"

[conclusion]
description = "Interprets, qualifies, generalizes, or discusses the implications of the current study's findings."
anti-description = "States facts and numerical values resulting from experiments or techniques and methods adopted by the authors."
prototypes = [
  "The evidence supports the use of contextual information for this task.",
  "The observed pattern may result from differences in data quality.",
  "These findings may not generalize to every domain.",
  "Further research is needed to determine whether the effect persists.",
]
context-prototypes = [
  "The target interprets evidence reported in the preceding sentence.",
  "The target generalizes, qualifies, or explains a nearby result.",
  "The target discusses what the surrounding findings imply.",
]
color = "#70ad47"

[contribution]
description = "States what the current paper newly introduces, provides, establishes, enables, or demonstrates."
anti-description = "States facts and numerical values resulting from experiments or techniques and methods adopted by the authors."
prototypes = [
  "The work provides a new way to distinguish rhetorical sentence types.",
  "The study establishes that the task can be performed without labeled training data.",
  "A reusable evaluation resource is made available."
]
context-prototypes = [
  "The target states what the paper provides, and nearby sentences explain or evaluate it.",
  "The surrounding text presents the target as an achieved advance rather than an intention.",
  "The target describes a new capability introduced by the current work.",
]
color = "#ffc000"

[take-away]
description = "Expresses the paper's main high-level insight, re-usable take-away, or central message."
anti-description = "States what the current paper newly introduces or the numerical results or the techniques, methods used by the authors."
prototypes = [
  "Reliable classification depends more on rhetorical function than on surface wording.",
  "Context is most useful when the sentence alone is ambiguous.",
  "Semantic comparison works best when labels represent distinct communicative roles.",
  "The central lesson is that meaning cannot always be inferred from conventional phrasing.",
]
context-prototypes = [
  "The target summarizes the central significance of the surrounding discussion.",
  "The target compresses several nearby findings into one broad message.",
  "The target states the main lesson readers should retain.",
]
color = "#9b59b6"
`;

  // ── config parsing ────────────────────────────────────────────────────────

  /**
   * Parse a TOML label definition into a structured label array.
   *
   * Expected TOML format (one [section] per label):
   *   [label-name]
   *   description = "..."
   *   prototypes = ["...", "..."]
   *   anti-description = "..."
   *   color = "#rrggbb"          (optional)
   *
   * Supports # comments, multi-line arrays, and basic TOML string escapes.
   *
   * @param {string} text  raw TOML config
   * @returns {Array<{name: string, description: string, prototypes: string[], antiDescription: string, color: string|null}>}
   */
  function parseConfig(text) {
    if (typeof text !== "string" || !text.trim()) {
      throw new Error("Zero-shot config must be a non-empty string");
    }

    const labels = [];
    let current = null;

    // join continuation lines for multi-line arrays before parsing
    const rawLines = text.split(/\r?\n/);
    const lines = [];
    let inArray = false;
    for (const raw of rawLines) {
      const trimmed = raw.trim();
      if (inArray) {
        lines[lines.length - 1] += " " + trimmed;
        if (trimmed.endsWith("]")) inArray = false;
        continue;
      }
      if (/=\s*\[/.test(trimmed) && !trimmed.includes("]")) {
        inArray = true;
      }
      lines.push(trimmed);
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line.startsWith("#")) continue;

      // section header: [name]
      const headerMatch = line.match(/^\[([a-z][a-z0-9-]*)\]$/i);
      if (headerMatch) {
        if (current && !current.description) {
          throw new Error(`Label [${current.name}] is missing a description`);
        }
        current = {
          name: `[${headerMatch[1]}]`,
          description: "",
          prototypes: [],
          contextPrototypes: [],
          color: null
        };
        labels.push(current);
        continue;
      }

      if (!current) {
        throw new Error(`Line ${i + 1}: content outside any [label] block — "${line}"`);
      }

      // key = value  (handle string values and array values)
      const kvMatch = line.match(/^([a-z][a-z-]*)\s*=\s*(.+)$/i);
      if (!kvMatch) {
        throw new Error(`Line ${i + 1}: unexpected content — "${line}"`);
      }

      const key = kvMatch[1];
      const rawValue = kvMatch[2];

      if (key === "prototypes") {
        const values = parseTomlStringArray(rawValue);
        if (!values.length) throw new Error(`Label ${current.name}: at least one prototype required`);
        if (current.prototypes.length) throw new Error(`Label ${current.name}: duplicate prototypes`);
        current.prototypes = values;
      } else if (key === "context-prototypes") {
        const values = parseTomlStringArray(rawValue);
        if (current.contextPrototypes.length) throw new Error(`Label ${current.name}: duplicate context-prototypes`);
        current.contextPrototypes = values;
      } else if (key === "description") {
        const value = parseTomlString(rawValue);
        if (!value) throw new Error(`Label ${current.name}: description is empty`);
        if (current.description) throw new Error(`Label ${current.name}: duplicate description`);
        current.description = value;
      } else if (key === "anti-description") {
        const value = parseTomlString(rawValue);
        if (current.antiDescription) throw new Error(`Label ${current.name}: duplicate anti-description`);
        current.antiDescription = value || "";
      } else if (key === "color") {
        const value = parseTomlString(rawValue);
        if (current.color) throw new Error(`Label ${current.name}: duplicate color`);
        current.color = value || null;
      } else {
        throw new Error(`Label ${current.name}: unknown key "${key}"`);
      }
    }

    // validate completeness
    for (const label of labels) {
      if (!label.description) throw new Error(`Label ${label.name}: missing description`);
      if (!label.prototypes.length) throw new Error(`Label ${label.name}: at least one prototype required`);
    }

    if (!labels.length) throw new Error("No labels found in config");
    return labels;
  }

  /** Parse a TOML basic string value (double-quoted, with escapes). */
  function parseTomlString(raw) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed.slice(1, -1)
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t');
    }
    return trimmed;
  }

  /** Parse a TOML inline string array: ["a", "b", ...]. Handles trailing commas. */
  function parseTomlStringArray(raw) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
      throw new Error(`Expected TOML array, got: "${trimmed.slice(0, 40)}..."`);
    }
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    const items = [];
    let i = 0;
    while (i < inner.length) {
      // skip whitespace and commas
      while (i < inner.length && /[\s,]/.test(inner[i])) i++;
      if (i >= inner.length) break;
      if (inner[i] !== '"') throw new Error(`Expected string in array at position ${i}`);
      i++; // skip opening "
      let str = "";
      while (i < inner.length && inner[i] !== '"') {
        if (inner[i] === '\\' && i + 1 < inner.length) {
          i++;
          const esc = inner[i];
          if (esc === '"') str += '"';
          else if (esc === '\\') str += '\\';
          else if (esc === 'n') str += '\n';
          else if (esc === 't') str += '\t';
          else str += esc;
        } else {
          str += inner[i];
        }
        i++;
      }
      if (i >= inner.length) throw new Error("Unterminated string in array");
      i++; // skip closing "
      items.push(str);
      // skip whitespace, optional comma, then continue
      while (i < inner.length && /\s/.test(inner[i])) i++;
      if (i < inner.length && inner[i] === ',') i++;
    }
    return items;
  }

  return Object.freeze({
    DEFAULT_CONFIG,
    parseConfig,
    parseTomlString,
    parseTomlStringArray
  });
})();
