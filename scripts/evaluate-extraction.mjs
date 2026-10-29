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

export function recoveredSentenceCount(actual, expected) {
  const texts = actual.map(item => normalizeSentence(typeof item === "string" ? item : item.text).toLocaleLowerCase("en"));
  const pages = actual.map(item => typeof item === "string" ? 0 : item.pageIndex ?? 0);
  const used = new Array(texts.length).fill(false);
  let matched = 0;
  for (const item of expected) {
    const text = typeof item === "string" ? item : item.text;
    const firstPage = typeof item === "string" ? 0 : item.pageIndex ?? 0;
    const lastPage = typeof item === "string" ? firstPage : item.endPageIndex ?? firstPage;
    const target = normalizeSentence(text).toLocaleLowerCase("en");
    const single = texts.findIndex((candidate, index) => !used[index] && candidate === target);
    if (single >= 0) { used[single] = true; matched++; continue; }
    if (lastPage === firstPage) continue;
    for (let start = 0; start < texts.length; start++) {
      if (used[start] || pages[start] < firstPage || pages[start] > lastPage) continue;
      let joined = texts[start];
      for (let end = start; end < texts.length && end < start + 4; end++) {
        if (end > start) {
          if (used[end] || pages[end] < pages[end - 1] || pages[end] < firstPage || pages[end] > lastPage) break;
          joined = `${joined} ${texts[end]}`;
        }
        if (joined === target) {
          for (let index = start; index <= end; index++) used[index] = true;
          matched++;
          start = texts.length;
          break;
        }
        if (!target.startsWith(joined)) break;
      }
    }
  }
  return { recall: expected.length ? matched / expected.length : 1, matchedSentences: matched, expectedSentences: expected.length };
}

export function sentenceBalancedMetrics(matchedSentences, expectedSentences, negativeUnits, claimedCharIndices) {
  const claimed = claimedCharIndices instanceof Set ? claimedCharIndices : new Set(claimedCharIndices);
  const truePositive = matchedSentences;
  const falseNegative = expectedSentences - matchedSentences;
  let falsePositive = 0;
  let trueNegative = 0;
  for (const unit of negativeUnits) {
    if (unit.charIndices.some(index => claimed.has(index))) falsePositive++;
    else trueNegative++;
  }
  const sensitivity = expectedSentences ? truePositive / expectedSentences : 1;
  const specificity = negativeUnits.length ? trueNegative / negativeUnits.length : 1;
  return { sensitivity, specificity, balancedAccuracy: (sensitivity + specificity) / 2,
    counts: { truePositive, falseNegative, falsePositive, trueNegative } };
}

export function characterConfusionMetrics(positiveCharIndices, negativeUnits, claimedCharIndices) {
  const claimed = claimedCharIndices instanceof Set ? claimedCharIndices : new Set(claimedCharIndices);
  let truePositive = 0;
  let falseNegative = 0;
  let falsePositive = 0;
  let trueNegative = 0;
  for (const index of positiveCharIndices) {
    if (claimed.has(index)) truePositive++;
    else falseNegative++;
  }
  for (const unit of negativeUnits) {
    for (const index of unit.charIndices) {
      if (claimed.has(index)) falsePositive++;
      else trueNegative++;
    }
  }
  const sensitivity = truePositive + falseNegative ? truePositive / (truePositive + falseNegative) : 1;
  const specificity = falsePositive + trueNegative ? trueNegative / (falsePositive + trueNegative) : 1;
  return { sensitivity, specificity, balancedAccuracy: (sensitivity + specificity) / 2,
    counts: { truePositive, falseNegative, falsePositive, trueNegative } };
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

function glyphKey(char) {
  return JSON.stringify([char.u ?? char.c, char.rect]);
}

function claimedRawCharIndices(result, geometry) {
  const rawByPage = new Map();
  geometry.pages.forEach((page, pageIndex) => {
    const ids = new Map();
    page.chars.forEach((char, index) => {
      const key = glyphKey(char);
      if (!ids.has(key)) ids.set(key, []);
      ids.get(key).push(`${pageIndex}:${index}`);
    });
    rawByPage.set(pageIndex, ids);
  });
  const outputPages = new Map((result.pages ?? []).map(page => [page.pageIndex, page]));
  const claimed = new Set();
  for (const sentence of result.sentences) {
    const page = outputPages.get(sentence.pageIndex);
    if (!page) continue;
    const ids = rawByPage.get(sentence.pageIndex);
    if (!ids) continue;
    for (const char of page.chars.slice(sentence.startChar, sentence.endChar)) {
      const matches = ids.get(glyphKey(char));
      if (matches?.length) claimed.add(matches.shift());
    }
  }
  return claimed;
}

function loadLabels(fixtureRoot, entry) {
  if (!entry.labels || !entry.labelsSha256) throw new Error(`${entry.id}: missing frozen character labels`);
  const bytes = fs.readFileSync(path.resolve(fixtureRoot, entry.labels));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== entry.labelsSha256) throw new Error(`${entry.id}: stale or damaged fixture ${entry.labels}`);
  const json = entry.labels.endsWith(".gz") ? zlib.gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
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
    const labels = loadLabels(fixtureRoot, entry);
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
    const recovered = recoveredSentenceCount(result.sentences, truth.sentences);
    const claimed = claimedRawCharIndices(result, geometry);
    const labelPages = labels.pages ?? [];
    const negativeUnits = labelPages.flatMap(page => page.negativeUnits.map(unit => ({
      ...unit, charIndices: unit.charIndices.map(index => `${page.pageIndex}:${index}`)
    })));
    const positiveCharIndices = labelPages.flatMap(page => page.positiveCharIndices.map(index => `${page.pageIndex}:${index}`));
    const sentenceMetrics = sentenceBalancedMetrics(recovered.matchedSentences, recovered.expectedSentences, negativeUnits, claimed);
    const characterMetrics = characterConfusionMetrics(positiveCharIndices, negativeUnits, claimed);
    const words = wordMetrics(actual, [...expected, ...(truth.fragments ?? []).map(fragment => fragment.text)]);
    const order = orderInversions(result.sentences, truth.sentences);
    const rectangles = validRectangleFraction(result.sentences);
    cases.push({ id: entry.id, exactSentenceRecall: exact.recall, sentenceSensitivity: sentenceMetrics.sensitivity,
      negativeSpecificity: sentenceMetrics.specificity, balancedAccuracy: sentenceMetrics.balancedAccuracy,
      characterBalancedAccuracy: characterMetrics.balancedAccuracy,
      wordPrecision: words.precision, wordRecall: words.recall,
      excludedLeakageCount: excludedLeakage(actual, truth.excluded ?? [], expected), readingOrderInversions: order.inversions,
      validRectangleFraction: rectangles.fraction,
      counts: {
        matchedSentences: exact.matchedSentences,
        expectedSentences: exact.expectedSentences,
        negativeTruePositive: sentenceMetrics.counts.truePositive,
        negativeFalseNegative: sentenceMetrics.counts.falseNegative,
        negativeFalsePositive: sentenceMetrics.counts.falsePositive,
        negativeTrueNegative: sentenceMetrics.counts.trueNegative,
        characterTruePositive: characterMetrics.counts.truePositive,
        characterFalseNegative: characterMetrics.counts.falseNegative,
        characterFalsePositive: characterMetrics.counts.falsePositive,
        characterTrueNegative: characterMetrics.counts.trueNegative,
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
  const macro = metric => cases.length ? cases.reduce((sum, item) => sum + item[metric], 0) / cases.length : 0;
  return { schemaVersion: 1, caseCount: cases.length, cases, totals: {
    exactSentenceRecall: cases.reduce((sum, item) => sum + item.counts.matchedSentences, 0) / Math.max(1, cases.reduce((sum, item) => sum + item.counts.expectedSentences, 0)),
    sentenceSensitivity: macro("sentenceSensitivity"),
    negativeSpecificity: macro("negativeSpecificity"),
    balancedAccuracy: macro("balancedAccuracy"),
    characterBalancedAccuracy: macro("characterBalancedAccuracy"),
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
  const autoresearch = args.includes("--autoresearch");
  const baselineAt = args.indexOf("--baseline");
  const outputAt = args.indexOf("--output");
  const started = performance.now();
  const report = await evaluateCorpus();
  const runtime = performance.now() - started;
  if (autoresearch) {
    const percent = value => (value * 100).toFixed(2);
    process.stdout.write(`METRIC balanced_accuracy=${percent(report.totals.balancedAccuracy)}\n`);
    process.stdout.write(`METRIC sentence_recall=${percent(report.totals.sentenceSensitivity)}\n`);
    process.stdout.write(`METRIC negative_specificity=${percent(report.totals.negativeSpecificity)}\n`);
    process.stdout.write(`METRIC character_balanced_accuracy=${percent(report.totals.characterBalancedAccuracy)}\n`);
    process.stdout.write(`METRIC runtime_ms=${runtime.toFixed(2)}\n`);
    return;
  }
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
