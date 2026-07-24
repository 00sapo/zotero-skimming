# Progress Log

## Local Qwen summarization
- Recovered current uncommitted map-reduce work; do not overwrite it. Modified: `CHANGELOG.md`, `README.md`, `content/annotator.js`, `content/remote-llm.js`, planning files, `test/annotator.test.js`; new untracked `test/remote-llm.test.js`.
- Located the prior local Qwen implementation in commit `d6dbc2c`, which is the direct restoration reference.
- User chose local-or-remote routing; the existing remote map-reduce path remains available.
- Restored local Qwen text generation with `onnx-community/Qwen2.5-0.5B-Instruct`, `dtype: "int8"`, and explicit `onnx/model_int8.onnx` download selection.
- Added source settings/UI, routing for visible and ranking summaries, baseline fallback on local-summary failure, regression tests, and documentation.
- Full `yarn test`, all required JavaScript syntax checks, and `git diff --check` pass.
