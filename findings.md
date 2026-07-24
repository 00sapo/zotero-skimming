# Findings & Decisions

## Dedicated local inference worker
- Current Transformers.js inference runs inside a hidden iframe on Zotero's UI thread; async calls do not prevent CPU-heavy ONNX inference from blocking the interface.
- Decision: user chose a dedicated worker thread over an external OS process.
- `content/model-worker.mjs` hosts Transformers.js and ONNX WASM. `content/model-manager.js` supplies locally cached runtime/WASM bytes at initialization and answers worker cache-read requests with local model bytes; no model download occurs during inference.
- The worker maintains pipeline instances and emits pipeline-load and inference progress messages. It uses single-threaded WASM with ONNX proxy workers disabled.
- The hidden iframe is retained only when the Zotero window does not support module workers.
