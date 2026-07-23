import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

export function loadScript(file, globals = {}) {
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    URL,
    Blob,
    Response,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    FastKeySentenceScoringConfig: {
      initial: { clusterDispersion: 0.15, textRank: 0.10, summarySimilarity: 0.55, scholarlyCues: 0.08, sentenceLength: 0.12 },
      roleScores: { background: 0.20, method: 0.60, contribution: 1.00, result: 0.85, takeaway: 0.90, goal: 0.55 },
      textRank: { similarityThreshold: 0.08, damping: 0.85, maxIterations: 50, windowSize: 240, overlap: 40 },
      classification: { confidence: 0.65, roleSalience: 0.35, priorImportance: 0.7, classificationScore: 0.3 },
      selection: { importance: 0.65, redundancy: 0.35, sectionPenalty: 0.06 }
    },
    FastKeySentenceModelIdentifiers: {
      embeddings: { en: "Xenova/all-MiniLM-L6-v2", multilingual: "Xenova/multilingual-e5-small" },
      classification: { en: "Xenova/mobilebert-uncased-mnli", multilingual: "onnx-community/multilingual-MiniLMv2-L6-mnli-xnli-ONNX" }
    },
    ...globals
  });
  vm.runInContext(fs.readFileSync(path.resolve(file), "utf8"), context, { filename: path.resolve(file) });
  return context;
}

export function sentence(text, order, section = "results") {
  return { text, order, section, pageIndex: 0, rects: [[0, 0, 10, 10]] };
}
