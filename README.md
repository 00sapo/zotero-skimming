# Zotero Skimming

> [!WARNING]
> Please, be aware of the bias risk induced by automated sentence selection methods. Do not use this add-on for in-depth study of academic articles. Consider it only for fast skimming of articles. Read more about [skimming](#references).

Say bye-bye to confused AI-generated summaries, abstract sentences, and hallucinations. With this add-on, you can give a first pass to a paper by directly reading its real sentences, no AI invention, only guided AI selection.

Highlights stay temporary until you save them. Generate a preview, adjust the threshold, then save only the sentences you want as native Zotero annotations. No popups interrupt the reader.

First skim, then read. Skimming is also known as _"orientation reading"_.

Requires Zotero 9 and one of:
- Ollama for efficient fully local processing on most consumer laptops
- OpenAI-compatible API key (e.g. LiteLLM, Deepseek, Openrouter, OpenAI, etc.) if you have very low budget hardware

<img src="assets/screenshot.png" alt="Screenshot of a paper annotated" width="400" />

## Installation

1. Download the latest `.xpi` from the [GitHub releases](https://github.com/00sapo/zotero-skimming/releases).
2. In Zotero, open **Tools → Add-ons**.
3. Open the gear menu and choose **Install Add-on From File…**.
4. Select the downloaded `.xpi` and restart Zotero if prompted.
5. Open **Settings → Zotero Skimming** and choose a summary source.
6. **Optional**: Install Ollama from https://ollama.com/download
   Ollama is needed to efficiently run the LLM models locally. You can alternatively use a remote
   API endpoint (DeepSeek recommended). For Google and Anthropic, consider using a local LiteLLM gateway, which offers
   OpenAI-compatible API. 

The add-on targets Zotero 9.x. It does not modify source PDFs. It paints temporary overlays first and writes native positioned highlight annotations only when you press **Save**.

## Usage

1. Open a PDF in the Zotero reader.
2. Open the **Paper skim** section in the right sidebar.
3. Press **Generate highlights**. The status line reports extraction, ranking, and model progress. No dialog opens.
4. Move the **Highlight threshold** slider to hide selected sentences with a low importance score. The preview updates immediately and does not call the model again.
5. Press **Save as Zotero annotations…** to keep the visible highlights in your library. Press **Clear** to remove the preview without saving anything.

All other settings live in **Settings → Zotero Skimming**:

- The summary source. Choose **Local Ollama** or **Remote API**.
- The compression ratio, which sets how many sentences are selected before the threshold is applied.
- The highlight threshold. The reader slider changes the same value.
- Semantic relevance, summary labels, and the label definitions.
- The endpoint, API key, and model names for remote use.
- The Ollama command, map-reduce, and the number of sentences per chunk.

The **Test Ollama** button in settings reports its result on the same page. Remote mode checks the endpoint and key fields without sending a paper.

The baseline ranker works without downloaded models. When enabled, local semantic relevance falls back to the baseline ranker if Ollama is unavailable.

## Workflow

### 1. Summarization

Choose **Remote API** to send filtered paper body text (no authors, tables, figures, abstract, or references) to the configured remote LLM. Its summary length scales with the highlight target: approximately `N × 1.5` sentences for `N` requested highlights.

Choose **Local Ollama** to summarize with imported `Qwen/Qwen3.5-2B` or with your preferred model. Ollama handles local GPU selection and execution; this add-on starts `ollama serve` when its executable is available. Remote credentials are hidden when local summarization is selected. Note that you can also use the remote endpoint to interact with Ollama. However, the Remote choice is designed to make the setup easier for non expert users.

**Map-reduce long papers** and its shared context window apply to both sources. They split long input into locally token-counted chunks before reducing their summaries. Local Ollama carries each partial summary into the next map step and overlaps adjacent chunks by 5%. The window defaults to 4096 tokens and accepts values from 256 to 131072. This is useful for small local models. Note that the default ollama model (Qwen3.5-2B) has a sufficiently large context window to handle almost any paper. Nevertheless, using map-reduce can still increase the completeness of the summary.

### 2. Local semantic relevance and tag classification

When enabled, the add-on downloads the embedding model and uses it to rank sentences by semantic similarity to the summary, replacing the baseline TF-IDF/TextRank scorer.

Each candidate `i` is scored as:

```
wᵢ·imp(i) + wᵢ·cov(i) − wᵣ·red(i) − pₛ·sec(i)
```

| Term | What | Effect |
|---|---|---|
| `imp(i)` | `summarySimilarity` (embed→summary cos) + `sentenceLength` (Gaussian centered at 18 words), min-max norm→[0,1] | Prefer sentences relevant to summary with readable length |
| `cov(i)` | `maxⱼ M[i][j]` — best cos to any summary sentence after column penalties | Favor sentences whose matched summary part is still uncovered |
| `red(i)` | `maxₖ cos(pᵢ, pₖ)` over already-selected `k` | Spread selections across the paper, not just one region |
| `sec(i)` | count of sentences already picked from the same section | Avoid over-sampling one section |
| `wᵢ=0.65` | `SCORING.selection.importance` | Strength of relevance + coverage |
| `wᵣ=0.35` | `SCORING.selection.redundancy` | Strength of diversity |
| `pₛ=0.06` | `SCORING.selection.sectionPenalty` | Penalty per extra same-section pick |

After picking sentence `i*`, penalize its best-matching summary column: `M[i][j*] = max(0, M[i][j*] − 0.1·σ)` for all remaining `i`. `σ` = stddev of all remaining matrix entries (recomputed each iteration). This pushes `cov(i)` down for candidates that would re-hit the same summary part, encouraging coverage of the whole synopsis.

If tag definitions are supplied (TOML in Zotero Settings), selected sentences are classified by cosine similarity to each tag's description vector. Each highlight receives the best-matching tag, its description, and a color from a fixed palette.

### 3. Temporary preview and saving

Sentence extraction uses the reader's per-character geometry. It clusters characters into visual lines, detects repeated column gutters, removes running headers and footers, and detects the reference zone from citation signals. Division of the text into sentences uses the platform segmenter, so the highlight rectangles match the prose.

The selected sentences are painted as temporary overlays. Nothing is written to the library until you press **Save as Zotero annotations…**. The threshold slider filters the preview by importance score without another model call. A second save skips sentences that already have an annotation, so repeated presses do not create duplicates.

## Models

Install Ollama separately. **Test Ollama** in settings starts the local server and pulls the required Hugging Face GGUF files into Ollama's local store.

| Stage | Default Model |
|-------|-------|
| Summarization | `Qwen/Qwen3.5-2B-Instruct-GGUF` (Q8_0) |
| Semantic relevance | `Qwen/Qwen3-Embedding-0.6B-GGUF` (Q8_0) |

`model-identifiers.json` records the imported model names and source repositories. `scoring-config.json` contains relevance prompts plus scoring and selection weights.

## Similar plugins

- [SkimRead](https://github.com/adellife/zotero-skimread): Document-wide Zotero PDF skimming that uses AI to choose the sentences that best express a paper’s goal, method, results, and novelty. It has the same goal as zotero-skimming, but it gives all the selection work to the AI, while this plugin provides more guided selection with cheap models. This plugin now copies its settings-pane, temporary-highlight, and explicit-save workflow.
- [Nodus](https://github.com/Drakonis96/nodus): A broader Zotero research workspace that indexes attachments for local-first search, cited answers, and AI-assisted study across a vault; philosophically it is a research knowledge workspace, which also includes sentence highlighting, but it focus on "important sentences" more than on sentence skimming.

## Build and test

Requirements: Bash, Python 3, `zip`, `unzip`, Node.js, Yarn, and the project's JavaScript test dependencies.

```sh
yarn install
yarn test
./scripts/release.sh --only-build
node --check bootstrap.js
node --check content/annotator.js
node --check content/extractor.js
node --check content/nlp.js
node --check content/model-manager.js
node --check content/remote-llm.js
git diff --check
```

`scripts/release.sh --only-build` reads the version from `manifest.json`, creates `zotero-skimming.xpi`, includes both JSON configuration files, and validates the archive with `unzip -t`.

## References

- K. Rayner, E. R. Schotter, M. E. J. Masson, M. C. Potter, and R. Treiman, “So Much to Read, So Little Time,” Psychol Sci Public Interest, vol. 17, no. 1, pp. 4–34, Jan. 2016, doi: [10.1177/1529100615623267](https://doi.org/10.1177/1529100615623267).
- R. Fok et al., “Scim: Intelligent Skimming Support for Scientific Papers,” Proceedings of the 28th International Conference on Intelligent User Interfaces. ACM, pp. 476–490, Mar. 27, 2023. doi: [10.1145/3581641.3584034](https://doi.org/10.1145/3581641.3584034).
- G. B. Duggan and S. J. Payne, “Text skimming: The process and effectiveness of foraging through text under time pressure.,” Journal of Experimental Psychology: Applied, vol. 15, no. 3, pp. 228–242, 2009, doi: [10.1037/a0016995](https://doi.org/10.1037/a0016995).

## Repository

https://github.com/00sapo/zotero-skimming
