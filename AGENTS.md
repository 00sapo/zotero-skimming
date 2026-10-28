# AGENTS.md

## Project

Zotero 9 and 10 add-on that finds salient prose sentences in academic PDFs and saves them as native Zotero highlight annotations. It is a dependency-free, manifest-v2 extension loaded from `bootstrap.js`.

## Layout

- `manifest.json` — add-on identity, version, and Zotero 9 and 10 compatibility.
- `bootstrap.js` — lifecycle hooks; loads scripts in dependency order.
- `content/annotator.js` — Zotero UI, persisted settings, all-page positioned PDF extraction, sentence-to-rectangle mapping, and annotation creation.
- `content/nlp.js` — model-free NLP baseline: filtering, TF-IDF features, sentence-length scoring, and MMR selection.
- `content/model-manager.js` — Ollama integration: server startup, model pulls, summary generation, embeddings, and logging.
- `content/model-host.mjs` — standalone remote-runtime host experiment; it is not loaded by `bootstrap.js`.
- `README.md` / `CHANGELOG.md` — user-facing description and release history.

## Runtime constraints

- Target Zotero `10.x`; retain Zotero 9 support, manifest v2, and the declared add-on ID unless an intentional compatibility/migration change is requested.
- Scripts share Zotero's chrome scope. Globals are deliberate: `FastKeySentenceNLP`, `FastKeySentenceModels`, and `FastOfflineKeySentenceAnnotator`.
- Preserve load order in `bootstrap.js`: `nlp.js` → `model-manager.js` → `annotator.js`.
- Use Zotero/Gecko APIs (`Zotero`, `Services`, `IOUtils`, `PathUtils`) rather than Node or browser-only assumptions.
- Keep PDF processing local. Baseline ranking must work without downloading models; optional inference must fail back to it cleanly.
- Do not alter the source PDF. Annotations use `Zotero.Annotations.saveFromJSON()` and must retain valid positioned rectangles and sort indexes.
- `Test Ollama` explicitly starts `ollama serve` and pulls the models in `model-identifiers.json`. Preserve the configurable command, readiness polling, and clear progress/failure reporting.

## Code conventions

- JavaScript only; match the existing two-space indentation, semicolons, `const`/`let`, async/await, and object-module style.
- Keep changes narrowly scoped and dependency-free. Avoid bundlers, transpilers, npm metadata, or Node imports unless the project architecture is intentionally changed.
- Use `Zotero.debug()` through existing logging helpers; surface user-actionable failures with the existing dialog/progress UI.
- Treat PDF worker internals and Zotero APIs defensively: feature-detect APIs, handle missing local files, and preserve error messages/fallback behavior.
- Maintain sentence geometry, reading order, reference/table/front-matter filtering, and duplicate-auto-annotation safeguards when changing extraction or ranking code.

## Validation

Run the unit tests and JavaScript syntax checks:

```sh
node --check bootstrap.js
node --check content/annotator.js
node --check content/nlp.js
node --check content/model-manager.js
node --check content/model-host.mjs
yarn test
```

Run the end-to-end smoke test against a real Zotero 10 installation and Ollama:

```sh
SMOKE_PDF="/path/to/paper.pdf" \
SMOKE_OLLAMA_COMMAND="mise exec -- ollama" \
node scripts/smoke-zotero.mjs
```

The script builds an XPI from the working tree, starts Zotero with a throwaway profile and data directory, and checks summary generation, embeddings, and native highlight geometry and tags. It never touches the user profile or library. The script injects a probe into a copy of `bootstrap.js`, so update its anchors if `startup` changes shape. It requires `zip` and an Ollama installation that can serve the models in `model-identifiers.json`. Without `SMOKE_PDF` it checks summaries and embeddings only. Use `ZOTERO_BIN` to point at another Zotero install, `SMOKE_TIMEOUT` to change the 300000 ms limit, `SMOKE_HEADLESS=0` to show the window, and `SMOKE_KEEP=1` to keep the temporary profile and log.

Then manually test in Zotero 10 with representative PDFs: single- and two-column layouts, multi-page documents, tables, references, and scanned/OCR-needed PDFs. Verify menu visibility, settings persistence, native highlight placement, duplicate prevention, baseline ranking, model download progress, and baseline fallback after model/runtime failure.

## Release hygiene

- Keep `manifest.json` version, `README.md` current-version text, and `CHANGELOG.md` aligned for releases.
- Do not commit generated `.xpi`, `.zip`, build output, model caches, or `node_modules/`.
