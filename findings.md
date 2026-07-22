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
|---|---|
| Vitest + v8 | User-approved test/coverage stack. |
| Development dependencies only | The Zotero add-on remains dependency-free at runtime. |

## Issues Encountered
| Issue | Resolution |
|---|---|
| None | — |
