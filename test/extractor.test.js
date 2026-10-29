import { describe, expect, it } from "vitest";
import { loadScript } from "./helpers.js";

function extractor() {
  return loadScript("content/extractor.js").FastKeySentenceExtractor;
}

function textLine(text, x, baseline, size = 10) {
  let cursor = x;
  return [...text].map(character => {
    const char = {
      c: character,
      rect: [cursor, baseline, cursor + 4, baseline + size],
      baseline,
      fontSize: size
    };
    cursor += 4;
    return char;
  });
}

function pageFromLines(pageIndex, width, height, lines) {
  let text = "";
  const charMap = [];
  const chars = [];
  for (const line of lines) {
    if (text) {
      text += " ";
      charMap.push(-1);
    }
    for (const char of line) {
      for (const character of char.c) {
        text += character;
        charMap.push(chars.length);
      }
      chars.push(char);
    }
  }
  return { pageIndex, width, height, text, charMap, chars };
}

describe("FastKeySentenceExtractor", () => {
  it("orders two columns and maps prose to character ranges", () => {
    const api = extractor();
    const left = [
      textLine("Left column starts with a clear statement.", 40, 700),
      textLine("It continues with more supporting detail.", 40, 680),
      textLine("It finishes with a final remark.", 40, 660)
    ];
    const right = [
      textLine("Right column starts with another idea.", 340, 700),
      textLine("It also continues with evidence and detail.", 340, 680),
      textLine("It ends with the last observation.", 340, 660)
    ];
    const page = api.buildStructuredPage(1, [...left, ...right].flat(), 600, {});
    expect(page.text.indexOf("Left column")).toBeLessThan(page.text.indexOf("Right column"));
    expect(page.text).toContain("Left column starts with a clear statement.");
    const ranges = api.segmentSentences(page);
    expect(ranges.length).toBeGreaterThanOrEqual(2);
    const rects = api.rangeToLineRects(page, ranges[0].startChar, ranges[0].endChar);
    expect(rects.length).toBeGreaterThan(0);
    expect(rects[0][2]).toBeGreaterThan(rects[0][0]);
  });

  it("records section headings that are removed from running prose", () => {
    const api = extractor();
    const lines = [
      textLine("Introduction", 40, 760, 16),
      textLine("This paper studies whether a short method improves results.", 40, 720),
      textLine("We evaluate the method on several public datasets.", 40, 700)
    ];
    const page = api.buildStructuredPage(1, lines.flat(), 600, {});
    expect(page.heading).toBe("introduction");
    expect(page.text).not.toContain("Introduction");
    const sentences = api.segmentSentences(page).map(item => ({ pageIndex: 1, ...item }));
    expect(api.withDocumentSections([page], sentences)[0].section).toBe("introduction");
  });

  it("drops title and author metadata on the first page", () => {
    const api = extractor();
    const lines = [
      textLine("A Very Long Article Title About Testing", 40, 760),
      textLine("Alice Smith and Bob Jones", 40, 730),
      textLine("This first paragraph contains the actual prose sentence for extraction.", 40, 690)
    ];
    const page = api.buildStructuredPage(0, lines.flat(), 600, { title: "A Very Long Article Title About Testing", creators: ["Alice Smith", "Bob Jones"] });
    expect(page.text).toContain("actual prose sentence");
    expect(page.text).not.toContain("Alice Smith");
    expect(page.text).not.toContain("A Very Long Article Title");
  });

  it("detects repeated headers and a trailing reference zone", () => {
    const api = extractor();
    const pages = [];
    for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
      pages.push(pageFromLines(pageIndex, 600, 800, [
        textLine("Journal of Testing and Results", 40, 780),
        textLine(`Body prose with ${["alpha", "beta", "gamma", "delta"][pageIndex]} words to count.`, 40, 500)
      ]));
    }
    const zones = api.analyzeZones(pages);
    expect(zones.furnitureLineCount).toBe(1);
    expect(api.overlapsFurniture(zones, 0, 0, 5)).toBe(true);

    const references = [];
    for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
      const lines = [textLine(`Body prose on page ${pageIndex} is still here.`, 40, 500)];
      if (pageIndex >= 2) {
        for (let entry = 0; entry < 6; entry++) {
          lines.push(textLine(`[${entry + 1}] Smith, J. 2020. A useful paper.`, 40, 450 - entry * 12));
        }
      }
      references.push(pageFromLines(pageIndex, 600, 800, lines));
    }
    expect(api.analyzeZones(references).referenceStartPage).toBe(2);
  });

  it("cleans hyphenation and splits long text at clauses", () => {
    const api = extractor();
    expect(api.cleanText("informa-\ntion  retrieval .")).toBe("information retrieval.");
    const page = pageFromLines(1, 600, 800, [
      textLine("First sentence with enough words to pass the minimum length requirement for extraction.", 40, 700),
      textLine("Second sentence also has enough words to pass the minimum length requirement here.", 40, 680)
    ]);
    expect(api.segmentSentences(page)).toHaveLength(2);
  });

  it("removes printed line numbers before joining sentences", () => {
    const api = extractor();
    const lines = [
      textLine("1", 8, 700).concat(textLine("First numbered line carries complete prose for recovery.", 40, 700)),
      textLine("2", 8, 688).concat(textLine("Second numbered line continues the same paragraph.", 40, 688)),
      textLine("3", 8, 676).concat(textLine("Third numbered line ends the recovered paragraph.", 40, 676)),
      textLine("4", 8, 664).concat(textLine("Fourth numbered line provides another complete sentence.", 40, 664))
    ];
    const page = api.buildStructuredPage(1, lines.flat(), 600, {});
    expect(page.text).not.toMatch(/(?:^|\s)[1-4](?:\s|$)/);
    expect(page.text).toContain("First numbered line");
    expect(api.segmentSentences(page)).toHaveLength(4);
  });

  it("drops bullet markers, superscripts, captions, and numeric table cells", () => {
    const api = extractor();
    const bullet = textLine("• What is the problem?", 40, 720);
    const superscript = textLine("A complete sentence ends here.", 40, 700);
    superscript.push(...textLine("1", 178, 703, 7).map(char => ({ ...char, fontSize: 7 })));
    const caption = textLine("Figure 1. A visible caption runs", 40, 670);
    const captionTail = textLine("across another caption line.", 40, 658);
    const rows = [
      textLine("Control", 40, 620).concat(textLine("12.4", 300, 620)),
      textLine("Revised", 40, 608).concat(textLine("18.7", 300, 608)),
      textLine("Repeated", 40, 596).concat(textLine("17.9", 300, 596))
    ];
    const body = textLine("Ordinary prose remains available after the excluded material in this paragraph.", 40, 560);
    const page = api.buildStructuredPage(1, [bullet, superscript, caption, captionTail, ...rows, body].flat(), 600, {});
    expect(page.text).toContain("What is the problem?");
    expect(page.text).not.toContain("•");
    expect(page.text).not.toMatch(/here\.1/);
    expect(page.text).not.toContain("visible caption");
    expect(page.text).not.toContain("across another caption line");
    expect(page.text).not.toContain("Control");
    expect(page.text).not.toContain("12.4");
    expect(page.text).toContain("Ordinary prose remains available");
  });

  it("keeps short legitimate prose sentences", () => {
    const api = extractor();
    const page = pageFromLines(1, 600, 800, [
      textLine("Research question.", 40, 700),
      textLine("A paragraph.", 40, 680)
    ]);
    expect(api.segmentSentences(page).map(item => item.text)).toEqual(["Research question.", "A paragraph."]);
  });

  it("extracts sentences from the reader document", async () => {
    const api = loadScript("content/extractor.js", {
      Components: { utils: { waiveXrays: value => value, cloneInto: value => value } },
      Zotero: { Promise: { delay: async () => {} }, Items: { get: () => null } }
    }).FastKeySentenceExtractor;
    const chars = textLine("This first paragraph contains a complete prose sentence that is long enough to survive the front-matter filter used by the extractor.", 40, 700)
      .map(char => ({ ...char, u: char.c, rotation: 0, diagonal: false, rect: char.rect.slice() }));
    const reader = {
      _internalReader: {
        _primaryView: {
          _iframeWindow: {
            PDFViewerApplication: {
              pagesCount: 1,
              pdfDocument: {
                getPageData: async () => ({ viewBox: [0, 0, 600, 800], chars })
              }
            }
          }
        }
      }
    };
    expect(api.isAvailable(reader)).toBe(true);
    const result = await api.extractDocument(reader, { parentItem: null });
    expect(result.pageCount).toBe(1);
    expect(result.sentences.length).toBe(1);
    expect(result.sentences[0].text).toContain("complete prose sentence");
    expect(result.sentences[0].rects.length).toBeGreaterThan(0);
  });
});
