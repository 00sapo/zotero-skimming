/* global Zotero, Services, FastKeySentenceNLP, FastKeySentenceModels */

FastOfflineKeySentenceAnnotator = {
  id: null,
  version: null,
  rootURI: null,
  windowState: new WeakMap(),
  prefBranch: "extensions.fast-offline-key-sentence-annotator.",

  init({ id, version, rootURI }) {
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
  },

  log(message) {
    Zotero.debug("Fast Offline Key-Sentence Annotator: " + message);
  },

  addToWindow(window) {
    if (!window?.document || this.windowState.has(window)) return;

    const doc = window.document;
    const popup = doc.getElementById("zotero-itemmenu");
    if (!popup) {
      this.log("Item context menu not found in this window");
      return;
    }

    const menuitem = doc.createXULElement("menuitem");
    menuitem.id = "fast-offline-key-sentence-annotator-menuitem";
    menuitem.setAttribute("label", "Annotate key sentences…");

    // Delay opening the modal until the context menu has closed. Opening a
    // child window directly from a XUL menu command is unreliable on some
    // Zotero/Gecko builds.
    const onCommand = () => {
      window.setTimeout(() => {
        this.openAnnotationDialog(window).catch(error => {
          this.log(error.stack || String(error));
          Services.prompt.alert(
            window,
            "Fast Offline Key-Sentence Annotator",
            error.message || String(error)
          );
        });
      }, 75);
    };

    const onPopupShowing = () => {
      try {
        const selected = window.ZoteroPane?.getSelectedItems?.() || [];
        const applicable = selected.some(item =>
          item?.isPDFAttachment?.() || item?.isRegularItem?.()
        );
        menuitem.hidden = !applicable;
      }
      catch (error) {
        this.log(error.stack || String(error));
        menuitem.hidden = true;
      }
    };

    menuitem.addEventListener("command", onCommand);
    popup.addEventListener("popupshowing", onPopupShowing);
    popup.appendChild(menuitem);
    this.windowState.set(window, {
      popup,
      menuitem,
      onCommand,
      onPopupShowing
    });
  },

  removeFromWindow(window) {
    const state = this.windowState.get(window);
    if (!state) return;
    state.menuitem.removeEventListener("command", state.onCommand);
    state.popup.removeEventListener("popupshowing", state.onPopupShowing);
    state.menuitem.remove();
    this.windowState.delete(window);
  },

  settingsDefaults: Object.freeze({
    perPage: 1.9,
    minimum: 12,
    maximum: 80,
    llmEmbeddings: false,
    llmClassification: false,
    classificationBatchSize: 8,
    multilingual: false,
    subspanHighlights: true,
    remoteEndpoint: "",
    remoteApiKey: "",
    remoteModel: ""
  }),

  getConfiguredSettings() {
    const defaults = this.settingsDefaults;
    const perPage = Number(Zotero.Prefs.get(this.prefBranch + "annotationsPerPage", true));
    const minimum = Number(Zotero.Prefs.get(this.prefBranch + "minimumAnnotations", true));
    const maximum = Number(Zotero.Prefs.get(this.prefBranch + "maximumAnnotations", true));
    const settings = {
      perPage: Number.isFinite(perPage) ? perPage : defaults.perPage,
      minimum: Number.isInteger(minimum) ? minimum : defaults.minimum,
      maximum: Number.isInteger(maximum) ? maximum : defaults.maximum,
      llmEmbeddings: Zotero.Prefs.get(this.prefBranch + "llmEmbeddings", true) ?? defaults.llmEmbeddings,
      llmClassification: Zotero.Prefs.get(this.prefBranch + "llmClassification", true) ?? defaults.llmClassification,
      classificationBatchSize: Number(Zotero.Prefs.get(this.prefBranch + "classificationBatchSize", true)) || defaults.classificationBatchSize,
      multilingual: Zotero.Prefs.get(this.prefBranch + "multilingual", true) ?? defaults.multilingual,
      subspanHighlights: Zotero.Prefs.get(this.prefBranch + "subspanHighlights", true) ?? defaults.subspanHighlights,
      remoteEndpoint: Zotero.Prefs.get(this.prefBranch + "remoteEndpoint", true) || defaults.remoteEndpoint,
      remoteApiKey: Zotero.Prefs.get(this.prefBranch + "remoteApiKey", true) || defaults.remoteApiKey,
      remoteModel: Zotero.Prefs.get(this.prefBranch + "remoteModel", true) || defaults.remoteModel
    };
    settings.llmEmbeddings = settings.llmEmbeddings === true;
    settings.llmClassification = settings.llmClassification === true;
    settings.multilingual = settings.multilingual === true;
    settings.subspanHighlights = settings.subspanHighlights === true;
    return this.isValidSettings(settings) ? settings : { ...defaults };
  },

  isValidDensity({ perPage, minimum, maximum }) {
    return Number.isFinite(perPage)
      && perPage > 0
      && perPage <= 20
      && Number.isInteger(minimum)
      && Number.isInteger(maximum)
      && minimum >= 0
      && maximum >= 1
      && maximum <= 500
      && minimum <= maximum;
  },

  isValidSettings(settings) {
    return this.isValidDensity(settings)
      && Number.isInteger(settings.classificationBatchSize)
      && settings.classificationBatchSize >= 1
      && settings.classificationBatchSize <= 32
      && ["llmEmbeddings", "llmClassification", "multilingual", "subspanHighlights"]
        .every(key => typeof settings[key] === "boolean")
      && typeof settings.remoteEndpoint === "string"
      && typeof settings.remoteApiKey === "string"
      && typeof settings.remoteModel === "string";
  },

  saveSettings(settings) {
    Zotero.Prefs.set(this.prefBranch + "annotationsPerPage", settings.perPage, true);
    Zotero.Prefs.set(this.prefBranch + "minimumAnnotations", settings.minimum, true);
    Zotero.Prefs.set(this.prefBranch + "maximumAnnotations", settings.maximum, true);
    Zotero.Prefs.set(this.prefBranch + "llmEmbeddings", settings.llmEmbeddings, true);
    Zotero.Prefs.set(this.prefBranch + "llmClassification", settings.llmClassification, true);
    Zotero.Prefs.set(this.prefBranch + "classificationBatchSize", settings.classificationBatchSize, true);
    Zotero.Prefs.set(this.prefBranch + "multilingual", settings.multilingual, true);
    Zotero.Prefs.set(this.prefBranch + "subspanHighlights", settings.subspanHighlights, true);
    Zotero.Prefs.set(this.prefBranch + "remoteEndpoint", settings.remoteEndpoint || "", true);
    Zotero.Prefs.set(this.prefBranch + "remoteApiKey", settings.remoteApiKey || "", true);
    Zotero.Prefs.set(this.prefBranch + "remoteModel", settings.remoteModel || "", true);
  },

  calculateAnnotationTarget(pageCount, settings) {
    const raw = Math.round(settings.perPage * Math.max(0, pageCount));
    return Math.min(settings.maximum, Math.max(settings.minimum, raw));
  },

  showSettingsOverlay(window, initialSettings) {
    const doc = window.document;
    const HTML_NS = "http://www.w3.org/1999/xhtml";
    const existing = doc.getElementById("fast-key-sentence-annotator-settings-overlay");
    existing?.remove();

    const create = (tag, attrs = {}, text = null) => {
      const element = doc.createElementNS(HTML_NS, tag);
      for (const [name, value] of Object.entries(attrs)) {
        if (name === "style") {
          element.style.cssText = value;
        }
        else if (name === "className") {
          element.className = value;
        }
        else if (name in element && !name.startsWith("aria-")) {
          try {
            element[name] = value;
          }
          catch (_) {
            element.setAttribute(name, String(value));
          }
        }
        else {
          element.setAttribute(name, String(value));
        }
      }
      if (text !== null) element.textContent = text;
      return element;
    };

    const overlay = create("div", {
      id: "fast-key-sentence-annotator-settings-overlay",
      role: "presentation",
      style: [
        "position: fixed",
        "inset: 0",
        "z-index: 2147483647",
        "display: flex",
        "align-items: center",
        "justify-content: center",
        "padding: 24px",
        "background: rgba(0, 0, 0, 0.42)",
        "font: message-box"
      ].join(";")
    });

    const panel = create("section", {
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "fast-key-sentence-annotator-dialog-title",
      style: [
        "width: min(680px, calc(100vw - 48px))",
        "max-height: calc(100vh - 48px)",
        "overflow: auto",
        "padding: 22px",
        "border: 1px solid color-mix(in srgb, CanvasText 25%, transparent)",
        "border-radius: 10px",
        "box-shadow: 0 18px 60px rgba(0, 0, 0, 0.35)",
        "background: Canvas",
        "color: CanvasText"
      ].join(";")
    });

    const title = create("h1", {
      id: "fast-key-sentence-annotator-dialog-title",
      style: "margin: 0 0 18px; font-size: 1.35rem; font-weight: 600"
    }, "Key-sentence annotation");
    panel.appendChild(title);

    const form = create("form", { novalidate: true });

    const makeFieldset = legendText => {
      const fieldset = create("fieldset", {
        style: "margin: 0 0 16px; padding: 14px 16px 16px; border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); border-radius: 7px"
      });
      fieldset.appendChild(create("legend", {
        style: "padding: 0 6px; font-weight: 600"
      }, legendText));
      return fieldset;
    };

    const density = makeFieldset("Highlight density");
    const densityGrid = create("div", {
      style: "display: grid; grid-template-columns: minmax(0, 1fr) 112px; gap: 10px 18px; align-items: center"
    });

    const numberFields = [
      ["per-page", "Average annotations per eligible page", initialSettings.perPage, "0.1", "20", "0.1"],
      ["minimum", "Minimum annotations per PDF", initialSettings.minimum, "0", "500", "1"],
      ["maximum", "Maximum annotations per PDF", initialSettings.maximum, "1", "500", "1"]
    ];
    const inputs = {};
    for (const [id, labelText, value, min, max, step] of numberFields) {
      const label = create("label", { htmlFor: id }, labelText);
      const input = create("input", {
        id,
        type: "number",
        value: String(value),
        min,
        max,
        step,
        style: "width: 112px; min-height: 30px; padding: 4px 7px; border: 1px solid color-mix(in srgb, CanvasText 28%, transparent); border-radius: 4px; background: Field; color: FieldText; font: inherit"
      });
      inputs[id] = input;
      densityGrid.append(label, input);
    }
    density.appendChild(densityGrid);
    form.appendChild(density);

    const stages = makeFieldset("Optional transformer stages");
    const options = [
      ["llm-embeddings", "LLM embeddings", "Use semantic sentence vectors instead of TF-IDF for ranking and MMR diversity.", initialSettings.llmEmbeddings],
      ["llm-classification", "LLM classification", "Classify selected sentences by scholarly discourse role.", initialSettings.llmClassification],
      ["multilingual", "Multilingual", "Use multilingual alternatives for enabled stages.", initialSettings.multilingual],
      ["subspan-highlights", "Subspan highlights", "Highlight the best 10–30 word phrase within each sentence instead of the full sentence.", initialSettings.subspanHighlights]
    ];
    const checks = {};
    for (const [id, labelText, helpText, checked] of options) {
      const row = create("div", {
        style: "display: grid; grid-template-columns: auto minmax(0, 1fr); column-gap: 10px; row-gap: 2px; margin-bottom: 12px; align-items: start"
      });
      const check = create("input", {
        id,
        type: "checkbox",
        checked: checked === true,
        style: "margin: 3px 0 0"
      });
      const label = create("label", {
        htmlFor: id,
        style: "font-weight: 500; line-height: 1.35"
      }, labelText);
      const help = create("div", {
        style: "grid-column: 2; opacity: 0.78; font-size: 0.92rem; line-height: 1.38"
      }, helpText);
      checks[id] = check;
      row.append(check, label, help);
      stages.appendChild(row);
    }
    const batchSizeRow = create("div", {
      style: "display: grid; grid-template-columns: minmax(0, 1fr) 72px; gap: 10px 18px; align-items: center; margin: 0 0 12px"
    });
    const batchSizeInput = create("input", {
      id: "classification-batch-size",
      type: "number",
      value: String(initialSettings.classificationBatchSize),
      min: "1",
      max: "32",
      step: "1",
      style: "width: 72px; min-height: 30px; padding: 4px 7px; border: 1px solid color-mix(in srgb, CanvasText 28%, transparent); border-radius: 4px; background: Field; color: FieldText; font: inherit"
    });
    batchSizeRow.append(
      create("label", { htmlFor: "classification-batch-size" }, "Classification batch size"),
      batchSizeInput
    );
    inputs["classification-batch-size"] = batchSizeInput;
    stages.appendChild(batchSizeRow);
    form.appendChild(stages);

    const remoteConfig = makeFieldset("Remote summarization (required)");
    const remoteGrid = create("div", {
      style: "display: grid; grid-template-columns: 100px minmax(0, 1fr); gap: 8px 14px; align-items: center"
    });
    const remoteFields = [
      ["remote-endpoint", "Endpoint", initialSettings.remoteEndpoint || FastKeySentenceRemote.DEFAULT_ENDPOINT, "https://api.openai.com/v1/chat/completions"],
      ["remote-model", "Model", initialSettings.remoteModel || FastKeySentenceRemote.DEFAULT_MODEL, "gpt-4o-mini"],
      ["remote-api-key", "API key", initialSettings.remoteApiKey, "sk-..."]
    ];
    let remoteEndpointInput, remoteModelInput, remoteApiKeyInput;
    for (const [id, labelText, value, placeholder] of remoteFields) {
      remoteGrid.appendChild(create("label", { htmlFor: id, style: "font-weight: 500" }, labelText));
      const input = create("input", {
        id,
        type: id === "remote-api-key" ? "password" : "text",
        value: String(value || ""),
        placeholder,
        style: "min-height: 30px; padding: 4px 7px; border: 1px solid color-mix(in srgb, CanvasText 28%, transparent); border-radius: 4px; background: Field; color: FieldText; font: inherit"
      });
      inputs[id] = input;
      remoteGrid.appendChild(input);
      if (id === "remote-endpoint") remoteEndpointInput = input;
      if (id === "remote-model") remoteModelInput = input;
      if (id === "remote-api-key") remoteApiKeyInput = input;
    }
    remoteConfig.appendChild(remoteGrid);
    remoteConfig.appendChild(create("p", {
      style: "margin: 8px 0 0; opacity: 0.78; font-size: 0.92rem; line-height: 1.38"
    }, "Any OpenAI-compatible endpoint works (OpenAI, Anthropic via proxy, Groq, local vLLM, etc.). The summary guides sentence ranking via semantic similarity."));
    form.appendChild(remoteConfig);

    const error = create("p", {
      role: "alert",
      "aria-live": "polite",
      style: "min-height: 1.4em; margin: 0 0 12px; color: #c62828; font-weight: 500"
    });
    form.appendChild(error);

    const modelStatus = create("div", {
      style: "display: none; margin: 0 0 14px; padding: 10px 12px; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: 6px; background: color-mix(in srgb, Canvas 94%, AccentColor 6%)"
    });
    const modelStatusText = create("div", {
      style: "margin-bottom: 7px; line-height: 1.35"
    }, "");
    const modelProgress = create("progress", {
      max: 100,
      value: 0,
      style: "width: 100%; height: 14px"
    });
    modelStatus.append(modelStatusText, modelProgress);
    form.appendChild(modelStatus);

    const footer = create("footer", {
      style: "display: flex; justify-content: space-between; gap: 10px; align-items: center"
    });
    const footerLeft = create("div", { style: "display: flex; gap: 10px" });
    const footerRight = create("div", { style: "display: flex; gap: 10px" });
    const buttonStyle = "min-width: 92px; min-height: 32px; padding: 5px 14px; border: 1px solid color-mix(in srgb, CanvasText 28%, transparent); border-radius: 5px; background: ButtonFace; color: ButtonText; font: inherit";
    const updateModelsButton = create("button", {
      type: "button",
      style: buttonStyle
    }, "Update models");
    const summarizeButton = create("button", {
      type: "button",
      style: buttonStyle
    }, "Summarize");
    const cancelButton = create("button", {
      type: "button",
      style: buttonStyle
    }, "Cancel");
    const annotateButton = create("button", {
      type: "submit",
      style: buttonStyle + "; background: AccentColor; color: AccentColorText; border-color: AccentColor"
    }, "Annotate");
    footerLeft.append(updateModelsButton, summarizeButton);
    footerRight.append(cancelButton, annotateButton);
    footer.append(footerLeft, footerRight);
    form.appendChild(footer);
    panel.appendChild(form);
    overlay.appendChild(panel);
    doc.documentElement.appendChild(overlay);

    const readSettings = () => ({
      perPage: Number(inputs["per-page"].value),
      minimum: Number(inputs.minimum.value),
      maximum: Number(inputs.maximum.value),
      llmEmbeddings: checks["llm-embeddings"].checked,
      llmClassification: checks["llm-classification"].checked,
      classificationBatchSize: Number(inputs["classification-batch-size"].value),
      multilingual: checks.multilingual.checked,
      subspanHighlights: checks["subspan-highlights"].checked,
      remoteEndpoint: inputs["remote-endpoint"].value.trim(),
      remoteApiKey: inputs["remote-api-key"].value.trim(),
      remoteModel: inputs["remote-model"].value.trim()
    });

    const setBusy = busy => {
      updateModelsButton.disabled = busy;
      summarizeButton.disabled = busy;
      annotateButton.disabled = busy;
      cancelButton.disabled = busy;
      for (const input of Object.values(inputs)) input.disabled = busy;
      for (const check of Object.values(checks)) check.disabled = busy;
    };

    const formatBytes = value => {
      if (!Number.isFinite(value) || value <= 0) return "";
      if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
      if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
      return `${Math.round(value)} B`;
    };

    const updateModelProgress = event => {
      modelStatus.style.display = "block";
      let percentage = Number(event.progress);
      if (!Number.isFinite(percentage) && Number(event.total) > 0) {
        percentage = 100 * Number(event.loaded || 0) / Number(event.total);
      }
      percentage = Number.isFinite(percentage) ? Math.max(0, Math.min(100, percentage)) : 0;
      modelProgress.value = percentage;
      const file = event.file ? ` - ${String(event.file).split("/").pop()}` : "";
      const bytes = Number(event.total) > 0
        ? ` (${formatBytes(Number(event.loaded) || 0)} / ${formatBytes(Number(event.total))})`
        : ` (${Math.round(percentage)}%)`;
      if (["download", "progress", "initiate"].includes(event.stage)) {
        modelStatusText.textContent = `Downloading ${event.model || "model"}${file}${bytes}`;
      }
      else if (event.stage === "complete") {
        modelStatusText.textContent = event.inferenceAvailable === false
          ? "Model files downloaded. Safe baseline remains active; ONNX inference is disabled in-process to prevent Zotero crashes."
          : "Selected models are ready for offline use.";
        modelProgress.value = 100;
      }
      else {
        modelStatusText.textContent = `Loading ${event.model || "model"}${file}${bytes}`;
      }
    };

    return new Promise(resolve => {
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        window.removeEventListener("keydown", onKeyDown, true);
        overlay.remove();
        resolve(result);
      };

      const onKeyDown = event => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(null);
        }
      };
      window.addEventListener("keydown", onKeyDown, true);

      updateModelsButton.addEventListener("click", async () => {
        error.textContent = "";
        const settings = readSettings();
        if (!this.isValidSettings(settings)) {
          error.textContent = "Use valid density values before updating models.";
          return;
        }
        if (!settings.llmEmbeddings && !settings.llmClassification) {
          error.textContent = "Select at least one LLM stage to update.";
          return;
        }
        this.saveSettings(settings);
        setBusy(true);
        modelStatus.style.display = "block";
        modelStatusText.textContent = "Preparing model update…";
        modelProgress.value = 0;
        try {
          await FastKeySentenceModels.updateModels(settings, updateModelProgress, false);
          modelStatusText.textContent = FastKeySentenceModels.supportsInference?.()
            ? "Selected models are ready for offline use."
            : "Model files downloaded. Safe baseline remains active; ONNX inference is disabled in-process to prevent Zotero crashes.";
          modelProgress.value = 100;
        }
        catch (modelError) {
          modelStatusText.textContent = "Model update failed.";
          modelProgress.value = 0;
          error.textContent = modelError?.message || String(modelError);
          this.log(modelError?.stack || String(modelError));
        }
        finally {
          setBusy(false);
          updateModelsButton.focus();
        }
      });

      cancelButton.addEventListener("click", () => finish(null));

      summarizeButton.addEventListener("click", async () => {
        error.textContent = "";
        const settings = readSettings();
        if (!this.isValidSettings(settings)) {
          error.textContent = "Use valid density values before summarising.";
          return;
        }
        if (!settings.remoteApiKey) {
          error.textContent = "Set a remote API key to generate a summary.";
          return;
        }
        finish({ ...settings, action: "summarize" });
      });

      form.addEventListener("submit", event => {
        event.preventDefault();
        const settings = readSettings();
        if (!this.isValidSettings(settings)) {
          error.textContent = "Use a positive average, integer limits, minimum less than or equal to maximum, and maximum no greater than 500.";
          inputs["per-page"].focus();
          return;
        }
        finish(settings);
      });

      for (const input of Object.values(inputs)) {
        input.addEventListener("input", () => {
          error.textContent = "";
        });
      }

      window.requestAnimationFrame(() => inputs["per-page"].focus());
    });
  },

  async openAnnotationDialog(window) {
    const result = await this.showSettingsOverlay(window, this.getConfiguredSettings());
    if (!result) return;
    if (!this.isValidSettings(result)) throw new Error("Invalid annotation settings.");
    this.saveSettings(result);
    if (result.action === "summarize") {
      await this.summarizeForSelection(window, result);
      return;
    }
    await this.runForSelection(window, result);
  },

  async runForSelection(window, settings = null) {
    try {
      const selected = window.ZoteroPane.getSelectedItems();
      if (!selected.length) throw new Error("Select a Zotero item or PDF attachment first.");
      const attachments = [];
      for (const item of selected) {
        const attachment = await this.resolvePDFAttachment(item);
        if (attachment && !attachments.some(x => x.id === attachment.id)) attachments.push(attachment);
      }
      if (!attachments.length) throw new Error("No PDF attachment was found in the selection.");
      for (const attachment of attachments) {
        await this.annotateAttachment(attachment, window, settings);
      }
    }
    catch (error) {
      this.log(error.stack || String(error));
      Services.prompt.alert(window, "Fast Offline Key-Sentence Annotator", error.message || String(error));
    }
  },

  async summarizeForSelection(window, settings) {
    try {
      const selected = window.ZoteroPane.getSelectedItems();
      if (!selected.length) throw new Error("Select a Zotero item or PDF attachment first.");
      const attachments = [];
      for (const item of selected) {
        const attachment = await this.resolvePDFAttachment(item);
        if (attachment && !attachments.some(x => x.id === attachment.id)) attachments.push(attachment);
      }
      if (!attachments.length) throw new Error("No PDF attachment was found in the selection.");
      for (const attachment of attachments) {
        await this.summarizeAttachment(attachment, window, settings);
      }
    }
    catch (error) {
      this.log(error.stack || String(error));
      Services.prompt.alert(window, "Fast Offline Key-Sentence Annotator", error.message || String(error));
    }
  },

  async summarizeAttachment(attachment, window, settings) {
    const progress = new Zotero.ProgressWindow();
    progress.changeHeadline("Summarizing paper");
    const title = await this.getDocumentTitle(attachment);
    const line = new progress.ItemProgress("chrome://zotero/skin/treeitem-attachment-pdf.png", title);
    line.setProgress(5);
    progress.show();

    try {
      if (typeof Zotero.PDFWorker?.getRecognizerData !== "function") {
        throw new Error("This Zotero build does not expose a supported local PDF text-extraction API.");
      }

      line.setText("Extracting all PDF pages");
      const pages = await this.extractAllPages(attachment, progressValue => {
        const value = Number.isFinite(progressValue) ? progressValue : 0;
        line.setProgress(Math.max(5, Math.min(40, 5 + Math.round(value * 35))));
      });
      line.setProgress(40);
      line.setText(`Reconstructing sentences from ${pages.length} pages`);
      const sentences = this.buildSentences(pages);
      if (!sentences.length) throw new Error("No usable text was found. Run OCR first if this is a scanned PDF.");

      const documentTitle = await this.getDocumentTitle(attachment);
      // Filter out noise (authors, tables, figures, references) and abstract
      const bodySentences = sentences.filter(
        s => !FastKeySentenceNLP.isNoise(s) && s.section !== "abstract"
      );
      const inputText = FastKeySentenceNLP.paperTextForSummary(bodySentences, documentTitle);

      line.setProgress(45);
      line.setText("Generating summary via remote API…");

      const summary = await FastKeySentenceRemote.summarize(
        inputText,
        documentTitle,
        10,
        event => {
          if (["sending", "retrying"].includes(event.stage)) {
            line.setText(`Sending to remote API${event.attempt ? ` (retry ${event.attempt})` : ""}…`);
          }
          else if (event.stage === "done") {
            line.setProgress(100);
            line.setText("Summary ready");
          }
        }
      );

      if (!summary) throw new Error("The summarization model returned an empty result.");

      line.setProgress(100);
      line.setText("Summary ready");
      progress.startCloseTimer(1500);

      await this.showSummaryOverlay(window, summary, title);
    }
    catch (error) {
      const e = error || "";
      const msg = typeof e === "object" && e !== null ? (e.message || String(e)) : String(e);
      this.log(`Summarization failed: ${msg}`);
      if (typeof FastKeySentenceModels !== "undefined" && FastKeySentenceModels.appendToLog) {
        void FastKeySentenceModels.appendToLog(`summarization failed: ${msg}`);
      }
      line.setError();
      line.setText("Summarization failed");
      progress.startCloseTimer(8000);
      throw error;
    }
  },

  showSummaryOverlay(window, summary, title) {
    const doc = window.document;
    const HTML_NS = "http://www.w3.org/1999/xhtml";
    const existing = doc.getElementById("fast-key-sentence-annotator-summary-overlay");
    existing?.remove();

    const create = (tag, attrs = {}, text = null) => {
      const element = doc.createElementNS(HTML_NS, tag);
      for (const [name, value] of Object.entries(attrs)) {
        if (name === "style") {
          element.style.cssText = value;
        }
        else if (name === "className") {
          element.className = value;
        }
        else if (name in element && !name.startsWith("aria-")) {
          try {
            element[name] = value;
          }
          catch (_) {
            element.setAttribute(name, String(value));
          }
        }
        else {
          element.setAttribute(name, String(value));
        }
      }
      if (text !== null) element.textContent = text;
      return element;
    };

    const overlay = create("div", {
      id: "fast-key-sentence-annotator-summary-overlay",
      role: "presentation",
      style: [
        "position: fixed",
        "inset: 0",
        "z-index: 2147483647",
        "display: flex",
        "align-items: center",
        "justify-content: center",
        "padding: 24px",
        "background: rgba(0, 0, 0, 0.42)",
        "font: message-box"
      ].join(";")
    });

    const panel = create("section", {
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "fast-key-sentence-annotator-summary-title",
      style: [
        "width: min(800px, calc(100vw - 48px))",
        "max-height: calc(100vh - 48px)",
        "overflow: auto",
        "padding: 22px",
        "border: 1px solid color-mix(in srgb, CanvasText 25%, transparent)",
        "border-radius: 10px",
        "box-shadow: 0 18px 60px rgba(0, 0, 0, 0.35)",
        "background: Canvas",
        "color: CanvasText"
      ].join(";")
    });

    const heading = create("h1", {
      id: "fast-key-sentence-annotator-summary-title",
      style: "margin: 0 0 6px; font-size: 1.25rem; font-weight: 600"
    }, "Paper summary");
    panel.appendChild(heading);

    const subtitle = create("div", {
      style: "margin: 0 0 16px; opacity: 0.7; font-size: 0.92rem"
    }, title);
    panel.appendChild(subtitle);

    const body = create("div", {
      style: [
        "margin: 0 0 18px",
        "padding: 14px 16px",
        "border: 1px solid color-mix(in srgb, CanvasText 18%, transparent)",
        "border-radius: 7px",
        "background: color-mix(in srgb, Canvas 96%, AccentColor 4%)",
        "line-height: 1.6",
        "white-space: pre-wrap",
        "max-height: 72vh",
        "overflow: auto"
      ].join(";")
    }, summary);
    panel.appendChild(body);

    const footer = create("footer", {
      style: "display: flex; justify-content: flex-end; gap: 10px"
    });
    const closeButton = create("button", {
      type: "button",
      style: "min-width: 92px; min-height: 32px; padding: 5px 14px; border: 1px solid color-mix(in srgb, CanvasText 28%, transparent); border-radius: 5px; background: AccentColor; color: AccentColorText; border-color: AccentColor; font: inherit"
    }, "Close");
    footer.appendChild(closeButton);
    panel.appendChild(footer);
    overlay.appendChild(panel);
    doc.documentElement.appendChild(overlay);

    return new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.removeEventListener("keydown", onKeyDown, true);
        overlay.remove();
        resolve();
      };

      const onKeyDown = event => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish();
        }
      };
      window.addEventListener("keydown", onKeyDown, true);

      closeButton.addEventListener("click", () => finish());
      closeButton.focus();
    });
  },

  async resolvePDFAttachment(item) {
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

  modelProgressHandler(line, settings) {
    const enabled = [
      settings.llmEmbeddings && "embeddings",
      settings.llmClassification && "classification"
    ].filter(Boolean);
    const ranges = new Map();
    const width = enabled.length ? 25 / enabled.length : 25;
    enabled.forEach((operation, index) => {
      ranges.set(operation, [45 + index * width, 45 + (index + 1) * width]);
    });
    const names = {
      summarization: "Remote summarization",
      embeddings: "LLM embeddings",
      classification: "LLM classification"
    };
    const filesByOperation = new Map();

    const formatBytes = value => {
      if (!Number.isFinite(value) || value <= 0) return "";
      if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
      if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
      return `${Math.round(value)} B`;
    };

    return event => {
      const operation = event.operation || enabled[0] || "embeddings";
      const [start, end] = ranges.get(operation) || [45, 70];
      let percentage = Number(event.progress);
      let loaded = Number(event.loaded) || 0;
      let total = Number(event.total) || 0;

      if (event.file && total > 0) {
        if (!filesByOperation.has(operation)) filesByOperation.set(operation, new Map());
        const files = filesByOperation.get(operation);
        files.set(event.file, { loaded: Math.min(loaded, total), total });
        loaded = [...files.values()].reduce((sum, file) => sum + file.loaded, 0);
        total = [...files.values()].reduce((sum, file) => sum + file.total, 0);
        percentage = total ? 100 * loaded / total : percentage;
      }
      else if (!Number.isFinite(percentage) && total > 0) {
        percentage = 100 * loaded / total;
      }
      if (!Number.isFinite(percentage)) percentage = 0;
      percentage = Math.max(0, Math.min(100, percentage));
      if (operation === "summarization") {
        line.setProgress(Math.round(5 + (event.stage === "done" ? 25 : 15 + percentage * 0.1)));
      }
      else {
        line.setProgress(Math.round(start + (end - start) * percentage / 100));
      }

      const label = names[operation] || "Transformer model";
      if (["download", "progress", "initiate"].includes(event.stage)) {
        const file = event.file ? ` - ${String(event.file).split("/").pop()}` : "";
        const byteText = total > 0 ? ` (${formatBytes(loaded)} / ${formatBytes(total)})` : ` (${Math.round(percentage)}%)`;
        line.setText(`${label}: downloading ${event.model || "model"}${file}${byteText}`);
      }
      else if (event.stage === "sending" || event.stage === "retrying") {
        line.setText(`${label}: sending request to API${event.attempt ? ` (retry ${event.attempt})` : ""}…`);
      }
      else if (event.stage === "done") {
        line.setText(`${label}: complete`);
      }
      else if (event.stage === "inference") {
        line.setText(`${label}: analysing sentences (${Math.round(percentage)}%)`);
      }
      else {
        line.setText(`${label}: loading ${event.model || "model"}`);
      }
    };
  },

  async annotateAttachment(attachment, window = null, settings = null) {
    const progress = new Zotero.ProgressWindow();
    progress.changeHeadline("Zotero-skimming");
    const title = attachment.getField("title") || attachment.attachmentFilename || "PDF";
    const line = new progress.ItemProgress("chrome://zotero/skin/treeitem-attachment-pdf.png", title);
    line.setProgress(5);
    progress.show();

    try {
      if (typeof Zotero.PDFWorker?.getStructuredDocumentText !== "function"
          && typeof Zotero.PDFWorker?.getRecognizerData !== "function") {
        throw new Error("This Zotero build does not expose a supported local PDF text-extraction API.");
      }
      if (typeof Zotero.Annotations?.saveFromJSON !== "function") {
        throw new Error("This Zotero build does not expose the required annotation API.");
      }

      const existingAutoAnnotations = attachment.getAnnotations()
        .filter(item => item.getTags().some(tag => tag.tag === "auto-key-sentence"));
      if (existingAutoAnnotations.length) {
        throw new Error(`This PDF already contains ${existingAutoAnnotations.length} automatic key-sentence annotation(s). Remove them before running the annotator again.`);
      }

      line.setText("Extracting all PDF pages");
      const pages = await this.extractAllPages(attachment, progressValue => {
        const value = Number.isFinite(progressValue) ? progressValue : 0;
        line.setProgress(Math.max(5, Math.min(30, 5 + Math.round(value * 25))));
      });
      line.setProgress(30);
      line.setText(`Reconstructing sentences from ${pages.length} pages`);
      const sentences = this.buildSentences(pages);
      if (!sentences.length) throw new Error("No usable text was found. Run OCR first if this is a scanned PDF.");

      const configuredSettings = settings && this.isValidSettings(settings)
        ? settings
        : this.getConfiguredSettings();
      // Base density on pages that still contain usable prose after front matter,
      // tables, references, and back matter have been excluded. This prevents a
      // long bibliography from inflating the number of highlights in the article.
      const eligiblePages = new Set(
        sentences.filter(sentence => !sentence.frontMatter).map(sentence => sentence.pageIndex)
      ).size || pages.length;
      const count = this.calculateAnnotationTarget(eligiblePages, configuredSettings);
      const enabledStages = [
        configuredSettings.llmEmbeddings && "embeddings",
        configuredSettings.llmClassification && "classification"
      ].filter(Boolean);
      line.setProgress(45);
      line.setText(
        `Ranking sentences (target: ${count}; ${configuredSettings.perPage}/eligible page, `
          + `min ${configuredSettings.minimum}, max ${configuredSettings.maximum}`
          + `${enabledStages.length ? `; LLM: ${enabledStages.join(", ")}` : "; fast mode"})`
      );
      const documentTitle = await this.getDocumentTitle(attachment);
      const selected = await FastKeySentenceNLP.analyzeAsync(sentences, count, {
        llmEmbeddings: configuredSettings.llmEmbeddings,
        llmClassification: configuredSettings.llmClassification,
        classificationBatchSize: configuredSettings.classificationBatchSize,
        multilingual: configuredSettings.multilingual,
        documentTitle,
        onModelProgress: this.modelProgressHandler(line, configuredSettings)
      });
      if (!selected.length) throw new Error("No suitable annotation candidates were found.");

      // Refine: build sliding windows for selected sentences and keep windows
      // that are more similar to the summary than the full sentence.
      if (configuredSettings.subspanHighlights !== false) {
        await this.refineSelectedWindows(selected, configuredSettings);
      }

      line.setProgress(70);
      line.setText("Creating Zotero highlights");
      let created = 0;
      const notifierQueue = new Zotero.Notifier.Queue();
      try {
        for (const sentence of selected) {
          const annotation = this.makeAnnotation(sentence);
          await Zotero.Annotations.saveFromJSON(attachment, annotation, { notifierQueue });
          created++;
        }
      }
      finally {
        await Zotero.Notifier.commit(notifierQueue);
      }
      line.setProgress(100);
      line.setText(`Created ${created} native highlights`);
      progress.startCloseTimer(3000);
    }
    catch (error) {
      const e = error || "";
      const msg = typeof e === "object" && e !== null ? (e.message || String(e)) : String(e);
      const stack = typeof e === "object" && e !== null ? e.stack : "";
      const detail = `${msg} (type: ${typeof e})${stack ? `\n${stack}` : ""}`;
      Zotero.debug(`FastOfflineKeySentenceAnnotator annotation failed: ${detail}`);
      if (typeof FastKeySentenceModels !== "undefined" && FastKeySentenceModels.appendToLog) {
        void FastKeySentenceModels.appendToLog(`annotation failed: ${detail}`);
      }
      line.setError();
      line.setText("Annotation failed");
      progress.startCloseTimer(8000);
      throw error;
    }
  },

  async extractAllPages(attachment, onProgress) {
    // Zotero 9.0.6 exposes getRecognizerData(), but that method deliberately
    // extracts only the first five pages. To obtain positioned text for every
    // page, process the original PDF in five-page in-memory chunks. Each chunk
    // is reduced to at most five pages with the bundled Zotero PDF worker and
    // then passed to getRecognizerData(). No file on disk is modified.
    const first = await Zotero.PDFWorker.getRecognizerData(attachment.id, true);
    const totalPages = Math.max(0, Number(first?.totalPages) || first?.pages?.length || 0);
    if (!totalPages) throw new Error("Zotero's PDF worker reported zero pages.");

    const allPages = [];
    const appendChunk = (data, originalStart) => {
      const chunkPages = this.extractPages(data);
      for (let i = 0; i < chunkPages.length; i++) {
        chunkPages[i].pageIndex = originalStart + i;
        allPages.push(chunkPages[i]);
      }
    };

    appendChunk(first, 0);
    onProgress?.(Math.min(1, Math.min(5, totalPages) / totalPages));
    if (totalPages <= 5) return this.cleanRepeatedMargins(allPages);

    if (typeof Zotero.PDFWorker?._query !== "function"
        || typeof Zotero.PDFWorker?._enqueue !== "function") {
      throw new Error("This Zotero build does not expose the internal PDF-worker calls required for all-page positioned extraction.");
    }

    const path = await attachment.getFilePathAsync();
    if (!path) throw new Error("The PDF file is missing locally.");
    const originalBytes = new Uint8Array(await IOUtils.read(path));

    for (let startPage = 5; startPage < totalPages; startPage += 5) {
      const endPage = Math.min(totalPages, startPage + 5);
      const keep = new Set(Array.from({ length: endPage - startPage }, (_, i) => startPage + i));
      const deleteIndexes = [];
      for (let i = totalPages - 1; i >= 0; i--) {
        if (!keep.has(i)) deleteIndexes.push(i);
      }

      // A transferred ArrayBuffer is detached, so allocate an independent copy
      // for every chunk.
      let chunkBuffer = originalBytes.slice().buffer;
      const chunkData = await Zotero.PDFWorker._enqueue(async () => {
        const deleted = await Zotero.PDFWorker._query(
          "deletePages",
          { buf: chunkBuffer, pageIndexes: deleteIndexes },
          [chunkBuffer]
        );
        let reducedBuffer = deleted.buf;
        return Zotero.PDFWorker._query(
          "getRecognizerData",
          { buf: reducedBuffer },
          [reducedBuffer]
        );
      }, true);

      appendChunk(chunkData, startPage);
      onProgress?.(endPage / totalPages);
      // Yield briefly so long documents do not monopolize Zotero's main thread.
      await Zotero.Promise.delay(0);
    }

    allPages.sort((a, b) => a.pageIndex - b.pageIndex);
    this.log(`Positioned extractor returned ${allPages.length}/${totalPages} page(s)`);
    return this.cleanRepeatedMargins(allPages);
  },

  extractStructuredPages(data) {
    if (!data) return [];
    if (typeof data === "string") {
      try { data = JSON.parse(data); }
      catch (_) { return []; }
    }

    const pages = new Map();
    const seen = new Set();
    const ensurePage = (pageIndex, width = 612, height = 792) => {
      pageIndex = Math.max(0, Number(pageIndex) || 0);
      if (!pages.has(pageIndex)) pages.set(pageIndex, { pageIndex, width, height, words: [] });
      const page = pages.get(pageIndex);
      if (Number(width) > 0) page.width = Number(width);
      if (Number(height) > 0) page.height = Number(height);
      return page;
    };

    const pageSizes = data.pageSizes || data.pages || data.metadata?.pageSizes;
    if (Array.isArray(pageSizes)) {
      pageSizes.forEach((entry, index) => {
        if (Array.isArray(entry)) ensurePage(index, entry[0], entry[1]);
        else if (entry && typeof entry === "object") ensurePage(
          entry.pageIndex ?? index,
          entry.width ?? entry.size?.[0],
          entry.height ?? entry.size?.[1]
        );
      });
    }

    const normalizeRect = (rect, pageHeight) => {
      if (!Array.isArray(rect) || rect.length < 4 || !rect.slice(0, 4).every(Number.isFinite)) return null;
      let [x1, y1, x2, y2] = rect.slice(0, 4).map(Number);
      if (x2 < x1) [x1, x2] = [x2, x1];
      if (y2 < y1) [y1, y2] = [y2, y1];
      // Structured-document-text PDF anchors normally use Zotero coordinates.
      // If coordinates clearly look top-origin, convert them conservatively.
      if (pageHeight && y2 > pageHeight * 1.02) return null;
      return [x1, y1, x2, y2];
    };

    const geometryFrom = (node, inherited = null) => {
      if (!node || typeof node !== "object") return inherited;
      const candidates = [node.position, node.anchor, node.pdfAnchor, node.region, node];
      for (const c of candidates) {
        if (!c || typeof c !== "object") continue;
        const pageIndex = c.pageIndex ?? c.page ?? c.pageNumber;
        let rects = c.rects || c.rectangles || c.boxes;
        if (!rects && Array.isArray(c.rect)) rects = [c.rect];
        if (pageIndex != null && Array.isArray(rects)) {
          return { pageIndex: Number(pageIndex), rects, width: c.pageWidth, height: c.pageHeight };
        }
      }
      return inherited;
    };

    const addText = (text, geometry) => {
      text = FastKeySentenceNLP.normalizeText(text);
      if (!text || !geometry || geometry.pageIndex == null) return;
      const page = ensurePage(geometry.pageIndex, geometry.width, geometry.height);
      const rects = geometry.rects.map(r => normalizeRect(r, page.height)).filter(Boolean);
      if (!rects.length) return;
      const key = `${page.pageIndex}|${text}|${rects.map(r => r.map(x => x.toFixed(2)).join(",")).join(";")}`;
      if (seen.has(key)) return;
      seen.add(key);

      // Keep text fragments with their source rectangles. For paragraph-level
      // anchors, distribute tokens over rectangles so sentence mapping remains local.
      const tokens = text.split(/\s+/).filter(Boolean);
      if (tokens.length === 1 || rects.length === 1) {
        page.words.push(...this.splitFragment(text, rects[0], rects[0][3]));
        return;
      }
      let offset = 0;
      const perRect = Math.max(1, Math.ceil(tokens.length / rects.length));
      for (let i = 0; i < rects.length && offset < tokens.length; i++) {
        const chunk = tokens.slice(offset, offset + perRect).join(" ");
        offset += perRect;
        if (chunk) page.words.push(...this.splitFragment(chunk, rects[i], rects[i][3]));
      }
    };

    const walk = (node, inheritedGeometry = null) => {
      if (node == null) return;
      if (typeof node === "string") {
        addText(node, inheritedGeometry);
        return;
      }
      if (Array.isArray(node)) {
        for (const child of node) walk(child, inheritedGeometry);
        return;
      }
      if (typeof node !== "object") return;
      const geometry = geometryFrom(node, inheritedGeometry);
      const directText = typeof node.text === "string" ? node.text
        : typeof node.value === "string" ? node.value
        : typeof node.str === "string" ? node.str
        : null;
      if (directText) addText(directText, geometry);
      for (const [key, value] of Object.entries(node)) {
        if (["text", "value", "str", "position", "anchor", "pdfAnchor", "region", "rects", "rectangles", "boxes", "rect"].includes(key)) continue;
        if (value && (typeof value === "object" || Array.isArray(value))) walk(value, geometry);
      }
    };
    walk(data, null);

    return [...pages.values()].sort((a, b) => a.pageIndex - b.pageIndex).map(page => {
      page.words = this.sortWordsReadingOrder(page.words, page.width, page.height);
      return page;
    });
  },

  sortWordsReadingOrder(words, pageWidth, pageHeight) {
    if (!words.length) return words;
    // Cluster by lines, then infer one or two broad columns. This is more stable
    // than trusting raw PDF object order, which PDF.js explicitly does not guarantee.
    const lineTolerance = Math.max(2.5, pageHeight * 0.004);
    const lines = [];
    for (const word of words.slice().sort((a, b) => b.rect[3] - a.rect[3] || a.rect[0] - b.rect[0])) {
      const cy = (word.rect[1] + word.rect[3]) / 2;
      let line = lines.find(l => Math.abs(l.cy - cy) <= lineTolerance);
      if (!line) { line = { cy, words: [] }; lines.push(line); }
      line.words.push(word);
    }
    lines.forEach(line => line.words.sort((a, b) => a.rect[0] - b.rect[0]));
    const mids = lines.map(l => Math.min(...l.words.map(w => w.rect[0])));
    const leftCount = mids.filter(x => x < pageWidth * 0.42).length;
    const rightCount = mids.filter(x => x > pageWidth * 0.50).length;
    const twoColumns = leftCount >= 4 && rightCount >= 4;
    if (!twoColumns) return lines.sort((a, b) => b.cy - a.cy).flatMap(l => l.words);
    const left = lines.filter(l => Math.min(...l.words.map(w => w.rect[0])) < pageWidth * 0.48);
    const right = lines.filter(l => Math.min(...l.words.map(w => w.rect[0])) >= pageWidth * 0.48);
    return left.sort((a, b) => b.cy - a.cy).concat(right.sort((a, b) => b.cy - a.cy)).flatMap(l => l.words);
  },

  splitFragment(text, rect, top = null) {
    text = FastKeySentenceNLP.normalizeText(text);
    if (!text || !Array.isArray(rect) || rect.length < 4) return [];
    const parts = text.match(/\S+/g) || [];
    if (parts.length <= 1) return [{ text, rect, top: top ?? rect[3] }];

    const totalUnits = parts.reduce((sum, part) => sum + Math.max(1, part.length), 0)
      + Math.max(0, parts.length - 1) * 0.55;
    const width = Math.max(0.1, rect[2] - rect[0]);
    let cursor = rect[0];
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      const units = Math.max(1, parts[i].length);
      const tokenWidth = width * units / totalUnits;
      const right = i === parts.length - 1 ? rect[2] : Math.min(rect[2], cursor + tokenWidth);
      out.push({ text: parts[i], rect: [cursor, rect[1], right, rect[3]], top: top ?? rect[3] });
      cursor = right + width * 0.55 / totalUnits;
    }
    return out;
  },

  buildLines(page) {
    const words = page.words.slice().sort((a, b) => b.rect[3] - a.rect[3] || a.rect[0] - b.rect[0]);
    const lines = [];
    for (const word of words) {
      const cy = (word.rect[1] + word.rect[3]) / 2;
      const h = Math.max(1, word.rect[3] - word.rect[1]);
      let best = null;
      let bestDistance = Infinity;
      for (const line of lines) {
        const tolerance = Math.max(2.2, Math.min(h, line.height) * 0.48);
        const distance = Math.abs(line.cy - cy);
        if (distance <= tolerance && distance < bestDistance) {
          best = line;
          bestDistance = distance;
        }
      }
      if (!best) {
        best = { cy, height: h, words: [] };
        lines.push(best);
      }
      best.words.push(word);
      best.cy = best.words.reduce((sum, w) => sum + (w.rect[1] + w.rect[3]) / 2, 0) / best.words.length;
      best.height = best.words.reduce((sum, w) => sum + (w.rect[3] - w.rect[1]), 0) / best.words.length;
    }
    for (const line of lines) {
      line.words.sort((a, b) => a.rect[0] - b.rect[0]);
      line.left = Math.min(...line.words.map(w => w.rect[0]));
      line.right = Math.max(...line.words.map(w => w.rect[2]));
      line.top = Math.max(...line.words.map(w => w.rect[3]));
      line.bottom = Math.min(...line.words.map(w => w.rect[1]));
      line.text = this.joinTokens(line.words.map(w => w.text));
    }
    return lines.sort((a, b) => b.cy - a.cy || a.left - b.left);
  },

  joinTokens(tokens) {
    let text = "";
    for (const token of tokens) {
      if (!token) continue;
      const noSpaceBefore = /^[,.;:!?%\)\]\}]/.test(token);
      const noSpaceAfterPrevious = /[\(\[\{\/$]$/.test(text);
      if (text && !noSpaceBefore && !noSpaceAfterPrevious) text += " ";
      text += token;
    }
    return text;
  },

  isFrontMatterLine(line, page) {
    if (page.pageIndex !== 0) return false;
    const text = FastKeySentenceNLP.normalizeText(line.text);
    if (!text) return true;
    if (/^(abstract|introduction)\b/i.test(text)) return false;
    if (/\b(doi|https?:\/\/|www\.|received|accepted|published|publisher|copyright|creative commons|citation:)\b/i.test(text)) return true;
    if (/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/.test(text)) return true;
    if (/^(article|research article|original article|algorithms?)$/i.test(text)) return true;
    if (/^\s*[©\u00a9]|all rights reserved/i.test(text)) return true;
    return false;
  },

  isBackMatterLine(text) {
    const s = FastKeySentenceNLP.normalizeText(text);
    return /^(?:author contributions?|funding|institutional review board statement|informed consent statement|data availability statement|acknowledg(?:e)?ments?|conflicts? of interest|abbreviations?)\s*[:.]?/i.test(s);
  },

  isTableCaptionLine(line) {
    const text = FastKeySentenceNLP.normalizeText(line?.text);
    return /^(?:table|tab\.)\s+(?:[A-Z][.-]?\s*)?(?:\d+(?:\.\d+)*|[IVXLC]+)\b/i.test(text);
  },

  tableLineProfile(line, page) {
    const words = line.words || [];
    const threshold = Math.max(8, page.width * 0.018, line.height * 1.8);
    const gaps = [];
    const cellStarts = words.length ? [words[0].rect[0]] : [];
    for (let i = 1; i < words.length; i++) {
      const gap = words[i].rect[0] - words[i - 1].rect[2];
      gaps.push(gap);
      if (gap > threshold) cellStarts.push(words[i].rect[0]);
    }

    const tokens = words.map(word => FastKeySentenceNLP.normalizeText(word.text)).filter(Boolean);
    const numeric = tokens.filter(token => /^(?:[<>~=+-]?\d[\d.,:%()*/-]*|n\/?a|nan|yes|no)$/i.test(token)).length;
    const short = tokens.filter(token => token.length <= 5).length;
    const numericRatio = numeric / Math.max(1, tokens.length);
    const shortRatio = short / Math.max(1, tokens.length);
    const cellCount = cellStarts.length;
    const sentenceLike = /[.!?]["')\]}]?$/.test(line.text)
      && /\b(?:is|are|was|were|has|have|shows?|indicates?|suggests?|we|this|the)\b/i.test(line.text);

    const tableLike = !sentenceLike && (
      cellCount >= 4
      || (cellCount >= 3 && (numericRatio >= 0.10 || shortRatio >= 0.45))
      || (cellCount >= 2 && numericRatio >= 0.38 && tokens.length >= 4)
    );
    return { threshold, gaps, cellStarts, cellCount, numericRatio, shortRatio, sentenceLike, tokenCount: tokens.length, tableLike };
  },

  detectTableLineIndexes(lines, page) {
    const marked = new Set();
    if (!lines.length) return marked;
    const profiles = lines.map(line => this.tableLineProfile(line, page));
    const captions = lines.map((line, index) => this.isTableCaptionLine(line) ? index : -1).filter(index => index >= 0);
    for (const index of captions) marked.add(index);

    const aligned = (a, b) => {
      if (a.cellCount < 3 || b.cellCount < 3) return false;
      const tolerance = Math.max(9, page.width * 0.016);
      let matches = 0;
      for (const x of a.cellStarts) {
        if (b.cellStarts.some(y => Math.abs(x - y) <= tolerance)) matches++;
      }
      return matches >= Math.min(3, a.cellCount, b.cellCount);
    };

    // Require either consecutive table-like rows or repeated aligned columns.
    for (let i = 0; i < lines.length; i++) {
      const previous = i > 0 ? profiles[i - 1] : null;
      const next = i + 1 < lines.length ? profiles[i + 1] : null;
      if (profiles[i].tableLike && (
        previous?.tableLike || next?.tableLike ||
        (previous && aligned(profiles[i], previous)) ||
        (next && aligned(profiles[i], next))
      )) {
        marked.add(i);
        if (previous?.tableLike || (previous && aligned(profiles[i], previous))) marked.add(i - 1);
        if (next?.tableLike || (next && aligned(profiles[i], next))) marked.add(i + 1);
      }
    }

    // Compact two-column tables often lack numeric cells. Detect three or more
    // consecutive rows with aligned cell starts while rejecting normal prose columns.
    for (let i = 0; i + 2 < lines.length; i++) {
      const block = profiles.slice(i, i + 3);
      const tolerance = Math.max(9, page.width * 0.016);
      const alignedPairs = block.every(profile => profile.cellCount >= 2)
        && block.slice(1).every(profile =>
          block[0].cellStarts.slice(0, 2).every(x => profile.cellStarts.some(y => Math.abs(x - y) <= tolerance))
        );
      const compact = block.every(profile => profile.tokenCount <= 20 && !profile.sentenceLike);
      const cellLike = block.reduce((sum, profile) => sum + profile.shortRatio + profile.numericRatio, 0) / block.length >= 0.48;
      if (alignedPairs && compact && cellLike) {
        marked.add(i);
        marked.add(i + 1);
        marked.add(i + 2);
      }
    }

    // A caption anchors a nearby table. Once geometric evidence is found, protect
    // the complete vertical interval, including wrapped cell text and caption lines.
    for (const caption of captions) {
      const lowerBound = caption + 1;
      const upperBound = Math.min(lines.length, caption + 32);
      const belowEvidence = [];
      for (let i = lowerBound; i < upperBound; i++) {
        if (profiles[i].tableLike || marked.has(i)) belowEvidence.push(i);
      }
      if (belowEvidence.length) {
        const lastEvidence = Math.max(...belowEvidence);
        for (let i = caption; i <= lastEvidence; i++) marked.add(i);
        for (let i = lastEvidence + 1; i < Math.min(lines.length, lastEvidence + 5); i++) {
          const continuation = lines[i].words.length <= 18
            && !/[.!?]["')\]}]?$/.test(lines[i].text);
          if (!continuation) break;
          marked.add(i);
        }
      }

      const aboveStart = Math.max(0, caption - 32);
      const aboveEvidence = [];
      for (let i = aboveStart; i < caption; i++) {
        if (profiles[i].tableLike || marked.has(i)) aboveEvidence.push(i);
      }
      if (aboveEvidence.length) {
        const firstEvidence = Math.min(...aboveEvidence);
        for (let i = firstEvidence; i <= caption; i++) marked.add(i);
      }
    }

    // Include compact header/footer rows immediately adjacent to a detected block.
    for (const index of [...marked]) {
      for (const neighbor of [index - 1, index + 1]) {
        if (neighbor < 0 || neighbor >= lines.length || marked.has(neighbor)) continue;
        const compact = lines[neighbor].words.length <= 12
          && !/[.!?]["')\]}]?$/.test(lines[neighbor].text)
          && profiles[neighbor].cellCount >= 2;
        if (compact) marked.add(neighbor);
      }
    }
    return marked;
  },

  isLikelyReferencePage(lines) {
    const content = lines
      .map(line => FastKeySentenceNLP.normalizeText(line.text))
      .filter(text => text && !/^(?:references|bibliography|works cited|literature cited|reference list)$/i.test(text));
    if (content.length < 6) return false;
    const referenceHits = content.filter(text => FastKeySentenceNLP.isReferenceEntry(text)).length;
    const yearHeavy = content.filter(text => /\b(?:18|19|20)\d{2}[a-z]?\b/.test(text)).length;
    return referenceHits >= 4
      && (referenceHits / content.length >= 0.28 || yearHeavy / content.length >= 0.45);
  },

  cleanRepeatedMargins(pages) {
    if (pages.length < 4) return pages;
    const counts = new Map();
    const signaturesByPage = new Map();
    for (const page of pages) {
      const sigs = [];
      for (const word of page.words) {
        const nearMargin = word.rect[3] > page.height * 0.92 || word.rect[1] < page.height * 0.08;
        if (!nearMargin) continue;
        const sig = FastKeySentenceNLP.normalizeText(word.text).toLowerCase().replace(/\d+/g, "#");
        if (sig.length >= 4) { sigs.push(sig); counts.set(sig, (counts.get(sig) || 0) + 1); }
      }
      signaturesByPage.set(page.pageIndex, new Set(sigs));
    }
    const threshold = Math.max(3, Math.ceil(pages.length * 0.35));
    for (const page of pages) {
      page.words = page.words.filter(word => {
        const nearMargin = word.rect[3] > page.height * 0.92 || word.rect[1] < page.height * 0.08;
        if (!nearMargin) return true;
        const sig = FastKeySentenceNLP.normalizeText(word.text).toLowerCase().replace(/\d+/g, "#");
        return (counts.get(sig) || 0) < threshold;
      });
    }
    return pages;
  },

  extractPages(data) {
    if (!data || !Array.isArray(data.pages)) throw new Error("Zotero's document worker returned no page structure.");
    return data.pages.map((page, pageIndex) => {
      const width = Number(page?.[0]) || 612;
      const height = Number(page?.[1]) || 792;
      const words = [];
      const visit = node => {
        if (!Array.isArray(node)) return;
        if (node.length >= 5 && node.slice(0, 4).every(Number.isFinite) && typeof node[node.length - 1] === "string") {
          const text = FastKeySentenceNLP.normalizeText(node[node.length - 1]);
          if (text) {
            const [x1, y1, x2, y2] = node;
            words.push(...this.splitFragment(text, [x1, height - y2, x2, height - y1], y1));
          }
          return;
        }
        for (const child of node) visit(child);
      };
      visit(page.slice(2));
      return { pageIndex, width, height, words };
    });
  },

  buildSentences(pages) {
    const sentences = [];
    let order = 0;
    let currentSection = "";
    let pendingSectionStart = false;
    let frontMatterEnded = false;
    let inReferences = false;
    let inBackMatter = false;

    for (const page of pages) {
      const lines = this.buildLines(page);
      if (!lines.length) continue;

      // Recover from a references section only when a later explicit section begins,
      // such as an appendix or supplementary material.
      const openingHeadings = lines.slice(0, 8)
        .map(line => FastKeySentenceNLP.detectHeading(line.text))
        .filter(Boolean);
      if (inReferences && openingHeadings.some(heading => !FastKeySentenceNLP.isReferenceHeading(heading))) {
        inReferences = false;
      }
      if (!inReferences && this.isLikelyReferencePage(lines)) inReferences = true;
      if (inReferences && !openingHeadings.some(heading => !FastKeySentenceNLP.isReferenceHeading(heading))) {
        continue;
      }

      const tableLines = this.detectTableLineIndexes(lines, page);
      let text = "";
      let pageWords = [];
      let previousLine = null;
      let bufferSection = currentSection;
      let bufferSectionStart = pendingSectionStart;

      const resetBuffer = () => {
        text = "";
        pageWords = [];
        bufferSection = currentSection;
        bufferSectionStart = pendingSectionStart;
      };

      const flushBuffer = () => {
        if (!text.trim()) {
          resetBuffer();
          return;
        }
        let firstCreated = true;
        for (const [start, end] of FastKeySentenceNLP.sentenceRanges(text)) {
          const sentenceText = FastKeySentenceNLP.normalizeText(text.slice(start, end));
          if (!sentenceText) continue;
          const hitWords = pageWords.filter(span => span.end > start && span.start < end);
          if (!hitWords.length) continue;
          const rects = this.mergeRects(hitWords.map(word => word.rect));
          if (!rects.length) continue;
          sentences.push({
            text: sentenceText,
            pageIndex: page.pageIndex,
            pageHeight: page.height,
            rects,
            section: bufferSection,
            sectionStart: firstCreated && bufferSectionStart,
            frontMatter: hitWords.every(word => word.frontMatter),
            inTable: false,
            reference: false,
            order: order++
          });
          if (firstCreated && bufferSectionStart) pendingSectionStart = false;
          firstCreated = false;
        }
        resetBuffer();
      };

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        const rawLine = FastKeySentenceNLP.normalizeText(line.text);
        if (!rawLine) continue;

        const heading = FastKeySentenceNLP.detectHeading(rawLine);
        if (heading && rawLine.split(/\s+/).length <= 12) {
          flushBuffer();
          currentSection = heading;
          previousLine = null;
          if (FastKeySentenceNLP.isReferenceHeading(heading)) {
            inReferences = true;
            pendingSectionStart = false;
            continue;
          }
          inReferences = false;
          inBackMatter = false;
          pendingSectionStart = true;
          frontMatterEnded = true;
          resetBuffer();
          continue;
        }

        let lineText = rawLine;
        const inlineHeading = lineText.match(/^\s*(abstract|introduction|background|related work|methods?|methodology|materials? and methods?|datasets?|workflow|architecture|experiments?|results?|discussion|limitations?|conclusions?|future work|references|bibliography|works cited|literature cited|reference list|appendix|supplementary material)\s*[:.—-]\s*(.+)$/i);
        if (inlineHeading) {
          flushBuffer();
          currentSection = FastKeySentenceNLP.detectHeading(inlineHeading[1]) || inlineHeading[1].toLowerCase();
          previousLine = null;
          if (FastKeySentenceNLP.isReferenceHeading(currentSection)) {
            inReferences = true;
            pendingSectionStart = false;
            continue;
          }
          inReferences = false;
          inBackMatter = false;
          pendingSectionStart = true;
          frontMatterEnded = true;
          lineText = inlineHeading[2];
          resetBuffer();
        }

        if (this.isBackMatterLine(lineText)) {
          flushBuffer();
          inBackMatter = true;
          previousLine = null;
          continue;
        }

        if (inReferences || inBackMatter) {
          flushBuffer();
          previousLine = null;
          continue;
        }

        if (tableLines.has(lineIndex)) {
          flushBuffer();
          previousLine = null;
          continue;
        }

        const metadata = this.isFrontMatterLine({ ...line, text: lineText }, page);
        const isFrontMatter = page.pageIndex === 0 && !frontMatterEnded && !currentSection;
        if (metadata) {
          flushBuffer();
          previousLine = null;
          continue;
        }

        const verticalGap = previousLine ? previousLine.bottom - line.top : 0;
        const indentShift = previousLine ? Math.abs(line.left - previousLine.left) : 0;
        const paragraphBreak = previousLine && (
          verticalGap > Math.max(previousLine.height, line.height) * 0.85
          || indentShift > page.width * 0.075
        );
        if (paragraphBreak) {
          if (text && !/[.!?]["')\]}]?$/.test(text)) text += ".";
          flushBuffer();
          previousLine = null;
        }

        if (!text) {
          bufferSection = currentSection;
          bufferSectionStart = pendingSectionStart;
        }

        for (const word of line.words) {
          const normalized = FastKeySentenceNLP.normalizeText(word.text);
          if (!normalized) continue;
          const noSpaceBefore = /^[,.;:!?%\)\]\}]/.test(normalized);
          const noSpaceAfterPrevious = /[\(\[\{\/$]$/.test(text);
          if (text && !text.endsWith(" ") && !noSpaceBefore && !noSpaceAfterPrevious) text += " ";
          const start = text.length;
          text += normalized;
          pageWords.push({
            start,
            end: text.length,
            rect: word.rect,
            top: word.top,
            frontMatter: isFrontMatter
          });
        }
        previousLine = line;
      }
      flushBuffer();
    }
    return sentences;
  },

  mergeRects(rects) {
    if (!rects.length) return [];
    const sorted = rects.slice().sort((a, b) => (b[3] - a[3]) || (a[0] - b[0]));
    const lines = [];
    for (const r of sorted) {
      const cy = (r[1] + r[3]) / 2;
      let line = lines.find(l => Math.abs(l.cy - cy) <= Math.max(2.5, (r[3] - r[1]) * 0.45));
      if (!line) {
        line = { cy, rects: [] };
        lines.push(line);
      }
      line.rects.push(r);
    }
    return lines
      .sort((a, b) => b.cy - a.cy)
      .map(line => {
        const rs = line.rects.sort((a, b) => a[0] - b[0]);
        return [Math.min(...rs.map(r => r[0])), Math.min(...rs.map(r => r[1])), Math.max(...rs.map(r => r[2])), Math.max(...rs.map(r => r[3]))];
      });
  },

  makeAnnotation(sentence) {
    const text = sentence.text;
    const rects = sentence.rects || [];
    const colors = {
      contribution: "#ffd400",
      result: "#5fb236",
      method: "#2ea8e5",
      goal: "#a28ae5",
      background: "#aaaaaa",
      takeaway: "#f19837"
    };
    const descriptions = {
      contribution: "Main contribution",
      result: "Key empirical result",
      method: "Core method",
      goal: "Research objective",
      background: "Background context",
      takeaway: "Key takeaway"
    };
    const top = Math.max(...rects.map(r => r[3]));
    const left = Math.min(...rects.map(r => r[0]));
    // Zotero 9 validates PDF annotation sort indexes as page|vertical|horizontal:
    // exactly 5 digits, 6 digits, and 5 digits respectively.
    const pagePart = String(Math.max(0, Math.min(99999, sentence.pageIndex))).padStart(5, "0");
    const verticalPart = String(Math.max(0, Math.min(999999, Math.round((sentence.pageHeight - top) * 100)))).padStart(6, "0");
    const horizontalPart = String(Math.max(0, Math.min(99999, Math.round(left * 100)))).padStart(5, "0");
    const sortIndex = `${pagePart}|${verticalPart}|${horizontalPart}`;
    return {
      key: Zotero.DataObjectUtilities.generateKey(),
      type: "highlight",
      color: colors[sentence.role] || colors.background,
      pageLabel: String(sentence.pageIndex + 1),
      sortIndex,
      position: { pageIndex: sentence.pageIndex, rects },
      text,
      comment: `${descriptions[sentence.role] || descriptions.background}. Section: ${sentence.section || "unclassified"}. Score: ${sentence.importance.toFixed(3)}.`,
      tags: [{ name: "auto-key-sentence" }, { name: `auto-${sentence.role || "background"}` }]
    };
  },

  async refineSelectedWindows(selected, settings) {
    if (typeof FastKeySentenceModels === "undefined" || typeof FastKeySentenceModels.embeddings !== "function") return;
    const threshold = 0.08;
    const summary = selected[0]?._paperSummary || "";
    if (!summary) return;

    const summaryEmb = (await FastKeySentenceModels.embeddings([summary], false, () => {}))[0];
    const cos = (a, b) => {
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
      return dot / (Math.sqrt(na) * Math.sqrt(nb));
    };

    for (const sentence of selected) {
      const tokens = sentence.text.split(/\s+/);
      if (tokens.length <= 10) continue;
      const windowSize = Math.min(30, tokens.length);
      const windows = [];
      for (let start = 0; start <= tokens.length - 10; start++) {
        const end = Math.min(start + windowSize, tokens.length);
        if (end - start < 10) continue;
        windows.push({
          text: tokens.slice(start, end).join(" "),
          rects: (sentence.rects || []).slice(start, end),
        });
      }
      if (!windows.length) continue;

      const allTexts = [sentence.text, ...windows.map(w => w.text)];
      const allEmbeddings = await FastKeySentenceModels.embeddings(allTexts, false, () => {});
      const sentenceScore = cos(allEmbeddings[0], summaryEmb);

      let bestWin = null, bestScore = sentenceScore + threshold;
      for (let i = 0; i < windows.length; i++) {
        const winScore = cos(allEmbeddings[i + 1], summaryEmb);
        if (winScore > bestScore) { bestScore = winScore; bestWin = windows[i]; }
      }
      if (bestWin) { sentence.text = bestWin.text; sentence.rects = bestWin.rects; }
    }
  },

};
