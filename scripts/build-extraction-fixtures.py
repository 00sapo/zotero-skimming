#!/usr/bin/env python3
"""Rebuild controlled PDF fixtures with LaTeX and independent character geometry."""
import argparse
import gzip
import hashlib
import itertools
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unicodedata

import pymupdf

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "test/fixtures/pdf-extraction"
MATRIX = FIXTURES / "matrix"


def normalized(text):
    return " ".join(unicodedata.normalize("NFKC", text).replace("\u00ad", "").split())


def geometry(document):
    pages = []
    for page in document:
        height = page.rect.height
        chars = []
        for block in page.get_text("rawdict", flags=0)["blocks"]:
            for line in block.get("lines", []):
                for span in line["spans"]:
                    for char in span["chars"]:
                        x1, y1, x2, y2 = char["bbox"]
                        chars.append({"u": char["c"], "rect": [x1, height-y2, x2, height-y1],
                                      "baseline": height-char["origin"][1], "fontSize": span["size"],
                                      "rotation": 0, "diagonal": False})
        pages.append({"viewBox": [0, 0, page.rect.width, height], "chars": chars})
    return {"pages": pages}


def source(content, columns, numbered, table_span, image_span):
    table_env = "table*" if columns == 2 and table_span == 2 else "table"
    figure_env = "figure*" if columns == 2 and image_span == 2 else "figure"
    table_width = r"\textwidth" if table_span == 2 else r"0.46\textwidth"
    image_width = r"\textwidth" if image_span == 2 else r"0.46\textwidth"
    numbering = r"\linenumbers" if numbered else ""
    # Actual template dimensions and typography come from the downloaded style.
    header = rf"""\documentclass[10pt,{'twocolumn' if columns == 2 else 'onecolumn'}]{{article}}
\usepackage{{simpleConference}}
\usepackage[T1]{{fontenc}}
\usepackage{{times,graphicx,lineno}}
\setlength{{\textheight}}{{6.7in}}
\setlength{{\parskip}}{{5pt}}
\pagestyle{{plain}}
\hyphenpenalty=10000
\exhyphenpenalty=10000
\begin{{document}}
\title{{{content['title']}}}
\author{{Alex Researcher}}
\date{{}}
\maketitle
{numbering}
\section{{Introduction}}
"""
    table = rf"""\begin{{{table_env}}}[t]
\centering
\begin{{tabular*}}{{{table_width}}}{{@{{\extracolsep{{\fill}}}}lr}}
\hline
Treatment & Response \\
\hline
Control & 12.4 \\
Revised & 18.7 \\
Repeated & 17.9 \\
\hline
\end{{tabular*}}
\caption{{Treatment measurements from the controlled study.}}
\end{{{table_env}}}
"""
    figure = rf"""\begin{{{figure_env}}}[t]
\centering
\includegraphics[width={image_width},height=55pt]{{pathway.png}}
\caption{{Measurement pathway used during the controlled study.}}
\end{{{figure_env}}}
"""
    paragraphs = []
    for index in range(0, len(content["sentences"]), 2):
        if index == 4:
            paragraphs.append(table)
        if index == 10:
            paragraphs.append(figure)
        if index == 12:
            paragraphs.append(r"\section{Results}")
        paragraphs.append(" ".join(content["sentences"][index:index+2]) + "\n\n")
    references = "\n\n".join(content["references"])
    return header + "\n".join(paragraphs) + rf"""
\clearpage
\nolinenumbers
\section*{{References}}
{references}
\end{{document}}
"""


def build(output):
    content = json.loads((MATRIX / "content.json").read_text())
    style = FIXTURES / "upstream/ruohoruotsi/simpleConference.sty"
    if not style.exists():
        raise SystemExit("Download the pinned conference template files before rebuilding.")
    output.mkdir(parents=True, exist_ok=True)
    cases = []
    with tempfile.TemporaryDirectory(prefix="zotero-extraction-latex-") as temporary:
        work = Path(temporary)
        shutil.copyfile(style, work / "simpleConference.sty")
        image_doc = pymupdf.open()
        image_page = image_doc.new_page(width=400, height=70)
        image_page.draw_rect(pymupdf.Rect(5, 5, 150, 65), color=(0, 0, 0))
        image_page.draw_rect(pymupdf.Rect(250, 5, 395, 65), color=(0, 0, 0))
        image_page.insert_text((20, 40), "Input signal", fontsize=14)
        image_page.insert_text((260, 40), "Measured response", fontsize=12)
        image_page.draw_line((150, 35), (250, 35), color=(0, 0, 0))
        image_page.get_pixmap(matrix=pymupdf.Matrix(2, 2)).save(work / "pathway.png")
        shutil.copyfile(work / "pathway.png", output / "pathway.png")
        for columns, numbered, table_span, image_span in itertools.product((1, 2), (False, True), (1, 2), (1, 2)):
            case_id = f"columns-{columns}_lines-{int(numbered)}_table-{table_span}_image-{image_span}"
            tex = source(content, columns, numbered, table_span, image_span)
            (work / "case.tex").write_text(tex)
            environment = {**os.environ, "SOURCE_DATE_EPOCH": "1704067200", "FORCE_SOURCE_DATE": "1"}
            for _ in range(2):
                result = subprocess.run(["pdflatex", "-interaction=nonstopmode", "-halt-on-error", "case.tex"],
                                        cwd=work, env=environment, capture_output=True, text=True)
                if result.returncode:
                    raise RuntimeError(result.stdout[-6000:])
            pdf = output / f"{case_id}.pdf"
            shutil.copyfile(work / "case.pdf", pdf)
            (output / f"{case_id}.tex").write_text(tex)
            with pymupdf.open(pdf) as document:
                page_texts = [normalized(" ".join(line for line in page.get_text().splitlines()
                                                if not line.strip().isdigit())) for page in document]
                # Ground truth comes from authored prose, never from production extraction.
                # Page location is resolved from the independent parser and checked below.
                sentences = []
                for text in content["sentences"]:
                    matches = [index for index, page_text in enumerate(page_texts)
                               if normalized(text) in page_text]
                    if len(matches) == 1:
                        sentences.append({"text": text, "pageIndex": matches[0]})
                        continue
                    matches = [index for index in range(len(page_texts) - 1)
                               if normalized(text) in page_texts[index] + " " + page_texts[index + 1]]
                    if len(matches) != 1:
                        raise RuntimeError(f"Cannot locate authored sentence in {case_id}: {text}")
                    sentences.append({"text": text, "pageIndex": matches[0], "endPageIndex": matches[0] + 1})
                excluded = []
                for kind, texts in (("reference", content["references"]), ("table", content["table"]),
                                    ("caption", [content["tableCaption"], content["figureCaption"]]),
                                    ("metadata", [content["title"], *content["creators"]])):
                    for text in texts:
                        matches = [index for index, page in enumerate(document) if page.search_for(text)]
                        # Captions use the upstream style's period separator, not a colon.
                        if not matches and kind == "caption":
                            text = text.replace(":", ".", 1)
                            matches = [index for index, page in enumerate(document) if page.search_for(text)]
                        if not matches:
                            raise RuntimeError(f"Cannot locate exclusion in {case_id}: {text}")
                        excluded.append({"text": text, "kind": kind, "pageIndex": matches[0]})
                truth = {"title": content["title"], "creators": content["creators"],
                         "sentences": sentences, "excluded": excluded,
                         "annotationMethod": "Authored prose checked against rendered PDFs by the assistant. Raster image labels are not PDF text."}
                (output / f"{case_id}.truth.json").write_text(json.dumps(truth, indent=2) + "\n")
                payload = json.dumps(geometry(document), separators=(",", ":")).encode()
                (output / f"{case_id}.geometry.json.gz").write_bytes(gzip.compress(payload, mtime=0))
                cases.append({"id": case_id, "pdf": f"matrix/{case_id}.pdf",
                              "groundTruth": f"matrix/{case_id}.truth.json",
                              "geometry": f"matrix/{case_id}.geometry.json.gz",
                              "sha256": hashlib.sha256(pdf.read_bytes()).hexdigest(),
                              "layout": {"columns": columns, "numberedLines": numbered,
                                         "tableSpan": table_span, "imageSpan": image_span},
                              "source": "Controlled derivative of the MIT-licensed simpleConference template",
                              "annotationScope": {"pages": list(range(len(document))), "completePages": True}})
                print(f"{case_id}: {len(document)} pages, {len(sentences)} body sentences")
    (output / "cases.json").write_text(json.dumps(cases, indent=2) + "\n")


def refresh_manifest():
    cases = json.loads((MATRIX / "cases.json").read_text())
    cases += json.loads((FIXTURES / "upstream/cases.json").read_text())["cases"]
    for case in cases:
        pdf = FIXTURES / case["pdf"]
        digest = hashlib.sha256(pdf.read_bytes()).hexdigest()
        if digest != case["sha256"]:
            raise RuntimeError(f"PDF changed without updated provenance: {pdf}")
        with pymupdf.open(pdf) as document:
            data = geometry(document)
        scope = set(case["annotationScope"]["pages"])
        for index, page in enumerate(data["pages"]):
            if index not in scope:
                page["chars"] = []
        geometry_path = FIXTURES / case["geometry"]
        geometry_path.write_bytes(gzip.compress(json.dumps(data, separators=(",", ":")).encode(), mtime=0))
        case["geometrySha256"] = hashlib.sha256(geometry_path.read_bytes()).hexdigest()
        case["groundTruthSha256"] = hashlib.sha256((FIXTURES / case["groundTruth"]).read_bytes()).hexdigest()
    manifest = {"schemaVersion": 1, "geometryParser": f"PyMuPDF {pymupdf.VersionBind}",
                "coordinateSystem": "PDF bottom-left origin in points",
                "cases": cases}
    (FIXTURES / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--geometry-only", action="store_true", help="Refresh geometry and hashes without compiling PDFs or rewriting annotations.")
    arguments = parser.parse_args()
    if not arguments.geometry_only:
        build(MATRIX)
    refresh_manifest()
