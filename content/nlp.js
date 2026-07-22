/* global Zotero, FastKeySentenceModels */

var FastKeySentenceNLP = (() => {
  "use strict";

  const STOP_WORDS = new Set(`a an and are as at be been being but by can could did do does doing for from had has have having he her hers herself him himself his how i if in into is it its itself may might more most must my myself no nor not of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves`.split(/\s+/));

  const ROLE_RULES = [
    { role: "contribution", score: 1.00, re: /\b(we (propose|present|introduce|develop|contribute)|our (main )?contribution|this paper (proposes|presents|introduces))\b/i },
    { role: "result", score: 1.00, re: /\b(results? (show|demonstrate|indicate|suggest)|we (achieve|obtain|find|observe)|achiev(?:e|ed|es)|improv(?:e|ed|ement)|accuracy|outperform(?:s|ed)?)\b/i },
    { role: "method", score: 0.75, re: /\b(method|approach|pipeline|algorithm|architecture|model|framework|we (train|use|apply|compute|construct|evaluate))\b/i },
    { role: "objective", score: 0.80, re: /\b(aim|objective|goal|focus(?:es)? on|we (study|investigate|evaluate|examine))\b/i },
    { role: "limitation", score: 0.90, re: /\b(however|limitation|challenge|drawback|error|fails?|difficult|cannot|future work is needed)\b/i },
    { role: "conclusion", score: 0.90, re: /\b(we conclude|in conclusion|overall|this (shows|demonstrates|indicates)|therefore)\b/i },
    { role: "future", score: 0.90, re: /\b(future work|could be extended|we plan|further research|in future)\b/i },
    { role: "dataset", score: 0.55, re: /\b(dataset|corpus|training set|test set|validation set|cross[- ]validation|pages?|samples?|instances?)\b/i }
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
    if (words.length < 8 || words.length > 90) return true;
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

  function denseCentroid(vectors) {
    if (!vectors.length || !vectors[0]?.length) return [];
    const centroid = new Array(vectors[0].length).fill(0);
    for (const vector of vectors) {
      for (let i = 0; i < centroid.length; i++) centroid[i] += Number(vector[i]) || 0;
    }
    for (let i = 0; i < centroid.length; i++) centroid[i] /= vectors.length;
    return centroid;
  }

  function textRank(vectors, norms, windowSize = 240, overlap = 40) {
    const n = vectors.length;
    const global = new Array(n).fill(0);
    const step = Math.max(1, windowSize - overlap);
    for (let start = 0; start < n; start += step) {
      const end = Math.min(n, start + windowSize);
      const m = end - start;
      const graph = Array.from({ length: m }, () => []);
      for (let i = 0; i < m; i++) {
        for (let j = i + 1; j < m; j++) {
          const w = vectorCosine(vectors[start + i], vectors[start + j], norms[start + i], norms[start + j]);
          if (w >= 0.08) {
            graph[i].push([j, w]);
            graph[j].push([i, w]);
          }
        }
      }
      let rank = new Array(m).fill(1 / Math.max(1, m));
      for (let iter = 0; iter < 50; iter++) {
        const next = new Array(m).fill((1 - 0.85) / Math.max(1, m));
        for (let i = 0; i < m; i++) {
          const sum = graph[i].reduce((total, [, weight]) => total + weight, 0);
          if (!sum) continue;
          for (const [j, weight] of graph[i]) next[j] += 0.85 * rank[i] * weight / sum;
        }
        const delta = next.reduce((total, value, i) => total + Math.abs(value - rank[i]), 0);
        rank = next;
        if (delta < 1e-7) break;
      }
      rank.forEach((value, i) => { global[start + i] = Math.max(global[start + i], value); });
      if (end === n) break;
    }
    return global;
  }

  function minMax(values) {
    if (!values.length) return [];
    const min = Math.min(...values), max = Math.max(...values);
    if (!Number.isFinite(min) || max === min) return values.map(() => 0.5);
    return values.map(value => (value - min) / (max - min));
  }

  function roleFor(text) {
    for (const rule of ROLE_RULES) if (rule.re.test(text)) return { role: rule.role, score: rule.score };
    return { role: "context", score: 0.25 };
  }

  const ROLE_SALIENCE = Object.freeze({
    contribution: 1.00,
    result: 1.00,
    limitation: 0.90,
    conclusion: 0.90,
    future: 0.90,
    objective: 0.80,
    method: 0.75,
    dataset: 0.55,
    context: 0.25
  });

  function sparseCentroid(vectors, indexes) {
    const centroid = new Map();
    for (const index of indexes) {
      for (const [key, value] of vectors[index]) centroid.set(key, (centroid.get(key) || 0) + value / indexes.length);
    }
    return centroid;
  }

  function clusterCentroid(vectors, indexes) {
    return isSparseVector(vectors[0])
      ? sparseCentroid(vectors, indexes)
      : denseCentroid(indexes.map(index => vectors[index]));
  }

  function kMeans(vectors, norms, count) {
    const clusters = Math.min(vectors.length, Math.max(1, Math.floor(Number(count) || 1)));
    let centroids = Array.from({ length: clusters }, (_, i) => clusterCentroid(vectors, [Math.floor(i * vectors.length / clusters)]));
    let assignments = new Array(vectors.length).fill(-1);
    for (let iteration = 0; iteration < 20; iteration++) {
      const centroidNorms = centroids.map(vectorNorm);
      const next = vectors.map((vector, i) => {
        let best = 0, similarity = -Infinity;
        for (let cluster = 0; cluster < clusters; cluster++) {
          const value = vectorCosine(vector, centroids[cluster], norms[i], centroidNorms[cluster]);
          if (value > similarity) {
            similarity = value;
            best = cluster;
          }
        }
        return best;
      });
      const unchanged = next.every((cluster, i) => cluster === assignments[i]);
      assignments = next;
      const members = Array.from({ length: clusters }, () => []);
      assignments.forEach((cluster, i) => members[cluster].push(i));
      centroids = centroids.map((centroid, cluster) => members[cluster].length ? clusterCentroid(vectors, members[cluster]) : centroid);
      if (unchanged) break;
    }
    return assignments;
  }

  function clusterDispersionRelevance(vectors, norms, count) {
    if (!vectors.length) return [];
    const assignments = kMeans(vectors, norms, count);
    const clusterCount = Math.min(vectors.length, Math.max(1, Math.floor(Number(count) || 1)));
    const candidates = new Array(clusterCount).fill(-1);
    const distances = new Array(clusterCount).fill(-Infinity);
    for (let i = 0; i < vectors.length; i++) {
      let minimum = Infinity;
      for (let j = 0; j < vectors.length; j++) {
        if (assignments[i] === assignments[j]) continue;
        minimum = Math.min(minimum, 1 - vectorCosine(vectors[i], vectors[j], norms[i], norms[j]));
      }
      if (!Number.isFinite(minimum)) minimum = 1;
      const cluster = assignments[i];
      if (minimum > distances[cluster]) {
        distances[cluster] = minimum;
        candidates[cluster] = i;
      }
    }
    const selectedDistances = minMax(distances);
    const relevance = new Array(vectors.length).fill(0);
    candidates.forEach((index, cluster) => {
      relevance[index] = candidates.length === 1 ? 1 : selectedDistances[cluster];
    });
    return relevance;
  }

  function scoreWithVectors(sentences, vectors, norms, clusterCount) {
    if (!sentences.length) return;
    const relevance = clusterDispersionRelevance(vectors, norms, clusterCount);
    const centrality = textRank(vectors, norms);
    const cues = [];
    const lengths = [];
    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      const role = roleFor(sentence.text);
      sentence.role = role.role;
      cues.push(role.score + (/\b\d+(?:\.\d+)?%\b/.test(sentence.text) ? 0.25 : 0));
      const wordCount = sentence.text.split(/\s+/).length;
      lengths.push(Math.exp(-Math.pow(wordCount - 27, 2) / (2 * Math.pow(18, 2))));
    }
    const R = minMax(relevance);
    const C = minMax(centrality);
    const Q = minMax(cues);
    const L = minMax(lengths);
    sentences.forEach((sentence, i) => {
      sentence.importance = 0.38 * R[i] + 0.35 * C[i] + 0.10 * Q[i] + 0.17 * L[i];
      sentence.baseImportance = sentence.importance;
    });
  }

  function scoreSparse(sentences, clusterCount) {
    if (!sentences.length) return { vectors: [], norms: [] };
    const { vectors, norms } = buildFeatures(sentences);
    scoreWithVectors(sentences, vectors, norms, clusterCount);
    return { vectors, norms };
  }

  function scoreDense(sentences, vectors, clusterCount) {
    const normalizedVectors = vectors.map(vector => Array.from(vector || [], Number));
    const norms = normalizedVectors.map(denseNorm);
    scoreWithVectors(sentences, normalizedVectors, norms, clusterCount);
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
        const sectionPenalty = 0.055 * (sectionCounts.get(sentences[i].section || "") || 0);
        const value = 0.72 * sentences[i].importance - 0.28 * redundancy - sectionPenalty;
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

  function shortlistIndexes(sentences, count) {
    const limit = Math.min(sentences.length, Math.max(60, Math.min(160, count * 4)));
    return sentences
      .map((sentence, index) => ({ index, importance: sentence.importance }))
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit)
      .map(entry => entry.index);
  }

  function rerankingQuery(sentences, documentTitle = "") {
    const abstract = sentences
      .filter(sentence => /abstract/.test(sentence.section || ""))
      .slice(0, 6)
      .map(sentence => sentence.text)
      .join(" ");
    const fallback = sentences.slice(0, 4).map(sentence => sentence.text).join(" ");
    return normalizeText([documentTitle, abstract || fallback].filter(Boolean).join(". ")).slice(0, 1800);
  }

  function analyze(sentences, count) {
    const filtered = sentences.filter(sentence => !isNoise(sentence));
    const { vectors, norms } = scoreSparse(filtered, count);
    return selectMMR(filtered, vectors, norms, Math.min(count, filtered.length));
  }

  async function analyzeAsync(sentences, count, options = {}) {
    const filtered = sentences.filter(sentence => !isNoise(sentence));
    if (!filtered.length) return [];

    const useModels = options.llmEmbeddings || options.llmClassification || options.llmRerankings;
    if (useModels && typeof FastKeySentenceModels === "undefined") {
      throw new Error("The transformer model manager was not loaded.");
    }

    const inferenceAvailable = !useModels || FastKeySentenceModels.supportsInference?.();
    if (useModels && !inferenceAvailable) {
      options.onModelProgress?.({
        stage: "unavailable",
        operation: "runtime",
        message: "Transformer inference is unavailable. Using the baseline ranker."
      });
    }

    let scored;
    if (options.llmEmbeddings && inferenceAvailable) {
      try {
        options.onModelProgress?.({ stage: "preparing", operation: "embeddings" });
        const embeddings = await FastKeySentenceModels.embeddings(
          filtered.map(sentence => sentence.text),
          !!options.multilingual,
          event => options.onModelProgress?.({ ...event, operation: "embeddings" })
        );
        scored = scoreDense(filtered, embeddings, count);
      }
      catch (error) {
        options.onModelProgress?.({
          stage: "fallback",
          operation: "embeddings",
          message: `Embedding inference failed; using TF-IDF instead: ${error?.message || error}`
        });
        scored = scoreSparse(filtered, count);
      }
    }
    else {
      scored = scoreSparse(filtered, count);
    }

    let shortlist = shortlistIndexes(filtered, count);

    if (options.llmClassification && inferenceAvailable && shortlist.length) {
      try {
        options.onModelProgress?.({ stage: "preparing", operation: "classification" });
        const predictions = await FastKeySentenceModels.classify(
          shortlist.map(index => filtered[index].text),
          !!options.multilingual,
          event => options.onModelProgress?.({ ...event, operation: "classification" }),
          options.classificationBatchSize
        );
        const rawScores = predictions.map(prediction => {
          const salience = ROLE_SALIENCE[prediction.role] ?? ROLE_SALIENCE.context;
          return 0.65 * Math.max(0, Math.min(1, prediction.score || 0)) + 0.35 * salience;
        });
        const normalized = minMax(rawScores);
        shortlist.forEach((index, position) => {
          const prediction = predictions[position] || { role: "context", score: 0 };
          filtered[index].role = prediction.role || "context";
          filtered[index].classificationConfidence = Number(prediction.score) || 0;
          filtered[index].importance = 0.78 * filtered[index].importance + 0.22 * normalized[position];
        });
        shortlist = shortlistIndexes(filtered, count);
      }
      catch (error) {
        options.onModelProgress?.({
          stage: "fallback",
          operation: "classification",
          message: `Classification failed; retaining heuristic roles: ${error?.message || error}`
        });
      }
    }

    if (options.llmRerankings && inferenceAvailable && shortlist.length) {
      try {
        const query = rerankingQuery(filtered, options.documentTitle || "");
        options.onModelProgress?.({ stage: "preparing", operation: "reranking" });
        const scores = await FastKeySentenceModels.rerank(
          query,
          shortlist.map(index => filtered[index].text),
          !!options.multilingual,
          event => options.onModelProgress?.({ ...event, operation: "reranking" })
        );
        const normalized = minMax(scores);
        shortlist.forEach((index, position) => {
          filtered[index].rerankingScore = Number(scores[position]) || 0;
          filtered[index].importance = 0.65 * filtered[index].importance + 0.35 * normalized[position];
        });
      }
      catch (error) {
        options.onModelProgress?.({
          stage: "fallback",
          operation: "reranking",
          message: `Re-ranking failed; retaining the first-stage scores: ${error?.message || error}`
        });
      }
    }

    return selectMMR(filtered, scored.vectors, scored.norms, Math.min(count, filtered.length));
  }

  return {
    normalizeText,
    sentenceRanges,
    detectHeading,
    isReferenceHeading,
    isReferenceEntry,
    analyze,
    analyzeAsync,
    roleFor
  };
})();
