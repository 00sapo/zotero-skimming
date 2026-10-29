# PDF extraction corpus

This corpus contains 18 PDFs and independent expected text. Ground truth means the expected prose and sentence order.

The assistant reviewed rendered pages and text from an independent PDF parser. No human reviewed these annotations. The production extractor did not generate the expected text.

## Coverage

The controlled matrix contains all 16 combinations of these four factors.

| Factor | First value | Second value |
|---|---|---|
| Prose layout | One column | Two columns |
| Printed line numbers | Absent | Present |
| Table width | One column | Two columns |
| Image width | One column | Two columns |

For one-column prose, a one-column object uses about half the text width. A two-column object uses the full text width. For two-column prose, these values mean a normal float and a spanning float.

Each controlled PDF contains three pages, a text table, a raster illustration, captions, headings, ordinary numeric prose, and a bibliography. LaTeX places some floats on the following page. Several sentences cross a page boundary.

The 16 variants contain the same 22 authored body sentences. All 48 pages are annotated. The assistant reviewed rendered sheets for every variant and matched the authored prose against independent PDF text.

The two downloaded PDFs remain unchanged. Their annotations cover selected original pages only.

| Original template | Annotated page index | Source |
|---|---|---|
| Two-column conference paper | 0, 1 | [Iroro Orife template](https://github.com/ruohoruotsi/latex-template-arxiv-preprint/tree/ac24f569abb5f67cdbf00cac88b707738fbd52da) |
| One-column research paper | 1, 2, 5, 13, 15 | [Pascal Michaillat template](https://github.com/pmichaillat/latex-paper/tree/f8afa108da12b18f8b059b81b2ccba23bd4ee7aa) |

Page 13 of the one-column paper holds a floating table with grouped column headings, Greek table cells, and a table note, so the annotated prose on that page is interrupted by a float. Page 13 also starts inside a sentence that continues from page 11 across the full-page figure on page 12; that opening text is recorded as a fragment.

Page 5 holds inline math, display equations, Greek letters, and dense digits. Page 15 holds a quotation block, run-in labels, and the conclusion. Display equations and equation numbers are excluded. Prose that contains inline math remains expected.

Both repositories declare the MIT license. The `upstream` directory retains their licenses, source files, pinned revisions, download URLs, and original file hashes.

The controlled variants use the downloaded `simpleConference.sty` with authored content. The builder changes the prose layout and adds line numbers and floats. It shortens the text area to expose column and page transitions.

## Annotation format

Each ground-truth JSON file contains ordered body sentences and excluded text. Exclusions identify captions, table cells, references, metadata, abstract text, or footnotes. Short body sentences remain expected even when the current extractor drops them.

Page indexes start at zero. An `endPageIndex` records a sentence that continues on another page. A `fragments` array records incomplete text at the boundary of an annotated scope. Word metrics include these fragments, but exact sentence metrics do not.

The controlled illustration contains raster labels. Those labels are visible pixels, not PDF text. The corpus does not test optical character recognition or scanned pages.

The geometry files contain characters and their coordinates from PyMuPDF 1.26.7. Coordinates use PDF points with the origin at the bottom left. Unannotated original pages retain their dimensions but contain no characters in the replay data.

`manifest.json` records the PDF, annotation, and geometry hashes. The evaluator rejects mismatched assets. These hashes detect stale files but do not prove annotation accuracy.

## Evaluation

On the development host, install the existing JavaScript dependencies first.

```sh
yarn install
yarn test
```

The test suite replays committed character geometry through `extractDocument()`. It needs no network, Python, LaTeX, Zotero, Ollama, or downloaded model.

For a quality report, use Node.js from the repository root.

```sh
node scripts/evaluate-extraction.mjs --baseline test/fixtures/pdf-extraction/baseline.json --output /tmp/extraction-report.json
```

The report contains these measurements.

- Sentence sensitivity measures the fraction of expected sentences recovered exactly. It includes sentences that continue across a page break.
- Negative specificity measures the fraction of annotated non-body line units where no glyph is claimed.
- Balanced accuracy is the mean of sentence sensitivity and negative specificity, averaged across PDFs.
- Character balanced accuracy repeats the check for every labeled glyph.
- Exact sentence recall measures the fraction of expected sentences recovered as one extraction.
- Word precision measures how much extracted text belongs to expected prose.
- Word recall measures how much expected prose appears in extracted text.
- Excluded leakage counts annotated excluded phrases that appear in the output.
- Reading-order inversions count reversed pairs of uniquely matched sentences.
- Rectangle validity measures finite rectangles with positive width and height.

Word metrics count repeated words separately. Excluded leakage ignores phrases that also occur in expected prose. It matches whole phrases and does not detect every partial reference or table fragment. Order measurements cover exact matches that occur once in each text. A zero inversion count does not prove correct order when sentence recall is low.

The test suite requires at least 99 percent balanced accuracy, sentence sensitivity, and negative specificity. It also rejects lower recall, lower precision, more leakage, more order inversions, or lower rectangle validity for any case. The committed corpus reaches 99.67 percent balanced accuracy, 99.96 percent sentence sensitivity, and 99.38 percent negative specificity. Passing these tests means the measured corpus passes, not that every unseen PDF extracts perfectly.

The replay uses PyMuPDF geometry rather than the Zotero reader parser. It tests layout processing after character extraction. It does not replace a real Zotero smoke test or prove that rectangles align with the reader on every PDF.

## Rebuild

On the development host, install Python 3.10 or later, `pdflatex`, and the required TeX packages. The builder needs `article`, `times`, `fontenc`, `graphicx`, and `lineno`.

From the repository root, create a separate Python environment.

```sh
python3 -m venv /tmp/zotero-pdf-fixtures-venv
/tmp/zotero-pdf-fixtures-venv/bin/pip install PyMuPDF==1.26.7
/tmp/zotero-pdf-fixtures-venv/bin/python scripts/build-extraction-fixtures.py
```

The builder compiles LaTeX in a temporary directory. It writes only retained fixtures into the repository. It fixes the PDF date, but another TeX version can produce different PDF bytes.

If only the parser or annotations change, refresh geometry and hashes without recompiling PDFs.

```sh
/tmp/zotero-pdf-fixtures-venv/bin/python scripts/build-extraction-fixtures.py --geometry-only
```

Review the rendered PDFs before you accept regenerated fixtures. Make sure that the expected text remains independent of production output. Do not update annotations to match extraction mistakes.

After a reviewed corpus change, record a new baseline with Node.js.

```sh
node scripts/evaluate-extraction.mjs --output test/fixtures/pdf-extraction/baseline.json
```

Review every changed quality metric before you commit the baseline. A baseline update can otherwise hide an extraction regression.
