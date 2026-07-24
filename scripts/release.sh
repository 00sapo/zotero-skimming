#!/usr/bin/env bash
set -euo pipefail

# Build a release XPI for Zotero Skimming
# Usage: ./scripts/release.sh [version]
#   version defaults to the current version in manifest.json

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-$(node -e "console.log(require('./manifest.json').version)")}"
echo "Building Zotero Skimming v$VERSION …"

# Update manifest version
node -e "
const m = require('./manifest.json');
m.version = '$VERSION';
require('fs').writeFileSync('./manifest.json', JSON.stringify(m, null, 2) + '\n');
"

# Generate updates.json
UPDATES_JSON="updates.json"
cat > "$UPDATES_JSON" <<EOF
{
  "addons": {
    "zotero-skimming@example.org": {
      "updates": [
        {
          "version": "$VERSION",
          "update_link": "https://github.com/00sapo/zotero-skimming/releases/download/v${VERSION}/zotero-skimming.xpi"
        }
      ]
    }
  }
}
EOF
echo "Wrote $UPDATES_JSON"

# Build XPI (zip with .xpi extension)
XPI="zotero-skimming.xpi"
zip -r "$XPI" \
  manifest.json bootstrap.js content/ assets/ \
  model-identifiers.json scoring-config.json \
  -x "*.DS_Store" "*.gitkeep"
echo "Wrote $XPI"

echo "Done. Release v$VERSION ready:"
echo "  - $XPI"
echo "  - $UPDATES_JSON"
echo ""
echo "Upload both to GitHub release v$VERSION."
