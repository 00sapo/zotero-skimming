/* global Zotero, ChromeUtils */

var FastKeySentenceModels = (() => {
  "use strict";

  const OLLAMA_URL = "http://127.0.0.1:11434";
  const OLLAMA_DOWNLOAD_URL = "https://ollama.com/download";
  const SUMMARY_MODEL = "zotero-skimming-summary";
  const EMBEDDING_MODEL = "zotero-skimming-embedding";
  const SUMMARY_REPOSITORY = "ar08/mT5_multilingual_XLSum-Q8_0-GGUF";
  const EMBEDDING_REPOSITORY = "Qwen/Qwen3-Embedding-0.6B-GGUF";
  const DEFAULT_CONTEXT_WINDOW = 4096;
  const MIN_CONTEXT_WINDOW = 256;
  const COMMAND_PREF = "extensions.fast-offline-key-sentence-annotator.ollamaCommand";

  let cacheDir = null;
  let logFile = null;
  let ollamaProcess = null;
  let subprocess = null;

  function errorDetail(error) {
    return error?.stack || error?.message || String(error || "");
  }

  function init() {
    cacheDir = PathUtils.join(PathUtils.profileDir, "fast-key-sentence-annotator", "ollama");
    logFile = PathUtils.join(cacheDir, "logs", "ollama.log");
  }

  async function appendToLog(message) {
    try {
      if (!logFile) init();
      await IOUtils.makeDirectory(PathUtils.parent(logFile), { ignoreExisting: true });
      const previous = await IOUtils.exists(logFile) ? new TextDecoder().decode(await IOUtils.read(logFile)) : "";
      await IOUtils.write(logFile, new TextEncoder().encode((previous + `[${new Date().toISOString()}] ${message}\n`).slice(-2 * 1024 * 1024)));
    }
    catch (_) {}
  }

  function log(message) {
    Zotero.debug("Fast Offline Key-Sentence Annotator Ollama: " + message);
    void appendToLog(message);
  }

  function getSubprocess() {
    if (subprocess) return subprocess;
    if (globalThis.Subprocess) return globalThis.Subprocess;
    if (!ChromeUtils?.importESModule) throw new Error("Zotero cannot launch Ollama on this platform.");
    subprocess = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs").Subprocess;
    return subprocess;
  }

  async function ollamaRequest(path, body = null) {
    const response = await fetch(OLLAMA_URL + path, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`Ollama returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return response.json();
  }

  async function isOllamaReady() {
    try {
      await ollamaRequest("/api/version");
      return true;
    }
    catch (_) {
      return false;
    }
  }

  function configuredCommand(command = null) {
    const value = command ?? Zotero.Prefs?.get(COMMAND_PREF, true) ?? "ollama";
    const parts = String(value).trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    const parsed = parts.map(part => part.replace(/^("|')|("|')$/g, ""));
    if (!parsed.length) throw new Error("Set an Ollama command before starting the local server.");
    return parsed;
  }

  async function ensureOllama(callback, command = null) {
    if (await isOllamaReady()) return;
    const [binary, ...arguments_] = configuredCommand(command);
    let executable = binary;
    try {
      const resolved = await getSubprocess().pathSearch(binary);
      if (!resolved && binary === "ollama") {
        Zotero.launchURL?.(OLLAMA_DOWNLOAD_URL);
        throw new Error("Ollama is not installed. Its download page has been opened; install Ollama, then try again.");
      }
      executable = resolved || binary;
    }
    catch (error) {
      if (/Ollama is not installed/.test(error.message || "")) throw error;
    }
    callback?.({ operation: "runtime", stage: "initiate", model: "Ollama", progress: 0 });
    try {
      ollamaProcess = await getSubprocess().call({ command: executable, arguments: [...arguments_, "serve"] });
    }
    catch (error) {
      Zotero.launchURL?.(OLLAMA_DOWNLOAD_URL);
      throw new Error(`Could not launch Ollama with “${configuredCommand(command).join(" ")} serve”. The Ollama download page has been opened. ${error.message || error}`);
    }
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await isOllamaReady()) {
        callback?.({ operation: "runtime", stage: "done", model: "Ollama", progress: 100 });
        return;
      }
      await Zotero.Promise.delay(250);
    }
    throw new Error("Ollama started but did not become ready. Check its local logs and GPU drivers.");
  }

  function modelDirectory() {
    if (!cacheDir) init();
    return PathUtils.join(cacheDir, "models");
  }

  async function downloadToFile(url, destination, callback, model, file) {
    await IOUtils.makeDirectory(PathUtils.parent(destination), { ignoreExisting: true });
    const temporary = destination + ".part";
    await IOUtils.remove(temporary, { ignoreAbsent: true });
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
    const total = Number(response.headers.get("content-length")) || 0;
    const chunks = [];
    let loaded = 0;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value?.length) continue;
        chunks.push(value);
        loaded += value.length;
        callback?.({ operation: "model-download", stage: "download", model, file, loaded, total, progress: total ? 100 * loaded / total : null });
      }
    }
    else {
      const bytes = new Uint8Array(await response.arrayBuffer());
      chunks.push(bytes);
      loaded = bytes.length;
    }
    const bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    if (!bytes.length) throw new Error(`Downloaded an empty model file from ${url}`);
    await IOUtils.write(temporary, bytes);
    await IOUtils.move(temporary, destination, { noOverwrite: false });
    callback?.({ operation: "model-download", stage: "done", model, file, loaded, total: total || loaded, progress: 100 });
    return destination;
  }

  async function resolveGGUF(repository, preference) {
    const response = await fetch(`https://huggingface.co/api/models/${repository}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Could not read ${repository} (${response.status}).`);
    const manifest = await response.json();
    const files = (manifest.siblings || []).map(item => item.rfilename || item.path || "").filter(name => name.endsWith(".gguf"));
    const file = files.find(name => preference.test(name)) || files[0];
    if (!file) throw new Error(`No GGUF file was found in ${repository}.`);
    return { file, revision: manifest.sha || "main" };
  }

  async function createModel(name, ggufPath, callback) {
    callback?.({ operation: "model-import", stage: "initiate", model: name, progress: 0 });
    const bytes = await IOUtils.read(ggufPath);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    const blobResponse = await fetch(`${OLLAMA_URL}/api/blobs/sha256:${digest}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes
    });
    if (!blobResponse.ok) throw new Error(`Ollama rejected ${PathUtils.filename(ggufPath)} (${blobResponse.status}).`);
    await ollamaRequest("/api/create", {
      model: name,
      files: { [PathUtils.filename(ggufPath)]: `sha256:${digest}` },
      stream: false
    });
    callback?.({ operation: "model-import", stage: "done", model: name, progress: 100 });
  }

  async function provisionModel(name, repository, preference, contextWindow, callback) {
    const { file, revision } = await resolveGGUF(repository, preference);
    const destination = PathUtils.join(modelDirectory(), name, file);
    if (!await IOUtils.exists(destination)) {
      await downloadToFile(`https://huggingface.co/${repository}/resolve/${revision}/${file}`, destination, callback, name, file);
    }
    await createModel(name, destination, callback);
    await IOUtils.writeJSON(PathUtils.join(modelDirectory(), name, "download-manifest.json"), {
      name, repository, revision, file, downloadedAt: new Date().toISOString()
    });
  }

  async function updateModels(settings, callback) {
    const contextWindow = validContextWindow(settings.mapReduceInputTokens);
    await ensureOllama(callback, settings.ollamaCommand);
    await provisionModel(SUMMARY_MODEL, SUMMARY_REPOSITORY, /q8[_-]0/i, contextWindow, callback);
    await provisionModel(EMBEDDING_MODEL, EMBEDDING_REPOSITORY, /q8[_-]0/i, contextWindow, callback);
    callback?.({ operation: "all", stage: "complete", model: "Ollama models", progress: 100 });
    return true;
  }

  function validContextWindow(value) {
    const number = Number(value);
    return Number.isInteger(number) && number >= MIN_CONTEXT_WINDOW ? number : DEFAULT_CONTEXT_WINDOW;
  }

  function contextBudget(contextWindow) {
    const window = validContextWindow(contextWindow);
    const reserve = Math.max(128, Math.min(512, Math.floor(window / 2)));
    return { input: Math.max(1, window - reserve), output: Math.max(32, Math.min(240, reserve - 80)) };
  }

  function estimateTokens(text) {
    const units = String(text || "").match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) || [];
    return units.reduce((total, unit) => total + (/^[\p{L}\p{N}]+$/u.test(unit) ? Math.max(1, Math.ceil(unit.length / 3)) : 1), 0);
  }

  function overlapTail(text, targetTokens) {
    const words = String(text).match(/\S+\s*/g) || [];
    let tail = "";
    let tokens = 0;
    for (let index = words.length - 1; index >= 0 && tokens < targetTokens; index--) {
      tail = words[index] + tail;
      tokens += estimateTokens(words[index]);
    }
    return tail;
  }

  function splitByTokenLimit(text, limit, overlap = 0) {
    const chunks = [];
    let chunk = "";
    let tokens = 0;
    for (const part of String(text || "").match(/[^.!?]+[.!?]*|.+$/g) || []) {
      for (const word of part.match(/\S+\s*/g) || []) {
        const wordTokens = estimateTokens(word);
        if (chunk && tokens + wordTokens > limit) {
          chunks.push(chunk.trim());
          chunk = overlap ? overlapTail(chunk, Math.max(1, Math.floor(limit * overlap))) : "";
          tokens = estimateTokens(chunk);
        }
        chunk += word;
        tokens += wordTokens;
      }
    }
    if (chunk.trim()) chunks.push(chunk.trim());
    return chunks;
  }

  async function summarizeChunk(text, callback, { sentenceCount = 10, maxNewTokens = 240, contextWindow } = {}) {
    const prompt = text;
    callback?.({ stage: "inference", model: SUMMARY_MODEL, progress: 0 });
    const result = await ollamaRequest("/api/generate", {
      model: SUMMARY_MODEL,
      prompt,
      system: "You are a research assistant.",
      stream: false,
      keep_alive: "5m",
      options: { temperature: 0, num_predict: maxNewTokens, num_ctx: validContextWindow(contextWindow) }
    });
    callback?.({ stage: "inference", model: SUMMARY_MODEL, progress: 100 });
    return String(result.response || "").replace(/\s+/g, " ").trim();
  }

  async function summarize(text, callback, { mapReduce = false, contextWindow = DEFAULT_CONTEXT_WINDOW, sentenceCount = 10 } = {}) {
    if (!text) return "";
    await ensureOllama(callback);
    const budget = contextBudget(contextWindow);
    const totalSentences = Math.max(1, Math.round(Number(sentenceCount) || 10));
    const chunks = splitByTokenLimit(text, budget.input, mapReduce ? 0.05 : 0);
    if (!chunks.length) return "";
    if (!mapReduce || chunks.length < 2) {
      return summarizeChunk(chunks[0], callback, { sentenceCount: totalSentences, maxNewTokens: budget.output, contextWindow });
    }
    // Map: summarize each chunk independently
    const mapSentences = Math.max(3, Math.ceil(totalSentences * 1.5 / chunks.length));
    const summaries = [];
    for (let index = 0; index < chunks.length; index++) {
      callback?.({ stage: "mapping", model: SUMMARY_MODEL, completed: index, total: chunks.length, progress: 100 * index / chunks.length });
      summaries.push(await summarizeChunk(chunks[index], callback, { sentenceCount: mapSentences, maxNewTokens: budget.output, contextWindow }));
      callback?.({ stage: "mapping", model: SUMMARY_MODEL, completed: index + 1, total: chunks.length, progress: 100 * (index + 1) / chunks.length });
    }
    // Reduce: combine chunk summaries
    let combined = summaries.join("\n\n");
    for (let round = 0; round < 8; round++) {
      const parts = splitByTokenLimit(combined, Math.min(budget.input, Math.floor(budget.input * (1 + round) / 2)), 0);
      if (parts.length < 2) return combined;
      callback?.({ stage: "reducing", model: SUMMARY_MODEL, round: round + 1, completed: 0, total: parts.length });
      const reduction = [];
      for (let index = 0; index < parts.length; index++) {
        callback?.({ stage: "reducing", model: SUMMARY_MODEL, round: round + 1, completed: index + 1, total: parts.length, progress: 100 * (index + 1) / parts.length });
        reduction.push(await summarizeChunk(parts[index], callback, { sentenceCount: totalSentences, maxNewTokens: budget.output, contextWindow }));
      }
      combined = reduction.join("\n\n");
    }
    return combined;
  }

  async function embeddings(texts, callback) {
    if (!texts.length) return [];
    await ensureOllama(callback);
    callback?.({ stage: "inference", model: EMBEDDING_MODEL, progress: 0 });
    const result = await ollamaRequest("/api/embed", { model: EMBEDDING_MODEL, input: texts, keep_alive: "5m" });
    const vectors = Array.isArray(result.embeddings) ? result.embeddings.map(vector => vector.map(Number)) : [];
    if (vectors.length !== texts.length) throw new Error("Ollama returned an incomplete embedding response.");
    callback?.({ stage: "inference", model: EMBEDDING_MODEL, progress: 100 });
    return vectors;
  }

  function supportsInference() {
    return true;
  }

  function shutdown() {
    try { ollamaProcess?.kill?.(); } catch (_) {}
    ollamaProcess = null;
  }

  return {
    SUMMARY_MODEL,
    EMBEDDING_MODEL,
    OLLAMA_URL,
    init,
    shutdown,
    summarize,
    embeddings,
    updateModels,
    supportsInference,
    log,
    appendToLog,
    estimateTokens,
    splitByTokenLimit
  };
})();
