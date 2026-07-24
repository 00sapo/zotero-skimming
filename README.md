# Zotero Skimming

Say bye-bye to confused AI-generated summaries, abstract sentences, and hallucinations. With this add-on, you can give a first pass to a paper by directly reading its real sentences, no AI invention, only guided AI selection.

First skim, then read. Skimming is also known as _"orientation reading"_.

Requires Zotero 9.

<img src="assets/screenshot.png" alt="Screenshot of a paper annotated" width="400" />

> [!WARNING]
> Please, be aware of the bias risk induced by automated sentence selection methods. Do not use this add-on for in-depth study of academic articles. Consider it only for fast skimming of articles. Read more about [skimming](#references).

## Installation

1. Download the latest `.xpi` from the [GitHub releases](https://github.com/00sapo/zotero-skimming/releases).
2. In Zotero, open **Tools → Add-ons**.
3. Open the gear menu and choose **Install Add-on From File…**.
4. Select the downloaded `.xpi` and restart Zotero if prompted.

The add-on targets Zotero 9.x. It does not modify source PDFs; it creates native positioned highlight annotations.

## Usage

1. Select a PDF attachment in the Zotero library.
2. Right-click it and choose **Skim paper**. <img src="assets/context-menu.png" alt="Zotero PDF context menu with Skim paper selected" width="150" />
3. Choose **Remote API** or **Local Qwen** for summarization. Remote mode requires an OpenAI-compatible endpoint, API key, and model name; local mode uses `onnx-community/Qwen2.5-0.5B-Instruct`. <img src="assets/settings-dialog.png" alt="Paper skim settings dialog" width="400" />
4. Set the average, minimum, and maximum annotations per PDF.
5. Enable optional local transformer stages (embeddings, classification) as needed.
6. Click **Update models** to download selected local model assets into the Zotero profile cache. This is required only once per selected model and revision.
7. Click **Annotate** to extract, summarize, rank, and annotate. In remote mode, **Test API credentials** verifies the API and previews the paper synopsis.

The baseline ranker works without downloaded models. Local Qwen uses int8 ONNX and falls back to baseline ranking if it cannot run. Other local transformer failures fall back to TF-IDF for embeddings and skip classification.

## Workflow

### 1. Summarization

Choose **Remote API** to send filtered paper body text (no authors, tables, figures, abstract, or references) to the configured remote LLM. Its summary length scales with the annotation target: approximately `N × 1.5` sentences for `N` requested annotations.

**Map-reduce long papers** and its shared context window apply to both sources. They split long input into locally token-counted chunks before reducing their summaries. The window defaults to 4096 tokens and accepts values from 256 to 131072.

Choose **Local Qwen** to summarize in Zotero with `onnx-community/Qwen2.5-0.5B-Instruct`. Download it first with **Update models**. Local summarization, embeddings, and classification run in a dedicated worker thread through the add-on's single-threaded Transformers.js/ONNX runtime using `onnx/model_int8.onnx`; they do not block Zotero's interface or access the network. Remote credentials are hidden when local summarization is selected.

### 2. Sentence embeddings

Sentences are vectorized with a local transformer model (MiniLM-L6 for English, multilingual-e5-small for multilingual). Without LLM embeddings enabled, TF-IDF word/bigram vectors are used instead. The summary text is embedded in the same vector space.

### 3. Sentence ranking

Each sentence is scored by:

```text
0.85 × summary similarity (cosine to summary embedding)
+ 0.15 × sentence-length suitability
```

Summary similarity dominates: sentences semantically close to the synopsis are preferred. Length suitability peaks near 18 words.

### 4. MMR selection

Maximum marginal relevance selects the requested number of highlights while penalizing semantic redundancy, repeated sections, and overlapping summary coverage:

```text
0.65 × importance − 0.35 × redundancy − section penalty − 0.03 × coverage overlap
```

Summary sentences are embedded and tracked: each selection claims the summary sentence it's closest to. Subsequent candidates receive a small penalty if their best-matching summary sentence was already claimed, encouraging the highlights to span different aspects of the synopsis.

### 5. Optional local classification

If enabled, a zero-shot classifier (mobileBERT, ~95 MB) labels each selected sentence with one of six roles. The classifier receives the paper summary concatenated with the sentence as context:

| Role | Description |
|------|-------------|
| contribution | Main contribution of the paper |
| result | Key empirical result or finding |
| method | Core method, approach, or architecture |
| goal | Research objective or aim |
| takeaway | Conclusion or key insight |
| background | Background context or related work |

Classification runs **after** MMR selection — only the final set of highlights is classified. It does not affect sentence ranking; it only sets the annotation color and tag.

### 6. Selected annotations

Selected annotations are restored to PDF reading order and mapped back to their original rectangles.

## Models

All local model assets come from Hugging Face and are downloaded explicitly with **Update models**. Embeddings and classification use q8/legacy quantized ONNX artifacts; local Qwen summarization uses its int8 ONNX artifact.

| Stage | English | Multilingual |
|-------|---------|-------------|
| Summarization | `onnx-community/Qwen2.5-0.5B-Instruct` (int8) | Same model |
| Embeddings | `Xenova/all-MiniLM-L6-v2` | `Xenova/multilingual-e5-small` |
| Classification | `Xenova/mobilebert-uncased-mnli` | `onnx-community/multilingual-MiniLMv2-L6-mnli-xnli-ONNX` |

`model-identifiers.json` is the source of truth for these Hugging Face identifiers. MobileBERT's quantized model is approximately 95 MB. `scoring-config.json` contains scoring and selection weights. Edit it to experiment with the algorithm; rebuild the XPI afterwards.

## Similar plugins

- [SkimRead](https://github.com/adellife/zotero-skimread): Document-wide Zotero PDF skimming that uses AI to choose the sentences that best express a paper’s goal, method, results, and novelty; it has the same exact goal as zotero-skimming, but it demands all the work to the AI, which selects the best sentences, while my plugin provides a more guided enhancing accuracy with cheap models. Currently, `zotero-skimread` has a slightly more convenient UI.
- [Nodus](https://github.com/Drakonis96/nodus): A broader Zotero research workspace that indexes attachments for local-first search, cited answers, and AI-assisted study across a vault; philosophically it is a research knowledge workspace, which also includes sentence highlighting, but it focus on "important sentences" more than on sentence skimming.

## Build and test

Requirements: Bash, Python 3, `zip`, `unzip`, Node.js, Yarn, and the project's JavaScript test dependencies.

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
node --check content/remote-llm.js
git diff --check
```

`build.sh` reads the version from `manifest.json`, creates `dist/zotero-skimming-VERSION.xpi`, includes both JSON configuration files, and validates the archive with `unzip -t`.

## References

- K. Rayner, E. R. Schotter, M. E. J. Masson, M. C. Potter, and R. Treiman, “So Much to Read, So Little Time,” Psychol Sci Public Interest, vol. 17, no. 1, pp. 4–34, Jan. 2016, doi: [10.1177/1529100615623267](https://doi.org/10.1177/1529100615623267).
- R. Fok et al., “Scim: Intelligent Skimming Support for Scientific Papers,” Proceedings of the 28th International Conference on Intelligent User Interfaces. ACM, pp. 476–490, Mar. 27, 2023. doi: [10.1145/3581641.3584034](https://doi.org/10.1145/3581641.3584034).
- G. B. Duggan and S. J. Payne, “Text skimming: The process and effectiveness of foraging through text under time pressure.,” Journal of Experimental Psychology: Applied, vol. 15, no. 3, pp. 228–242, 2009, doi: [10.1037/a0016995](https://doi.org/10.1037/a0016995).

## Repository

https://github.com/00sapo/zotero-skimming
