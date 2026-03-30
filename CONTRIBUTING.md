# Contributing to Native Translator

Thank you for your interest in contributing! This document explains how to get involved.

## Before You Start

- Check [open issues](../../issues) to avoid duplicate work.
- For large changes, open an issue first to discuss the approach.
- All contributions must retain the original author attribution (see [LICENSE](LICENSE)).

## Development Setup

```bash
git clone https://github.com/ilihack/native-translator.git
cd native-translator
npm install
npm run dev
```

You need a [Google AI Studio API key](https://aistudio.google.com/app/apikey) to test translation features.

## Code Quality Checks

All of the following must pass before a PR can be merged. Run them locally:

```bash
# TypeScript — no type errors
bash scripts/check-typecheck.sh

# ESLint — no lint errors (warnings are okay)
bash scripts/check-lint.sh

# Unit tests — all must pass
bash scripts/check-tests.sh

# Production build — must succeed
bash scripts/check-build.sh

# JSDoc headers — every source file must have one
bash scripts/check-jsdoc.sh

# No stray console.log calls
bash scripts/check-stray-logs.sh

# Service Worker version consistency
bash scripts/check-sw-consistency.sh

# Branding check
bash scripts/check-branding.sh
```

## Code Style

- **Language:** English only for all code, comments, and UI strings. No German in source files.
- **Comments:** Every source file must begin with a 2–3 line JSDoc header describing its purpose, inputs, and exports.
- **Constants:** Magic numbers and timing values belong in `client/src/config/index.ts` — never hardcoded in hooks or components.
- **No `console.log`:** Use the internal `logger` utility (`client/src/utils/logger.ts`) for all debug output.
- **TypeScript:** Avoid `any`. Prefer explicit types.
- **Components:** Keep components focused. Split large files rather than creating 500-line monoliths.

## Pull Request Process

1. Fork the repository and create a branch from `main`.
2. Make your changes and ensure all checks pass.
3. Write or update unit tests if your change affects logic in `utils/` or `hooks/`.
4. Open a pull request with a clear description of what changed and why.
5. A maintainer will review and provide feedback.

## Attribution Requirement

This project uses the **MIT License with Attribution Requirement**. Any fork, derivative work, or public deployment must display:

> "Based on Native Translator by ilihack — https://nativetranslator.app"

Removing or hiding this attribution is not permitted under the license terms.

## Reporting Bugs

Please include:
- Browser + OS version
- Steps to reproduce
- Expected vs. actual behavior
- Debug logs (copy them from Settings → Copy Logs)

## Feature Requests

Open a GitHub issue with the label `enhancement`. Describe the use case, not just the implementation.

## Code of Conduct

Be respectful. Constructive criticism is welcome; personal attacks are not.
