# Task Plan: Incremental Qwen map-reduce

## Goal
Add 5% overlap between local Qwen map windows and use the running article summary in each subsequent map prompt.

## Phases
- [completed] Inspect local map-reduce, callers, and summary-sentence targets.
- [completed] Add overlap, incremental prompt context, and propagated sentence targets.
- [completed] Update regression tests, documentation, and validate.

## Constraints
- Local Qwen only; retain remote map-reduce behavior.
- Preserve context-window limits, int8 Qwen, local worker execution, and progress events.
