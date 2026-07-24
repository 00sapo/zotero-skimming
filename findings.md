# Findings & Decisions

## Local Qwen summarization
- The repository previously implemented this exact model in commit `d6dbc2c`: `text-generation` through `FastKeySentenceModels.summarize()`, deterministic generation (`do_sample: false`), `max_new_tokens: 240`, and ChatML prompt delimiters.
- That implementation selected `onnx-community/Qwen2.5-0.5B-Instruct` under a `summarization` model identifier and included it in `Update models` only when `llmSummarization` was enabled.
- The current model manager retains the required runtime/cache/q8 behavior. It has no local summary method; remote summarization is currently required by settings and drives ranking and the visible summary.
- Decision: user chose a persisted local-or-remote source selector, retaining remote map-reduce.
- The Qwen model manifest includes `onnx/model_int8.onnx` but no q8 file. Local Qwen loading and its download manifest must use `dtype: "int8"`; existing embedding/classification models remain q8.
