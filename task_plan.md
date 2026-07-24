# Task Plan: Non-blocking local model inference

## Goal
Run local Qwen summarization, embeddings, and classification in a persistent dedicated worker thread, with per-stage progress bars that keep Zotero responsive.

## Phases
- [completed] Assess the current hidden-iframe runtime and confirm isolation level.
- [completed] Add worker runtime/cache bridge and route all local inference through it.
- [completed] Add per-stage progress bars and streamed progress handling.
- [completed] Add regression tests, document worker behavior, and validate.

## Constraints
- Zotero 9 manifest-v2; no external helper process or network inference.
- Keep explicit model downloads/local cache, int8 Qwen, q8 embedding/classification, single-threaded WASM, and disabled ONNX proxy workers.
- Retain the legacy hidden-iframe runtime only as a compatibility fallback if dedicated workers are unavailable.
