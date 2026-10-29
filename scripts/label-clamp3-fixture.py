#!/usr/bin/env python3
"""Label body and non-body characters for the curated CLaMP 3 fixture.

Body characters come from the text blocks that contain curated sentences. Block
membership avoids fragile glyph alignment around superscripts, math, and
ligatures. Non-body units are contiguous runs of other visible characters on
each PDF text line.
"""
import gzip
import hashlib
import json
import re
import unicodedata
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "test/fixtures/pdf-extraction"
CASE_ID = "clamp3-acl-2025"
HYPHENS = {"-", "\u2010", "\u2011", "\u00ad"}


def canonical(text):
    return "".join(char for char in unicodedata.normalize("NFKC", text).lower()
                   if not char.isspace() and char not in HYPHENS)


def block_payload(page):
    chars = []
    for block in page.get_text("rawdict", flags=0)["blocks"]:
        for line in block.get("lines", []):
            for span in line["spans"]:
                for char in span["chars"]:
                    x1, y1, x2, y2 = char["bbox"]
                    chars.append({"text": char["c"], "center": ((x1 + x2) / 2, (y1 + y2) / 2)})
    return chars


def body_blocks(page, sentences):
    """Return block rectangles that hold at least one curated sentence."""
    wanted = [canonical(sentence["text"]) for sentence in sentences]
    wanted = [text for text in wanted if len(text) >= 40]
    marked = []
    for block in page.get_text("blocks"):
        x1, y1, x2, y2, text, *_ = block
        block_text = canonical(text)
        if not block_text:
            continue
        if any(needle in block_text or block_text in needle for needle in wanted):
            marked.append((x1, y1, x2, y2))
            continue
        # Superscripts and footnote markers can drop characters from the raw
        # stream. Compare a digit-free prefix to keep the block attributable.
        prefix = re.sub(r"\d", "", block_text)[:80]
        if len(prefix) >= 40 and any(prefix in re.sub(r"\d", "", needle) for needle in wanted):
            marked.append((x1, y1, x2, y2))
    return marked


def label_case(truth_path, pdf_path):
    truth = json.loads(truth_path.read_text())
    by_page = {}
    for sentence in truth["sentences"]:
        by_page.setdefault(sentence["pageIndex"], []).append(sentence)
    pages = []
    with pymupdf.open(pdf_path) as document:
        for page_index, page in enumerate(document):
            rects = body_blocks(page, by_page.get(page_index, []))
            chars = block_payload(page)

            def inside(center):
                return any(x1 - 0.5 <= center[0] <= x2 + 0.5 and y1 - 0.5 <= center[1] <= y2 + 0.5
                           for x1, y1, x2, y2 in rects)

            positive = {index for index, char in enumerate(chars) if inside(char["center"])}
            negatives = []
            run = []
            for index, char in enumerate(chars):
                text = char["text"]
                if not text or text.isspace() or index in positive:
                    if run:
                        negatives.append({"charIndices": run, "kind": "non-body"})
                        run = []
                elif text:
                    run.append(index)
            if run:
                negatives.append({"charIndices": run, "kind": "non-body"})
            pages.append({"pageIndex": page_index, "positiveCharIndices": sorted(positive),
                          "negativeUnits": negatives})
    payload = json.dumps({"pages": pages}, separators=(",", ":"), ensure_ascii=False).encode()
    labels_path = truth_path.with_name(truth_path.name + ".labels.json.gz")
    labels_path.write_bytes(gzip.compress(payload, mtime=0))
    return labels_path


def main():
    manifest_path = FIXTURES / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    case = next(case for case in manifest["cases"] if case["id"] == CASE_ID)
    labels_path = label_case(FIXTURES / case["groundTruth"], FIXTURES / case["pdf"])
    case["labels"] = str(labels_path.relative_to(FIXTURES))
    case["labelsSha256"] = hashlib.sha256(labels_path.read_bytes()).hexdigest()
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"{CASE_ID}: {case['labelsSha256']}")


if __name__ == "__main__":
    main()
