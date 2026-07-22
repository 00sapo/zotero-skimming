# Task Plan: Classification batching

## Goal
Make local zero-shot classification faster with a persisted, user-configurable batch size.

## Phases
### Implementation
- [x] Add a `classificationBatchSize` setting with a 1–32 validation range and default of 8.
- [x] Add dialog input and RAM-speed explanation.
- [x] Batch zero-shot pipeline calls and retain fallback output handling.
- [x] Pass the setting through ranking to the model manager.

### Verification
- [x] Update unit tests.
- [x] Run `yarn test`, `yarn coverage`, syntax checks, and `git diff --check`.

## Deferred
| Item | Reason |
| Qwen synopsis | The selected official Qwen2.5 ONNX repository has no q8 artifact; user retained q8-only operation. |
