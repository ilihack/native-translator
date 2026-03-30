/**
 * Config deserialization helpers shared between useLiveSession and test suites.
 * Keeping these functions in a standalone module allows them to be unit-tested
 * without importing the full useLiveSession hook (which carries AudioContext,
 * WebSocket, and AudioWorklet side-effects that are hard to mock in jsdom).
 *
 * @exports AUDIO_CONFIG_KEYS  — ordered allowlist of every valid AudioConfig key
 * @exports sanitizeStorageConfig — strips unknown/dangerous keys from raw storage objects
 */

import type { AudioConfig } from '../hooks/useLiveSession';

/**
 * Ordered allowlist of every key that may legally appear in a persisted AudioConfig.
 * Any key NOT in this list will be silently dropped by sanitizeStorageConfig(), which:
 *   (a) prevents legacy fields (e.g. proactiveMode) from leaking into session config;
 *   (b) neutralises localStorage-manipulation attacks that attempt to inject __proto__,
 *       constructor, prototype or unexpected session parameters.
 */
export const AUDIO_CONFIG_KEYS: ReadonlyArray<keyof AudioConfig> = [
  'noiseSuppression',
  'autoGainControl',
  'outputGain',
  'softClipDrive',
  'voiceName',
  'showDebugInfo',
  'userApiKey',
  'modelName',
  'vadPrefixPaddingMs',
  'vadSilenceDurationMs',
  'vadStartSensitivity',
  'temperature',
  'audioTestMode',
  'inputBufferSize',
  'triggerTokens',
  'funnyMode',
] as const;

/**
 * Returns a copy of `raw` containing only the keys present in AUDIO_CONFIG_KEYS.
 * Non-string/unknown input is treated as an empty object.
 */
export function sanitizeStorageConfig(raw: Record<string, unknown>): Partial<AudioConfig> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const clean: Partial<AudioConfig> = {};
  for (const key of AUDIO_CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (clean as any)[key] = (raw as any)[key];
    }
  }
  return clean;
}
