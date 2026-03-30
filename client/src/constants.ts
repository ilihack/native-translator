/**
 * Re-export barrel aggregating all public constants, types, and utilities from
 * config/, utils/promptBuilder, and utils/scriptDetection into a single import path.
 * @exports SUPPORTED_LANGUAGES, voice arrays, prompt builders, script detection utilities
 */
export { 
  SUPPORTED_LANGUAGES, 
  DEFAULT_SOURCE_LANG, 
  DEFAULT_TARGET_LANG,
  getLanguageByCode,
  getDefaultSourceLang,
  getDefaultTargetLang,
  detectBrowserLanguage,
  type Language 
} from './config/languages';

export { VOICE_OPTIONS, MALE_VOICES, FEMALE_VOICES, DEFAULT_VOICE, type VoiceOption } from './config/voices';

export { MAX_SESSION_DURATION, BACKGROUND_TIMEOUT, AUDIO_CONFIG, GEMINI_DEFAULTS } from './config';

export { detectLanguageByScript, languagesShareScript } from './utils/scriptDetection';

export { 
  buildSystemInstruction, 
  replaceLanguagePlaceholders, 
  DEFAULT_PROMPT_TEMPLATE,
  getRandomPersonality,
  PERSONALITY_OPTIONS,
  PERSONALITY_INSTRUCTIONS,
  type PersonalityType
} from './utils/promptBuilder';

export { RECORDER_WORKLET_CODE as WORKLET_CODE, PCM_PLAYER_WORKLET_CODE } from './audio';

import { buildSystemInstruction } from './utils/promptBuilder';
import { getDefaultSourceLang, getDefaultTargetLang } from './config/languages';

export const SYSTEM_INSTRUCTION = buildSystemInstruction(
  getDefaultSourceLang(),
  getDefaultTargetLang()
);
