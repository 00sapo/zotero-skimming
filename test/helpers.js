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
      initial: { clusterDispersion: 0.38, textRank: 0.35, scholarlyCues: 0.1, sentenceLength: 0.17 },
      roleScores: { contribution: 1, result: 1, method: 0.75, objective: 0.8, limitation: 0.9, conclusion: 0.9, future: 0.9, dataset: 0.55, context: 0.25 },
      textRank: { similarityThreshold: 0.08, damping: 0.85, maxIterations: 50, windowSize: 240, overlap: 40 },
      classification: { confidence: 0.65, roleSalience: 0.35, priorImportance: 0.78, classificationScore: 0.22 },
      reranking: { priorImportance: 0.65, rerankingScore: 0.35 },
      selection: { importance: 0.72, redundancy: 0.28, sectionPenalty: 0.055 }
    },
    FastKeySentenceModelIdentifiers: {
      embeddings: { en: "Xenova/all-MiniLM-L6-v2", multilingual: "Xenova/multilingual-e5-small" },
      classification: { en: "Xenova/distilbert-base-uncased-mnli", multilingual: "onnx-community/multilingual-MiniLMv2-L6-mnli-xnli-ONNX" },
      reranking: { en: "Xenova/ms-marco-MiniLM-L-6-v2", multilingual: "SugoLabs/mmarco-mMiniLMv2-L12-H384-v1" },
      summarization: { en: "onnx-community/Llama-3.2-1B-Instruct-ONNX", multilingual: "onnx-community/Llama-3.2-1B-Instruct-ONNX" }
    },
    ...globals
  });
  vm.runInContext(fs.readFileSync(path.resolve(file), "utf8"), context, { filename: path.resolve(file) });
  return context;
}

export function sentence(text, order, section = "results") {
  return { text, order, section, pageIndex: 0, rects: [[0, 0, 10, 10]] };
}
