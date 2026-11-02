import { describe, expect, it, vi } from "vitest";
import { loadScript } from "./helpers.js";

function actualDocument() {
  const elements = new Map();
  class Element {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.listeners = {};
      this.style = {};
      this.dataset = {};
      this.hidden = false;
      this.disabled = false;
      this.textContent = "";
      this.value = "";
      this._checked = false;
      this.attributes = new Map();
    }
    get checked() { return this._checked; }
    set checked(value) { this._checked = value; }
    set id(value) { this._id = value; elements.set(value, this); }
    get id() { return this._id; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); this[name] = String(value); }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    remove() { this.removed = true; if (this._id) elements.delete(this._id); }
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
    removeEventListener(type, listener) { this.listeners[type] = (this.listeners[type] || []).filter(x => x !== listener); }
    dispatch(type, event = {}) { for (const listener of this.listeners[type] || []) listener({ preventDefault: vi.fn(), stopPropagation: vi.fn(), target: this, ...event }); }
    focus() { this.focused = true; }
    querySelectorAll(selector) {
      const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
      return descendants(this).filter(element => element.tag === selector || element.className === selector.replace(/^\./, ""));
    }
  }
  const root = new Element("root");
  const doc = { documentElement: root };
  const create = tag => {
    const element = new Element(tag);
    element.ownerDocument = doc;
    return element;
  };
  Object.assign(doc, {
    createElementNS: (_ns, tag) => create(tag),
    createElement: tag => create(tag),
    createXULElement: tag => create(tag),
    getElementById: id => elements.get(id) || null
  });
  root.ownerDocument = doc;
  const window = {
    document: doc,
    ZoteroPane: { getSelectedItems: () => [] },
    setTimeout: fn => fn(),
    requestAnimationFrame: vi.fn(fn => fn()),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    elements
  };
  doc.defaultView = window;
  return window;
}

function annotator(globals = {}) {
  const prefs = new Map();
  const summaryLabels = {
    DEFAULT_CONFIG: "# config\n[result]\ndescription = \"result\"",
    parseConfig(text) {
      if (!text || !text.trim()) return [];
      const labels = [];
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^\[([a-z][a-z0-9-]*)\]$/i);
        if (match) labels.push({ name: `[${match[1]}]`, description: `${match[1]} description`, color: null });
      }
      return labels;
    }
  };
  const nlp = loadScript("content/nlp.js", { FastKeySentenceSummaryLabels: summaryLabels }).FastKeySentenceNLP;
  const models = {
    init: vi.fn(),
    shutdown: vi.fn(),
    summarize: async () => "A test summary.",
    embeddings: async () => [[1, 0], [0, 1]],
    testOllama: vi.fn(async () => true),
    supportsInference: () => true,
    setModelOverrides: vi.fn(),
    appendToLog: vi.fn(),
    SUMMARY_MODEL: "test-summary",
    EMBEDDING_MODEL: "test-embed"
  };
  const extractor = globals.FastKeySentenceExtractor || {
    cleanText: text => String(text || "").replace(/\s+/g, " ").trim(),
    extractDocument: vi.fn(async () => ({ sentences: [], pages: [], pageCount: 0 }))
  };
  const zotero = {
    debug: vi.fn(),
    DataObjectUtilities: { generateKey: () => "KEY" },
    Prefs: { get: key => prefs.get(key), set: (key, value) => prefs.set(key, value) },
    ItemPaneManager: { registerSection: vi.fn(() => 1), unregisterSection: vi.fn() },
    PreferencePanes: { register: vi.fn(async () => "zotero-skimming-prefs") },
    Items: { getAsync: async () => ({ getField: () => "Parent title" }) },
    Notifier: { Queue: class {}, commit: async () => {} },
    Annotations: { saveFromJSON: vi.fn(async () => ({})) },
    Reader: { _readers: [] },
    ...globals.Zotero
  };
  const api = loadScript("content/annotator.js", {
    FastKeySentenceNLP: globals.FastKeySentenceNLP || nlp,
    FastKeySentenceModels: globals.FastKeySentenceModels || models,
    FastKeySentenceExtractor: extractor,
    FastKeySentenceRemote: {
      DEFAULT_ENDPOINT: "https://api.example.com",
      DEFAULT_MODEL: "test-model",
      validateConfig: vi.fn(async ({ apiKey, model }) => apiKey && model
        ? { valid: true }
        : { valid: false, error: "Missing credentials" })
    },
    FastKeySentenceSummaryLabels: summaryLabels,
    FastKeySentenceSummaryLabelConfigV2: globals.FastKeySentenceSummaryLabelConfigV2 || "# config\n[result]\ndescription = \"result\"",
    FastKeySentenceSummaryLabelConfigV2Path: globals.FastKeySentenceSummaryLabelConfigV2Path || "/tmp/config.toml",
    IOUtils: globals.IOUtils || { writeUTF8: vi.fn(async () => {}) },
    ...globals,
    Zotero: zotero
  }).FastOfflineKeySentenceAnnotator;
  api.__prefs = prefs;
  api.__models = models;
  api.__extractor = extractor;
  api.__zotero = zotero;
  return api;
}

function attachment(overrides = {}) {
  return {
    id: 7,
    libraryID: 1,
    isAttachment: () => true,
    isPDFAttachment: () => true,
    getField: () => "Paper",
    getAnnotations: () => [],
    ...overrides
  };
}

describe("FastOfflineKeySentenceAnnotator settings", () => {
  it("reads, validates, and saves settings including the threshold", () => {
    const api = annotator();
    api.init({ id: "addon@example.com", version: "1.0", rootURI: "resource://addon/" });
    expect(api.getConfiguredSettings()).toEqual(api.settingsDefaults);
    api.__prefs.set("extensions.zotero-skimming.selectionThreshold", null);
    expect(api.getConfiguredSettings().selectionThreshold).toBe(0.75);
    expect(api.getSelectionThreshold()).toBe(0.75);

    const settings = { ...api.settingsDefaults, compressionRatio: 3, selectionThreshold: 0.25, localRelevance: true };
    expect(api.saveSettings(settings)).toBe(true);
    expect(api.getConfiguredSettings()).toMatchObject({ compressionRatio: 3, selectionThreshold: 0.25, localRelevance: true });
    expect(api.calculateAnnotationTarget(100, { compressionRatio: 2 })).toBe(50);
    expect(api.getSelectionThreshold()).toBe(0.25);
    expect(api.setSelectionThreshold(0.4)).toBe(0.4);

    expect(api.isValidSettings({ ...api.settingsDefaults, compressionRatio: 1 })).toBe(false);
    expect(api.isValidSettings({ ...api.settingsDefaults, selectionThreshold: 2 })).toBe(false);
    expect(api.isValidSettings({ ...api.settingsDefaults, localRelevance: 1 })).toBe(false);
    expect(api.isValidSettings({ ...api.settingsDefaults, ollamaCommand: "ollama" })).toBe(false);
  });

  it("registers the preferences pane once", async () => {
    const api = annotator();
    api.init({ id: "addon@example.com", version: "1.0", rootURI: "resource://addon/" });
    await expect(api.registerPrefsPane()).resolves.toBe("zotero-skimming-prefs");
    await api.registerPrefsPane();
    expect(api.__prefs).toBeDefined();
    expect(api.id).toBe("addon@example.com");
  });

  it("wires the preferences pane without dialogs", async () => {
    const api = annotator();
    api.init({ id: "addon@example.com", version: "1.0", rootURI: "resource://addon/" });
    const window = actualDocument();
    const doc = window.document;
    const root = doc.createElement("vbox");
    root.id = "zotero-skimming-prefs";
    const ids = {
      compressionRatio: "number",
      selectionThreshold: "number",
      localRelevance: "checkbox",
      summaryLabels: "checkbox",
      summaryLabelConfigV2: "textarea",
      summarySource: "select",
      remoteEndpoint: "text",
      remoteApiKey: "password",
      summaryModel: "text",
      embeddingModel: "text",
      ollamaCommand: "text",
      mapReduce: "checkbox",
      mapReduceSentences: "number",
      remoteOptions: "vbox",
      localOptions: "vbox",
      status: "span",
      progress: "progress",
      testOllama: "button"
    };
    for (const [name, tag] of Object.entries(ids)) {
      const element = doc.createElement(tag);
      element.id = `zotero-skimming-pref-${name}`;
      window.elements.set(element.id, element);
    }
    api.onPrefsLoad(window);
    const $ = name => doc.getElementById(`zotero-skimming-pref-${name}`);
    expect($("compressionRatio").value).toBe("10");
    expect($("selectionThreshold").value).toBe("75");
    expect($("summarySource").value).toBe("local");
    expect($("remoteOptions").hidden).toBe(true);

    $("compressionRatio").value = "4";
    $("summaryLabelConfigV2").value = "# config\n[result]\ndescription = \"result\"";
    $("compressionRatio").dispatch("change");
    expect(api.getConfiguredSettings().compressionRatio).toBe(4);
    expect($("status").textContent).toBe("Saved.");

    $("summaryLabelConfigV2").value = "";
    $("summaryLabelConfigV2").dispatch("input");
    expect($("status").textContent).toContain("invalid");
    $("summaryLabelConfigV2").value = "# config\n[result]\ndescription = \"result\"";
    $("summarySource").value = "remote";
    $("summarySource").dispatch("change");
    expect($("remoteOptions").hidden).toBe(false);

    $("testOllama").listeners.click[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(api.__models.testOllama).not.toHaveBeenCalled();
  });
});

describe("FastOfflineKeySentenceAnnotator sidebar", () => {
  it("renders temporary-highlight controls and no settings form", async () => {
    const api = annotator();
    api.init({ id: "addon@example.com", version: "1.0", rootURI: "resource://addon/" });
    const paneManager = { registerSection: vi.fn(() => 7), unregisterSection: vi.fn() };
    api.__zotero.ItemPaneManager = paneManager;
    const window = actualDocument();
    api.addToWindow(window);
    const section = paneManager.registerSection.mock.calls[0][0];
    const body = window.document.createElement("div");
    section.onRender({ body, item: null, tabType: "reader" });
    const text = body.children[0].children.flatMap(child => [child, ...child.children]).map(element => element.textContent);
    expect(text).toContain("Generate highlights");
    expect(text).toContain("Save as Zotero annotations…");
    expect(text).toContain("Highlight threshold");
    expect(text).not.toContain("Paper skim");
    const refs = api.panelRefs.get(body);
    expect(refs.embeddingsToggle.checked).toBe(false);
    expect(refs.taggingToggle.checked).toBe(false);
    refs.embeddingsToggle.checked = true;
    refs.embeddingsToggle.dispatch("change");
    refs.taggingToggle.checked = true;
    refs.taggingToggle.dispatch("change");
    expect(api.__prefs.get("extensions.zotero-skimming.localRelevance")).toBe(true);
    expect(api.__prefs.get("extensions.zotero-skimming.zeroShotLabels")).toBe(true);
    expect(api.getConfiguredSettings()).toMatchObject({ localRelevance: true, summaryLabels: true });
    await section.onAsyncRender({ body, item: null, tabType: "reader" });
    expect(body.children[0].children[0].textContent).toContain("Select a PDF");
  });

  it("generates a preview, applies the threshold, and saves on request", async () => {
    const sentences = [
      { text: "High importance sentence with enough words.", pageIndex: 0, pageHeight: 800, rects: [[0, 700, 200, 710]], section: "results", importance: 0.9, order: 0 },
      { text: "Low importance sentence with enough words.", pageIndex: 0, pageHeight: 800, rects: [[0, 680, 200, 690]], section: "results", importance: 0.2, order: 1 }
    ];
    const extractor = { cleanText: text => text, extractDocument: vi.fn(async () => ({ sentences, pages: [], pageCount: 1 })) };
    const nlp = loadScript("content/nlp.js").FastKeySentenceNLP;
    const importanceByText = new Map(sentences.map(sentence => [sentence.text, sentence.importance]));
    nlp.analyzeAsync = vi.fn(async (input, _count, options) => {
      options.onModelProgress({ stage: "preparing", operation: "summarization" });
      options.onModelProgress({ stage: "inference", operation: "summarization", progress: 0 });
      options.onModelProgress({ stage: "inference", operation: "summarization", progress: 50 });
      options.onModelProgress({ stage: "inference", operation: "summarization", progress: 100 });
      options.onModelProgress({ stage: "preparing", operation: "tag-embeddings" });
      options.onModelProgress({ stage: "inference", operation: "tag-embeddings", progress: 0, batch: 1, total: 2 });
      options.onModelProgress({ stage: "inference", operation: "tag-embeddings", progress: 50, batch: 1, total: 2 });
      options.onSummary?.("Raw summary text.");
      return input.map(sentence => ({
        ...sentence,
        importance: importanceByText.get(sentence.text) ?? sentence.importance,
        _paperSummary: "Summary text."
      }));
    });
    const api = annotator({ FastKeySentenceExtractor: extractor, FastKeySentenceNLP: nlp });
    api.init({ id: "addon@example.com", version: "1.0", rootURI: "resource://addon/" });
    api.__prefs.set("extensions.zotero-skimming.compressionRatio", 2);
    api.__zotero.Reader._readers = [{ itemID: 7 }];
    const saved = [];
    const attachmentItem = {
      ...attachment(),
      getAnnotations: () => saved.map(annotation => ({ annotationText: annotation.text, getTags: () => [{ tag: "autoskim-key-sentence" }] })),
      libraryID: 1
    };
    const window = actualDocument();
    window.ZoteroPane = {};
    const body = window.document.createElement("div");
    api.renderSidebar(body, window, attachmentItem, "reader");
    await new Promise(resolve => setTimeout(resolve, 0));
    const refs = api.panelRefs.get(body);
    expect(refs).toBeTruthy();
    const progressSpy = vi.spyOn(api, "setPanelProgress");
    const indeterminateSpy = vi.spyOn(api, "setPanelProgressIndeterminate");
    await api.generateForItem(attachmentItem, body);
    const generationProgress = progressSpy.mock.calls.map(call => call[1]);
    expect(generationProgress).toEqual([...generationProgress].sort((a, b) => a - b));
    expect(generationProgress).toContain(45);
    expect(generationProgress).toContain(58);
    expect(generationProgress).toContain(76);
    expect(generationProgress).toContain(100);
    expect(indeterminateSpy).toHaveBeenCalledTimes(2);
    expect(api.previews.get(attachmentItem.id).visible).toHaveLength(1);
    expect(refs.status.textContent).toContain("Generated 1");

    refs.threshold.value = "0";
    refs.threshold.dispatch("input");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(api.previews.get(attachmentItem.id).visible).toHaveLength(2);

    refs.threshold.value = "50";
    refs.threshold.dispatch("input");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(api.previews.get(attachmentItem.id).visible).toHaveLength(1);
    expect(refs.status.textContent).toContain("1 highlight");

    refs.threshold.value = "100";
    refs.threshold.dispatch("input");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(api.previews.get(attachmentItem.id).visible).toHaveLength(0);

    refs.threshold.value = "50";
    refs.threshold.dispatch("input");
    await new Promise(resolve => setTimeout(resolve, 0));

    api.__zotero.Annotations.saveFromJSON = vi.fn(async (_attachment, annotation) => {
      saved.push(annotation);
      return annotation;
    });
    await api.savePreviewForItem(attachmentItem, body);
    expect(saved).toHaveLength(1);
  });

  it("reuses extracted text and the summary on a second run", async () => {
    const sentences = [
      { text: "First sentence with enough words.", pageIndex: 0, pageHeight: 800, rects: [[0, 700, 200, 710]], section: "results", importance: 0.9, order: 0 },
      { text: "Second sentence with enough words.", pageIndex: 0, pageHeight: 800, rects: [[0, 680, 200, 690]], section: "results", importance: 0.4, order: 1 }
    ];
    const extractor = { cleanText: text => text, extractDocument: vi.fn(async () => ({ sentences, pages: [], pageCount: 1 })) };
    const nlp = loadScript("content/nlp.js").FastKeySentenceNLP;
    const calls = [];
    nlp.analyzeAsync = vi.fn(async (input, count, options) => {
      calls.push({ count, options });
      if (calls.length === 1) input.forEach(sentence => { sentence.tag = "stale"; sentence.tagColor = "#ffffff"; });
      options.onSummary?.("Raw summary.");
      return input.map(sentence => ({ ...sentence, importance: 1, _paperSummary: "Summary." }));
    });
    const api = annotator({ FastKeySentenceExtractor: extractor, FastKeySentenceNLP: nlp });
    api.init({ id: "addon@example.com", version: "1.0", rootURI: "resource://addon/" });
    api.__zotero.Reader._readers = [{ itemID: 7 }];
    const window = actualDocument();
    const body = window.document.createElement("div");
    const attachmentItem = attachment();
    api.renderSidebar(body, window, attachmentItem, "reader");
    await new Promise(resolve => setTimeout(resolve, 0));

    await api.generateForItem(attachmentItem, body);
    await api.generateForItem(attachmentItem, body);

    expect(extractor.extractDocument).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(calls[0].options.cachedSummary).toBe("");
    expect(calls[1].options.cachedSummary).toBe("Raw summary.");
    const cachedSentences = [...api.extractionCache.values()][0];
    expect(cachedSentences.every(sentence => sentence.tag === undefined)).toBe(true);
  });
});

describe("FastOfflineKeySentenceAnnotator attachments", () => {
  it("resolves attachments and titles", async () => {
    const api = annotator();
    const child = attachment({ id: 2 });
    api.__zotero.Items = { getAsync: async id => id === 2 ? child : null };
    expect(await api.resolvePDFAttachment({ isAttachment: () => true, isPDFAttachment: () => true })).toBeTruthy();
    expect(await api.resolvePDFAttachment({ isRegularItem: () => true, getAttachments: () => [3, 2] })).toBe(child);
    expect(await api.resolvePDFAttachment({ isRegularItem: () => false })).toBeNull();
    expect(await api.getDocumentTitle({ parentID: 9, getField: () => "file.pdf", attachmentFilename: "x" })).toBe("file.pdf");
  });

  it("deletes only saved Skim annotations", async () => {
    const first = { getTags: () => [{ tag: "autoskim-key-sentence" }], eraseTx: vi.fn(async () => {}) };
    const second = { getTags: () => [{ tag: "important" }], eraseTx: vi.fn(async () => {}) };
    const api = annotator();
    const count = await api.deleteSavedAnnotations({ getAnnotations: () => [first, second] });
    expect(count).toBe(1);
    expect(first.eraseTx).toHaveBeenCalledOnce();
    expect(second.eraseTx).not.toHaveBeenCalled();
  });

  it("requires a second press before removing saved annotations", async () => {
    const first = { getTags: () => [{ tag: "autoskim-key-sentence" }], eraseTx: vi.fn(async () => {}) };
    const api = annotator();
    const window = actualDocument();
    const body = window.document.createElement("div");
    const attachmentItem = attachment({ getAnnotations: () => [first] });
    api.renderSidebar(body, window, attachmentItem, "reader");
    const refs = api.panelRefs.get(body);
    await api.onRemoveSaved(attachmentItem, body);
    expect(first.eraseTx).not.toHaveBeenCalled();
    expect(refs.status.textContent).toContain("Confirm removal");
    await api.onRemoveSaved(attachmentItem, body);
    expect(first.eraseTx).toHaveBeenCalledOnce();
    expect(refs.status.textContent).toContain("Removed 1");
  });

  it("creates valid annotations with tags and scores", () => {
    const api = annotator();
    api.init({ id: "addon@example.com", version: "1.0", rootURI: "resource://addon/" });
    const annotation = api.makeAnnotation({ text: "A result.", tag: "result", tagColor: "#a5a5a5", pageIndex: 2, pageHeight: 800, rects: [[10, 700, 30, 720]], section: "results", importance: 0.8123 });
    expect(annotation.color).toBe("#a5a5a5");
    expect(annotation.sortIndex).toMatch(/^00002\|\d{6}\|\d{5}$/);
    expect(annotation.tags).toContainEqual({ name: "autoskim-key-sentence" });
    expect(annotation.tags).toContainEqual({ name: "result" });
    expect(annotation.comment).toBe("Section: results. Score: 0.812.");
  });
});

describe("FastOfflineKeySentenceAnnotator overlays", () => {
  it("paints one colored tag label on the nearest page edge", () => {
    const window = actualDocument();
    const doc = window.document;
    const pageDiv = doc.createElement("div");
    const viewport = {
      width: 600,
      height: 800,
      convertToViewportRectangle: rect => rect.slice()
    };
    const app = {
      pdfViewer: { _pages: [{ div: pageDiv, viewport }] },
      pdfDocument: {},
      eventBus: { on: vi.fn(), off: vi.fn() }
    };
    const reader = { _internalReader: { _primaryView: { _iframeWindow: { document: doc, PDFViewerApplication: app } } } };
    doc.querySelectorAll = selector => pageDiv.children.filter(child => child.className === selector.replace(/^\./, ""));
    const api = annotator({
      Components: {
        utils: {
          waiveXrays: value => value,
          cloneInto: value => value,
          exportFunction: fn => fn
        }
      }
    });
    const specs = [
      { tag: "method", tagColor: "#5b9bd5", tagDescription: "How the study ran.", pageIndex: 0, rects: [[20, 100, 200, 112]] },
      { tag: "result", tagColor: "#a5a5a5", pageIndex: 0, rects: [[20, 104, 200, 116]] },
      { tag: "goal", tagColor: "#ed7d31", pageIndex: 0, rects: [[450, 300, 580, 312]] },
      { tag: "conclusion", tagColor: "#70ad47", pageIndex: 0, rects: [[250, 400, 350, 412]] },
      { pageIndex: 0, rects: [[20, 500, 200, 512]] }
    ];
    const labelsOf = () => pageDiv.children.filter(child => child.className === "zotero-skimming-tag" && !child.removed);

    const overlays = api.installOverlays(reader, specs);
    const labels = labelsOf();
    expect(labels).toHaveLength(4);
    expect(labels.map(label => label.textContent)).toEqual(["method", "result", "goal", "conclusion"]);
    expect(labels[0].style.left).toBe("0px");
    expect(labels[0].style.right).toBeUndefined();
    expect(labels[1].style.left).toBe("0px");
    expect(labels[2].style.right).toBe("0px");
    expect(labels[2].style.left).toBeUndefined();
    expect(labels[3].style.right).toBe("0px");
    expect(labels[3].style.left).toBeUndefined();
    expect(labels[0].style.top).toBe("100px");
    expect(labels[1].style.top).toBe("116px");
    expect(labels[2].style.top).toBe("300px");
    expect(labels[3].style.top).toBe("400px");
    expect(labels[0].style.backgroundColor).toBe("#5b9bd5");
    expect(labels[0].getAttribute("title")).toBe("How the study ran.");

    overlays.update(specs.slice(0, 1));
    expect(labelsOf()).toHaveLength(1);

    overlays.clear();
    expect(pageDiv.children.filter(child => !child.removed)).toHaveLength(0);
  });
});
