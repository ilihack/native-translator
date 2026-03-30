/**
 * Language catalog defining all 24 supported languages with BCP-47 codes, native names,
 * script families, and RTL flags. Provides lookup helpers and browser language detection.
 * @exports Language interface, SUPPORTED_LANGUAGES array, getLanguageByCode, detectBrowserLanguage
 */
import { logger } from '../utils/logger';

export interface Language {
  code: string;
  name: string;
  nativeName: string;
  script?: string;
  placeholder: string;
  startPlaceholder: string;
  scriptRanges?: [number, number][];
}

// Sorted by number of total speakers worldwide (native + second language)
export const SUPPORTED_LANGUAGES: Language[] = [
  { code: 'en', name: 'English', nativeName: 'English', placeholder: 'Start speaking...', startPlaceholder: 'Please start...', scriptRanges: [[0x0041, 0x005A], [0x0061, 0x007A]] },
  { code: 'zh', name: 'Chinese', nativeName: '中文', placeholder: '请直接说话...', startPlaceholder: '请开始...', scriptRanges: [[0x4E00, 0x9FFF], [0x3400, 0x4DBF]] },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', placeholder: 'बोलना शुरू करें...', startPlaceholder: 'कृपया शुरू करें...', scriptRanges: [[0x0041, 0x005A], [0x0061, 0x007A], [0x0900, 0x097F]] },
  { code: 'es', name: 'Spanish', nativeName: 'Español', placeholder: 'Empieza a hablar...', startPlaceholder: 'Por favor inicia...', scriptRanges: [[0x0041, 0x005A], [0x0061, 0x007A], [0x00C0, 0x024F]] },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', placeholder: 'ابدأ بالتحدث...', startPlaceholder: 'يرجى البدء...', scriptRanges: [[0x0041, 0x005A], [0x0061, 0x007A], [0x0600, 0x06FF]] },
  { code: 'fr', name: 'French', nativeName: 'Français', placeholder: 'Commencez à parler...', startPlaceholder: 'Veuillez démarrer...', scriptRanges: [[0x0041, 0x005A], [0x0061, 0x007A], [0x00C0, 0x024F]] },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português', placeholder: 'Comece a falar...', startPlaceholder: 'Por favor inicie...', scriptRanges: [[0x0041, 0x005A], [0x0061, 0x007A], [0x00C0, 0x024F]] },
  { code: 'ru', name: 'Russian', nativeName: 'Русский', placeholder: 'Начните говорить...', startPlaceholder: 'Пожалуйста начните...', scriptRanges: [[0x0041, 0x005A], [0x0061, 0x007A], [0x0400, 0x04FF]] },
  { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia', placeholder: 'Mulai berbicara...', startPlaceholder: 'Silakan mulai...', scriptRanges: [[0x0041, 0x005A], [0x0061, 0x007A]] },
  { code: 'ja', name: 'Japanese', nativeName: '日本語', placeholder: '話し始めてください...', startPlaceholder: '開始してください...', scriptRanges: [[0x0041, 0x005A], [0x0061, 0x007A], [0x3040, 0x30FF], [0x4E00, 0x9FFF]] },
  { code: 'de', name: 'German', nativeName: 'Deutsch', placeholder: 'Bitte sprechen...', startPlaceholder: 'Bitte starten...', scriptRanges: [[0x0041, 0x005A], [0x0061, 0x007A], [0x00C0, 0x024F]] },
  { code: 'ko', name: 'Korean', nativeName: '한국어', placeholder: '말씀해 주세요...', startPlaceholder: '시작해 주세요...', scriptRanges: [[0x0041, 0x005A], [0x0061, 0x007A], [0xAC00, 0xD7AF], [0x1100, 0x11FF]] },
  { code: 'tr', name: 'Turkish', nativeName: 'Türkçe', placeholder: 'Konuşmaya başlayın...', startPlaceholder: 'Lütfen başlatın...', scriptRanges: [[0x0041, 0x005A], [0x0061, 0x007A], [0x00C0, 0x024F]] },
  { code: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt', placeholder: 'Hãy bắt đầu nói...', startPlaceholder: 'Vui lòng bắt đầu...', scriptRanges: [[0x0041, 0x005A], [0x0061, 0x007A], [0x00C0, 0x024F], [0x1E00, 0x1EFF]] },
  { code: 'it', name: 'Italian', nativeName: 'Italiano', placeholder: 'Inizia a parlare...', startPlaceholder: 'Per favore avvia...', scriptRanges: [[0x0041, 0x005A], [0x0061, 0x007A], [0x00C0, 0x024F]] },
  { code: 'th', name: 'Thai', nativeName: 'ไทย', placeholder: 'เริ่มพูดได้เลย...', startPlaceholder: 'กรุณาเริ่มต้น...', scriptRanges: [[0x0041, 0x005A], [0x0061, 0x007A], [0x0E00, 0x0E7F]] },
  { code: 'pl', name: 'Polish', nativeName: 'Polski', placeholder: 'Zacznij mówić...', startPlaceholder: 'Proszę rozpocząć...', scriptRanges: [[0x0041, 0x005A], [0x0061, 0x007A], [0x00C0, 0x024F]] },
  { code: 'uk', name: 'Ukrainian', nativeName: 'Українська', placeholder: 'Починайте говорити...', startPlaceholder: 'Будь ласка почніть...', scriptRanges: [[0x0041, 0x005A], [0x0061, 0x007A], [0x0400, 0x04FF]] },
  { code: 'nl', name: 'Dutch', nativeName: 'Nederlands', placeholder: 'Begin te spreken...', startPlaceholder: 'Gelieve te starten...', scriptRanges: [[0x0041, 0x005A], [0x0061, 0x007A], [0x00C0, 0x024F]] },
  { code: 'ro', name: 'Romanian', nativeName: 'Română', placeholder: 'Începeți să vorbiți...', startPlaceholder: 'Vă rugăm să începeți...', scriptRanges: [[0x0041, 0x005A], [0x0061, 0x007A], [0x00C0, 0x024F]] },
  { code: 'el', name: 'Greek', nativeName: 'Ελληνικά', placeholder: 'Ξεκινήστε να μιλάτε...', startPlaceholder: 'Παρακαλώ ξεκινήστε...', scriptRanges: [[0x0041, 0x005A], [0x0061, 0x007A], [0x0370, 0x03FF]] },
  { code: 'hu', name: 'Hungarian', nativeName: 'Magyar', placeholder: 'Kezdjen el beszélni...', startPlaceholder: 'Kérjük indítsa el...', scriptRanges: [[0x0041, 0x005A], [0x0061, 0x007A], [0x00C0, 0x024F]] },
  { code: 'cs', name: 'Czech', nativeName: 'Čeština', placeholder: 'Začněte mluvit...', startPlaceholder: 'Prosím spusťte...', scriptRanges: [[0x0041, 0x005A], [0x0061, 0x007A], [0x00C0, 0x024F]] },
  { code: 'sv', name: 'Swedish', nativeName: 'Svenska', placeholder: 'Börja tala...', startPlaceholder: 'Vänligen starta...', scriptRanges: [[0x0041, 0x005A], [0x0061, 0x007A], [0x00C0, 0x024F]] },
];

export const DEFAULT_SOURCE_LANG = 'en';
export const DEFAULT_TARGET_LANG = 'zh';

export function getLanguageByCode(code: string): Language | undefined {
  return SUPPORTED_LANGUAGES.find(l => l.code === code);
}

export function getDefaultSourceLang(): Language {
  return SUPPORTED_LANGUAGES.find(l => l.code === DEFAULT_SOURCE_LANG)!;
}

export function getDefaultTargetLang(): Language {
  return SUPPORTED_LANGUAGES.find(l => l.code === DEFAULT_TARGET_LANG)!;
}

/**
 * Detects the browser/device language and returns a matching supported language code.
 * Falls back to English ('en') if no match is found.
 */
export function detectBrowserLanguage(): string {
  try {
    // Get browser languages (ordered by preference)
    const browserLanguages = navigator.languages?.length 
      ? navigator.languages 
      : [navigator.language];
    
    for (const browserLang of browserLanguages) {
      if (!browserLang) continue;
      
      // Try exact match first (e.g., 'en-US' -> 'en')
      const langCode = browserLang.split('-')[0].toLowerCase();
      
      // Check if this language code is supported
      const supported = SUPPORTED_LANGUAGES.find(l => l.code === langCode);
      if (supported) {
        return supported.code;
      }
    }
  } catch (e) {
    logger.general.debug('Browser language detection failed, falling back to English', e);
  }
  
  // Fallback to English
  return DEFAULT_SOURCE_LANG;
}
