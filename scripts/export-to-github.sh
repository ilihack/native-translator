#!/usr/bin/env bash
# export-to-github.sh
# Pushes this project to GitHub as a single clean commit — no git history.
#
# HOW TO USE:
#   1. On Replit: open the three-dot menu → "Download as ZIP"
#   2. On your local machine: unzip the file
#   3. Open a terminal in the unzipped folder
#   4. Run: bash scripts/export-to-github.sh https://github.com/ilihack/native-translator.git
#
# Requirements: git, Node.js 20+

set -e

REMOTE="${1}"
BRANCH="${2:-main}"

if [ -z "$REMOTE" ]; then
  echo ""
  echo "Usage:"
  echo "  bash scripts/export-to-github.sh <github-url> [branch]"
  echo ""
  echo "Example:"
  echo "  bash scripts/export-to-github.sh https://github.com/ilihack/native-translator.git"
  echo ""
  exit 1
fi

echo ""
echo "========================================"
echo "  Native Translator — GitHub Export"
echo "========================================"
echo ""

# Validate project root
if [ ! -f "package.json" ] || [ ! -d "client" ]; then
  echo "Error: Run this from the project root (the folder containing package.json)."
  exit 1
fi

echo "Remote : $REMOTE"
echo "Branch : $BRANCH"
echo ""

# Initialize fresh git repo if one doesn't exist (ZIP download case)
if [ ! -d ".git" ]; then
  echo "Step 1/4: Initializing fresh git repository..."
  git init
  git checkout -b "$BRANCH"
else
  echo "Step 1/4: Creating orphan branch (strips all existing history)..."
  git checkout --orphan export-clean
  git rm -rf --cached . > /dev/null 2>&1 || true
fi

echo "Step 2/4: Staging all files..."
git add -A

echo "Step 3/4: Creating single clean commit..."
git commit -m "Initial open-source release

Native Translator — real-time simultaneous voice interpretation PWA.
Powered by Google Gemini Live API. 24 languages. No text layer.

Live: https://nativtranslator.app
By ilihack (https://github.com/ilihack)

Licensed under MIT with Attribution Requirement — see LICENSE."

echo "Step 4/4: Pushing to GitHub ($BRANCH)..."
git remote remove origin 2>/dev/null || true
git remote add origin "$REMOTE"

# Push the current HEAD to main on GitHub
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git push origin "${CURRENT_BRANCH}:${BRANCH}" --force

echo ""
echo "========================================"
echo "  Done!"
echo "========================================"
echo ""
echo "Your repo: ${REMOTE%.git}"
echo ""
echo "Recommended next steps:"
echo "  1. Tag the release:"
echo "       git tag v7.0.0 && git push origin v7.0.0"
echo ""
echo "  2. On GitHub → repo → gear icon (About):"
echo "       Description : The fastest AI voice translator: pure audio in, native audio out."
echo "                     No text layer, no account, no server. 24 languages. → nativtranslator.app"
echo "       Website     : https://nativtranslator.app"
echo "       Topics      : translation pwa gemini real-time voice ai typescript react open-source"
echo ""
echo "  3. Settings → General → enable:"
echo "       - Issues"
echo "       - Discussions (optional)"
echo "       - Security Advisories"
echo ""
echo "  4. Settings → Branches → Add rule for 'main':"
echo "       - Require status checks to pass (select the CI job)"
echo ""
