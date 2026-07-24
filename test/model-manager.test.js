import { describe, expect, it, vi } from "vitest";
import { loadScript } from "./helpers.js";

const ROOT = "/profile/fast-key-sentence-annotator/ollama";
const summaryRepo = "Qwen/Qwen2.5-0.5B-Instruct-GGUF";
const embeddingRepo = "Qwen/Qwen3-Embedding-0.6B-GGUF";

function bytes(value = "asset") {
  return new TextEncoder().encode(value);
}

function response(value = {}, { ok = true, status = 200 } = {}) {
  const data = bytes(typeof value === "string" ? value : JSON.stringify(value));
  return {
    ok,
    status,
    headers: { get: name => name === "content-length" ? String(data.length) : null },
    body: null,
    arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    text: async () => typeof value === "string" ? value : JSON.stringify(value),
    json: async () => value
  };
}

function manager({ fetchImpl, path = "/usr/bin/ollama" } = {}) {
  const files = new Map();
  const subprocess = { pathSearch: vi.fn(async () => path), call: vi.fn(async () => ({ kill: vi.fn() })) };
  const Zotero = {
    debug: vi.fn(),
    launchURL: vi.fn(),
    Promise: { delay: vi.fn(async () => {}) }
  };
  const IOUtils = {
    exists: vi.fn(async name => files.has(name)),
    read: vi.fn(async name => files.get(name)),
    write: vi.fn(async (name, value) => files.set(name, value)),
    writeJSON: vi.fn(async (name, value) => files.set(name, value)),
    makeDirectory: vi.fn(async () => {}),
    remove: vi.fn(async name => files.delete(name)),
    move: vi.fn(async (from, to) => { files.set(to, files.get(from)); files.delete(from); })
  };
  const PathUtils = {
    profileDir: "/profile",
    join: (...parts) => parts.join("/"),
    parent: name => name.slice(0, name.lastIndexOf("/")),
    filename: name => name.slice(name.lastIndexOf("/") + 1)
  };
  const fetch = vi.fn(fetchImpl || (async url => {
    if (url.endsWith("/api/version")) return response({ version: "test" });
    if (url.includes(summaryRepo) && url.includes("/api/models/")) return response({ sha: "summary-revision", siblings: [{ rfilename: "qwen2.5-0.5b-instruct-q4_k_m.gguf" }] });
    if (url.includes(embeddingRepo) && url.includes("/api/models/")) return response({ sha: "embedding-revision", siblings: [{ rfilename: "qwen3-embedding-0.6b-q8_0.gguf" }] });
    if (url.endsWith("/api/create")) return response({ status: "success" });
    if (url.endsWith("/api/generate")) return response({ response: "A local summary." });
    if (url.endsWith("/api/embed")) return response({ embeddings: [[1, 0], [0, 1]] });
    return response("gguf");
  }));
  const context = loadScript("content/model-manager.js", {
    Zotero, IOUtils, PathUtils, fetch, crypto,
    ChromeUtils: { importESModule: () => ({ Subprocess: subprocess }) }
  });
  context.FastKeySentenceModels.init();
  return { api: context.FastKeySentenceModels, Zotero, IOUtils, files, fetch, subprocess };
}

describe("FastKeySentenceModels Ollama", () => {
  it("downloads and imports the two required GGUF models", async () => {
    const { api, files, fetch } = manager();
    await expect(api.updateModels({ mapReduceInputTokens: 4096 })).resolves.toBe(true);
    expect([...files.keys()]).toContain(`${ROOT}/models/zotero-skimming-summary/qwen2.5-0.5b-instruct-q4_k_m.gguf`);
    expect([...files.keys()]).toContain(`${ROOT}/models/zotero-skimming-embedding/qwen3-embedding-0.6b-q8_0.gguf`);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/create"), expect.any(Object));
  });

  it("uses a configured command to launch Ollama", async () => {
    let healthChecks = 0;
    const { api, subprocess, fetch } = manager({ fetchImpl: async url => {
      if (url.endsWith("/api/version")) return healthChecks++ ? response({ version: "test" }) : response("offline", { ok: false, status: 503 });
      if (url.endsWith("/api/create")) return response({ status: "success" });
      if (url.includes("/api/models/")) return response({ sha: "revision", siblings: [{ rfilename: url.includes("Embedding") ? "qwen3-embedding-0.6b-q8_0.gguf" : "qwen2.5-0.5b-instruct-q4_k_m.gguf" }] });
      return response("gguf");
    } });
    await api.updateModels({ mapReduceInputTokens: 4096, ollamaCommand: "mise exec -- ollama" });
    expect(subprocess.pathSearch).toHaveBeenCalledWith("mise");
    expect(subprocess.call).toHaveBeenCalledWith(expect.objectContaining({ arguments: ["exec", "--", "ollama", "serve"] }));
    expect(fetch).toHaveBeenCalled();
  });

  it("opens Ollama download when the executable is unavailable", async () => {
    const { api, Zotero } = manager({
      path: null,
      fetchImpl: async url => url.endsWith("/api/version") ? response("offline", { ok: false, status: 503 }) : response({})
    });
    await expect(api.summarize("Paper text.")).rejects.toThrow("Ollama is not installed");
    expect(Zotero.launchURL).toHaveBeenCalledWith("https://ollama.com/download");
  });

  it("generates local summaries and embeds sentence batches through Ollama", async () => {
    const { api } = manager();
    await expect(api.summarize("Paper text.", null, { sentenceCount: 4 })).resolves.toBe("A local summary.");
    await expect(api.embeddings(["summary", "sentence"])).resolves.toEqual([[1, 0], [0, 1]]);
  });

  it("keeps five-percent overlap and running-summary prompts in map-reduce", async () => {
    let calls = 0;
    const { api, fetch } = manager({ fetchImpl: async url => {
      if (url.endsWith("/api/version")) return response({ version: "test" });
      if (url.endsWith("/api/generate")) return response({ response: `summary ${++calls}` });
      return response({});
    } });
    await api.summarize(Array.from({ length: 50 }, () => "word.").join(" "), null, { mapReduce: true, contextWindow: 256, sentenceCount: 4 });
    const bodies = fetch.mock.calls.filter(([url]) => url.endsWith("/api/generate")).map(([, options]) => JSON.parse(options.body));
    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies[1].prompt).toContain("Here is a summary of the first part of an article: summary 1");
  });
});
