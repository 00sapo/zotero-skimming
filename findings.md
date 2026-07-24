# Findings & Decisions

## Incremental Qwen map-reduce
- Local map-reduce previously summarized chunks independently, then recursively reduced the generated summaries; it had no source overlap.
- Decision: adjacent local map windows overlap by 5% of the map-input token budget. The first chunk starts a summary; each later chunk receives the running summary in the exact requested prompt form.
- Each local map call uses `max(1, requestedSentenceCount - (chunkCount - 1))` sentences, reserving a sentence per remaining map transition. NLP supplies approximately `annotationCount × 1.5`; visible summaries request 10 sentences.
