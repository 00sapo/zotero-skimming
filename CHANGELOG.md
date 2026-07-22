# Changelog

## Unreleased

- Renamed the project to **Zotero Skimming**.
- Updated the project description and Codeberg metadata.

## 1.7.0

- Enables local q8 transformer inference after **Update models**.
- Uses the explicitly downloaded Hugging Face files through a custom Transformers.js cache.
- Downloads and loads ONNX Runtime WASM locally.
- Forces single-threaded WASM execution and disables ONNX proxy workers to reduce Zotero runtime instability.
- Integrates embeddings into centroid relevance, TextRank, and MMR; classification and reranking remain independently optional.
- Falls back to the baseline ranker when model initialization fails.

## 1.6.7

- Fixed a native Zotero crash triggered by **Update models**.
- The update action now performs download only and never initializes Transformers.js or ONNX Runtime.
- Quantized q8 model files and tokenizer/config assets are stored in the Zotero profile.
- Added controlled baseline fallback while in-process transformer inference remains disabled.
- Added per-file progress and a local download manifest.
