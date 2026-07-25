import { describe, expect, it, vi } from "vitest";
import { loadScript } from "./helpers.js";

function bootstrap({ windows = [] } = {}) {
  const models = { init: vi.fn(), shutdown: vi.fn() };
  const annotator = { init: vi.fn(), addToWindow: vi.fn(), removeFromWindow: vi.fn() };
  const Zotero = { debug: vi.fn(), getMainWindows: vi.fn(() => windows), Prefs: { get: vi.fn(() => "") } };
  const defaults = { setIntPref: vi.fn(), setBoolPref: vi.fn(), setStringPref: vi.fn() };
  const Services = { scriptloader: { loadSubScript: vi.fn() }, prefs: { getDefaultBranch: vi.fn(() => defaults) } };
  const configFileContent = "# dummy TOML\n[test]\ndescription = \"T\"\nprototypes = [\"P\"]\ncontext-prototypes = [\"C\"]";
  const PathUtils = { join: vi.fn(() => "/profile/zotero-skimming/zero-shot-config.toml"), parent: vi.fn(() => "/profile/zotero-skimming"), profileDir: "/profile" };
  const IOUtils = {
    makeDirectory: vi.fn(async () => {}),
    exists: vi.fn(async () => true),
    read: vi.fn(async () => new TextEncoder().encode(configFileContent)),
    writeUTF8: vi.fn(async () => {})
  };
  const context = loadScript("bootstrap.js", {
    Zotero,
    Services,
    PathUtils,
    IOUtils,
    TextEncoder,
    TextDecoder,
    FastKeySentenceZeroShot: { DEFAULT_CONFIG: configFileContent },
    FastKeySentenceNLP: {},
    FastKeySentenceModels: models,
    FastOfflineKeySentenceAnnotator: annotator,
    fetch: vi.fn(async () => ({ ok: true, json: async () => ({}) }))
  });
  return { context, models, annotator, Zotero, Services };
}

describe("bootstrap", () => {
  it("loads scripts, initializes modules, and registers existing Zotero windows", async () => {
    const validWindow = { ZoteroPane: {} };
    const { context, models, annotator, Services } = bootstrap({ windows: [validWindow, {}, null] });

    await context.startup({ id: "addon@example.com", version: "1.2.3", rootURI: "resource://addon/" });

    expect(Services.scriptloader.loadSubScript.mock.calls.map(([url]) => url)).toEqual([
      "resource://addon/content/zero-shot-classifier.js",
      "resource://addon/content/nlp.js",
      "resource://addon/content/model-manager.js",
      "resource://addon/content/remote-llm.js",
      "resource://addon/content/annotator.js"
    ]);
    expect(models.init).toHaveBeenCalledWith("resource://addon/");
    expect(annotator.init).toHaveBeenCalledWith({ id: "addon@example.com", version: "1.2.3", rootURI: "resource://addon/" });
    expect(annotator.addToWindow).toHaveBeenCalledTimes(1);
    expect(annotator.addToWindow).toHaveBeenCalledWith(validWindow);
  });

  it("handles window hooks and shuts down models and registered windows", () => {
    const windows = [{ ZoteroPane: {} }, {}];
    const { context, models, annotator } = bootstrap({ windows });

    context.onMainWindowLoad({ window: windows[0] });
    context.onMainWindowUnload({ window: windows[0] });
    context.onMainWindowLoad({ window: undefined });
    context.onMainWindowUnload({ window: undefined });
    context.shutdown();

    expect(annotator.addToWindow).toHaveBeenCalledWith(windows[0]);
    expect(annotator.removeFromWindow).toHaveBeenCalledWith(windows[0]);
    expect(annotator.removeFromWindow).toHaveBeenCalledWith(windows[1]);
    expect(models.shutdown).toHaveBeenCalledOnce();
    expect(context.FastOfflineKeySentenceAnnotator).toBeUndefined();
  });

  it("shuts down safely when modules are absent", () => {
    const context = loadScript("bootstrap.js", {
      Zotero: { debug: vi.fn(), getMainWindows: vi.fn() },
      PathUtils: { join: vi.fn(() => "/x"), parent: vi.fn(() => "/x"), profileDir: "/x" },
      IOUtils: { makeDirectory: vi.fn(async () => {}), exists: vi.fn(async () => true), read: vi.fn(async () => new TextEncoder().encode("[t]\ndescription=\"T\"\nprototypes=[\"P\"]")), writeUTF8: vi.fn(async () => {}) },
      TextEncoder,
      TextDecoder,
      Services: { scriptloader: { loadSubScript: vi.fn() }, prefs: { getDefaultBranch: vi.fn(() => ({ setIntPref: vi.fn(), setBoolPref: vi.fn(), setStringPref: vi.fn() })) } }
    });
    expect(() => context.shutdown()).not.toThrow();
  });

  it("logs installation lifecycle events", () => {
    const { context, Zotero } = bootstrap();

    context.install();
    context.uninstall();

    expect(Zotero.debug).toHaveBeenNthCalledWith(1, "Zotero Skimming: Installed");
    expect(Zotero.debug).toHaveBeenNthCalledWith(2, "Zotero Skimming: Uninstalled");
  });
});
