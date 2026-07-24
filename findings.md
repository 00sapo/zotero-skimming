# Findings & Decisions

## Ollama local inference
- Ollama resolves the official llama.cpp release/backend problem: it manages Metal, CUDA, ROCm, and Vulkan across supported platforms.
- Ollama exposes generation and embeddings APIs but no documented reranking endpoint. User chose Qwen3 embeddings with cosine similarity instead of the requested reranker.
- User chose a required existing Ollama installation: the add-on starts `ollama serve` when possible and opens Ollama’s download page if the executable is unavailable. It must not install software silently.
- Local GGUF files are explicitly downloaded into the Zotero profile then imported through `/api/create` into named Ollama models. The former ONNX runtime, worker, and classification model are removed.
