#!/usr/bin/env bash
set -euo pipefail

VERSION="$(
  python3 -c 'import json; print(json.load(open("manifest.json"))["version"])'
)"

OUTPUT="dist/zotero-skimming-${VERSION}.xpi"

rm -rf dist
mkdir -p dist

zip -r -9 "$OUTPUT" \
  manifest.json \
  bootstrap.js \
  model-identifiers.json \
  scoring-config.json \
  content \
  "assets/book reader.svg"

echo "Built: $OUTPUT"
unzip -t "$OUTPUT"
