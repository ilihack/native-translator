/**
 * Central configuration barrel re-exporting language definitions, voice options,
 * and application-wide constants like session duration and background timeout limits.
 * @exports All exports from languages.ts, voices.ts, plus MAX_SESSION_DURATION, BACKGROUND_TIMEOUT
 */
export * from './languages';
export * from './voices';

export const MAX_SESSION_DURATION = 30 * 60 * 1000;
export const BACKGROUND_TIMEOUT = 5 * 60 * 1000; // 5 minutes in background = auto-disconnect

export const AUDIO_CONFIG = {
  GEMINI_SAMPLE_RATE: 24000,
  INPUT_SAMPLE_RATE: 16000,
} as const;

/** Gemini Live API generation defaults used in the connect() call. */
export const GEMINI_DEFAULTS = {
  /** nucleus-sampling probability cutoff */
  TOP_P: 0.95,
  /** top-K token cutoff */
  TOP_K: 40,
  /** temperature for personality / funny mode (high creativity) */
  FUNNY_MODE_TEMPERATURE: 1.5,
} as const;
