#!/usr/bin/env python3
"""Copy the CLaMP 3 paper and refresh its extraction geometry and manifest hashes.

The ground truth is curated by hand in `ground-truth.json`; this script never
rewrites it. Run with PyMuPDF, for example through `uv run --with PyMuPDF`.
"""
import gzip
import hashlib
import json
import shutil
import sys
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "test/fixtures/pdf-extraction"
CASE_ID = "clamp3-acl-2025"
DEFAULT_SOURCE = Path("/home/federico/Zotero/storage/9RW2ZCXF/Wu et al. - 2025 - CLaMP 3 universal music information retrieval across unaligned modalities and unseen languages.pdf")


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
                        chars.append({
                            "u": char["c"],
                            "rect": [x1, height - y2, x2, height - y1],
                            "baseline": height - char["origin"][1],
                            "fontSize": span["size"],
                            "rotation": 0,
                            "diagonal": False,
                        })
        pages.append({"viewBox": [0, 0, page.rect.width, height], "chars": chars})
    return {"pages": pages}


def main():
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SOURCE
    if not source.is_file():
        raise SystemExit(f"Source PDF not found: {source}")
    target = FIXTURES / "clamp3"
    truth_path = target / "ground-truth.json"
    if not truth_path.is_file():
        raise SystemExit(f"Curated ground truth not found: {truth_path}")
    target.mkdir(parents=True, exist_ok=True)
    pdf_path = target / "clamp3.pdf"
    shutil.copyfile(source, pdf_path)
    with pymupdf.open(pdf_path) as document:
        page_count = len(document)
        geometry_path = target / "geometry.json.gz"
        geometry_path.write_bytes(gzip.compress(
            json.dumps(geometry(document), separators=(",", ":"), ensure_ascii=False).encode(), mtime=0))
    manifest_path = FIXTURES / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["cases"] = [case for case in manifest["cases"] if case["id"] != CASE_ID]
    manifest["cases"].append({
        "id": CASE_ID,
        "pdf": "clamp3/clamp3.pdf",
        "groundTruth": "clamp3/ground-truth.json",
        "geometry": "clamp3/geometry.json.gz",
        "sha256": hashlib.sha256(pdf_path.read_bytes()).hexdigest(),
        "layout": {"columns": 2, "numberedLines": False},
        "source": "CLaMP 3 ACL 2025 paper provided for extraction evaluation",
        "annotationScope": {"pages": list(range(page_count)), "completePages": True},
    })
    for case in manifest["cases"]:
        for key, suffix in (("pdf", "sha256"), ("geometry", "geometrySha256"), ("groundTruth", "groundTruthSha256")):
            path = FIXTURES / case[key]
            if path.is_file():
                case[suffix] = hashlib.sha256(path.read_bytes()).hexdigest()
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    truth = json.loads(truth_path.read_text())
    print(f"{CASE_ID}: {page_count} pages, {len(truth['sentences'])} curated sentences, {len(manifest['cases'])} corpus cases")


if __name__ == "__main__":
    main()
