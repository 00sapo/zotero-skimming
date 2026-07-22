# Findings & Decisions

## Requirements
- Add automated tests achieving >90% coverage for JavaScript files.
- Use Vitest with v8 coverage, explicitly selected by the user.
- Preserve the production add-on's dependency-free, Zotero 9/Gecko runtime.

## Research Findings
- The project has no package manager metadata, test runner, or coverage configuration.
- JavaScript totals 2,518 lines: `bootstrap.js` 47; `content/annotator.js` 1,391; `content/model-manager.js` 580; `content/nlp.js` 488; `content/model-host.mjs` 12.
- Runtime modules are global IIFEs and depend on Zotero/Gecko APIs; tests require a controlled global environment or explicit test-only module exposure.

## Technical Decisions
| Decision | Rationale |
| Vitest + v8 | User-approved test/coverage stack. |
| Development dependencies only | The Zotero add-on remains dependency-free at runtime. |
| Per-file 90% statements/functions/lines | User selected this scope; branch coverage remains reported, not gated. |

## Qwen summarization integration
- User selected Qwen2.5-0.5B-Instruct to generate a paper synopsis, appended to the title and abstract before cross-encoder reranking.
- `onnx-community/Qwen2.5-0.5B-Instruct-ONNX` provides `onnx/model_q4.onnx`, `model_uint8.onnx`, and `model_quantized.onnx`, but no `*_q8.onnx`.
- Current model manager intentionally permits only `*_q8.onnx` / legacy `model_quantized.onnx`, globally uses `dtype: "q8"`, and project constraints require retaining q8 selection.

## Issues Encountered
| Issue | Resolution |
| Qwen has no q8 ONNX artifact | Pending explicit user decision: permit a per-summarizer q4/uint8 exception, or select a different model. |
