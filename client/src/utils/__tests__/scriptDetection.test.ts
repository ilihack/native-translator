/**
 * Unit tests for client/src/utils/scriptDetection.ts
 *
 * Tests are deliberately based on the REAL language fixtures from languages.ts
 * (where all languages include Latin ranges) and the algorithm's actual 0.15
 * score-margin threshold.  Only use text where one script clearly dominates.
 *
 * Covers:
 *  - detectLanguageByScript(): Cyrillic, Han, Arabic, Devanagari, Hangul,
 *    UNIQUE_CHARS bonus (ß, ñ), short-text guard, ambiguous-Latin guard
 *  - languagesShareScript(): family-level classification
 */
import { describe, it, expect } from 'vitest';
import { detectLanguageByScript, languagesShareScript } from '../scriptDetection';
import type { Language } from '../../config/languages';

// ─── Language fixtures (matching actual languages.ts entries) ─────────────────

const EN: Language = {
  code: 'en', name: 'English', nativeName: 'English',
  placeholder: '', startPlaceholder: '',
  scriptRanges: [[0x0041, 0x005A], [0x0061, 0x007A]],
};

const DE: Language = {
  code: 'de', name: 'German', nativeName: 'Deutsch',
  placeholder: '', startPlaceholder: '',
  scriptRanges: [[0x0041, 0x005A], [0x0061, 0x007A], [0x00C0, 0x024F]],
};

/** Russian — Latin + Cyrillic, matching the real config */
const RU: Language = {
  code: 'ru', name: 'Russian', nativeName: 'Русский',
  placeholder: '', startPlaceholder: '',
  scriptRanges: [[0x0041, 0x005A], [0x0061, 0x007A], [0x0400, 0x04FF]],
};

const ZH: Language = {
  code: 'zh', name: 'Chinese', nativeName: '中文',
  placeholder: '', startPlaceholder: '',
  scriptRanges: [[0x4E00, 0x9FFF], [0x3400, 0x4DBF]],
};

const JA: Language = {
  code: 'ja', name: 'Japanese', nativeName: '日本語',
  placeholder: '', startPlaceholder: '',
  scriptRanges: [[0x0041, 0x005A], [0x0061, 0x007A], [0x3040, 0x30FF], [0x4E00, 0x9FFF]],
};

const AR: Language = {
  code: 'ar', name: 'Arabic', nativeName: 'العربية',
  placeholder: '', startPlaceholder: '',
  scriptRanges: [[0x0041, 0x005A], [0x0061, 0x007A], [0x0600, 0x06FF]],
};

const HI: Language = {
  code: 'hi', name: 'Hindi', nativeName: 'हिन्दी',
  placeholder: '', startPlaceholder: '',
  scriptRanges: [[0x0041, 0x005A], [0x0061, 0x007A], [0x0900, 0x097F]],
};

const KO: Language = {
  code: 'ko', name: 'Korean', nativeName: '한국어',
  placeholder: '', startPlaceholder: '',
  scriptRanges: [[0x0041, 0x005A], [0x0061, 0x007A], [0xAC00, 0xD7AF], [0x1100, 0x11FF]],
};

const ES: Language = {
  code: 'es', name: 'Spanish', nativeName: 'Español',
  placeholder: '', startPlaceholder: '',
  scriptRanges: [[0x0041, 0x005A], [0x0061, 0x007A], [0x00C0, 0x024F]],
};

// ─── detectLanguageByScript ──────────────────────────────────────────────────

describe('detectLanguageByScript', () => {
  it('returns "unknown" for empty text', () => {
    expect(detectLanguageByScript('', EN, DE)).toBe('unknown');
  });

  it('returns "unknown" for text with fewer than 2 chars', () => {
    expect(detectLanguageByScript('A', EN, DE)).toBe('unknown');
  });

  it('returns "unknown" for text with fewer than 2 SIGNIFICANT chars', () => {
    // Only punctuation and spaces — no significant chars reach the minimum
    expect(detectLanguageByScript('... --- !!!', EN, RU)).toBe('unknown');
  });

  // ── Cyrillic detection ─────────────────────────────────────────────────────

  it('detects Russian Cyrillic text as lang1 when RU is lang1', () => {
    // Pure Cyrillic: only RU has 0x0400-0x04FF; EN does not → big margin
    const result = detectLanguageByScript('Привет мир это тест', RU, EN);
    expect(result).toBe('lang1');
  });

  it('detects Russian Cyrillic text as lang2 when RU is lang2', () => {
    const result = detectLanguageByScript('Привет мир это большой тест', EN, RU);
    expect(result).toBe('lang2');
  });

  // ── Han detection ──────────────────────────────────────────────────────────

  it('detects Chinese Han text as lang2 against English', () => {
    // ZH has no Latin ranges; EN has no Han ranges → clear separation
    const result = detectLanguageByScript('你好世界这是一个测试句子呢', EN, ZH);
    expect(result).toBe('lang2');
  });

  it('detects Chinese Han text as lang1 when ZH is lang1', () => {
    const result = detectLanguageByScript('你好世界这是一个测试句子', ZH, EN);
    expect(result).toBe('lang1');
  });

  // ── Arabic detection ───────────────────────────────────────────────────────

  it('detects Arabic-script text as lang2 against English', () => {
    // All Arabic chars (0x0600-0x06FF) are only in AR's ranges, not EN's
    const result = detectLanguageByScript('مرحبا بالعالم هذا نص عربي اختبار', EN, AR);
    expect(result).toBe('lang2');
  });

  // ── Devanagari detection ───────────────────────────────────────────────────

  it('detects Devanagari (Hindi) text as lang2 against English', () => {
    const result = detectLanguageByScript('नमस्ते दुनिया यह एक परीक्षण', EN, HI);
    expect(result).toBe('lang2');
  });

  // ── Hangul detection ───────────────────────────────────────────────────────

  it('detects Korean Hangul text as lang2 against English', () => {
    const result = detectLanguageByScript('안녕하세요 세상이 아름답습니다', EN, KO);
    expect(result).toBe('lang2');
  });

  // ── UNIQUE_CHARS bonus ─────────────────────────────────────────────────────

  it('detects German via ß UNIQUE_CHARS bonus (pure ß text scores > 0.15 margin)', () => {
    // Pure ß: EN has no matching range for ß; DE gets UNIQUE_CHAR_BONUS=3 per ß
    // score1(EN)=0/10, score2(DE)=1.0 → clear detection
    const result = detectLanguageByScript('ßßßßßßßßßß', EN, DE);
    expect(result).toBe('lang2');
  });

  it('detects Spanish via ñ UNIQUE_CHARS bonus (pure ñ text)', () => {
    // EN has no range for ñ; ES gets UNIQUE_CHAR_BONUS for ñ (0x00F1)
    const result = detectLanguageByScript('ñññññññññ', EN, ES);
    expect(result).toBe('lang2');
  });

  // ── Ambiguous Latin ────────────────────────────────────────────────────────

  it('returns "unknown" for plain ASCII text between two Latin-script languages', () => {
    // Both EN and DE have the same Latin ranges → tie → unknown
    const result = detectLanguageByScript('Hello world test sentence', EN, DE);
    expect(result).toBe('unknown');
  });

  it('returns "unknown" for plain ASCII text when comparing EN and RU (both have Latin)', () => {
    // Both EN and RU share Latin ranges → ASCII text is ambiguous
    const result = detectLanguageByScript('Hello world test', EN, RU);
    expect(result).toBe('unknown');
  });
});

// ─── languagesShareScript ────────────────────────────────────────────────────

describe('languagesShareScript', () => {
  it('returns true for two languages that share a primary Latin family', () => {
    // EN primary = 'latin', DE primary = 'latin' → share
    expect(languagesShareScript(EN, DE)).toBe(true);
  });

  it('returns true for EN and ES (both Latin primary)', () => {
    expect(languagesShareScript(EN, ES)).toBe(true);
  });

  it('returns false for Latin (EN) vs Han (ZH) — ZH has no Latin ranges', () => {
    // EN primary = 'latin', ZH primary = 'han' → no share
    expect(languagesShareScript(EN, ZH)).toBe(false);
  });

  it('returns false for Latin (EN) vs Hangul (KO)', () => {
    // KO has Latin ranges but getPrimaryFamily prefers non-latin scripts → hangul
    expect(languagesShareScript(EN, KO)).toBe(false);
  });

  it('returns false for Latin (EN) vs Cyrillic-primary (RU)', () => {
    // RU has both Latin and Cyrillic ranges; getPrimaryFamily picks cyrillic first
    expect(languagesShareScript(EN, RU)).toBe(false);
  });

  it('is symmetric: shareScript(A,B) === shareScript(B,A)', () => {
    expect(languagesShareScript(EN, RU)).toBe(languagesShareScript(RU, EN));
    expect(languagesShareScript(ZH, JA)).toBe(languagesShareScript(JA, ZH));
    expect(languagesShareScript(EN, DE)).toBe(languagesShareScript(DE, EN));
  });

  it('returns false for languages with no scriptRanges (both null primary)', () => {
    // primary1 = null, primary2 = null → primary1 !== null is false → returns false
    const BARE: Language = {
      code: 'xx', name: 'Unknown', nativeName: 'Unknown',
      placeholder: '', startPlaceholder: '',
    };
    expect(languagesShareScript(BARE, BARE)).toBe(false);
  });

  it('returns true for two Han-primary languages (ZH and JA share Han)', () => {
    // ZH primary = 'han', JA primary = 'han' → share
    expect(languagesShareScript(ZH, JA)).toBe(true);
  });
});
