# Task Plan: Local Qwen summarization

## Goal
Restore optional local paper summarization using `onnx-community/Qwen2.5-0.5B-Instruct` with its int8 ONNX asset, without changing the existing local cache/runtime safeguards.

## Phases
- [completed] Recover the prior Qwen implementation and assess current integration points.
- [completed] Confirm coexistence: user chose a persisted local-or-remote source selector.
- [completed] Restore model identifier, int8 download selection, local generation, settings, and ranking/visible-summary routing.
- [completed] Add regression tests, document behavior, and validate.

## Constraints
- Zotero 9 manifest-v2; Transformers.js runtime is locally cached and runs single-threaded WASM with ONNX proxy workers disabled.
- Preserve explicit `Update models` downloads, existing q8 selection for embedding/classification models, and int8 selection for Qwen.
- Preserve the existing remote map-reduce feature until the user explicitly elects to remove it.
