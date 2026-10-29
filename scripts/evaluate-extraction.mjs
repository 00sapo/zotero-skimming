import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function normalizeSentence(value) {
  return String(value ?? "").replace(/-\s*\n\s*/g, "").replace(/[\u00ad]/g, "").replace(/\s+/g, " ").trim();
}

function tokens(value) {
  return normalizeSentence(value).toLocaleLowerCase("en").match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
}

function countTokens(sentences) {
  const counts = new Map();
  for (const sentence of sentences) for (const token of tokens(sentence)) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

function overlapCount(left, right) {
  let count = 0;
  for (const [token, quantity] of left) count += Math.min(quantity, right.get(token) ?? 0);
  return count;
}

export function wordMetrics(actual, expected) {
  const actualCounts = countTokens(actual);
  const expectedCounts = countTokens(expected);
  const matched = overlapCount(actualCounts, expectedCounts);
  const actualTotal = [...actualCounts.values()].reduce((sum, value) => sum + value, 0);
  const expectedTotal = [...expectedCounts.values()].reduce((sum, value) => sum + value, 0);
  return { precision: actualTotal ? matched / actualTotal : (expectedTotal ? 0 : 1), recall: expectedTotal ? matched / expectedTotal : (actualTotal ? 0 : 1), matchedWords: matched, actualWords: actualTotal, expectedWords: expectedTotal };
}

export function exactSentenceRecall(actual, expected) {
  const remaining = new Map();
  for (const text of actual) {
    const normalized = normalizeSentence(text).toLocaleLowerCase("en");
    remaining.set(normalized, (remaining.get(normalized) ?? 0) + 1);
  }
  let matched = 0;
  for (const text of expected) {
    const normalized = normalizeSentence(text).toLocaleLowerCase("en");
    const quantity = remaining.get(normalized) ?? 0;
    if (quantity) { matched++; remaining.set(normalized, quantity - 1); }
  }
  return { recall: expected.length ? matched / expected.length : 1, matchedSentences: matched, expectedSentences: expected.length };
}

function sentenceMatches(actual, expected) {
  const positions = new Map();
  for (let index = 0; index < expected.length; index++) {
    const text = normalizeSentence(expected[index]).toLocaleLowerCase("en");
    if (!positions.has(text)) positions.set(text, []);
    positions.get(text).push(index);
  }
  const actualCounts = new Map();
  for (const sentence of actual) {
    const text = normalizeSentence(sentence).toLocaleLowerCase("en");
    actualCounts.set(text, (actualCounts.get(text) ?? 0) + 1);
  }
  const matches = [];
  for (let ai = 0; ai < actual.length; ai++) {
    const text = normalizeSentence(actual[ai]).toLocaleLowerCase("en");
    const candidates = positions.get(text);
    if (candidates?.length === 1 && actualCounts.get(text) === 1) {
      matches.push({ ai, ei: candidates[0] });
    }
  }
  return matches;
}

export function orderInversions(actual, expected) {
  const matches = sentenceMatches(actual.map(item => typeof item === "string" ? item : item.text), expected.map(item => typeof item === "string" ? item : item.text));
  let inversions = 0;
  for (let i = 0; i < matches.length; i++) for (let j = i + 1; j < matches.length; j++) {
    if ((matches[i].ai - matches[j].ai) * (matches[i].ei - matches[j].ei) < 0) inversions++;
  }
  return { inversions, matchedSentences: matches.length };
}

export function validRectangleFraction(sentences) {
  const rects = sentences.flatMap(sentence => sentence.rects ?? []);
  const valid = rects.filter(rect => Array.isArray(rect) && rect.length === 4 && rect.every(Number.isFinite) && rect[2] > rect[0] && rect[3] > rect[1]).length;
  return { fraction: rects.length ? valid / rects.length : 1, validRectangles: valid, rectangleCount: rects.length };
}

export function excludedLeakage(actual, excluded, expected = []) {
  const haystack = ` ${tokens(actual.map(sentence => typeof sentence === "string" ? sentence : sentence.text).join(" ")).join(" ")} `;
  const prose = ` ${tokens(expected.join(" ")).join(" ")} `;
  return excluded.reduce((count, item) => {
    const phrase = tokens(item.text).join(" ");
    const needle = ` ${phrase} `;
    return phrase.length && !prose.includes(needle) && haystack.includes(needle) ? count + 1 : count;
  }, 0);
}

function loadExtractor() {
  const context = vm.createContext({ console, setTimeout, clearTimeout, URL, Blob, Response, TextEncoder, TextDecoder, Uint8Array, Intl,
    Components: { utils: { waiveXrays: value => value, cloneInto: value => value } },
    Zotero: { Promise: { delay: async () => {} }, Items: { get: () => null } }
  });
  vm.runInContext(fs.readFileSync(path.join(root, "content/extractor.js"), "utf8"), context, { filename: "content/extractor.js" });
  return context.FastKeySentenceExtractor;
}

function readGeometry(fixtureRoot, geometryPath) {
  const raw = fs.readFileSync(path.resolve(fixtureRoot, geometryPath));
  const json = geometryPath.endsWith(".gz") ? zlib.gunzipSync(raw).toString("utf8") : raw.toString("utf8");
  return JSON.parse(json);
}

export async function evaluateCorpus({ fixtureRoot = path.join(root, "test/fixtures/pdf-extraction"), manifestPath = "manifest.json", extractor = loadExtractor() } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(fixtureRoot, manifestPath), "utf8"));
  const cases = [];
  for (const entry of manifest.cases) {
    for (const [asset, expectedHash] of [
      [entry.pdf, entry.sha256],
      [entry.geometry, entry.geometrySha256],
      [entry.groundTruth, entry.groundTruthSha256]
    ]) {
      const digest = createHash("sha256").update(fs.readFileSync(path.resolve(fixtureRoot, asset))).digest("hex");
      if (digest !== expectedHash) throw new Error(`${entry.id}: stale or damaged fixture ${asset}`);
    }
    const truth = JSON.parse(fs.readFileSync(path.resolve(fixtureRoot, entry.groundTruth), "utf8"));
    const geometry = readGeometry(fixtureRoot, entry.geometry);
    const pages = geometry.pages;
    const reader = { _internalReader: { _primaryView: { _iframeWindow: { PDFViewerApplication: {
      pagesCount: pages.length,
      pdfDocument: { getPageData: async ({ pageIndex }) => ({ viewBox: pages[pageIndex].viewBox, chars: pages[pageIndex].chars.map(char => ({ ...char, c: char.u })) }) }
    } } } } };
    const parent = { getField: field => field === "title" ? truth.title : "", getCreators: () => truth.creators.map(name => {
      const parts = String(name).trim().split(/\s+/); return { firstName: parts.slice(0, -1).join(" "), lastName: parts.at(-1) ?? "" };
    }) };
    const result = await extractor.extractDocument(reader, { parentItem: parent });
    const actual = result.sentences.map(sentence => sentence.text);
    const expected = truth.sentences.map(sentence => sentence.text);
    const exact = exactSentenceRecall(actual, expected);
    const words = wordMetrics(actual, [...expected, ...(truth.fragments ?? []).map(fragment => fragment.text)]);
    const order = orderInversions(result.sentences, truth.sentences);
    const rectangles = validRectangleFraction(result.sentences);
    cases.push({ id: entry.id, exactSentenceRecall: exact.recall, wordPrecision: words.precision, wordRecall: words.recall,
      excludedLeakageCount: excludedLeakage(actual, truth.excluded ?? [], expected), readingOrderInversions: order.inversions,
      validRectangleFraction: rectangles.fraction,
      counts: {
        matchedSentences: exact.matchedSentences,
        expectedSentences: exact.expectedSentences,
        orderMatchedSentences: order.matchedSentences,
        matchedWords: words.matchedWords,
        actualWords: words.actualWords,
        expectedWords: words.expectedWords,
        validRectangles: rectangles.validRectangles,
        rectangles: rectangles.rectangleCount
      }
    });
  }
  const actualWords = cases.reduce((sum, item) => sum + item.counts.actualWords, 0);
  const expectedWords = cases.reduce((sum, item) => sum + item.counts.expectedWords, 0);
  const matchedWords = cases.reduce((sum, item) => sum + item.counts.matchedWords, 0);
  const rectangleCount = cases.reduce((sum, item) => sum + item.counts.rectangles, 0);
  const validRects = cases.reduce((sum, item) => sum + item.counts.validRectangles, 0);
  return { schemaVersion: 1, caseCount: cases.length, cases, totals: {
    exactSentenceRecall: cases.reduce((sum, item) => sum + item.counts.matchedSentences, 0) / Math.max(1, cases.reduce((sum, item) => sum + item.counts.expectedSentences, 0)),
    wordPrecision: actualWords ? matchedWords / actualWords : (expectedWords ? 0 : 1),
    wordRecall: expectedWords ? matchedWords / expectedWords : (actualWords ? 0 : 1),
    excludedLeakageCount: cases.reduce((sum, item) => sum + item.excludedLeakageCount, 0),
    readingOrderInversions: cases.reduce((sum, item) => sum + item.readingOrderInversions, 0),
    validRectangleFraction: rectangleCount ? validRects / rectangleCount : 1
  } };
}
export function compareBaseline(current, baseline) {
  const failures = [];
  const previous = new Map(baseline.cases.map(item => [item.id, item]));
  for (const item of current.cases) {
    const old = previous.get(item.id);
    if (!old) { failures.push(`${item.id}: missing from baseline`); continue; }
    for (const metric of ["exactSentenceRecall", "wordPrecision", "wordRecall", "validRectangleFraction"]) if (item[metric] < old[metric]) failures.push(`${item.id}: ${metric} decreased (${old[metric]} -> ${item[metric]})`);
    for (const metric of ["excludedLeakageCount", "readingOrderInversions"]) if (item[metric] > old[metric]) failures.push(`${item.id}: ${metric} increased (${old[metric]} -> ${item[metric]})`);
  }
  for (const old of baseline.cases) if (!current.cases.some(item => item.id === old.id)) failures.push(`${old.id}: missing from current corpus`);
  return failures;
}


async function main() {
  const args = process.argv.slice(2);
  const baselineAt = args.indexOf("--baseline");
  const outputAt = args.indexOf("--output");
  const report = await evaluateCorpus();
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (outputAt >= 0) fs.writeFileSync(path.resolve(args[outputAt + 1]), json);
  process.stdout.write(json);
  if (baselineAt >= 0) {
    const baselinePath = path.resolve(args[baselineAt + 1]);
    const failures = compareBaseline(report, JSON.parse(fs.readFileSync(baselinePath, "utf8")));
    if (failures.length) { console.error(failures.join("\n")); process.exitCode = 1; }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
