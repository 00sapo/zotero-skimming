/* global Zotero */

var FastKeySentenceModels = (() => {
  "use strict";

  // Pinned to the latest stable v3 release. The runtime is loaded only when an
  // LLM stage is enabled. Model assets are fetched from Hugging Face and kept
  // in Transformers.js' persistent browser cache.
  const TRANSFORMERS_VERSION = "3.8.1";
  const RUNTIME_URL = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}`;
  const DTYPE = "q8";
  const IN_PROCESS_INFERENCE_ENABLED = true;
  const WASM_FILENAME = "ort-wasm-simd-threaded.jsep.wasm";

  const MODELS = Object.freeze(FastKeySentenceModelIdentifiers);

  let rootURI = null;
  let cacheDir = null;
  let runtimeFile = null;
  let runtimePromise = null;
  let wasmBlobURL = null;
  let hostPromise = null;
  let hostFrame = null;
  const objectCache = new Map();

  function log(message) {
    Zotero.debug("Fast Offline Key-Sentence Annotator models: " + message);
  }

  function init(options = {}) {
    rootURI = options.rootURI || rootURI;
    cacheDir = PathUtils.join(PathUtils.profileDir, "fast-key-sentence-annotator");
    runtimeFile = PathUtils.join(cacheDir, "runtime", `transformers-${TRANSFORMERS_VERSION}.min.mjs`);
  }

  function formatDownloadEvent(callback, model, file, loaded, total, stage = "download") {
    callback?.({
      operation: "runtime",
      stage,
      model,
      file,
      loaded,
      total,
      progress: total > 0 ? 100 * loaded / total : null
    });
  }

  async function downloadToFile(url, destination, callback, label) {
    await IOUtils.makeDirectory(PathUtils.parent(destination), { ignoreExisting: true });
    const temp = destination + ".part";
    await IOUtils.remove(temp, { ignoreAbsent: true });

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
        if (value?.length) {
          chunks.push(value);
          loaded += value.length;
          formatDownloadEvent(callback, label, PathUtils.filename(destination), loaded, total);
        }
      }
    }
    else {
      const bytes = new Uint8Array(await response.arrayBuffer());
      chunks.push(bytes);
      loaded = bytes.length;
      formatDownloadEvent(callback, label, PathUtils.filename(destination), loaded, total || loaded);
    }
    const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    if (!bytes.length) throw new Error(`Downloaded an empty file from ${url}`);
    await IOUtils.write(temp, bytes);
    await IOUtils.move(temp, destination, { noOverwrite: false });
    formatDownloadEvent(callback, label, PathUtils.filename(destination), bytes.length, total || bytes.length, "done");
    return destination;
  }

  async function ensureRuntimeDownloaded(callback, force = false) {
    if (!runtimeFile) init({});
    if (!force && await IOUtils.exists(runtimeFile)) return runtimeFile;
    callback?.({ operation: "runtime", stage: "initiate", model: "Transformers.js", progress: 0 });
    return downloadToFile(RUNTIME_URL + "/dist/transformers.min.js", runtimeFile, callback, "Transformers.js");
  }

  async function ensureWasmDownloaded(callback, force = false) {
    if (!cacheDir) init({});
    const destination = PathUtils.join(cacheDir, "runtime", WASM_FILENAME);
    if (!force && await IOUtils.exists(destination)) return destination;
    callback?.({ operation: "runtime", stage: "initiate", model: "ONNX Runtime WASM", file: WASM_FILENAME, progress: 0 });
    return downloadToFile(`${RUNTIME_URL}/dist/${WASM_FILENAME}`, destination, callback, "ONNX Runtime WASM");
  }

  function requestURL(request) {
    if (typeof request === "string") return request;
    return request?.url || String(request || "");
  }

  function modelFileFromURL(url) {
    for (const name of Object.values(MODELS).flatMap(group => Object.values(group))) {
      const encoded = name.split("/").map(encodeURIComponent).join("/");
      for (const id of [name, encoded]) {
        const marker = `/${id}/resolve/`;
        const index = url.indexOf(marker);
        if (index < 0) continue;
        const tail = url.slice(index + marker.length);
        const slash = tail.indexOf("/");
        if (slash < 0) continue;
        const file = decodeURIComponent(tail.slice(slash + 1).split(/[?#]/)[0]);
        return { name, file };
      }
    }
    return null;
  }

  function createLocalModelCache(hostWindow) {
    return {
      async match(request) {
        const parsed = modelFileFromURL(requestURL(request));
        if (!parsed) return undefined;
        const path = PathUtils.join(cacheDir, "models", ...parsed.name.split("/"), ...parsed.file.split("/"));
        if (!await IOUtils.exists(path)) return undefined;
        const bytes = await IOUtils.read(path);
        return new hostWindow.Response(bytes, {
          status: 200,
          headers: {
            "content-type": parsed.file.endsWith(".json") ? "application/json" : "application/octet-stream",
            "content-length": String(bytes.byteLength)
          }
        });
      },
      async put() {
        // Downloads are managed explicitly by Update models.
      }
    };
  }

  function getHostModule(hostWindow) {
    try {
      return hostWindow?.FastKeySentenceTransformers
        || hostWindow?.wrappedJSObject?.FastKeySentenceTransformers
        || null;
    }
    catch (_) {
      return null;
    }
  }

  async function createModuleHost(callback) {
    const runtimePath = await ensureRuntimeDownloaded(callback, false);
    const owner = Zotero.getMainWindow?.();
    if (!owner?.document) throw new Error("No Zotero main window is available for transformer inference.");

    const doc = owner.document;
    const HTML_NS = "http://www.w3.org/1999/xhtml";
    hostFrame = doc.getElementById("fast-key-sentence-transformer-host");
    if (!hostFrame) {
      hostFrame = doc.createElementNS(HTML_NS, "iframe");
      hostFrame.id = "fast-key-sentence-transformer-host";
      hostFrame.setAttribute("aria-hidden", "true");
      hostFrame.style.cssText = "position:fixed;width:1px;height:1px;left:-10000px;top:-10000px;border:0;visibility:hidden;pointer-events:none";
      hostFrame.src = "about:blank";
      doc.documentElement.appendChild(hostFrame);
      await new Promise(resolve => owner.setTimeout(resolve, 0));
    }

    const hostWindow = hostFrame.contentWindow;
    const hostDocument = hostFrame.contentDocument;
    if (!hostWindow || !hostDocument) throw new Error("Could not create the transformer module context.");
    const existing = getHostModule(hostWindow);
    if (existing) return existing;

    callback?.({ operation: "runtime", stage: "runtime", model: "Transformers.js", progress: 0 });
    const sourceBytes = await IOUtils.read(runtimePath);
    const source = new TextDecoder().decode(sourceBytes);
    const runtimeBlobURL = hostWindow.URL.createObjectURL(new hostWindow.Blob([source], { type: "text/javascript" }));
    const wrapper = `
      try {
        const Transformers = await import(${JSON.stringify(runtimeBlobURL)});
        globalThis.FastKeySentenceTransformers = Transformers;
        globalThis.dispatchEvent(new CustomEvent("fast-key-sentence-transformers-ready"));
      }
      catch (error) {
        globalThis.dispatchEvent(new CustomEvent("fast-key-sentence-transformers-error", { detail: error?.message || String(error) }));
      }
    `;
    const wrapperURL = hostWindow.URL.createObjectURL(new hostWindow.Blob([wrapper], { type: "text/javascript" }));

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        hostWindow.removeEventListener("fast-key-sentence-transformers-ready", onReady);
        hostWindow.removeEventListener("fast-key-sentence-transformers-error", onError);
        hostWindow.URL.revokeObjectURL(wrapperURL);
      };
      const fail = error => {
        if (settled) return;
        settled = true;
        cleanup();
        hostWindow.URL.revokeObjectURL(runtimeBlobURL);
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const onReady = () => {
        if (settled) return;
        const mod = getHostModule(hostWindow);
        if (!mod?.pipeline || !mod?.env) return fail(new Error("The local Transformers.js runtime is incomplete."));
        settled = true;
        cleanup();
        callback?.({ operation: "runtime", stage: "runtime", model: "Transformers.js", progress: 100 });
        resolve(mod);
      };
      const onError = event => fail(new Error(event?.detail || "The local Transformers.js runtime failed to load."));
      hostWindow.addEventListener("fast-key-sentence-transformers-ready", onReady);
      hostWindow.addEventListener("fast-key-sentence-transformers-error", onError);
      const script = hostDocument.createElementNS(HTML_NS, "script");
      script.type = "module";
      script.src = wrapperURL;
      script.addEventListener("error", () => fail(new Error("The local transformer module could not be executed.")), { once: true });
      (hostDocument.head || hostDocument.documentElement).appendChild(script);
      owner.setTimeout(() => fail(new Error("Transformer runtime initialization timed out.")), 120000);
    });
  }

  async function runtime(callback) {
    if (!runtimePromise) {
      if (!hostPromise) hostPromise = createModuleHost(callback);
      runtimePromise = hostPromise.then(async mod => {
        if (!mod?.pipeline || !mod?.env) {
          throw new Error("The downloaded Transformers.js module is incomplete.");
        }
        const hostWindow = hostFrame?.contentWindow;
        if (!hostWindow) throw new Error("The transformer host window is unavailable.");

        // Resolve every model request from the files downloaded by Update models.
        // Remote access stays enabled only so Transformers.js constructs the
        // canonical Hub URL used as the custom-cache key; cache misses fail
        // before inference with a clear error instead of silently re-downloading.
        mod.env.allowRemoteModels = true;
        mod.env.allowLocalModels = false;
        mod.env.useBrowserCache = false;
        mod.env.useCustomCache = true;
        mod.env.customCache = createLocalModelCache(hostWindow);

        if (mod.env.backends?.onnx?.wasm) {
          const wasmPath = PathUtils.join(cacheDir, "runtime", WASM_FILENAME);
          if (!await IOUtils.exists(wasmPath)) {
            throw new Error("ONNX Runtime WASM is missing. Use Update models first.");
          }
          const wasmBytes = await IOUtils.read(wasmPath);
          if (wasmBlobURL) hostWindow.URL.revokeObjectURL(wasmBlobURL);
          wasmBlobURL = hostWindow.URL.createObjectURL(
            new hostWindow.Blob([wasmBytes], { type: "application/wasm" })
          );
          mod.env.backends.onnx.wasm.wasmPaths = { wasm: wasmBlobURL };
          mod.env.backends.onnx.wasm.numThreads = 1;
          mod.env.backends.onnx.wasm.proxy = false;
        }
        return mod;
      }).catch(error => {
        runtimePromise = null;
        hostPromise = null;
        throw new Error(
          "Could not initialize the locally downloaded Transformers.js runtime. "
          + (error?.message || error)
        );
      });
    }
    return runtimePromise;
  }

  function modelName(kind, multilingual) {
    return MODELS[kind][multilingual ? "multilingual" : "en"];
  }

  function report(callback, model, event) {
    if (!callback || !event) return;
    const progress = Number(event.progress);
    const loaded = Number(event.loaded);
    const total = Number(event.total);
    callback({
      stage: event.status || event.stage || "loading",
      model,
      file: event.file || event.name || "",
      progress: Number.isFinite(progress) ? progress : null,
      loaded: Number.isFinite(loaded) ? loaded : 0,
      total: Number.isFinite(total) ? total : 0
    });
  }

  async function getPipeline(task, kind, multilingual, callback) {
    const name = modelName(kind, multilingual);
    const key = `pipeline:${task}:${name}:${DTYPE}`;
    if (!objectCache.has(key)) {
      const mod = await runtime(callback);
      const pending = mod.pipeline(task, name, {
        dtype: DTYPE,
        progress_callback: event => report(callback, name, event)
      }).catch(error => {
        objectCache.delete(key);
        throw new Error(`Could not load ${name}: ${error?.message || error}`);
      });
      objectCache.set(key, pending);
    }
    return objectCache.get(key);
  }

  async function getPairModel(multilingual, callback) {
    const name = modelName("reranking", multilingual);
    const key = `pair:${name}:${DTYPE}`;
    if (!objectCache.has(key)) {
      const mod = await runtime(callback);
      const pending = Promise.all([
        mod.AutoTokenizer.from_pretrained(name, {
          progress_callback: event => report(callback, name, event)
        }),
        mod.AutoModelForSequenceClassification.from_pretrained(name, {
          dtype: DTYPE,
          progress_callback: event => report(callback, name, event)
        })
      ]).then(([tokenizer, model]) => ({ tokenizer, model, name })).catch(error => {
        objectCache.delete(key);
        throw new Error(`Could not load ${name}: ${error?.message || error}`);
      });
      objectCache.set(key, pending);
    }
    return objectCache.get(key);
  }

  async function embeddings(texts, multilingual, callback) {
    if (!texts.length) return [];
    const extractor = await getPipeline("feature-extraction", "embeddings", multilingual, callback);
    const vectors = [];
    const batchSize = multilingual ? 10 : 24;

    for (let start = 0; start < texts.length; start += batchSize) {
      let batch = texts.slice(start, start + batchSize);
      // E5 was trained with task prefixes. The same prefix is used on every
      // sentence because this plugin performs symmetric, same-language
      // similarity rather than cross-language retrieval.
      if (multilingual) batch = batch.map(text => `passage: ${text}`);
      const output = await extractor(batch, {
        pooling: "mean",
        normalize: true
      });
      const rows = output.tolist();
      if (batch.length === 1 && typeof rows[0] === "number") vectors.push(rows);
      else vectors.push(...rows);
      callback?.({
        stage: "inference",
        model: modelName("embeddings", multilingual),
        progress: 100 * Math.min(1, (start + batch.length) / texts.length)
      });
      await Zotero.Promise.delay(0);
    }
    return vectors;
  }

  const ROLE_LABELS = [
    "main contribution",
    "research objective",
    "method",
    "dataset or experimental setup",
    "empirical result",
    "limitation",
    "conclusion",
    "future work",
    "background context"
  ];
  const ROLE_MAP = Object.freeze({
    "main contribution": "contribution",
    "research objective": "objective",
    "method": "method",
    "dataset or experimental setup": "dataset",
    "empirical result": "result",
    "limitation": "limitation",
    "conclusion": "conclusion",
    "future work": "future",
    "background context": "context"
  });

  async function classify(texts, multilingual, callback, batchSize = 8) {
    if (!texts.length) return [];
    const classifier = await getPipeline(
      "zero-shot-classification",
      "classification",
      multilingual,
      callback
    );
    const results = [];
    const size = Math.max(1, Math.min(32, Math.floor(Number(batchSize) || 8)));
    for (let start = 0; start < texts.length; start += size) {
      const batch = texts.slice(start, start + size);
      const output = await classifier(batch, ROLE_LABELS, {
        multi_label: false,
        hypothesis_template: "This sentence is about {}."
      });
      const predictions = Array.isArray(output) ? output : [output];
      for (let i = 0; i < batch.length; i++) {
        const prediction = predictions[i] || {};
        const label = prediction.labels?.[0] || "background context";
        results.push({
          role: ROLE_MAP[label] || "context",
          score: Number(prediction.scores?.[0]) || 0
        });
      }
      callback?.({
        stage: "inference",
        model: modelName("classification", multilingual),
        progress: 100 * Math.min(1, (start + batch.length) / texts.length)
      });
      await Zotero.Promise.delay(0);
    }
    return results;
  }

  async function rerank(query, texts, multilingual, callback) {
    if (!texts.length) return [];
    const { tokenizer, model, name } = await getPairModel(multilingual, callback);
    const scores = [];
    const batchSize = multilingual ? 6 : 12;
    for (let start = 0; start < texts.length; start += batchSize) {
      const batch = texts.slice(start, start + batchSize);
      const features = await tokenizer(
        new Array(batch.length).fill(query),
        { text_pair: batch, padding: true, truncation: true }
      );
      const output = await model(features);
      const logits = output?.logits || output;
      const data = Array.from(logits?.data || logits || []);
      if (data.length === batch.length) {
        scores.push(...data);
      }
      else {
        const width = Math.max(1, Math.floor(data.length / batch.length));
        for (let i = 0; i < batch.length; i++) {
          scores.push(data[i * width + width - 1] ?? 0);
        }
      }
      callback?.({
        stage: "inference",
        model: name,
        progress: 100 * Math.min(1, (start + batch.length) / texts.length)
      });
      await Zotero.Promise.delay(0);
    }
    return scores;
  }

  function selectedModelNames(settings) {
    const names = [];
    if (settings.llmEmbeddings) names.push(modelName("embeddings", settings.multilingual));
    if (settings.llmClassification) names.push(modelName("classification", settings.multilingual));
    if (settings.llmRerankings) names.push(modelName("reranking", settings.multilingual));
    return [...new Set(names)];
  }

  function wantedModelFiles(siblings) {
    const names = siblings.map(item => item.rfilename || item.path || "").filter(Boolean);
    const rootFiles = new Set([
      "config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json",
      "added_tokens.json", "vocab.txt", "vocab.json", "merges.txt", "modules.json",
      "sentence_bert_config.json", "sentencepiece.bpe.model", "tokenizer.model"
    ]);
    const selected = names.filter(name => rootFiles.has(name));
    const q8 = names.filter(name => /^onnx\/.+_q8\.onnx$/i.test(name));
    const legacyQ8 = names.filter(name => /^onnx\/model_quantized\.onnx$/i.test(name));
    const onnx = q8.length ? q8 : legacyQ8;
    if (!onnx.length) {
      throw new Error("No quantized q8 ONNX model was found in the selected Hugging Face repository.");
    }
    selected.push(...onnx);
    return [...new Set(selected)];
  }

  async function fetchModelManifest(name) {
    const url = `https://huggingface.co/api/models/${name}`;
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`Could not read model manifest for ${name} (${response.status}).`);
    return response.json();
  }

  async function downloadModelFiles(name, callback) {
    const manifest = await fetchModelManifest(name);
    const siblings = Array.isArray(manifest.siblings) ? manifest.siblings : [];
    const files = wantedModelFiles(siblings);
    const baseDir = PathUtils.join(cacheDir, "models", ...name.split("/"));
    let completed = 0;
    for (const file of files) {
      const destination = PathUtils.join(baseDir, ...file.split("/"));
      const source = `https://huggingface.co/${name}/resolve/main/${file}`;
      callback?.({ operation: "model-download", stage: "initiate", model: name, file, progress: 100 * completed / files.length });
      if (!await IOUtils.exists(destination)) {
        await downloadToFile(source, destination, event => {
          callback?.({ ...event, operation: "model-download", model: name, file });
        }, name);
      }
      completed++;
      callback?.({ operation: "model-download", stage: "file-complete", model: name, file, progress: 100 * completed / files.length });
    }
    const metadata = {
      model: name,
      dtype: DTYPE,
      revision: manifest.sha || "main",
      downloadedAt: new Date().toISOString(),
      files
    };
    await IOUtils.writeJSON(PathUtils.join(baseDir, "download-manifest.json"), metadata);
  }

  async function updateModels(settings, callback, forceRuntime = false) {
    const names = selectedModelNames(settings);
    if (!names.length) throw new Error("Select at least one LLM stage before updating models.");
    await ensureRuntimeDownloaded(callback, !!forceRuntime);
    await ensureWasmDownloaded(callback, !!forceRuntime);
    for (let i = 0; i < names.length; i++) {
      await downloadModelFiles(names[i], event => callback?.({ ...event, modelIndex: i, modelCount: names.length }));
    }
    callback?.({
      operation: "all",
      stage: "complete",
      model: "Selected models",
      progress: 100,
      inferenceAvailable: IN_PROCESS_INFERENCE_ENABLED
    });
    return true;
  }

  function supportsInference() {
    return IN_PROCESS_INFERENCE_ENABLED;
  }

  function shutdown() {
    for (const value of objectCache.values()) {
      Promise.resolve(value).then(object => object?.dispose?.()).catch(() => {});
    }
    objectCache.clear();
    if (wasmBlobURL && hostFrame?.contentWindow) {
      try { hostFrame.contentWindow.URL.revokeObjectURL(wasmBlobURL); } catch (_) {}
    }
    wasmBlobURL = null;
    hostFrame?.remove();
    hostFrame = null;
    hostPromise = null;
    runtimePromise = null;
  }

  return {
    MODELS,
    TRANSFORMERS_VERSION,
    DTYPE,
    init,
    shutdown,
    embeddings,
    classify,
    rerank,
    updateModels,
    ensureRuntimeDownloaded,
    modelName,
    supportsInference,
    log
  };
})();
