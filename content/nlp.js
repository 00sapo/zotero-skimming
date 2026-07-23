/* global Zotero, FastKeySentenceModels */

var FastKeySentenceNLP = (() => {
  "use strict";

  const STOP_WORDS = new Set(`a an and are as at be been being but by can could did do does doing for from had has have having he her hers herself him himself his how i if in into is it its itself may might more most must my myself no nor not of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves`.split(/\s+/));
  const SCORING = Object.freeze(FastKeySentenceScoringConfig);

  const ROLE_RULES = [
    { role: "contribution", score: SCORING.roleScores.contribution, re: /\b(we (propose|present|introduce|develop|contribute)|our (main )?contribution|this paper (proposes|presents|introduces)|novel|new (method|approach|framework|architecture))\b/i },
    { role: "result", score: SCORING.roleScores.result, re: /\b(results? (show|demonstrate|indicate|suggest|reveal)|we (achieve|obtain|find|observe|show)|achiev(?:e|ed|es)|improv(?:e|ed|ement)|accuracy of|outperform(?:s|ed)?|state.of.the.art|F1|BLEU|accuracy)\b/i },
    { role: "method", score: SCORING.roleScores.method, re: /\b(method|approach|pipeline|algorithm|architecture|model|framework|we (train|use|apply|compute|construct|evaluate|implement|design))\b/i },
    { role: "goal", score: SCORING.roleScores.goal, re: /\b(aim|objective|goal|focus(?:es)? on|we (study|investigate|evaluate|examine|explore|address)|research question|hypothesis)\b/i },
    { role: "takeaway", score: SCORING.roleScores.takeaway, re: /\b(we conclude|in conclusion|overall|this (shows|demonstrates|indicates)|therefore|thus|these (findings|results) (suggest|indicate|demonstrate)|key (finding|insight|result))\b/i },
    { role: "background", score: SCORING.roleScores.background, re: /\b(background|related work|previous (work|research|studies)|prior (work|art)|state of the art|existing (methods|approaches|systems))\b/i }
  ];

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

    const vectors = [];
    const norms = [];
    const centroid = new Map();
    for (const counts of termCounts) {
      const vector = new Map();
      let norm2 = 0;
      for (const [term, tf] of counts) {
        const idx = vocab.get(term);
        if (idx === undefined) continue;
        const idf = Math.log((n + 1) / ((df.get(term) || 0) + 1)) + 1;
        const value = (1 + Math.log(tf)) * idf;
        vector.set(idx, value);
        centroid.set(idx, (centroid.get(idx) || 0) + value / n);
        norm2 += value * value;
      }
      vectors.push(vector);
      norms.push(Math.sqrt(norm2));
    }
    return { vectors, norms, centroid, centroidNorm: sparseNorm(centroid) };
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



  function minMax(values) {
    if (!values.length) return [];
    const min = Math.min(...values), max = Math.max(...values);
    if (!Number.isFinite(min) || max === min) return values.map(() => 0.5);
    return values.map(value => (value - min) / (max - min));
  }

  function roleFor(text) {
    for (const rule of ROLE_RULES) if (rule.re.test(text)) return rule.role;
    return "background";
  }


  function clusterCentroid(vectors, indexes) {
    return isSparseVector(vectors[0])
      ? sparseCentroid(vectors, indexes)
      : denseCentroid(indexes.map(index => vectors[index]));
  }



  function scoreWithVectors(sentences, vectors, norms, clusterCount, summaryScores = null) {
    if (!sentences.length) return;
    const summarySim = summaryScores || new Array(sentences.length).fill(0);
    const lengths = [];
    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      sentence.role = roleFor(sentence.text);
      const wordCount = sentence.text.split(/\s+/).length;
      lengths.push(Math.exp(-Math.pow(wordCount - 18, 2) / (2 * Math.pow(12, 2))));
    }
    const S = minMax(summarySim);
    const L = minMax(lengths);
    sentences.forEach((sentence, i) => {
      sentence.importance = SCORING.initial.summarySimilarity * S[i]
        + SCORING.initial.sentenceLength * L[i];
      sentence.baseImportance = sentence.importance;
    });
  }

  function scoreSparse(sentences, clusterCount, summaryScores = null) {
    if (!sentences.length) return { vectors: [], norms: [] };
    const { vectors, norms } = buildFeatures(sentences);
    scoreWithVectors(sentences, vectors, norms, clusterCount, summaryScores);
    return { vectors, norms };
  }

  function scoreDense(sentences, vectors, clusterCount, summaryScores = null) {
    const normalizedVectors = vectors.map(vector => Array.from(vector || [], Number));
    const norms = normalizedVectors.map(denseNorm);
    scoreWithVectors(sentences, normalizedVectors, norms, clusterCount, summaryScores);
    return { vectors: normalizedVectors, norms };
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


  function summarySimilaritySpares(sentences, summaryText) {
    if (!summaryText || !sentences.length) return new Array(sentences.length).fill(0);
    const { vectors: sentenceVectors, norms: sentenceNorms } = buildFeatures(sentences);
    const { vectors: [summaryVec] } = buildFeatures([{ text: summaryText }]);
    const summaryNorm = sparseNorm(summaryVec);
    if (!summaryNorm) return new Array(sentences.length).fill(0);
    return sentenceVectors.map((vec, i) => vectorCosine(vec, summaryVec, sentenceNorms[i], summaryNorm));
  }

  function summarySimilarityDense(vectors, norms, summaryEmbedding) {
    if (!summaryEmbedding || !summaryEmbedding.length) return new Array(vectors.length).fill(0);
    const summaryNorm = denseNorm(summaryEmbedding);
    return vectors.map((vec, i) => vectorCosine(vec, summaryEmbedding, norms[i], summaryNorm));
  }

  function analyze(sentences, count) {
    const filtered = sentences.filter(sentence => !isNoise(sentence));
    const { vectors, norms } = scoreSparse(filtered, count);
    return selectMMR(filtered, vectors, norms, Math.min(count, filtered.length));
  }

  function paperTextForSummary(sentences, documentTitle = "") {
    const body = sentences
      .filter(s => normalizeText(s.section || "") !== "abstract")
      .map(s => s.text)
      .filter(Boolean)
      .join(" ");
    return normalizeText([documentTitle, body].filter(Boolean).join(" ")).slice(0, 128000);
  }

  async function analyzeAsync(sentences, count, options = {}) {
    const filtered = sentences.filter(sentence => !isNoise(sentence));
    if (!filtered.length) return [];

    const useLocalModels = options.llmEmbeddings || options.llmClassification;
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

    // 1. Summarize via remote LLM
    options.onModelProgress?.({ stage: "preparing", operation: "summarization" });
    const paperText = paperTextForSummary(filtered, options.documentTitle || "");
    const summary = await FastKeySentenceRemote.summarize(
      paperText,
      options.documentTitle || "",
      count,
      event => options.onModelProgress?.({ ...event, operation: "summarization" })
    );

    // 2. Build embeddings
    let scored;
    if (options.llmEmbeddings && inferenceAvailable) {
      options.onModelProgress?.({ stage: "preparing", operation: "embeddings" });
      const allTexts = [summary, ...filtered.map(sentence => sentence.text)];
      const allEmbeddings = await FastKeySentenceModels.embeddings(
        allTexts,
        !!options.multilingual,
        event => options.onModelProgress?.({ ...event, operation: "embeddings" })
      );
      const summaryEmbedding = allEmbeddings[0];
      const sentenceEmbeddings = allEmbeddings.slice(1);
      const summaryScores = summarySimilarityDense(sentenceEmbeddings,
        sentenceEmbeddings.map(denseNorm), summaryEmbedding);
      scored = scoreDense(filtered, sentenceEmbeddings, count, summaryScores);
    }
    else {
      const summaryScores = summarySimilaritySpares(filtered, summary);
      scored = scoreSparse(filtered, count, summaryScores);
    }

    const shortlist = shortlistIndexes(filtered, count);

    const selected = selectMMR(filtered, scored.vectors, scored.norms, Math.min(count, filtered.length));

    // 3. Classify selected sentences (if enabled)
    if (options.llmClassification && inferenceAvailable && selected.length) {
      options.onModelProgress?.({ stage: "preparing", operation: "classification" });
      const predictions = await FastKeySentenceModels.classify(
        selected.map(s => s.text),
        !!options.multilingual,
        event => options.onModelProgress?.({ ...event, operation: "classification" }),
        options.classificationBatchSize
      );
      selected.forEach((sentence, position) => {
        const prediction = predictions[position] || { role: "background", score: 0 };
        sentence.role = prediction.role || "background";
        sentence.classificationConfidence = Number(prediction.score) || 0;
      });
    }

    // Attach summary to each selected sentence for downstream use
    selected.forEach(s => { s._paperSummary = summary; });
    return selected;
  }

  return {
    normalizeText,
    sentenceRanges,
    detectHeading,
    isReferenceHeading,
    isReferenceEntry,
    isNoise,
    paperTextForSummary,
    analyze,
    analyzeAsync,
    roleFor
  };
})();
