# Zotero Skimming

Zotero 9 add-on that finds salient prose in academic PDFs and saves the results as native Zotero highlight annotations.

## Screenshots

Configure annotation density and optional models in the dialog:

![Key-sentence annotation settings](assets/settings-dialog.png)

Right-click a PDF attachment and choose **Annotate key sentences…**:

![Zotero PDF context menu](assets/context-menu.png)

## Features

- 🧭 Fully local PDF processing
- ✨ Native Zotero highlights, not PDF edits
- 📚 Baseline TF-IDF/TextRank pipeline that works everywhere
- 🧠 Optional transformer stages for embeddings, classification, re-ranking, and summarization
- ⚡ WebGPU acceleration when available, with WASM fallback
- 🎛️ Tune density, batch size, model usage, and scoring weights

## Installation

1. Download the latest `.xpi` from the [Codeberg releases](https://codeberg.org/00sapo/zotero-skimming/releases).
2. In Zotero, open **Tools → Add-ons**.
3. Open the gear menu and choose **Install Add-on From File…**.
4. Select the downloaded `.xpi` and restart Zotero if prompted.

The add-on targets Zotero 9.x. It does not modify source PDFs; it creates native positioned highlight annotations.

## Usage

1. Select a PDF attachment in the Zotero library.
2. Right-click it and choose **Annotate key sentences…**.
3. Set the average, minimum, and maximum annotations per PDF.
4. Enable optional transformer stages as needed.
5. Click **Update models** to download selected model assets into the Zotero profile cache. This is required only once per selected model and revision.
6. Click **Annotate**.

The baseline ranker works without downloaded models. Transformer failures fall back to the baseline where possible. Larger classification batches are faster but require more RAM. WebGPU is used automatically when available; inference falls back to WASM.

## Scoring algorithm

### Extraction and filtering

The add-on extracts positioned text from every page, reconstructs reading order and sections, then removes references, tables, front matter, headings, boilerplate, citation-heavy lines, and unsuitable sentence lengths.

### Initial sentence score

Sentence vectors are TF-IDF word/bigram vectors by default, or local transformer embeddings when enabled. K-means creates `floor(annotation target / 4)` clusters, bounded to the available sentences. For each sentence, **cluster dispersion** is its cosine distance from its own cluster centroid.

The initial score is:

```text
0.38 × cluster dispersion
+ 0.35 × TextRank centrality
+ 0.10 × scholarly cues
+ 0.17 × sentence-length suitability
```

TextRank uses cosine-linked sentence graphs, a 0.08 similarity threshold, damping 0.85, up to 50 iterations, and overlapping windows of 240 sentences with 40-sentence overlap. Sentence-length suitability peaks near 27 words. Scholarly cues detect contribution, result, method, objective, limitation, conclusion, future-work, and dataset language; percentage expressions receive an additional cue.

The shortlist contains up to `min(160, max(60, target × 4))` candidates.

### Optional classification

A zero-shot classifier labels shortlisted sentences by scholarly role. Its score is 65% model confidence and 35% role salience, then the sentence score is blended as:

```text
0.78 × previous score + 0.22 × classification score
```

Classification calls are batched. The batch size is configurable from 1 to 32.

### Optional summarization and re-ranking

The Qwen3 0.6B model can summarize up to approximately 40K tokens of paper text. The synopsis is added to the title and abstract-derived context used by the cross-encoder re-ranker.

Re-ranking blends as:

```text
0.65 × previous score + 0.35 × re-ranking score
```

### Final selection

Maximum marginal relevance selects the requested number of highlights while penalizing semantic redundancy and repeated sections:

```text
0.72 × importance − 0.28 × redundancy − section penalty
```

Selected annotations are restored to PDF reading order and mapped back to their original rectangles.

## Models

All model assets come from Hugging Face, are downloaded explicitly with **Update models**, and use the q8/legacy quantized ONNX artifact accepted by the add-on.

| Stage | English | Multilingual |
|---|---|---|
| Embeddings | `Xenova/all-MiniLM-L6-v2` | `Xenova/multilingual-e5-small` |
| Classification | `Xenova/distilbert-base-uncased-mnli` | `onnx-community/multilingual-MiniLMv2-L6-mnli-xnli-ONNX` |
| Re-ranking | `Xenova/ms-marco-MiniLM-L-6-v2` | `SugoLabs/mmarco-mMiniLMv2-L12-H384-v1` |
| Summarization | `onnx-community/Qwen3-0.6B-ONNX` | same model |

`model-identifiers.json` is the source of truth for these Hugging Face identifiers. Qwen3's quantized model is approximately 590 MB before tokenizer and configuration files. `scoring-config.json` contains the scoring weights, role scores, TextRank parameters, classification/re-ranking blends, and final-selection weights. Edit it to experiment with the algorithm; rebuild the XPI afterwards.

## Build and test

Requirements: Bash, Python 3, `zip`, `unzip`, Node.js, Yarn, and the project’s JavaScript test dependencies.

```sh
yarn install
./build.sh
yarn test
yarn coverage
node --check bootstrap.js
node --check content/annotator.js
node --check content/nlp.js
node --check content/model-manager.js
node --check content/model-host.mjs
git diff --check
```

`build.sh` reads the version from `manifest.json`, creates `dist/zotero-skimming-VERSION.xpi`, includes both JSON configuration files, and validates the archive with `unzip -t`.

## Repository

https://codeberg.org/00sapo/zotero-skimming
