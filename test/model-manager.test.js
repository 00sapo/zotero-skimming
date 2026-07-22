import { describe, expect, it, vi } from "vitest";
import { loadScript } from "./helpers.js";

const ROOT = "/profile/fast-key-sentence-annotator";
const RUNTIME = `${ROOT}/runtime/transformers-3.8.1.min.mjs`;
const WASM = `${ROOT}/runtime/ort-wasm-simd-threaded.jsep.wasm`;

function bytes(value = "asset") {
  return new TextEncoder().encode(value);
}

function response(value = "asset", { ok = true, status = 200, stream = false, length = true } = {}) {
  const data = bytes(value);
  return {
    ok,
    status,
    headers: { get: name => name === "content-length" && length ? String(data.length) : null },
    body: stream ? {
      getReader: () => {
        let read = 0;
        return { read: async () => read++ ? { done: true } : { value: data, done: false } };
      }
    } : null,
    arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    json: async () => value
  };
}

function hostModule(overrides = {}) {
  return {
    env: { backends: { onnx: { wasm: {} } } },
    pipeline: vi.fn(async task => task === "feature-extraction"
      ? async input => ({ tolist: () => input.length === 1 ? [1, 2] : input.map((_, i) => [i, i + 1]) })
      : async () => ({ labels: ["empirical result"], scores: [0.8] })),
    AutoTokenizer: { from_pretrained: vi.fn(async () => async (queries, options) => ({ queries, options })) },
    AutoModelForSequenceClassification: { from_pretrained: vi.fn(async () => async () => ({ logits: { data: [0.1, 0.9] } })) },
    ...overrides
  };
}

function manager({ module = hostModule(), fetchImpl, owner = true, existingHost = true, files: initial = [RUNTIME, WASM] } = {}) {
  const files = new Map(initial.map(path => [path, bytes(path)]));
  const listeners = new Map();
  const frameWindow = {
    ...(existingHost ? { FastKeySentenceTransformers: module } : {}),
    URL: { createObjectURL: vi.fn(() => "blob:asset"), revokeObjectURL: vi.fn() }, Blob, Response,
    addEventListener: vi.fn((name, fn) => listeners.set(name, fn)),
    removeEventListener: vi.fn(name => listeners.delete(name))
  };
  const frame = { contentWindow: frameWindow, contentDocument: {}, id: "", setAttribute: vi.fn(), style: {}, remove: vi.fn() };
  const script = { addEventListener: vi.fn(), type: "", src: "" };
  const document = {
    getElementById: vi.fn(() => existingHost ? frame : null),
    createElementNS: vi.fn((ns, name) => name === "iframe" ? frame : script),
    documentElement: { appendChild: vi.fn() },
    head: { appendChild: vi.fn(() => { frameWindow.FastKeySentenceTransformers = module; listeners.get("fast-key-sentence-transformers-ready")?.(); }) }
  };
  frame.contentDocument = document;
  const Zotero = {
    debug: vi.fn(),
    Promise: { delay: vi.fn(async () => {}) },
    getMainWindow: vi.fn(() => owner ? { document, setTimeout: fn => fn() } : null)
  };
  const IOUtils = {
    exists: vi.fn(async path => files.has(path)), read: vi.fn(async path => files.get(path)),
    write: vi.fn(async (path, value) => files.set(path, value)),
    writeJSON: vi.fn(async (path, value) => files.set(path, value)),
    makeDirectory: vi.fn(async () => {}), remove: vi.fn(async path => files.delete(path)),
    move: vi.fn(async (from, to) => { files.set(to, files.get(from)); files.delete(from); })
  };
  const PathUtils = {
    profileDir: "/profile", join: (...parts) => parts.join("/"),
    parent: path => path.slice(0, path.lastIndexOf("/")), filename: path => path.slice(path.lastIndexOf("/") + 1)
  };
  const fetch = vi.fn(fetchImpl || (async () => response()));
  const context = loadScript("content/model-manager.js", { Zotero, IOUtils, PathUtils, Services: {}, fetch });
  context.FastKeySentenceModels.init({ rootURI: "resource://addon/" });
  return { api: context.FastKeySentenceModels, Zotero, IOUtils, files, fetch, module, frame, frameWindow, document };
}

const settings = { llmEmbeddings: true, llmClassification: true, llmRerankings: true, multilingual: false };

describe("FastKeySentenceModels", () => {
  it("exposes its pinned local-inference contract", () => {
    const { api, Zotero } = manager();
    expect(api.supportsInference()).toBe(true);
    expect(api.DTYPE).toBe("q8");
    expect(api.modelName("embeddings", false)).toBe("Xenova/all-MiniLM-L6-v2");
    expect(api.modelName("embeddings", true)).toBe("Xenova/multilingual-e5-small");
    api.log("ready");
    expect(Zotero.debug).toHaveBeenCalledWith(expect.stringContaining("ready"));
  });

  it("downloads runtime assets through stream and array-buffer responses", async () => {
    const events = [];
    const manifest = { siblings: [{ rfilename: "config.json" }, { rfilename: "onnx/model_q8.onnx" }] };
    const { api, files, fetch } = manager({ files: [], fetchImpl: async url => url.includes("/api/models/") ? response(manifest) : response(url.includes("wasm") ? "wasm" : "runtime", { stream: !url.includes("wasm") }) });
    await expect(api.ensureRuntimeDownloaded(events.push.bind(events))).resolves.toBe(RUNTIME);
    await expect(api.ensureRuntimeDownloaded(events.push.bind(events))).resolves.toBe(RUNTIME);
    await api.updateModels({ ...settings, llmEmbeddings: true, llmClassification: false, llmRerankings: false }, () => {});
    expect(files.has(RUNTIME)).toBe(true);
    expect(events.map(event => event.stage)).toContain("done");
    expect(fetch).toHaveBeenCalled();
  });

  it("reports download failures and empty assets", async () => {
    const failed = manager({ files: [], fetchImpl: async () => response("", { ok: false, status: 503 }) });
    await expect(failed.api.ensureRuntimeDownloaded()).rejects.toThrow("503");
    const empty = manager({ files: [], fetchImpl: async () => response("", { length: false }) });
    await expect(empty.api.ensureRuntimeDownloaded()).rejects.toThrow("empty file");
  });

  it("creates an isolated module host and resolves local model-cache URLs", async () => {
    const local = `${ROOT}/models/Xenova/all-MiniLM-L6-v2/config.json`;
    const { api, files, module, document } = manager({ existingHost: false, files: [RUNTIME, WASM, local] });
    files.set(local, bytes("{}"));
    await api.embeddings(["x"]);
    expect(document.createElementNS).toHaveBeenCalled();
    const cached = await module.env.customCache.match("https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/config.json");
    expect(await cached.text()).toBe("{}");
    expect(await module.env.customCache.match("https://example.test/nope")).toBeUndefined();
    await expect(module.env.customCache.put()).resolves.toBeUndefined();
  });

  it("runs embeddings in batches, prefixes multilingual E5 input, and reuses pipelines", async () => {
    const { api, module, Zotero } = manager();
    const progress = vi.fn();
    expect(await api.embeddings([])).toEqual([]);
    expect(await api.embeddings(["a", "b"], false, progress)).toEqual([[0, 1], [1, 2]]);
    expect(await api.embeddings(["a"], true)).toEqual([[1, 2]]);
    expect(await api.embeddings(Array.from({ length: 25 }, (_, i) => String(i)), false)).toHaveLength(25);
    const multilingualCall = module.pipeline.mock.results[1].value;
    expect(module.pipeline).toHaveBeenCalledTimes(2);
    expect(Zotero.Promise.delay).toHaveBeenCalled();
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ progress: 100 }));
    await multilingualCall;
  });

  it("classifies sentence batches, defaults missing outputs, and reports inference", async () => {
    const classifier = vi.fn()
      .mockResolvedValueOnce([
        { labels: ["method"], scores: ["0.4"] },
        { labels: [], scores: [] }
      ])
      .mockResolvedValueOnce([{ labels: ["unknown"], scores: [0] }]);
    const { api, Zotero } = manager({ module: hostModule({ pipeline: vi.fn(async () => classifier) }) });
    expect(await api.classify([])).toEqual([]);
    expect(await api.classify(["a", "b", "c", "d", "e"], false, vi.fn(), 2)).toEqual([
      { role: "method", score: 0.4 }, { role: "context", score: 0 }, { role: "context", score: 0 }, { role: "context", score: 0 }, { role: "context", score: 0 }
    ]);
    expect(classifier.mock.calls.map(([batch]) => batch.length)).toEqual([2, 2, 1]);
    expect(Zotero.Promise.delay).toHaveBeenCalledTimes(3);
  });

  it("reranks direct and multi-logit batches and supports multilingual batching", async () => {
    const model = vi.fn()
      .mockResolvedValueOnce({ logits: { data: [0.2, 0.8] } })
      .mockResolvedValueOnce({ logits: { data: [0.1, 0.2, 0.3, 0.4] } });
    const { api, module } = manager({ module: hostModule({ AutoModelForSequenceClassification: { from_pretrained: vi.fn(async () => model) } }) });
    expect(await api.rerank("q", [])).toEqual([]);
    expect(await api.rerank("q", ["a", "b"])).toEqual([0.2, 0.8]);
    expect(await api.rerank("q", ["a", "b"], true)).toEqual([0.2, 0.4]);
    expect(module.AutoTokenizer.from_pretrained).toHaveBeenCalledTimes(2);
  });

  it("wraps pipeline and pair-model failures and permits retries", async () => {
    const badPipeline = hostModule({ pipeline: vi.fn().mockRejectedValueOnce(new Error("broken")).mockResolvedValue(async () => ({ tolist: () => [1] })) });
    const first = manager({ module: badPipeline });
    await expect(first.api.embeddings(["x"])).rejects.toThrow("Could not load");
    await expect(first.api.embeddings(["x"])).resolves.toEqual([[1]]);
    const badPair = manager({ module: hostModule({ AutoTokenizer: { from_pretrained: vi.fn().mockRejectedValue(new Error("bad tokenizer")) } }) });
    await expect(badPair.api.rerank("q", ["x"])).rejects.toThrow("Could not load");
  });

  it("reports pipeline and pair-model loading variants", async () => {
    const progress = vi.fn();
    const module = hostModule({
      pipeline: vi.fn(async (task, name, options) => {
        options.progress_callback({ status: "ready", file: "weights.onnx", progress: "50", loaded: "4", total: "8" });
        options.progress_callback({ stage: "", name: "fallback", progress: "bad", loaded: null, total: undefined });
        return task === "feature-extraction" ? async () => ({ tolist: () => [1, 2] }) : async () => ({ labels: ["method"], scores: [1] });
      }),
      AutoTokenizer: { from_pretrained: vi.fn(async (_name, options) => {
        options.progress_callback({});
        return async () => ({});
      }) },
      AutoModelForSequenceClassification: { from_pretrained: vi.fn(async (_name, options) => {
        options.progress_callback({ stage: "loading", progress: 25 });
        return async () => ({ logits: { data: [1] } });
      }) }
    });
    const { api } = manager({ module });
    await api.embeddings(["x"], false, progress);
    await api.classify(["x"], false, progress);
    await api.rerank("q", ["x"], false, progress);
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ stage: "ready", progress: 50, loaded: 4, total: 8 }));
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ stage: "loading", progress: null, loaded: 0, total: 0 }));
  });

  it("ignores model progress when no progress callback was requested", async () => {
    const module = hostModule({ pipeline: vi.fn(async (_task, _name, options) => {
      options.progress_callback({ progress: 1 });
      return async () => ({ tolist: () => [1] });
    }) });
    const { api } = manager({ module });
    await expect(api.embeddings(["x"])).resolves.toEqual([[1]]);
  });

  it("forces runtime downloads and accepts legacy model manifests with cached assets", async () => {
    const manifest = { siblings: [{ path: "config.json" }, { rfilename: "onnx/model_quantized.onnx" }] };
    const config = `${ROOT}/models/Xenova/all-MiniLM-L6-v2/config.json`;
    const model = `${ROOT}/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx`;
    const { api, fetch, files } = manager({
      files: [RUNTIME, WASM, config, model],
      fetchImpl: async url => url.includes("/api/models/") ? response(manifest) : response("fresh")
    });
    await api.ensureRuntimeDownloaded(undefined, true);
    await api.updateModels({ ...settings, llmClassification: false, llmRerankings: false }, undefined, true);
    expect(files.has(model)).toBe(true);
    expect(fetch.mock.calls.filter(([url]) => url.includes("model_quantized.onnx"))).toHaveLength(0);
  });

  it("uses request objects, cache miss paths, and runtimes without ONNX WASM", async () => {
    const onnx = `${ROOT}/models/Xenova/all-MiniLM-L6-v2/onnx/model_q8.onnx`;
    const module = hostModule({ env: { backends: {} } });
    const { api, files, module: loaded } = manager({ module, files: [RUNTIME, WASM, onnx] });
    files.set(onnx, bytes("onnx"));
    await api.embeddings(["x"]);
    const cache = loaded.env.customCache;
    expect(await cache.match({ url: "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_q8.onnx" })).toBeInstanceOf(Response);
    expect(await cache.match({ url: "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main" })).toBeUndefined();
    expect(await cache.match({ url: "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/missing.json" })).toBeUndefined();
    expect(await cache.match({})).toBeUndefined();
  });

  it("initializes without options and reports chunked downloads with unknown size", async () => {
    let reads = 0;
    const { api } = manager({
      files: [],
      fetchImpl: async () => ({
        ok: true, status: 200, headers: { get: () => null },
        body: { getReader: () => ({ read: async () => ++reads === 1 ? { value: new Uint8Array(), done: false } : reads === 2 ? { value: bytes("x"), done: false } : { done: true } }) }
      })
    });
    const events = [];
    api.init();
    await api.ensureRuntimeDownloaded(events.push.bind(events), true);
    expect(events).toContainEqual(expect.objectContaining({ total: 0, progress: null }));
  });

  it("updates individual model stages and shuts down before host creation", async () => {
    const manifest = { siblings: [{ rfilename: "config.json" }, { rfilename: "onnx/model_q8.onnx" }] };
    const cached = [RUNTIME, WASM, `${ROOT}/models/Xenova/all-MiniLM-L6-v2/config.json`, `${ROOT}/models/Xenova/all-MiniLM-L6-v2/onnx/model_q8.onnx`, `${ROOT}/models/Xenova/distilbert-base-uncased-mnli/config.json`, `${ROOT}/models/Xenova/distilbert-base-uncased-mnli/onnx/model_q8.onnx`, `${ROOT}/models/Xenova/ms-marco-MiniLM-L-6-v2/config.json`, `${ROOT}/models/Xenova/ms-marco-MiniLM-L-6-v2/onnx/model_q8.onnx`];
    const { api } = manager({ files: cached, fetchImpl: async () => response(manifest) });
    await api.updateModels({ ...settings, llmClassification: false, llmRerankings: false });
    await api.updateModels({ ...settings, llmEmbeddings: false, llmRerankings: false });
    await api.updateModels({ ...settings, llmEmbeddings: false, llmClassification: false });
    expect(api.shutdown()).toBeUndefined();
  });

  it("downloads selected q8 model files, skips cached files, and emits aggregate progress", async () => {
    const manifest = { sha: "abc", siblings: [
      { rfilename: "config.json" }, { rfilename: "tokenizer.json" }, { rfilename: "onnx/model_q8.onnx" }, { rfilename: "ignored.bin" }
    ] };
    const events = [];
    const { api, IOUtils, files } = manager({ files: [], fetchImpl: async url => url.includes("/api/models/") ? response(manifest) : response("model") });
    await expect(api.updateModels({ ...settings, llmClassification: false, llmRerankings: false }, event => events.push(event), true)).resolves.toBe(true);
    expect(IOUtils.writeJSON).toHaveBeenCalledWith(expect.stringContaining("download-manifest.json"), expect.objectContaining({ dtype: "q8", revision: "abc" }));
    expect([...files.keys()].some(path => path.endsWith("model_q8.onnx"))).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ operation: "all", stage: "complete" }));
  });

  it("rejects invalid model selections and manifests", async () => {
    const none = manager();
    await expect(none.api.updateModels({ ...settings, llmEmbeddings: false, llmClassification: false, llmRerankings: false })).rejects.toThrow("Select at least");
    const missing = manager({ fetchImpl: async () => response({ siblings: [{ rfilename: "config.json" }] }) });
    await expect(missing.api.updateModels({ ...settings, llmClassification: false, llmRerankings: false })).rejects.toThrow("quantized q8");
    const manifestError = manager({ fetchImpl: async () => response("", { ok: false, status: 404 }) });
    await expect(manifestError.api.updateModels({ ...settings, llmClassification: false, llmRerankings: false })).rejects.toThrow("manifest");
  });

  it("fails inference cleanly when host creation or runtime prerequisites fail", async () => {
    const unavailable = manager({ owner: false });
    await expect(unavailable.api.embeddings(["x"])).rejects.toThrow("No Zotero main window");
    const missingWasm = manager({ files: [RUNTIME] });
    await expect(missingWasm.api.embeddings(["x"])).rejects.toThrow("WASM is missing");
  });

  it("releases cached models and host resources on shutdown", async () => {
    const dispose = vi.fn();
    const { api, module, frame, frameWindow } = manager();
    const extractor = async () => ({ tolist: () => [1] });
    extractor.dispose = dispose;
    module.pipeline.mockResolvedValue(extractor);
    await api.embeddings(["x"]);
    api.shutdown();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(frame.remove).toHaveBeenCalled();
    expect(frameWindow.URL.revokeObjectURL).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalled();
    expect(api.shutdown()).toBeUndefined();
  });
});
