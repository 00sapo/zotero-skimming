/* global Zotero, FastKeySentenceModels, FastKeySentenceRemote, FastKeySentenceZeroShot */

var FastKeySentenceNLP = (() => {
  "use strict";

  const STOP_WORDS = new Set(`a an and are as at be been being but by can could did do does doing for from had has have having he her hers herself him himself his how i if in into is it its itself may might more most must my myself no nor not of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves`.split(/\s+/));
  // ── keyword section descriptions (fallback when scoring-config is unavailable) ──

  const SCORING = Object.freeze(FastKeySentenceScoringConfig);

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

  function selectMMR(sentences, vectors, norms, count, summarySentences = null) {
    const selected = [];
    const remaining = new Set(sentences.map((_, i) => i));
    const sectionCounts = new Map();

    const summaryVecs = summarySentences ? summarySentences.map(s => s.vector) : null;
    const summaryNorms = summarySentences ? summarySentences.map(s => s.norm) : null;
    const m = summaryVecs ? summaryVecs.length : 0;
    const n = sentences.length;

    const M = m ? Array.from({ length: n }, () => new Array(m).fill(0)) : null;
    if (M) {
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < m; j++) {
          M[i][j] = vectorCosine(vectors[i], summaryVecs[j], norms[i], summaryNorms[j]);
        }
      }
    }

    while (selected.length < count && remaining.size) {
      let penalty = 0;
      if (M) {
        let sum = 0, sumSq = 0, vals = 0;
        for (const i of remaining) {
          for (let j = 0; j < m; j++) {
            const v = M[i][j];
            sum += v;
            sumSq += v * v;
            vals++;
          }
        }
        const mean = sum / vals;
        const sd = Math.sqrt(Math.max(0, sumSq / vals - mean * mean));
        penalty = 0.1 * sd;
      }

      let best = -1, bestScore = -Infinity;
      for (const i of remaining) {
        let redundancy = 0;
        for (const j of selected) {
          redundancy = Math.max(redundancy, vectorCosine(vectors[i], vectors[j], norms[i], norms[j]));
        }
        let coverageBonus = 0;
        if (M) {
          for (let j = 0; j < m; j++) {
            if (M[i][j] > coverageBonus) coverageBonus = M[i][j];
          }
        }
        const sectionPenalty = SCORING.selection.sectionPenalty * (sectionCounts.get(sentences[i].section || "") || 0);
        const value = SCORING.selection.importance * sentences[i].importance
          + SCORING.selection.importance * coverageBonus
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

      if (M) {
        let bestJ = 0;
        for (let j = 0; j < m; j++) {
          if (M[best][j] > M[best][bestJ]) bestJ = j;
        }
        for (const i of remaining) {
          M[i][bestJ] = Math.max(0, M[i][bestJ] - penalty);
        }
      }
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

  function paperTextForSummary(sentences) {
    const body = sentences
      .filter(s => !s.frontMatter && normalizeText(s.section || "") !== "abstract")
      .map(s => s.text)
      .filter(Boolean)
      .join(" ");
    return normalizeText(body).slice(0, 128000);
  }

  async function analyzeAsync(sentences, count, options = {}) {
    const filtered = sentences.filter(sentence => !isNoise(sentence));
    if (!filtered.length) return [];

    const useLocalSummary = options.summarySource === "local";
    const useLocalRelevance = options.localRelevance === true;
    const useLocalModels = useLocalSummary || useLocalRelevance;
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

    // 1. Summarize via the selected source
    options.onModelProgress?.({ stage: "preparing", operation: "summarization" });
    const paperText = paperTextForSummary(filtered);
    let summary = "";
    let localSummaryFailed = false;
    if (useLocalSummary) {
      if (inferenceAvailable) {
        try {
          summary = await FastKeySentenceModels.summarize(
            paperText,
            event => options.onModelProgress?.({ ...event, operation: "summarization" }),
            {
              mapReduce: options.mapReduce === true,
              mapReduceSentences: options.mapReduceSentences,
              sentenceCount: Math.max(3, Math.round(count * 1.5))
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
    }
    else {
      summary = await FastKeySentenceRemote.summarize(
        paperText,
        options.documentTitle || "",
        count,
        event => options.onModelProgress?.({ ...event, operation: "summarization" })
      );
    }

    // 2. Score sparse baseline, then apply dense summary relevance if embeddings are available.
    const summaryScores = summarySimilaritySpares(filtered, summary);
    const scored = scoreSparse(filtered, count, summaryScores);
    const useRemoteEmbed = !localSummaryFailed && summary && typeof FastKeySentenceRemote?.embeddings === "function";
    const useLocalEmbed = inferenceAvailable && !localSummaryFailed && summary;
    if (useLocalRelevance && (useRemoteEmbed || useLocalEmbed)) {
      const embedFn = options.summarySource === "local" || !useRemoteEmbed
        ? FastKeySentenceModels.embeddings
        : FastKeySentenceRemote.embeddings;
      const withProgress = (texts, operation) => options.onModelProgress?.({
        stage: Array.isArray(texts) && texts.length > 5 ? "preparing" : "inference",
        operation
      });
      try {
        options.onModelProgress?.({ stage: "preparing", operation: "summary-relevance" });
        const texts = filtered.map(sentence => sentence.text);
        const [summaryEmbedding, ...sentenceEmbeddings] = await embedFn(
          [summary, ...texts],
          event => options.onModelProgress?.({ ...event, operation: "summary-relevance" })
        );
        const sentenceNorms = sentenceEmbeddings.map(denseNorm);
        const denseRelevance = summarySimilarityDense(sentenceEmbeddings, sentenceNorms, summaryEmbedding);
        const lengths = filtered.map(s => Math.exp(-Math.pow(s.text.split(/\s+/).length - 18, 2) / (2 * Math.pow(12, 2))));
        const S = minMax(denseRelevance);
        const L = minMax(lengths);
        filtered.forEach((sentence, index) => {
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

    const shortlistSize = Math.min(filtered.length, Math.max(count * 4, 60), 160);
    const shortlist = filtered
      .map((sentence, index) => ({ index, importance: sentence.importance || 0 }))
      .sort((a, b) => b.importance - a.importance)
      .slice(0, shortlistSize)
      .map(entry => entry.index);

    // Embed summary sentences for MMR coverage encouragement
    let summaryParts = null;
    if (summary && (useLocalRelevance || options.summarySource === "remote")) {
      try {
        const summarySentences = sentenceRanges(summary).map(([s, e]) => summary.slice(s, e)).filter(Boolean);
        if (summarySentences.length > 1) {
          const remoteAvailable = typeof FastKeySentenceRemote?.embeddings === "function";
          const embedFn = options.summarySource === "remote" && remoteAvailable
            ? FastKeySentenceRemote.embeddings
            : FastKeySentenceModels.embeddings;
          const vectors = await embedFn(
            summarySentences,
            event => options.onModelProgress?.({ ...event, operation: "summary-relevance" })
          );
          summaryParts = vectors.map((vec, index) => ({ vector: vec.map(Number), norm: denseNorm(vec), text: summarySentences[index] }));
        }
      }
      catch (_) {}
    }

    const selected = selectMMR(filtered, scored.vectors, scored.norms, Math.min(count, filtered.length), summaryParts);

    const doZeroShot = options.zeroShotLabels === true;
    const dbg = typeof Services !== "undefined" ? msg => Services.console.logStringMessage(msg) : () => {};
    dbg(`Zotero Skimming: tag-classification entry — selected=${selected.length} zeroShotLabels=${doZeroShot} summarySource=${options.summarySource || "local"}`);
    if (doZeroShot && selected.length) {
      try {
        options.onModelProgress?.({ stage: "preparing", operation: "tag-classification" });

        const labels = FastKeySentenceZeroShot.parseConfig(options.zeroShotConfig || FastKeySentenceZeroShot.DEFAULT_CONFIG);
        const labelDescs = new Map(labels.map(l => [l.name, l.description]));
        dbg(`Zotero Skimming: tag-classification — ${labels.length} labels parsed: ${labels.map(l => l.name).join(", ")}`);

        const remoteAvailable = typeof FastKeySentenceRemote?.embeddings === "function";
        const useRemoteClassify = options.summarySource === "remote" && remoteAvailable;
        const primaryEmbed = useRemoteClassify ? FastKeySentenceRemote.embeddings : FastKeySentenceModels.embeddings;
        const fallbackEmbed = useRemoteClassify ? FastKeySentenceModels.embeddings : (remoteAvailable ? FastKeySentenceRemote.embeddings : null);
        dbg(`Zotero Skimming: tag-classification — embed source: ${useRemoteClassify ? "remote" : "local"}, fallback: ${fallbackEmbed ? "available" : "none"}`);

        const embeddingModel = {
          embed: async (texts) => {
            try {
              return await primaryEmbed(texts,
                event => options.onModelProgress?.({ ...event, operation: "tag-classification" }));
            }
            catch (primaryError) {
              if (!fallbackEmbed) throw primaryError;
              options.onModelProgress?.({
                stage: "unavailable",
                operation: "tag-classification",
                message: `Primary embedding failed; trying fallback. ${primaryError.message || primaryError}`
              });
              return await fallbackEmbed(texts,
                event => options.onModelProgress?.({ ...event, operation: "tag-classification" }));
            }
          }
        };

        const classifier = await FastKeySentenceZeroShot.createClassifier({
          embeddingModel,
          config: options.zeroShotConfig
        });
        dbg(`Zotero Skimming: tag-classification — classifier created, ${classifier.labels.length} classifier labels`);

        const byOrder = new Map();
        for (const s of filtered) byOrder.set(s.order, s);
        const sortedOrders = [...byOrder.keys()].sort((a, b) => a - b);
        const orderToPos = new Map(sortedOrders.map((o, i) => [o, i]));

        let classified = 0;
        for (const sentence of selected) {
          const pos = orderToPos.get(sentence.order);
          if (pos === undefined) { dbg(`Zotero Skimming: tag-classification — sentence order=${sentence.order} not in orderToPos, skipping`); continue; }

          const prev = [sortedOrders[pos - 2], sortedOrders[pos - 1]]
            .filter(o => byOrder.has(o))
            .map(o => byOrder.get(o).text);
          const next = [sortedOrders[pos + 1], sortedOrders[pos + 2]]
            .filter(o => byOrder.has(o))
            .map(o => byOrder.get(o).text);

          const contextText = `Previous: ${prev.join(" ")}\nTarget: ${sentence.text}\nNext: ${next.join(" ")}`;

          const result = await classifier.classify(sentence.text, contextText);
          const labelName = result.predicted.replace(/^\[|\]$/g, "");
          sentence.tag = labelName;
          sentence.tagDescription = labelDescs.get(result.predicted) || "";
          sentence.tagIndex = classifier.labels.findIndex(l => l.name === result.predicted);
          sentence.tagScore = result.scores[result.predicted] || 0;
          classified++;
          dbg(`Zotero Skimming: tag-classification — sentence #${classified} tag=${sentence.tag} tagIndex=${sentence.tagIndex} predicted=${result.predicted} margin=${result.margin?.toFixed(3)}`);
        }
        dbg(`Zotero Skimming: tag-classification — done: ${classified}/${selected.length} sentences tagged`);
      }
      catch (error) {
        const msg = error?.message || String(error);
        const stack = error?.stack || "";
        if (typeof Services !== "undefined") Services.console.logStringMessage(`Zotero Skimming: tag-classification FAILED — ${msg}\n${stack}`);
        Zotero.debug(`Zotero Skimming: tag classification failed — ${msg}\n${stack}`);
        options.onModelProgress?.({
          stage: "unavailable",
          operation: "tag-classification",
          message: `Tag classification failed; highlights remain untagged. ${error.message || error}`
        });
      }
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
    analyzeAsync
  };
})();
