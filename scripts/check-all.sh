#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# check-all.sh  —  Master pre-push quality gate for Native Translator
#
# Run this before every push or after any code change:
#   bash scripts/check-all.sh
#
# Passes only when ALL checks below return exit code 0.
# Failures are collected and a summary is printed at the end.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

PASS_COUNT=0
FAIL_COUNT=0
FAILED_CHECKS=()

run_check() {
  local name="$1"
  local script="$2"

  echo ""
  echo "──────────────────────────────────────"
  if bash "$script"; then
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILED_CHECKS+=("$name")
    echo "↑ FAILED: $name"
  fi
}

echo "╔══════════════════════════════════════╗"
echo "║  Native Translator — Pre-Push Gate   ║"
echo "╚══════════════════════════════════════╝"

# ── 1. TypeScript: zero type errors ──────────────────────────────────────────
run_check "TypeScript"       scripts/check-typecheck.sh

# ── 2. ESLint: zero lint errors ───────────────────────────────────────────────
run_check "ESLint"           scripts/check-lint.sh

# ── 3. Unit + integration tests ───────────────────────────────────────────────
run_check "Tests"            scripts/check-tests.sh

# ── 4. Production build must succeed ─────────────────────────────────────────
run_check "Build"            scripts/check-build.sh

# ── 5. JSDoc headers on every source file ────────────────────────────────────
run_check "JSDoc headers"    scripts/check-jsdoc.sh

# ── 6. No legacy branding strings ────────────────────────────────────────────
run_check "Branding"         scripts/check-branding.sh

# ── 7. No raw console.* calls outside logger.ts ──────────────────────────────
run_check "Console hygiene"  scripts/check-stray-logs.sh

# ── 8. Service worker cache name consistency ──────────────────────────────────
run_check "SW consistency"   scripts/check-sw-consistency.sh

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════"
if [ "$FAIL_COUNT" -eq 0 ]; then
  echo "  ✓ ALL $PASS_COUNT checks passed — safe to push."
  echo "══════════════════════════════════════"
  exit 0
else
  echo "  ✗ $FAIL_COUNT of $((PASS_COUNT + FAIL_COUNT)) checks FAILED:"
  for check in "${FAILED_CHECKS[@]}"; do
    echo "    • $check"
  done
  echo "══════════════════════════════════════"
  exit 1
fi
