#!/bin/bash
set -e
echo "=== TypeScript Check ==="
ERRORS=$(npx tsc --noEmit 2>&1 | grep -v 'node_modules' | grep -v 'drizzle.config' | grep 'error TS' || true)
if [ -n "$ERRORS" ]; then
  echo "FAIL: TypeScript errors found:"
  echo "$ERRORS"
  exit 1
fi
echo "PASS: No TypeScript errors"
