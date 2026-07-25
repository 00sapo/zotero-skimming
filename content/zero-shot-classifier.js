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

  // ── defaults ──────────────────────────────────────────────────────────────

  const DEFAULTS = Object.freeze({
    descriptionWeight: 0.35,
    prototypeWeight: 0.65,
    targetWeight: 0.75,
    contextWeight: 0.25,
    antiDescriptionWeight: 0.15,
    topK: 2,
    uncertaintyThreshold: 0.0,
    similarityFn: null            // uses cosine when null
  });

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

  // ── vector helpers ─────────────────────────────────────────────────────────

  function denseNorm(vec) {
    let sum = 0;
    for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
    return Math.sqrt(sum);
  }

  function cosine(a, b) {
    if (!a || !b || !a.length || !b.length) return 0;
    let dot = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) dot += a[i] * b[i];
    const na = denseNorm(a);
    const nb = denseNorm(b);
    return na && nb ? dot / (na * nb) : 0;
  }

  // ── public API ────────────────────────────────────────────────────────────

  /**
   * Create a zero-shot rhetorical sentence classifier.
   *
   * @param {object} options
   * @param {object} options.embeddingModel  object with async embed(texts: string[]) => number[][]
   * @param {string} [options.config]        raw label-definition text (uses DEFAULT_CONFIG when omitted)
   * @param {number} [options.descriptionWeight]
   * @param {number} [options.prototypeWeight]
   * @param {number} [options.targetWeight]
   * @param {number} [options.contextWeight]
   * @param {number} [options.topK]
   * @param {number} [options.uncertaintyThreshold]  margin below which [uncertain] is returned
   * @param {function} [options.similarityFn]        (a: number[], b: number[]) => number
   */
  async function createClassifier(options = {}) {
    if (!options.embeddingModel || typeof options.embeddingModel.embed !== "function") {
      throw new Error("embeddingModel with async embed(texts[]) is required");
    }

    const config = Object.freeze({
      descriptionWeight:     options.descriptionWeight     ?? DEFAULTS.descriptionWeight,
      prototypeWeight:       options.prototypeWeight       ?? DEFAULTS.prototypeWeight,
      targetWeight:          options.targetWeight          ?? DEFAULTS.targetWeight,
      contextWeight:         options.contextWeight         ?? DEFAULTS.contextWeight,
      antiDescriptionWeight: options.antiDescriptionWeight ?? DEFAULTS.antiDescriptionWeight,
      topK:                  options.topK                  ?? DEFAULTS.topK,
      uncertaintyThreshold:  options.uncertaintyThreshold  ?? DEFAULTS.uncertaintyThreshold,
      similarityFn:          options.similarityFn          ?? DEFAULTS.similarityFn
    });

    if (config.topK < 1) throw new Error("topK must be >= 1");

    const configText = options.config
      || (typeof FastKeySentenceZeroShotConfig !== "undefined" ? FastKeySentenceZeroShotConfig : null)
      || DEFAULT_CONFIG;
    const labels = parseConfig(configText);
    const sim = config.similarityFn || cosine;

    // collect all static texts to embed
    const staticTexts = [];
    const textIndex = []; // { labelIdx, kind }

    for (let li = 0; li < labels.length; li++) {
      staticTexts.push(labels[li].description);
      textIndex.push({ labelIdx: li, kind: "description" });

      for (const proto of labels[li].prototypes) {
        staticTexts.push(proto);
        textIndex.push({ labelIdx: li, kind: "prototype" });
      }

      for (const ctxProto of labels[li].contextPrototypes) {
        staticTexts.push(ctxProto);
        textIndex.push({ labelIdx: li, kind: "contextPrototype" });
      }

      if (labels[li].antiDescription) {
        staticTexts.push(labels[li].antiDescription);
        textIndex.push({ labelIdx: li, kind: "antiDescription" });
      }
    }

    // embed all static texts in one batch
    const staticVecs = await options.embeddingModel.embed(staticTexts);

    // build per-label structure
    const labelData = labels.map((label, li) => ({
      name: label.name,
      descVec: null,
      protoVecs: [],
      contextProtoVecs: [],
      antiDescVec: null
    }));

    for (let i = 0; i < textIndex.length; i++) {
      const { labelIdx, kind } = textIndex[i];
      const vec = staticVecs[i];
      if (kind === "description")        labelData[labelIdx].descVec = vec;
      else if (kind === "prototype")     labelData[labelIdx].protoVecs.push(vec);
      else if (kind === "contextPrototype") labelData[labelIdx].contextProtoVecs.push(vec);
      else if (kind === "antiDescription") labelData[labelIdx].antiDescVec = vec;
    }

    function meanTopK(vec, candidates, kNorms = null) {
      const sims = candidates.map((cv, idx) => sim(vec, cv, null, kNorms ? kNorms[idx] : null));
      sims.sort((a, b) => b - a);
      const top = sims.slice(0, config.topK);
      return { similarities: sims, mean: top.length ? top.reduce((s, v) => s + v, 0) / top.length : 0 };
    }

    /**
     * Classify a single sentence with its discourse context.
     *
     * @param {string} targetText   the sentence to classify
     * @param {string} contextText  formatted context window text
     * @returns {Promise<{
     *   predicted: string,
     *   scores: Record<string, number>,
     *   details: Record<string, {
     *     descriptionSimilarity: number,
     *     prototypeSimilarities: number[],
     *     contextPrototypeSimilarities: number[],
     *     targetScore: number,
     *     contextScore: number,
     *     finalScore: number
     *   }>,
     *   margin: number,
     *   runnerUp: string
     * }>}
     */
    async function classify(targetText, contextText) {
      if (typeof targetText !== "string" || !targetText.trim()) {
        throw new Error("classify() requires a non-empty target sentence string");
      }
      if (typeof contextText !== "string" || !contextText.trim()) {
        throw new Error("classify() requires a non-empty context window string");
      }

      const [targetVec, contextVec] = await options.embeddingModel.embed([targetText, contextText]);

      const results = [];

      for (const ld of labelData) {
        const descSim = sim(targetVec, ld.descVec);

        const protoResult = meanTopK(targetVec, ld.protoVecs);
        const protoMean = protoResult.mean;

        const ctxProtoResult = meanTopK(contextVec, ld.contextProtoVecs);
        const ctxProtoMean = ctxProtoResult.mean;

        const antiSim = ld.antiDescVec ? sim(targetVec, ld.antiDescVec) : 0;

        const targetScore = config.descriptionWeight * descSim
                          + config.prototypeWeight * protoMean
                          - config.antiDescriptionWeight * antiSim;

        const contextScore = ctxProtoMean;

        const finalScore = config.targetWeight * targetScore
                         + config.contextWeight * contextScore;

        results.push({
          label: ld.name,
          descriptionSimilarity: descSim,
          prototypeSimilarities: protoResult.similarities,
          contextPrototypeSimilarities: ctxProtoResult.similarities,
          antiDescriptionSimilarity: antiSim,
          targetScore,
          contextScore,
          finalScore
        });
      }

      // sort by finalScore descending
      results.sort((a, b) => b.finalScore - a.finalScore);

      const top = results[0];
      const runnerUp = results.length > 1 ? results[1] : null;
      const margin = runnerUp ? top.finalScore - runnerUp.finalScore : Infinity;

      const uncertain = config.uncertaintyThreshold > 0 && margin < config.uncertaintyThreshold;
      const predicted = uncertain
        ? `[uncertain]`
        : top.label;

      const scores = {};
      const details = {};
      for (const r of results) {
        scores[r.label] = r.finalScore;
        details[r.label] = {
          descriptionSimilarity: r.descriptionSimilarity,
          prototypeSimilarities: r.prototypeSimilarities,
          contextPrototypeSimilarities: r.contextPrototypeSimilarities,
          antiDescriptionSimilarity: r.antiDescriptionSimilarity,
          targetScore: r.targetScore,
          contextScore: r.contextScore,
          finalScore: r.finalScore
        };
      }

      const out = {
        predicted,
        scores,
        details,
        margin,
        runnerUp: runnerUp ? runnerUp.label : null
      };

      if (uncertain && runnerUp) {
        out.uncertainCandidates = [top.label, runnerUp.label];
      }

      return out;
    }

    return Object.freeze({
      classify,
      labels: Object.freeze(labels.map(l => ({ name: l.name, color: l.color }))),
      config
    });
  }

  // expose internals for testing
  const forTesting = { parseConfig, parseTomlString, parseTomlStringArray, cosine, denseNorm, DEFAULTS, DEFAULT_CONFIG };

  return Object.freeze({ createClassifier, ...forTesting });
})();
