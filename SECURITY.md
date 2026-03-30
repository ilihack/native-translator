# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| Latest (main) | ✅ |
| Older tags | ❌ — please update to `main` |

## Reporting a Vulnerability

**Please do not report security issues as public GitHub issues.**

If you discover a security vulnerability, please report it privately:

1. **GitHub Private Disclosure** (preferred): Use the [Security Advisories](../../security/advisories/new) feature in this repository.
2. **Email**: Contact the maintainer via GitHub profile (https://github.com/ilihack).

Include in your report:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if you have one)

You will receive an acknowledgement within **72 hours** and a resolution timeline within **7 days**.

## Scope

### In scope
- Client-side JavaScript vulnerabilities (XSS, injection, etc.)
- API key leakage or exposure vectors
- Service Worker vulnerabilities
- localStorage data exposure
- WebSocket connection security

### Out of scope
- Issues that require physical access to the user's device
- Issues in third-party dependencies (report to the upstream project)
- Google Gemini API security issues (report to Google)

## Security Design Notes

- **API keys** are stored only in `localStorage` and are never transmitted to this project's servers.
- **All AI communication** goes directly from the browser to the Google Gemini API over WebSocket (WSS).
- **No user data** is stored server-side by this application.
- The backend Express server serves only static files and does not proxy or log any user data.

## Attribution

This security policy applies to the Native Translator project by **ilihack** — https://nativetranslator.app
