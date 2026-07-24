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
      initial: { summarySimilarity: 0.85, sentenceLength: 0.15 },
      selection: { importance: 0.65, redundancy: 0.35, sectionPenalty: 0.06 }
    },
    FastKeySentenceModelIdentifiers: {
      embeddings: { repository: "Qwen/Qwen3-Embedding-0.6B-GGUF", model: "zotero-skimming-embedding" },
      summarization: { repository: "Qwen/Qwen2.5-0.5B-Instruct-GGUF", model: "zotero-skimming-summary" }
    },
    ...globals
  });
  vm.runInContext(fs.readFileSync(path.resolve(file), "utf8"), context, { filename: path.resolve(file) });
  return context;
}

export function sentence(text, order, section = "results") {
  return { text, order, section, pageIndex: 0, rects: [[0, 0, 10, 10]] };
}
