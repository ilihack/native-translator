# Native Translator

> Real-time simultaneous interpretation — powered by Google Gemini Live API.

**Live demo → [nativetranslator.app](https://nativetranslator.app)**

---

## Description

The fastest AI voice translator: pure audio in, native audio out. No text layer, no account, no server. 24 languages. Nuances and tone intact. → nativetranslator.app

---

nativ translator is a free, open-source PWA for real-time simultaneous voice interpretation across 24 languages — powered by Google Gemini Live API.

**What makes it different from every other translator:**

Most translators follow a 4-step pipeline: speech → text → translated text → speech. nativ translator skips the text layer entirely. Your voice goes in as audio and comes out as audio — preserving the natural flow, tone, emotion, and nuance of what you say. This is also why it is the fastest real-time translator currently available: no speech-to-text round-trip, just direct audio-to-audio interpretation at conversation speed.

On top of that, it is context-aware. Because it runs on a full language model, it understands what the conversation is about and adapts automatically — a medical discussion gets clinical precision, a technical briefing gets the right jargon, casual chat stays natural. No rigid word-for-word translation.

No account. No download. No backend AI. Runs entirely in your browser. Bring your own free Google Gemini API key.

---

[![License: MIT + Attribution](https://img.shields.io/badge/license-MIT%20%2B%20Attribution-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61dafb)](https://react.dev/)
[![PWA](https://img.shields.io/badge/PWA-ready-brightgreen)](https://web.dev/progressive-web-apps/)

---

## What is this?

Native Translator is a **Progressive Web App (PWA)** for real-time, bidirectional, simultaneous voice interpretation across **24 languages** — running entirely in your browser with no backend AI processing.

**Native audio in. Native audio out. No text in between — just your voice, naturally translated.**

Most translators work in four steps: speech → text → translated text → speech. Native Translator skips the text layer entirely. Your voice is streamed directly as audio to Google Gemini Live, and the translated audio comes straight back — which is why it is the fastest real-time translator currently available, and why it preserves nuance, tone, and emotion that text-based systems throw away.

| | Native Translator | Conventional translators |
|---|---|---|
| Pipeline | Audio → Audio | Speech → Text → Translate → Speech |
| Speed | Conversation speed | Noticeable delay |
| Tone & emotion | Preserved | Lost |
| Context awareness | Full language model | Phrase matching |
| Text shown | Optional transcript | Always |

**Four core advantages:**
- 🎙 **Pure Audio — No Text Layer** — voice in, voice out; natural flow preserved
- 🎵 **Nuances intact** — tone, emotion, emphasis survive the translation
- ⚡ **Fastest available** — no speech-to-text round-trip, near-instant output
- 🧠 **Context-aware** — adapts to the topic automatically (medical, legal, technical, casual)

**Key principle:** Your API key never leaves your device. It is stored only in your browser's `localStorage`.

---

## Features

- **Real-time simultaneous interpretation** — no pause-and-translate, continuous streaming
- **24 languages** — English, German, French, Spanish, Portuguese, Italian, Dutch, Polish, Russian, Ukrainian, Turkish, Arabic, Hebrew, Persian, Hindi, Bengali, Chinese (Simplified & Traditional), Japanese, Korean, Vietnamese, Thai, Indonesian, Swahili
- **Bidirectional** — detects which language is being spoken and translates in both directions automatically
- **Voice-to-voice** — full audio output, not just text
- **PWA** — installable on any device, works offline (after first load)
- **Mobile-optimized** — tested on Android Chrome, fully responsive
- **No account required** — bring your own [Google AI Studio API key](https://aistudio.google.com/app/apikey) (free tier available)
- **Privacy-first** — zero server-side data storage, all processing via Google's API directly
- **Automatic reconnect** — exponential backoff reconnection with watchdog timers for network drops
- **Log export** — built-in debug logger with copy-to-clipboard for troubleshooting

---

## Architecture Overview

```
Browser (React PWA)
│
├── AudioWorklet (recorder)   ← getUserMedia → 48kHz → resample → 16kHz PCM
│
├── WebSocket ──────────────────────────────────────────────────────────────→ Google Gemini Live API
│                                                                             (gemini-3.1-flash-live-preview)
├── WebSocket ←──────────────────────────────────────────────────────────────
│
└── AudioWorklet (player)     ← 24kHz PCM → soft-clip WaveShaper → AudioContext
```

**State machine:** `IDLE → CONNECTING → LISTENING → SPEAKING → ERROR`

**Backend:** Minimal Express server — only serves static files and Vite HMR in development. Zero AI processing server-side.

---

## Getting Started

### Prerequisites

- Node.js 20+
- A free [Google AI Studio API key](https://aistudio.google.com/app/apikey)

### Install & Run

```bash
git clone https://github.com/ilihack/native-translator.git
cd native-translator
npm install
npm run dev
```

Open `http://localhost:5000` → paste your API key → select languages → press Start.

### Production Build

```bash
npm run build
```

The `dist/` folder contains the complete static build + Express server entry point (`dist/index.cjs`).

---

## Configuration

All settings are stored in `localStorage` under the key `gemini_interpreter_config_v5`.

| Setting | Default | Description |
|---|---|---|
| Temperature | 0.7 | AI creativity (0 = precise, 2 = creative) |
| Prefix Padding | 50 ms | VAD delay before speech start |
| Silence Duration | 300 ms | VAD silence to end a turn |
| Output Gain | 1.0 | Playback volume multiplier |
| Context Window Trigger | 0 | Token threshold for context compression (0 = off) |
| Audio Chunk Size | 20 ms | PCM chunk duration sent to API |

---

## Project Structure

```
client/
├── index.html              # SEO landing page (no React, pure HTML)
├── app.html                # React app entry point
├── public/
│   ├── sw.js               # Service Worker (offline caching)
│   ├── manifest.json       # PWA manifest
│   └── sitemap.xml         # XML sitemap
└── src/
    ├── audio/
    │   └── worklets/
    │       ├── recorder.worklet.ts   # Mic capture + resampling
    │       └── player.worklet.ts     # PCM playback + watchdog
    ├── components/
    │   ├── SettingsOverlay.tsx       # All user settings UI
    │   ├── Visualizer.tsx            # Audio VU meter
    │   ├── LegalPages.tsx            # Privacy + Imprint overlays
    │   └── ServiceWorkerUpdateToast.tsx
    ├── config/
    │   └── index.ts                  # All constants and timing values
    ├── hooks/
    │   ├── useLiveSession.ts         # Core WebSocket + audio pipeline
    │   └── useSessionMachine.ts      # FSM: IDLE/CONNECTING/LISTENING/SPEAKING/ERROR
    └── utils/
        ├── logger.ts                 # Debug logger with localStorage persistence
        ├── promptBuilder.ts          # System instruction builder + sanitizer
        ├── storageConfig.ts          # localStorage config schema + validation
        └── scriptDetection.ts        # Script-based language detection

server/
├── index.ts                # Express entry point
├── routes.ts               # API routes
└── static.ts               # Static file serving for production
```

---

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a pull request.

---

## Security

Found a security issue? Please **do not** open a public issue. Read [SECURITY.md](SECURITY.md) for responsible disclosure instructions.

---

## License

This project is released under the **MIT License with Attribution Requirement**.

You are free to use, modify, fork, and distribute this code — including commercially — provided that:

1. The original copyright notice is retained.
2. Any public deployment or derivative work displays the attribution:

   > "Based on Native Translator by ilihack — https://nativetranslator.app"

See [LICENSE](LICENSE) for the full text.

---

## Author

**ilihack** — [github.com/ilihack](https://github.com/ilihack)

Live app: [nativetranslator.app](https://nativetranslator.app)

---

## Acknowledgements

- [Google Gemini Live API](https://ai.google.dev/) — real-time audio streaming & translation
- [React](https://react.dev/), [Vite](https://vitejs.dev/), [Tailwind CSS](https://tailwindcss.com/), [shadcn/ui](https://ui.shadcn.com/)
- [Lucide Icons](https://lucide.dev/)
