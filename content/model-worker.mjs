let Transformers = null;
let wasmBlobURL = null;
const pipelines = new Map();
const cacheRequests = new Map();
let nextCacheRequest = 1;

function errorDetail(error) {
  return error?.stack || error?.message || String(error);
}

function progress(requestId, model, event) {
  self.postMessage({
    type: "progress",
    requestId,
    model,
    stage: event?.status || event?.stage || "loading",
    file: event?.file || event?.name || "",
    progress: Number.isFinite(Number(event?.progress)) ? Number(event.progress) : null,
    loaded: Number(event?.loaded) || 0,
    total: Number(event?.total) || 0
  });
}

function modelCache() {
  return {
    async match(request) {
      const id = nextCacheRequest++;
      const result = new Promise((resolve, reject) => cacheRequests.set(id, { resolve, reject }));
      self.postMessage({ type: "cache-read", id, url: typeof request === "string" ? request : request.url });
      const cached = await result;
      if (!cached) throw new Error(`Missing cached model asset: ${typeof request === "string" ? request : request.url}. Download/update the model first.`);
      return new Response(cached.bytes, {
        status: 200,
        headers: { "content-type": cached.contentType || "application/octet-stream" }
      });
    },
    async put() {}
  };
}

async function initialize(message) {
  const runtimeURL = URL.createObjectURL(new Blob([message.runtimeBytes], { type: "text/javascript" }));
  try {
    Transformers = await import(runtimeURL);
  }
  finally {
    URL.revokeObjectURL(runtimeURL);
  }
  const env = Transformers.env;
  // Transformers.js needs this enabled to construct canonical Hub cache keys.
  // `modelCache().match()` throws on every cache miss, so no network request is made.
  env.allowRemoteModels = true;
  env.allowLocalModels = false;
  env.useBrowserCache = false;
  env.useCustomCache = true;
  env.customCache = modelCache();
  if (env.backends?.onnx?.wasm) {
    wasmBlobURL = URL.createObjectURL(new Blob([message.wasmBytes], { type: "application/wasm" }));
    env.backends.onnx.wasm.wasmPaths = { wasm: wasmBlobURL };
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = false;
  }
}

async function pipeline(task, model, dtype, requestId) {
  const key = `${task}:${model}:${dtype}`;
  if (!pipelines.has(key)) {
    pipelines.set(key, Transformers.pipeline(task, model, {
      dtype,
      progress_callback: event => progress(requestId, model, event)
    }));
  }
  return pipelines.get(key);
}

async function infer(message) {
  const { requestId, operation, model, dtype } = message;
  if (operation === "generate") {
    const generator = await pipeline("text-generation", model, dtype, requestId);
    return generator(message.prompt, {
      max_new_tokens: message.maxNewTokens,
      do_sample: false,
      return_full_text: false
    });
  }
  if (operation === "embeddings") {
    const extractor = await pipeline("feature-extraction", model, dtype, requestId);
    const vectors = [];
    const batchSize = message.multilingual ? 10 : 24;
    for (let start = 0; start < message.texts.length; start += batchSize) {
      let batch = message.texts.slice(start, start + batchSize);
      if (message.multilingual) batch = batch.map(text => `passage: ${text}`);
      const output = await extractor(batch, { pooling: "mean", normalize: true });
      const rows = output.tolist();
      if (batch.length === 1 && typeof rows[0] === "number") vectors.push(rows);
      else vectors.push(...rows);
      progress(requestId, model, { stage: "inference", progress: 100 * Math.min(1, (start + batch.length) / message.texts.length) });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return vectors;
  }
  if (operation === "classification") {
    const classifier = await pipeline("zero-shot-classification", model, dtype, requestId);
    const results = [];
    const size = Math.max(1, Math.min(32, Math.floor(Number(message.batchSize) || 8)));
    for (let start = 0; start < message.texts.length; start += size) {
      const batch = message.texts.slice(start, start + size);
      const output = await classifier(batch, message.labels, {
        multi_label: false,
        hypothesis_template: "This sentence is about {}."
      });
      results.push(...(Array.isArray(output) ? output : [output]));
      progress(requestId, model, { stage: "inference", progress: 100 * Math.min(1, (start + batch.length) / message.texts.length) });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return results;
  }
  throw new Error(`Unknown worker operation: ${operation}`);
}

self.onmessage = async event => {
  const message = event.data || {};
  if (message.type === "cache-result") {
    const pending = cacheRequests.get(message.id);
    if (!pending) return;
    cacheRequests.delete(message.id);
    pending.resolve(message.cached || null);
    return;
  }
  if (message.type === "init") {
    try {
      await initialize(message);
      self.postMessage({ type: "ready" });
    }
    catch (error) {
      self.postMessage({ type: "init-error", error: errorDetail(error) });
    }
    return;
  }
  if (message.type === "infer") {
    try {
      const result = await infer(message);
      self.postMessage({ type: "result", requestId: message.requestId, result });
    }
    catch (error) {
      self.postMessage({ type: "error", requestId: message.requestId, error: errorDetail(error) });
    }
  }
};
