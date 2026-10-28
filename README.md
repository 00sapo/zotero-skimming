# Zotero Skimming

> [!WARNING]
> Use the add-on for a fast first pass only. Automated sentence selection can miss important sentences or introduce bias. Do not use the add-on for a detailed study of a paper.

Zotero Skimming selects important sentences in a PDF and saves them as native Zotero highlights. It does not change the PDF.

Skimming is a fast first pass over a paper. It is also called orientation reading.

<img src="assets/screenshot.png" alt="Screenshot of a paper with Zotero Skimming highlights" width="400" />

## Requirements

- Zotero 10.
- Optional: Ollama. Ollama runs the local summary and embedding models.
- Optional: an OpenAI-compatible API endpoint and API key. The add-on uses the endpoint for remote summaries and embeddings.

If local summarization fails, the add-on falls back to a built-in TF-IDF (word frequency) ranker. `Remote API` needs a working endpoint and API key.

## Installation

1. Download the latest `.xpi` file from the [GitHub releases](https://github.com/00sapo/zotero-skimming/releases).
2. Open `Tools → Add-ons` in Zotero.
3. Open the gear menu and choose `Install Add-on From File…`.
4. Select the `.xpi` file. Restart Zotero if Zotero asks.
5. Optional: install Ollama from https://ollama.com/download.

Ollama runs the models on your computer. If your computer cannot run the models, use a remote API. For Google or Anthropic, use a local LiteLLM gateway. LiteLLM provides an OpenAI-compatible API.

## Usage

1. Open the PDF in the Zotero reader.
2. Open the `Paper skim` section in the right pane.
3. Select `Local Ollama` or `Remote API` in `Source`.
4. If you use `Local Ollama`, install Ollama. If Ollama is not on the PATH of Zotero, set `Ollama command`. For mise, use `mise exec -- ollama`. Click `Test Ollama`. The add-on starts Ollama and pulls the two models.
5. If you use `Remote API`, set `Endpoint` and `API key`. The model fields have defaults. Change them if your provider uses other models.
6. Set `Compression ratio`. A value of 2 selects about half of the body sentences. The minimum is 1.5.
7. Optional: enable `Semantic relevance`. The add-on then ranks sentences by meaning.
8. Optional: enable `Classify highlights from labeled summary`. Edit the TOML definitions to change the labels and colors.
9. Click `Annotate`. The add-on extracts the text, generates a summary, ranks the sentences, and creates the highlights.
10. Click `Test summary` to see the summary without highlights. Click `Delete annotations` to remove the automatic highlights.

If the PDF already contains automatic highlights, the add-on stops. Click `Delete annotations` before you run `Annotate` again.

## How it works

### Summary

The add-on sends only the body text to the summary model. It removes front matter, the abstract, tables, figures, and references. The requested summary length is about 1.5 sentences for each requested annotation.

`Local Ollama` sends the text to the local Ollama server. The add-on starts `ollama serve` when the configured command is available. `Remote API` sends the text to the configured OpenAI-compatible endpoint. The add-on hides the remote fields in local mode.

### Map-reduce

Map-reduce (split, summarize, then combine) is optional. The add-on splits long text into chunks and summarizes each chunk. It then summarizes the partial summaries. Local chunks contain N sentences. Remote map-reduce uses a 4096-token context window. The settings dialog shows the control in local mode. The setting also applies to remote summaries. Use map-reduce for long papers or small models.

### Ranking and highlights

When a summary is available, the add-on scores each sentence by its similarity to the summary and by its length. It penalizes similar sentences and extra picks from one section. `Semantic relevance` uses embeddings (numeric vectors that represent meaning) for the summary similarity. Without it, the add-on uses TF-IDF (word frequency) and sentence length.

The add-on restores the selected sentences to reading order and maps them to their rectangles on the PDF pages. Each highlight receives the `autoskim-key-sentence` tag.

With `Classify highlights from labeled summary`, the add-on compares each selected sentence with the summary labels or the label descriptions in the TOML box. It assigns the closest label and the label color.

`scoring-config.json` contains the score weights. `model-identifiers.json` contains the default model names.

## Models

| Stage | Default model |
|---|---|
| Summarization | `hf.co/unsloth/Qwen3.5-2B-GGUF:Q8_0` |
| Semantic relevance | `hf.co/PeterAM4/Qwen3-Embedding-0.6B-GGUF:Q8_0` |

`Test Ollama` pulls these models through the Ollama API. Ollama downloads the files from Hugging Face. Enter another model name in `Summary model` or `Embedding model` to use a different model.

## Similar plugins

SkimRead ([repository](https://github.com/adellife/zotero-skimread)) provides document-wide skimming for Zotero PDFs. A model selects the sentences.

Nodus ([repository](https://github.com/Drakonis96/nodus)) is a research workspace for Zotero. It includes search, cited answers, and sentence highlighting.

## Build and test

Requirements: Bash, Node.js, Yarn, `zip`, and `git`.

```sh
yarn install
./scripts/release.sh --only-build
yarn test
yarn coverage
node --check bootstrap.js
node --check content/annotator.js
node --check content/nlp.js
node --check content/model-manager.js
node --check content/remote-llm.js
git diff --check
```

`./scripts/release.sh --only-build` builds `zotero-skimming.xpi` in the repository root. It reads the version from `manifest.json` and includes the JSON configuration files, the icon asset, and the locale files.

Without `--only-build`, the script updates the version, updates `updates.json`, commits, tags, and can create a GitHub release.

Run the end-to-end smoke test against a real Zotero 10 installation and Ollama:

```sh
SMOKE_PDF="/path/to/paper.pdf" \
SMOKE_OLLAMA_COMMAND="mise exec -- ollama" \
yarn smoke
```

The smoke test runs the working tree in Zotero with a temporary profile. It checks summaries, embeddings, and highlights. It needs Ollama with the two models. See `AGENTS.md` for the options.

## References

- K. Rayner, E. R. Schotter, M. E. J. Masson, M. C. Potter, and R. Treiman, “So Much to Read, So Little Time,” Psychol Sci Public Interest, vol. 17, no. 1, pp. 4–34, Jan. 2016, doi: [10.1177/1529100615623267](https://doi.org/10.1177/1529100615623267).
- R. Fok et al., “Scim: Intelligent Skimming Support for Scientific Papers,” Proceedings of the 28th International Conference on Intelligent User Interfaces. ACM, pp. 476–490, Mar. 27, 2023. doi: [10.1145/3581641.3584034](https://doi.org/10.1145/3581641.3584034).
- G. B. Duggan and S. J. Payne, “Text skimming: The process and effectiveness of foraging through text under time pressure.,” Journal of Experimental Psychology: Applied, vol. 15, no. 3, pp. 228–242, 2009, doi: [10.1037/a0016995](https://doi.org/10.1037/a0016995).

## Repository

https://github.com/00sapo/zotero-skimming
