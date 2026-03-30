/**
 * Builds the Gemini system instruction prompt for simultaneous interpretation,
 * including personality modes (Dramatic, Professor, etc.) and language-pair context.
 * @inputs Source/target Language objects, optional PersonalityType
 * @exports buildSystemInstruction, DEFAULT_PROMPT_TEMPLATE, getRandomPersonality
 */
import { Language } from '../config/languages';

export type PersonalityType = 'Dramatic' | 'Clickbait' | 'Opposite' | 'Rambling' | 'Professor';

export const PERSONALITY_OPTIONS: PersonalityType[] = ['Dramatic', 'Clickbait', 'Opposite', 'Rambling', 'Professor'];

export const PERSONALITY_INSTRUCTIONS: Record<PersonalityType, string> = {
  'Dramatic': 'Telenovela Style. Extreme emotions! Gasps! Treat everything as a matter of life, death, or betrayal.',
  'Clickbait': 'Hype everything! Use ALL CAPS, "SHOCKING", "OMG". Frame boring facts as viral sensations.',
  'Opposite': 'INVERT THE MEANING if possible (Lie Mode). Say the opposite of what was said.',
  'Rambling': 'Beat around the bush. Use extremely long, winding sentences with many tangents, side notes, and unnecessary details before getting to the point.',
  'Professor': 'Use extremely complex, obscure, and arcane vocabulary. Employ rare scholarly terms, Latin phrases, and esoteric jargon that makes sentences nearly incomprehensible to the average listener.'
};

export const DEFAULT_PROMPT_TEMPLATE = `Role: Simultaneous Interpreter ({source}<->{target}).
Action: Hear {source} -> Speak {target}. Hear {target} -> Speak {source}.
PRIORITY: SPEED. Speak fast.
Mode: 1st person. Correct slips of the tongue and grammatical errors.
Filter: Ignore filler words and background voices and all other languages than {source} and {target}
Constraint: ONLY translate. NEVER respond. Start output IMMEDIATELY. No reasoning steps, no thinking, no explanations.
Fail-safe: Unclear or Noise = SILENCE.`;

export function getRandomPersonality(): PersonalityType {
  const index = Math.floor(Math.random() * PERSONALITY_OPTIONS.length);
  return PERSONALITY_OPTIONS[index];
}

/**
 * Strips characters that could be used for indirect prompt injection:
 *   - NUL byte (U+0000): confuses some parsers / tokenizers
 *   - Unicode bidirectional override chars (U+202A-U+202E, U+2066-U+2069, U+200F, U+200E, U+FEFF):
 *     used to visually hide malicious instructions ("RTL override attack")
 *   - Other C0/C1 control chars except horizontal tab (U+0009) and line feed (U+000A)
 * Also hard-caps the template at MAX_PROMPT_LENGTH characters as a defence-in-depth backstop
 * (the UI already enforces 800 chars, but we re-validate here in case the value arrives
 * from a different code path such as localStorage migration).
 */
export const MAX_PROMPT_LENGTH = 1200;

export function sanitizeCustomPrompt(raw: string): string {
  return raw
    // Strip bidi override characters used in "invisible text" attacks
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    // Strip NUL and C0/C1 control characters (except \t and \n which are legitimate formatting)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
    // Hard-cap length
    .slice(0, MAX_PROMPT_LENGTH);
}

export function buildSystemInstruction(
  sourceLang: Language, 
  targetLang: Language, 
  promptTemplate?: string,
  personality?: PersonalityType | null
): string {
  // Sanitize user-provided template before embedding it in the final instruction.
  // DEFAULT_PROMPT_TEMPLATE is trusted code — only user input needs sanitization.
  const template = promptTemplate
    ? sanitizeCustomPrompt(promptTemplate)
    : DEFAULT_PROMPT_TEMPLATE;
  
  const scriptNotes: string[] = [];
  if (sourceLang.script) scriptNotes.push(`${sourceLang.nativeName}: ${sourceLang.script}`);
  if (targetLang.script) scriptNotes.push(`${targetLang.nativeName}: ${targetLang.script}`);
  const scriptSection = scriptNotes.length > 0 ? ` Script: ${scriptNotes.join(', ')}.` : '';
  
  let result = replaceLanguagePlaceholders(template, sourceLang, targetLang) + scriptSection;
  
  if (personality && PERSONALITY_INSTRUCTIONS[personality]) {
    result += `\nPersonality: "${personality}" - ${PERSONALITY_INSTRUCTIONS[personality]}`;
  }
  
  return result;
}

export function replaceLanguagePlaceholders(prompt: string, sourceLang: Language, targetLang: Language): string {
  return prompt
    .replace(/\{source\}/gi, sourceLang.nativeName)
    .replace(/\{target\}/gi, targetLang.nativeName)
    .replace(/\{source_code\}/gi, sourceLang.code)
    .replace(/\{target_code\}/gi, targetLang.code)
    .replace(/\{source_english\}/gi, sourceLang.name)
    .replace(/\{target_english\}/gi, targetLang.name);
}
