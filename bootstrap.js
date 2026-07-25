var FastOfflineKeySentenceAnnotator;
var FastKeySentenceModels;
var FastKeySentenceScoringConfig;

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
  Services.scriptloader.loadSubScript(rootURI + "content/nlp.js");
  Services.scriptloader.loadSubScript(rootURI + "content/model-manager.js");
  Services.scriptloader.loadSubScript(rootURI + "content/remote-llm.js");
  Services.scriptloader.loadSubScript(rootURI + "content/annotator.js");

  const defaults = Services.prefs.getDefaultBranch("extensions.zotero-skimming.");
  defaults.setIntPref("compressionRatio", 10);
  defaults.setBoolPref("localRelevance", false);
  defaults.setStringPref("ollamaCommand", "/usr/bin/ollama");
  defaults.setStringPref("tagDefinitions", FastKeySentenceNLP.DEFAULT_TAG_DEFINITIONS);
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
      FastOfflineKeySentenceAnnotator.addToWindow(window);
    }
  }
}

function onMainWindowLoad({ window }) {
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
