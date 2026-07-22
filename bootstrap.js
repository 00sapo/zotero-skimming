var FastOfflineKeySentenceAnnotator;
var FastKeySentenceModels;
var FastKeySentenceModelIdentifiers;

function log(message) {
  Zotero.debug("Fast Offline Key-Sentence Annotator: " + message);
}

function install() {
  log("Installed");
}

async function startup({ id, version, rootURI }) {
  const response = await fetch(rootURI + "model-identifiers.json");
  if (!response.ok) throw new Error(`Could not load model identifiers (${response.status})`);
  FastKeySentenceModelIdentifiers = Object.freeze(await response.json());
  Services.scriptloader.loadSubScript(rootURI + "content/nlp.js");
  Services.scriptloader.loadSubScript(rootURI + "content/model-manager.js");
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
