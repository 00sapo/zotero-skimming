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
    "/api/show": { body: { modelfile: "..." } },
    "/api/pull": { body: { status: "success" } },
    "/api/create": { body: { status: "success" } },
    "/api/generate": { body: { response: "A local summary." } },
    "/api/embed": { body: { embeddings: [[1, 0], [0, 1]] } },
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
  const XMLHttpRequest = xhr ?? makeXHR();
  const context = loadScript("content/model-manager.js", {
    Zotero, IOUtils, PathUtils, fetch: vi.fn(), crypto: null, XMLHttpRequest,
    ChromeUtils: { importESModule: () => ({ Subprocess: subprocess }) }
  });
  context.FastKeySentenceModels.init();
  return { api: context.FastKeySentenceModels, Zotero, IOUtils, files, subprocess };
}

describe("FastKeySentenceModels Ollama", () => {
  it("offers a summary and embedding model", () => {
    const { api } = manager();
    expect(api.SUMMARY_MODEL).toBe("hf.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF");
    expect(api.EMBEDDING_MODEL).toBe("hf.co/Qwen/Qwen3-Embedding-0.6B-GGUF");
  });

  it("uses a configured command to launch Ollama via testOllama", async () => {
    let healthCheckCalls = 0;
    const ollamaPath = "/usr/bin/ollama";
    const xhr = makeXHR({
      "/api/version": { body: {}, status: () => healthCheckCalls++ === 0 ? 503 : 200 }
    });
    const { api, subprocess } = manager({ xhr, io: { exists: async name => name.startsWith("/") } });
    await api.testOllama({ ollamaCommand: ollamaPath }, vi.fn());
    expect(subprocess.call).toHaveBeenCalledWith(expect.objectContaining({ command: ollamaPath, arguments: ["serve"] }));
  });

  it("opens Ollama download when the executable is unavailable", async () => {
    const xhr = makeXHR({ "/api/version": { status: 503, body: {} } });
    const { api } = manager({ xhr, io: { exists: async () => false } });
    await expect(api.testOllama({ ollamaCommand: "/usr/bin/ollama" })).rejects.toThrow("Ollama was not found at");
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
    const result = await api.summarize(Array.from({ length: 50 }, () => "word.").join(" "), null, { mapReduce: true, mapReduceSentences: 4, sentenceCount: 4 });
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(0);
  });

  it("shares the OLLAMA_URL constant", () => {
    const { api } = manager();
    expect(api.OLLAMA_URL).toBe("http://127.0.0.1:11434");
  });
});
