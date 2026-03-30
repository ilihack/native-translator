#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# use-full-index.sh
#
# Restores client/index.html from the backup created by
# use-bare-index.sh. This brings back the full landing page
# with consent screen, SEO content, FAQ accordion, and
# JSON-LD structured data.
#
# Usage: bash scripts/use-full-index.sh
# ──────────────────────────────────────────────────────────────

set -euo pipefail
cd "$(dirname "$0")/.."

FULL="client/index.html"
BACKUP="client/index.full.html"

if [ ! -f "$BACKUP" ]; then
  echo "ERROR: No backup found at $BACKUP. The full index is probably already active."
  exit 1
fi

cp "$BACKUP" "$FULL"
echo "Restored full index.html (with landing page)."
