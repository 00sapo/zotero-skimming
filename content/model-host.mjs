const RUNTIME_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js";

try {
  const Transformers = await import(RUNTIME_URL);
  globalThis.FastKeySentenceTransformers = Transformers;
  globalThis.dispatchEvent(new CustomEvent("fast-key-sentence-transformers-ready"));
}
catch (error) {
  globalThis.dispatchEvent(new CustomEvent("fast-key-sentence-transformers-error", {
    detail: error?.message || String(error)
  }));
}
