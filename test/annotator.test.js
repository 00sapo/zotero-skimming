import { describe, expect, it, vi } from "vitest";
import { loadScript } from "./helpers.js";

function annotator(globals = {}) {
  const nlpContext = loadScript("content/nlp.js");
  return loadScript("content/annotator.js", {
    FastKeySentenceNLP: nlpContext.FastKeySentenceNLP,
    FastKeySentenceRemote: { DEFAULT_ENDPOINT: "https://api.example.com", DEFAULT_MODEL: "test-model", summarize: async () => "A test summary.", getConfig: () => ({ endpoint: "", apiKey: "", model: "" }), saveConfig: () => {} },
    Zotero: { debug: vi.fn(), DataObjectUtilities: { generateKey: () => "KEY" } },
    ...globals
  }).FastOfflineKeySentenceAnnotator;
}

function fakeWindow(selected = []) {
  const elements = new Map();
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.style = {}; this.hidden = false; }
    set id(value) { this._id = value; elements.set(value, this); }
    get id() { return this._id; }
    setAttribute(name, value) { this[name] = value; }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    remove() { this.removed = true; if (this.id) elements.delete(this.id); }
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
    removeEventListener(type, listener) { this.listeners[type] = (this.listeners[type] || []).filter(x => x !== listener); }
    dispatch(type, event = {}) { for (const listener of this.listeners[type] || []) listener({ preventDefault: vi.fn(), stopPropagation: vi.fn(), ...event }); }
    focus() { this.focused = true; }
  }
  const root = new Element("root");
  const doc = {
    documentElement: root,
    createElementNS: (_ns, tag) => new Element(tag),
    createXULElement: tag => new Element(tag),
    getElementById: id => elements.get(id) || (id === "zotero-itemmenu" ? popup : null)
  };
  const popup = new Element("popup");
  return {
    document: doc,
    ZoteroPane: { getSelectedItems: () => selected },
    setTimeout: fn => fn(), requestAnimationFrame: fn => fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    elements, popup
  };
}

const word = (text, x, y) => ({ text, rect: [x, y, x + 20, y + 10], top: y + 10 });

function descendants(element) {
  return [element, ...element.children.flatMap(descendants)];
}

function byText(window, text) {
  return descendants(window.document.documentElement).find(element => element.textContent === text);
}

function byId(window, id) {
  return window.elements.get(id);
}

describe("FastOfflineKeySentenceAnnotator geometry", () => {
  it("splits, orders, joins, groups, and merges positioned prose", () => {
    const api = annotator();
    expect(api.splitFragment("one two", [0, 0, 30, 10])).toHaveLength(2);
    expect(api.splitFragment("", [0, 0, 1, 1])).toEqual([]);
    expect(api.joinTokens(["Hello", ",", "world", "!", "(", "test", ")"])).toBe("Hello, world! (test)");
    const page = { pageIndex: 0, width: 600, height: 800, words: [word("world", 30, 700), word("Hello", 0, 700), word("Next", 0, 670)] };
    expect(api.buildLines(page).map(line => line.text)).toEqual(["Hello world", "Next"]);
    expect(api.mergeRects([[20, 10, 30, 20], [0, 10, 15, 20], [0, 0, 10, 5]])).toEqual([[0, 10, 30, 20], [0, 0, 10, 5]]);
  });

  it("reads two-column prose down the left column before the right", () => {
    const api = annotator();
    const line = (text, x, y) => text.split(" ").map((part, index) => word(part, x + index * 26, y));
    const page = {
      pageIndex: 0,
      width: 600,
      height: 800,
      words: [
        ...line("Left column begins with a complete thought", 40, 700),
        ...line("and ends only on this second line.", 40, 688),
        ...line("Right column begins with a separate thought", 340, 700),
        ...line("and ends only on this second line.", 340, 688)
      ]
    };

    expect(api.buildLines(page).map(item => item.text)).toEqual([
      "Left column begins with a complete thought",
      "and ends only on this second line.",
      "Right column begins with a separate thought",
      "and ends only on this second line."
    ]);
    expect(api.buildSentences([page]).map(item => item.text)).toEqual([
      "Left column begins with a complete thought and ends only on this second line.",
      "Right column begins with a separate thought and ends only on this second line."
    ]);
  });

  it("splits columns despite irregular word spacing", () => {
    const api = annotator();
    const row = (left, right, y) => [
      ...left.map((text, index) => word(text, [40, 120, 210, 275][index], y)),
      ...right.map((text, index) => word(text, [313, 343, 373, 403][index], y))
    ];
    const page = {
      pageIndex: 0,
      width: 600,
      height: 800,
      words: [
        ...row(["Left", "first", "wide", "gap."], ["Right", "first", "column", "text."], 700),
        ...row(["Left", "second", "wide", "gap."], ["Right", "second", "column", "text."], 688),
        word("Heading", 40, 676),
        ...["Right", "after", "short", "heading."].map((text, index) => word(text, 313 + index * 30, 676))
      ]
    };

    expect(api.buildLines(page).map(item => item.text)).toEqual([
      "Left first wide gap.",
      "Left second wide gap.",
      "Heading",
      "Right first column text.",
      "Right second column text.",
      "Right after short heading."
    ]);
  });

  it("keeps column-local headings with their left-column prose", () => {
    const api = annotator();
    const line = (text, x, y) => text.split(" ").map((part, index) => word(part, x + index * 26, y));
    const page = {
      pageIndex: 0,
      width: 600,
      height: 800,
      words: [
        ...line("Abstract prose on the left.", 40, 730),
        ...line("1 Introduction", 40, 700),
        ...line("Introduction prose on the left.", 40, 688),
        ...line("Continuation starts in the right column.", 340, 730),
        ...line("More right-column prose follows.", 340, 688)
      ]
    };

    expect(api.buildLines(page).map(item => item.text)).toEqual([
      "Abstract prose on the left.",
      "1 Introduction",
      "Introduction prose on the left.",
      "Continuation starts in the right column.",
      "More right-column prose follows."
    ]);
  });

  it("extracts legacy and structured pages, filtering duplicate geometry", () => {
    const api = annotator();
    const legacy = api.extractPages({ pages: [[100, 200, [0, 10, 40, 20, "Hello world"]]] });
    expect(legacy[0].words.map(item => item.text)).toEqual(["Hello", "world"]);
    const structured = api.extractStructuredPages({ pageSizes: [[100, 200]], content: [{ text: "Hello world", position: { pageIndex: 0, rects: [[0, 10, 40, 20]] } }, { text: "Hello world", position: { pageIndex: 0, rects: [[0, 10, 40, 20]] } }] });
    expect(structured).toHaveLength(1);
    expect(structured[0].words).toHaveLength(2);
    expect(api.extractStructuredPages("not json")).toEqual([]);
  });

  it("recognizes tables, references, margins, and builds usable sentences", () => {
    const api = annotator();
    const rows = [["Table 1", 0], ["A 1 B 2 C 3", 0], ["D 4 E 5 F 6", 0]].map(([text], i) => ({ text, words: text.split(" ").map((part, j) => word(part, j * 80, 700 - i * 20)), height: 10 }));
    expect(api.detectTableLineIndexes(rows, { width: 600 }).size).toBeGreaterThan(0);
    const pages = [{ pageIndex: 0, width: 600, height: 800, words: [
      ..."Abstract".split(" ").map((text, i) => word(text, i * 30, 730)),
      ..."We propose a method that substantially improves results for difficult scientific tasks.".split(" ").map((text, i) => word(text, i * 30, 700)),
      ..."The results demonstrate reliable accuracy across independent evaluation datasets.".split(" ").map((text, i) => word(text, i * 30, 670))
    ] }];
    const built = api.buildSentences(pages);
    expect(built.length).toBeGreaterThan(0);
    expect(built[0].section).toBe("abstract");
    expect(Array.isArray(built[0].rects)).toBe(true);
    const repeated = Array.from({ length: 4 }, (_, pageIndex) => ({ pageIndex, width: 100, height: 100, words: [word("Header", 0, 95), word(`Body${pageIndex}`, 0, 50)] }));
    expect(api.cleanRepeatedMargins(repeated).every(page => page.words.every(item => item.text !== "Header"))).toBe(true);
    expect(api.isFrontMatterLine({ text: "doi: 10.1/x" }, { pageIndex: 0 })).toBe(true);
    expect(api.isFrontMatterLine({ text: "Abstract" }, { pageIndex: 0 })).toBe(false);
    expect(api.isBackMatterLine("Funding:" )).toBe(true);
    expect(api.isTableCaptionLine({ text: "Table IV Results" })).toBe(true);
    expect(api.isLikelyReferencePage(Array.from({ length: 6 }, (_, i) => ({ text: `[${i + 1}] Smith 2020.` })))).toBe(true);
    expect(api.cleanRepeatedMargins([{ pageIndex: 0, words: [] }])).toHaveLength(1);
  });

  it("handles structured variants, columns, tables, and sentence section transitions", () => {
    const api = annotator();
    const structured = api.extractStructuredPages({ metadata: { pageSizes: [{ pageNumber: 1, size: [200, 300] }] }, content: { anchor: { page: 0, rectangles: [[40, 20, 0, 10]] }, value: "A B", child: { str: "C", position: { pageIndex: 0, rect: [0, 20, 20, 30] } } } });
    expect(structured[0].words.map(x => x.text)).toEqual(["C", "A", "B"]);
    const columns = Array.from({ length: 8 }, (_, i) => word(String(i), i < 4 ? 0 : 400, (i < 4 ? 700 : 500) - (i % 4) * 30));
    expect(api.sortWordsReadingOrder(columns, 600, 800).map(x => x.text)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
    expect(api.detectTableLineIndexes([], { width: 100 }).size).toBe(0);
    expect(() => api.extractPages(null)).toThrow("no page structure");
    const lines = ["Introduction", "A complete opening sentence with enough meaningful words for testing.", "Funding", "Ignored sentence after funding.", "References", "[1] Smith 2020."].map((text, i) => ({ pageIndex: 0, width: 600, height: 800, words: text.split(" ").map((x, j) => word(x, j * 30, 750 - i * 20)) }));
    expect(api.buildSentences(lines).some(x => x.section === "introduction")).toBe(true);
    const referencePage = {
      pageIndex: 0,
      width: 600,
      height: 800,
      words: ["Introduction", "A complete opening sentence with enough meaningful words for testing.", "References", "[1] Smith, J. 2020. A useful dataset.", "Datasets..", "A reference title following a misleading heading."].flatMap((text, i) =>
        text.split(" ").map((part, j) => word(part, j * 30, 750 - i * 20))
      )
    };
    expect(api.buildSentences([referencePage]).map(sentence => sentence.text)).toEqual([
      "A complete opening sentence with enough meaningful words for testing."
    ]);
  });

  it("creates Zotero-valid annotations and reports model progress", () => {
    const api = annotator();
    const annotation = api.makeAnnotation({ text: "A result.", role: "result", pageIndex: 2, pageHeight: 800, rects: [[10, 700, 30, 720]], section: "results", importance: 0.8123 });
    expect(annotation.sortIndex).toMatch(/^00002\|\d{6}\|\d{5}$/);
    expect(annotation.tags).toContainEqual({ name: "auto-key-sentence" });
    const line = { setProgress: vi.fn(), setText: vi.fn() };
    const handler = api.modelProgressHandler(line, { llmEmbeddings: true, llmClassification: true });
    handler({ operation: "embeddings", stage: "download", file: "a.bin", loaded: 1024, total: 2048, model: "model" });
    handler({ operation: "classification", stage: "inference", progress: 50 });
    expect(line.setProgress).toHaveBeenCalled();
    expect(line.setText).toHaveBeenLastCalledWith(expect.stringContaining("analysing"));
  });
});

describe("FastOfflineKeySentenceAnnotator Zotero workflows", () => {
  it("manages menu lifecycle, preferences, settings, and dialog submission", async () => {
    const prefs = new Map();
    const models = { updateModels: vi.fn().mockResolvedValue(), supportsInference: () => false };
    const api = annotator({
      FastKeySentenceModels: models,
      Zotero: { debug: vi.fn(), DataObjectUtilities: { generateKey: () => "KEY" }, Prefs: { get: key => prefs.get(key), set: (key, value) => prefs.set(key, value) } },
      Services: { prompt: { alert: vi.fn() } }
    });
    api.init({ id: "id", version: "1", rootURI: "root" });
    expect(api.id).toBe("id");
    expect(api.isValidDensity({ perPage: 1, minimum: 0, maximum: 1 })).toBe(true);
    expect(api.isValidDensity({ perPage: 0, minimum: 2, maximum: 1 })).toBe(false);
    expect(api.getConfiguredSettings()).toEqual({ ...api.settingsDefaults });
    api.saveSettings({ perPage: 2, minimum: 1, maximum: 3, llmEmbeddings: true, llmClassification: false, classificationBatchSize: 12, multilingual: true, remoteEndpoint: "https://api.example.com", remoteApiKey: "sk-test", remoteModel: "gpt-4o-mini" });
    expect(api.getConfiguredSettings()).toMatchObject({ perPage: 2, classificationBatchSize: 12, remoteEndpoint: "https://api.example.com" });
    expect(api.calculateAnnotationTarget(3, { perPage: 2, minimum: 1, maximum: 4 })).toBe(4);

    const window = fakeWindow([{ isPDFAttachment: () => true }]);
    api.openAnnotationDialog = vi.fn().mockResolvedValue();
    api.addToWindow(window);
    const menu = window.popup.children[0];
    menu.dispatch("popupshowing");
    expect(menu.hidden).toBe(false);
    menu.dispatch("command");
    expect(api.openAnnotationDialog).toHaveBeenCalledWith(window);
    api.removeFromWindow(window);
    expect(menu.removed).toBe(true);

    expect(models.updateModels).not.toHaveBeenCalled();
  });

  it("renders, validates, updates, cancels, and submits the settings overlay", async () => {
    const updateModels = vi.fn().mockImplementation(async (_settings, progress) => progress({ stage: "download", model: "x", file: "dir/a.bin", loaded: 512, total: 1024 }));
    const api = annotator({ FastKeySentenceModels: { updateModels, supportsInference: () => true }, Zotero: { debug: vi.fn(), DataObjectUtilities: { generateKey: () => "KEY" }, Prefs: { get: () => null, set: vi.fn() } } });
    const window = fakeWindow();
    const result = api.showSettingsOverlay(window, api.settingsDefaults);
    expect(window.document.documentElement.children[0].tag).toBe("div");
    expect(byId(window, "per-page").value).toBe("1.9");
    expect(byId(window, "classification-batch-size").value).toBe("8");
    expect(byId(window, "remote-endpoint")).toBeDefined();
    await byText(window, "Update models").listeners.click[0]();
    expect(descendants(window.document.documentElement).find(x => x.role === "alert").textContent).toContain("Use valid density");
    api.isValidSettings = settings => settings.perPage > 0;
    byId(window, "llm-embeddings").checked = true;
    await byText(window, "Update models").listeners.click[0]();
    expect(updateModels).toHaveBeenCalled();
    byId(window, "per-page").value = "0";
    const submit = () => descendants(window.document.documentElement).find(x => x.tag === "form").listeners.submit[0]({ preventDefault: vi.fn() });
    submit();
    expect(byId(window, "per-page").focused).toBe(true);
    byId(window, "per-page").value = "2";
    byId(window, "minimum").value = "1";
    byId(window, "maximum").value = "3";
    byId(window, "classification-batch-size").value = "12";
    byId(window, "remote-api-key").value = "sk-test";
    submit();
    await expect(result).resolves.toMatchObject({ perPage: 2, llmEmbeddings: true, classificationBatchSize: 12, remoteApiKey: "sk-test" });

    const cancelled = api.showSettingsOverlay(window, api.settingsDefaults);
    window.document.documentElement.children.at(-1).listeners.keydown?.[0]?.({ key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() });
    window.dispatch = undefined;
    window.removeEventListener.mockClear();
    window.document.documentElement.children.at(-1);
    window.addEventListener.mock.calls.at(-1)[1]({ key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() });
    await expect(cancelled).resolves.toBeNull();
  });

  it("covers model update errors and dialog orchestration", async () => {
    const api = annotator({ Services: { prompt: { alert: vi.fn() } }, FastKeySentenceModels: { updateModels: async () => { throw new Error("offline"); } }, Zotero: { debug: vi.fn(), DataObjectUtilities: { generateKey: () => "KEY" }, Prefs: { get: () => null, set: vi.fn() } } });
    const window = fakeWindow();
    api.isValidSettings = () => true;
    const pending = api.showSettingsOverlay(window, { ...api.settingsDefaults, llmEmbeddings: true });
    await byText(window, "Update models").listeners.click[0]();
    expect(descendants(window.document.documentElement).find(x => x.role === "alert").textContent).toBe("offline");
    byText(window, "Cancel").listeners.click[0]();
    await expect(pending).resolves.toBeNull();
    api.showSettingsOverlay = vi.fn().mockResolvedValue(null);
    await api.openAnnotationDialog(window);
    api.isValidSettings = () => false;
    api.showSettingsOverlay.mockResolvedValueOnce({ perPage: 0 });
    await expect(api.openAnnotationDialog(window)).rejects.toThrow("Invalid annotation settings");
    api.isValidSettings = () => true;
    api.showSettingsOverlay.mockResolvedValueOnce(api.settingsDefaults);
    api.runForSelection = vi.fn();
    await api.openAnnotationDialog(window);
    expect(api.runForSelection).toHaveBeenCalled();
  });

  it("resolves attachments, handles selection errors, and creates annotations", async () => {
    const alert = vi.fn();
    const children = new Map([[2, { isPDFAttachment: () => true }], [3, { isPDFAttachment: () => false }]]);
    const api = annotator({ Zotero: { debug: vi.fn(), DataObjectUtilities: { generateKey: () => "KEY" }, Items: { getAsync: async id => children.get(id) } }, Services: { prompt: { alert } } });
    expect(await api.resolvePDFAttachment({ isAttachment: () => true, isPDFAttachment: () => true })).toBeTruthy();
    expect(await api.resolvePDFAttachment({ isRegularItem: () => true, getAttachments: () => [3, 2] })).toBe(children.get(2));
    expect(await api.resolvePDFAttachment({ isRegularItem: () => false })).toBeNull();
    api.annotateAttachment = vi.fn();
    await api.runForSelection(fakeWindow([{ id: 1, isAttachment: () => true, isPDFAttachment: () => true }, { id: 1, isAttachment: () => true, isPDFAttachment: () => true }]));
    expect(api.annotateAttachment).toHaveBeenCalledTimes(1);
    await api.runForSelection(fakeWindow());
    expect(alert).toHaveBeenCalled();
    expect(await api.getDocumentTitle({ parentID: 9, getField: () => "file.pdf", attachmentFilename: "x" })).toBe("file.pdf");
  });

  it("covers remaining public error and alternate workflow branches", async () => {
    const alert = vi.fn();
    const api = annotator({ Services: { prompt: { alert } }, Zotero: { debug: vi.fn(), DataObjectUtilities: { generateKey: () => "KEY" }, Prefs: { get: () => null, set: vi.fn() }, Items: { getAsync: async () => ({ getField: () => "Parent title" }) } } });
    const noPopup = fakeWindow();
    noPopup.document.getElementById = () => null;
    api.addToWindow(noPopup);
    api.addToWindow({});
    const menuWindow = fakeWindow();
    api.openAnnotationDialog = vi.fn().mockRejectedValue(new Error("dialog failed"));
    api.addToWindow(menuWindow);
    const menu = menuWindow.popup.children[0];
    menu.dispatch("popupshowing", { });
    menuWindow.ZoteroPane.getSelectedItems = () => { throw new Error("selection failed"); };
    menu.dispatch("popupshowing");
    menu.dispatch("command");
    await Promise.resolve();
    expect(alert).toHaveBeenCalled();
    api.addToWindow(menuWindow);
    api.removeFromWindow({});

    expect(api.getConfiguredSettings()).toEqual(api.settingsDefaults);
    expect(await api.getDocumentTitle({ parentID: 1, getField: () => "Fallback" })).toBe("Parent title");
    api.getDocumentTitle({ parentID: 1, getField: () => "Fallback" });
    const titleApi = annotator({ Zotero: { debug: vi.fn(), DataObjectUtilities: { generateKey: () => "KEY" }, Items: { getAsync: async () => { throw new Error("gone"); } } } });
    expect(await titleApi.getDocumentTitle({ parentID: 1, getField: () => "", attachmentFilename: "file.pdf" })).toBe("file.pdf");

    const line = { setProgress: vi.fn(), setText: vi.fn() };
    const progress = api.modelProgressHandler(line, { llmEmbeddings: true, llmClassification: false });
    progress({ operation: "unknown", stage: "loading", loaded: 1, total: 0 });
    progress({ operation: "embeddings", stage: "progress", file: "a", loaded: 2000000, total: 2000000 });
    progress({ operation: "embeddings", stage: "inference", loaded: 1, total: 2 });
    expect(line.setText).toHaveBeenCalledWith(expect.stringContaining("analysing"));

    expect(api.extractStructuredPages({ pageSizes: [{ pageIndex: 2, width: 50, height: 60 }], content: [{ text: "discard", position: { pageIndex: 2, rect: [0, 100, 1, 101] } }, { text: "A B C D", position: { pageIndex: 2, rects: [[20, 20, 0, 10], [0, 30, 20, 40]] } }] })[0].words).toHaveLength(5);
    expect(api.extractStructuredPages({ content: ["orphan", null, 7] })).toEqual([]);
    expect(api.splitFragment("One", [0, 0, 1, 1])).toHaveLength(1);
    expect(api.splitFragment("", null)).toEqual([]);
    expect(api.sortWordsReadingOrder([], 1, 1)).toEqual([]);
    expect(api.isFrontMatterLine({ text: "author@example.org" }, { pageIndex: 0 })).toBe(true);
    expect(api.isFrontMatterLine({ text: "Article" }, { pageIndex: 0 })).toBe(true);

    const sentenceLines = ["Introduction: A sufficiently long inline sentence has useful findings for testing.", "References", "[1] Smith 2020.", "Appendix", "A subsequent sufficiently long appendix sentence restores prose processing."].map((text, i) => ({ pageIndex: 0, width: 600, height: 800, words: text.split(" ").map((x, j) => word(x, j * 25, 750 - i * 25)) }));
    expect(api.buildSentences(sentenceLines).some(x => x.section === "introduction")).toBe(true);

    const modelApi = annotator({ FastKeySentenceModels: { updateModels: vi.fn().mockResolvedValue(), supportsInference: () => true }, Zotero: { debug: vi.fn(), DataObjectUtilities: { generateKey: () => "KEY" }, Prefs: { get: () => null, set: vi.fn() } } });
    const settingsWindow = fakeWindow();
    modelApi.isValidSettings = () => true;
    const pending = modelApi.showSettingsOverlay(settingsWindow, modelApi.settingsDefaults);
    byId(settingsWindow, "llm-embeddings").checked = true;
    await byText(settingsWindow, "Update models").listeners.click[0]();
    expect(byText(settingsWindow, "Update models").focused).toBe(true);
    byText(settingsWindow, "Cancel").listeners.click[0]();
    await pending;
  });

  it("exercises parser and prose filtering alternatives", () => {
    const api = annotator();
    const page = { width: 600, height: 800 };
    const line = (text, xs = [0]) => ({ text, height: 10, words: text.split(" ").map((text, i) => word(text, xs[i] ?? i * 25, 700)) });
    expect(api.tableLineProfile(line("A 1 B 2", [0, 100, 200, 300]), page).tableLike).toBe(true);
    expect(api.detectTableLineIndexes([line("Table 1"), line("A 1 B 2", [0, 100, 200, 300]), line("C 3 D 4", [0, 100, 200, 300]), line("tail", [0, 100])], page).size).toBeGreaterThan(0);
    expect(api.detectTableLineIndexes([line("A B", [0, 100]), line("C D", [0, 100]), line("E F", [0, 100])], page).size).toBeGreaterThanOrEqual(0);
    expect(api.isLikelyReferencePage(Array.from({ length: 6 }, (_, i) => ({ text: `Smith, J. (${2000 + i}). Journal.` })))).toBe(true);
    expect(api.cleanRepeatedMargins(Array.from({ length: 4 }, (_, pageIndex) => ({ pageIndex, height: 100, words: [word("Footer", 0, 0), word("Body", 0, 50)] })))[0].words).toHaveLength(1);
    expect(api.extractPages({ pages: [[10, 20, [0, 1, 3, 4, ""], [0, 1, 3, 4, "Ok"]]] })[0].words).toHaveLength(1);
    const prose = ["doi: x", "Abstract", "A complete sentence has enough useful words to be considered here.", "A second paragraph starts with useful detail and continues clearly"].map((text, i) => ({ pageIndex: 0, width: 600, height: 800, words: text.split(" ").map((x, j) => word(x, j * 22 + (i === 3 ? 100 : 0), 750 - i * 45)) }));
    expect(api.buildSentences(prose).length).toBeGreaterThan(0);
    for (const density of [{ perPage: NaN, minimum: 1, maximum: 2 }, { perPage: 0, minimum: 1, maximum: 2 }, { perPage: 21, minimum: 1, maximum: 2 }, { perPage: 1, minimum: 1.1, maximum: 2 }, { perPage: 1, minimum: 1, maximum: 1.1 }, { perPage: 1, minimum: -1, maximum: 2 }, { perPage: 1, minimum: 1, maximum: 0 }, { perPage: 1, minimum: 1, maximum: 501 }, { perPage: 1, minimum: 3, maximum: 2 }]) expect(api.isValidDensity(density)).toBe(false);
    expect(api.isValidSettings({ ...api.settingsDefaults, llmEmbeddings: 1 })).toBe(false);
    expect(api.calculateAnnotationTarget(-1, { perPage: 1, minimum: 2, maximum: 3 })).toBe(2);
    expect(api.makeAnnotation({ text: "x", role: "other", pageIndex: -1, pageHeight: 1, rects: [[-1, 2, 3, 4]], section: "", importance: 0 })).toMatchObject({ color: "#aaaaaa", pageLabel: "0" });
  });

  it("reports extraction and annotation API failures", async () => {
    const progressLines = [];
    class Progress { changeHeadline() {} show() {} startCloseTimer() {} }
    Progress.prototype.ItemProgress = class { setProgress() {} setText() {} setError() { progressLines.push(this); } };
    const attachment = { id: 1, getField: () => "PDF", getAnnotations: () => [], getFilePathAsync: async () => "" };
    const base = { debug: vi.fn(), DataObjectUtilities: { generateKey: () => "KEY" }, ProgressWindow: Progress, Prefs: { get: () => null }, Annotations: { saveFromJSON: async () => {} }, Notifier: { Queue: class {}, commit: async () => {} } };
    let api = annotator({ Zotero: base });
    await expect(api.annotateAttachment(attachment)).rejects.toThrow("text-extraction");
    api = annotator({ Zotero: { ...base, Annotations: undefined, PDFWorker: { getRecognizerData: async () => ({ pages: [] }) } } });
    await expect(api.annotateAttachment(attachment)).rejects.toThrow("annotation API");
    api = annotator({ Zotero: { ...base, PDFWorker: { getRecognizerData: async () => ({ totalPages: 0, pages: [] }) } } });
    await expect(api.extractAllPages(attachment)).rejects.toThrow("zero pages");
    api = annotator({ Zotero: { ...base, PDFWorker: { getRecognizerData: async () => ({ totalPages: 6, pages: [[1, 1]] }) } } });
    await expect(api.extractAllPages(attachment)).rejects.toThrow("internal PDF-worker");
    api = annotator({ IOUtils: { read: async () => new Uint8Array() }, Zotero: { ...base, PDFWorker: { getRecognizerData: async () => ({ totalPages: 6, pages: [[1, 1]] }), _query: async () => ({}), _enqueue: async () => ({}) } } });
    await expect(api.extractAllPages(attachment)).rejects.toThrow("missing locally");
    expect(progressLines.length).toBeGreaterThan(0);
  });

  it("extracts all chunks and annotates through progress, ranking, saving, and failures", async () => {
    const saved = []; const commits = [];
    const progressLines = [];
    class Progress { changeHeadline() {} show() {} startCloseTimer() {} }
    Progress.prototype.ItemProgress = class { constructor() { progressLines.push(this); } setProgress() {} setText() {} setError() { this.error = true; } };
    const worker = {
      getRecognizerData: vi.fn().mockResolvedValueOnce({ totalPages: 6, pages: [[100, 100, [0, 10, 50, 20, "First page sentence."]]] }).mockResolvedValueOnce({ pages: [[100, 100, [0, 10, 50, 20, "Sixth page sentence."]]] }),
      _enqueue: async fn => fn(), _query: vi.fn().mockResolvedValueOnce({ buf: new ArrayBuffer(1) }).mockResolvedValueOnce({ pages: [[100, 100, [0, 10, 50, 20, "Sixth page sentence."]]] })
    };
    const nlp = loadScript("content/nlp.js").FastKeySentenceNLP;
    nlp.analyzeAsync = async sentences => [{ ...sentences[0], role: "result", importance: 1 }];
    const api = annotator({
      FastKeySentenceNLP: nlp,
      IOUtils: { read: async () => new Uint8Array([1]) },
      Zotero: { debug: vi.fn(), DataObjectUtilities: { generateKey: () => "KEY" }, PDFWorker: worker, Promise: { delay: async () => {} }, ProgressWindow: Progress,
        Annotations: { saveFromJSON: async (_attachment, value) => saved.push(value) }, Notifier: { Queue: class {}, commit: async queue => commits.push(queue) }, Prefs: { get: () => null } }
    });
    const attachment = { id: 8, getFilePathAsync: async () => "/tmp/a.pdf", getField: () => "Paper", getAnnotations: () => [] };
    const percentages = [];
    expect((await api.extractAllPages(attachment, value => percentages.push(value))).map(page => page.pageIndex)).toEqual([0, 5]);
    expect(percentages).toEqual([5 / 6, 1]);
    api.extractAllPages = async () => [{ pageIndex: 0, width: 100, height: 100, words: "Abstract A sufficiently long result sentence demonstrates reliable findings across datasets.".split(" ").map((text, i) => word(text, i * 5, 70)) }];
    await api.annotateAttachment(attachment, null, { perPage: 1, minimum: 1, maximum: 2, llmEmbeddings: false, llmClassification: false, multilingual: false });
    expect(saved).toHaveLength(1);
    expect(commits).toHaveLength(1);
    attachment.getAnnotations = () => [{ getTags: () => [{ tag: "auto-key-sentence" }] }];
    await expect(api.annotateAttachment(attachment)).rejects.toThrow("already contains");
    expect(progressLines.at(-1).error).toBe(true);
  });
});
