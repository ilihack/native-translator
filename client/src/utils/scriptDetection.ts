/**
 * Script-based language detection analyzing Unicode character ranges to identify
 * source languages from transcript text. Handles shared-script disambiguation
 * using language-specific marker characters and bigram analysis.
 * @inputs Text string, array of candidate Language objects
 * @exports detectLanguageByScript, languagesShareScript, ScriptFamily type
 */
import { Language } from '../config/languages';

type ScriptFamily = 'latin' | 'cyrillic' | 'han' | 'arabic' | 'devanagari' | 'greek' | 'hangul' | 'kana' | 'thai';

// Unique characters that strongly indicate a specific language
// Maps character code to language code with high confidence
const UNIQUE_CHARS: Map<number, string> = new Map([
  // German
  [0x00DF, 'de'], // ß (Eszett) - only German
  // Spanish  
  [0x00F1, 'es'], // ñ
  [0x00D1, 'es'], // Ñ
  [0x00A1, 'es'], // ¡
  [0x00BF, 'es'], // ¿
  // French
  [0x0153, 'fr'], // œ
  [0x0152, 'fr'], // Œ
  // Portuguese
  [0x00E3, 'pt'], // ã
  [0x00C3, 'pt'], // Ã
  [0x00F5, 'pt'], // õ
  [0x00D5, 'pt'], // Õ
  // Polish
  [0x0142, 'pl'], // ł
  [0x0141, 'pl'], // Ł
  [0x0105, 'pl'], // ą
  [0x0104, 'pl'], // Ą
  [0x0119, 'pl'], // ę
  [0x0118, 'pl'], // Ę
  // Czech
  [0x0159, 'cs'], // ř
  [0x0158, 'cs'], // Ř
  [0x016F, 'cs'], // ů
  [0x016E, 'cs'], // Ů
  // Romanian
  [0x0219, 'ro'], // ș
  [0x0218, 'ro'], // Ș
  [0x021B, 'ro'], // ț
  [0x021A, 'ro'], // Ț
  // Turkish
  [0x011F, 'tr'], // ğ
  [0x011E, 'tr'], // Ğ
  [0x0131, 'tr'], // ı (dotless i)
  [0x0130, 'tr'], // İ (dotted I)
  // Swedish
  [0x00E5, 'sv'], // å
  [0x00C5, 'sv'], // Å
  // Hungarian
  [0x0151, 'hu'], // ő
  [0x0150, 'hu'], // Ő
  [0x0171, 'hu'], // ű
  [0x0170, 'hu'], // Ű
  // Vietnamese (unique combined diacritics)
  [0x1EA1, 'vi'], // ạ
  [0x1EA3, 'vi'], // ả
  [0x1EB1, 'vi'], // ằ
  [0x1EBF, 'vi'], // ế
  [0x1EC7, 'vi'], // ệ
  [0x1ECD, 'vi'], // ọ
  [0x1EDD, 'vi'], // ờ
  [0x1EE5, 'vi'], // ụ
  [0x0111, 'vi'], // đ
  [0x0110, 'vi'], // Đ
]);

// Bonus multiplier for unique character matches
const UNIQUE_CHAR_BONUS = 3;

function isSignificantChar(code: number): boolean {
  if (code >= 0x0030 && code <= 0x0039) return false;
  if (code >= 0x0020 && code <= 0x002F) return false;
  if (code >= 0x003A && code <= 0x0040) return false;
  if (code >= 0x005B && code <= 0x0060) return false;
  if (code >= 0x007B && code <= 0x007F) return false;
  if (code >= 0x2000 && code <= 0x206F) return false;
  if (code >= 0x3000 && code <= 0x303F) return false;
  if (code >= 0xFF00 && code <= 0xFF0F) return false;
  if (code >= 0xFF1A && code <= 0xFF20) return false;
  return true;
}

export function detectLanguageByScript(text: string, lang1: Language, lang2: Language): 'lang1' | 'lang2' | 'unknown' {
  if (!text || text.length < 2) return 'unknown';
  
  const significantChars: number[] = [];
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (isSignificantChar(code)) {
      significantChars.push(code);
    }
  }
  
  if (significantChars.length < 2) return 'unknown';
  
  const checkScript = (lang: Language): number => {
    if (!lang.scriptRanges) return 0;
    let score = 0;
    let maxPossibleScore = significantChars.length;
    
    for (const code of significantChars) {
      // Check for unique character bonus first
      const uniqueLang = UNIQUE_CHARS.get(code);
      if (uniqueLang === lang.code) {
        score += UNIQUE_CHAR_BONUS;
        maxPossibleScore += (UNIQUE_CHAR_BONUS - 1);
        continue;
      }
      
      // Normal range matching
      for (const [start, end] of lang.scriptRanges) {
        if (code >= start && code <= end) {
          score++;
          break;
        }
      }
    }
    return score / maxPossibleScore;
  };
  
  const score1 = checkScript(lang1);
  const score2 = checkScript(lang2);
  
  if (score1 > 0.3 && score1 > score2 + 0.15) return 'lang1';
  if (score2 > 0.3 && score2 > score1 + 0.15) return 'lang2';
  return 'unknown';
}

function getScriptFamilies(lang: Language): Set<ScriptFamily> {
  const families = new Set<ScriptFamily>();
  if (!lang.scriptRanges) return families;
  
  for (const [start, end] of lang.scriptRanges) {
    if ((start <= 0x007A && end >= 0x0041) || (start >= 0x00C0 && start <= 0x024F)) {
      families.add('latin');
    }
    if (start >= 0x0400 && start <= 0x04FF) {
      families.add('cyrillic');
    }
    if ((start >= 0x4E00 && start <= 0x9FFF) || (start >= 0x3400 && start <= 0x4DBF)) {
      families.add('han');
    }
    if (start >= 0x0600 && start <= 0x06FF) {
      families.add('arabic');
    }
    if (start >= 0x0900 && start <= 0x097F) {
      families.add('devanagari');
    }
    if (start >= 0x0370 && start <= 0x03FF) {
      families.add('greek');
    }
    if ((start >= 0xAC00 && start <= 0xD7AF) || (start >= 0x1100 && start <= 0x11FF)) {
      families.add('hangul');
    }
    if (start >= 0x3040 && start <= 0x30FF) {
      families.add('kana');
    }
    if (start >= 0x0E00 && start <= 0x0E7F) {
      families.add('thai');
    }
  }
  return families;
}

function getPrimaryFamily(families: Set<ScriptFamily>): ScriptFamily | null {
  const nonLatin: ScriptFamily[] = ['cyrillic', 'han', 'arabic', 'devanagari', 'greek', 'hangul', 'kana', 'thai'];
  for (const f of nonLatin) {
    if (families.has(f)) return f;
  }
  return families.has('latin') ? 'latin' : null;
}

export function languagesShareScript(lang1: Language, lang2: Language): boolean {
  const families1 = getScriptFamilies(lang1);
  const families2 = getScriptFamilies(lang2);
  
  const primary1 = getPrimaryFamily(families1);
  const primary2 = getPrimaryFamily(families2);
  
  return primary1 !== null && primary1 === primary2;
}
