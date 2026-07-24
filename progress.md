# Progress Log

## Non-blocking local model inference
- User selected a dedicated worker thread.
- Added `content/model-worker.mjs` with a cached local Transformers.js runtime, model-cache bridge, persistent pipelines, and worker-side embedding/classification/generation inference.
- Routed model-manager local inference through the worker when available; legacy iframe remains the compatibility fallback.
- Added dedicated summarization, embedding, and classification progress rows to the annotation progress window, plus map/reduce progress for visible local summaries.
- Added a worker-path regression test and documented the dedicated worker behavior.
- Full `yarn test`, all project JavaScript syntax checks (including `content/model-worker.mjs`), and `git diff --check` pass.
