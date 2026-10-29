# Changelog

## Unreleased

- Improve PDF extraction. Remove printed line numbers, table cells, captions, bullets, run-in list labels, superscripts, footnotes, abstract text, and reference entries. Keep column order, paragraph boundaries, complete list sentences, short prose, and logotype small capitals. The committed corpus reaches 99.69 percent balanced accuracy.
- Use model-free ranking by default. Limit diversity selection to a shortlist that keeps section and uncommon-term coverage.
- Reuse sparse sentence features and embed only shortlisted sentences for semantic relevance.
- Normalize sentence importance to a range from 0 to 1. A threshold of 0 shows every eligible sentence, and 100 shows none. The default is 75%.
- Add two downloaded academic templates and 16 controlled PDF layouts with independent expected text, source licenses, and extraction regression metrics.
- Moved all configuration into a native **Settings → Zotero Skimming** pane.
- Removed the sidebar settings overlay, summary dialog, and every alert and progress popup. Status and progress now appear in the reader sidebar.
- Highlights are temporary by default. Generate a preview, adjust the score threshold, then press **Save as Zotero annotations…** to write native highlights.
- Replaced recognizer word geometry with per-character reader geometry for line clustering, repeated-gutter detection, header and footer removal, reference-zone detection, and segmenter-based sentence division.
- Added threshold filtering that reuses the cached selection and does not call the model again.
- Replaced the local Transformers.js/ONNX runtime with Ollama.
- Added explicit **Test Ollama** provisioning for the Qwen3.5 summary and Qwen3 semantic-relevance GGUF models.
- Replaced local embedding/classification stages with optional summary and keyword-section relevance through Qwen3 embeddings.
- Retained local map-reduce with sentence-sized chunks and incremental summaries.
- Added opt-in map-reduce remote summarization with a configurable 4096-token input window.
- Renamed the project to **Zotero Skimming**.
- Updated the project description and Codeberg metadata.
- Added Zotero 10 support and updated the compatibility range in the manifest and update manifest.

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
