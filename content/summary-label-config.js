var FastKeySentenceSummaryLabels = (() => {
  "use strict";

  const DEFAULT_CONFIG = `# Summary label definitions.
# Each label has one prompt description and an optional Zotero highlight color.

[literature]
description = "Describes prior knowledge, previous studies, established theories, earlier methods, or unresolved gaps that existed before the current work."
color = "#8b9dc3"

[method]
description = "Explains how the current study, analysis, system, dataset, or experiment was carried out."
color = "#5b9bd5"

[goal]
description = "States the problem, motivation, objective, hypothesis, or research question addressed by the current paper."
color = "#ed7d31"

[result]
description = "Reports evidence, observations, measurements, comparisons, or outcomes produced by the current study."
color = "#a5a5a5"

[conclusion]
description = "Interprets, qualifies, generalizes, or discusses the implications of the current study's findings."
color = "#70ad47"

[contribution]
description = "States what the current paper newly introduces, provides, establishes, enables, or demonstrates."
color = "#ffc000"

[take-away]
description = "Expresses the paper's main high-level insight, re-usable take-away, or central message."
color = "#9b59b6"
`;

  function parseConfig(text) {
    if (typeof text !== "string" || !text.trim()) {
      throw new Error("Summary label config must be a non-empty string");
    }
    const labels = [];
    let current = null;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].trim();
      if (!line || line.startsWith("#")) continue;
      const header = line.match(/^\[([a-z][a-z0-9-]*)\]$/i);
      if (header) {
        if (current && !current.description) throw new Error(`Label ${current.name}: missing description`);
        current = { name: `[${header[1]}]`, description: "", color: null };
        labels.push(current);
        continue;
      }
      if (!current) throw new Error(`Line ${index + 1}: content outside any [label] block — "${line}"`);
      const assignment = line.match(/^([a-z][a-z-]*)\s*=\s*(.+)$/i);
      if (!assignment) throw new Error(`Line ${index + 1}: unexpected content — "${line}"`);
      const key = assignment[1];
      const value = parseTomlString(assignment[2]);
      if (key === "description") {
        if (!value) throw new Error(`Label ${current.name}: description is empty`);
        if (current.description) throw new Error(`Label ${current.name}: duplicate description`);
        current.description = value;
      }
      else if (key === "color") {
        if (current.color) throw new Error(`Label ${current.name}: duplicate color`);
        if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`Label ${current.name}: invalid color`);
        current.color = value;
      }
      else {
        throw new Error(`Label ${current.name}: unknown key "${key}"`);
      }
    }
    for (const label of labels) {
      if (!label.description) throw new Error(`Label ${label.name}: missing description`);
    }
    if (!labels.length) throw new Error("No labels found in config");
    return labels;
  }

  function parseTomlString(raw) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed.slice(1, -1)
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\")
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t");
    }
    return trimmed;
  }

  return Object.freeze({ DEFAULT_CONFIG, parseConfig, parseTomlString });
})();
