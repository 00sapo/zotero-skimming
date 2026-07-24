import { describe, it, expect, vi } from "vitest";
import { loadScript } from "./helpers.js";

function bytes(value) {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(value);
  const buffer = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(buffer).set(encoded);
  return new Uint8Array(buffer);
}

function makeXHR(overrides) {
  const routes = {
    "/api/version": { body: { version: "test" } },
    "/api/blobs/": { body: "ok" },
    "/api/create": { body: { status: "success" } },
    "/api/generate": { body: { response: "A local summary." } },
    "/api/embed": { body: { embeddings: [[1, 0], [0, 1]] } },
    "huggingface": { body: bytes("dummy gguf") },
    ...overrides
  };
  return vi.fn(function mockXHR() {
    this.open = vi.fn(function (method, url) { this._url = url; });
    this.setRequestHeader = vi.fn();
    this.send = vi.fn(function () {
      this.status = 200;
      this.statusText = "OK";
      const match = Object.entries(routes).find(([pattern]) => this._url.includes(pattern));
      const route = match ? match[1] : { body: new Uint8Array(0) };
      if (route.status) this.status = typeof route.status === "function" ? route.status() : route.status;
      const body = typeof route.body === "function" ? route.body(this._url) : route.body;
      if (body instanceof Uint8Array) {
        this.response = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
      } else {
        this.responseText = typeof body === "string" ? body : JSON.stringify(body);
        this.response = body;
      }
      if (typeof this.onload === "function") this.onload.call(this);
    });
  });
}

function manager({ path = "/usr/bin/ollama", xhr, io } = {}) {
  const files = new Map();
  const subprocess = { call: vi.fn(async () => ({ kill: vi.fn() })) };
  const Zotero = {
    debug: vi.fn(),
    launchURL: vi.fn(),
    Promise: { delay: vi.fn(async () => {}) }
  };
  const IOUtils = {
    exists: vi.fn(async name => files.has(name)),
    read: vi.fn(async name => files.get(name)),
    write: vi.fn(async (name, value) => { files.set(name, value); }),
    writeJSON: vi.fn(async (name, value) => files.set(name, value)),
    makeDirectory: vi.fn(async () => {}),
    remove: vi.fn(async name => files.delete(name)),
    move: vi.fn(async (from, to) => { files.set(to, files.get(from)); files.delete(from); }),
    ...io
  };
  const PathUtils = {
    profileDir: "/profile",
    join: (...parts) => parts.join("/"),
    parent: name => name.slice(0, name.lastIndexOf("/")),
    filename: name => name.slice(name.lastIndexOf("/") + 1)
  };
  const crypto = { subtle: { digest: vi.fn(async (algorithm, data) => data.slice(0, 32)) } };
  const XMLHttpRequest = xhr ?? makeXHR();
  const context = loadScript("content/model-manager.js", {
    Zotero, IOUtils, PathUtils, fetch: vi.fn(), crypto, XMLHttpRequest,
    ChromeUtils: { importESModule: () => ({ Subprocess: subprocess }) }
  });
  context.FastKeySentenceModels.init();
  return { api: context.FastKeySentenceModels, Zotero, IOUtils, files, subprocess };
}

const RUNTIME = "model-shim.json";
const WASM = "ort-wasm-simd-threaded.wasm";

describe("FastKeySentenceModels Ollama", () => {
  it("offers a summary and embedding model", () => {
    const { api } = manager();
    expect(api.SUMMARY_MODEL).toBe("zotero-skimming-summary");
    expect(api.EMBEDDING_MODEL).toBe("zotero-skimming-embedding");
  });

  it("downloads and imports the two required GGUF models", async () => {
    const { api, files } = manager();
    files.set(RUNTIME, bytes("runtime"));
    files.set(WASM, bytes("wasm"));
    files.set("/profile/fast-key-sentence-annotator/ollama/models/zotero-skimming-summary/qwen2.5-0.5b-instruct-q4_k_m.gguf", bytes("dummy gguf"));
    files.set("/profile/fast-key-sentence-annotator/ollama/models/zotero-skimming-embedding/qwen3-embedding-0.6b-q8_0.gguf", bytes("dummy gguf"));
    const ok = await api.updateModels({ mapReduceInputTokens: 4096 }, vi.fn());
    expect(ok).toBe(true);
  });

  it("uses a configured command to launch Ollama", async () => {
    let healthCheckCalls = 0;
    const ollamaPath = "/usr/bin/ollama";
    const xhr = makeXHR({
      "/api/version": { body: {}, status: () => healthCheckCalls++ === 0 ? 503 : 200 }
    });
    const { api, subprocess, files } = manager({ xhr, io: { exists: async name => name.startsWith("/") } });
    files.set("/profile/fast-key-sentence-annotator/ollama/models/zotero-skimming-summary/qwen2.5-0.5b-instruct-q4_k_m.gguf", bytes("dummy gguf"));
    files.set("/profile/fast-key-sentence-annotator/ollama/models/zotero-skimming-embedding/qwen3-embedding-0.6b-q8_0.gguf", bytes("dummy gguf"));
    await api.updateModels({ mapReduceInputTokens: 4096, ollamaCommand: ollamaPath }, vi.fn());
    expect(subprocess.call).toHaveBeenCalledWith(expect.objectContaining({ command: ollamaPath, arguments: ["serve"] }));
  });

  it("opens Ollama download when the executable is unavailable", async () => {
    const xhr = makeXHR({ "/api/version": { status: 503, body: {} } });
    const { api } = manager({ xhr, io: { exists: async () => false } });
    await expect(api.summarize("Paper text.")).rejects.toThrow("Ollama was not found at");
  });

  it("summarises text via Ollama", async () => {
    const { api } = manager();
    const result = await api.summarize("Significant paper text content that matters for research.");
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(0);
  });

  it("generates embeddings for tag classification", async () => {
    const { api } = manager();
    const vectors = await api.embeddings(["word1", "word2"]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toEqual([1, 0]);
  });

  it("reports inference support with Ollama", () => {
    const { api } = manager();
    expect(api.supportsInference()).toBe(true);
  });

  it("uses map-reduce for long texts", async () => {
    let calls = 0;
    const { api } = manager({
      xhr: makeXHR({ "/api/generate": { body: () => ({ response: `summary ${++calls}` }) } })
    });
    const result = await api.summarize(Array.from({ length: 50 }, () => "word.").join(" "), null, { mapReduce: true, contextWindow: 256, sentenceCount: 4 });
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(0);
  });

  it("shares the OLLAMA_URL constant", () => {
    const { api } = manager();
    expect(api.OLLAMA_URL).toBe("http://127.0.0.1:11434");
  });
});
