# Progress Log

## Session: 2026-07-22

### Automated test coverage
- **Status:** complete
- `yarn test`: 44 tests passed.
- `yarn coverage`: 95.35% statements, 94.90% functions, 97.08% lines; per-file 90% gate passes.
- JS syntax checks: pass.

### Qwen synopsis for reranking
- **Status:** blocked by q8-only constraint
- Inspected `onnx-community/Qwen2.5-0.5B-Instruct-ONNX`: it has q4, int8, uint8, and legacy quantized ONNX artifacts, but no `model_q8.onnx`.
- User explicitly chose to retain q8-only operation.
- A search found no Qwen2.5 0.5B ONNX repository with a direct q8 export. One third-party Qwen2 repository contains `model_quantized.onnx` plus many external weight files, which the downloader cannot safely or currently support; it is not an acceptable substitute for the selected official Qwen2.5 model.

## Error Log
| Error | Attempt | Resolution |
|---|---:|---|
| Qwen ONNX repository has no q8 artifact | 1 | Do not implement under the q8-only requirement; wait for a compatible official export or authorize a format exception. |
