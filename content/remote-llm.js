/* global Zotero */

var FastKeySentenceRemote = (() => {
  "use strict";

  const DEFAULT_MODEL = "gpt-4o-mini";
  const DEFAULT_ENDPOINT = "https://api.openai.com/v1/chat/completions";
  const MAX_RETRIES = 2;

  function errorDetail(error) {
    const e = error || "";
    const msg = typeof e === "object" && e !== null ? (e.message || String(e)) : String(e);
    const stack = typeof e === "object" && e !== null ? e.stack : "";
    return `${msg} (type: ${typeof e})${stack ? `\n${stack}` : ""}`;
  }

  function log(message) {
    Zotero.debug("Fast Offline Key-Sentence Annotator remote: " + message);
  }

  function getConfig() {
    const pref = "extensions.fast-offline-key-sentence-annotator.";
    return {
      endpoint: Zotero.Prefs.get(pref + "remoteEndpoint", true) || DEFAULT_ENDPOINT,
      apiKey: Zotero.Prefs.get(pref + "remoteApiKey", true) || "",
      model: Zotero.Prefs.get(pref + "remoteModel", true) || DEFAULT_MODEL
    };
  }

  function saveConfig({ endpoint, apiKey, model }) {
    const pref = "extensions.fast-offline-key-sentence-annotator.";
    Zotero.Prefs.set(pref + "remoteEndpoint", endpoint || "", true);
    Zotero.Prefs.set(pref + "remoteApiKey", apiKey || "", true);
    Zotero.Prefs.set(pref + "remoteModel", model || "", true);
  }

  const SUMMARY_SENTENCES_PER_ANNOTATION = 1.5;

  async function summarize(paperText, documentTitle, sentenceCount = 10, onProgress = null) {
    const { endpoint, apiKey, model } = getConfig();
    if (!apiKey) throw new Error("No remote API key configured. Set it in the annotator settings.");
    if (!endpoint) throw new Error("No remote endpoint configured.");

    const targetSentences = Math.max(3, Math.round(sentenceCount * SUMMARY_SENTENCES_PER_ANNOTATION));
    const targetTokens = Math.min(1000, Math.max(120, targetSentences * 30));

    const systemPrompt = [
      "You are a research assistant. Summarize the following academic paper in a single compact paragraph.",
      `Aim for about ${targetSentences} sentences. Cover: the research objective, the method or approach,`,
      "the main empirical findings, and any key limitations or conclusions.",
      "Be precise, concise, and avoid filler."
    ].join(" ");

    const userText = documentTitle
      ? `Title: ${documentTitle}\n\n${paperText}`
      : paperText;

    const body = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText.slice(0, 128000) }
      ],
      temperature: 0.1,
      max_tokens: targetTokens
    };

    onProgress?.({ stage: "sending", model });
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          onProgress?.({ stage: "retrying", model, attempt, message: `Retry ${attempt}/${MAX_RETRIES}` });
          await new Promise(resolve => Zotero.Promise.delay?.(2000 * attempt) || setTimeout(resolve, 2000 * attempt));
        }
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
          },
          body: JSON.stringify(body)
        });
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new Error(`Remote LLM returned ${response.status}: ${text.slice(0, 200)}`);
        }
        const data = await response.json();
        const content = data?.choices?.[0]?.message?.content || "";
        if (!content) throw new Error("Remote LLM returned an empty response.");
        onProgress?.({ stage: "done", model });
        return content.replace(/\s+/g, " ").trim();
      }
      catch (error) {
        lastError = error;
        log(`Summarization attempt ${attempt + 1} failed: ${errorDetail(error)}`);
      }
    }
    throw new Error(`Remote summarization failed after ${MAX_RETRIES + 1} attempts: ${lastError?.message || lastError}`);
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

  return {
    DEFAULT_MODEL,
    DEFAULT_ENDPOINT,
    getConfig,
    saveConfig,
    summarize,
    validateConfig,
    log
  };
})();
