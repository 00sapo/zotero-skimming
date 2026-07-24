# Task Plan: Ollama local summaries and embeddings

## Goal
Replace local Transformers.js/llama.cpp plans with Ollama: Qwen2.5 summary generation plus Qwen3 embeddings for summary and configured-keyword relevance. Replace **Update models** with **Download Ollama models**.

## Decisions
- Require a user-installed Ollama; launch `ollama serve` autonomously when available.
- Open Ollama’s download page when the executable is unavailable.
- Use `Qwen/Qwen2.5-0.5B-Instruct-GGUF` for a locally imported summary model.
- Use `Qwen/Qwen3-Embedding-0.6B-GGUF` for local cosine ranking against paper summary and configured keyword sections.
- Drop local classification and reranking; retain remote summarization/map-reduce.

## Phases
- [completed] Assess llama.cpp/Ollama feasibility and settle model/runtime choices.
- [completed] Replace local runtime with Ollama process/API/model provisioning.
- [completed] Replace NLP local stages with Ollama embedding ranking and revise settings UI.
- [completed] Add tests, documentation, and validate.

## Constraints
- Target Zotero 9 MV2; never silently install Ollama or alter PDFs.
- Keep inference local, using Ollama’s native GPU management.
- Preserve baseline fallback, remote summarization, extraction, geometry, and native annotation creation.
