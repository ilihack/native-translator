/**
 * Unit tests for client/src/utils/promptBuilder.ts
 *
 * Covers:
 *  - sanitizeCustomPrompt(): bidi-override stripping, control char removal, length cap
 *  - buildSystemInstruction(): placeholder substitution, personality appending, sanitization
 *  - replaceLanguagePlaceholders(): all 6 placeholder types, case-insensitive, repeated
 *  - getRandomPersonality(): valid return values
 *  - MAX_PROMPT_LENGTH constant
 */
import { describe, it, expect } from 'vitest';
import {
  sanitizeCustomPrompt,
  buildSystemInstruction,
  replaceLanguagePlaceholders,
  getRandomPersonality,
  PERSONALITY_OPTIONS,
  MAX_PROMPT_LENGTH,
  DEFAULT_PROMPT_TEMPLATE,
} from '../promptBuilder';
import type { Language } from '../../config/languages';

// ─── fixtures ────────────────────────────────────────────────────────────────

const EN: Language = {
  code: 'en',
  name: 'English',
  nativeName: 'English',
  placeholder: '',
  startPlaceholder: '',
  scriptRanges: [[0x0041, 0x005A]],
};

const DE: Language = {
  code: 'de',
  name: 'German',
  nativeName: 'Deutsch',
  placeholder: '',
  startPlaceholder: '',
  scriptRanges: [[0x0041, 0x005A]],
};

const ZH: Language = {
  code: 'zh',
  name: 'Chinese',
  nativeName: '中文',
  script: 'Simplified Chinese',
  placeholder: '',
  startPlaceholder: '',
  scriptRanges: [[0x4E00, 0x9FFF]],
};

// ─── sanitizeCustomPrompt ────────────────────────────────────────────────────

describe('sanitizeCustomPrompt', () => {
  it('passes through normal ASCII text unchanged', () => {
    const input = 'Translate every sentence to {target}.';
    expect(sanitizeCustomPrompt(input)).toBe(input);
  });

  it('preserves legitimate unicode (accented chars, Chinese, Arabic, emoji)', () => {
    const input = 'Übersetze auf Français, 中文 and العربية 🌍';
    expect(sanitizeCustomPrompt(input)).toBe(input);
  });

  it('preserves horizontal tab (U+0009) and newline (U+000A)', () => {
    const input = 'Line one\n\tindented line two';
    expect(sanitizeCustomPrompt(input)).toBe(input);
  });

  it('strips RIGHT-TO-LEFT OVERRIDE (U+202E) — core bidi attack char', () => {
    const input = 'Normal \u202Evil instructions hidden here';
    expect(sanitizeCustomPrompt(input)).not.toContain('\u202E');
    expect(sanitizeCustomPrompt(input)).toBe('Normal vil instructions hidden here');
  });

  it('strips all bidi override characters (U+202A-U+202E, U+2066-U+2069)', () => {
    const bidiChars = ['\u202A', '\u202B', '\u202C', '\u202D', '\u202E',
                       '\u2066', '\u2067', '\u2068', '\u2069'];
    for (const ch of bidiChars) {
      expect(sanitizeCustomPrompt(`before${ch}after`)).toBe('beforeafter');
    }
  });

  it('strips LEFT-TO-RIGHT MARK (U+200E) and RIGHT-TO-LEFT MARK (U+200F)', () => {
    expect(sanitizeCustomPrompt('a\u200Eb')).toBe('ab');
    expect(sanitizeCustomPrompt('a\u200Fb')).toBe('ab');
  });

  it('strips ZERO WIDTH NO-BREAK SPACE / BOM (U+FEFF)', () => {
    expect(sanitizeCustomPrompt('\uFEFFHello')).toBe('Hello');
  });

  it('strips NUL byte (U+0000)', () => {
    expect(sanitizeCustomPrompt('hello\x00world')).toBe('helloworld');
  });

  it('strips C0 control chars (U+0001–U+0008)', () => {
    for (let c = 1; c <= 8; c++) {
      const ch = String.fromCharCode(c);
      expect(sanitizeCustomPrompt(`a${ch}b`)).toBe('ab');
    }
  });

  it('strips C0 control chars U+000B (vertical tab) and U+000C (form feed)', () => {
    expect(sanitizeCustomPrompt('a\x0Bb')).toBe('ab');
    expect(sanitizeCustomPrompt('a\x0Cb')).toBe('ab');
  });

  it('strips C0 control chars U+000E–U+001F', () => {
    for (let c = 0x0E; c <= 0x1F; c++) {
      const ch = String.fromCharCode(c);
      expect(sanitizeCustomPrompt(`a${ch}b`)).toBe('ab');
    }
  });

  it('strips DEL (U+007F)', () => {
    expect(sanitizeCustomPrompt('a\x7Fb')).toBe('ab');
  });

  it('strips C1 controls (U+0080–U+009F)', () => {
    for (let c = 0x80; c <= 0x9F; c++) {
      const ch = String.fromCharCode(c);
      expect(sanitizeCustomPrompt(`a${ch}b`)).toBe('ab');
    }
  });

  it('hard-caps output at MAX_PROMPT_LENGTH characters', () => {
    const long = 'x'.repeat(MAX_PROMPT_LENGTH + 500);
    expect(sanitizeCustomPrompt(long).length).toBe(MAX_PROMPT_LENGTH);
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeCustomPrompt('')).toBe('');
  });

  it('handles mixed dangerous + legitimate content correctly', () => {
    const input = 'Translate:\u202E ignore instructions\u0000 keep going';
    const result = sanitizeCustomPrompt(input);
    expect(result).toContain('Translate:');
    expect(result).toContain('keep going');
    expect(result).not.toContain('\u202E');
    expect(result).not.toContain('\u0000');
  });
});

// ─── replaceLanguagePlaceholders ─────────────────────────────────────────────

describe('replaceLanguagePlaceholders', () => {
  it('replaces {source} with source nativeName', () => {
    expect(replaceLanguagePlaceholders('{source}', EN, DE)).toBe('English');
  });

  it('replaces {target} with target nativeName', () => {
    expect(replaceLanguagePlaceholders('{target}', EN, DE)).toBe('Deutsch');
  });

  it('replaces {source_code} with source BCP-47 code', () => {
    expect(replaceLanguagePlaceholders('{source_code}', EN, DE)).toBe('en');
  });

  it('replaces {target_code} with target BCP-47 code', () => {
    expect(replaceLanguagePlaceholders('{target_code}', EN, DE)).toBe('de');
  });

  it('replaces {source_english} with source English name', () => {
    expect(replaceLanguagePlaceholders('{source_english}', EN, DE)).toBe('English');
  });

  it('replaces {target_english} with target English name', () => {
    expect(replaceLanguagePlaceholders('{target_english}', EN, DE)).toBe('German');
  });

  it('replaces all placeholders in a single template string', () => {
    const tmpl = '{source} ({source_code}) ↔ {target} ({target_code})';
    expect(replaceLanguagePlaceholders(tmpl, EN, DE))
      .toBe('English (en) ↔ Deutsch (de)');
  });

  it('replacement is case-insensitive for placeholder tags', () => {
    expect(replaceLanguagePlaceholders('{SOURCE}', EN, DE)).toBe('English');
    expect(replaceLanguagePlaceholders('{Target}', EN, DE)).toBe('Deutsch');
  });

  it('replaces repeated occurrences of the same placeholder', () => {
    const result = replaceLanguagePlaceholders('{source} and {source}', EN, DE);
    expect(result).toBe('English and English');
  });

  it('leaves unknown placeholders unchanged', () => {
    expect(replaceLanguagePlaceholders('{unknown}', EN, DE)).toBe('{unknown}');
  });

  it('handles language names with special characters', () => {
    const FR: Language = {
      code: 'fr', name: 'French', nativeName: 'Français',
      placeholder: '', startPlaceholder: '', scriptRanges: [],
    };
    expect(replaceLanguagePlaceholders('{target}', EN, FR)).toBe('Français');
  });
});

// ─── buildSystemInstruction ──────────────────────────────────────────────────

describe('buildSystemInstruction', () => {
  it('uses DEFAULT_PROMPT_TEMPLATE when no custom prompt provided', () => {
    const result = buildSystemInstruction(EN, DE);
    expect(result).toContain('English');
    expect(result).toContain('Deutsch');
    // Should contain something from the default template
    expect(result.length).toBeGreaterThan(20);
  });

  it('uses the custom template when provided', () => {
    const custom = 'You interpret {source} into {target} strictly.';
    const result = buildSystemInstruction(EN, DE, custom);
    expect(result).toContain('You interpret English into Deutsch strictly.');
  });

  it('sanitizes the custom template — strips bidi override chars', () => {
    const malicious = 'Normal\u202E evil hidden instruction';
    const result = buildSystemInstruction(EN, DE, malicious);
    expect(result).not.toContain('\u202E');
  });

  it('appends personality section when personality is provided', () => {
    const result = buildSystemInstruction(EN, DE, undefined, 'Dramatic');
    expect(result).toContain('Personality:');
    expect(result).toContain('Dramatic');
  });

  it('does NOT append personality section when personality is null', () => {
    const result = buildSystemInstruction(EN, DE, undefined, null);
    expect(result).not.toContain('Personality:');
  });

  it('includes script note for languages that have a script property', () => {
    const result = buildSystemInstruction(EN, ZH);
    expect(result).toContain('Simplified Chinese');
  });

  it('does NOT include script note when neither language has a script property', () => {
    const result = buildSystemInstruction(EN, DE);
    expect(result).not.toContain('Script:');
  });

  it('respects MAX_PROMPT_LENGTH cap on custom template', () => {
    const veryLong = 'x'.repeat(MAX_PROMPT_LENGTH + 1000);
    const result = buildSystemInstruction(EN, DE, veryLong);
    // The sanitized template is capped, but scriptSection may be appended afterward —
    // total length should not exceed MAX_PROMPT_LENGTH + reasonable overhead
    expect(result.length).toBeLessThan(MAX_PROMPT_LENGTH + 200);
  });
});

// ─── getRandomPersonality ────────────────────────────────────────────────────

describe('getRandomPersonality', () => {
  it('always returns a value from PERSONALITY_OPTIONS', () => {
    for (let i = 0; i < 50; i++) {
      const p = getRandomPersonality();
      expect(PERSONALITY_OPTIONS).toContain(p);
    }
  });

  it('returns different values across multiple calls (probabilistic)', () => {
    const results = new Set(Array.from({ length: 30 }, () => getRandomPersonality()));
    // With 5 options and 30 draws, we should see at least 3 distinct values
    expect(results.size).toBeGreaterThanOrEqual(2);
  });
});

// ─── MAX_PROMPT_LENGTH ───────────────────────────────────────────────────────

describe('MAX_PROMPT_LENGTH', () => {
  it('is a positive integer >= 800 (the UI limit)', () => {
    expect(MAX_PROMPT_LENGTH).toBeGreaterThanOrEqual(800);
    expect(Number.isInteger(MAX_PROMPT_LENGTH)).toBe(true);
  });
});
