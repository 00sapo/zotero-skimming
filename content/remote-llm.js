/* global Zotero, Services */

var FastKeySentenceRemote = (() => {
  "use strict";

  const DEFAULT_MODEL = "gpt-4o-mini";
  const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
  const DEFAULT_ENDPOINT = "https://api.openai.com/v1/chat/completions";
  const DEFAULT_MAP_INPUT_TOKENS = 4096;
  const MIN_MAP_INPUT_TOKENS = 256;
  const MAP_PROMPT_TOKEN_RESERVE = 512;
  const MAX_REDUCE_ROUNDS = 16;
  const MAX_RETRIES = 2;
  const SUMMARY_SENTENCES_PER_ANNOTATION = 1.5;

  function errorDetail(error) {
    const e = error || "";
    const msg = typeof e === "object" && e !== null ? (e.message || String(e)) : String(e);
    const stack = typeof e === "object" && e !== null ? e.stack : "";
    return `${msg} (type: ${typeof e})${stack ? `\n${stack}` : ""}`;
  }

  function log(message) {
    Zotero.debug("Zotero Skimming remote: " + message);
  }

  function getConfig() {
    const pref = "extensions.zotero-skimming.";
    const mapInputTokens = Number(Zotero.Prefs.get(pref + "mapReduceInputTokens", true));
    return {
      endpoint: Zotero.Prefs.get(pref + "remoteEndpoint", true) || DEFAULT_ENDPOINT,
      apiKey: Zotero.Prefs.get(pref + "remoteApiKey", true) || "",
      model: Zotero.Prefs.get(pref + "summaryModel", true) || DEFAULT_MODEL,
      mapReduce: Zotero.Prefs.get(pref + "mapReduce", true) === true,
      mapInputTokens: Number.isInteger(mapInputTokens) && mapInputTokens >= MIN_MAP_INPUT_TOKENS
        ? mapInputTokens
        : DEFAULT_MAP_INPUT_TOKENS
    };
  }

  function saveConfig({ endpoint, apiKey, model, mapReduce = false, mapInputTokens = DEFAULT_MAP_INPUT_TOKENS }) {
    const pref = "extensions.zotero-skimming.";
    Zotero.Prefs.set(pref + "remoteEndpoint", endpoint || "", true);
    Zotero.Prefs.set(pref + "remoteApiKey", apiKey || "", true);
    Zotero.Prefs.set(pref + "summaryModel", model || "", true);
    Zotero.Prefs.set(pref + "mapReduce", mapReduce === true, true);
    Zotero.Prefs.set(pref + "mapReduceInputTokens", mapInputTokens, true);
  }

  function estimateTokens(text) {
    const units = String(text || "").match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) || [];
    return units.reduce((total, unit) => total + (/^[\p{L}\p{N}]+$/u.test(unit)
      ? Math.max(1, Math.ceil(unit.length / 3))
      : 1), 0);
  }

  function splitOversizeSegment(segment, limit) {
    const chunks = [];
    let current = "";
    let currentTokens = 0;
    for (const unit of String(segment).match(/\S+\s*/g) || []) {
      const tokens = estimateTokens(unit);
      if (current && currentTokens + tokens > limit) {
        chunks.push(current.trim());
        current = "";
        currentTokens = 0;
      }
      if (tokens > limit) {
        for (let start = 0; start < unit.length; start += limit * 2) chunks.push(unit.slice(start, start + limit * 2));
      }
      else {
        current += unit;
        currentTokens += tokens;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
  }

  function splitByTokenLimit(text, limit) {
    const segments = String(text || "").match(/[^.!?]+[.!?]*|.+$/g) || [];
    const chunks = [];
    let current = "";
    let currentTokens = 0;
    for (const segment of segments) {
      const tokens = estimateTokens(segment);
      if (tokens > limit) {
        if (current.trim()) chunks.push(current.trim());
        chunks.push(...splitOversizeSegment(segment, limit));
        current = "";
        currentTokens = 0;
      }
      else if (current && currentTokens + tokens > limit) {
        chunks.push(current.trim());
        current = segment;
        currentTokens = tokens;
      }
      else {
        current += segment;
        currentTokens += tokens;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
  }

  async function requestSummary(config, systemPrompt, userText, maxTokens, onProgress, event = {}) {
    const body = {
      model: config.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText }
      ],
      temperature: 0.1,
      max_tokens: maxTokens
    };

    onProgress?.({ stage: "sending", model: config.model, ...event });
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          onProgress?.({ stage: "retrying", model: config.model, attempt, message: `Retry ${attempt}/${MAX_RETRIES}`, ...event });
          await new Promise(resolve => Zotero.Promise.delay?.(2000 * attempt) || setTimeout(resolve, 2000 * attempt));
        }
        const response = await fetch(config.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${config.apiKey}`
          },
          body: JSON.stringify(body)
        });
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new Error(`Remote LLM returned ${response.status}: ${text.slice(0, 200)}`);
        }
        const content = (await response.json())?.choices?.[0]?.message?.content || "";
        if (!content) throw new Error("Remote LLM returned an empty response.");
        return content.replace(/[ \t]+/g, " ").trim();
      }
      catch (error) {
        lastError = error;
        log(`Summarization attempt ${attempt + 1} failed: ${errorDetail(error)}`);
      }
    }
    throw new Error(`Remote summarization failed after ${MAX_RETRIES + 1} attempts: ${lastError?.message || lastError}`);
  }

  const SYSTEM_PROMPT = [
    "Return the summary directly without \"Here is...\" nor comments.",
    "Return just the summary.",
    "The summaries are made of one sentence per line, without blank lines, nor sections or titles.",
    "Number the lines starting from 1."
  ].join(" ");

  function summaryPrompt(targetSentences) {
    return `Write a summary of exactly ${targetSentences} numbered sentences. Summary:`;
  }

  function mapBudget(contextWindow) {
    const reserve = Math.max(128, Math.min(MAP_PROMPT_TOKEN_RESERVE, Math.floor(contextWindow / 2)));
    return {
      input: Math.max(1, contextWindow - reserve),
      output: Math.max(32, Math.min(400, reserve - 80))
    };
  }

  async function summarizeMapReduce(paperText, documentTitle, targetSentences, targetTokens, config, onProgress) {
    const budget = mapBudget(config.mapInputTokens);
    const inputLimit = budget.input;
    const source = documentTitle ? `Title: ${documentTitle}\n\n${paperText}` : paperText;
    let chunks = splitByTokenLimit(source, inputLimit);
    if (!chunks.length) throw new Error("No paper text available for map-reduce summarization.");
    let round = 0;
    while (round < MAX_REDUCE_ROUNDS) {
      const total = chunks.length;
      const prompt = summaryPrompt(targetSentences);
      const outputTokens = Math.min(targetTokens, budget.output);
      const summaries = [];
      for (let index = 0; index < chunks.length; index++) {
        onProgress?.({ stage: "mapping", model: config.model, round: round + 1, completed: index, total, progress: 100 * index / total });
        summaries.push(await requestSummary(config, SYSTEM_PROMPT, chunks[index] + "\n\n" + prompt, outputTokens, onProgress, {
          round: round + 1,
          chunk: index + 1,
          total
        }));
        onProgress?.({ stage: "mapping", model: config.model, round: round + 1, completed: index + 1, total, progress: 100 * (index + 1) / total });
      }
      if (total === 1) return summaries[0];
      chunks = splitByTokenLimit(summaries.join("\n\n"), inputLimit);
      round++;
    }
    throw new Error("Map-reduce summarization did not produce a final summary.");
  }

  async function summarize(paperText, documentTitle, sentenceCount = 10, onProgress = null) {
    const config = getConfig();
    if (!config.apiKey) throw new Error("No remote API key configured. Set it in the annotator settings.");
    if (!config.endpoint) throw new Error("No remote endpoint configured.");

    const targetSentences = Math.max(3, Math.round(sentenceCount * SUMMARY_SENTENCES_PER_ANNOTATION));
    Services.console.logStringMessage(`Zotero Skimming remote: summarize inputChars=${paperText.length} targetSentences=${targetSentences} mapReduce=${config.mapReduce}`);
    const targetTokens = Math.min(1000, Math.max(120, targetSentences * 30));
    let summary;
    if (config.mapReduce) {
      summary = await summarizeMapReduce(paperText, documentTitle, targetSentences, targetTokens, config, onProgress);
    }
    else {
      const userText = documentTitle ? `Title: ${documentTitle}\n\n${paperText}` : paperText;
      const instruction = summaryPrompt(targetSentences);
      summary = await requestSummary(config, SYSTEM_PROMPT, (userText + "\n\n" + instruction).slice(0, 128000), targetTokens, onProgress);
    }
    const responseSentences = (summary || "").split(/\n/).filter(line => line.trim()).length;
    Services.console.logStringMessage(`Zotero Skimming remote: summarize responseSentences=${responseSentences} responseChars=${(summary || "").length}`);
    onProgress?.({ stage: "done", model: config.model });
    return summary;
  }

  async function validateConfig({ endpoint, apiKey, model }) {
    if (!apiKey) return { valid: false, error: "API key is required." };
    if (!endpoint) return { valid: false, error: "Endpoint URL is required." };
    try {
      new URL(endpoint);
    }
    catch (_) {
      return { valid: false, error: "Invalid endpoint URL." };
    }
    if (!model) return { valid: false, error: "Model name is required." };
    return { valid: true };
  }

  async function embeddings(texts, callback) {
    if (!Array.isArray(texts) || !texts.length) throw new Error("No texts provided for embedding.");
    const config = getConfig();
    if (!config.apiKey) throw new Error("No remote API key configured.");
    const model = Zotero.Prefs.get("extensions.zotero-skimming." + "embeddingModel", true) || DEFAULT_EMBEDDING_MODEL;
    const url = config.endpoint.replace(/\/chat\/completions$/, "").replace(/\/?$/, "") + "/embeddings";
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({ model, input: texts })
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Remote embedding returned ${response.status}: ${text.slice(0, 200)}`);
    }
    const data = await response.json();
    if (!Array.isArray(data?.data)) throw new Error("Remote embedding returned invalid response.");
    const vectors = data.data
      .sort((a, b) => a.index - b.index)
      .map(item => item.embedding);
    if (vectors.length !== texts.length) {
      throw new Error(`Remote embedding returned ${vectors.length} vectors for ${texts.length} texts.`);
    }
    return vectors;
  }

  return {
    DEFAULT_MODEL,
    DEFAULT_EMBEDDING_MODEL,
    DEFAULT_ENDPOINT,
    MAP_PROMPT_TOKEN_RESERVE,
    getConfig,
    estimateTokens,
    splitByTokenLimit,
    summarize,
    embeddings,
    validateConfig,
    log
  };
})();
