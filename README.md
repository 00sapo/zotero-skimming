# Zotero Skimming

> [!WARNING]
> Please, be aware of the bias risk induced by automated sentence selection methods. Do not use this add-on for in-depth study of academic articles. Consider it only for fast skimming of articles. Read more about [skimming](#references).

Say bye-bye to confused AI-generated summaries, abstract sentences, and hallucinations. With this add-on, you can give a first pass to a paper by directly reading its real sentences, no AI invention, only guided AI selection.

First skim, then read. Skimming is also known as _"orientation reading"_.

Requires Zotero 9 and one of:
- Ollama
- OpenAI-compatible API key (e.g. LiteLLM, Deepseek, Openrouter, OpenAI, etc.)

<img src="assets/screenshot.png" alt="Screenshot of a paper annotated" width="400" />

## Installation

1. Download the latest `.xpi` from the [GitHub releases](https://github.com/00sapo/zotero-skimming/releases).
2. In Zotero, open **Tools → Add-ons**.
3. Open the gear menu and choose **Install Add-on From File…**.
4. Select the downloaded `.xpi` and restart Zotero if prompted.
5. **Optional**: Install Ollama from https://ollama.com/download
   Ollama is needed to efficiently run the LLM models locally. You can alternatively use a remote
   API endpoint. For Google and Deepseek, consider using a local LiteLLM gateway, which offers
   OpenAI-compatible API.

The add-on targets Zotero 9.x. It does not modify source PDFs; it creates native positioned highlight annotations.

## Usage

1. Select a PDF attachment in the Zotero library.
2. Right-click it and choose **Skim paper**. <img src="assets/context-menu.png" alt="Zotero PDF context menu with Skim paper selected" width="150" />
3. Choose **Remote API** or **Local Ollama** for summarization. Remote mode requires an OpenAI-compatible endpoint, API key, and model name. Local mode requires a user-installed [Ollama](https://ollama.com/download). <img src="assets/settings-dialog.png" alt="Paper skim settings dialog" width="400" />
4. Set the average, minimum, and maximum annotations per PDF.
5. Optionally enable local semantic relevance scoring and configure highlight tags.
6. Set **Ollama command** if Ollama is not on Zotero’s PATH (for mise: `mise exec -- ollama`), then click **Download Ollama models** once to download and import the required GGUF models.
7. Click **Annotate** to extract, summarize, rank, and annotate. In remote mode, **Test API credentials** verifies the API and previews the paper synopsis.

The baseline ranker works without downloaded models. When enabled, local semantic relevance falls back to the baseline ranker if Ollama is unavailable.

## Workflow

### 1. Summarization

Choose **Remote API** to send filtered paper body text (no authors, tables, figures, abstract, or references) to the configured remote LLM. Its summary length scales with the annotation target: approximately `N × 1.5` sentences for `N` requested annotations.

Choose **Local Ollama** to summarize with imported `Qwen/Qwen3.5-2B` or with your preferred model. Ollama handles local GPU selection and execution; this add-on starts `ollama serve` when its executable is available. Remote credentials are hidden when local summarization is selected. Note that you can also use the remote endpoint to interact with Ollama. However, the Remote choice is designed to make the setup easier for non expert users.

**Map-reduce long papers** and its shared context window apply to both sources. They split long input into locally token-counted chunks before reducing their summaries. Local Ollama carries each partial summary into the next map step and overlaps adjacent chunks by 5%. The window defaults to 4096 tokens and accepts values from 256 to 131072. This is useful for small local models. Note that the default ollama model (Qwen3.5-2B) has a sufficiently large context window to handle almost any paper. Nevertheless, using map-reduce can still increase the completeness of the summary.

### 2. Local semantic relevance and tag classification

When enabled, a remote or local model (local defaults to `Qwen/Qwen3-Embedding-0.6B-GGUF`) embed candidates through Ollama against the paper synopsis and configured scholarly keyword sections.

The relevance of a sentence is computed as a weighted average of the similarity between the sentence
and the paper summary and of a gaussian score encouraging sentence length around 20 words.

After MMR selection, each selected sentence is compared with the configured label definitions to classify it as one of the supported categories (literature, method, goal, result, conclusion, contribution). Tags and their descriptions are user-configurable in the settings dialog; colors are assigned deterministically by tag order. If disabled, the baseline TF-IDF ranker remains active and highlights are untagged.

### 3. MMR selection

Maximum marginal relevance selects the requested number of highlights while penalizing semantic redundancy and repeated sections:

```text
0.65 × relevance − 0.35 × redundancy
```

| Term | Meaning |
|------|---------|
| `importance` | sentence salience from summary relevance and keyword relevance |
| `redundancy` | cosine similarity to previously selected candidates |
| `coverage penalty` | penalises similarity to a summary sentence already covered by a prior pick |

Coverage penalty is applied to the similarity matrix between the summary and a target sentence
before of the importance computation.

### 4. Selected annotations

Selected annotations are restored to PDF reading order and mapped back to their original rectangles.

## Models

Install Ollama separately, then use **Download Ollama models** to upload these Hugging Face GGUF files into Ollama's local store through its blob API.

| Stage | Model |
|-------|-------|
| Summarization | `Qwen/Qwen2.5-0.5B-Instruct-GGUF` (Q4_K_M) |
| Semantic relevance | `Qwen/Qwen3-Embedding-0.6B-GGUF` (Q8_0) |

`model-identifiers.json` records the imported model names and source repositories. `scoring-config.json` contains relevance prompts plus scoring and selection weights.

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
