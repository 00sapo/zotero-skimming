/* global Zotero, Services, IOUtils, FastKeySentenceNLP, FastKeySentenceModels, FastKeySentenceRemote, FastKeySentenceExtractor, FastKeySentenceSummaryLabels, FastKeySentenceSummaryLabelConfigV2, FastKeySentenceSummaryLabelConfigV2Path, FastKeySentenceBuildCommit */

FastOfflineKeySentenceAnnotator = {
  id: null,
  version: null,
  rootURI: null,
  iconURI: null,
  sectionKey: null,
  paneManager: null,
  prefsPaneID: null,
  prefBranch: "extensions.zotero-skimming.",
  previews: new Map(),
  panelRefs: new WeakMap(),
  generateLocks: new Set(),

  init({ id, version, rootURI }) {
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
    this.iconURI = encodeURI(rootURI + "assets/book reader.svg");
    this.previews = new Map();
    this.panelRefs = new WeakMap();
    this.generateLocks = new Set();
    if (typeof FastKeySentenceModels?.init === "function") FastKeySentenceModels.init(rootURI);
  },

  log(message) {
    Zotero.debug("Zotero Skimming: " + message);
  },

  addToWindow(window) {
    if (!window?.document || this.sectionKey) return;
    const paneManager = Zotero?.ItemPaneManager;
    if (!paneManager?.registerSection) {
      this.log("ItemPaneManager.registerSection not available in this window");
      return;
    }
    const sectionKey = paneManager.registerSection({
      paneID: "zotero-skimming-panel",
      pluginID: this.id,
      header: {
        l10nID: "zotero-skimming-panel-header",
        icon: this.iconURI
      },
      sidenav: {
        l10nID: "zotero-skimming-panel-sidebar",
        icon: this.iconURI
      },
      onItemChange: ({ setEnabled, tabType }) => {
        setEnabled(tabType === "reader");
        return true;
      },
      onRender: ({ body, item, tabType }) => {
        this.renderSidebar(body, body.ownerDocument.defaultView, item, tabType);
      },
      onAsyncRender: async ({ body, item, tabType }) => {
        await this.refreshSidebar(body, body.ownerDocument.defaultView, item, tabType);
      }
    });
    if (!sectionKey) return;
    this.sectionKey = sectionKey;
    this.paneManager = paneManager;
  },

  removeFromWindow() {},

  shutdown() {
    for (const preview of this.previews.values()) {
      try { preview.overlays?.clear(); } catch (_) {}
    }
    this.previews.clear();
    this.generateLocks.clear();
    this.panelRefs = new WeakMap();
    if (!this.sectionKey) return;
    try {
      this.paneManager?.unregisterSection?.(this.sectionKey);
    }
    catch (error) {
      this.log(error.stack || String(error));
    }
    this.sectionKey = null;
    this.paneManager = null;
  },

  async registerPrefsPane() {
    if (this.prefsPaneID || !Zotero.PreferencePanes?.register) return this.prefsPaneID;
    try {
      this.prefsPaneID = await Zotero.PreferencePanes.register({
        pluginID: this.id,
        id: "zotero-skimming-prefs",
        src: this.rootURI + "content/preferences.xhtml",
        label: "Zotero Skimming",
        image: this.iconURI
      });
    }
    catch (error) {
      this.log(`Could not register preferences pane: ${error.message || error}`);
    }
    return this.prefsPaneID;
  },

  settingsDefaults: Object.freeze({
    compressionRatio: 10,
    selectionThreshold: 0,
    localRelevance: false,
    summaryLabels: false,
    ollamaCommand: "/usr/bin/ollama",
    summaryLabelConfigV2: FastKeySentenceSummaryLabels.DEFAULT_CONFIG,
    remoteEndpoint: "",
    remoteApiKey: "",
    summarySource: "local",
    mapReduce: false,
    mapReduceSentences: 40,
    summaryModel: "",
    embeddingModel: ""
  }),

  getConfiguredSettings() {
    const defaults = this.settingsDefaults;
    const compressionRatio = Number(Zotero.Prefs.get(this.prefBranch + "compressionRatio", true));
    const thresholdPercent = Number(Zotero.Prefs.get(this.prefBranch + "selectionThreshold", true));
    const settings = {
      compressionRatio: Number.isFinite(compressionRatio) && compressionRatio >= 1.5 ? compressionRatio : defaults.compressionRatio,
      selectionThreshold: Number.isFinite(thresholdPercent)
        ? Math.min(1, Math.max(0, thresholdPercent / 100))
        : defaults.selectionThreshold,
      localRelevance: Zotero.Prefs.get(this.prefBranch + "localRelevance", true) ?? defaults.localRelevance,
      summaryLabels: Zotero.Prefs.get(this.prefBranch + "zeroShotLabels", true) ?? defaults.summaryLabels,
      ollamaCommand: Zotero.Prefs.get(this.prefBranch + "ollamaCommand", true) || defaults.ollamaCommand,
      summaryLabelConfigV2: FastKeySentenceSummaryLabelConfigV2 || defaults.summaryLabelConfigV2,
      remoteEndpoint: Zotero.Prefs.get(this.prefBranch + "remoteEndpoint", true) || defaults.remoteEndpoint,
      remoteApiKey: Zotero.Prefs.get(this.prefBranch + "remoteApiKey", true) || defaults.remoteApiKey,
      summarySource: Zotero.Prefs.get(this.prefBranch + "summarySource", true) || defaults.summarySource,
      mapReduce: Zotero.Prefs.get(this.prefBranch + "mapReduce", true) ?? defaults.mapReduce,
      mapReduceSentences: Number(Zotero.Prefs.get(this.prefBranch + "mapReduceSentences", true)) || defaults.mapReduceSentences,
      summaryModel: Zotero.Prefs.get(this.prefBranch + "summaryModel", true) || defaults.summaryModel,
      embeddingModel: Zotero.Prefs.get(this.prefBranch + "embeddingModel", true) || defaults.embeddingModel
    };
    settings.localRelevance = settings.localRelevance === true;
    settings.summaryLabels = settings.summaryLabels === true;
    settings.mapReduce = settings.mapReduce === true;
    settings.summarySource = settings.summarySource === "local" ? "local" : "remote";
    return this.isValidSettings(settings) ? settings : { ...defaults };
  },

  isValidSettings(settings) {
    return Number.isFinite(settings.compressionRatio)
        && settings.compressionRatio >= 1.5
        && Number.isFinite(settings.selectionThreshold)
        && settings.selectionThreshold >= 0
        && settings.selectionThreshold <= 1
        && (!settings.mapReduce || (Number.isInteger(settings.mapReduceSentences) && settings.mapReduceSentences >= 2))
        && ["localRelevance", "mapReduce", "summaryLabels"]
          .every(key => typeof settings[key] === "boolean")
        && ["local", "remote"].includes(settings.summarySource)
        && typeof settings.ollamaCommand === "string"
        && settings.ollamaCommand.startsWith("/")
        && typeof settings.summaryLabelConfigV2 === "string"
        && settings.summaryLabelConfigV2.trim().length > 0
        && typeof settings.remoteEndpoint === "string"
        && typeof settings.remoteApiKey === "string"
        && typeof settings.summaryModel === "string"
        && typeof settings.embeddingModel === "string";
  },

  saveSettings(settings) {
    Zotero.Prefs.set(this.prefBranch + "compressionRatio", settings.compressionRatio, true);
    Zotero.Prefs.set(this.prefBranch + "selectionThreshold", Math.round(settings.selectionThreshold * 100), true);
    Zotero.Prefs.set(this.prefBranch + "localRelevance", settings.localRelevance, true);
    Zotero.Prefs.set(this.prefBranch + "zeroShotLabels", settings.summaryLabels, true);
    Zotero.Prefs.set(this.prefBranch + "ollamaCommand", (settings.ollamaCommand || this.settingsDefaults.ollamaCommand).trim(), true);
    Zotero.Prefs.set(this.prefBranch + "summaryLabelConfigV2", "", true);
    if (FastKeySentenceSummaryLabelConfigV2Path) {
      const content = (settings.summaryLabelConfigV2 || this.settingsDefaults.summaryLabelConfigV2).trim();
      try {
        FastKeySentenceSummaryLabels.parseConfig(content);
      }
      catch (error) {
        this.log(`Refusing to save invalid summary label config: ${error.message || error}`);
        return false;
      }
      FastKeySentenceSummaryLabelConfigV2 = content;
      IOUtils.writeUTF8(FastKeySentenceSummaryLabelConfigV2Path, content).catch(() => {});
    }
    Zotero.Prefs.set(this.prefBranch + "remoteEndpoint", settings.remoteEndpoint || "", true);
    Zotero.Prefs.set(this.prefBranch + "remoteApiKey", settings.remoteApiKey || "", true);
    Zotero.Prefs.set(this.prefBranch + "summarySource", settings.summarySource, true);
    Zotero.Prefs.set(this.prefBranch + "mapReduce", settings.mapReduce, true);
    Zotero.Prefs.set(this.prefBranch + "mapReduceSentences", settings.mapReduceSentences, true);
    Zotero.Prefs.set(this.prefBranch + "summaryModel", settings.summaryModel || "", true);
    Zotero.Prefs.set(this.prefBranch + "embeddingModel", settings.embeddingModel || "", true);
    return true;
  },

  getSelectionThreshold() {
    const percent = Number(Zotero.Prefs.get(this.prefBranch + "selectionThreshold", true));
    return Number.isFinite(percent) ? Math.min(1, Math.max(0, percent / 100)) : 0;
  },

  setSelectionThreshold(value) {
    const percent = Math.round(Math.min(1, Math.max(0, Number(value) || 0)) * 100);
    Zotero.Prefs.set(this.prefBranch + "selectionThreshold", percent, true);
    return percent / 100;
  },

  calculateAnnotationTarget(pageCount, settings) {
    return Math.max(1, Math.round(Math.max(0, pageCount) / settings.compressionRatio));
  },

  isPanelEnabled(window, tabType) {
    return Boolean(window?.ZoteroPane && tabType === "reader");
  },

  // ---------- preferences pane ----------

  onPrefsLoad(window) {
    const doc = window?.document;
    if (!doc) return;
    const root = doc.getElementById("zotero-skimming-prefs");
    if (!root || root.getAttribute("data-bound") === "true") return;
    root.setAttribute("data-bound", "true");

    const $ = name => doc.getElementById("zotero-skimming-pref-" + name);
    const fields = {
      compressionRatio: $("compressionRatio"),
      selectionThreshold: $("selectionThreshold"),
      localRelevance: $("localRelevance"),
      summaryLabels: $("summaryLabels"),
      summaryLabelConfigV2: $("summaryLabelConfigV2"),
      summarySource: $("summarySource"),
      remoteEndpoint: $("remoteEndpoint"),
      remoteApiKey: $("remoteApiKey"),
      summaryModel: $("summaryModel"),
      embeddingModel: $("embeddingModel"),
      ollamaCommand: $("ollamaCommand"),
      mapReduce: $("mapReduce"),
      mapReduceSentences: $("mapReduceSentences")
    };
    const remoteOptions = $("remoteOptions");
    const localOptions = $("localOptions");
    const status = $("status");
    const progress = $("progress");
    const testButton = $("testOllama");

    const settings = this.getConfiguredSettings();
    fields.compressionRatio.value = String(settings.compressionRatio);
    fields.selectionThreshold.value = String(Math.round(settings.selectionThreshold * 100));
    fields.localRelevance.checked = settings.localRelevance;
    fields.summaryLabels.checked = settings.summaryLabels;
    fields.summaryLabelConfigV2.value = settings.summaryLabelConfigV2;
    fields.summarySource.value = settings.summarySource;
    fields.remoteEndpoint.value = settings.remoteEndpoint;
    fields.remoteApiKey.value = settings.remoteApiKey;
    fields.summaryModel.value = settings.summaryModel;
    fields.embeddingModel.value = settings.embeddingModel;
    fields.ollamaCommand.value = settings.ollamaCommand;
    fields.mapReduce.checked = settings.mapReduce;
    fields.mapReduceSentences.value = String(settings.mapReduceSentences);

    const setStatus = message => {
      if (status) status.textContent = message;
    };
    const syncVisibility = () => {
      const local = fields.summarySource.value === "local";
      if (localOptions) localOptions.hidden = !local;
      if (remoteOptions) remoteOptions.hidden = local;
    };

    const readForm = () => ({
      compressionRatio: Number(fields.compressionRatio.value),
      selectionThreshold: Math.min(1, Math.max(0, Number(fields.selectionThreshold.value) / 100)),
      localRelevance: fields.localRelevance.checked === true,
      summaryLabels: fields.summaryLabels.checked === true,
      summaryLabelConfigV2: fields.summaryLabelConfigV2.value,
      summarySource: fields.summarySource.value === "remote" ? "remote" : "local",
      remoteEndpoint: fields.remoteEndpoint.value.trim(),
      remoteApiKey: fields.remoteApiKey.value.trim(),
      summaryModel: fields.summaryModel.value.trim(),
      embeddingModel: fields.embeddingModel.value.trim(),
      ollamaCommand: fields.ollamaCommand.value.trim(),
      mapReduce: fields.mapReduce.checked === true,
      mapReduceSentences: Number(fields.mapReduceSentences.value)
    });

    const save = () => {
      const next = readForm();
      if (!this.isValidSettings(next)) {
        setStatus("Check the settings. The compression ratio must be at least 1.5 and the Ollama command must be an absolute path.");
        return false;
      }
      if (!this.saveSettings(next)) {
        setStatus("The summary label configuration is invalid, so it was not saved.");
        return false;
      }
      setStatus("Saved.");
      return true;
    };

    const validateLabels = () => {
      const text = fields.summaryLabelConfigV2.value;
      if (!text?.trim()) {
        fields.summaryLabelConfigV2.style.borderColor = "#c62828";
        return "Label configuration must not be empty.";
      }
      try {
        FastKeySentenceSummaryLabels.parseConfig(text);
        fields.summaryLabelConfigV2.style.borderColor = "";
        return "";
      }
      catch (error) {
        fields.summaryLabelConfigV2.style.borderColor = "#c62828";
        return error.message || String(error);
      }
    };

    for (const element of Object.values(fields)) {
      if (!element) continue;
      const handler = () => {
        if (element === fields.summarySource) syncVisibility();
        if (element === fields.summaryLabelConfigV2) {
          const error = validateLabels();
          if (error) {
            setStatus(`Label configuration is invalid: ${error}`);
            return;
          }
        }
        save();
      };
      element.addEventListener("change", handler);
      element.addEventListener("command", handler);
    }
    fields.summaryLabelConfigV2?.addEventListener("input", () => {
      const error = validateLabels();
      if (error) setStatus(`Label configuration is invalid: ${error}`);
    });

    const testSettings = async () => {
      const next = readForm();
      if (next.summarySource === "remote") {
        setStatus("Checking the remote configuration…");
        try {
          const result = await FastKeySentenceRemote.validateConfig({
            endpoint: next.remoteEndpoint || FastKeySentenceRemote.DEFAULT_ENDPOINT,
            apiKey: next.remoteApiKey,
            model: next.summaryModel || FastKeySentenceRemote.DEFAULT_MODEL
          });
          setStatus(result.valid ? "The remote configuration looks valid." : `Remote configuration error: ${result.error}`);
        }
        catch (error) {
          setStatus(`Remote configuration error: ${error.message || error}`);
        }
        return;
      }
      if (!next.ollamaCommand.startsWith("/")) {
        setStatus("Ollama command must be an absolute path, for example /usr/bin/ollama.");
        return;
      }
      testButton.disabled = true;
      if (progress) {
        progress.hidden = false;
        progress.value = 0;
      }
      setStatus("Starting Ollama and checking models…");
      try {
        FastKeySentenceModels.setModelOverrides(next);
        await FastKeySentenceModels.testOllama(next, event => {
          if (progress && Number.isFinite(Number(event.progress))) progress.value = Number(event.progress);
          if (event.stage === "initiate") setStatus("Starting Ollama…");
          else if (event.operation === "model-pull") setStatus(`Downloading ${event.model || "model"}…`);
          else if (event.stage === "done") setStatus("Ollama is ready.");
        });
        setStatus("Ollama is ready.");
      }
      catch (error) {
        setStatus(`Ollama error: ${error.message || error}`);
      }
      finally {
        testButton.disabled = false;
        if (progress) progress.hidden = true;
      }
    };
    testButton?.addEventListener("click", testSettings);
    testButton?.addEventListener("command", testSettings);

    syncVisibility();
    setStatus("");
  },

  // ---------- reader sidebar ----------

  renderSidebar(body, window, item, tabType) {
    if (!this.isPanelEnabled(window, tabType)) {
      body.textContent = "Select a PDF attachment or item.";
      return;
    }
    const doc = body.ownerDocument;
    const HTML_NS = "http://www.w3.org/1999/xhtml";
    const create = (tag, attrs = {}, text = null) => {
      const element = doc.createElementNS(HTML_NS, tag);
      for (const [name, value] of Object.entries(attrs)) {
        if (name === "style") element.style.cssText = value;
        else if (name === "className") element.className = value;
        else if (name in element && !name.startsWith("aria-")) {
          try { element[name] = value; }
          catch (_) { element.setAttribute(name, String(value)); }
        }
        else element.setAttribute(name, String(value));
      }
      if (text !== null) element.textContent = text;
      return element;
    };

    body.replaceChildren();
    const wrap = create("div", { style: "display:flex;flex-direction:column;gap:8px;padding:4px 0;font-size:12px;line-height:1.35" });

    const status = create("div", {
      id: "zotero-skimming-status",
      role: "status",
      "aria-live": "polite",
      style: "min-height:2.6em;opacity:0.9;white-space:pre-wrap"
    }, "Ready. Settings live in Zotero Settings → Zotero Skimming.");
    wrap.appendChild(status);

    const progress = create("progress", { max: "100", value: "0", hidden: true, style: "width:100%;height:8px" });
    wrap.appendChild(progress);

    const buttonStyle = "min-height:28px;padding:3px 10px;border:1px solid color-mix(in srgb, CanvasText 28%, transparent);border-radius:5px;background:ButtonFace;color:ButtonText;font:inherit";
    const actionRow = create("div", { style: "display:flex;gap:6px;flex-wrap:wrap" });
    const generate = create("button", { type: "button", style: buttonStyle + ";background:AccentColor;color:AccentColorText;border-color:AccentColor" }, "Generate highlights");
    const clear = create("button", { type: "button", style: buttonStyle }, "Clear");
    clear.disabled = true;
    actionRow.append(generate, clear);
    wrap.appendChild(actionRow);

    const saveRow = create("div", { style: "display:flex;gap:6px;flex-wrap:wrap" });
    const save = create("button", { type: "button", style: buttonStyle }, "Save as Zotero annotations…");
    const remove = create("button", { type: "button", style: buttonStyle }, "Remove saved annotations");
    save.disabled = true;
    remove.disabled = true;
    saveRow.append(save, remove);
    wrap.appendChild(saveRow);

    const thresholdRow = create("div", { style: "display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:6px;align-items:center" });
    const thresholdLabel = create("label", { htmlFor: "zotero-skimming-threshold" }, "Highlight threshold");
    const threshold = create("input", {
      id: "zotero-skimming-threshold",
      type: "range",
      min: "0",
      max: "100",
      step: "5",
      value: String(Math.round(this.getSelectionThreshold() * 100)),
      style: "width:100%"
    });
    const thresholdValue = create("output", {}, `${Math.round(this.getSelectionThreshold() * 100)}%`);
    thresholdRow.append(thresholdLabel, threshold, thresholdValue);
    wrap.appendChild(thresholdRow);

    wrap.appendChild(create("div", { style: "opacity:0.68;font-size:11px" },
      "Highlights are temporary. Save them only when you want them in your library."));

    const summaryBox = create("details", { style: "margin-top:4px" });
    summaryBox.appendChild(create("summary", {}, "Paper summary"));
    const summaryText = create("div", { style: "white-space:pre-wrap;opacity:0.9;padding:4px 0" }, "");
    summaryBox.appendChild(summaryText);
    summaryBox.hidden = true;
    wrap.appendChild(summaryBox);

    body.appendChild(wrap);

    const refs = { status, progress, generate, clear, save, remove, threshold, thresholdValue, summaryBox, summaryText, count: null };
    this.panelRefs.set(body, refs);

    generate.addEventListener("click", () => void this.generateForItem(item, body));
    clear.addEventListener("click", () => {
      this.clearPreviewForItem(item, body);
    });
    save.addEventListener("click", () => void this.savePreviewForItem(item, body));
    remove.addEventListener("click", () => void this.onRemoveSaved(item, body));
    threshold.addEventListener("input", () => {
      const value = this.setSelectionThreshold(Number(threshold.value) / 100);
      thresholdValue.textContent = `${Math.round(value * 100)}%`;
      void this.applyThresholdToItem(item, body);
    });

    void this.restorePreviewState(body, item);
  },

  async refreshSidebar(body, window, item, tabType) {
    if (!this.isPanelEnabled(window, tabType)) return;
    await this.restorePreviewState(body, item);
  },

  async restorePreviewState(body, item) {
    const refs = this.panelRefs.get(body);
    if (!refs) return;
    const attachment = await this.resolvePDFAttachment(item);
    if (!attachment) {
      this.setPanelStatus(body, "Select a PDF attachment.");
      refs.save.disabled = true;
      refs.clear.disabled = true;
      return;
    }
    const preview = this.previews.get(attachment.id);
    if (!preview) {
      this.setPanelStatus(body, "No highlights yet. Press Generate highlights.");
      refs.save.disabled = true;
      refs.clear.disabled = true;
      refs.summaryBox.hidden = true;
      refs.save.textContent = "Save as Zotero annotations…";
      refs.remove.disabled = !this.hasSavedAnnotations(attachment);
      return;
    }
    const threshold = this.getSelectionThreshold();
    refs.threshold.value = String(Math.round(threshold * 100));
    refs.thresholdValue.textContent = `${Math.round(threshold * 100)}%`;
    this.applyThreshold(preview);
    this.updatePanel(body, preview);
    refs.remove.disabled = !this.hasSavedAnnotations(attachment);
  },

  updatePanel(body, preview, message = null) {
    const refs = this.panelRefs.get(body);
    if (!refs) return;
    const visible = preview?.visible || [];
    const unsaved = visible.filter(sentence => !preview?.savedTexts?.has(sentence.text));
    refs.save.disabled = !unsaved.length;
    refs.clear.disabled = !preview;
    refs.progress.hidden = true;
    if (preview?.summary) {
      refs.summaryText.textContent = preview.summary;
      refs.summaryBox.hidden = false;
    }
    else {
      refs.summaryText.textContent = "";
      refs.summaryBox.hidden = true;
    }
    if (message) this.setPanelStatus(body, message);
    else if (preview) {
      this.setPanelStatus(body, `${visible.length} highlight${visible.length === 1 ? "" : "s"} shown from ${preview.sentences.length} selected sentences.`);
    }
  },

  setPanelStatus(body, message) {
    const refs = this.panelRefs.get(body);
    if (refs?.status) refs.status.textContent = message;
  },

  setPanelProgress(body, value) {
    const refs = this.panelRefs.get(body);
    if (!refs?.progress) return;
    refs.progress.hidden = false;
    const number = Number(value);
    refs.progress.value = Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 0;
  },

  hasSavedAnnotations(attachment) {
    try {
      return (attachment.getAnnotations?.() || []).some(annotation =>
        annotation.getTags?.().some(tag => tag.tag === "autoskim-key-sentence")
      );
    }
    catch (_) {
      return false;
    }
  },

  findReader(attachment) {
    try {
      const readers = Zotero.Reader?._readers || [];
      return readers.find(reader => String(reader.itemID) === String(attachment.id)) || null;
    }
    catch (_) {
      return null;
    }
  },

  async generateForItem(item, body) {
    const attachment = await this.resolvePDFAttachment(item);
    if (!attachment) {
      this.setPanelStatus(body, "Select a PDF attachment.");
      return;
    }
    if (this.generateLocks.has(attachment.id)) {
      this.setPanelStatus(body, "A run is already in progress for this PDF.");
      return;
    }
    const settings = this.getConfiguredSettings();
    if (!this.isValidSettings(settings)) {
      this.setPanelStatus(body, "Settings are invalid. Open Zotero Settings → Zotero Skimming.");
      return;
    }
    const reader = this.findReader(attachment);
    if (!reader) {
      this.setPanelStatus(body, "Open this PDF in the Zotero reader first.");
      return;
    }

    this.generateLocks.add(attachment.id);
    this.clearPreview(attachment.id);
    const refs = this.panelRefs.get(body);
    if (refs) {
      refs.generate.disabled = true;
      refs.save.disabled = true;
      refs.clear.disabled = true;
      refs.summaryBox.hidden = true;
    }
    this.setPanelProgress(body, 0);
    const preview = {
      attachment,
      reader,
      sentences: [],
      visible: [],
      summary: "",
      overlays: null,
      savedTexts: new Set()
    };
    this.previews.set(attachment.id, preview);

    try {
      this.setPanelStatus(body, "Reading PDF text…");
      const extracted = await FastKeySentenceExtractor.extractDocument(reader, attachment, (progress, page, total) => {
        this.setPanelProgress(body, progress * 40);
        this.setPanelStatus(body, `Reading PDF text… page ${page}/${total}`);
      });
      const candidates = extracted.sentences.filter(sentence =>
        !FastKeySentenceNLP.isNoise(sentence)
        && sentence.section !== "abstract"
        && sentence.section !== "references"
        && sentence.section !== "front matter"
      );
      if (!candidates.length) throw new Error("No usable candidate sentences were found.");
      const count = this.calculateAnnotationTarget(candidates.length, settings);
      FastKeySentenceModels.setModelOverrides(settings);
      this.setPanelStatus(body, `Selecting ${count} sentences from ${candidates.length} candidates…`);
      this.setPanelProgress(body, 45);
      const selected = await FastKeySentenceNLP.analyzeAsync(candidates, count, {
        localRelevance: settings.localRelevance,
        summaryLabels: settings.summaryLabels,
        summaryLabelConfigV2: settings.summaryLabelConfigV2,
        summarySource: settings.summarySource,
        mapReduce: settings.mapReduce,
        mapReduceSentences: settings.mapReduceSentences,
        documentTitle: await this.getDocumentTitle(attachment),
        onModelProgress: event => {
          if (event.stage === "done") this.setPanelProgress(body, 90);
          else if (event.stage === "inference" && Number.isFinite(Number(event.progress))) {
            this.setPanelProgress(body, 50 + Number(event.progress) * 0.4);
          }
          if (event.message) this.setPanelStatus(body, event.message);
          else if (event.stage === "mapping") this.setPanelStatus(body, `Summarising in parts… ${event.completed || 0}/${event.total || 0}`);
          else if (event.stage === "reducing") this.setPanelStatus(body, "Reducing summary…");
          else if (event.stage === "sending") this.setPanelStatus(body, "Sending text to the remote API…");
          else if (event.stage === "retrying") this.setPanelStatus(body, "Retrying the remote request…");
        }
      });
      if (!selected.length) throw new Error("No suitable highlight candidates were found.");

      preview.sentences = selected;
      preview.summary = selected.find(sentence => typeof sentence._paperSummary === "string")?._paperSummary || "";
      this.applyThreshold(preview);
      preview.overlays = this.installOverlays(reader, preview.visible);
      this.setPanelProgress(body, 100);
      this.updatePanel(body, preview, `Generated ${preview.visible.length} temporary highlight${preview.visible.length === 1 ? "" : "s"}. Press Save to keep them.`);
      return preview;
    }
    catch (error) {
      this.log(error.stack || String(error));
      this.setPanelStatus(body, `⚠ ${error.message || String(error)}`);
      this.previews.delete(attachment.id);
      if (refs) {
        refs.progress.hidden = true;
        refs.summaryBox.hidden = true;
      }
      return null;
    }
    finally {
      this.generateLocks.delete(attachment.id);
      if (refs) refs.generate.disabled = false;
    }
  },

  applyThreshold(preview) {
    const threshold = this.getSelectionThreshold();
    preview.visible = (preview.sentences || []).filter(sentence =>
      Number(sentence.importance) >= threshold
    );
    preview.overlays?.update?.(preview.visible);
    return preview.visible;
  },

  async applyThresholdToItem(item, body) {
    const attachment = await this.resolvePDFAttachment(item);
    if (!attachment) return;
    const preview = this.previews.get(attachment.id);
    if (!preview) {
      this.setPanelStatus(body, "Generate highlights before changing the threshold.");
      return;
    }
    this.applyThreshold(preview);
    this.updatePanel(body, preview);
  },

  installOverlays(reader, sentences) {
    let handle = null;
    try {
      const iframeWin = reader?._internalReader?._primaryView?._iframeWindow;
      const Cu = Components?.utils;
      if (!iframeWin || !Cu) return null;
      const win = Cu.waiveXrays(iframeWin);
      const app = win.PDFViewerApplication;
      if (!app?.pdfViewer || !app?.pdfDocument) return null;
      handle = { win, app, Cu };
    }
    catch (_) {
      return null;
    }

    const { win, app, Cu } = handle;
    const doc = win.document;
    const HL_CLASS = "zotero-skimming-hl";
    if (!doc.getElementById("zotero-skimming-preview-style")) {
      const style = doc.createElement("style");
      style.id = "zotero-skimming-preview-style";
      style.textContent = `.${HL_CLASS}{position:absolute;pointer-events:none;border-radius:2px;mix-blend-mode:multiply;z-index:3;}`;
      (doc.head || doc.documentElement).appendChild(style);
    }

    let specs = Array.isArray(sentences) ? sentences.slice() : [];
    let byPage = new Map();
    const group = () => {
      byPage = new Map();
      for (const spec of specs) {
        if (!byPage.has(spec.pageIndex)) byPage.set(spec.pageIndex, []);
        byPage.get(spec.pageIndex).push(spec);
      }
    };
    group();

    const colorFor = spec => {
      const color = typeof spec.tagColor === "string" ? spec.tagColor : "#ffd400";
      const match = /^#([0-9a-f]{6})$/i.exec(color);
      if (!match) return "rgba(255, 212, 0, 0.28)";
      const value = parseInt(match[1], 16);
      return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, 0.28)`;
    };

    const paintPage = pageIndex => {
      const pageSpecs = byPage.get(pageIndex);
      const pageView = app.pdfViewer._pages?.[pageIndex];
      const pageDiv = pageView?.div;
      const viewport = pageView?.viewport;
      if (!pageSpecs || !pageDiv || !viewport) return;
      for (const element of Array.from(pageDiv.querySelectorAll(`.${HL_CLASS}`))) element.remove();
      if (!pageView.canvas && pageView.renderingState === 0) return;
      for (const spec of pageSpecs) {
        for (const rect of spec.rects || []) {
          let viewportRect;
          try {
            viewportRect = viewport.convertToViewportRectangle(Cu.cloneInto([...rect], win));
          }
          catch (_) {
            continue;
          }
          const left = Math.min(viewportRect[0], viewportRect[2]);
          const top = Math.min(viewportRect[1], viewportRect[3]);
          const width = Math.abs(viewportRect[2] - viewportRect[0]);
          const height = Math.abs(viewportRect[3] - viewportRect[1]);
          if (!(width > 0 && height > 0)) continue;
          const div = doc.createElement("div");
          div.className = HL_CLASS;
          div.style.left = `${left}px`;
          div.style.top = `${top}px`;
          div.style.width = `${width}px`;
          div.style.height = `${height}px`;
          div.style.backgroundColor = colorFor(spec);
          pageDiv.appendChild(div);
        }
      }
    };

    const repaint = () => {
      for (const pageIndex of byPage.keys()) {
        try { paintPage(pageIndex); } catch (_) {}
      }
    };
    let listener = null;
    try {
      listener = Cu.exportFunction(event => {
        const pageIndex = Number(event?.pageNumber) - 1;
        if (byPage.has(pageIndex)) repaint();
      }, win);
      app.eventBus?.on?.("pagerendered", listener);
    }
    catch (_) {
      listener = null;
    }

    repaint();

    return {
      update(next) {
        specs = Array.isArray(next) ? next.slice() : [];
        group();
        repaint();
      },
      repaint,
      clear() {
        if (listener) {
          try { app.eventBus?.off?.("pagerendered", listener); } catch (_) {}
        }
        try {
          for (const element of Array.from(doc.querySelectorAll(`.${HL_CLASS}`))) element.remove();
        }
        catch (_) {}
      }
    };
  },

  clearPreview(attachmentId) {
    const preview = this.previews.get(attachmentId);
    if (!preview) return;
    try { preview.overlays?.clear(); } catch (_) {}
    this.previews.delete(attachmentId);
  },

  clearPreviewForItem(item, body) {
    void this.resolvePDFAttachment(item).then(attachment => {
      if (!attachment) return;
      this.clearPreview(attachment.id);
      this.setPanelStatus(body, "Highlights cleared.");
      const refs = this.panelRefs.get(body);
      if (refs) {
        refs.save.disabled = true;
        refs.clear.disabled = true;
        refs.summaryBox.hidden = true;
        refs.progress.hidden = true;
      }
    });
  },

  async savePreviewForItem(item, body) {
    const attachment = await this.resolvePDFAttachment(item);
    if (!attachment) {
      this.setPanelStatus(body, "Select a PDF attachment.");
      return;
    }
    const preview = this.previews.get(attachment.id);
    if (!preview || !preview.visible.length) {
      this.setPanelStatus(body, "Generate highlights first.");
      return;
    }
    if (!attachment.libraryID) {
      this.setPanelStatus(body, "The PDF must be saved in a Zotero library first.");
      return;
    }
    const refs = this.panelRefs.get(body);
    if (refs) refs.save.disabled = true;
    this.setPanelProgress(body, 0);
    this.setPanelStatus(body, "Saving Zotero annotations…");
    let created = 0;
    let skipped = 0;
    try {
      const existing = new Set();
      for (const annotation of attachment.getAnnotations?.() || []) {
        const text = annotation.annotationText || annotation.getNote?.() || "";
        if (text) existing.add(text);
      }
      const notifierQueue = new Zotero.Notifier.Queue();
      try {
        for (let index = 0; index < preview.visible.length; index++) {
          const sentence = preview.visible[index];
          const annotationText = typeof FastKeySentenceExtractor?.cleanText === "function"
            ? FastKeySentenceExtractor.cleanText(sentence.text)
            : sentence.text;
          if (existing.has(annotationText)) {
            preview.savedTexts.add(sentence.text);
            skipped++;
            continue;
          }
          const annotation = this.makeAnnotation(sentence);
          await Zotero.Annotations.saveFromJSON(attachment, annotation, { notifierQueue });
          existing.add(annotationText);
          preview.savedTexts.add(sentence.text);
          created++;
          this.setPanelProgress(body, Math.round(100 * (index + 1) / preview.visible.length));
        }
      }
      finally {
        await Zotero.Notifier.commit(notifierQueue);
      }
      this.setPanelStatus(body, skipped
        ? `Saved ${created} new annotations. ${skipped} were already saved.`
        : `Saved ${created} Zotero annotations.`);
      if (refs) refs.remove.disabled = false;
      this.updatePanel(body, preview, skipped
        ? `Saved ${created} new annotations. ${skipped} were already saved.`
        : `Saved ${created} Zotero annotations.`);
      return { created, skipped };
    }
    catch (error) {
      this.log(error.stack || String(error));
      this.setPanelStatus(body, `⚠ Could not save annotations: ${error.message || error}`);
      return null;
    }
    finally {
      if (refs) refs.progress.hidden = true;
    }
  },

  async onRemoveSaved(item, body) {
    const attachment = await this.resolvePDFAttachment(item);
    if (!attachment) return;
    const refs = this.panelRefs.get(body);
    if (!refs) return;
    if (refs.remove.dataset.confirm !== "true") {
      refs.remove.dataset.confirm = "true";
      refs.remove.textContent = "Confirm removal";
      this.setPanelStatus(body, "Press Confirm removal to delete saved Skim annotations. This does not remove temporary highlights.");
      return;
    }
    refs.remove.dataset.confirm = "";
    refs.remove.textContent = "Remove saved annotations";
    let removed = 0;
    try {
      removed = await this.deleteSavedAnnotations(attachment);
      const preview = this.previews.get(attachment.id);
      preview?.savedTexts?.clear();
      if (preview) this.updatePanel(body, preview);
    }
    catch (error) {
      this.log(error.stack || String(error));
      this.setPanelStatus(body, `⚠ Could not remove annotations: ${error.message || error}`);
      return;
    }
    refs.remove.disabled = true;
    this.setPanelStatus(body, `Removed ${removed} saved annotation${removed === 1 ? "" : "s"}.`);
  },

  async deleteSavedAnnotations(attachment) {
    let removed = 0;
    for (const annotation of attachment.getAnnotations?.() || []) {
      if (!annotation.getTags?.().some(tag => tag.tag === "autoskim-key-sentence")) continue;
      await annotation.eraseTx();
      removed++;
    }
    return removed;
  },

  async resolvePDFAttachment(item) {
    if (!item) return null;
    if (item.isAttachment?.()) return item.isPDFAttachment?.() ? item : null;
    if (!item.isRegularItem?.()) return null;
    for (const id of item.getAttachments?.() || []) {
      const child = await Zotero.Items.getAsync(id);
      if (child?.isPDFAttachment?.()) return child;
    }
    return null;
  },

  async getDocumentTitle(attachment) {
    try {
      const parentID = attachment.parentID || attachment.getSource?.();
      if (parentID) {
        const parent = await Zotero.Items.getAsync(parentID);
        const parentTitle = parent?.getField?.("title");
        if (parentTitle) return parentTitle;
      }
    }
    catch (error) {
      this.log("Could not read parent title: " + (error.message || error));
    }
    return attachment.getField("title") || attachment.attachmentFilename || "PDF";
  },

  makeAnnotation(sentence) {
    const text = typeof FastKeySentenceExtractor?.cleanText === "function"
      ? FastKeySentenceExtractor.cleanText(sentence.text)
      : sentence.text;
    const rects = sentence.rects || [];
    const tag = typeof sentence.tag === "string" && sentence.tag.trim() ? sentence.tag.trim() : null;
    const configuredLabel = tag ? FastKeySentenceSummaryLabels.parseConfig(FastKeySentenceSummaryLabelConfigV2 || this.settingsDefaults.summaryLabelConfigV2)
      .find(label => label.name === `[${tag}]`) : null;
    const tagColor = typeof sentence.tagColor === "string" && /^#[0-9a-f]{6}$/i.test(sentence.tagColor)
      ? sentence.tagColor : configuredLabel?.color || null;
    const tagIndex = Number.isInteger(sentence.tagIndex) ? sentence.tagIndex : -1;
    if (typeof Services !== "undefined") Services.console.logStringMessage(`Zotero Skimming: makeAnnotation — tag="${tag || "(none)"}" tagColor="${tagColor || "(none)"}" tagIndex=${tagIndex} tagDescription="${(sentence.tagDescription || "").slice(0, 60)}" tagScore=${sentence.tagScore}`);
    const top = Math.max(...rects.map(rect => rect[3]));
    const left = Math.min(...rects.map(rect => rect[0]));
    const pagePart = String(Math.max(0, Math.min(99999, sentence.pageIndex))).padStart(5, "0");
    const verticalPart = String(Math.max(0, Math.min(999999, Math.round((sentence.pageHeight - top) * 100)))).padStart(6, "0");
    const horizontalPart = String(Math.max(0, Math.min(99999, Math.round(left * 100)))).padStart(5, "0");
    const sortIndex = `${pagePart}|${verticalPart}|${horizontalPart}`;
    const importance = Number(sentence.importance);
    return {
      key: Zotero.DataObjectUtilities.generateKey(),
      type: "highlight",
      color: tagColor || "#aaaaaa",
      pageLabel: String(sentence.pageIndex + 1),
      sortIndex,
      position: { pageIndex: sentence.pageIndex, rects },
      text,
      comment: `${sentence.tagDescription ? sentence.tagDescription + ". " : ""}Section: ${sentence.section || "unclassified"}. Score: ${(Number.isFinite(importance) ? importance : 0).toFixed(3)}.`,
      tags: [{ name: "autoskim-key-sentence" }, ...(tag ? [{ name: tag }] : [])]
    };
  }
};
