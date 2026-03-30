#!/bin/bash
# Bumps the Service Worker cache version to today's date-based version.
# Run this script before every deploy that includes app code changes.
# Usage: bash scripts/bump-sw-version.sh
set -e

NEW_VERSION="native-translator-v$(date +'%Y.%-m.%-d')"
SW_FILE="client/public/sw.js"
SETTINGS_FILE="client/src/components/SettingsOverlay.tsx"

OLD_VERSION=$(grep -o "CACHE_NAME = '[^']*'" "$SW_FILE" | grep -o "'[^']*'" | tr -d "'")

if [ "$OLD_VERSION" = "$NEW_VERSION" ]; then
  echo "SW version already up to date: $NEW_VERSION"
  exit 0
fi

sed -i "s/CACHE_NAME = '$OLD_VERSION'/CACHE_NAME = '$NEW_VERSION'/" "$SW_FILE"

echo "✓ SW cache bumped: $OLD_VERSION → $NEW_VERSION"
echo "  Note: SettingsOverlay reads the prefix 'native-translator-v' and displays the suffix."
echo "  Run bash scripts/check-sw-consistency.sh to verify."
