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
