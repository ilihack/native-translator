#!/bin/bash
echo "=== Console Hygiene Check ==="
HITS=$(grep -rn "console\.log\|console\.warn\|console\.error" \
  client/src --include="*.ts" --include="*.tsx" \
  | grep -v "^\s*//" \
  | grep -v "showDebugInfo" \
  | grep -v "//.*console" \
  | grep -v "client/src/utils/logger\.ts" || true)
if [ -n "$HITS" ]; then
  echo "FAIL: Ungated console calls found outside logger.ts (must be wrapped in showDebugInfo or moved to logger):"
  echo "$HITS"
  exit 1
fi
echo "PASS: All console calls are in logger.ts or gated behind showDebugInfo"
