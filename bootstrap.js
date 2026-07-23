var FastOfflineKeySentenceAnnotator;
var FastKeySentenceModels;
var FastKeySentenceModelIdentifiers;
var FastKeySentenceScoringConfig;

function log(message) {
  Zotero.debug("Fast Offline Key-Sentence Annotator: " + message);
}

function install() {
  log("Installed");
}

async function startup({ id, version, rootURI }) {
  const [modelsResponse, scoringResponse] = await Promise.all([
    fetch(rootURI + "model-identifiers.json"),
    fetch(rootURI + "scoring-config.json")
  ]);
  if (!modelsResponse.ok) throw new Error(`Could not load model identifiers (${modelsResponse.status})`);
  if (!scoringResponse.ok) throw new Error(`Could not load scoring configuration (${scoringResponse.status})`);
  FastKeySentenceModelIdentifiers = Object.freeze(await modelsResponse.json());
  FastKeySentenceScoringConfig = Object.freeze(await scoringResponse.json());
  Services.scriptloader.loadSubScript(rootURI + "content/nlp.js");
  Services.scriptloader.loadSubScript(rootURI + "content/model-manager.js");
  Services.scriptloader.loadSubScript(rootURI + "content/remote-llm.js");
  Services.scriptloader.loadSubScript(rootURI + "content/annotator.js");
  FastKeySentenceModels.init({ rootURI });
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
