#!/bin/bash
# Every source file in client/src/ must start with a JSDoc block comment (/**).
# Excludes: shadcn-generated files, test files, and test helpers.

echo "=== JSDoc Header Check ==="

FAIL=0
MISSING=()

EXCLUDES=(
  "client/src/components/ui/"
  "client/src/hooks/use-toast.ts"
  "client/src/lib/utils.ts"
  "client/src/test/"
  "__tests__"
  ".test.ts"
  ".test.tsx"
)

while IFS= read -r -d '' file; do
  # Check if file matches any exclude pattern
  skip=0
  for excl in "${EXCLUDES[@]}"; do
    if [[ "$file" == *"$excl"* ]]; then
      skip=1
      break
    fi
  done
  [ "$skip" -eq 1 ] && continue

  # Check that /** appears within the first 3 non-empty lines.
  # This allows a leading /// <reference> TypeScript directive before the JSDoc block.
  first_3=$(grep -m3 "." "$file" || true)
  if ! echo "$first_3" | grep -q "^/\*\*"; then
    MISSING+=("$file")
    FAIL=1
  fi
done < <(find client/src -type f \( -name "*.ts" -o -name "*.tsx" \) -print0)

if [ "$FAIL" -eq 1 ]; then
  echo "FAIL: The following files are missing a JSDoc header comment ('/**' on line 1):"
  for f in "${MISSING[@]}"; do
    echo "  $f"
  done
  echo ""
  echo "Every source file must start with:"
  echo "  /**"
  echo "   * Brief description of what this file does."
  echo "   * @exports MainExport"
  echo "   */"
  exit 1
fi

echo "PASS: All source files have JSDoc headers"
