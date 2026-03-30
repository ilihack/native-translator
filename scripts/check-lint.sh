#!/bin/bash
# Runs ESLint over client/src. Zero errors are required.
# Warnings (no-explicit-any, exhaustive-deps) are reported but do not fail the check.
set -e

echo "=== ESLint Check ==="

OUTPUT=$(npx eslint client/src/ 2>&1 || true)
ERRORS=$(echo "$OUTPUT" | grep -c " error " || true)

if [ "$ERRORS" -gt 0 ]; then
  echo "$OUTPUT"
  echo ""
  echo "FAIL: $ERRORS ESLint error(s) found — fix all errors before pushing."
  exit 1
fi

WARNINGS=$(echo "$OUTPUT" | grep -c " warning " || true)
if [ "$WARNINGS" -gt 0 ]; then
  echo "  $WARNINGS warning(s) (informational — no-explicit-any / exhaustive-deps)."
fi

echo "PASS: No ESLint errors"
