# AGENTS.md

## Project

Zotero 9 and 10 add-on that finds salient prose sentences in academic PDFs and saves them as native Zotero highlight annotations. It is a dependency-free, manifest-v2 extension loaded from `bootstrap.js`.

## Layout

- `manifest.json` — add-on identity, version, and Zotero 9 and 10 compatibility.
- `bootstrap.js` — lifecycle hooks; loads scripts in dependency order.
- `content/annotator.js` — Zotero UI, persisted settings, the settings pane wiring, temporary reader overlays, threshold filtering, and native annotation creation.
- `content/extractor.js` — geometry-based all-page PDF extraction: character clustering, reading order, page furniture and reference zoning, and sentence segmentation.
- `content/nlp.js` — model-free NLP baseline: filtering, TF-IDF features, sentence-length scoring, and MMR selection.
- `content/model-manager.js` — Ollama integration: server startup, model pulls, summary generation, embeddings, and logging.
- `content/preferences.xhtml` — the native Zotero settings pane markup.
- `content/remote-llm.js` — OpenAI-compatible remote summarization and embeddings.
- `README.md` / `CHANGELOG.md` — user-facing description and release history.

## Runtime constraints

- Target Zotero `10.x`; retain Zotero 9 support, manifest v2, and the declared add-on ID unless an intentional compatibility/migration change is requested.
- Scripts share Zotero's chrome scope. Globals are deliberate: `FastKeySentenceNLP`, `FastKeySentenceExtractor`, `FastKeySentenceModels`, `FastKeySentenceRemote`, and `FastOfflineKeySentenceAnnotator`.
- Preserve load order in `bootstrap.js`: `nlp.js` → `extractor.js` → `model-manager.js` → `remote-llm.js` → `annotator.js`.
- Use Zotero/Gecko APIs (`Zotero`, `Services`, `IOUtils`, `PathUtils`) rather than Node or browser-only assumptions.
- Keep PDF processing local. Baseline ranking must work without downloading models; optional inference must fail back to it cleanly.
- Do not alter the source PDF. Temporary highlights use reader overlays only. Native annotations use `Zotero.Annotations.saveFromJSON()` and must retain valid positioned rectangles and sort indexes.
- Configuration belongs in the native settings pane. Keep the reader sidebar free of settings forms and popups.
- `Test Ollama` explicitly starts `ollama serve` and pulls the models in `model-identifiers.json`. Preserve the configurable command, readiness polling, and clear progress/failure reporting.

## Code conventions

- JavaScript only; match the existing two-space indentation, semicolons, `const`/`let`, async/await, and object-module style.
- Keep changes narrowly scoped and dependency-free. Avoid bundlers, transpilers, npm metadata, or Node imports unless the project architecture is intentionally changed.
- Use `Zotero.debug()` through existing logging helpers; surface user-actionable failures in the settings pane or reader status line, not in dialogs.
- Treat reader and Zotero APIs defensively: feature-detect APIs, handle missing local files, and preserve clear error messages.
- Maintain sentence geometry, reading order, reference filtering, and duplicate-auto-annotation safeguards when changing extraction or ranking code.

## Validation

The Vitest suite covers the ranker, extractor, settings, and annotation flow. Run the unit tests and JavaScript syntax checks:

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

Run the end-to-end smoke test against a real Zotero 10 installation and Ollama:

```sh
SMOKE_PDF="/path/to/paper.pdf" \
SMOKE_OLLAMA_COMMAND="mise exec -- ollama" \
node scripts/smoke-zotero.mjs
```

The script builds an XPI from the working tree, starts Zotero with a throwaway profile and data directory, and checks summary generation, embeddings, and native highlight geometry and tags. It never touches the user profile or library. The script injects a probe into a copy of `bootstrap.js`, so update its anchors if `startup` changes shape. It requires `zip` and an Ollama installation that can serve the models in `model-identifiers.json`. Without `SMOKE_PDF` it checks summaries and embeddings only. Use `ZOTERO_BIN` to point at another Zotero install, `SMOKE_TIMEOUT` to change the 300000 ms limit, `SMOKE_HEADLESS=0` to show the window, and `SMOKE_KEEP=1` to keep the temporary profile and log.

Then manually test in Zotero 10 with representative PDFs: single- and two-column layouts, multi-page documents, tables, references, and scanned/OCR-needed PDFs. Verify menu visibility, settings persistence, temporary overlays, threshold filtering, explicit save, duplicate prevention, baseline ranking, model download progress, and baseline fallback after model/runtime failure.

## Release hygiene

- Keep `manifest.json` version, `README.md` current-version text, and `CHANGELOG.md` aligned for releases.
- Do not commit generated `.xpi`, `.zip`, build output, model caches, or `node_modules/`.
