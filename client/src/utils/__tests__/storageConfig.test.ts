/**
 * Unit tests for client/src/utils/storageConfig.ts
 *
 * Covers:
 *  - AUDIO_CONFIG_KEYS: completeness, readonly, no duplicates
 *  - sanitizeStorageConfig(): allowlist enforcement, dangerous key stripping,
 *    prototype pollution resistance, type preservation, edge cases
 */
import { describe, it, expect } from 'vitest';
import { AUDIO_CONFIG_KEYS, sanitizeStorageConfig } from '../storageConfig';

// ─── AUDIO_CONFIG_KEYS ───────────────────────────────────────────────────────

describe('AUDIO_CONFIG_KEYS', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(AUDIO_CONFIG_KEYS)).toBe(true);
    expect(AUDIO_CONFIG_KEYS.length).toBeGreaterThan(0);
  });

  it('contains every expected AudioConfig field', () => {
    const expected = [
      'noiseSuppression', 'autoGainControl', 'outputGain', 'softClipDrive',
      'voiceName', 'showDebugInfo', 'userApiKey', 'modelName',
      'vadPrefixPaddingMs', 'vadSilenceDurationMs', 'vadStartSensitivity',
      'temperature', 'audioTestMode', 'inputBufferSize', 'triggerTokens', 'funnyMode',
    ];
    for (const key of expected) {
      expect(AUDIO_CONFIG_KEYS).toContain(key);
    }
  });

  it('has no duplicate entries', () => {
    const uniq = new Set(AUDIO_CONFIG_KEYS);
    expect(uniq.size).toBe(AUDIO_CONFIG_KEYS.length);
  });
});

// ─── sanitizeStorageConfig ───────────────────────────────────────────────────

describe('sanitizeStorageConfig', () => {
  it('returns an empty object for empty input', () => {
    expect(sanitizeStorageConfig({})).toEqual({});
  });

  it('preserves all valid AudioConfig keys and their values', () => {
    const input = {
      userApiKey: 'AIzaTestKey1234567890123456789012345',
      outputGain: 2.5,
      voiceName: 'Aoede',
      temperature: 0.3,
      funnyMode: 'off',
      noiseSuppression: false,
    };
    const result = sanitizeStorageConfig(input as Record<string, unknown>);
    expect(result.userApiKey).toBe('AIzaTestKey1234567890123456789012345');
    expect(result.outputGain).toBe(2.5);
    expect(result.voiceName).toBe('Aoede');
    expect(result.temperature).toBe(0.3);
    expect(result.funnyMode).toBe('off');
    expect(result.noiseSuppression).toBe(false);
  });

  it('strips unknown keys not in the allowlist', () => {
    const input = {
      outputGain: 2.5,
      unknownField: 'danger',
      anotherRogue: 42,
    };
    const result = sanitizeStorageConfig(input as Record<string, unknown>);
    expect(result.outputGain).toBe(2.5);
    expect('unknownField' in result).toBe(false);
    expect('anotherRogue' in result).toBe(false);
  });

  it('strips legacy proactiveMode field', () => {
    const input = { outputGain: 1.0, proactiveMode: true };
    const result = sanitizeStorageConfig(input as Record<string, unknown>);
    expect('proactiveMode' in result).toBe(false);
  });

  it('does NOT transfer __proto__ to the output object', () => {
    // JSON.parse of a __proto__ key creates an own property, not prototype chain.
    // sanitizeStorageConfig must NOT forward this key at all.
    const raw = JSON.parse('{"__proto__": {"evil": true}, "outputGain": 1.5}');
    const result = sanitizeStorageConfig(raw);
    // Prototype chain must not be polluted (no "evil" on the result or its chain)
    expect('evil' in result).toBe(false);
    // The __proto__ key must NOT appear as an own property on the sanitised object
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(false);
    // But valid keys are kept
    expect(result.outputGain).toBe(1.5);
  });

  it('does NOT forward constructor key', () => {
    const input = { outputGain: 1.0, constructor: 'pwned' };
    const result = sanitizeStorageConfig(input as Record<string, unknown>);
    // 'constructor' is not in AUDIO_CONFIG_KEYS → stripped
    expect(Object.prototype.hasOwnProperty.call(result, 'constructor')).toBe(false);
  });

  it('does NOT forward prototype key', () => {
    const input = { outputGain: 1.0, prototype: { isAdmin: true } };
    const result = sanitizeStorageConfig(input as Record<string, unknown>);
    expect(Object.prototype.hasOwnProperty.call(result, 'prototype')).toBe(false);
  });

  it('handles null as input gracefully (returns empty object)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(sanitizeStorageConfig(null as any)).toEqual({});
  });

  it('handles array as input gracefully (returns empty object)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(sanitizeStorageConfig(['outputGain', 2.5] as any)).toEqual({});
  });

  it('handles undefined as input gracefully (returns empty object)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(sanitizeStorageConfig(undefined as any)).toEqual({});
  });

  it('preserves boolean false (not filtered as falsy)', () => {
    const result = sanitizeStorageConfig({ noiseSuppression: false } as Record<string, unknown>);
    expect(result.noiseSuppression).toBe(false);
  });

  it('preserves numeric zero', () => {
    const result = sanitizeStorageConfig({ outputGain: 0 } as Record<string, unknown>);
    expect(result.outputGain).toBe(0);
  });

  it('preserves empty string', () => {
    const result = sanitizeStorageConfig({ userApiKey: '' } as Record<string, unknown>);
    expect(result.userApiKey).toBe('');
  });

  it('handles a full realistic config object correctly', () => {
    const full = {
      noiseSuppression: false,
      autoGainControl: false,
      outputGain: 2.5,
      softClipDrive: 1.5,
      voiceName: 'Aoede',
      showDebugInfo: false,
      userApiKey: 'AIzaSyTestKeyABC123',
      modelName: 'gemini-3.1-flash-live-preview',
      vadPrefixPaddingMs: 100,
      vadSilenceDurationMs: 500,
      vadStartSensitivity: 'low',
      temperature: 0.3,
      audioTestMode: false,
      inputBufferSize: 960,
      triggerTokens: 3000,
      funnyMode: 'off',
      // rogue extras
      proactiveMode: true,
      randomHackerField: 'ignored',
    };
    const result = sanitizeStorageConfig(full as Record<string, unknown>);
    // All 16 valid keys present
    expect(Object.keys(result).length).toBe(16);
    expect('proactiveMode' in result).toBe(false);
    expect('randomHackerField' in result).toBe(false);
  });
});
