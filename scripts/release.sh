#!/usr/bin/env bash
set -euo pipefail

ONLY_BUILD=false
for arg in "$@"; do
  case "$arg" in
    --only-build) ONLY_BUILD=true ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! $ONLY_BUILD; then
  # --- Step 0: ensure clean state & tests pass ---
  if [ -n "$(git status --porcelain)" ]; then
    echo "Uncommitted changes. Commit or stash first."
    exit 1
  fi
  echo "Running tests …"
  yarn test 2>/dev/null
  echo "✓ Tests pass"

  # --- Step 1: determine next version ---
  LAST_TAG="$(git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0")"
  CURRENT="${LAST_TAG#v}"
  echo ""
  echo "Current version: $CURRENT  (last tag: $LAST_TAG)"
  echo ""
  echo "Select bump type:"
  echo "  1) major  ($(echo "$CURRENT" | awk -F. '{print $1+1".0.0"}'))"
  echo "  2) minor  ($(echo "$CURRENT" | awk -F. '{print $1"."$2+1".0"}'))"
  echo "  3) patch  ($(echo "$CURRENT" | awk -F. '{print $1"."$2"."$3+1}'))"
  read -rp "Choice [1-3]: " BUMP

  case "$BUMP" in
    1) NEW_VERSION="$(echo "$CURRENT" | awk -F. '{print $1+1".0.0"}')" ;;
    2) NEW_VERSION="$(echo "$CURRENT" | awk -F. '{print $1"."$2+1".0"}')" ;;
    3) NEW_VERSION="$(echo "$CURRENT" | awk -F. '{print $1"."$2"."$3+1}')" ;;
    *) echo "Invalid choice."; exit 1 ;;
  esac

  echo "→ New version: v$NEW_VERSION"

  # --- Step 2: update manifest.json ---
  node -e "
  const m = require('./manifest.json');
  m.version = '$NEW_VERSION';
  require('fs').writeFileSync('./manifest.json', JSON.stringify(m, null, 2) + '\n');
  "
  echo "✓ manifest.json updated to v$NEW_VERSION"
fi

# --- build XPI ---
echo "Building zotero-skimming.xpi …"
XPI="zotero-skimming.xpi"
zip -r -9 "$XPI" \
  manifest.json bootstrap.js content/ assets/book\ reader.svg \
  model-identifiers.json scoring-config.json \
  -x "*.DS_Store" "*.gitkeep"
echo "✓ $XPI built"

if ! $ONLY_BUILD; then
  # --- generate updates.json ---
  echo "Generating updates.json …"
  cat > updates.json <<EOF
{
  "addons": {
    "zotero-skimming@example.org": {
      "updates": [
        {
          "version": "$NEW_VERSION",
          "update_link": "https://github.com/00sapo/zotero-skimming/releases/download/v${NEW_VERSION}/zotero-skimming.xpi"
        }
      ]
    }
  }
}
EOF
  echo "✓ updates.json generated"
fi

if $ONLY_BUILD; then
  echo ""
  echo "--only-build: $XPI built. Skipping version bump, updates.json, commit, tag, release."
  exit 0
fi

# --- Step 5: commit, tag ---
git add manifest.json updates.json
git commit -m "chore: release v$NEW_VERSION"
git tag -a "v$NEW_VERSION" -m "release v$NEW_VERSION"
echo "✓ committed & tagged v$NEW_VERSION"

# --- Step 6: push & create GitHub release ---
echo ""
echo "Ready to push: git push --follow-tags"
read -rp "Push to origin and create GitHub release? [y/N]: " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
  echo "Cancelled. Files left: $XPI, updates.json"
  exit 0
fi

git push --follow-tags
echo "✓ Pushed"

if ! command -v gh &>/dev/null; then
  echo "⚠ gh CLI not found. Install it: https://cli.github.com/"
  echo "  Upload $XPI and updates.json to the release manually."
  exit 0
fi

{
  printf '## Changes since %s\n\n' "$LAST_TAG"
  git log "${LAST_TAG}..HEAD" --oneline --no-decorate | sed 's/^/* /'
  printf '\n[Full history](https://github.com/00sapo/zotero-skimming/compare/%s...v%s)\n' "$LAST_TAG" "$NEW_VERSION"
} > /tmp/zotero-skimming-release-notes.md

gh release create "v$NEW_VERSION" \
  --title "v$NEW_VERSION" \
  --notes-file /tmp/zotero-skimming-release-notes.md \
  "$XPI" "updates.json"

rm -f /tmp/zotero-skimming-release-notes.md "$XPI"
echo "✓ GitHub release v$NEW_VERSION created"
