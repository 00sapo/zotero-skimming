#!/usr/bin/env node
// Runs the working tree inside a real Zotero install.
//
// The script builds an XPI from the repository, adds a probe to a copy of
// bootstrap.js, starts Zotero with a throwaway profile and data directory, and
// checks summary generation, embeddings, and native annotation creation.
//
// Environment:
//   ZOTERO_BIN            Zotero executable (default per platform)
//   SMOKE_PDF             PDF used for the annotation check (optional)
//   SMOKE_OLLAMA_COMMAND  Value for extensions.zotero-skimming.ollamaCommand
//   SMOKE_TIMEOUT         Total run time in milliseconds (default 300000)
//   SMOKE_HEADLESS        "0" to show the Zotero window (default is headless)
//   SMOKE_KEEP            "1" to keep the temporary profile and log
//
// The user profile and library are not touched.

import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ADDON_ID = "zotero-skimming@00sapo.org";
const RESULT_NAME = "smoke-result.json";
const LOG_NAME = "zotero-smoke.log";
const DEFAULT_TIMEOUT = 300_000;
const PLUGIN_ENTRIES = [
  "bootstrap.js",
  "manifest.json",
  "model-identifiers.json",
  "scoring-config.json",
  "content",
  "assets",
  "locale"
];

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function defaultZoteroBin() {
  if (process.env.ZOTERO_BIN) return process.env.ZOTERO_BIN;
  if (process.platform === "darwin") return "/Applications/Zotero.app/Contents/MacOS/zotero";
  if (process.platform === "win32") return "C:\\Program Files\\Zotero\\zotero.exe";
  return "/usr/lib/zotero/zotero";
}

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

function makeProbe(resultPath, pdfPath) {
  return `
async function smokeProbe() {
  const out = { zotero: Zotero.version, checks: [] };
  const pdfPath = ${JSON.stringify(pdfPath)};
  try {
    const summary = await FastKeySentenceModels.summarize(
      "Cats sleep a lot. Dogs bark loudly. Birds fly high.",
      event => { out.lastEvent = event; },
      { sentenceCount: 2 }
    );
    out.summary = String(summary);
    out.checks.push({ name: "summary", ok: out.summary.trim().length > 0, detail: out.summary.trim().length + " chars" });
    const vectors = await FastKeySentenceModels.embeddings(["alpha text", "beta text"]);
    out.checks.push({
      name: "embeddings",
      ok: vectors.length === 2 && vectors.every(vector => Array.isArray(vector) && vector.length > 0),
      detail: vectors.length + " vectors of " + (vectors[0] ? vectors[0].length : 0)
    });
    if (pdfPath) {
      const attachment = await Zotero.Attachments.importFromFile({
        file: pdfPath,
        libraryID: Zotero.Libraries.userLibraryID
      });
      await FastOfflineKeySentenceAnnotator.annotateAttachment(attachment);
      const annotations = attachment.getAnnotations();
      out.annotations = annotations.map(item => {
        let position = item.annotationPosition;
        if (typeof position === "string") {
          try { position = JSON.parse(position); }
          catch (_) { position = null; }
        }
        return {
          page: item.annotationPageLabel,
          rects: position && position.rects ? position.rects.length : 0,
          tags: item.getTags().map(tag => tag.tag)
        };
      });
      out.checks.push({
        name: "annotations",
        ok: annotations.length > 0 && out.annotations.every(annotation => annotation.rects > 0 && annotation.tags.includes("autoskim-key-sentence")),
        detail: annotations.length + " highlights"
      });
    }
  }
  catch (error) {
    out.error = {
      message: error && error.message ? error.message : String(error),
      stack: error && error.stack ? error.stack : ""
    };
  }
  try { await IOUtils.writeUTF8(${JSON.stringify(resultPath)}, JSON.stringify(out, null, 1)); }
  catch (_) {}
  try { Services.startup.quit(Services.startup.eAttemptQuit); } catch (_) {}
}
`;
}

function buildXpi(buildDir, xpiPath, resultPath, pdfPath) {
  for (const entry of PLUGIN_ENTRIES) {
    const source = join(ROOT, entry);
    if (!existsSync(source)) continue;
    if (entry === "locale" && readdirSync(source).length === 0) continue;
    cpSync(source, join(buildDir, entry), { recursive: true });
  }

  const bootstrapPath = join(buildDir, "bootstrap.js");
  const bootstrap = readFileSync(bootstrapPath, "utf8");
  const callAnchor = `  for (const window of Zotero.getMainWindows()) {
    if (window?.ZoteroPane) FastOfflineKeySentenceAnnotator.addToWindow(window);
  }
}`;
  const functionAnchor = "function onMainWindowLoad({ window }) {";
  if (!bootstrap.includes(callAnchor) || !bootstrap.includes(functionAnchor)) {
    fail("bootstrap.js changed shape; update the injection anchors in scripts/smoke-zotero.mjs.");
  }
  const patched = bootstrap
    .replace(callAnchor, callAnchor.replace(/\n}$/, "\n\n  setTimeout(() => { void smokeProbe(); }, 5000);\n}"))
    .replace(functionAnchor, `${makeProbe(resultPath, pdfPath)}\n${functionAnchor}`);
  writeFileSync(bootstrapPath, patched);

  const entries = PLUGIN_ENTRIES.filter(entry => existsSync(join(buildDir, entry)));
  const zipped = spawnSync("zip", ["-qr", xpiPath, ...entries], { cwd: buildDir, encoding: "utf8" });
  if (zipped.error?.code === "ENOENT") fail("The zip command is required to build the XPI.");
  if (zipped.status !== 0) fail(`zip failed: ${zipped.stderr || zipped.stdout}`);
}

function writeProfile(profileDir, dataDir) {
  const lines = [
    `user_pref("extensions.autoDisableScopes", 0);`,
    `user_pref("extensions.zotero.firstRun2", true);`,
    `user_pref("extensions.zotero.dataDir", ${JSON.stringify(dataDir)});`,
    `user_pref("extensions.zotero-skimming.summarySource", "local");`,
    `user_pref("extensions.zotero-skimming.localRelevance", true);`,
    `user_pref("extensions.zotero-skimming.zeroShotLabels", true);`
  ];
  if (process.env.SMOKE_OLLAMA_COMMAND) {
    lines.push(`user_pref("extensions.zotero-skimming.ollamaCommand", ${JSON.stringify(process.env.SMOKE_OLLAMA_COMMAND)});`);
  }
  writeFileSync(join(profileDir, "user.js"), `${lines.join("\n")}\n`);
}

function logTail(logPath, lineCount = 40) {
  if (!existsSync(logPath)) return "(no log)";
  return readFileSync(logPath, "utf8").trimEnd().split("\n").slice(-lineCount).join("\n");
}

async function main() {
  const zoteroBin = defaultZoteroBin();
  if (!existsSync(zoteroBin)) fail(`Zotero executable not found: ${zoteroBin}. Set ZOTERO_BIN.`);

  const pdfPath = process.env.SMOKE_PDF ? resolve(process.env.SMOKE_PDF) : null;
  if (pdfPath && !existsSync(pdfPath)) fail(`SMOKE_PDF not found: ${pdfPath}`);

  const timeoutMs = Number(process.env.SMOKE_TIMEOUT) || DEFAULT_TIMEOUT;
  const headless = process.env.SMOKE_HEADLESS !== "0";
  const keep = process.env.SMOKE_KEEP === "1";
  const tempDir = mkdtempSync(join(tmpdir(), "zotero-skimming-smoke-"));
  const buildDir = join(tempDir, "build");
  const profileDir = join(tempDir, "profile");
  const dataDir = join(tempDir, "data");
  const logPath = join(tempDir, LOG_NAME);
  const resultPath = join(tempDir, RESULT_NAME);
  const xpiPath = join(profileDir, "extensions", `${ADDON_ID}.xpi`);

  mkdirSync(buildDir, { recursive: true });
  mkdirSync(join(profileDir, "extensions"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  buildXpi(buildDir, xpiPath, resultPath, pdfPath);
  writeProfile(profileDir, dataDir);

  const args = ["--profile", profileDir, "-no-remote", "-datadir", dataDir, "-ZoteroDebugText"];
  if (headless) args.unshift("--headless");
  console.log(`Zotero: ${zoteroBin}`);
  console.log(`PDF: ${pdfPath || "(skipped)"}`);
  console.log(`Log: ${logPath}`);

  const logFd = openSync(logPath, "w");
  const child = spawn(zoteroBin, args, { stdio: ["ignore", logFd, logFd] });
  let result = null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(resultPath)) {
      result = JSON.parse(readFileSync(resultPath, "utf8"));
      break;
    }
    if (child.exitCode !== null) break;
    await delay(500);
  }

  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await delay(5000);
    if (child.exitCode === null) child.kill("SIGKILL");
  }

  if (!result) {
    const started = readFileSync(logPath, "utf8").includes("Calling bootstrap method 'startup'");
    console.error(logTail(logPath));
    fail(
      started
        ? `The add-on started but no result was written within ${timeoutMs} ms. Check the log above, Ollama, and the downloaded models.`
        : "The add-on did not start. Check the log above."
    );
  }

  console.log(`Zotero version: ${result.zotero}`);
  for (const check of result.checks) {
    console.log(`${check.ok ? "ok  " : "FAIL"} ${check.name}${check.detail ? ` (${check.detail})` : ""}`);
  }
  if (result.error) {
    console.error(`${result.error.message}\n${result.error.stack || ""}`);
  }

  const failed = result.error || result.checks.length === 0 || result.checks.some(check => !check.ok);
  if (pdfPath && !result.checks.some(check => check.name === "annotations")) {
    console.error("FAIL the PDF annotation check did not run");
    process.exitCode = 1;
  }
  else if (failed) {
    console.error("FAIL");
    process.exitCode = 1;
  }
  else {
    console.log("PASS");
  }

  if (keep) console.log(`Kept: ${tempDir}`);
  else rmSync(tempDir, { recursive: true, force: true });
}

await main();
