#!/usr/bin/env python3
"""Create frozen body/non-body character labels from authored text and source PDFs."""
import gzip
import hashlib
import json
import unicodedata
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "test/fixtures/pdf-extraction"
HYPHENS = {"-", "\u2010", "\u2011", "\u00ad"}


def canonical(text):
    """Match source text independent of whitespace and Unicode compatibility glyphs."""
    return "".join(char for char in unicodedata.normalize("NFKC", text) if not char.isspace())


def page_lines(page):
    """Yield rawdict text lines with the same geometry-index order as the fixture builder."""
    index = 0
    for block in page.get_text("rawdict", flags=0)["blocks"]:
        for line in block.get("lines", []):
            chars = []
            for span in line["spans"]:
                for char in span["chars"]:
                    chars.append((index, char["c"]))
                    index += 1
            yield chars


def searchable(lines):
    """Build a normalized stream while retaining each source glyph's geometry index.

    A hyphen printed at a line break may stand for a real hyphen or for a word split by
    typesetting. Each such glyph is flagged so the matcher can treat it as optional while
    still attributing the physical glyph to the authored word.
    """
    stream = []
    previous_alpha = False
    for line in lines:
        visible = [(index, text) for index, text in line if text and not text.isspace()]
        if not visible:
            continue
        if all(text.isdigit() for _, text in visible):
            continue
        for position, (index, text) in enumerate(visible):
            for normalized_char in unicodedata.normalize("NFKC", text):
                optional = (position == len(visible) - 1 and normalized_char in HYPHENS
                            and previous_alpha)
                stream.append((normalized_char, index, optional))
                previous_alpha = normalized_char.isalpha()
        previous_alpha = False
    return stream


def match(stream, needle, start):
    """Consume needle from start, allowing line-break hyphens to be skipped."""
    stack = [(start, 0, ())]
    while stack:
        index, offset, positions = stack.pop()
        while offset < len(needle):
            if index >= len(stream):
                break
            char, _, optional = stream[index]
            if optional and needle[offset] in HYPHENS:
                # The printed hyphen may be a real hyphen or a typeset word split.
                stack.append((index + 1, offset, positions + (index,)))
                positions += (index,)
                index += 1
                offset += 1
                continue
            if optional:
                positions += (index,)
                index += 1
                continue
            if char != needle[offset]:
                break
            positions += (index,)
            index += 1
            offset += 1
        else:
            return index, set(positions)
    return None


def occurrences(stream, text):
    """Return every (start, end, glyph indexes) occurrence of authored text."""
    needle = canonical(text)
    if not needle:
        return []
    found = []
    for start in range(len(stream)):
        matched = match(stream, needle, start)
        if matched:
            end, positions = matched
            found.append((start, end, {stream[position][1] for position in positions}))
    return found


def label_case(case):
    truth_path = FIXTURES / case["groundTruth"]
    truth = json.loads(truth_path.read_text())
    pdf_path = FIXTURES / case["pdf"]
    with pymupdf.open(pdf_path) as document:
        pages = []
        for page in document:
            lines = list(page_lines(page))
            pages.append({"lines": lines, "stream": searchable(lines)})

    positive_by_page = [set() for _ in pages]
    cursor_by_page = [0 for _ in pages]
    authored = list(truth.get("sentences", [])) + list(truth.get("fragments", []))
    for item in authored:
        first_page = item["pageIndex"]
        last_page = item.get("endPageIndex", first_page)
        combined = []
        boundaries = []
        for page_index in range(first_page, last_page + 1):
            boundaries.extend([page_index] * len(pages[page_index]["stream"]))
            combined.extend(pages[page_index]["stream"])
        eligible = []
        for start, end, indices in occurrences(combined, item["text"]):
            if boundaries[start] != first_page or start < cursor_by_page[first_page]:
                continue
            if boundaries[end - 1] > last_page:
                continue
            eligible.append((start, end, indices))
        if not eligible:
            raise RuntimeError(f"Cannot align authored text in {case['id']} page {first_page}: {item['text']}")
        start, end, _ = eligible[0]
        page_index = first_page
        for position in range(start, end):
            while boundaries[position] != page_index:
                page_index = boundaries[position]
            positive_by_page[page_index].add(combined[position][1])
        cursor_by_page[first_page] = end

    scope = set(case["annotationScope"]["pages"])
    labeled_pages = []
    for page_index, page in enumerate(pages):
        if page_index not in scope:
            labeled_pages.append({"pageIndex": page_index, "positiveCharIndices": [],
                                  "negativeUnits": []})
            continue
        positive = positive_by_page[page_index]
        negatives = []
        for line in page["lines"]:
            run = []
            for char_index, text in line:
                if not text or text.isspace() or char_index in positive:
                    if run:
                        negatives.append({"charIndices": run, "kind": "non-body"})
                        run = []
                else:
                    run.append(char_index)
            if run:
                negatives.append({"charIndices": run, "kind": "non-body"})
        labeled_pages.append({"pageIndex": page_index,
                              "positiveCharIndices": sorted(positive),
                              "negativeUnits": negatives})
    payload = json.dumps({"pages": labeled_pages}, separators=(",", ":"), ensure_ascii=False).encode()
    labels_path = truth_path.with_name(truth_path.name + ".labels.json.gz")
    labels_path.write_bytes(gzip.compress(payload, mtime=0))
    return labels_path


def main():
    manifest_path = FIXTURES / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    for case in manifest["cases"]:
        label_path = label_case(case)
        case["labels"] = str(label_path.relative_to(FIXTURES))
        case["labelsSha256"] = hashlib.sha256(label_path.read_bytes()).hexdigest()
        print(f"{case['id']}: {case['labelsSha256']}")
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
