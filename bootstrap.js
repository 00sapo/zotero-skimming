var FastOfflineKeySentenceAnnotator;
var FastKeySentenceModels;
var FastKeySentenceScoringConfig;
var FastKeySentenceSummaryLabelConfigV2;
var FastKeySentenceSummaryLabelConfigV2Path;

function log(message) {
  Zotero.debug("Zotero Skimming: " + message);
}

function install() {
  log("Installed");
}

async function startup({ id, version, rootURI }) {
  const scoringResponse = await fetch(rootURI + "scoring-config.json");
  if (!scoringResponse.ok) throw new Error(`Could not load scoring configuration (${scoringResponse.status})`);
  FastKeySentenceScoringConfig = Object.freeze(await scoringResponse.json());
  Services.scriptloader.loadSubScript(rootURI + "content/summary-label-config.js");

  FastKeySentenceSummaryLabelConfigV2Path = PathUtils.join(PathUtils.profileDir, "zotero-skimming", "summary-label-config-v2.toml");
  await IOUtils.makeDirectory(PathUtils.parent(FastKeySentenceSummaryLabelConfigV2Path), { ignoreExisting: true });
  if (!await IOUtils.exists(FastKeySentenceSummaryLabelConfigV2Path)) {
    await IOUtils.writeUTF8(FastKeySentenceSummaryLabelConfigV2Path, FastKeySentenceSummaryLabels.DEFAULT_CONFIG);
  }
  FastKeySentenceSummaryLabelConfigV2 = new TextDecoder().decode(await IOUtils.read(FastKeySentenceSummaryLabelConfigV2Path));

  // Validate the v2 summary-label config; retired config files are intentionally ignored.
  try {
    FastKeySentenceSummaryLabels.parseConfig(FastKeySentenceSummaryLabelConfigV2);
  } catch (error) {
    log(`Summary label config v2 parse error — falling back to default. ${error.message || error}`);
    if (typeof Services?.console?.logStringMessage === "function") Services.console.logStringMessage(`Zotero Skimming: summary-label-config-v2.toml is invalid — ${error.message || error}. Using built-in defaults.`);
    FastKeySentenceSummaryLabelConfigV2 = FastKeySentenceSummaryLabels.DEFAULT_CONFIG;
    await IOUtils.writeUTF8(FastKeySentenceSummaryLabelConfigV2Path, FastKeySentenceSummaryLabelConfigV2).catch(() => {});
  }

  Services.scriptloader.loadSubScript(rootURI + "content/nlp.js");
  Services.scriptloader.loadSubScript(rootURI + "content/model-manager.js");
  Services.scriptloader.loadSubScript(rootURI + "content/remote-llm.js");
  Services.scriptloader.loadSubScript(rootURI + "content/annotator.js");

  const defaults = Services.prefs.getDefaultBranch("extensions.zotero-skimming.");
  defaults.setIntPref("compressionRatio", 10);
  defaults.setBoolPref("localRelevance", false);
  defaults.setBoolPref("zeroShotLabels", false);
  defaults.setStringPref("ollamaCommand", "/usr/bin/ollama");
  defaults.setStringPref("remoteEndpoint", "");
  defaults.setStringPref("remoteApiKey", "");
  defaults.setStringPref("summarySource", "local");
  defaults.setBoolPref("mapReduce", false);
  defaults.setIntPref("mapReduceSentences", 40);
  defaults.setIntPref("mapReduceInputTokens", 4096);
  defaults.setStringPref("summaryModel", "");
  defaults.setStringPref("embeddingModel", "");

  FastKeySentenceModels.init(rootURI);
  FastOfflineKeySentenceAnnotator.init({ id, version, rootURI });

  // Zotero 9 calls startup after core initialization, but existing main windows
  // still need explicit registration. Future windows are handled by the hooks.
  for (const window of Zotero.getMainWindows()) {
    if (window?.ZoteroPane) {
      window?.MozXULElement?.insertFTLIfNeeded?.("zotero-skimming-mainWindow.ftl");
      FastOfflineKeySentenceAnnotator.addToWindow(window);
    }
  }
}

function onMainWindowLoad({ window }) {
  window?.MozXULElement?.insertFTLIfNeeded?.("zotero-skimming-mainWindow.ftl");
  FastOfflineKeySentenceAnnotator?.addToWindow(window);
}

function onMainWindowUnload({ window }) {
  FastOfflineKeySentenceAnnotator?.removeFromWindow(window);
}

function shutdown() {
  FastKeySentenceModels?.shutdown?.();
  if (!FastOfflineKeySentenceAnnotator) return;
  for (const window of Zotero.getMainWindows()) {
    FastOfflineKeySentenceAnnotator.removeFromWindow(window);
  }
  FastOfflineKeySentenceAnnotator = undefined;
}

function uninstall() {
  log("Uninstalled");
}
