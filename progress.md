# Progress Log

## Ollama local summaries and embeddings
- Revised the llama.cpp plan after confirming Ollama has no reranking API.
- User selected Qwen3 embeddings instead of reranking, and a required user-installed Ollama with autonomous service startup/download-page fallback.
- Implemented Ollama model provisioning, summary generation, and dual summary/keyword cosine relevance; removed the ONNX worker/classification stack.
- Updated settings, tests, model identifiers, scoring keywords, README, and changelog.
- Added a configurable Ollama launch command; use `mise exec -- ollama` when mise owns the executable.
- Full `yarn test`, project JavaScript syntax checks, and `git diff --check` pass.
