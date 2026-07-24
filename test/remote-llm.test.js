import { describe, expect, it, vi } from "vitest";
import { loadScript } from "./helpers.js";

function remote(preferences = new Map(), fetch = vi.fn()) {
  return loadScript("content/remote-llm.js", {
    Zotero: {
      debug: vi.fn(),
      Prefs: { get: key => preferences.get(key), set: (key, value) => preferences.set(key, value) },
      Promise: { delay: vi.fn().mockResolvedValue() }
    },
    Services: { console: { logStringMessage: vi.fn() } },
    fetch
  }).FastKeySentenceRemote;
}

const prefix = "extensions.zotero-skimming.";

function response(text = "A compact summary.") {
  return { ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) };
}

describe("FastKeySentenceRemote", () => {
  it("counts conservatively and splits source text within the configured map input limit", () => {
    const api = remote();
    const chunks = api.splitByTokenLimit("Alpha result. Beta method. Gamma conclusion.", 5);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk => api.estimateTokens(chunk) <= 5)).toBe(true);
    expect(api.estimateTokens("longer-token, 42!")).toBeGreaterThan(3);
  });

  it("allows a 256-token map input window", () => {
    const api = remote(new Map([[prefix + "mapReduceInputTokens", 256]]));
    expect(api.getConfig().mapInputTokens).toBe(256);
  });

  it("uses the existing direct request when map-reduce is disabled", async () => {
    const fetch = vi.fn().mockResolvedValue(response());
    const api = remote(new Map([
      [prefix + "remoteApiKey", "key"],
      [prefix + "remoteEndpoint", "https://api.example.test/chat"],
      [prefix + "remoteModel", "test-model"]
    ]), fetch);

    await expect(api.summarize("Paper body.", "Title", 3)).resolves.toBe("A compact summary.");
    expect(fetch).toHaveBeenCalledOnce();
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.model).toBe("test-model");
    expect(body.messages[1].content).toContain("Title: Title");
  });

  it("maps and reduces long text without exceeding the reserved map input window", async () => {
    const fetch = vi.fn().mockResolvedValue(response());
    const api = remote(new Map([
      [prefix + "remoteApiKey", "key"],
      [prefix + "mapReduce", true],
      [prefix + "mapReduceInputTokens", 1024]
    ]), fetch);
    const progress = vi.fn();
    const paper = Array.from({ length: 1800 }, () => "word.").join(" ");

    await expect(api.summarize(paper, "Title", 3, progress)).resolves.toBe("A compact summary.");
    expect(fetch.mock.calls.length).toBeGreaterThan(2);
    for (const [, request] of fetch.mock.calls) {
      const body = JSON.parse(request.body);
      const userContent = body.messages[1].content;
      const text = userContent.split("\n\nWrite a summary")[0];
      expect(api.estimateTokens(text)).toBeLessThanOrEqual(1024 - api.MAP_PROMPT_TOKEN_RESERVE);
    }
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ stage: "mapping" }));
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ stage: "done" }));
  });
});
