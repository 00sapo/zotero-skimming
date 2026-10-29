/* global Zotero, FastKeySentenceModels, FastKeySentenceRemote, FastKeySentenceSummaryLabels */

var FastKeySentenceNLP = (() => {
  "use strict";

  const STOP_WORDS = new Set(`a an and are as at be been being but by can could did do does doing for from had has have having he her hers herself him himself his how i if in into is it its itself may might more most must my myself no nor not of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves`.split(/\s+/));
  // ── keyword section descriptions (fallback when scoring-config is unavailable) ──

  const SCORING = Object.freeze(FastKeySentenceScoringConfig);
  // Keep unselected candidates below the default threshold so the aligned sequence is the visible default.
  const SECONDARY_IMPORTANCE_CEILING = 0.5;

  function normalizeText(text) {
    return String(text || "")
      .replace(/\u00ad/g, "")
      .replace(/\uFB00/g, "ff")
      .replace(/\uFB01/g, "fi")
      .replace(/\uFB02/g, "fl")
      .replace(/\uFB03/g, "ffi")
      .replace(/\uFB04/g, "ffl")
      .replace(/([A-Za-z])-\s+([a-z])/g, "$1$2")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/\s+/g, " ")
      .trim();
  }

  function tokenize(text) {
    return normalizeText(text)
      .toLowerCase()
      .match(/[a-z][a-z0-9]*(?:[-'][a-z0-9]+)*/g)?.filter(t => !STOP_WORDS.has(t) && t.length > 1) || [];
  }

  function sentenceRanges(text) {
    const ranges = [];
    const abbreviations = new Set(["e.g.", "i.e.", "et al.", "fig.", "sec.", "eq.", "dr.", "mr.", "mrs.", "prof.", "vs."]);
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (!".!?".includes(ch)) continue;
      const left = text.slice(Math.max(0, i - 12), i + 1).toLowerCase();
      if ([...abbreviations].some(a => left.endsWith(a))) continue;
      let j = i + 1;
      while (j < text.length && /[\"'\)\]\}]/.test(text[j])) j++;
      if (j < text.length && !/\s/.test(text[j])) continue;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (j < text.length && !/[A-Z0-9\[(]/.test(text[j])) continue;
      ranges.push([start, i + 1]);
      start = j;
      i = j - 1;
    }
    if (start < text.length) ranges.push([start, text.length]);
    return ranges;
  }

  function detectHeading(text) {
    const s = normalizeText(text);
    if (!s || s.length > 90) return null;
    const known = /^(abstract|introduction|background|related work|methods?|methodology|materials? and methods?|datasets?|workflow|architecture|layout analysis|post-processing pipeline|metrics|preliminary experiments?|document-specific fine-tuning|mixed model training(?: without fine-tuning)?|evaluation of the contribution of the different post-processing steps|error analysis|experiments?|results?|discussion|limitations?|conclusions?|future work|references|bibliography|works cited|literature cited|reference list|appendix|supplementary material|supplementary information)$/i;
    const unnumbered = s.match(known);
    if (unnumbered) return unnumbered[1].toLowerCase();

    const numbered = s.match(/^\d+(?:\.\d+)*[.)]?\s+(.+)$/);
    if (!numbered) return null;
    const title = normalizeText(numbered[1]).replace(/[.]$/, "");
    if (!title || title.split(/\s+/).length > 12 || /[:!?]$/.test(title)) return null;
    const knownNumbered = title.match(known);
    if (knownNumbered) return knownNumbered[1].toLowerCase();

    const alphaWords = title.match(/[A-Za-z][A-Za-z-]*/g) || [];
    if (!alphaWords.length) return null;
    const connectors = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "in", "of", "on", "or", "the", "to", "using", "with", "without"]);
    const contentWords = alphaWords.filter(word => !connectors.has(word.toLowerCase()));
    const capitalized = contentWords.filter(word => /^[A-Z]/.test(word)).length;
    if (!contentWords.length || capitalized / contentWords.length < 0.65) return null;
    return title.toLowerCase();
  }

  function isReferenceHeading(heading) {
    return /^(?:references|bibliography|works cited|literature cited|reference list)$/i.test(normalizeText(heading));
  }

  function isReferenceEntry(text) {
    const s = normalizeText(text);
    if (!s || s.length < 8) return false;
    const hasYear = /\b(?:18|19|20)\d{2}[a-z]?\b/.test(s);
    const hasLocator = /\b(?:doi\s*:|https?:\/\/|www\.)/i.test(s);
    const marker = /^(?:\[\d+\]|\d+[.)])\s+/.test(s);
    const citationTerms = /\b(?:et al\.?|vol\.?|no\.?|pp\.?|pages?|journal|proceedings|conference|press|publisher|edition|retrieved|accessed|available at)\b/i.test(s);
    const authorInitial = /^(?:(?:\[\d+\]|\d+[.)])\s+)?[A-Z][A-Za-z'’\-]+,\s*(?:[A-Z]\.?(?:[- ]?[A-Z]\.?)?\s*,?\s*){1,4}/.test(s);

    if (authorInitial && (hasYear || hasLocator || citationTerms)) return true;
    if (marker && (hasYear || hasLocator || citationTerms || authorInitial)) return true;
    if (hasLocator && (hasYear || citationTerms || s.split(/\s+/).length <= 12)) return true;
    if (/^[A-Z][A-Za-z'’\-]+(?:,|\s+and\s+|\s*&\s+).{0,120}\((?:18|19|20)\d{2}[a-z]?\)/.test(s)) return true;
    if (hasYear && citationTerms) return true;
    return false;
  }

  function isNoise(sentence) {
    const text = normalizeText(sentence.text);
    const words = text.split(/\s+/).filter(Boolean);
    if (sentence.frontMatter || sentence.inTable || sentence.reference) return true;
    if (/^(?:author contributions?|funding|institutional review board statement|informed consent statement|data availability statement|acknowledg(?:e)?ments?|conflicts? of interest|abbreviations?)\s*[:.]?/i.test(text)) return true;
    if (isReferenceHeading(sentence.section || "") || isReferenceEntry(text)) return true;
    if (words.length < 5 || words.length > 90) return true;
    const digits = (text.match(/\d/g) || []).length;
    if (digits / Math.max(1, text.length) > 0.28) return true;
    if (/^(figure|fig\.|table|tab\.)\s+(?:[A-Z][.-]?\s*)?(?:\d+|[IVXLC]+)/i.test(text)) return true;
    if ((text.match(/\b(?:\d+(?:\.\d+)?|n\/?a)\b/gi) || []).length >= 5
        && !/\b(?:we|this|these|results?|shows?|indicates?|suggests?|was|were|is|are|has|have)\b/i.test(text)) return true;
    if (/^\[?\d+\]?\s+[A-Z][^.!?]{0,80}\b(19|20)\d{2}\b/.test(text)) return true;
    if (/\b(doi|https?:\/\/|www\.|received|accepted|published|publisher(?:'s)? note|copyright|creative commons|all rights reserved|citation:)\b/i.test(text)) return true;
    if (/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/.test(text)) return true;
    if (/^[©\u00a9]|^\W{2,}$/.test(text)) return true;
    if (/^(?:[A-Z][A-Za-z'’-]+(?:,| and | & |\s+)){2,}[A-Z][A-Za-z'’-]+$/.test(text) && words.length < 14) return true;
    return false;
  }

  function buildFeatures(sentences) {
    const df = new Map();
    const termCounts = [];
    const vocab = new Map();

    for (const sentence of sentences) {
      const tokens = tokenize(sentence.text);
      const terms = tokens.concat(tokens.slice(0, -1).map((t, i) => `${t}__${tokens[i + 1]}`));
      const counts = new Map();
      for (const term of terms) counts.set(term, (counts.get(term) || 0) + 1);
      termCounts.push(counts);
      for (const term of counts.keys()) df.set(term, (df.get(term) || 0) + 1);
    }

    const n = sentences.length;
    const allowed = [...df.entries()]
      .filter(([, d]) => d <= n * 0.96)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 16000)
      .map(([term]) => term);
    allowed.forEach((term, i) => vocab.set(term, i));
    const idf = new Float64Array(allowed.length);
    allowed.forEach((term, i) => {
      idf[i] = Math.log((n + 1) / ((df.get(term) || 0) + 1)) + 1;
    });

    const vectors = [];
    const norms = [];
    const centroid = new Map();
    for (const counts of termCounts) {
      const vector = new Map();
      let norm2 = 0;
      for (const [term, tf] of counts) {
        const idx = vocab.get(term);
        if (idx === undefined) continue;
        const value = (1 + Math.log(tf)) * idf[idx];
        vector.set(idx, value);
        centroid.set(idx, (centroid.get(idx) || 0) + value / n);
        norm2 += value * value;
      }
      vectors.push(vector);
      norms.push(Math.sqrt(norm2));
    }
    return {
      vectors,
      norms,
      centroid,
      centroidNorm: sparseNorm(centroid),
      documentFrequencies: allowed.map(term => df.get(term) || 1),
      vocabulary: vocab,
      idf
    };
  }

  function vectorizeText(text, vocabulary, idf) {
    const tokens = tokenize(text);
    const terms = tokens.concat(tokens.slice(0, -1).map((t, i) => `${t}__${tokens[i + 1]}`));
    const counts = new Map();
    for (const term of terms) counts.set(term, (counts.get(term) || 0) + 1);
    const vector = new Map();
    let norm2 = 0;
    for (const [term, tf] of counts) {
      const idx = vocabulary.get(term);
      if (idx === undefined) continue;
      const value = (1 + Math.log(tf)) * (idf[idx] || 1);
      vector.set(idx, value);
      norm2 += value * value;
    }
    return { vector, norm: Math.sqrt(norm2) };
  }

  function sparseNorm(v) {
    let sum = 0;
    for (const x of v.values()) sum += x * x;
    return Math.sqrt(sum);
  }

  function cosine(a, b, normA = sparseNorm(a), normB = sparseNorm(b)) {
    if (!normA || !normB) return 0;
    let small = a, large = b;
    if (a.size > b.size) [small, large] = [b, a];
    let dot = 0;
    for (const [k, v] of small) dot += v * (large.get(k) || 0);
    return dot / (normA * normB);
  }

  function denseNorm(vector) {
    let sum = 0;
    for (const value of vector || []) sum += value * value;
    return Math.sqrt(sum);
  }

  function isSparseVector(vector) {
    return vector instanceof Map;
  }

  function vectorNorm(vector) {
    return isSparseVector(vector) ? sparseNorm(vector) : denseNorm(vector);
  }

  function vectorCosine(a, b, normA = vectorNorm(a), normB = vectorNorm(b)) {
    if (!normA || !normB) return 0;
    if (isSparseVector(a) && isSparseVector(b)) return cosine(a, b, normA, normB);
    if (!Array.isArray(a) || !Array.isArray(b)) return 0;
    const length = Math.min(a.length, b.length);
    let dot = 0;
    for (let i = 0; i < length; i++) dot += a[i] * b[i];
    return dot / (normA * normB);
  }



  function buildShortlist(sentences, vectors, documentFrequencies, size) {
    const ranked = sentences.map((sentence, index) => ({ index, importance: sentence.importance || 0 }))
      .sort((a, b) => b.importance - a.importance);
    if (ranked.length <= size) return ranked.map(entry => entry.index);

    const selected = new Set(ranked.slice(0, Math.max(1, Math.floor(size * 0.7))).map(entry => entry.index));
    const sectionLimit = Math.max(1, Math.floor(size * 0.15));
    let sectionCount = 0;
    const sectionBest = new Map();
    for (const entry of ranked) {
      const section = sentences[entry.index].section || "";
      if (!sectionBest.has(section)) sectionBest.set(section, entry.index);
    }
    for (const index of sectionBest.values()) {
      if (selected.size >= size || sectionCount >= sectionLimit) break;
      if (!selected.has(index)) {
        selected.add(index);
        sectionCount++;
      }
    }

    const rarity = sentences.map(() => 0);
    for (let i = 0; i < vectors.length; i++) {
      for (const termIndex of vectors[i].keys()) {
        const df = documentFrequencies[termIndex] || 1;
        rarity[i] = Math.max(rarity[i], Math.log((sentences.length + 1) / (df + 1)));
      }
    }
    const rareCandidates = rarity.map((value, index) => ({ index, value }))
      .sort((a, b) => b.value - a.value);
    for (const entry of rareCandidates) {
      if (selected.size >= size) break;
      selected.add(entry.index);
    }
    return [...selected];
  }

  function minMax(values) {
    if (!values.length) return [];
    const min = Math.min(...values), max = Math.max(...values);
    if (!Number.isFinite(min) || max === min) return values.map(() => 0.5);
    return values.map(value => (value - min) / (max - min));
  }

  function scoreWithVectors(sentences, vectors, norms, clusterCount, summaryScores = null) {
    if (!sentences.length) return;
    const summarySim = summaryScores || new Array(sentences.length).fill(0);
    const lengths = [];
    for (const sentence of sentences) {
      const wordCount = sentence.text.split(/\s+/).length;
      lengths.push(Math.exp(-Math.pow(wordCount - 18, 2) / (2 * Math.pow(12, 2))));
    }
    const S = minMax(summarySim);
    const L = minMax(lengths);
    sentences.forEach((sentence, i) => {
      sentence.summaryRelevance = summarySim[i];
      sentence.importance = SCORING.initial.summarySimilarity * S[i]
        + SCORING.initial.sentenceLength * L[i];
    });
  }

  function scoreSparse(sentences, clusterCount, summaryScores = null) {
    if (!sentences.length) return { vectors: [], norms: [] };
    const { vectors, norms } = buildFeatures(sentences);
    scoreWithVectors(sentences, vectors, norms, clusterCount, summaryScores);
    return { vectors, norms };
  }

  function selectMMR(sentences, vectors, norms, count) {
    const selected = [];
    const remaining = new Set(sentences.map((_, i) => i));
    const sectionCounts = new Map();

    while (selected.length < count && remaining.size) {
      let best = -1, bestScore = -Infinity;
      for (const i of remaining) {
        let redundancy = 0;
        for (const j of selected) {
          redundancy = Math.max(redundancy, vectorCosine(vectors[i], vectors[j], norms[i], norms[j]));
        }
        const sectionPenalty = SCORING.selection.sectionPenalty * (sectionCounts.get(sentences[i].section || "") || 0);
        const value = SCORING.selection.importance * sentences[i].importance
          - SCORING.selection.redundancy * redundancy - sectionPenalty;
        if (value > bestScore) {
          bestScore = value;
          best = i;
        }
      }
      if (best < 0) break;

      selected.push(best);
      remaining.delete(best);
      const section = sentences[best].section || "";
      sectionCounts.set(section, (sectionCounts.get(section) || 0) + 1);
    }
    return selected.map(i => sentences[i]).sort((a, b) => a.order - b.order);
  }

  function selectSequence(sentences, vectors, norms, count, summaryParts) {
    const n = sentences.length;
    const m = summaryParts ? summaryParts.length : 0;
    if (!n || !m || count <= 0) return [];
    const target = Math.min(count, n, m);
    if (target <= 0) return [];

    const summaryPositions = summaryParts.map((_, index) => m > 1 ? index / (m - 1) : 0.5);
    const articlePositions = sentences.map((sentence, index) => {
      const value = Number(sentence.position);
      if (Number.isFinite(value)) return Math.max(0, Math.min(1, value));
      return n > 1 ? index / (n - 1) : 0.5;
    });
    const importanceWeight = Number(SCORING.selection.importance) || 0;
    const positionWeight = Number(SCORING.selection.position) || 0;
    const redundancyWeight = Number(SCORING.selection.redundancy) || 0;
    const sectionPenalty = Number(SCORING.selection.sectionPenalty) || 0;

    const similarity = [];
    for (let i = 0; i < n; i++) {
      const row = new Float64Array(m);
      for (let j = 0; j < m; j++) {
        row[j] = Math.max(0, vectorCosine(vectors[i], summaryParts[j].vector, norms[i], summaryParts[j].norm));
      }
      similarity.push(row);
    }

    const redundancy = [];
    for (let i = 0; i < n; i++) redundancy.push(new Float64Array(n));
    for (let i = 0; i < n; i++) {
      for (let k = i + 1; k < n; k++) {
        const value = Math.max(0, vectorCosine(vectors[i], vectors[k], norms[i], norms[k]));
        redundancy[i][k] = value;
        redundancy[k][i] = value;
      }
    }

    const sections = sentences.map(sentence => sentence.section || "");
    const dp = new Float64Array(target * m * n);
    const prev = new Int32Array(target * m * n);
    dp.fill(-Infinity);
    prev.fill(-1);
    const stateIndex = (t, j, i) => ((t - 1) * m + j) * n + i;

    for (let j = 0; j < m; j++) {
      for (let i = 0; i < n; i++) {
        dp[stateIndex(1, j, i)] = importanceWeight * ((Number(sentences[i].importance) || 0) + similarity[i][j])
          - positionWeight * Math.abs(articlePositions[i] - summaryPositions[j]);
      }
    }

    const bestPrev = new Float64Array(n);
    const bestPrevJ = new Int32Array(n);
    for (let t = 2; t <= target; t++) {
      for (let j = 1; j < m; j++) {
        if (j === 1) {
          for (let i = 0; i < n; i++) {
            bestPrev[i] = dp[stateIndex(t - 1, 0, i)];
            bestPrevJ[i] = 0;
          }
        }
        else {
          const previousJ = j - 1;
          for (let i = 0; i < n; i++) {
            const value = dp[stateIndex(t - 1, previousJ, i)];
            if (value > bestPrev[i]) {
              bestPrev[i] = value;
              bestPrevJ[i] = previousJ;
            }
          }
        }
        for (let i = 0; i < n; i++) {
          let best = -Infinity;
          let bestI = -1;
          let bestJ = -1;
          for (let k = 0; k < i; k++) {
            const value = bestPrev[k];
            if (value === -Infinity) continue;
            const score = value - redundancyWeight * redundancy[i][k]
              - (sections[i] === sections[k] ? sectionPenalty : 0);
            if (score > best) {
              best = score;
              bestI = k;
              bestJ = bestPrevJ[k];
            }
          }
          if (bestI < 0) continue;
          const index = stateIndex(t, j, i);
          dp[index] = best + importanceWeight * ((Number(sentences[i].importance) || 0) + similarity[i][j])
            - positionWeight * Math.abs(articlePositions[i] - summaryPositions[j]);
          prev[index] = bestJ * n + bestI;
        }
      }
    }

    let bestScore = -Infinity;
    let bestJ = -1;
    let bestI = -1;
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < n; i++) {
        const value = dp[stateIndex(target, j, i)];
        if (value > bestScore) {
          bestScore = value;
          bestJ = j;
          bestI = i;
        }
      }
    }
    if (bestI < 0) return [];

    const selected = [];
    let t = target;
    let j = bestJ;
    let i = bestI;
    while (t >= 1 && j >= 0 && i >= 0) {
      selected.push(i);
      const previous = prev[stateIndex(t, j, i)];
      if (previous < 0) break;
      j = Math.floor(previous / n);
      i = previous % n;
      t--;
    }
    selected.reverse();
    return selected.map(index => sentences[index]);
  }


  function summarySimilaritySparse(sentenceVectors, sentenceNorms, summaryVector) {
    const summaryNorm = sparseNorm(summaryVector);
    if (!summaryNorm) return new Array(sentenceVectors.length).fill(0);
    return sentenceVectors.map((vector, index) =>
      vectorCosine(vector, summaryVector, sentenceNorms[index], summaryNorm)
    );
  }


  function summarySimilarityDense(vectors, norms, summaryEmbedding) {
    if (!summaryEmbedding || !summaryEmbedding.length) return new Array(vectors.length).fill(0);
    const summaryNorm = denseNorm(summaryEmbedding);
    return vectors.map((vec, i) => vectorCosine(vec, summaryEmbedding, norms[i], summaryNorm));
  }

  function cleanSummarySentence(text) {
    return normalizeText(String(text || "")
      .replace(/^\s*\d+\.\s*/, "")
      .replace(/^\s*\[[a-z][a-z0-9-]*\]\s*/i, "")
      .replace(/^\s*/, ""));
  }

  function parseLabeledSummary(summaryText, labels = []) {
    const validLabels = new Set(labels.map(label => label.name));
    const entries = [];
    const pattern = /(?:^|\s)(?:\d+[.)]?\s*)?\[([a-z][a-z0-9-]*)\]\s*(.*?)(?=\s+(?:\d+[.)]?\s*)?\[[a-z][a-z0-9-]*\]|$)/gsi;
    for (const match of String(summaryText || "").matchAll(pattern)) {
      const label = `[${match[1]}]`;
      const sentence = cleanSummarySentence(match[2]);
      if (sentence && (!validLabels.size || validLabels.has(label))) entries.push({ label, sentence });
    }
    return entries;
  }

  function analyze(sentences, count) {
    const filtered = sentences.filter(sentence => !isNoise(sentence));
    const { vectors, norms } = scoreSparse(filtered, count);
    return selectMMR(filtered, vectors, norms, Math.min(count, filtered.length));
  }

  function paperTextForSummary(sentences) {
    const body = sentences
      .filter(s => !s.frontMatter && normalizeText(s.section || "") !== "abstract")
      .map(s => s.text)
      .filter(Boolean)
      .join(" ");
    return normalizeText(body).slice(0, 128000);
  }

  async function analyzeAsync(sentences, count, options = {}) {
    const filtered = sentences.filter(sentence => !isNoise(sentence)).sort((a, b) => a.order - b.order);
    if (!filtered.length) return [];

    const positionDenominator = filtered.length > 1 ? filtered.length - 1 : 0;
    filtered.forEach((sentence, index) => {
      sentence.position = positionDenominator ? index / positionDenominator : 0.5;
    });

    const labelsEnabled = options.summaryLabels === true;
    const useLocalRelevance = options.localRelevance === true;
    const useLocalSummary = options.summarySource !== "remote" && (useLocalRelevance || labelsEnabled);
    const useRemoteSummary = options.summarySource === "remote";
    const useLocalModels = useLocalSummary || useLocalRelevance || labelsEnabled;
    if (useLocalModels && typeof FastKeySentenceModels === "undefined") {
      throw new Error("The transformer model manager was not loaded.");
    }

    const inferenceAvailable = !useLocalModels || FastKeySentenceModels.supportsInference?.();
    if (useLocalModels && !inferenceAvailable) {
      options.onModelProgress?.({
        stage: "unavailable",
        operation: "runtime",
        message: "Transformer inference is unavailable. Using the baseline ranker."
      });
    }

    const labels = labelsEnabled ? FastKeySentenceSummaryLabels.parseConfig(options.summaryLabelConfigV2 || FastKeySentenceSummaryLabels.DEFAULT_CONFIG) : [];
    const shouldSummarize = useLocalSummary || useRemoteSummary;
    let summary = "";
    let localSummaryFailed = false;
    if (shouldSummarize) {
      options.onModelProgress?.({ stage: "preparing", operation: "summarization" });
      const paperText = paperTextForSummary(filtered);
      if (useLocalSummary && inferenceAvailable) {
        try {
          summary = await FastKeySentenceModels.summarize(
            paperText,
            event => options.onModelProgress?.({ ...event, operation: "summarization" }),
            {
              mapReduce: options.mapReduce === true,
              mapReduceSentences: options.mapReduceSentences,
              sentenceCount: Math.max(3, Math.round(count * 1.5)),
              labels
            }
          );
        }
        catch (error) {
          localSummaryFailed = true;
          options.onModelProgress?.({
            stage: "unavailable",
            operation: "summarization",
            message: `Local summarization failed; using the baseline ranker. ${error.message || error}`
          });
        }
      }
      else if (useRemoteSummary) {
        summary = await FastKeySentenceRemote.summarize(
          paperText,
          options.documentTitle || "",
          count,
          event => options.onModelProgress?.({ ...event, operation: "summarization" }),
          labels
        );
      }
    }

    const summaryEntries = labelsEnabled ? parseLabeledSummary(summary, labels) : [];
    const classificationEntries = summaryEntries.length
      ? summaryEntries.map(entry => ({ text: entry.sentence, label: labels.find(label => label.name === entry.label) }))
      : labels.map(label => ({ text: label.description, label }));
    if (summaryEntries.length) summary = summaryEntries.map(entry => entry.sentence).join("\n");

    const featureInput = summary ? [...filtered, { text: summary }] : filtered;
    const features = buildFeatures(featureInput);
    const sentenceVectors = features.vectors.slice(0, filtered.length);
    const sentenceNorms = features.norms.slice(0, filtered.length);
    const summaryScores = summary
      ? summarySimilaritySparse(sentenceVectors, sentenceNorms, features.vectors[filtered.length])
      : new Array(filtered.length).fill(0);
    scoreWithVectors(filtered, sentenceVectors, sentenceNorms, count, summaryScores);

    const summarySentences = summary
      ? sentenceRanges(summary).map(([start, end]) => cleanSummarySentence(summary.slice(start, end))).filter(Boolean)
      : [];
    let summaryParts = summarySentences.map(text => {
      const { vector, norm } = vectorizeText(text, features.vocabulary, features.idf);
      return { vector, norm, text };
    });
    if (!summaryParts.length) summaryParts = null;

    const shortlistSize = Math.min(filtered.length, Math.max(count * 4, 60), 160);
    const shortlistIndices = buildShortlist(filtered, sentenceVectors, features.documentFrequencies, shortlistSize);
    shortlistIndices.sort((a, b) => a - b);
    const shortlist = shortlistIndices.map(index => filtered[index]);
    const shortlistVectors = shortlistIndices.map(index => sentenceVectors[index]);
    const shortlistNorms = shortlistIndices.map(index => sentenceNorms[index]);
    let sequenceVectors = shortlistVectors;
    let sequenceNorms = shortlistNorms;
    let denseShortlistVectors = null;
    let denseShortlistNorms = null;
    const useRemoteEmbed = !localSummaryFailed && summary && typeof FastKeySentenceRemote?.embeddings === "function";
    const useLocalEmbed = inferenceAvailable && !localSummaryFailed && summary;
    if (useLocalRelevance && (useRemoteEmbed || useLocalEmbed)) {
      const embedFn = options.summarySource === "local" || !useRemoteEmbed
        ? FastKeySentenceModels.embeddings
        : FastKeySentenceRemote.embeddings;
      try {
        options.onModelProgress?.({ stage: "preparing", operation: "summary-relevance" });
        const texts = shortlist.map(sentence => sentence.text);
        const [summaryEmbedding, ...sentenceEmbeddings] = await embedFn(
          [summary, ...texts],
          event => options.onModelProgress?.({ ...event, operation: "summary-relevance" })
        );
        const sentenceEmbeddingNorms = sentenceEmbeddings.map(denseNorm);
        denseShortlistVectors = sentenceEmbeddings.map(vector => Array.from(vector, Number));
        denseShortlistNorms = denseShortlistVectors.map(denseNorm);
        const denseRelevance = summarySimilarityDense(sentenceEmbeddings, sentenceEmbeddingNorms, summaryEmbedding);
        const lengths = shortlist.map(sentence => Math.exp(-Math.pow(sentence.text.split(/\s+/).length - 18, 2) / (2 * Math.pow(12, 2))));
        const S = minMax(denseRelevance);
        const L = minMax(lengths);
        shortlist.forEach((sentence, index) => {
          sentence.summaryRelevance = denseRelevance[index] || 0;
          sentence.importance = SCORING.initial.summarySimilarity * S[index]
            + SCORING.initial.sentenceLength * L[index];
        });
      }
      catch (error) {
        options.onModelProgress?.({
          stage: "unavailable",
          operation: "local-relevance",
          message: `Ollama relevance failed; using the baseline ranker. ${error.message || error}`
        });
      }
    }

    if (summary && useLocalRelevance && denseShortlistVectors && summarySentences.length > 1) {
      try {
        const embedFn = options.summarySource === "remote" && typeof FastKeySentenceRemote?.embeddings === "function"
          ? FastKeySentenceRemote.embeddings
          : FastKeySentenceModels.embeddings;
        const vectors = await embedFn(
          summarySentences,
          event => options.onModelProgress?.({ ...event, operation: "summary-relevance" })
        );
        summaryParts = vectors.map((vector, index) => {
          const values = Array.from(vector, Number);
          return { vector: values, norm: denseNorm(values), text: summarySentences[index] };
        });
        sequenceVectors = denseShortlistVectors;
        sequenceNorms = denseShortlistNorms;
      }
      catch (_) {}
    }

    const selectedSentences = summaryParts && summaryParts.length > 1
      ? selectSequence(shortlist, sequenceVectors, sequenceNorms, Math.min(count, shortlist.length), summaryParts)
      : selectMMR(shortlist, shortlistVectors, shortlistNorms, Math.min(count, shortlist.length));
    const selectedSet = new Set(selectedSentences);
    let minImportance = Infinity;
    let maxImportance = -Infinity;
    for (const sentence of filtered) {
      const importance = Number(sentence.importance) || 0;
      minImportance = Math.min(minImportance, importance);
      maxImportance = Math.max(maxImportance, importance);
    }
    const importanceRange = maxImportance - minImportance;
    for (const sentence of filtered) {
      const importance = Number(sentence.importance) || 0;
      sentence._selected = selectedSet.has(sentence);
      sentence.importance = sentence._selected
        ? 1
        : importanceRange > 0
          ? (importance - minImportance) / importanceRange * SECONDARY_IMPORTANCE_CEILING
          : SECONDARY_IMPORTANCE_CEILING;
    }

    if (labelsEnabled && filtered.length) {
      try {
        options.onModelProgress?.({ stage: "preparing", operation: "tag-classification" });
        if (!classificationEntries.length) throw new Error("No summary labels are configured.");
        const remoteAvailable = typeof FastKeySentenceRemote?.embeddings === "function";
        const useRemoteClassify = options.summarySource === "remote" && remoteAvailable;
        const primaryEmbed = useRemoteClassify ? FastKeySentenceRemote.embeddings : FastKeySentenceModels.embeddings;
        const fallbackEmbed = useRemoteClassify ? FastKeySentenceModels.embeddings : (remoteAvailable ? FastKeySentenceRemote.embeddings : null);
        const texts = [...classificationEntries.map(entry => entry.text), ...filtered.map(sentence => sentence.text)];
        let vectors;
        try {
          vectors = await primaryEmbed(texts, event => options.onModelProgress?.({ ...event, operation: "tag-classification" }));
        }
        catch (primaryError) {
          if (!fallbackEmbed) throw primaryError;
          options.onModelProgress?.({
            stage: "unavailable",
            operation: "tag-classification",
            message: `Primary embedding failed; trying fallback. ${primaryError.message || primaryError}`
          });
          vectors = await fallbackEmbed(texts, event => options.onModelProgress?.({ ...event, operation: "tag-classification" }));
        }
        const summaryVectors = vectors.slice(0, classificationEntries.length);
        const sourceVectors = vectors.slice(classificationEntries.length);
        const summaryNorms = summaryVectors.map(denseNorm);
        const sourceNorms = sourceVectors.map(denseNorm);
        for (let i = 0; i < filtered.length; i++) {
          let bestIndex = 0;
          let bestScore = -1;
          for (let j = 0; j < classificationEntries.length; j++) {
            const score = vectorCosine(sourceVectors[i], summaryVectors[j], sourceNorms[i], summaryNorms[j]);
            if (score > bestScore) {
              bestScore = score;
              bestIndex = j;
            }
          }
          const label = classificationEntries[bestIndex].label;
          filtered[i].tag = label.name.replace(/^\[|\]$/g, "");
          filtered[i].tagDescription = label.description || "";
          filtered[i].tagColor = label.color || null;
          filtered[i].tagIndex = labels.indexOf(label);
          filtered[i].tagScore = bestScore;
        }
      }
      catch (error) {
        const msg = error?.message || String(error);
        if (typeof Services !== "undefined") Services.console.logStringMessage(`Zotero Skimming: tag classification failed — ${msg}`);
        options.onModelProgress?.({
          stage: "unavailable",
          operation: "tag-classification",
          message: `Tag classification failed; highlights remain untagged. ${error.message || error}`
        });
      }
    }

    filtered.forEach(sentence => { sentence._paperSummary = summary; });
    return filtered;
  }

  return {
    normalizeText,
    sentenceRanges,
    detectHeading,
    isReferenceHeading,
    isReferenceEntry,
    isNoise,
    paperTextForSummary,
    parseLabeledSummary,
    selectSequence,

    analyze,
    analyzeAsync
  };
})();
