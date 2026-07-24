# Progress Log

## Incremental Qwen map-reduce
- Added local 5% token-budget overlap via `overlapTail()` and sequential running-summary reduction.
- Updated Qwen prompts to include the prior summary where present and an explicit computed sentence target.
- Propagated sentence targets from ranking and visible-summary paths; targeted tests, syntax checks, and `git diff --check` pass.
- Full `yarn test`, all project JavaScript syntax checks, and `git diff --check` pass.
