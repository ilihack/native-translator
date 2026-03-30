#!/bin/bash
set -e
echo "=== Production Build Check ==="
# In CI environments enforce the lockfile; locally skip to avoid wiping node_modules.
if [ "${CI:-false}" = "true" ]; then
  echo "CI detected — running npm ci to enforce package-lock.json"
  npm ci
fi
npm run build
echo "PASS: Production build succeeded"
