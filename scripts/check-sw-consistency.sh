#!/bin/bash
echo "=== Service Worker Consistency Check ==="
FAIL=0

SW_CACHE=$(grep -o "CACHE_NAME = '[^']*'" client/public/sw.js | grep -o "'[^']*'" | tr -d "'" || true)
if [ -z "$SW_CACHE" ]; then
  echo "FAIL: Could not read CACHE_NAME from sw.js"
  FAIL=1
fi
echo "SW cache name: $SW_CACHE"

OVERLAY_HAS=$(grep -c "native-translator-v" client/src/components/SettingsOverlay.tsx || true)
if [ "$OVERLAY_HAS" -eq 0 ]; then
  echo "FAIL: SettingsOverlay.tsx does not contain 'native-translator-v' regex — SW version display broken"
  FAIL=1
fi
echo "SettingsOverlay version regex: OK ($OVERLAY_HAS matches)"

SW_HAS=$(echo "$SW_CACHE" | grep -c "native-translator-v" || true)
if [ "$SW_HAS" -eq 0 ]; then
  echo "FAIL: SW cache name '$SW_CACHE' does not match expected prefix 'native-translator-v'"
  FAIL=1
fi

if [ "$FAIL" -eq 0 ]; then
  echo "PASS: SW cache name and SettingsOverlay are consistent"
else
  exit 1
fi
