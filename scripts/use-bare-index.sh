#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# use-bare-index.sh
#
# Replaces client/index.html with the bare version that has NO
# landing page, NO consent screen, and NO SEO content — just
# the minimal shell needed to boot the React app.
#
# A backup of the full index is saved to client/index.full.html
# on the first run so it can be restored later.
#
# Usage:   bash scripts/use-bare-index.sh
# Restore: bash scripts/use-full-index.sh
# ──────────────────────────────────────────────────────────────

set -euo pipefail
cd "$(dirname "$0")/.."

FULL="client/index.html"
BARE="client/index.bare.html"
BACKUP="client/index.full.html"

if [ ! -f "$BARE" ]; then
  echo "ERROR: $BARE not found."
  exit 1
fi

if [ ! -f "$BACKUP" ]; then
  cp "$FULL" "$BACKUP"
  echo "Backed up full index to $BACKUP"
fi

cp "$BARE" "$FULL"
echo "Switched to bare index.html (no landing page)."
echo "To restore: bash scripts/use-full-index.sh"
