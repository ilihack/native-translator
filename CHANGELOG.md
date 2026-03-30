# Changelog

All notable changes to Native Translator are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
Versioning: [Semantic Versioning](https://semver.org/)

---

## [7.0.0] — 2026-03-30

### Changed
- All user-facing text translated to English (was partially German)
- Service Worker bumped to `native-translator-v7.0.0`

### Fixed
- False reconnects on long AI responses (speaking watchdog now resets on every PCM chunk)
- AI silence hang: 3 s watchdog detects model generating only null PCM bytes (`AAA=`)
- No-response hang: 15 s guard detects AI not responding while in LISTENING state

### Added
- Log persistence: logs flushed to `localStorage` every 3 s, restored on next session
- "Copy Logs (+ last session)" button merges current + previous session logs
- Privacy notice below API key input (green shield box)
- Open-source release: LICENSE, README, CONTRIBUTING, SECURITY, CHANGELOG, GitHub templates

---

## [6.4.0] — 2026-03 (pre-OSS)

### Changed
- Default temperature: 0.3 → 0.7
- Default VAD prefix padding: 100 ms → 50 ms
- Default VAD silence duration: 500 ms → 300 ms
- VAD controls grayed out with informational note

### Added
- Context Window Trigger field with ALPHA badge
- `withCtxTimeout()`: 3 s timeout wrapper for `AudioContext` suspend/resume calls
- `selfInitiatedCloseRef`: prevents double-reconnect in `onclose` handler
- Exponential backoff reconnect (1 s, 2 s, 4 s, 8 s — max 4 attempts)

---

## [6.3.0] — 2026-02

### Added
- Script-based language detection (`scriptDetection.ts`)
- Prompt sanitizer: strips bidi override characters and control chars
- `promptBuilder.ts` with placeholder replacement (`{source}`, `{target}`, etc.)
- Personality mode (random translation style)
- `storageConfig.ts` allowlist-based config sanitizer

### Fixed
- iOS PWA ↔ Safari context switch losing consent state (now dual localStorage + cookie)

---

## [6.0.0] — 2026-01

### Added
- Two-page routing: `/` (SEO landing page, pure HTML) + `/app` (React SPA)
- JSON-LD schemas: `WebSite`, `SoftwareApplication`, `FAQPage`
- PWA installation support, screen wake lock
- Service Worker offline caching
- `ServiceWorkerUpdateToast` for update notifications

### Changed
- Moved from single-page to split landing/app architecture for SEO

---

## [5.0.0] — 2025-12

### Added
- Initial public release
- Real-time bidirectional voice translation via Gemini Live API
- 24 language support
- AudioWorklet-based recorder (48 kHz → 16 kHz resampling) and player (24 kHz PCM)
- Finite state machine: `IDLE → CONNECTING → LISTENING → SPEAKING → ERROR`
- `localStorage`-based config persistence
