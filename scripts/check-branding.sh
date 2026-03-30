#!/bin/bash
echo "=== Branding Check ==="
HITS=$(grep -rn "iiTranslator\|iitranslator\|gemini-interpreter\|iitranslator\.app" \
  client/src client/public client/index.html 2>/dev/null || true)
if [ -n "$HITS" ]; then
  echo "FAIL: Old branding strings found:"
  echo "$HITS"
  exit 1
fi
echo "PASS: No legacy branding found"
