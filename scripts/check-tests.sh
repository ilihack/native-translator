#!/bin/bash
set -e
echo "=== Unit & Integration Tests ==="
npx vitest run --reporter=verbose
echo "PASS: All tests passed"
