/* global Components, Zotero */

/**
 * Geometry-based PDF sentence extraction for the Zotero reader.
 *
 * The reader's pdf.js fork exposes per-character geometry through
 * `pdfDocument.getPageData()`. This module turns those characters into
 * reading-order prose, zones out page furniture and references, and segments
 * the result into sentences whose character ranges map back to exact
 * rectangles.
 *
 * Every function except `extractDocument` is pure so tests can exercise the
 * layout rules without a live reader.
 */
var FastKeySentenceExtractor = (() => {
  "use strict";

  const MIN_LEN = 10;
  const MAX_LEN = 800;
  const MIN_REPEAT_PAGES = 3;
  const REPEAT_PAGE_FRACTION = 0.3;
  const Y_BAND_PT = 30;
  const REF_DENSITY = 0.5;
  const REF_MIN_HITS = 5;

  const REF_SIGNALS = [
    /\b(?:19|20)\d{2}\b/,
    /\bet al\b/i,
    /doi|arxiv|https?:\/\//i,
    /^\s*(?:\[\d+\]|\d{1,3}\.)\s/,
    /[A-Z][a-z]+,\s*[A-Z]\./
  ];

  const SECTION_MARKERS = [
    [/\b(?:references|bibliography|works cited|literature cited|cited literature|reference list|r[ée]f[ée]rences?|bibliographie|ouvrages cit[ée]s|litt[ée]rature cit[ée]e|bibliograf(?:y|ía|ia)|referencias|literaturverzeichnis|riferimenti bibliografici)\b/i, "references"],
    [/\b(?:appendix|supplementary materials?|annexes?|appendice|anhang)\b/i, "appendix"],
    [/\b(?:abstract|summary|r[ée]sum[ée]|resumen|zusammenfassung|riassunto)\b/i, "abstract"],
    [/\b(?:introduction|background|introducci[óo]n|einleitung|introduzione)\b/i, "introduction"],
    [/\b(?:materials? and methods?|methods?|methodology|experimental setup|m[ée]thodes?|m[ée]thodologie|mat[ée]riel et m[ée]thodes|corpus|metodolog[íi]a|methoden|metodi)\b/i, "methods"],
    [/\b(?:results?|findings?|r[ée]sultats?|resultados|ergebnisse|risultati)\b/i, "results"],
    [/\b(?:discussion|analys[ei]s|analyse|discusi[óo]n|diskussion|discussione)\b/i, "discussion"],
    [/\b(?:conclusions?|concluding remarks?|conclusi[óo]n|schluss|fazit|conclusione)\b/i, "conclusion"]
  ];

  function median(values) {
    if (!values || !values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  function normalized(text) {
    return String(text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function numberOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function getHandle(reader) {
    try {
      const iframeWin = reader?._internalReader?._primaryView?._iframeWindow;
      if (!iframeWin) return null;
      const Cu = Components?.utils;
      if (!Cu) return null;
      const win = Cu.waiveXrays(iframeWin);
      const app = win.PDFViewerApplication;
      if (!app?.pdfDocument) return null;
      return { reader, win, app, Cu };
    }
    catch (_) {
      return null;
    }
  }

  function isAvailable(reader) {
    const handle = getHandle(reader);
    return Boolean(handle?.app?.pdfDocument?.getPageData);
  }

  function getPageCount(reader) {
    const handle = getHandle(reader);
    return Math.max(0, Number(handle?.app?.pagesCount)
      || Number(handle?.app?.pdfDocument?.numPages)
      || 0);
  }

  function hintsForAttachment(attachment) {
    try {
      let parent = attachment?.parentItem;
      if (!parent && attachment?.parentID) parent = Zotero.Items.get(attachment.parentID);
      return {
        title: String(parent?.getField?.("title") || ""),
        creators: (parent?.getCreators?.() || []).map(creator =>
          [creator.firstName, creator.lastName].filter(Boolean).join(" ")
        )
      };
    }
    catch (_) {
      return {};
    }
  }

  function lineText(chars) {
    let text = "";
    for (let i = 0; i < chars.length; i++) {
      if (i) {
        const previous = chars[i - 1];
        const current = chars[i];
        const gap = Math.max(current.rect[0] - previous.rect[2], previous.rect[0] - current.rect[2]);
        if (gap > previous.fontSize * 0.18) text += " ";
      }
      text += chars[i].c;
    }
    return text.replace(/\s+/g, " ").trim();
  }

  function describeVisualLine(chars) {
    // Glyph boxes can overlap, so order by the visual center and keep PDF order on ties.
    let ordered = chars.slice().sort((a, b) =>
      (a.rect[0] + a.rect[2]) / 2 - (b.rect[0] + b.rect[2]) / 2);
    const baseline = median(ordered.map(char => char.baseline));
    const fontSize = median(ordered.map(char => char.fontSize));
    ordered = ordered.filter(char => !(char.fontSize < fontSize * 0.92
      && Math.abs(char.baseline - baseline) > char.fontSize * 0.35));
    while (ordered.length && /^[\s•·◦▪▫‣]$/.test(ordered[0].c)) ordered = ordered.slice(1);
    return {
      chars: ordered,
      text: lineText(ordered),
      baseline: median(ordered.map(char => char.baseline)),
      fontSize: median(ordered.map(char => char.fontSize)),
      x1: Math.min(...ordered.map(char => char.rect[0])),
      x2: Math.max(...ordered.map(char => char.rect[2]))
    };
  }

  function visualLines(chars, pageWidth) {
    const clusters = [];
    const sorted = chars.slice().sort((a, b) => b.baseline - a.baseline || a.rect[0] - b.rect[0]);
    for (const char of sorted) {
      let best = -1;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < clusters.length; index++) {
        const line = clusters[index];
        const distance = Math.abs(char.baseline - line.baseline);
        const tolerance = Math.max(1, Math.min(char.fontSize || 10, line.fontSize || 10) * 0.48);
        if (distance <= tolerance && distance < bestDistance) {
          best = index;
          bestDistance = distance;
        }
      }
      if (best >= 0) {
        const cluster = clusters[best];
        const count = cluster.chars.length;
        cluster.chars.push(char);
        cluster.baseline = (cluster.baseline * count + char.baseline) / (count + 1);
        cluster.fontSize = (cluster.fontSize * count + char.fontSize) / (count + 1);
      }
      else {
        clusters.push({ chars: [char], baseline: char.baseline, fontSize: char.fontSize });
      }
    }

    const rows = clusters.map(cluster => describeVisualLine(cluster.chars));
    const segments = [];
    for (const row of rows) {
      const threshold = Math.max(14, row.fontSize * 1.6);
      let start = 0;
      for (let index = 1; index < row.chars.length; index++) {
        const gap = row.chars[index].rect[0] - row.chars[index - 1].rect[2];
        if (gap < threshold) continue;
        const segment = describeVisualLine(row.chars.slice(start, index));
        if (segment.text) segments.push(segment);
        start = index;
      }
      const segment = describeVisualLine(row.chars.slice(start));
      if (segment.text) segments.push(segment);
    }
    return segments;
  }

  function normalizedGlyph(character) {
    const ligatures = {
      "\uFB00": "ff", "\uFB01": "fi", "\uFB02": "fl", "\uFB03": "ffi",
      "\uFB04": "ffl", "\uFB05": "st", "\uFB06": "st", "\u00AD": ""
    };
    return ligatures[character] ?? character;
  }

  function clusterBy(values, tolerance) {
    const clusters = [];
    for (const value of values.slice().sort((a, b) => a.center - b.center)) {
      const cluster = clusters.find(entry => Math.abs(entry.center - value.center) <= tolerance);
      if (cluster) {
        cluster.values.push(value);
        cluster.center = median(cluster.values.map(item => item.center));
      }
      else clusters.push({ center: value.center, values: [value] });
    }
    return clusters;
  }

  function leadingDigitRun(line) {
    const chars = line.chars;
    let index = 0;
    while (index < chars.length && !chars[index].c.trim()) index++;
    const start = index;
    let digits = "";
    while (index < chars.length && /^[0-9]$/.test(chars[index].c)) {
      digits += chars[index].c;
      index++;
    }
    if (!digits || digits.length > 4) return null;
    const next = chars[index];
    const gap = next ? next.rect[0] - chars[index - 1].rect[2] : Number.POSITIVE_INFINITY;
    if (next && gap < Math.max(4, line.fontSize * 0.6)) return null;
    const first = chars[start];
    return {
      chars: chars.slice(start, index),
      center: (first.rect[0] + chars[index - 1].rect[2]) / 2,
      gap
    };
  }

  function trailingDigitRun(line) {
    const chars = line.chars;
    let index = chars.length - 1;
    while (index >= 0 && !chars[index].c.trim()) index--;
    const end = index + 1;
    while (index >= 0 && /^[0-9]$/.test(chars[index].c)) index--;
    const start = index + 1;
    if (end <= start || end - start > 4) return null;
    const previous = chars[index];
    const gap = previous ? chars[start].rect[0] - previous.rect[2] : Number.POSITIVE_INFINITY;
    if (previous && gap < Math.max(4, line.fontSize * 0.6)) return null;
    return {
      chars: chars.slice(start, end),
      center: (chars[start].rect[0] + chars[end - 1].rect[2]) / 2,
      gap
    };
  }

  function middleDigitRuns(line) {
    const found = [];
    for (let index = 0; index < line.chars.length; index++) {
      if (!/^[0-9]$/.test(line.chars[index].c)) continue;
      const start = index;
      while (index + 1 < line.chars.length && /^[0-9]$/.test(line.chars[index + 1].c)) index++;
      const end = index + 1;
      if (end - start > 4) continue;
      const first = line.chars[start];
      const last = line.chars[end - 1];
      const before = line.chars[start - 1];
      const after = line.chars[end];
      const gapBefore = before ? first.rect[0] - before.rect[2] : Number.POSITIVE_INFINITY;
      const gapAfter = after ? after.rect[0] - last.rect[2] : Number.POSITIVE_INFINITY;
      if (gapBefore < Math.max(5, line.fontSize * 0.7) || gapAfter < Math.max(5, line.fontSize * 0.7)) continue;
      found.push({
        chars: line.chars.slice(start, end),
        center: (first.rect[0] + last.rect[2]) / 2,
        gap: Math.min(gapBefore, gapAfter)
      });
    }
    return found;
  }

  function stripMarginNumbers(chars, pageWidth) {
    if (!chars.length || pageWidth <= 0) return chars;
    const lines = visualLines(chars, pageWidth);
    if (lines.length < 4) return chars;
    const runs = [];
    for (const line of lines) {
      for (const run of [leadingDigitRun(line), trailingDigitRun(line), ...middleDigitRuns(line)]) {
        if (run) runs.push(run);
      }
    }
    if (!runs.length) return chars;
    const threshold = Math.max(3, Math.ceil(lines.length * 0.2));
    const removed = new Set();
    for (const cluster of clusterBy(runs, Math.max(3, pageWidth * 0.008))) {
      if (cluster.values.length < threshold) continue;
      for (const run of cluster.values) {
        for (const char of run.chars) removed.add(char);
      }
    }
    if (!removed.size) return chars;
    return chars.filter(char => !removed.has(char));
  }

  function bodyFontSize(chars) {
    const counts = new Map();
    for (const char of chars) {
      if (char.fontSize < 4) continue;
      const size = Math.round(char.fontSize * 2) / 2;
      counts.set(size, (counts.get(size) || 0) + Math.max(1, char.c.length));
    }
    let bestSize = 10;
    let bestCount = 0;
    for (const [size, count] of counts) {
      if (count > bestCount) {
        bestSize = size;
        bestCount = count;
      }
    }
    return bestSize;
  }

  function looksLikeHeading(text) {
    const words = text.match(/[A-Za-z][A-Za-z'’-]*/g) || [];
    if (!words.length || words.length > 16 || /[.!?]\s*$/.test(text)) return false;
    const numbered = /^\s*(?:\d+(?:\.\d+)*|[IVXLCDM]+)[.)-]?\s+/i.test(text);
    const known = SECTION_MARKERS.some(([marker]) => {
      marker.lastIndex = 0;
      return marker.test(text);
    });
    if (known && words.length <= 4) return true;
    if (words.length < 2) return false;
    const capitals = words.filter(word => /^[A-Z]/.test(word) || word === word.toUpperCase()).length;
    return numbered || capitals / words.length >= 0.6;
  }

  function detectColumnStarts(lines, pageWidth) {
    const tolerance = Math.max(8, pageWidth * 0.035);
    const candidates = lines.filter(line => line.x2 - line.x1 < pageWidth * 0.6).sort((a, b) => a.x1 - b.x1);
    const clusters = [];
    for (const line of candidates) {
      let closest;
      let distance = Number.POSITIVE_INFINITY;
      for (const cluster of clusters) {
        const current = Math.abs(line.x1 - cluster.center);
        if (current <= tolerance && current < distance) {
          closest = cluster;
          distance = current;
        }
      }
      if (closest) {
        closest.starts.push(line.x1);
        closest.lines.push(line);
        closest.center = median(closest.starts);
      }
      else {
        clusters.push({ starts: [line.x1], lines: [line], center: line.x1 });
      }
    }

    const repeated = clusters.filter(cluster => cluster.starts.length >= 3
      && median(cluster.lines.map(line => line.x2 - line.x1)) >= pageWidth * 0.22);
    let best = null;
    let bestScore = -1;
    for (let leftIndex = 0; leftIndex < repeated.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < repeated.length; rightIndex++) {
        const first = repeated[leftIndex];
        const second = repeated[rightIndex];
        const left = first.center <= second.center ? first : second;
        const right = left === first ? second : first;
        const separation = right.center - left.center;
        if (separation < pageWidth * 0.2) continue;
        const leftTop = Math.max(...left.lines.map(line => line.baseline));
        const leftBottom = Math.min(...left.lines.map(line => line.baseline));
        const rightTop = Math.max(...right.lines.map(line => line.baseline));
        const rightBottom = Math.min(...right.lines.map(line => line.baseline));
        const overlap = Math.min(leftTop, rightTop) - Math.max(leftBottom, rightBottom);
        const shorterSpan = Math.min(leftTop - leftBottom, rightTop - rightBottom);
        if (overlap < Math.max(0, shorterSpan * 0.35)) continue;
        const score = Math.min(left.starts.length, right.starts.length) * 10000
          + (left.starts.length + right.starts.length) * 100
          + separation;
        if (score > bestScore) {
          best = { left, right, tolerance };
          bestScore = score;
        }
      }
    }
    return best;
  }

  function readingOrder(lines, pageWidth) {
    if (!lines.length || pageWidth <= 0) return lines;
    const topDown = (a, b) => b.baseline - a.baseline || a.x1 - b.x1;
    const columns = detectColumnStarts(lines, pageWidth);
    if (!columns) return lines.slice().sort(topDown);

    const crossesBothColumns = line =>
      line.x1 <= columns.left.center + columns.tolerance
      && line.x2 >= columns.right.center + pageWidth * 0.08;
    const spanning = lines.filter(line => line.x2 - line.x1 >= pageWidth * 0.6 || crossesBothColumns(line));
    const columnLines = lines.filter(line => !spanning.includes(line));
    const left = columnLines.filter(line =>
      Math.abs(line.x1 - columns.left.center) <= Math.abs(line.x1 - columns.right.center)
    );
    const right = columnLines.filter(line => !left.includes(line));
    if (left.length < 3 || right.length < 3) return lines.slice().sort(topDown);

    const columnTop = Math.max(...columnLines.map(line => line.baseline));
    const columnBottom = Math.min(...columnLines.map(line => line.baseline));
    const above = spanning.filter(line => line.baseline > columnTop);
    const below = spanning.filter(line => line.baseline < columnBottom);
    const within = spanning.filter(line => line.baseline <= columnTop && line.baseline >= columnBottom);
    return [
      ...above.sort(topDown),
      ...left.sort(topDown),
      ...right.sort(topDown),
      ...within.sort(topDown),
      ...below.sort(topDown)
    ];
  }

  function sectionFromText(text) {
    for (const [marker, section] of SECTION_MARKERS) {
      marker.lastIndex = 0;
      if (marker.test(text)) return section;
    }
    return null;
  }

  const CAPTION_START = /^\s*(?:figure|fig\.?|table|tab\.?)\s*(?:[A-Z]?\d+|[IVXLC]+)\b/i;

  function isPageNumberLine(text) {
    return /^\s*(?:\d{1,4}|[ivxlcdm]{1,7})\s*$/i.test(text);
  }

  function detectTableLines(lines, lineHeight) {
    const numeric = line => /^[0-9][0-9.,%+-]*$/.test(line.text.replace(/\s/g, ""));
    const short = line => line.text.length <= 40;
    const candidates = lines.filter(line => short(line) && numeric(line));
    if (!candidates.length) return new Set();
    const clusters = clusterBy(candidates.map(line => ({ line, center: line.x1 })), 12);
    const supported = clusters.filter(cluster =>
      new Set(cluster.values.map(value => Math.round(value.line.baseline / 2))).size >= 2);
    const marked = new Set();
    for (const cluster of supported) {
      const baseline = Math.max(...cluster.values.map(value => value.line.baseline));
      for (const value of cluster.values) marked.add(value.line);
      for (const line of lines) {
        if (!short(line)) continue;
        if (Math.abs(line.baseline - baseline) > lineHeight * 4) continue;
        if (marked.has(line)) continue;
        marked.add(line);
      }
    }
    return marked;
  }

  function buildStructuredPage(pageIndex, chars, pageWidth, hints = {}) {
    const numbered = stripMarginNumbers(chars, pageWidth);
    const bodySize = bodyFontSize(numbered);
    const bodyChars = numbered.filter(char => char.fontSize >= bodySize * 0.75);
    const lines = visualLines(bodyChars, pageWidth);
    const title = normalized(hints.title || "");
    const creators = (hints.creators || []).map(normalized).filter(creator => creator.length >= 4);
    const columns = detectColumnStarts(lines, pageWidth);
    const lineColumn = line => !columns
      ? "single"
      : Math.abs(line.x1 - columns.left.center) <= Math.abs(line.x1 - columns.right.center) ? "left" : "right";
    let columnRanges = null;
    if (columns) {
      const ranges = { left: { x1: Infinity, x2: -Infinity }, right: { x1: Infinity, x2: -Infinity } };
      for (const line of lines) {
        if (line.x2 - line.x1 >= pageWidth * 0.55) continue;
        const key = lineColumn(line);
        ranges[key].x1 = Math.min(ranges[key].x1, line.x1);
        ranges[key].x2 = Math.max(ranges[key].x2, line.x2);
      }
      if (Number.isFinite(ranges.left.x1) && Number.isFinite(ranges.right.x1)) columnRanges = ranges;
    }
    const headingColumn = line => {
      if (!columns || !columnRanges) return lineColumn(line);
      const overlap = key => Math.max(0, Math.min(line.x2, columnRanges[key].x2) - Math.max(line.x1, columnRanges[key].x1));
      return overlap("left") >= overlap("right") ? "left" : "right";
    };
    const gaps = [];
    for (const column of new Set(lines.map(lineColumn))) {
      const group = lines.filter(line => lineColumn(line) === column)
        .sort((a, b) => b.baseline - a.baseline);
      for (let index = 1; index < group.length; index++) {
        const gap = group[index - 1].baseline - group[index].baseline;
        if (gap > 1 && gap < bodySize * 3) gaps.push(gap);
      }
    }
    const lineHeight = gaps.length ? median(gaps) : Math.max(bodySize * 1.2, 10);
    const tableLines = detectTableLines(lines, lineHeight);
    const captionLines = new Set();
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      if (!CAPTION_START.test(lines[lineIndex].text)) continue;
      const caption = lines[lineIndex];
      captionLines.add(lineIndex);
      let lastBaseline = caption.baseline;
      let lastText = caption.text;
      let continuationCount = 0;
      for (let cursor = lineIndex + 1; cursor < lines.length && continuationCount < 2; cursor++) {
        const line = lines[cursor];
        const gap = lastBaseline - line.baseline;
        if (gap <= 0) continue;
        if (lineColumn(line) !== lineColumn(caption)) continue;
        if (gap > lineHeight * 2.2) break;
        const overlaps = line.x1 <= caption.x2 + bodySize && line.x2 >= caption.x1 - bodySize;
        const continuation = !/[.!?]\s*$/.test(lastText)
          && gap <= lineHeight * 1.2
          && line.text.length <= lastText.length + 20;
        if (!overlaps && !continuation) break;
        captionLines.add(cursor);
        continuationCount++;
        lastBaseline = line.baseline;
        lastText = line.text;
      }
    }

    let heading = null;
    let keywordColumn = null;
    const suppressed = { left: false, right: false, single: false };
    let references = false;
    const eligible = [];

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      const text = line.text.trim();
      const key = normalized(text);
      if (!text || !key) continue;
      const column = lineColumn(line);
      const sectionColumn = headingColumn(line);
      const tooSmall = line.fontSize <= Math.max(3, bodySize * 0.9);
      const largeHeading = line.fontSize >= bodySize * 1.28;
      const textHeading = looksLikeHeading(text);
      const headingLike = !tooSmall && (textHeading || largeHeading || line.fontSize >= bodySize * 1.15);
      const section = headingLike ? sectionFromText(text) : null;

      if (!heading && lineIndex < 3 && headingLike) heading = section;

      if (/^(?:keywords?|keyterms?)$/i.test(key)) {
        keywordColumn = column;
        continue;
      }
      if (pageIndex === 0 && keywordColumn === column && line.x2 - line.x1 < pageWidth * 0.38 && !/[.!?]\s*$/.test(text)) {
        continue;
      }

      if (section === "abstract") suppressed[sectionColumn] = true;
      else if (section === "references") references = true;
      else if (section || largeHeading) suppressed[sectionColumn] = false;

      const titleMatch = pageIndex === 0 && key.length >= 6 && title.length >= 6
        && (title.includes(key) || key.includes(title));
      const creatorMatch = pageIndex === 0
        && creators.some(creator => key.includes(creator) || creator.includes(key));
      const lower = text.toLowerCase();
      const metadataLine = !/[.!?]\s*$/.test(text)
        && text.split(/\s+/).length <= 35
        && /contents\s+lists?\s+available|science\s*direct|journal\s+homepage|facult|universit|department|institute|pavillon|rue\b|street\b|road\b|avenue\b|postal\b|québec|quebec|canada\b|article\s+info/i.test(lower);
      const metadata = (pageIndex === 0 && (
        /doi\s*:|doi\.org|creative\s*commons|copyright|article\s+reuse|journal|corresponding\s+author|e-?mail\s*:|university|issn|sagepub|open\s+access|special\s+issue|online\s+supplementary\s+material|version\s+in\s+\w+\s+of\s+this\s+article|©/i.test(lower)
        || metadataLine
      )) || tooSmall;
      const hidden = line.fontSize <= Math.max(3, bodySize * 0.35);
      if (headingLike || titleMatch || creatorMatch || metadata || hidden) continue;
      if (captionLines.has(lineIndex) || tableLines.has(line)) continue;
      if (isPageNumberLine(text) || suppressed[column] || references) continue;
      eligible.push(line);
    }

    const orderedLines = readingOrder(eligible, pageWidth);
    const orderedChars = orderedLines.flatMap(line => line.chars);
    let text = "";
    const charMap = [];
    const blockRanges = [];
    let blockStart = 0;
    let blockFirstX = null;
    let previousLine = null;
    let charBase = 0;
    for (const line of orderedLines) {
      if (!line.chars.length) continue;
      const newBlock = previousLine && (
        lineColumn(line) !== lineColumn(previousLine)
        || previousLine.baseline - line.baseline > lineHeight * 1.45

      );
      if (!previousLine) {
        blockFirstX = line.x1;
      }
      else if (newBlock) {
        if (text.length > blockStart) blockRanges.push([blockStart, text.length]);
        text += " ";
        charMap.push(-1);
        blockStart = text.length;
        blockFirstX = line.x1;
      }
      else if (text.endsWith("-") && /^[a-zà-öø-ÿ]/.test(line.chars[0].c)) {
        text = text.slice(0, -1);
        charMap.pop();
      }
      else {
        text += " ";
        charMap.push(-1);
      }
      for (let index = 0; index < line.chars.length; index++) {
        const character = line.chars[index];
        if (index > 0) {
          const previous = line.chars[index - 1];
          const gap = character.rect[0] - previous.rect[2];
          if (gap > previous.fontSize * 0.18) {
            text += " ";
            charMap.push(-1);
          }
        }
        for (const value of character.c) {
          text += value;
          charMap.push(charBase + index);
        }
      }
      charBase += line.chars.length;
      previousLine = line;
    }
    if (text.length > blockStart) blockRanges.push([blockStart, text.length]);
    return { pageIndex, text, charMap, chars: orderedChars, width: pageWidth, heading, blockRanges };
  }

  async function extractPage(reader, pageIndex, hints = {}) {
    const handle = getHandle(reader);
    if (!handle) return null;
    const { win, app, Cu } = handle;
    const argument = Cu.cloneInto({ pageIndex }, win);
    const pageData = await app.pdfDocument.getPageData(argument);
    const rawChars = pageData?.chars;
    if (!rawChars || !rawChars.length) return { pageIndex, text: "", charMap: [], chars: [], width: 0, height: 0, heading: null };

    const viewBox = pageData.viewBox;
    const hasBox = Array.isArray(viewBox) && viewBox.length >= 4;
    const pageWidth = hasBox ? Number(viewBox[2]) - Number(viewBox[0]) : 0;
    const pageHeight = hasBox ? Number(viewBox[3]) - Number(viewBox[1]) : 0;
    const yMid = char => (char.rect[1] + char.rect[3]) / 2;

    const sizes = [];
    for (const char of rawChars) {
      if (!char.rotation && !char.diagonal) sizes.push(char.fontSize ?? 10);
    }
    sizes.sort((a, b) => a - b);
    const medianSize = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 10;

    const chars = [];
    for (const char of rawChars) {
      if (char.rotation || char.diagonal) continue;
      if (pageHeight > 0) {
        const y = yMid(char);
        if (y > pageHeight * 0.945 || y < pageHeight * 0.055) continue;
        if (y < pageHeight * 0.18 && (char.fontSize ?? 10) < medianSize * 0.82) continue;
      }
      chars.push({
        c: String(normalizedGlyph(String(char.u ?? char.c ?? ""))),
        rect: [char.rect[0], char.rect[1], char.rect[2], char.rect[3]],
        baseline: char.baseline ?? char.rect[1],
        fontSize: char.fontSize ?? 10
      });
    }
    if (!chars.length) return { pageIndex, text: "", charMap: [], chars: [], width: pageWidth, height: pageHeight, heading: null };
    const page = buildStructuredPage(pageIndex, chars, pageWidth, hints);
    page.height = pageHeight;
    return page;
  }

  function buildPageLines(page) {
    const lines = [];
    if (!page.chars.length) return lines;
    const textOfChar = new Array(page.chars.length).fill(-1);
    for (let textIndex = 0; textIndex < page.charMap.length; textIndex++) {
      const charIndex = page.charMap[textIndex];
      if (charIndex >= 0 && textOfChar[charIndex] < 0) textOfChar[charIndex] = textIndex;
    }
    let current = null;
    const flush = () => {
      if (!current) return;
      const startText = textOfChar[current.start] ?? 0;
      const lastText = textOfChar[current.end - 1] ?? startText;
      lines.push({
        startChar: current.start,
        endChar: current.end,
        startText,
        endText: lastText + 1,
        baseline: current.baseline,
        text: page.text.slice(startText, lastText + 1)
      });
    };
    for (let i = 0; i < page.chars.length; i++) {
      const char = page.chars[i];
      if (current && Math.abs(char.baseline - current.baseline) <= current.size * 0.5) {
        current.end = i + 1;
      }
      else {
        flush();
        current = { start: i, end: i + 1, baseline: char.baseline, size: char.fontSize };
      }
    }
    flush();
    return lines;
  }

  function pageLines(page) {
    if (!page._lines) page._lines = buildPageLines(page);
    return page._lines;
  }

  function furnitureKey(text) {
    return text.replace(/[\d\s]+/g, "").toLowerCase();
  }

  function analyzeZones(pages) {
    const zones = { furniture: new Map(), furnitureLineCount: 0, referenceStartPage: -1 };
    const paged = pages.filter(page => page.chars.length > 0);
    if (paged.length < MIN_REPEAT_PAGES) return zones;

    const linesByPage = new Map();
    for (const page of paged) linesByPage.set(page.pageIndex, pageLines(page));

    const occurrences = new Map();
    for (const page of paged) {
      const seenOnPage = new Set();
      for (const line of linesByPage.get(page.pageIndex)) {
        const key = furnitureKey(line.text);
        if (key.length < 5 || seenOnPage.has(key)) continue;
        seenOnPage.add(key);
        const yBucket = Math.round(line.baseline / Y_BAND_PT);
        if (!occurrences.has(key)) occurrences.set(key, []);
        occurrences.get(key).push({ pageIndex: page.pageIndex, yBucket, line });
      }
    }
    const minPages = Math.max(MIN_REPEAT_PAGES, Math.ceil(paged.length * REPEAT_PAGE_FRACTION));
    for (const occurrence of occurrences.values()) {
      if (occurrence.length < minPages) continue;
      const buckets = occurrence.map(item => item.yBucket);
      if (Math.max(...buckets) - Math.min(...buckets) > 1) continue;
      zones.furnitureLineCount++;
      for (const { pageIndex, line } of occurrence) {
        if (!zones.furniture.has(pageIndex)) zones.furniture.set(pageIndex, []);
        zones.furniture.get(pageIndex).push([line.startChar, line.endChar]);
      }
    }

    let start = -1;
    for (let i = paged.length - 1; i >= 0; i--) {
      const lines = linesByPage.get(paged[i].pageIndex).filter(line => line.text.trim().length > 10);
      const hits = lines.filter(line => refSignalScore(line.text) >= 1).length;
      const dense = lines.length > 0 && hits / lines.length >= REF_DENSITY && hits >= REF_MIN_HITS;
      if (dense) start = i;
      else if (start >= 0) break;
    }
    if (start >= 0) zones.referenceStartPage = paged[start].pageIndex;
    return zones;
  }

  function refSignalScore(text) {
    let score = 0;
    for (const signal of REF_SIGNALS) if (signal.test(text)) score++;
    return score;
  }

  function overlapsFurniture(zones, pageIndex, startChar, endChar) {
    const ranges = zones.furniture.get(pageIndex);
    if (!ranges) return false;
    for (const [start, end] of ranges) {
      if (startChar < end && endChar > start) return true;
    }
    return false;
  }

  function sectionAtPageStart(page) {
    if (page.heading) return page.heading;
    const lead = page.text.slice(0, 160).trimStart();
    for (const [marker, section] of SECTION_MARKERS) {
      marker.lastIndex = 0;
      const match = marker.exec(lead);
      if (match && match.index <= 12) return section;
    }
    return null;
  }

  function withDocumentSections(pages, sentences) {
    const sections = new Map();
    let active = "body";
    for (const page of pages) {
      const detected = sectionAtPageStart(page);
      if (detected) active = detected;
      sections.set(page.pageIndex, active);
    }
    return sentences.map(sentence => ({
      ...sentence,
      section: sections.get(sentence.pageIndex) || "body"
    }));
  }

  function limitWork(sentences) {
    const filtered = sentences.filter(sentence => sentence.section !== "references");
    return filtered.length ? filtered : sentences;
  }

  const BYLINE_TOKEN = /[A-Z][A-Za-z'’-]+\d[\d,]*/g;

  function bylineTrimOffset(text) {
    const head = text.slice(0, 240);
    BYLINE_TOKEN.lastIndex = 0;
    let matches = 0;
    let end = -1;
    let match;
    while ((match = BYLINE_TOKEN.exec(head))) {
      if (match.index > 140) break;
      matches++;
      end = match.index + match[0].length;
    }
    if (matches < 2 || end < 0) return 0;
    const rest = text.slice(end);
    const lead = rest.match(/^[\s,;&]*(?:and\s+)?/);
    return end + (lead ? lead[0].length : 0);
  }

  const LEADING_HEADING = /^(?:Phase\s*\d+\s*[:.]?|(?:Results?|Methods?|Methodology|Findings?|Discussion|Conclusions?|Introduction|Background|Abstract|Limitations?)(?:\s+(?:for|of|to|in)\s+(?:the\s+)?[A-Z][\w-]*(?:\s+[A-Z][\w-]*){0,2})?)\s*[:.]?\s+(?=[A-Z])/;

  function headingTrimOffset(text) {
    const match = LEADING_HEADING.exec(text);
    if (!match) return 0;
    if (!/^[A-Z]/.test(text.slice(match[0].length))) return 0;
    return match[0].length;
  }

  function medianFontSize(page, startChar, endChar) {
    const sizes = page.chars.slice(startChar, endChar).map(char => char.fontSize).sort((a, b) => a - b);
    return sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
  }

  function isSubtitleLine(page, line) {
    const text = line.text.trim();
    if (text.length < 4 || text.length > 180 || !/[A-Za-z]{3}/.test(text)) return false;
    const words = text
      .replace(/^\s*(?:\d+(?:\.\d+)*|[IVXLCDM]+)[.)-]?\s*/i, "")
      .match(/[A-Za-z][A-Za-z'’-]*/g);
    if (!words?.length || words.length > 16) return false;
    const numbered = /^\s*(?:\d+(?:\.\d+)*|[IVXLCDM]+)[.)-]?\s+/i.test(text);
    const capitals = words.filter(word => /^[A-Z]{2,}$/.test(word) || /^[A-Z]/.test(word)).length;
    const titleLike = capitals / words.length >= 0.65;
    const allCaps = words.every(word => word === word.toUpperCase());
    const lineSize = medianFontSize(page, line.startChar, line.endChar);
    const bodySize = medianFontSize(page, 0, page.chars.length);
    const typographic = lineSize > 0 && bodySize > 0 && lineSize >= bodySize * 1.12;
    const terminal = /[.!?]\s*$/.test(text);
    if (terminal && !typographic && !allCaps) return false;
    return numbered || titleLike || allCaps || typographic;
  }

  function subtitleTrimOffset(page, startText, endText) {
    const line = pageLines(page).find(candidate => startText >= candidate.startText && startText < candidate.endText);
    if (!line || !isSubtitleLine(page, line)) return 0;
    const next = Math.min(endText, line.endText);
    const remainder = page.text.slice(next, endText).trimStart();
    if (remainder.length < MIN_LEN) return -1;
    return next - startText + (page.text.slice(next, endText).length - remainder.length);
  }

  function pushSpan(page, out, startText, endText) {
    const raw = page.text.slice(startText, endText);
    const leadingWhitespace = raw.length - raw.trimStart().length;
    let text = raw.trim();
    let removedFront = 0;
    if (text.length < MIN_LEN || !/[a-zA-Z]{3}/.test(text)) return;
    if (page.pageIndex === 0) {
      const skip = bylineTrimOffset(text);
      if (skip > 0) {
        const kept = text.slice(skip).trimStart();
        if (kept.length < MIN_LEN) return;
        removedFront += text.length - kept.length;
        text = kept;
      }
    }
    const headSkip = headingTrimOffset(text);
    if (headSkip > 0) {
      const kept = text.slice(headSkip).trimStart();
      if (kept.length >= MIN_LEN) {
        removedFront += text.length - kept.length;
        text = kept;
      }
    }
    const currentStart = startText + leadingWhitespace + removedFront;
    const subtitleSkip = subtitleTrimOffset(page, currentStart, endText);
    if (subtitleSkip < 0) return;
    if (subtitleSkip > 0) {
      const kept = text.slice(subtitleSkip).trimStart();
      if (kept.length < MIN_LEN) return;
      removedFront += text.length - kept.length;
      text = kept;
    }
    if (removedFront > 0) startText += leadingWhitespace + removedFront;
    let startChar = -1;
    let endChar = -1;
    for (let i = startText; i < endText && i < page.charMap.length; i++) {
      if (page.charMap[i] >= 0) {
        if (startChar < 0) startChar = page.charMap[i];
        endChar = page.charMap[i] + 1;
      }
    }
    if (startChar >= 0 && endChar > startChar) out.push({ startChar, endChar, text });
  }

  function splitLongSegment(page, out, base, text) {
    const boundary = /[.;:!?»)]\s+/g;
    const cuts = [];
    let match;
    while ((match = boundary.exec(text))) cuts.push(match.index + match[0].length);
    cuts.push(text.length);
    let start = 0;
    for (const cut of cuts) {
      if (cut - start >= MAX_LEN * 0.6) {
        pushSpan(page, out, base + start, base + cut);
        start = cut;
      }
    }
    if (text.length - start >= MIN_LEN) pushSpan(page, out, base + start, base + text.length);
  }

  function sentenceSegments(text) {
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
      const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
      return [...segmenter.segment(text)].map(item => ({ index: item.index, segment: item.segment }));
    }
    const out = [];
    const pattern = /[^.!?]+(?:[.!?]+|$)/g;
    let match;
    while ((match = pattern.exec(text))) {
      if (match[0].trim()) out.push({ index: match.index, segment: match[0] });
    }
    return out;
  }

  function segmentSentences(page) {
    const out = [];
    if (!page.text) return out;
    const ranges = page.blockRanges?.length ? page.blockRanges : [[0, page.text.length]];
    for (const [start, end] of ranges) {
      const text = page.text.slice(start, end);
      for (const item of sentenceSegments(text)) {
        const raw = item.segment;
        const trimmed = raw.trim();
        if (trimmed.length < MIN_LEN || !/[a-zA-Z]{3}/.test(trimmed)) continue;
        const base = start + item.index + (raw.length - raw.trimStart().length);
        if (trimmed.length <= MAX_LEN) pushSpan(page, out, base, base + trimmed.length);
        else splitLongSegment(page, out, base, trimmed);
      }
    }
    return out;
  }

  function rangeToLineRects(page, startChar, endChar) {
    const rects = [];
    let current = null;
    let currentBaseline = NaN;
    for (let i = startChar; i < endChar && i < page.chars.length; i++) {
      const char = page.chars[i];
      const [x1, y1, x2, y2] = char.rect;
      if (current && Math.abs(char.baseline - currentBaseline) <= char.fontSize * 0.5) {
        current[0] = Math.min(current[0], x1);
        current[1] = Math.min(current[1], y1);
        current[2] = Math.max(current[2], x2);
        current[3] = Math.max(current[3], y2);
      }
      else {
        if (current) rects.push(current);
        current = [x1, y1, x2, y2];
        currentBaseline = char.baseline;
      }
    }
    if (current) rects.push(current);
    const sizes = page.chars.slice(startChar, endChar).map(char => char.fontSize);
    const maxHeight = (sizes.length ? Math.max(...sizes) : 40) * 2.5;
    return rects.filter(rect => rect[3] - rect[1] <= maxHeight);
  }

  function cleanText(value) {
    return String(value || "")
      .replace(/\u00ad/g, "")
      .replace(/([A-Za-zÀ-ÖØ-öø-ÿ]{2,})-\s+([a-zà-öø-ÿ]{2,})/g, "$1$2")
      .replace(/([a-zà-öø-ÿ0-9])([.!?])(?=[A-ZÀ-ÖØ-Þ])/g, "$1$2 ")
      .replace(/\s+([,.;:!?])/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
  }

  async function extractDocument(reader, attachment, onProgress = null) {
    const wait = () => typeof Zotero !== "undefined" && Zotero.Promise?.delay
      ? Zotero.Promise.delay(250)
      : new Promise(resolve => setTimeout(resolve, 250));
    for (let attempt = 0; attempt < 20 && !isAvailable(reader); attempt++) await wait();
    if (!isAvailable(reader)) throw new Error("The PDF reader is not ready. Open the PDF and try again.");
    const pageCount = getPageCount(reader);
    if (!pageCount) throw new Error("The reader did not report any pages.");
    const hints = hintsForAttachment(attachment);
    const pages = [];
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
      const page = await extractPage(reader, pageIndex, hints);
      if (page?.text) pages.push(page);
      onProgress?.((pageIndex + 1) / pageCount, pageIndex + 1, pageCount);
      await Promise.resolve();
    }
    if (!pages.length) throw new Error("No extractable text was found. Run OCR first if this is a scanned PDF.");

    const zones = analyzeZones(pages);
    const sentences = [];
    let order = 0;
    for (const page of pages) {
      for (const sentence of segmentSentences(page)) {
        if (overlapsFurniture(zones, page.pageIndex, sentence.startChar, sentence.endChar)) continue;
        const rects = rangeToLineRects(page, sentence.startChar, sentence.endChar);
        if (!rects.length) continue;
        sentences.push({
          pageIndex: page.pageIndex,
          pageHeight: page.height,
          section: "body",
          rects,
          ...sentence,
          order: order++
        });
      }
    }
    if (!sentences.length) throw new Error("No usable sentences were found in this PDF.");

    let processed = withDocumentSections(pages, sentences);
    if (zones.referenceStartPage >= 0) {
      for (const sentence of processed) {
        if (sentence.pageIndex > zones.referenceStartPage
          || (sentence.pageIndex === zones.referenceStartPage && refSignalScore(sentence.text) >= 1)) {
          sentence.section = "references";
        }
      }
    }
    processed = limitWork(processed);
    return {
      sentences: processed,
      pages,
      pageCount,
      referenceStartPage: zones.referenceStartPage,
      furnitureLineCount: zones.furnitureLineCount
    };
  }

  return {
    getHandle,
    isAvailable,
    getPageCount,
    hintsForAttachment,
    buildStructuredPage,
    detectColumnStarts,
    readingOrder,
    extractPage,
    pageLines,
    analyzeZones,
    refSignalScore,
    overlapsFurniture,
    sectionAtPageStart,
    withDocumentSections,
    segmentSentences,
    rangeToLineRects,
    cleanText,
    extractDocument
  };
})();
