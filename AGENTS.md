# AGENTS.md

## Project

Zotero 9 add-on that finds salient prose sentences in academic PDFs and saves them as native Zotero highlight annotations. It is a dependency-free, manifest-v2 extension loaded from `bootstrap.js`.

## Layout

- `manifest.json` — add-on identity, version, and Zotero 9 compatibility.
- `bootstrap.js` — lifecycle hooks; loads scripts in dependency order.
- `content/annotator.js` — Zotero UI, persisted settings, the settings pane wiring, temporary reader overlays, threshold filtering, and native annotation creation.
- `content/extractor.js` — geometry-based all-page PDF extraction: character clustering, reading order, page furniture and reference zoning, and sentence segmentation.
- `content/nlp.js` — model-free NLP baseline: filtering, TF-IDF features, TextRank, role heuristics, and MMR selection.
- `content/model-manager.js` — optional local Ollama runtime, model downloads, embeddings, classification, and summarization.
- `content/preferences.xhtml` — the native Zotero settings pane markup.
- `content/remote-llm.js` — OpenAI-compatible remote summarization and embeddings.
- `README.md` / `CHANGELOG.md` — user-facing description and release history.

## Runtime constraints

- Target Zotero `9.x`; retain manifest v2 and the declared add-on ID unless an intentional compatibility/migration change is requested.
- Scripts share Zotero's chrome scope. Globals are deliberate: `FastKeySentenceNLP`, `FastKeySentenceExtractor`, `FastKeySentenceModels`, `FastKeySentenceRemote`, and `FastOfflineKeySentenceAnnotator`.
- Preserve load order in `bootstrap.js`: `nlp.js` → `extractor.js` → `model-manager.js` → `remote-llm.js` → `annotator.js`.
- Use Zotero/Gecko APIs (`Zotero`, `Services`, `IOUtils`, `PathUtils`) rather than Node or browser-only assumptions.
- Keep PDF processing local. Baseline ranking must work without downloading models; optional inference must fail back to it cleanly.
- Do not alter the source PDF. Temporary highlights use reader overlays only. Native annotations use `Zotero.Annotations.saveFromJSON()` and must retain valid positioned rectangles and sort indexes.
- Configuration belongs in the native settings pane. Keep the reader sidebar free of settings forms and popups.
- **Test Ollama** starts the local server and pulls the configured models. Preserve clear progress and failure reporting in the settings pane.

## Code conventions

- JavaScript only; match the existing two-space indentation, semicolons, `const`/`let`, async/await, and object-module style.
- Keep changes narrowly scoped and dependency-free. Avoid bundlers, transpilers, npm metadata, or Node imports unless the project architecture is intentionally changed.
- Use `Zotero.debug()` through existing logging helpers; surface user-actionable failures in the settings pane or reader status line, not in dialogs.
- Treat reader and Zotero APIs defensively: feature-detect APIs, handle missing local files, and preserve clear error messages.
- Maintain sentence geometry, reading order, reference filtering, and duplicate-auto-annotation safeguards when changing extraction or ranking code.

## Validation

The Vitest suite covers the ranker, extractor, settings, and annotation flow. Run it, then run syntax checks:

```sh
yarn install
yarn test
node --check bootstrap.js
node --check content/annotator.js
node --check content/extractor.js
node --check content/nlp.js
node --check content/model-manager.js
node --check content/remote-llm.js
```

Then manually test in Zotero 9 with representative PDFs: single- and two-column layouts, multi-page documents, tables, references, and scanned/OCR-needed PDFs. Verify menu visibility, settings persistence, temporary overlays, threshold filtering, explicit save, duplicate prevention, baseline ranking, model download progress, and baseline fallback after model/runtime failure.

## Release hygiene

- Keep `manifest.json` version, `README.md` current-version text, and `CHANGELOG.md` aligned for releases.
- Do not commit generated `.xpi`, `.zip`, build output, model caches, or `node_modules/`.
