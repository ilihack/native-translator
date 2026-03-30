/**
 * Gemini Live API voice catalog with male and female voice options.
 * Each voice has an ID matching Gemini's voice parameter and a display label.
 * @exports VoiceOption interface, MALE_VOICES, FEMALE_VOICES arrays
 */
export interface VoiceOption {
  id: string;
  label: string;
  gender: 'male' | 'female';
  recommended?: boolean;
}

// Curated Gemini HD voices suitable for interpreter/translator applications
// Sorted by internet popularity (most used in examples/demos first)

// Male voices - sorted by popularity
export const MALE_VOICES: VoiceOption[] = [
  { id: 'Orus', label: 'Orus (Decisive)', gender: 'male', recommended: true },
  { id: 'Charon', label: 'Charon (Clear)', gender: 'male' },
  { id: 'Achird', label: 'Achird (Friendly)', gender: 'male' },
  { id: 'Iapetus', label: 'Iapetus (Articulate)', gender: 'male' },
  { id: 'Algieba', label: 'Algieba (Smooth)', gender: 'male' },
];

// Female voices - sorted by popularity
export const FEMALE_VOICES: VoiceOption[] = [
  { id: 'Aoede', label: 'Aoede (Natural)', gender: 'female', recommended: true },
  { id: 'Kore', label: 'Kore (Confident)', gender: 'female' },
  { id: 'Erinome', label: 'Erinome (Precise)', gender: 'female' },
  { id: 'Gacrux', label: 'Gacrux (Mature)', gender: 'female' },
  { id: 'Sulafat', label: 'Sulafat (Warm)', gender: 'female' },
];

// Combined list for backwards compatibility
export const VOICE_OPTIONS: VoiceOption[] = [...MALE_VOICES, ...FEMALE_VOICES];

export const DEFAULT_VOICE = 'Aoede';
