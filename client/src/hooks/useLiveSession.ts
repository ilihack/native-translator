/**
 * Core React hook managing the full Gemini Live API session lifecycle: WebSocket connection,
 * bidirectional audio streaming, microphone capture via AudioWorklet, playback pipeline,
 * and automatic reconnection with exponential backoff.
 * @inputs API key, language pair, voice selection, audio device config
 * @exports useLiveSession hook returning session controls, audio levels, and connection state
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { type Session, type LiveServerMessage, type LiveServerContent } from '@google/genai';
import { ConnectionStatus, SessionState } from '../types';
import { decode, createBlobFromInt16, calculatePeakFromInt16, playSignalTone } from '../utils/audio';
import { WORKLET_CODE, PCM_PLAYER_WORKLET_CODE, MAX_SESSION_DURATION, BACKGROUND_TIMEOUT, AUDIO_CONFIG, GEMINI_DEFAULTS, SUPPORTED_LANGUAGES, buildSystemInstruction, DEFAULT_PROMPT_TEMPLATE, DEFAULT_TARGET_LANG, detectLanguageByScript, languagesShareScript, detectBrowserLanguage, Language, getRandomPersonality, PersonalityType } from '../constants';
import { useSessionMachine } from './useSessionMachine';
import { useReconnection } from './useReconnection';
import { useAudioLevelMeter } from './useAudioLevelMeter';
import { logger } from '../utils/logger';
import { sanitizeStorageConfig } from '../utils/storageConfig';

declare global {
  interface Window {
    /** Safari vendor-prefix fallback for AudioContext (removed in Safari 14.1+). */
    webkitAudioContext?: typeof AudioContext;
  }
}

export type FunnyMode = 'off' | 'random' | 'Dramatic' | 'Clickbait' | 'Opposite' | 'Rambling' | 'Professor';

/** Extends SDK type to include undocumented `.error` fields the Gemini Live server may return. */
type LiveServerMessageWithError = LiveServerMessage & {
  error?: { message?: string };
  serverContent?: LiveServerContent & { error?: { message?: string } };
};

export interface AudioConfig {
  noiseSuppression: boolean;
  autoGainControl: boolean;
  outputGain: number;
  softClipDrive: number; // Soft clipping intensity (1.0 = gentle, 3.0+ = aggressive)
  voiceName: string;
  showDebugInfo: boolean;
  userApiKey: string;
  modelName: string;
  vadPrefixPaddingMs: number;
  vadSilenceDurationMs: number;
  vadStartSensitivity: 'low' | 'high'; // VAD start of speech sensitivity
  temperature: number;
  audioTestMode: boolean;
  inputBufferSize: number; // Audio input buffer size in samples (default 960 = 20ms at 48kHz)
  triggerTokens: number; // Context window compression trigger threshold (default 30000)
  funnyMode: FunnyMode; // Personality mode for fun translations
}

export const STORAGE_KEY = 'gemini_interpreter_config_v6';
const PREV_STORAGE_KEY = 'gemini_interpreter_config_v5';

// ─── Audio timing constants ────────────────────────────────────────────────────
/** Debounce delay (ms) after last inputText before treating silence as user-speech start.
 *  Protects against late audio packets being echoed during user speech. */
const INPUT_SILENCE_DELAY_MS = 150;
/** Duration (s) of the audio self-test recording captured before playback. */
const AUDIO_TEST_DURATION_SEC = 5;
/** Total samples captured during the audio self-test (16 kHz × 5 s = 80 000). */
const AUDIO_TEST_BUFFER_SIZE = AUDIO_CONFIG.INPUT_SAMPLE_RATE * AUDIO_TEST_DURATION_SEC;

// Creates a tanh soft-clipping curve for WaveShaperNode.
// The gain is EMBEDDED inside the curve so the GainNode stays at unity (1.0).
// This prevents the hard-clipping artefact that occurs when the GainNode outputs
// values > 1.0 and the WaveShaperNode clamps them before applying the tanh curve.
//
// With the gain embedded:
//   • Quiet audio (amplitude ≈ 0.1) is boosted up to ~gain× before saturation.
//   • Loud audio (amplitude = 1.0) saturates smoothly to ≤ 1.0 — no hard clip.
//
// @param samples  Number of curve points (resolution).
// @param drive    Saturation steepness — higher = harder knee (1.0 = gentle).
// @param gain     Target loudness multiplier baked into the curve (e.g. 2.5).
const createSoftClipCurve = (samples: number = 8192, drive: number = 1.5, gain: number = 1.0): Float32Array => {
  const curve = new Float32Array(samples);
  const normalizer = Math.tanh(gain * drive); // normalise so output peaks at 1.0
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1; // -1 … +1
    curve[i] = Math.tanh(x * gain * drive) / normalizer;
  }
  return curve;
};

// Convenience aliases drawn from the central AUDIO_CONFIG constant.
// AUDIO_CONFIG.INPUT_SAMPLE_RATE  = 16 000 Hz  — PCM sent TO the Gemini API
// AUDIO_CONFIG.GEMINI_SAMPLE_RATE = 24 000 Hz  — PCM received FROM the Gemini API
const INPUT_SAMPLE_RATE  = AUDIO_CONFIG.INPUT_SAMPLE_RATE;   // 16 000
const OUTPUT_SAMPLE_RATE = AUDIO_CONFIG.GEMINI_SAMPLE_RATE;  // 24 000

// ─── Reconnection & retry timing (see useReconnection.ts for scheduleRetry) ──
/** Max WebSocket reconnect attempts before giving up and showing a hard error. */
const MAX_RECONNECT_ATTEMPTS = 4;
/** Base delay (ms) for exponential-backoff reconnects: 1 s → 2 s → 4 s → 8 s. */
const RECONNECT_DELAY_BASE = 1000;
/** Fixed retry delay (ms) for 429 / RESOURCE_EXHAUSTED errors.
 *  Gemini free-tier RPM reset is typically 60 s; paid tiers may have shorter windows.
 *  We wait a full minute to be safe before the single automatic retry. */
const RATE_LIMIT_RETRY_DELAY_MS = 60_000;
/** Polling interval (ms) used by scheduleRetry when retry conditions aren't met yet. */
/** RETRY_POLL_INTERVAL lives in useReconnection.ts */
/** Silence threshold (ms) after which an open WebSocket is considered stale. */
const CONNECTION_HEALTH_TIMEOUT = 8000;

// ─── AudioContext resume (iOS Safari workaround) ──────────────────────────────
/** Max attempts to resume a suspended AudioContext (Safari often needs multiple tries). */
const MAX_AUDIO_RESUME_ATTEMPTS = 3;
/** Delay (ms) between successive AudioContext resume attempts. */
const AUDIO_RESUME_DELAY_MS = 150;

export const useLiveSession = () => {
  // ─────────────────────────────────────────────────────────────────────────────
  // TABLE OF CONTENTS
  //   § 1  STATE & REF DECLARATIONS
  //   § 2  RECONNECT SCHEDULING    (useReconnection sub-hook)
  //   § 3  SYNCHRONISATION EFFECTS & AUDIO LEVEL METERING
  //   § 4  SESSION LIFECYCLE HELPERS   (cleanupSession · stopSession)
  //   § 5  startSession   (WebSocket connect · AudioWorklet · PCM pipeline)
  // ─────────────────────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────────────────────
  // § 1  STATE & REF DECLARATIONS
  //      All useState / useRef declarations for the hook.  Organised by concern:
  //      audio, session, UI, reconnect, mute.
  // ─────────────────────────────────────────────────────────────────────────────
  const { context, send, canStart, canStop, isConnected, isSpeaking, isConnectionDegraded } = useSessionMachine();

  // ─── Prewarm AudioContext refs (replaces module-level globals) ────────────────
  // Kept as refs so React StrictMode double-mount cannot leak stale AudioContexts.
  const audioPrewarmedRef = useRef<boolean>(false);
  const prewarmedInputCtxRef = useRef<AudioContext | null>(null);
  const prewarmedOutputCtxRef = useRef<AudioContext | null>(null);

  const [isOutputMuted, setIsOutputMuted] = useState(false);
  const [isInputMuted, setIsInputMuted] = useState(false);
  const [actualInRate, setActualInRate] = useState<number>(0);
  const [actualOutRate, setActualOutRate] = useState<number>(0);
  const [inputBaseLatency, setInputBaseLatency] = useState<number>(0);
  const [outputBaseLatency, setOutputBaseLatency] = useState<number>(0);
  const [processingTime, setProcessingTime] = useState<number>(0);

  const [sourceLangCode, setSourceLangCode] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.sourceLangCode) {
          return parsed.sourceLangCode;
        }
      }
      // First launch: detect browser/device language, fallback to English
      return detectBrowserLanguage();
    } catch (e) { 
      logger.general.debug('Failed to load sourceLangCode from storage', e); 
      return detectBrowserLanguage(); 
    }
  });

  const [targetLangCode, setTargetLangCode] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved).targetLangCode || DEFAULT_TARGET_LANG : DEFAULT_TARGET_LANG;
    } catch (e) { logger.general.debug('Failed to load targetLangCode from storage', e); return DEFAULT_TARGET_LANG; }
  });

  const sourceLang = SUPPORTED_LANGUAGES.find(l => l.code === sourceLangCode) || SUPPORTED_LANGUAGES[0];
  const targetLang = SUPPORTED_LANGUAGES.find(l => l.code === targetLangCode) || SUPPORTED_LANGUAGES[1];
  
  const [customPrompt, setCustomPrompt] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved).customPrompt || '' : '';
    } catch (e) { logger.general.debug('Failed to load customPrompt from storage', e); return ''; }
  });
  
  // Session personality: calculated once per session start for 'random' mode
  const [sessionPersonality, setSessionPersonality] = useState<PersonalityType | null>(null);
  
  // Refresh session personality when funnyMode changes or on new session
  const refreshSessionPersonality = useCallback((funnyMode: FunnyMode) => {
    if (funnyMode === 'off') {
      setSessionPersonality(null);
    } else if (funnyMode === 'random') {
      setSessionPersonality(getRandomPersonality());
    } else {
      setSessionPersonality(funnyMode as PersonalityType);
    }
  }, []);
  
  // Build final system instruction with placeholders replaced
  // Supported: {source}, {target}, {source_code}, {target_code}, {source_english}, {target_english}
  const systemInstruction = buildSystemInstruction(
    sourceLang, 
    targetLang, 
    customPrompt.trim() || undefined,
    sessionPersonality
  );

  // Sync ref for immediate use in session start
  const systemInstructionRef = useRef(systemInstruction);
  useEffect(() => {
    systemInstructionRef.current = systemInstruction;
  }, [systemInstruction]);
  
  const sourceLangRef = useRef<Language>(sourceLang);
  const targetLangRef = useRef<Language>(targetLang);
  // Track last displayed content type for same-script pairs (mirror mode)
  const mirrorLastTypeRef = useRef<'input' | 'output' | null>(null);
  // Cache same-script check (computed once per language pair)
  const sameScriptCacheRef = useRef<boolean>(languagesShareScript(sourceLang, targetLang));
  
  useEffect(() => {
    sourceLangRef.current = sourceLang;
    targetLangRef.current = targetLang;
    // Reset mirror state and recompute script cache when languages change
    mirrorLastTypeRef.current = null;
    sameScriptCacheRef.current = languagesShareScript(sourceLang, targetLang);
  }, [sourceLang, targetLang]);

  const [config, setConfig] = useState<AudioConfig>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
         const raw = JSON.parse(saved).config;
         // sanitizeStorageConfig strips every key not in AUDIO_CONFIG_KEYS before spreading,
         // preventing unknown keys (including legacy fields such as proactiveMode and any
         // attacker-injected property names) from reaching the session config.
         const loaded: AudioConfig = { 
           noiseSuppression: false,
           autoGainControl: false,
           outputGain: 2.5,
           softClipDrive: 1.5,
           voiceName: 'Aoede',
           showDebugInfo: false,
           userApiKey: '',
           modelName: 'gemini-3.1-flash-live-preview',
           vadPrefixPaddingMs: 50,
           vadSilenceDurationMs: 300,
           vadStartSensitivity: 'low' as const,
           temperature: 0.7,
           audioTestMode: false,
           inputBufferSize: 960,
           triggerTokens: 0,
           funnyMode: 'off' as const,
           ...sanitizeStorageConfig(raw || {}) 
         };
         // ── One-time migration: 3000 was the old bad default — it fired every ~2 min
         // which caused audible mid-sentence stops (server pauses model while pruning).
         // Reset to 0 (disabled); users can enable manually if needed.
         if (loaded.triggerTokens === 3000 || loaded.triggerTokens === 25000) {
           loaded.triggerTokens = 0;
           logger.general.info('Migrated triggerTokens to 0 (disabled compression)');
         }
         return loaded;
      }
    } catch (e) { logger.general.debug('Failed to load config from storage', e); }
    // Rescue API key from previous version's storage if available
    let rescuedApiKey = '';
    try {
      const prev = localStorage.getItem(PREV_STORAGE_KEY);
      if (prev) rescuedApiKey = JSON.parse(prev)?.config?.userApiKey ?? '';
    } catch (e) { logger.general.debug('Legacy API key rescue failed (JSON parse error)', e); }
    return {
      noiseSuppression: false,
      autoGainControl: false,
      outputGain: 2.5,
      softClipDrive: 1.5,
      voiceName: 'Aoede',
      showDebugInfo: false,
      userApiKey: rescuedApiKey,
      modelName: 'gemini-3.1-flash-live-preview',
      vadPrefixPaddingMs: 50,
      vadSilenceDurationMs: 300,
      vadStartSensitivity: 'low' as const,
      temperature: 0.7,
      audioTestMode: false,
      inputBufferSize: 960,
      triggerTokens: 0,
      funnyMode: 'off' as const,
    };
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ config, sourceLangCode, targetLangCode, customPrompt }));
    } catch (e) { logger.general.warn("Failed to save config", e); }
  }, [config, sourceLangCode, targetLangCode, customPrompt]);

  // Update session personality when funnyMode changes
  useEffect(() => {
    refreshSessionPersonality(config.funnyMode);
  }, [config.funnyMode, refreshSessionPersonality]);

  const configRef = useRef<AudioConfig>(config);
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const outputGainNodeRef = useRef<GainNode | null>(null);
  const softClipNodeRef = useRef<WaveShaperNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // PWA auto-start: when set, getUserMedia races against this timeout (ms).
  // Null = no timeout (manual start). Set by the auto-start effect in standalone mode.
  const micPermissionTimeoutMsRef = useRef<number | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const inputAnalyserRef = useRef<AnalyserNode | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);
  const activeSessionRef = useRef<Session | null>(null);
  const lastAudioSendTimeRef = useRef<number>(0);
  const lastRecorderIntervalRef = useRef<number>(0);
  const awaitingFirstResponseRef = useRef<boolean>(false);
  const isOutputMutedRef = useRef(false);
  const isInputMutedRef = useRef(false);
  const shouldClearOnNextRef = useRef<boolean>(true);
  const lastLatencyUpdateRef = useRef<number>(0);
  const isPlayingAudioRef = useRef<boolean>(false);
  /** Three turn-lifecycle flags grouped in one ref to reduce per-turn reset boilerplate.
   *  turnCompleted     — set true on turnComplete server event, cleared when reset conditions met.
   *  audioEndedAfterTurn — true when player fires 'ended' after turnComplete (incl. 400ms tail).
   *  speakingTurnEnded — true when SPEAKING turn is fully over; gates audio-drop logic. */
  const turnStateRef = useRef({ turnCompleted: false, audioEndedAfterTurn: false, speakingTurnEnded: false });
  const turnResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // Timer for input silence detection
  const hadInputRef = useRef<boolean>(false); // True when valid inputText appeared after audio ended (not echo)
  // inputSilenceElapsedRef: True when 150ms passed since last inputText
  // The 150ms delay protects against late audio packets being played during user speech
  const inputSilenceElapsedRef = useRef<boolean>(false);
  const sessionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const workletUrlRef = useRef<string | null>(null);
  const pcmPlayerUrlRef = useRef<string | null>(null);
  const pcmPlayerNodeRef = useRef<AudioWorkletNode | null>(null);
  // Track which AudioContexts have had worklet modules successfully registered.
  // Re-calling addModule on the same context during reconnects can hang on Android Chrome
  // because the browser sees the module as "already loading" and the promise never resolves.
  const workletRegisteredCtxRef = useRef<Set<AudioContext>>(new Set());
  const pendingOperationRef = useRef<boolean>(false);
  const lastMessageTimeRef = useRef<number>(Date.now());
  const connectionHealthIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isConnectedRef = useRef<boolean>(false);
  const sessionStateRef = useRef<SessionState>(SessionState.IDLE); // Track session state for audio processing
  const backgroundTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backgroundStartRef = useRef<number | null>(null);
  // reconnectAttemptRef / reconnectTimeoutRef / shouldAutoReconnectRef live in useReconnection (below §2)
  const startSessionRef = useRef<(() => Promise<void>) | null>(null);
  const sessionValidationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionValidatedRef = useRef<boolean>(false);
  const isStartingRef = useRef<boolean>(false); // True from start request until validation or failure
  const wasStreamingAudioRef = useRef<boolean>(false); // Track if we were sending audio before pause
  const hasEverConnectedRef = useRef<boolean>(false); // True after first-ever session validate (fresh launch detection)
  const startupQuietUntilRef = useRef<number>(0);     // Timestamp: suppress mic audio until this time on first launch
  const postSpeechSuppressUntilRef = useRef<number>(0); // Timestamp: suppress mic after AI speech ends (echo prevention)
  const speakingWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null); // Watchdog: auto-reconnect if stuck in SPEAKING
  const lastPcmChunkTimeRef = useRef<number>(0); // Timestamp of last PCM audio chunk received from API (used by SPEAKING watchdog)
  const turnSpeakingStartRef = useRef<number>(0); // Timestamp when current SPEAKING turn began (for silence detection)
  const turnHadRealAudioRef = useRef<boolean>(false); // True once any non-zero PCM byte arrives in current turn
  const lastErrorTypeRef = useRef<'microphone' | 'audio' | 'network' | 'api' | 'rate_limit' | 'other' | null>(null); // Track error type for auto-retry
  const teardownInProgressRef = useRef<boolean>(false); // Guard to prevent retries during cleanup
  const selfInitiatedCloseRef = useRef<boolean>(false); // Set by turnSignalMissing/watchdog so onclose skips duplicate reconnect
  // Centralized mic mute control with reference counting for temporary mutes
  const tempMuteCountRef = useRef<number>(0); // Count of active temporary mutes (signal tone, etc.)
  const micPersistentMutedRef = useRef<boolean>(false); // User's intended mute state
  // Background-handling refs — tracks connected state across visibility changes and abort tokens
  const wasConnectedBeforeBackgroundRef = useRef<boolean>(false);
  const isReconnectingRef = useRef<boolean>(false);
  const isPausedForBackgroundRef = useRef<boolean>(false);
  const sessionAbortTokenRef = useRef<number>(0); // Incremented on pause to cancel in-flight startSession

  // ─── Audio context helper ─────────────────────────────────────────────────────
  // Wraps a suspend() or resume() call with a 3 s timeout so a hung browser API
  // call (which can occur on Android Chrome) doesn't block the calling function.
  const withCtxTimeout = (op: Promise<void>, label: string): Promise<void> =>
    Promise.race([
      op,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error(`AudioContext.${label} timed out after 3 s`)), 3_000)
      )
    ]);

  // ─── Prewarm helpers (defined here so they close over refs declared above) ───
  const prewarmAudio = useCallback(() => {
    if (audioPrewarmedRef.current) return;
    audioPrewarmedRef.current = true;
    const timing = logger.timing('audio', 'Prewarm AudioContext');
    try {
      // latencyHint: 0 requests the browser's absolute minimum buffer (Web Audio spec §4.1).
      // Numeric 0 is valid — browsers clamp to their hardware minimum (~3 ms on Chrome).
      prewarmedInputCtxRef.current  = new (window.AudioContext ?? window.webkitAudioContext!)({ latencyHint: 0 });
      prewarmedOutputCtxRef.current = new (window.AudioContext ?? window.webkitAudioContext!)({ latencyHint: 0 });
      prewarmedInputCtxRef.current.resume();
      prewarmedOutputCtxRef.current.resume();
      timing.end({ inputState: prewarmedInputCtxRef.current.state, outputState: prewarmedOutputCtxRef.current.state, inputRate: prewarmedInputCtxRef.current.sampleRate });
      logger.audio.info('Audio prewarmed successfully', { inputRate: prewarmedInputCtxRef.current.sampleRate });
    } catch (e) {
      logger.audio.warn('Prewarm failed', e);
    }
    // Prefetch the AI SDK so it is ready before the user presses the mic button.
    import('@google/genai').catch((e) => { logger.general.debug('SDK prefetch failed (non-critical)', e); });
  }, []);

  const resetPrewarmedAudio = useCallback(async () => {
    logger.audio.info('Resetting prewarmed audio state');
    const closePromises: Promise<void>[] = [];
    if (prewarmedInputCtxRef.current && prewarmedInputCtxRef.current.state !== 'closed') {
      closePromises.push(prewarmedInputCtxRef.current.close().catch(e => logger.audio.debug('Failed to close prewarmed input ctx', e)));
    }
    if (prewarmedOutputCtxRef.current && prewarmedOutputCtxRef.current.state !== 'closed') {
      closePromises.push(prewarmedOutputCtxRef.current.close().catch(e => logger.audio.debug('Failed to close prewarmed output ctx', e)));
    }
    if (closePromises.length > 0) {
      await Promise.all(closePromises);
      logger.audio.debug('Prewarmed AudioContexts closed');
    }
    audioPrewarmedRef.current     = false;
    prewarmedInputCtxRef.current  = null;
    prewarmedOutputCtxRef.current = null;
    logger.audio.info('Prewarmed audio state reset complete');
  }, []);

  // Close any prewarmed AudioContexts when the hook unmounts.
  // In normal production use App never unmounts, but React 18 StrictMode
  // double-mounts every component in development. Without this cleanup the
  // first mount's contexts are abandoned (not in any session ref, not closed)
  // and leak as long as the browser tab is open.
  useEffect(() => {
    return () => {
      resetPrewarmedAudio();
    };
  }, [resetPrewarmedAudio]);

  // ─────────────────────────────────────────────────────────────────────────────
  // § 2  RECONNECT SCHEDULING
  //      scheduleRetry() is the single entry-point for all retry sources.
  //      Only one timer may exist at a time; it polls conditions before retrying.
  // ─────────────────────────────────────────────────────────────────────────────

  // ── useReconnection: manages scheduleRetry, reconnectAttemptRef, reconnectTimeoutRef, shouldAutoReconnectRef
  const { reconnectAttemptRef, reconnectTimeoutRef, shouldAutoReconnectRef, scheduleRetry } = useReconnection({
    startSessionRef,
    pendingOperationRef,
    teardownInProgressRef,
  });

  // ── useAudioLevelMeter: RAF loop for 20-FPS VU updates; exposes raw refs for worklet to write
  const { inputPeakLevel, inputClipping, inputPeakLevelRef, inputClippingRef } = useAudioLevelMeter();

  const [isOnline, setIsOnline] = useState(navigator.onLine);
  
  // ─────────────────────────────────────────────────────────────────────────────
  // § 3  SYNCHRONISATION EFFECTS & AUDIO LEVEL METERING
  //      useEffect hooks that sync refs/config, plus the 20-fps RAF loop that
  //      reads worklet peak data and drives the VU meter UI.
  // ─────────────────────────────────────────────────────────────────────────────

  // inputPeakLevelRef / inputClippingRef live in useAudioLevelMeter (instantiated in §2 above)
  // Audio test mode: collects AUDIO_TEST_DURATION_SEC seconds of resampled audio for playback
  // (AUDIO_TEST_DURATION_SEC / AUDIO_TEST_BUFFER_SIZE defined at module level)
  const audioTestBufferRef = useRef<Float32Array | null>(null);
  const audioTestIndexRef = useRef<number>(0);
  const [audioTestReady, setAudioTestReady] = useState(false);
  const [isPlayingTestAudio, setIsPlayingTestAudio] = useState(false);

  useEffect(() => { 
      configRef.current = config; 
      if (outputGainNodeRef.current && outputAudioContextRef.current) {
          // GainNode at 0.95 (headroom for inter-sample peaks) or 0 for mute.
          // The 5% attenuation prevents resampling overshoot from hard-clipping at WaveShaperNode boundary.
          const targetGain = isOutputMuted ? 0 : 0.95;
          try {
             outputGainNodeRef.current.gain.setTargetAtTime(targetGain, outputAudioContextRef.current.currentTime, 0.1);
          } catch(e) { logger.audio.debug('Failed to set output gain', e); }
      }
      // Regenerate soft-clip curve when gain or drive changes — gain is embedded in the curve
      if (softClipNodeRef.current) {
          try {
             softClipNodeRef.current.curve = createSoftClipCurve(8192, config.softClipDrive, config.outputGain);
          } catch(e) { logger.audio.debug('Failed to update soft-clip curve', e); }
      }
  }, [config, isOutputMuted]);

  useEffect(() => { isOutputMutedRef.current = isOutputMuted; }, [isOutputMuted]);
  // Sync user's persistent mute state to refs
  // Only updates ref if no temporary mutes are active (tempMuteCountRef === 0)
  useEffect(() => { 
    micPersistentMutedRef.current = isInputMuted;
    if (tempMuteCountRef.current === 0) {
      isInputMutedRef.current = isInputMuted; 
    }
  }, [isInputMuted]);
  useEffect(() => { isConnectedRef.current = isConnected; }, [isConnected]);
  useEffect(() => { sessionStateRef.current = context.state; }, [context.state]);
  
  // Centralized mic mute control - all mute operations should go through these helpers
  
  // Set persistent mute state (user toggle) - updates state, ref, and persistent tracking
  const setMicMutedPersistent = useCallback((muted: boolean) => {
    micPersistentMutedRef.current = muted;
    setIsInputMuted(muted);
    // Only update ref if no temporary mutes active
    if (tempMuteCountRef.current === 0) {
      isInputMutedRef.current = muted;
    }
    logger.audio.debug('Persistent mute set', { muted, tempMuteCount: tempMuteCountRef.current });
  }, []);
  
  // Request temporary mute (signal tone, etc.) - increments counter and mutes
  const requestTempMute = useCallback((reason: string) => {
    tempMuteCountRef.current += 1;
    isInputMutedRef.current = true;
    logger.audio.debug('Temp mute requested', { reason, count: tempMuteCountRef.current });
  }, []);
  
  // Release temporary mute - decrements counter and restores persistent state when zero
  const releaseTempMute = useCallback((reason: string) => {
    tempMuteCountRef.current = Math.max(0, tempMuteCountRef.current - 1);
    logger.audio.debug('Temp mute released', { reason, count: tempMuteCountRef.current });
    // When all temp mutes released, restore to user's persistent state
    if (tempMuteCountRef.current === 0) {
      isInputMutedRef.current = micPersistentMutedRef.current;
      logger.audio.debug('Restored to persistent mute state', { muted: micPersistentMutedRef.current });
    }
  }, []);
  
  useEffect(() => { 
    logger.setEnabled(config.showDebugInfo);
  }, [config.showDebugInfo]);

  useEffect(() => {
    const timing = logger.timing('audio', 'Worklet URLs created');
    const recorderBlob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
    workletUrlRef.current = URL.createObjectURL(recorderBlob);
    const playerBlob = new Blob([PCM_PLAYER_WORKLET_CODE], { type: 'application/javascript' });
    pcmPlayerUrlRef.current = URL.createObjectURL(playerBlob);
    timing.end();
    
    const handleFirstInteraction = () => {
      prewarmAudio();
      document.removeEventListener('touchstart', handleFirstInteraction);
      document.removeEventListener('click', handleFirstInteraction);
    };
    document.addEventListener('touchstart', handleFirstInteraction, { once: true, passive: true });
    document.addEventListener('click', handleFirstInteraction, { once: true });
    
    return () => { 
      if (workletUrlRef.current) URL.revokeObjectURL(workletUrlRef.current);
      if (pcmPlayerUrlRef.current) URL.revokeObjectURL(pcmPlayerUrlRef.current);
      document.removeEventListener('touchstart', handleFirstInteraction);
      document.removeEventListener('click', handleFirstInteraction);
    };
  }, []);

  // Track online/offline status and auto-reconnect when internet comes back
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      logger.session.info('Internet connection restored');
      
      // Delay check to avoid race condition where WebSocket close event hasn't processed yet
      // The browser 'online' event can fire before WebSocket onclose, causing isConnectedRef
      // to still be true even though the connection is already dead
      setTimeout(() => {
        // Double-check activeSessionRef to see if WebSocket is really still alive
        const hasActiveSession = activeSessionRef.current !== null;
        const isSessionConnected = isConnectedRef.current && hasActiveSession;
        
        logger.session.debug('Online handler delayed check', {
          isConnectedRef: isConnectedRef.current,
          hasActiveSession,
          isSessionConnected,
          shouldAutoReconnect: shouldAutoReconnectRef.current,
          pending: pendingOperationRef.current,
          hidden: document.hidden
        });
        
        // Auto-reconnect if we were in an error state due to connection loss
        // and auto-reconnect is enabled
        if (shouldAutoReconnectRef.current && 
            !isSessionConnected && 
            !pendingOperationRef.current &&
            !document.hidden) {
          logger.session.info('Auto-reconnecting after internet restored');
          // Reset reconnect counter for fresh attempts
          reconnectAttemptRef.current = 0;
          // Use centralized scheduler - 300ms additional delay to let network stabilize
          scheduleRetry(300, 'online');
        }
      }, 200); // 200ms delay to let WebSocket close event process first
    };
    
    const handleOffline = () => {
      setIsOnline(false);
      logger.session.warn('Internet connection lost');
      
      // If we're connected, the WebSocket will eventually close and handle reconnect.
      // For now just log - don't immediately disconnect as connection might be brief
    };
    
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Listen for audio device changes (microphone connected/disconnected)
  // Auto-retry if last error was microphone-related
  // Uses the same reconnectTimeoutRef as other retry sources to ensure only one timer exists
  useEffect(() => {
    const handleDeviceChange = async () => {
      logger.audio.info('Audio device change detected');
      
      // Only auto-retry if:
      // - Last error was microphone or audio related
      // - Auto-reconnect is enabled (user didn't manually disconnect)
      // - Not already connected or in a pending operation
      // - App is in foreground
      if ((lastErrorTypeRef.current === 'microphone' || lastErrorTypeRef.current === 'audio') && 
          shouldAutoReconnectRef.current &&
          !isConnectedRef.current && 
          !pendingOperationRef.current &&
          !document.hidden) {
        
        // Check if a microphone is now available
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const hasMicrophone = devices.some(d => d.kind === 'audioinput' && d.deviceId !== '');
          
          if (hasMicrophone) {
            logger.session.info('Microphone available after device change, scheduling auto-retry');
            // Clear error type and reset reconnect counter
            lastErrorTypeRef.current = null;
            reconnectAttemptRef.current = 0;
            // Use centralized scheduler - 1000ms delay to let device stabilize
            scheduleRetry(1000, 'device-change');
          }
        } catch (e) {
          logger.audio.warn('Failed to enumerate devices', e);
        }
      }
    };
    
    if (navigator.mediaDevices?.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
      return () => {
        navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
      };
    }
  }, []);

  // RAF loop is now in useAudioLevelMeter (instantiated in §2 above)

  useEffect(() => {
    if (streamRef.current) {
        const track = streamRef.current.getAudioTracks()[0];
        if (track) {
            track.applyConstraints({
                noiseSuppression: config.noiseSuppression,
            }).catch(e => logger.audio.error("Constraint apply failed", e));
        }
    }
  }, [config.noiseSuppression]);

  // Helper: Play signal tone with microphone muted to prevent feedback
  // Uses centralized temp mute system for proper reference counting
  const playSignalToneWithMicMute = useCallback(async () => {
    if (!outputAudioContextRef.current || isOutputMutedRef.current) return;
    
    // Request temporary mute (will be restored after tone)
    requestTempMute('signal-tone');
    
    try {
      // Pass the session's GainNode so the tone is routed through the same
      // output graph as AI audio — the user's volume setting then applies
      // to the signal tone too, instead of it always playing at full volume.
      await playSignalTone(outputAudioContextRef.current, outputGainNodeRef.current);
    } catch (e) {
      logger.audio.warn('Signal tone failed', e);
    }
    
    // Release temporary mute - restores to user's persistent state
    releaseTempMute('signal-tone');
  }, [requestTempMute, releaseTempMute]);

  // ─────────────────────────────────────────────────────────────────────────────
  // § 4  SESSION LIFECYCLE HELPERS
  //      cleanupSession()  — tears down audio pipeline & WebSocket, resets refs.
  //      releaseMedia()    — releases the mic MediaStream.
  //      Both are called from startSession, stopSession, and visibility handling.
  // ─────────────────────────────────────────────────────────────────────────────

  // Simple cleanup with await-then-retry for overlapping callers
  const cleanupPromiseRef = useRef<Promise<void> | null>(null);
  
  const cleanupSession = useCallback(async (closeAudioContexts = true, preserveRetryTimer = false) => {
    // If cleanup is running, await it then run again with our options
    // Use promise as the single source of truth (set before any async work)
    if (cleanupPromiseRef.current) {
      logger.session.debug('Cleanup in progress, awaiting...');
      await cleanupPromiseRef.current;
      // Recurse to run cleanup with our options (will be fast, most refs are null)
      return cleanupSession(closeAudioContexts, preserveRetryTimer);
    }
    
    logger.session.info('Cleaning up session', { closeAudioContexts, preserveRetryTimer });
    
    // Create promise FIRST (atomic guard) before any other state changes
    const doCleanup = async () => {
      teardownInProgressRef.current = true;
      try {
        // Clear all timers
        if (sessionTimeoutRef.current) clearTimeout(sessionTimeoutRef.current);
        if (connectionHealthIntervalRef.current) { clearInterval(connectionHealthIntervalRef.current); connectionHealthIntervalRef.current = null; }
        if (backgroundTimeoutRef.current) clearTimeout(backgroundTimeoutRef.current);
        if (speakingWatchdogRef.current) { clearTimeout(speakingWatchdogRef.current); speakingWatchdogRef.current = null; }
        if (sessionValidationTimeoutRef.current) {
          clearTimeout(sessionValidationTimeoutRef.current);
          sessionValidationTimeoutRef.current = null;
        }
        if (!preserveRetryTimer && reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
        
        // Reset state
        sessionValidatedRef.current = false;
        isStartingRef.current = false;
        wasStreamingAudioRef.current = false;
        backgroundTimeoutRef.current = null;
        backgroundStartRef.current = null;
        inputPeakLevelRef.current = 0;  // useAudioLevelMeter's RAF loop will sync state on next frame
        inputClippingRef.current = false;
        tempMuteCountRef.current = 0; // Reset temporary mute counter
        isInputMutedRef.current = micPersistentMutedRef.current; // Restore to persistent state
        
        // Close session and audio nodes
        if (activeSessionRef.current) {
          try { activeSessionRef.current.close(); } catch(e) { logger.transport.debug('Failed to close session', e); }
          activeSessionRef.current = null;
        }
        if (workletNodeRef.current) {
          try {
            // Terminate BEFORE nulling onmessage: the message goes TO the worklet thread,
            // so the direction is independent of our inbound listener. Terminating makes
            // process() return false, allowing the Web Audio engine to GC the processor.
            // Without this, process() always returns true and the processor runs forever
            // even after disconnect — causing a worklet leak and eventual browser crash.
            workletNodeRef.current.port.postMessage({ type: 'terminate' });
            workletNodeRef.current.port.onmessage = null;
            workletNodeRef.current.disconnect();
          } catch(e) { logger.audio.debug('Failed to disconnect worklet', e); }
          workletNodeRef.current = null;
        }
        if (sourceNodeRef.current) {
          try { sourceNodeRef.current.disconnect(); } catch(e) { logger.audio.debug('Failed to disconnect source node', e); }
          sourceNodeRef.current = null;
        }
        if (pcmPlayerNodeRef.current) {
          try {
            // Send terminate FIRST so the processor returns false from process() and can be GC'd.
            // Then send clear to flush the buffer (in case the worklet is still mid-playback).
            pcmPlayerNodeRef.current.port.postMessage({ type: 'terminate' });
            pcmPlayerNodeRef.current.port.postMessage({ type: 'clear' });
            pcmPlayerNodeRef.current.port.onmessage = null;
            pcmPlayerNodeRef.current.disconnect();
          } catch(e) { logger.audio.debug('Failed to disconnect PCM player', e); }
          pcmPlayerNodeRef.current = null;
        }
        
        // Close AudioContexts if requested
        if (closeAudioContexts) {
          if (inputAudioContextRef.current?.state !== 'closed') {
            try { await inputAudioContextRef.current?.close(); } catch(e) { logger.audio.debug('Failed to close input AudioContext', e); }
          }
          if (outputAudioContextRef.current?.state !== 'closed') {
            try { await outputAudioContextRef.current?.close(); } catch(e) { logger.audio.debug('Failed to close output AudioContext', e); }
          }
          // Closed contexts are no longer valid — remove from the worklet registry so
          // addModule is called again if fresh contexts are created for the next session.
          if (inputAudioContextRef.current) workletRegisteredCtxRef.current.delete(inputAudioContextRef.current);
          if (outputAudioContextRef.current) workletRegisteredCtxRef.current.delete(outputAudioContextRef.current);
          inputAudioContextRef.current = null;
          outputAudioContextRef.current = null;
          if (!shouldAutoReconnectRef.current) {
            reconnectAttemptRef.current = 0;
          }
        }
        
        // Clear remaining refs
        if (inputAnalyserRef.current) {
          try { inputAnalyserRef.current.disconnect(); } catch(e) { logger.audio.debug('Failed to disconnect input analyser', e); }
          inputAnalyserRef.current = null;
        }
        if (outputAnalyserRef.current) {
          try { outputAnalyserRef.current.disconnect(); } catch(e) { logger.audio.debug('Failed to disconnect output analyser', e); }
          outputAnalyserRef.current = null;
        }
        if (outputGainNodeRef.current) {
          try { outputGainNodeRef.current.disconnect(); } catch(e) { logger.audio.debug('Failed to disconnect gain node', e); }
        }
        outputGainNodeRef.current = null;
        if (softClipNodeRef.current) {
          try { softClipNodeRef.current.disconnect(); } catch(e) { logger.audio.debug('Failed to disconnect soft-clip node', e); }
        }
        softClipNodeRef.current = null;
        isPlayingAudioRef.current = false;
        shouldClearOnNextRef.current = true;
        turnStateRef.current.turnCompleted = false;
        turnStateRef.current.audioEndedAfterTurn = false;
        turnStateRef.current.speakingTurnEnded = false;
        hadInputRef.current = false;
        inputSilenceElapsedRef.current = false;
        logger.audio.info('Turn state RESET by cleanupSession — all flags cleared');
        if (turnResetTimerRef.current) {
          clearTimeout(turnResetTimerRef.current);
          turnResetTimerRef.current = null;
        }
        lastAudioSendTimeRef.current = 0;
        awaitingFirstResponseRef.current = false;
        lastPcmChunkTimeRef.current = 0;
        turnSpeakingStartRef.current = 0;
        turnHadRealAudioRef.current = false;
        
        // ALWAYS release microphone (check track state to prevent errors)
        if (streamRef.current) {
          logger.audio.info('Releasing microphone');
          streamRef.current.getTracks().forEach(track => {
            if (track.readyState !== 'ended') {
              track.stop();
            }
          });
          streamRef.current = null;
        }
        
        logger.session.info('Cleanup complete');
      } finally {
        teardownInProgressRef.current = false;
        cleanupPromiseRef.current = null;
      }
    };
    
    cleanupPromiseRef.current = doCleanup();
    await cleanupPromiseRef.current;
  }, []);

  const releaseMedia = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
  }, []);

  // ─────────────────────────────────────────────────────────────────────────────
  // § 5  startSession  (≈ 1 100 lines)
  //      The main session loop.  Sequence:
  //        1. Guard checks (background, already connected, rate-limit)
  //        2. Lazy-load @google/genai SDK
  //        3. Open mic + AudioWorklet input pipeline
  //        4. Open AudioContext + PCM player output pipeline
  //        5. Open Gemini Live WebSocket and register message handlers
  //        6. Stream mic PCM → send()  |  receive audio chunks → player
  //        7. On close/error → exponential backoff reconnect via scheduleRetry()
  // ─────────────────────────────────────────────────────────────────────────────

  const startSession = useCallback(async () => {
    // Check if app is in background - don't start sessions while hidden
    if (document.hidden || isPausedForBackgroundRef.current) {
      logger.session.debug('Start blocked - app is in background');
      return;
    }
    
    if (!canStart || pendingOperationRef.current) {
      logger.session.debug('Start blocked', { canStart, pending: pendingOperationRef.current });
      return;
    }
    
    // Mark pending IMMEDIATELY after guard to prevent race conditions
    // This must happen synchronously before any async operations
    pendingOperationRef.current = true;
    
    // ─── Diagnose: snapshot of turn state at session start ─────────────────────
    // All flags should be false here (reset by cleanupSession or initial values).
    // If speakingTurnEnded=true here, it survived from the previous session and
    // will cause the FIRST audio chunk of the new session to be silently dropped.
    logger.session.info('startSession() — turn state snapshot at entry', {
      turnCompleted: turnStateRef.current.turnCompleted,
      speakingTurnEnded: turnStateRef.current.speakingTurnEnded,
      audioEndedAfterTurn: turnStateRef.current.audioEndedAfterTurn,
      hadInput: hadInputRef.current,
      isPlaying: isPlayingAudioRef.current,
    });
    // ────────────────────────────────────────────────────────────────────────────
    
    // Capture abort token at start - if it changes during async ops, we abort
    const startAbortToken = sessionAbortTokenRef.current;
    const checkAbort = () => sessionAbortTokenRef.current !== startAbortToken || document.hidden;
    
    // Enable auto-reconnect for this session
    shouldAutoReconnectRef.current = true;
    // Reset session validation state and mark as starting
    sessionValidatedRef.current = false;
    isStartingRef.current = true;
    if (sessionValidationTimeoutRef.current) {
      clearTimeout(sessionValidationTimeoutRef.current);
      sessionValidationTimeoutRef.current = null;
    }
    
    // If any prewarmed AudioContext exists but is NOT 'running' (e.g. created outside
    // the button's user-gesture by handleFirstInteraction and auto-suspended by iOS),
    // discard it before calling prewarmAudio() so fresh contexts are created inside
    // THIS gesture call stack — which iOS requires to start in 'running' state.
    //
    // We only reset when there's actually a non-running context present.
    // On reconnects both prewarmed refs are null (consumed on first start and never
    // recreated by cleanupSession), so the condition is false, prewarmAudio() returns
    // early (audioPrewarmedRef is still true), and no contexts are leaked.
    const prewarmedBad =
      (prewarmedInputCtxRef.current !== null && prewarmedInputCtxRef.current.state !== 'running') ||
      (prewarmedOutputCtxRef.current !== null && prewarmedOutputCtxRef.current.state !== 'running');
    if (prewarmedBad) {
      await resetPrewarmedAudio();
    }
    prewarmAudio();
    
    logger.session.info('Starting session', { 
      source: sourceLangRef.current.code, 
      target: targetLangRef.current.code,
      reconnectAttempt: reconnectAttemptRef.current
    });
    
    logger.logSystemInfo();
    logger.logConnectionQuality({});
    logger.logMemory();
    
    // For 'random' mode, re-roll personality on each new session start
    // We need to compute this synchronously so the new prompt is used immediately
    let currentPersonality = sessionPersonality;
    if (configRef.current.funnyMode === 'random') {
      currentPersonality = getRandomPersonality();
      setSessionPersonality(currentPersonality);
      // Rebuild system instruction with the new personality
      systemInstructionRef.current = buildSystemInstruction(
        sourceLangRef.current,
        targetLangRef.current,
        customPrompt.trim() || undefined,
        currentPersonality
      );
      logger.session.info('Random personality selected', { personality: currentPersonality });
    }
    
    // Note: systemInstructionRef.current is already set by the useEffect that syncs it
    // with the computed systemInstruction (which uses customPrompt || DEFAULT_PROMPT_TEMPLATE)
    // For non-random modes, we keep the existing value
    logger.session.debug('Using system instruction', { 
      instruction: systemInstructionRef.current ? systemInstructionRef.current.substring(0, 100) + '...' : '(none)',
      isCustom: customPrompt ? !!customPrompt.trim() : false,
      personality: currentPersonality
    });
    const timing = logger.timing('session', 'Session start');
    
    // pendingOperationRef already set at the top of this function
    send({ type: 'START_REQUESTED' });
    // Sync sessionStateRef immediately — useEffect fires only after re-render, but
    // onclose/onerror callbacks fire from the network layer (macrotask queue) and may
    // read sessionStateRef before the useEffect has had a chance to run.
    // stopSession and hardReset already do this synchronously for their transitions.
    sessionStateRef.current = SessionState.CONNECTING;

    try {
      if (sessionTimeoutRef.current) clearTimeout(sessionTimeoutRef.current);
      sessionTimeoutRef.current = setTimeout(() => {
        cleanupSession();
        releaseMedia();
        send({ type: 'TIMEOUT' });
        // Do NOT use alert() here — it blocks the main thread (including the audio render thread)
        // and causes audio glitches. The TIMEOUT event already transitions the UI to an error state.
        logger.session.warn('Session timeout reached (30 min)');
      }, MAX_SESSION_DURATION);

      logger.mark('audio_context_start');
      let inputCtx: AudioContext;
      let outputCtx: AudioContext;
      
      // iOS fix: Check if existing contexts are still usable (not closed)
      // On iOS, AudioContext can become 'closed' after interruptions (phone call, other app audio)
      const existingInputUsable = inputAudioContextRef.current && inputAudioContextRef.current.state !== 'closed';
      const existingOutputUsable = outputAudioContextRef.current && outputAudioContextRef.current.state !== 'closed';
      
      if (existingInputUsable && existingOutputUsable) {
        // Reuse existing contexts (common during reconnect)
        inputCtx = inputAudioContextRef.current!;
        outputCtx = outputAudioContextRef.current!;
        logger.audio.info('Reusing existing AudioContexts', { 
          inputState: inputCtx.state, 
          outputState: outputCtx.state 
        });
      } else if (prewarmedInputCtxRef.current && prewarmedInputCtxRef.current.state !== 'closed' && prewarmedOutputCtxRef.current && prewarmedOutputCtxRef.current.state !== 'closed') {
        inputCtx = prewarmedInputCtxRef.current;
        outputCtx = prewarmedOutputCtxRef.current;
        prewarmedInputCtxRef.current  = null;
        prewarmedOutputCtxRef.current = null;
        logger.audio.info('Using prewarmed AudioContexts');
      } else {
        // Create fresh contexts (iOS: always create new after 'closed' state)
        // Use native device sample rate for "fast track" audio path
        // latencyHint: 0 — browser-minimum buffer, valid per Web Audio spec §4.1
        logger.audio.info('Creating new AudioContexts', {
          oldInputState: inputAudioContextRef.current?.state,
          oldOutputState: outputAudioContextRef.current?.state
        });
        inputCtx = new (window.AudioContext ?? window.webkitAudioContext!)({ latencyHint: 0 });
        outputCtx = new (window.AudioContext ?? window.webkitAudioContext!)({ latencyHint: 0 });
      }
      
      // iOS fix: Force resume suspended contexts with multiple retry attempts
      for (let attempt = 1; attempt <= MAX_AUDIO_RESUME_ATTEMPTS; attempt++) {
        // Try to resume both contexts (3 s timeout each to prevent hang on Android Chrome)
        if (inputCtx.state === 'suspended') {
          await withCtxTimeout(inputCtx.resume(), 'resume').catch(e => logger.audio.warn(`Input resume attempt ${attempt} failed`, e));
        }
        if (outputCtx.state === 'suspended') {
          await withCtxTimeout(outputCtx.resume(), 'resume').catch(e => logger.audio.warn(`Output resume attempt ${attempt} failed`, e));
        }
        
        // Check if both are now running
        if (inputCtx.state === 'running' && outputCtx.state === 'running') {
          logger.audio.info(`AudioContexts running after attempt ${attempt}`);
          break;
        }
        
        // If not the last attempt, wait and retry
        if (attempt < MAX_AUDIO_RESUME_ATTEMPTS) {
          logger.audio.warn(`AudioContext not running after attempt ${attempt}, retrying...`, {
            inputState: inputCtx.state,
            outputState: outputCtx.state
          });
          await new Promise(resolve => setTimeout(resolve, AUDIO_RESUME_DELAY_MS));
        }
      }
      
      // Final check - if still not running after all attempts, throw error
      if (inputCtx.state !== 'running' || outputCtx.state !== 'running') {
        logger.audio.error('AudioContext failed to start after all attempts', {
          inputState: inputCtx.state,
          outputState: outputCtx.state,
          attempts: MAX_AUDIO_RESUME_ATTEMPTS
        });
        
        // Clean up any partially created resources
        try {
          if (inputCtx.state !== 'closed') inputCtx.close().catch(e => logger.audio.debug('Failed to close input ctx', e));
          if (outputCtx.state !== 'closed') outputCtx.close().catch(e => logger.audio.debug('Failed to close output ctx', e));
        } catch (e) { logger.audio.debug('Error during AudioContext cleanup', e); }
        
        const failedContext = inputCtx.state !== 'running' ? 'Microphone audio' : 'Playback audio';
        throw new Error(`${failedContext} could not be started. Please tap the screen again and try once more.`);
      }
      
      logger.mark('audio_context_ready');

      inputAudioContextRef.current = inputCtx;
      outputAudioContextRef.current = outputCtx;

      // iOS robustness: immediately react to AudioContext interruptions (phone call,
      // AirPlay transfer, audio route change). The statechange event fires synchronously
      // when iOS suspends the context, giving us a chance to resume before audio gaps
      // become audible. Guard: only auto-resume when NOT in a deliberate background pause
      // (isPausedForBackgroundRef is set synchronously before the intentional suspend).
      // Listeners are automatically removed when the context is closed — no cleanup needed.
      const tryResumeCtx = (ctx: AudioContext | null, label: string) => {
        if (!ctx || ctx.state !== 'suspended' || isPausedForBackgroundRef.current) return;
        logger.audio.warn(`${label} AudioContext suspended unexpectedly — attempting immediate resume`);
        ctx.resume().catch(e => logger.audio.debug(`${label} statechange resume failed`, e));
      };
      inputCtx.addEventListener('statechange', () => tryResumeCtx(inputAudioContextRef.current, 'Input'));
      outputCtx.addEventListener('statechange', () => tryResumeCtx(outputAudioContextRef.current, 'Output'));

      setActualInRate(inputCtx.sampleRate);
      setActualOutRate(outputCtx.sampleRate);
      setInputBaseLatency(inputCtx.baseLatency || 0);
      setOutputBaseLatency(outputCtx.baseLatency || 0);
      
      logger.audio.info('Audio contexts ready', {
        inputRate: inputCtx.sampleRate,
        outputRate: outputCtx.sampleRate,
        baseLatency: inputCtx.baseLatency,
        outputLatency: outputCtx.baseLatency,
        prewarmed: !prewarmedInputCtxRef.current
      });
      
      logger.logAudioContext(inputCtx, 'input');
      logger.logAudioContext(outputCtx, 'output');

      // Add to session metadata for log exports
      logger.setMetadata('audio_settings', {
        inputRate: inputCtx.sampleRate,
        outputRate: outputCtx.sampleRate,
        inputBaseLatency: inputCtx.baseLatency,
        outputBaseLatency: outputCtx.baseLatency
      });

      // Resampling now happens in the recorder worklet (48kHz → 16kHz)
      logger.audio.info('Resampling configured in worklet', {
        from: inputCtx.sampleRate,
        to: INPUT_SAMPLE_RATE,
        taps: 16,
        phases: 32
      });

      // Defensive: disconnect any nodes left over from a previous session that wasn't
      // fully cleaned up (e.g. a code path that didn't null the refs). Without this,
      // the old nodes stay connected to the AudioContext destination and accumulate.
      if (outputGainNodeRef.current) {
        try { outputGainNodeRef.current.disconnect(); } catch(e) { logger.audio.debug('Failed to disconnect stale gain node', e); }
        outputGainNodeRef.current = null;
      }
      if (softClipNodeRef.current) {
        try { softClipNodeRef.current.disconnect(); } catch(e) { logger.audio.debug('Failed to disconnect stale soft-clip node', e); }
        softClipNodeRef.current = null;
      }
      if (inputAnalyserRef.current) {
        try { inputAnalyserRef.current.disconnect(); } catch(e) { logger.audio.debug('Failed to disconnect stale input analyser', e); }
        inputAnalyserRef.current = null;
      }
      if (outputAnalyserRef.current) {
        try { outputAnalyserRef.current.disconnect(); } catch(e) { logger.audio.debug('Failed to disconnect stale output analyser', e); }
        outputAnalyserRef.current = null;
      }

      const outputGain = outputCtx.createGain();
      // GainNode is set to 0.95 (≈ −0.5 dB headroom) rather than unity.
      // At peakAmplitude=1.0, resampling sinc interpolation can create inter-sample
      // peaks that slightly exceed ±1.0. Without headroom the WaveShaperNode clamps
      // those peaks at the lookup-table boundary → hard-clip transient → crackle.
      // 0.95 absorbs the overshoot while keeping perceptible loudness unchanged.
      outputGain.gain.value = isOutputMutedRef.current ? 0 : 0.95;
      
      // Create soft-clipping WaveShaperNode — gain is baked into the curve.
      // Chain: PCM Player → GainNode (0.95 headroom / mute) → WaveShaperNode (tanh soft clip) → destination
      const softClipper = outputCtx.createWaveShaper();
      softClipper.curve = createSoftClipCurve(8192, configRef.current.softClipDrive, configRef.current.outputGain);
      softClipper.oversample = '4x'; // '4x' gives better anti-aliasing for non-linear processing
      
      outputGain.connect(softClipper);
      softClipper.connect(outputCtx.destination);
      outputGainNodeRef.current = outputGain;
      softClipNodeRef.current = softClipper;

      const inputAnalyser = inputCtx.createAnalyser();
      inputAnalyser.fftSize = 32; inputAnalyser.smoothingTimeConstant = 0.2;
      inputAnalyserRef.current = inputAnalyser;
      
      const outputAnalyser = outputCtx.createAnalyser();
      outputAnalyser.fftSize = 32; outputAnalyser.smoothingTimeConstant = 0.2;
      outputAnalyserRef.current = outputAnalyser;

      // Check internet connection
      if (!navigator.onLine) {
        throw new Error('No internet connection. Please check your network.');
      }

      const apiKey = configRef.current.userApiKey;
      if (!apiKey) {
        throw new Error('Please enter your Google AI API key in settings');
      }
      // SECURITY NOTE: The @google/genai SDK embeds the API key as a URL query
      // parameter in the WebSocket connection URL:
      //   wss://generativelanguage.googleapis.com/...?key=AIzaSy...
      // The URL is encrypted on the wire (WSS/TLS), so passive network observers
      // cannot read it. However it IS visible in browser DevTools → Network tab.
      // This is a known limitation of API-key-based auth with Google's Live API.
      // Google offers ephemeral token support (v1alpha) as a future mitigation,
      // which would require a server-side token endpoint.
      // Race the SDK import against a 15 s timeout — the dynamic import can hang
      // indefinitely on Android Chrome if the browser's module cache is in a bad state.
      const sdkImportTimeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(Object.assign(
          new Error('SDK load timed out — check your network connection.'),
          { name: 'NetworkError' }
        )), 15_000)
      );
      const { GoogleGenAI, Modality, StartSensitivity, EndSensitivity, ActivityHandling, ThinkingLevel } =
        await Promise.race([import('@google/genai'), sdkImportTimeout]);
      const ai = new GoogleGenAI({
        apiKey,
      });

      logger.mark('parallel_setup_start');
      
      const getStreamPromise = (async () => {
        let stream = streamRef.current;
        if (!stream || !stream.active) {
          logger.mark('getUserMedia_start');
          try {
            const getUserMediaCall = navigator.mediaDevices.getUserMedia({ 
              audio: { 
                  echoCancellation: false,
                  noiseSuppression: configRef.current.noiseSuppression,
                  autoGainControl: configRef.current.autoGainControl,
                  channelCount: 1
              } 
            });
            const timeoutMs = micPermissionTimeoutMsRef.current;
            // Always race against a timeout to avoid hanging if the browser never resolves
            // getUserMedia (can happen on Android Chrome after rapid mic acquire/release cycles).
            // PWA auto-start uses a short custom timeout; normal mode uses a 10 s safety net.
            const effectiveTimeout = timeoutMs ?? 10_000;
            const timeoutError = timeoutMs !== null
              ? Object.assign(new Error('MicPermissionTimeout'), { name: 'MicPermissionTimeout' })
              : Object.assign(new Error('Microphone request timed out. Please try again.'), { name: 'AbortError' });
            const timeoutCall = new Promise<never>((_, reject) =>
              setTimeout(() => reject(timeoutError), effectiveTimeout)
            );
            stream = await Promise.race([getUserMediaCall, timeoutCall]);
          } catch (micErr: unknown) {
            const errName = micErr instanceof Error ? micErr.name : '';
            const errMsg  = micErr instanceof Error ? micErr.message : String(micErr);
            if (errName === 'MicPermissionTimeout') {
              // Re-throw unchanged — outer catch handles this silently (PWA auto-start gave up)
              throw micErr;
            } else if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError') {
              throw new Error('Microphone access denied. Please allow access in your browser settings.');
            } else if (errName === 'NotFoundError') {
              throw new Error('No microphone found. Please connect a microphone.');
            } else if (errName === 'NotReadableError' || errName === 'TrackStartError') {
              throw new Error('Microphone is already in use. Please close other apps using the microphone.');
            } else if (errName === 'AbortError') {
              throw new Error('Microphone access was aborted. Please try again.');
            } else if (errName === 'OverconstrainedError') {
              throw new Error('Microphone does not support the requested settings. Please try again.');
            } else {
              throw new Error('Microphone error: ' + errMsg);
            }
          }
          
          // Verify the stream has active audio tracks
          const audioTracks = stream.getAudioTracks();
          if (audioTracks.length === 0) {
            throw new Error('No active microphone found. Please connect a microphone and try again.');
          }
          
          const track = audioTracks[0];
          if (track.readyState !== 'live' || !track.enabled) {
            logger.audio.warn('Audio track not ready', { 
              readyState: track.readyState, 
              enabled: track.enabled,
              muted: track.muted 
            });
            throw new Error('Microphone is not ready. Please check the microphone connection and try again.');
          }
          
          streamRef.current = stream;

          // Robustness: listen for unexpected track termination.
          // This covers: hardware disconnect (USB/3.5mm unplug), Bluetooth headset
          // loss, browser permission revocation mid-session, and some platform
          // audio focus losses (iOS does this for Siri/calls on some firmware).
          //
          // Guard: cleanupSession() sets streamRef.current = null synchronously
          // BEFORE calling track.stop(), which fires 'ended' asynchronously as a
          // task. By the time our handler runs, streamRef is already null, so we
          // skip the false-positive. ✓
          track.addEventListener('ended', () => {
            if (!streamRef.current) return; // Intentional cleanup already running
            logger.audio.error('Microphone track ended unexpectedly', {
              label: track.label,
              readyState: track.readyState,
            });
            send({ type: 'NETWORK_ERROR', error: 'Microphone disconnected. Please reconnect your microphone and try again.' });
            void cleanupSession();
          });

          // Informational only — log mute/unmute transitions (iOS: notification audio,
          // incoming call audio steal). We do NOT stop the session here: the track may
          // unmute shortly and resuming the session automatically is safer than dropping
          // the WebSocket connection.
          track.addEventListener('mute', () => {
            logger.audio.warn('Microphone track muted by system', { label: track.label });
          });
          track.addEventListener('unmute', () => {
            logger.audio.info('Microphone track unmuted by system', { label: track.label });
          });

          logger.mark('getUserMedia_done');
          logger.audio.info('Microphone stream acquired', {
            trackLabel: track.label,
            readyState: track.readyState,
            enabled: track.enabled
          });
        }
        return stream;
      })();

      if (!inputCtx.audioWorklet || !outputCtx.audioWorklet) {
        throw new Error('Your browser does not support AudioWorklet. Please update to Safari 14.5+, Chrome 67+, or Firefox 76+.');
      }

      // Helper: call addModule only if the module hasn't been registered on this AudioContext yet.
      // On Android Chrome, calling addModule a second time on the SAME context (which happens on
      // reconnect when closeAudioContexts=false) can return a promise that never resolves, causing
      // the entire startSession to hang with pendingOperationRef stuck at true — which freezes the UI.
      // A 6-second timeout is added as a safety net in case the browser stalls for any other reason.
      const safeAddModule = (ctx: AudioContext, url: string): Promise<void> => {
        if (workletRegisteredCtxRef.current.has(ctx)) {
          logger.audio.debug('Skipping addModule — already registered on this AudioContext');
          return Promise.resolve();
        }
        const addModuleCall = ctx.audioWorklet.addModule(url).then(() => {
          workletRegisteredCtxRef.current.add(ctx);
        });
        const timeoutCall = new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('addModule timed out after 6s')), 6000)
        );
        return Promise.race([addModuleCall, timeoutCall]);
      };

      const loadWorkletsPromise = Promise.all([
        workletUrlRef.current ? safeAddModule(inputCtx, workletUrlRef.current) : Promise.resolve(),
        pcmPlayerUrlRef.current ? safeAddModule(outputCtx, pcmPlayerUrlRef.current) : Promise.resolve()
      ]);

      const connectSessionPromise = ai.live.connect({
        model: configRef.current.modelName,
        config: {
          responseModalities: [Modality.AUDIO],
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.MINIMAL,
          },
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: configRef.current.voiceName } } },
          systemInstruction: systemInstructionRef.current,
          inputAudioTranscription: {}, 
          outputAudioTranscription: {},
          // Always send a finite number in [0, 2] — parseFloat in the settings UI
          // accepts "0,3"/"0.3" but could theoretically produce NaN on edge paths.
          temperature: (() => {
            const raw = configRef.current.funnyMode !== 'off'
              ? GEMINI_DEFAULTS.FUNNY_MODE_TEMPERATURE
              : configRef.current.temperature;
            const t = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0.3;
            return Math.min(2, Math.max(0, t));
          })(),
          topP: GEMINI_DEFAULTS.TOP_P,
          topK: GEMINI_DEFAULTS.TOP_K,
          // triggerTokens=0 means compression is disabled — don't send the field.
          // triggerTokens>=1: targetTokens = max(1, floor(trigger/2)) — prevents
          // sending targetTokens:"0" which is rejected by the API and closes the WebSocket.
          ...(configRef.current.triggerTokens > 0 && {
            contextWindowCompression: {
              triggerTokens: String(configRef.current.triggerTokens),
              slidingWindow: {
                targetTokens: String(Math.max(1, Math.floor(configRef.current.triggerTokens / 2))),
              },
            },
          }),
          realtimeInputConfig: (() => {
            const vadConfig = {
              disabled: false,
              startOfSpeechSensitivity: configRef.current.vadStartSensitivity === 'high'
                ? StartSensitivity.START_SENSITIVITY_HIGH
                : StartSensitivity.START_SENSITIVITY_LOW,
              endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
              prefixPaddingMs: configRef.current.vadPrefixPaddingMs,
              silenceDurationMs: configRef.current.vadSilenceDurationMs,
            };
            logger.session.info('VAD config being sent to API', {
              startSensitivity: configRef.current.vadStartSensitivity,
              prefixPaddingMs: vadConfig.prefixPaddingMs,
              silenceDurationMs: vadConfig.silenceDurationMs,
              endSensitivity: 'high (fixed)',
            });
            return {
              automaticActivityDetection: vadConfig,
              activityHandling: ActivityHandling.NO_INTERRUPTION,
            };
          })(),
        },
        callbacks: {
            onopen: () => { 
                logger.mark('websocket_connected');
                logger.transport.info('WebSocket connected, waiting for model validation...');
                timing.end();
                lastMessageTimeRef.current = Date.now();
                
                // Reset reconnect counter on successful connection
                reconnectAttemptRef.current = 0;
                shouldAutoReconnectRef.current = true;
                
                // Start connection health monitoring (log only every 30s to reduce spam)
                let lastStaleLogTime = 0;
                // Tracks cumulative ms the output AudioContext has been suspended while playback
                // is active. Resets when the context resumes or playback ends naturally.
                let outputSuspendedWhilePlayingMs = 0;
                connectionHealthIntervalRef.current = setInterval(() => {
                  if (!isConnectedRef.current) return;
                  const now = Date.now();
                  const timeSinceLastMessage = now - lastMessageTimeRef.current;
                  if (timeSinceLastMessage > CONNECTION_HEALTH_TIMEOUT) {
                    // Only log every 30 seconds to avoid log spam during silence
                    if (now - lastStaleLogTime >= 30000) {
                      logger.transport.warn('Connection appears stale', { timeSinceLastMessage });
                      lastStaleLogTime = now;
                    }
                  } else {
                    // Reset log timer when connection is active
                    lastStaleLogTime = 0;
                  }
                  
                  // Android/iOS: AudioContext can be suspended by OS mid-play (phone call,
                  // notification, Bluetooth handoff, power management). When suspended,
                  // currentTime stops — the player worklet's 4s grace-period timer freezes
                  // and never fires turnSignalMissing. Detect it here and recover fast.
                  if (isPlayingAudioRef.current && !isPausedForBackgroundRef.current) {
                    const outState = outputAudioContextRef.current?.state;
                    if (outState === 'suspended') { // 'interrupted' (iOS) also maps to 'suspended' in the TS types
                      outputSuspendedWhilePlayingMs += 2000;
                      logger.audio.warn('Output AudioContext suspended mid-play', { 
                        durationMs: outputSuspendedWhilePlayingMs, outState 
                      });
                      // Try to resume — if the OS allows it, audio will continue normally
                      outputAudioContextRef.current?.resume().catch(e => 
                        logger.audio.debug('Health-interval output resume failed', e)
                      );
                      if (outputSuspendedWhilePlayingMs >= 5000) {
                        // 5 s with no recovery: treat as audio ended so the session can
                        // advance to LISTENING and the user can speak again.
                        outputSuspendedWhilePlayingMs = 0;
                        logger.audio.warn('Output AudioContext suspended 5s during playback — forcing audio-ended recovery');
                        isPlayingAudioRef.current = false;
                        if (speakingWatchdogRef.current) {
                          clearTimeout(speakingWatchdogRef.current);
                          speakingWatchdogRef.current = null;
                        }
                        send({ type: 'MODEL_AUDIO_ENDED' });
                        send({ type: 'CONNECTION_QUALITY_RECOVERED' });
                      }
                    } else {
                      // Context is running — reset suspension counter
                      outputSuspendedWhilePlayingMs = 0;
                    }
                  } else {
                    outputSuspendedWhilePlayingMs = 0;
                  }

                  // "AI never started responding" guard: if the user stopped speaking
                  // (wasStreamingAudio=false, lastAudioSendTime>0) but the AI has not
                  // sent any audio back within 15 s, the session is stuck in LISTENING.
                  // The WebSocket may still be alive (heartbeats), so the existing
                  // connection-stale log is not enough — we need an active reconnect.
                  const NO_RESPONSE_TIMEOUT_MS = 15_000;
                  if (
                    !wasStreamingAudioRef.current &&
                    !isPlayingAudioRef.current &&
                    lastAudioSendTimeRef.current > 0 &&
                    now - lastAudioSendTimeRef.current > NO_RESPONSE_TIMEOUT_MS
                  ) {
                    logger.transport.warn('AI never started responding — stuck in LISTENING for 15s, forcing reconnect', {
                      timeSinceLastSend: now - lastAudioSendTimeRef.current,
                    });
                    lastAudioSendTimeRef.current = 0; // Prevent re-entry
                    const attempt = reconnectAttemptRef.current;
                    if (attempt < MAX_RECONNECT_ATTEMPTS) {
                      reconnectAttemptRef.current++;
                      const delay = RECONNECT_DELAY_BASE * Math.pow(2, attempt);
                      send({ type: 'NETWORK_ERROR', error: `Reconnecting… (${reconnectAttemptRef.current}/${MAX_RECONNECT_ATTEMPTS})` });
                      scheduleRetry(delay, 'no-response-watchdog');
                      selfInitiatedCloseRef.current = true;
                      cleanupSession(false, true);
                    } else {
                      send({ type: 'NETWORK_ERROR', error: 'No response. Please restart.' });
                      shouldAutoReconnectRef.current = false;
                    }
                  }

                  // "Model stuck generating silence" guard: at very low temperatures the model
                  // can emit only null PCM bytes (e.g. data:"AAA=") instead of real speech.
                  // Chunks keep arriving so the SPEAKING watchdog never fires — but the user
                  // hears nothing. Detect this by checking that 3+ real-time seconds have
                  // elapsed in SPEAKING state without a single non-zero audio byte.
                  const SILENCE_HANG_MS = 3_000;
                  if (
                    isPlayingAudioRef.current &&
                    !turnHadRealAudioRef.current &&
                    turnSpeakingStartRef.current > 0 &&
                    now - turnSpeakingStartRef.current > SILENCE_HANG_MS
                  ) {
                    logger.audio.warn('Model generating only silence — no real PCM audio in 3s, forcing reconnect', {
                      silenceDurationMs: now - turnSpeakingStartRef.current,
                    });
                    turnHadRealAudioRef.current = true; // Prevent re-entry
                    isPlayingAudioRef.current = false;
                    if (speakingWatchdogRef.current) {
                      clearTimeout(speakingWatchdogRef.current);
                      speakingWatchdogRef.current = null;
                    }
                    const attempt = reconnectAttemptRef.current;
                    if (attempt < MAX_RECONNECT_ATTEMPTS) {
                      reconnectAttemptRef.current++;
                      const delay = RECONNECT_DELAY_BASE * Math.pow(2, attempt);
                      send({ type: 'NETWORK_ERROR', error: `Reconnecting… (${reconnectAttemptRef.current}/${MAX_RECONNECT_ATTEMPTS})` });
                      scheduleRetry(delay, 'silence-watchdog');
                      selfInitiatedCloseRef.current = true;
                      cleanupSession(false, true);
                    } else {
                      send({ type: 'NETWORK_ERROR', error: 'Connection lost. Please restart.' });
                      shouldAutoReconnectRef.current = false;
                    }
                  }
                }, 2000); // Check every 2s
                
                // Wait for first valid message before START_SUCCEEDED to detect invalid API key/model.
                // 8s gives enough headroom for slow mobile networks without masking real errors.
                // Use sessionStateRef (not stale context.state closure) for the real-time state.
                sessionValidationTimeoutRef.current = setTimeout(() => {
                  if (!sessionValidatedRef.current && sessionStateRef.current === SessionState.CONNECTING) {
                    logger.session.error('Session validation timeout - no response from model');
                    send({ type: 'START_FAILED', error: 'No response from model. Please check the model name.' });
                    cleanupSession(true, false);
                    pendingOperationRef.current = false;
                  }
                }, 8000);
            },
            onmessage: async (message: LiveServerMessage) => {
              try {
                lastMessageTimeRef.current = Date.now();
                // Cast to extended type to handle undocumented error fields the server may send
                const msg = message as LiveServerMessageWithError;

                // Raw API message logging — only in debug mode to avoid console spam in production
                if (configRef.current.showDebugInfo) {
                  logger.transport.debug('[LIVE API]', { raw: JSON.stringify(message).substring(0, 500) });
                }
                
                // Validate session on first message from model
                if (!sessionValidatedRef.current) {
                  // Check for error response
                  const errorMsg = msg.error?.message || msg.serverContent?.error?.message;
                  if (errorMsg) {
                    logger.session.error('Model returned error', { error: errorMsg });
                    if (sessionValidationTimeoutRef.current) {
                      clearTimeout(sessionValidationTimeoutRef.current);
                      sessionValidationTimeoutRef.current = null;
                    }
                    send({ type: 'START_FAILED', error: errorMsg.includes('not found') 
                      ? 'Model not found. Please check the model name.'
                      : errorMsg });
                    cleanupSession(true, false);
                    pendingOperationRef.current = false;
                    return;
                  }
                  
                  // Any non-error message validates the session
                  sessionValidatedRef.current = true;
                  isStartingRef.current = false;
                  if (sessionValidationTimeoutRef.current) {
                    clearTimeout(sessionValidationTimeoutRef.current);
                    sessionValidationTimeoutRef.current = null;
                  }
                  logger.session.info('Session validated - first message received');
                  lastErrorTypeRef.current = null; // Clear any previous error type

                  // Fix A: Resume AudioContexts immediately on validate so the recorder worklet
                  // starts processing audio right away — this makes the VU meter respond without
                  // waiting for the 3-second periodic resume interval.
                  if (inputAudioContextRef.current?.state === 'suspended') {
                    inputAudioContextRef.current.resume().catch(e =>
                      logger.audio.debug('Failed to resume input ctx on validate', e)
                    );
                  }
                  if (outputAudioContextRef.current?.state === 'suspended') {
                    outputAudioContextRef.current.resume().catch(e =>
                      logger.audio.debug('Failed to resume output ctx on validate', e)
                    );
                  }

                  // Fix B: On the very first session (fresh launch after permission dialog),
                  // suppress mic-to-server audio for 500ms so ambient tap/noise from granting
                  // the permission dialog cannot trigger a spurious first AI response.
                  if (!hasEverConnectedRef.current) {
                    hasEverConnectedRef.current = true;
                    startupQuietUntilRef.current = Date.now() + 500;
                    logger.audio.debug('Startup quiet period active (500ms) — suppressing initial mic audio');
                  }

                  send({ type: 'START_SUCCEEDED' });
                  pendingOperationRef.current = false;
                }
                
                // Check for API errors even after session validation (e.g. unsupported config fields)
                const postValidationError = msg.error?.message || msg.serverContent?.error?.message;
                if (postValidationError) {
                  logger.session.error('API error after session start', { error: postValidationError });
                  send({ type: 'NETWORK_ERROR', error: postValidationError });
                  cleanupSession(true, false);
                  return;
                }

                // Gemini 3.1 can deliver multiple parts per event (audio + transcript in one message)
                const parts = message.serverContent?.modelTurn?.parts ?? [];
                const currentState = sessionStateRef.current;
                const activeState = currentState === SessionState.LISTENING || currentState === SessionState.SPEAKING;

                // ─── Diagnose: log whenever this message contains audio parts ──────────────
                const audioParts = parts.filter(p => p?.inlineData?.data);
                if (audioParts.length > 0) {
                  logger.audio.info('Audio message arrived', {
                    chunks: audioParts.length,
                    totalBytes: audioParts.reduce((s, p) => s + (p.inlineData?.data?.length ?? 0), 0),
                    hasPlayer: !!pcmPlayerNodeRef.current,
                    activeState,
                    state: currentState,
                    outCtxState: outputAudioContextRef.current?.state,
                    // Full turn-state snapshot — key for diagnosing dropped audio
                    turnCompleted: turnStateRef.current.turnCompleted,
                    speakingTurnEnded: turnStateRef.current.speakingTurnEnded,
                    audioEndedAfterTurn: turnStateRef.current.audioEndedAfterTurn,
                    hadInput: hadInputRef.current,
                    inputSilenceElapsed: inputSilenceElapsedRef.current,
                    isPlaying: isPlayingAudioRef.current,
                    // Also report whether this message contains transcriptions (ordering matters!)
                    hasInputTxt: !!message.serverContent?.inputTranscription?.text,
                    hasOutputTxt: !!message.serverContent?.outputTranscription?.text,
                    hasTurnComplete: !!message.serverContent?.turnComplete,
                  });
                }
                // ─────────────────────────────────────────────────────────────────────────────

                for (const part of parts) {
                  const base64Audio = part?.inlineData?.data;
                  if (!base64Audio) continue;
                  if (!pcmPlayerNodeRef.current) {
                    // Player worklet not yet set up — audio is lost.
                    // On first start this should not happen (pcmPlayerNodeRef is set before
                    // the recorder worklet sends audio). On reconnect it can happen if the
                    // model sends audio faster than the worklet reloads.
                    logger.audio.warn('Audio chunk DROPPED — player worklet not ready (pcmPlayerNodeRef is null)', {
                      size: base64Audio.length,
                      state: currentState,
                      outCtxState: outputAudioContextRef.current?.state,
                    });
                    continue;
                  }

                  if (!activeState) {
                    logger.audio.warn('Audio chunk DROPPED — session not in active state', {
                      state: currentState,
                      size: base64Audio.length,
                    });
                    continue;
                  }

                  // SPEAKING-Ende vereinfacht: Drop audio nur wenn Turn beendet UND Player fertig
                  // speakingTurnEndedRef wird true wenn: turnComplete + Player 'ended' (mit 400ms Nachlauf)
                  if (turnStateRef.current.speakingTurnEnded) {
                    // ⚠ DIAGNOSE: This is the most common cause of "no audio playback".
                    // If speakingTurnEnded is stuck true across turns, ALL audio is silently dropped.
                    // The new-turn reset below (in the transcription block) fires AFTER this loop,
                    // so audio in the same message as outputTxt is already dropped before reset.
                    logger.audio.debug('Audio chunk DROPPED — speakingTurnEnded=true (turn fully over)', {
                      size: base64Audio.length,
                      // Full state snapshot for diagnosis
                      turnCompleted: turnStateRef.current.turnCompleted,
                      audioEndedAfterTurn: turnStateRef.current.audioEndedAfterTurn,
                      hadInput: hadInputRef.current,
                      inputSilenceElapsed: inputSilenceElapsedRef.current,
                      isPlaying: isPlayingAudioRef.current,
                      // If this message ALSO contains outputTxt, it means the turn-reset is
                      // happening AFTER the drop — the first audio chunk of the new turn is lost.
                      hasOutputTxtInSameMsg: !!message.serverContent?.outputTranscription?.text,
                      hasInputTxtInSameMsg: !!message.serverContent?.inputTranscription?.text,
                    });
                    continue;
                  }

                  // Measure latency on first audio response after user stopped speaking
                  if (!awaitingFirstResponseRef.current && lastAudioSendTimeRef.current > 0) {
                    const latency = Date.now() - lastAudioSendTimeRef.current;
                    if (latency >= 50 && latency <= 5000) {
                      send({ type: 'UPDATE_LATENCY', latency });
                      logger.audio.debug('Response latency (from end of speech)', { latency });
                      awaitingFirstResponseRef.current = true;
                    } else {
                      logger.audio.debug('Latency out of range, will retry', { latency });
                    }
                  }

                  // IMMEDIATELY set playing flag BEFORE sending to player
                  // This prevents race condition where mic can hear AI output before flag is set
                  const wasPlaying = isPlayingAudioRef.current;
                  isPlayingAudioRef.current = true;

                  // On the first audio chunk of a new turn, immediately send audioStreamEnd.
                  // This closes the ~20ms race window in which the recorder worklet could
                  // still forward a mic frame to the server before shouldPauseAudio takes
                  // effect — a single stray frame is enough to trigger the server's VAD and
                  // produce an INTERRUPTED event that cuts off the first AI response.
                  if (!wasPlaying && wasStreamingAudioRef.current && activeSessionRef.current) {
                    try {
                      activeSessionRef.current.sendRealtimeInput({ audioStreamEnd: true });
                      wasStreamingAudioRef.current = false;
                      logger.audio.debug('Sent immediate audioStreamEnd on AI audio start (zero-delay echo prevention)');
                    } catch (e) {
                      logger.audio.warn('Failed to send immediate audioStreamEnd', e);
                    }
                  }

                  const pcmData = decode(base64Audio);

                  // Silence detection: check if this chunk contains any non-zero byte.
                  // When the model generates temperature=0 "hallucinated silence" it sends
                  // only null PCM samples (e.g. data: "AAA="). We track this per turn so
                  // the health check can reconnect if silence persists beyond 3 s real-time.
                  if (!turnHadRealAudioRef.current) {
                    for (let bi = 0; bi < pcmData.byteLength; bi++) {
                      if (pcmData[bi] !== 0) { turnHadRealAudioRef.current = true; break; }
                    }
                  }

                  const buffer = pcmData.buffer.slice(pcmData.byteOffset, pcmData.byteOffset + pcmData.byteLength);
                  pcmPlayerNodeRef.current.port.postMessage(
                    { type: 'pcm', buffer, length: pcmData.byteLength },
                    [buffer]
                  );
                  // Track the time of the last received chunk so the SPEAKING watchdog
                  // can distinguish "actively streaming long audio" from "AI hung silently".
                  lastPcmChunkTimeRef.current = Date.now();
                  logger.audio.debug('Audio chunk received', { size: pcmData.byteLength });
                }

                const inputTranscription = message.serverContent?.inputTranscription;
                const outputTranscription = message.serverContent?.outputTranscription;
                const inputTxt = inputTranscription?.text;
                const outputTxt = outputTranscription?.text;

                if (inputTxt || outputTxt) {
                    logger.transport.info('Transcription received', { 
                      inputText: inputTxt?.substring(0, 80),
                      outputText: outputTxt?.substring(0, 80),
                      inputMeta: inputTranscription ? JSON.stringify(inputTranscription).substring(0, 200) : null,
                      outputMeta: outputTranscription ? JSON.stringify(outputTranscription).substring(0, 200) : null
                    });
                    
                    // Simplified turn reset logic - FOUR conditions must be met:
                    // 1. turnComplete received (turnCompletedRef = true)
                    // 2. Audio playback ended with 400ms delay (audioEndedAfterTurnRef = true) - prevents echo
                    // 3. Valid user input received after audio ended (hadInputRef = true) - user spoke
                    // 4. 1000ms silence after LAST inputText (inputSilenceElapsedRef = true) - user finished speaking
                    //
                    // The 1000ms silence protects against late audio packets (up to ~800ms network delay)
                    // being played while user is still speaking.
                    // Note: outputReceivedRef was removed - it provided no additional protection.
                    if (turnStateRef.current.turnCompleted) {
                      if (outputTxt) {
                        // If output text appears AND audio has ended AND user has spoken,
                        // this is a NEW turn starting. Reset flags to accept new audio.
                        if (turnStateRef.current.audioEndedAfterTurn && hadInputRef.current) {
                          // ⚠ DIAGNOSE NOTE: If this message also contained audio chunks (audioParts.length > 0),
                          // those chunks were already processed (and dropped if speakingTurnEnded=true)
                          // BEFORE we arrive here. The reset comes too late for audio in the same message.
                          logger.audio.info('New turn detected via outputTxt — resetting turn state', {
                            audioWasInSameMsg: audioParts.length > 0,
                            // If audioWasInSameMsg=true AND speakingTurnEnded was true at audio arrival,
                            // those first audio chunks are permanently lost.
                          });
                          // CRITICAL: Must reset speakingTurnEndedRef here too!
                          // Otherwise audio will be dropped even though a new turn started.
                          turnStateRef.current.speakingTurnEnded = false;
                          turnStateRef.current.audioEndedAfterTurn = false;
                          // Also reset turn flags since new turn is starting
                          turnStateRef.current.turnCompleted = false;
                          hadInputRef.current = false;
                          inputSilenceElapsedRef.current = false;
                          if (turnResetTimerRef.current) {
                            clearTimeout(turnResetTimerRef.current);
                            turnResetTimerRef.current = null;
                          }
                        } else {
                          // Conditions NOT yet met — new-turn reset blocked
                          logger.audio.debug('outputTxt arrived but new-turn reset BLOCKED — conditions not met', {
                            audioEndedAfterTurn: turnStateRef.current.audioEndedAfterTurn,
                            hadInput: hadInputRef.current,
                            // If both are false: player hasn't ended yet OR user hasn't spoken
                            // Audio for this new turn will be dropped until conditions are met
                            speakingTurnEnded: turnStateRef.current.speakingTurnEnded,
                          });
                        }
                      }
                      
                      if (inputTxt) {
                        // CRITICAL: Ignore input transcriptions during playback
                        // These are likely echo/feedback from the AI's own speech
                        // Note: 400ms post-stream delay in player worklet handles echo prevention
                        if (isPlayingAudioRef.current) {
                          logger.audio.debug('Ignoring input during playback (likely echo)', { 
                            text: inputTxt.substring(0, 40)
                          });
                        } else {
                          // Accept all input when not actively playing audio
                          // The player's 400ms post-stream delay is sufficient echo protection
                          // Audio has ended AND we're not playing - this is real user input
                          hadInputRef.current = true;
                          // Reset silence flag and restart timer on each inputText
                          inputSilenceElapsedRef.current = false;
                          if (turnResetTimerRef.current) {
                            clearTimeout(turnResetTimerRef.current);
                          }
                          turnResetTimerRef.current = setTimeout(() => {
                            inputSilenceElapsedRef.current = true;
                            logger.audio.debug('Turn condition: input silence elapsed (1000ms since last input)');
                            // Check if all FOUR conditions are now met
                            if (turnStateRef.current.turnCompleted && turnStateRef.current.audioEndedAfterTurn && 
                                hadInputRef.current && inputSilenceElapsedRef.current) {
                              turnStateRef.current.turnCompleted = false;
                              turnStateRef.current.audioEndedAfterTurn = false;
                              turnStateRef.current.speakingTurnEnded = false;
                              hadInputRef.current = false;
                              inputSilenceElapsedRef.current = false;
                              logger.audio.debug('Turn reset - ALL conditions met (timer)');
                            }
                            turnResetTimerRef.current = null;
                          }, INPUT_SILENCE_DELAY_MS);
                        }
                      }
                      
                      // Check if all FOUR conditions are now met
                      if (turnStateRef.current.audioEndedAfterTurn && hadInputRef.current && inputSilenceElapsedRef.current) {
                        turnStateRef.current.turnCompleted = false;
                        turnStateRef.current.audioEndedAfterTurn = false;
                        turnStateRef.current.speakingTurnEnded = false;
                        hadInputRef.current = false;
                        inputSilenceElapsedRef.current = false;
                        if (turnResetTimerRef.current) {
                          clearTimeout(turnResetTimerRef.current);
                          turnResetTimerRef.current = null;
                        }
                        logger.audio.debug('Turn reset - ALL conditions met');
                      }
                    }
                    
                    if (shouldClearOnNextRef.current) {
                        send({ type: 'CLEAR_TEXT' });
                        shouldClearOnNextRef.current = false;
                    }
                }

                const sameScript = sameScriptCacheRef.current;
                
                if (sameScript) {
                    if (inputTxt && outputTxt) {
                        send({ type: 'SET_TEXT', topText: outputTxt, bottomText: outputTxt, textType: 'output' });
                        mirrorLastTypeRef.current = 'output';
                    } else if (inputTxt) {
                        if (mirrorLastTypeRef.current === 'output') {
                            send({ type: 'SET_TEXT', topText: inputTxt, bottomText: inputTxt, textType: 'input' });
                        } else {
                            send({ type: 'UPDATE_TEXT', topText: inputTxt, bottomText: inputTxt, textType: 'input' });
                        }
                        mirrorLastTypeRef.current = 'input';
                    } else if (outputTxt) {
                        if (mirrorLastTypeRef.current === 'input') {
                            send({ type: 'SET_TEXT', topText: outputTxt, bottomText: outputTxt, textType: 'output' });
                        } else {
                            send({ type: 'UPDATE_TEXT', topText: outputTxt, bottomText: outputTxt, textType: 'output' });
                        }
                        mirrorLastTypeRef.current = 'output';
                    }
                } else {
                    if (inputTxt) {
                        const detected = detectLanguageByScript(inputTxt, sourceLangRef.current, targetLangRef.current);
                        const targetPane = detected === 'lang2' ? 'TOP' : 'BOTTOM';
                        logger.transport.info('INPUT ROUTING', { 
                          text: inputTxt.substring(0, 50), 
                          detected, 
                          routedTo: targetPane,
                          sourceLang: sourceLangRef.current.code,
                          targetLang: targetLangRef.current.code
                        });
                        
                        if (detected === 'lang1') {
                            send({ type: 'UPDATE_TEXT', bottomText: inputTxt });
                        } else if (detected === 'lang2') {
                            send({ type: 'UPDATE_TEXT', topText: inputTxt });
                        } else {
                            send({ type: 'UPDATE_TEXT', bottomText: inputTxt });
                        }
                    }
                    if (outputTxt) {
                        const detected = detectLanguageByScript(outputTxt, sourceLangRef.current, targetLangRef.current);
                        const targetPane = (detected === 'lang2' || detected === 'unknown') ? 'TOP' : 'BOTTOM';
                        logger.transport.info('OUTPUT ROUTING', { 
                          text: outputTxt.substring(0, 50), 
                          detected, 
                          routedTo: targetPane,
                          sourceLang: sourceLangRef.current.code,
                          targetLang: targetLangRef.current.code
                        });
                        
                        if (detected === 'lang2') {
                            send({ type: 'UPDATE_TEXT', topText: outputTxt });
                        } else if (detected === 'lang1') {
                            send({ type: 'UPDATE_TEXT', bottomText: outputTxt });
                        } else {
                            send({ type: 'UPDATE_TEXT', topText: outputTxt });
                        }
                    }
                }

                if (message.serverContent?.turnComplete) {
                    logger.transport.info('TURN COMPLETE - clearing text on next message');
                    shouldClearOnNextRef.current = true;
                    mirrorLastTypeRef.current = null;
                    turnStateRef.current.turnCompleted = true; // Mark turn as completed - drop any late audio
                    
                    // CRITICAL: If no audio is currently playing (text-only turn or muted output),
                    // immediately mark audio as ended to allow new input
                    // Otherwise, wait for MODEL_AUDIO_ENDED from PCM player (mit 400ms Nachlauf)
                    if (!isPlayingAudioRef.current) {
                      turnStateRef.current.audioEndedAfterTurn = true;
                      turnStateRef.current.speakingTurnEnded = true; // No audio playing — end turn immediately
                      // ⚠ DIAGNOSE: speakingTurnEnded is now TRUE and will DROP all audio from next turn
                      // until the new-turn detection in the transcription block resets it.
                      // New-turn reset requires: audioEndedAfterTurn=true + hadInput=true + outputTxt arrives.
                      logger.audio.debug('TURN_COMPLETE: no audio was playing — speakingTurnEnded=true immediately', {
                        // This is normal for a turn where the model sent no audio (e.g. pure text).
                        // It is a bug if the model DID send audio but isPlayingAudioRef was already false.
                        isPlaying: isPlayingAudioRef.current,
                        hadInput: hadInputRef.current,
                      });
                    } else {
                      turnStateRef.current.audioEndedAfterTurn = false; // Will be set true when audio actually ends
                      // speakingTurnEndedRef stays false — set to true once the player fires 'ended'
                      logger.audio.info('TURN_COMPLETE: audio still playing — waiting for player ended event', {
                        isPlaying: isPlayingAudioRef.current,
                      });
                    }
                    
                    hadInputRef.current = false; // Reset for next turn
                    inputSilenceElapsedRef.current = false;
                    if (turnResetTimerRef.current) {
                      clearTimeout(turnResetTimerRef.current);
                      turnResetTimerRef.current = null;
                    }
                    // Reset for next latency measurement cycle
                    awaitingFirstResponseRef.current = false;
                    lastAudioSendTimeRef.current = 0;
                    // Signal player that stream is complete - allows graceful end
                    if (pcmPlayerNodeRef.current) {
                      pcmPlayerNodeRef.current.port.postMessage({ type: 'endOfStream' });
                    }
                    send({ type: 'TURN_COMPLETE' });
                }

                if (message.serverContent?.interrupted) {
                    logger.transport.info('INTERRUPTED by user - clearing audio buffer');
                    if (pcmPlayerNodeRef.current) {
                      pcmPlayerNodeRef.current.port.postMessage({ type: 'clear' });
                    }
                    // FULL RESET of all turn-related flags on interrupt
                    // This ensures clean state for next turn
                    isPlayingAudioRef.current = false;
                    turnStateRef.current.turnCompleted = false;
                    turnStateRef.current.audioEndedAfterTurn = true; // Ready for new input
                    turnStateRef.current.speakingTurnEnded = false; // Ready for new audio
                    hadInputRef.current = false;
                    inputSilenceElapsedRef.current = false;
                    if (turnResetTimerRef.current) {
                      clearTimeout(turnResetTimerRef.current);
                      turnResetTimerRef.current = null;
                    }
                    send({ type: 'INTERRUPTED' });
                    shouldClearOnNextRef.current = true;
                    mirrorLastTypeRef.current = null;
                    // Reset for next latency measurement cycle
                    awaitingFirstResponseRef.current = false;
                    lastAudioSendTimeRef.current = 0;
                    // Signal tone is handled by the PCM player's 'ended' (reason='clear') callback
                    // triggered by the 'clear' message sent above. Playing it here too would cause
                    // a double-beep and double mic-mute cycle. Only fall back to playing directly
                    // when no player worklet is active.
                    if (!pcmPlayerNodeRef.current) {
                      playSignalToneWithMicMute();
                    }
                }
              } catch (err: unknown) {
                // Last-resort guard: any unhandled exception in the message handler is caught
                // here so it doesn't silently corrupt state or propagate to the SDK.
                logger.session.error('Unhandled error in onmessage handler', err);
                send({ type: 'NETWORK_ERROR', error: 'Internal error. Please restart.' });
                void cleanupSession(true, false);
              }
            },
            onerror: (err: ErrorEvent) => {
              logger.transport.error('WebSocket error', err);
              // Don't immediately error - wait for onclose to handle reconnect
              pendingOperationRef.current = false;
            },
            onclose: (event: CloseEvent) => {
              const wasStarting = isStartingRef.current;
              logger.transport.info('WebSocket closed', { 
                state: context.state, 
                code: event?.code,
                reconnectAttempt: reconnectAttemptRef.current,
                shouldAutoReconnect: shouldAutoReconnectRef.current,
                sessionValidated: sessionValidatedRef.current,
                wasStarting
              });
              pendingOperationRef.current = false;
              isStartingRef.current = false;
              
              // Clear validation timeout if pending
              if (sessionValidationTimeoutRef.current) {
                clearTimeout(sessionValidationTimeoutRef.current);
                sessionValidationTimeoutRef.current = null;
              }
              
              // If we were in the process of starting and never validated, this is a startup failure
              if (wasStarting && !sessionValidatedRef.current) {
                logger.session.error('Connection closed before validation - likely invalid model or API key');
                send({ type: 'START_FAILED', error: 'Connection failed. Please check model name and API key.' });
                return;
              }
              
              // Don't reconnect if user intentionally disconnected.
              // Use sessionStateRef (not stale context.state closure) so this reflects
              // the real current state even when called from the auto-start path.
              if (sessionStateRef.current === SessionState.IDLE || sessionStateRef.current === SessionState.DISCONNECTING) {
                return;
              }

              // If turnSignalMissing or the SPEAKING watchdog already scheduled a retry and
              // triggered this close, skip reconnect — they already incremented the counter
              // and set the timer.  pendingOperationRef is already false at this point (the
              // session was validated before turnSignalMissing can fire), so returning here
              // is safe and prevents double-counting the reconnect attempt.
              if (selfInitiatedCloseRef.current) {
                selfInitiatedCloseRef.current = false;
                logger.session.debug('onclose: self-initiated close — reconnect already scheduled, skipping duplicate');
                return;
              }
              
              // Check if we should auto-reconnect
              const canReconnect = shouldAutoReconnectRef.current && 
                                   navigator.onLine && 
                                   reconnectAttemptRef.current < MAX_RECONNECT_ATTEMPTS;
              
              if (canReconnect) {
                const delay = RECONNECT_DELAY_BASE * Math.pow(2, reconnectAttemptRef.current);
                reconnectAttemptRef.current++;
                
                // Show reconnect status but keep state in ERROR for canStart check
                lastErrorTypeRef.current = 'network';
                send({ type: 'NETWORK_ERROR', error: `Connection lost. Reconnecting in ${delay/1000}s... (${reconnectAttemptRef.current}/${MAX_RECONNECT_ATTEMPTS})` });
                
                // Schedule retry BEFORE cleanup to ensure timer is set
                // (cleanup with preserveRetryTimer=true won't clear it)
                scheduleRetry(delay, 'websocket-reconnect');
                
                // Cleanup current session but preserve AudioContexts and retry timer
                cleanupSession(false, true);
              } else {
                // Max attempts reached or offline - full cleanup with microphone release
                lastErrorTypeRef.current = 'network';
                const errorMsg = !navigator.onLine 
                  ? 'Internet connection lost.'
                  : reconnectAttemptRef.current >= MAX_RECONNECT_ATTEMPTS
                    ? 'Connection failed. Please restart manually.'
                    : event?.code === 1006 
                      ? 'Server unreachable. Please try again later.'
                      : 'Connection to server interrupted.';
                logger.session.info('Max reconnect attempts reached, full cleanup with microphone release');
                send({ type: 'NETWORK_ERROR', error: errorMsg });
                cleanupSession(true, false);
                reconnectAttemptRef.current = 0;
                pendingOperationRef.current = false;
              }
            }
        }
      });

      // Race the entire parallel setup (mic + worklets + WebSocket) against 20 s.
      // Without a ceiling, ai.live.connect() can hang for ~30 s on mobile when the
      // Gemini endpoint is unreachable, leaving pendingOperationRef stuck at true.
      const parallelSetupTimeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(Object.assign(
          new Error('Connection timed out — please check your internet connection.'),
          { name: 'NetworkError' }
        )), 20_000)
      );
      const [stream, , session] = await Promise.race([
        Promise.all([
          getStreamPromise,
          loadWorkletsPromise,
          connectSessionPromise
        ]),
        parallelSetupTimeout
      ]);
      logger.mark('parallel_setup_done');
      
      // Abort check after async parallel setup - critical point before wiring mic/session
      if (checkAbort()) {
        logger.session.warn('Session start aborted after parallel setup - cleaning up');
        // Clean up what we just acquired
        if (stream) {
          stream.getTracks().forEach(track => track.stop());
          streamRef.current = null;
        }
        if (session) {
          try { session.close(); } catch(e) { logger.transport.debug('Failed to close aborted session', e); }
        }
        pendingOperationRef.current = false;
        isStartingRef.current = false;
        send({ type: 'HARD_RESET' });
        return;
      }
      
      const pcmPlayer = new AudioWorkletNode(outputCtx, 'pcm-player-processor', {
        processorOptions: { sampleRate: OUTPUT_SAMPLE_RATE, loggingEnabled: configRef.current.showDebugInfo }
      });
      pcmPlayer.port.onmessage = (e) => {
        try {
        // Handle error messages from worklet
        if (e.data.type === 'error') {
          logger.audio.error('PCM player worklet error', {
            context: e.data.context,
            message: e.data.message,
            errorCount: e.data.errorCount
          });
          return;
        }
        
        if (e.data.type === 'started') {
          isPlayingAudioRef.current = true;
          // New turn begins — reset silence-detection state
          turnSpeakingStartRef.current = Date.now();
          turnHadRealAudioRef.current = false;
          turnStateRef.current.speakingTurnEnded = false;
          // Defensive iOS fix: the output AudioContext can be auto-suspended by iOS
          // between session setup and first playback (e.g. on fresh PWA launch when
          // the audio session hasn't fully committed to PlayAndRecord mode yet).
          // Best-effort resume here; if iOS rejects it (no gesture), audio may still
          // not play but the periodic resumeAudio listener will recover it.
          const outCtxState = outputAudioContextRef.current?.state;
          if (outCtxState === 'suspended') {
            logger.audio.warn('Output AudioContext is SUSPENDED when player started — attempting resume (iOS likely cause)');
            outputAudioContextRef.current!.resume().catch(err =>
              logger.audio.warn('Failed to resume output AudioContext at playback start', err)
            );
          }
          send({ type: 'MODEL_AUDIO_STARTED' });
          logger.audio.info('PCM Player started', { 
            initialBufferMs: e.data.bufferMs,
            outCtxState,
            // If outCtxState is 'suspended', no audio will be heard even though chunks are queued
          });
          // SPEAKING-state watchdog: fires 8 s after the last PCM audio chunk was
          // received. Reschedules itself while chunks are arriving (long responses are
          // safe). Only triggers a reconnect when the API stops sending audio chunks
          // for 8 s while the player has not yet signalled a natural end.
          // This replaces the old "fire 8s after MODEL_AUDIO_STARTED" which caused
          // false reconnects for any response longer than 8 seconds.
          lastPcmChunkTimeRef.current = Date.now(); // Reset on new turn start
          if (speakingWatchdogRef.current) clearTimeout(speakingWatchdogRef.current);
          const SPEAKING_WATCHDOG_MS = 8_000;
          const armSpeakingWatchdog = () => {
            speakingWatchdogRef.current = setTimeout(() => {
              speakingWatchdogRef.current = null;
              if (!isPlayingAudioRef.current) return; // Already ended normally — no-op
              const silenceDuration = Date.now() - lastPcmChunkTimeRef.current;
              if (silenceDuration < SPEAKING_WATCHDOG_MS) {
                // Chunks still arriving — reschedule for the remaining gap
                armSpeakingWatchdog();
                return;
              }
              logger.audio.warn('SPEAKING watchdog fired — no audio chunk for 8s while playing, forcing reconnect', { silenceDuration });
              isPlayingAudioRef.current = false;
              const attempt = reconnectAttemptRef.current;
              if (attempt < MAX_RECONNECT_ATTEMPTS) {
                reconnectAttemptRef.current++;
                const delay = RECONNECT_DELAY_BASE * Math.pow(2, attempt);
                send({ type: 'NETWORK_ERROR', error: `Reconnecting… (${reconnectAttemptRef.current}/${MAX_RECONNECT_ATTEMPTS})` });
                scheduleRetry(delay, 'speaking-watchdog');
                // Tell onclose not to duplicate the reconnect (we are intentionally closing)
                selfInitiatedCloseRef.current = true;
                cleanupSession(false, true);
              } else {
                send({ type: 'NETWORK_ERROR', error: 'Connection lost. Please restart.' });
                shouldAutoReconnectRef.current = false;
              }
            }, SPEAKING_WATCHDOG_MS);
          };
          armSpeakingWatchdog();
        } else if (e.data.type === 'ended') {
          const reason = e.data.reason || 'natural';
          const stats = e.data.stats;
          
          // Always clear the SPEAKING watchdog when audio ends (any reason)
          if (speakingWatchdogRef.current) {
            clearTimeout(speakingWatchdogRef.current);
            speakingWatchdogRef.current = null;
          }
          
          // Only clear playing flag for definitive endings (complete, clear, natural)
          // Do NOT clear for 'underrun' - audio may still be pending/buffered
          if (reason === 'complete' || reason === 'clear' || reason === 'natural') {
            isPlayingAudioRef.current = false;
            // Post-AI-speech mic suppression: prevent mic from streaming to the server
            // for 300 ms after AI audio ends. This stops the mic from capturing speaker
            // output and sending it back to the model (echo → infinite feedback loop).
            // The worklet's 180 ms post-stream delay already helps, but we add another
            // 300 ms buffer on the streaming side for robustness.
            if (reason === 'complete' || reason === 'natural') {
              postSpeechSuppressUntilRef.current = Date.now() + 300;
              logger.audio.debug('Post-AI-speech mic suppression armed (300ms)');
            }
            
            // Mark that audio ended after turn - needed for turn reset logic (LISTENING)
            if (turnStateRef.current.turnCompleted) {
              turnStateRef.current.audioEndedAfterTurn = true;
              // SPEAKING-Ende: Turn ist komplett abgeschlossen - späte Audio-Chunks droppen
              turnStateRef.current.speakingTurnEnded = true;
              logger.audio.debug('SPEAKING turn ended: turnComplete + player ended (mit 400ms Nachlauf)');
            }
            
            send({ type: 'MODEL_AUDIO_ENDED' });
            // Always clear connection degraded state when playback ends
            // This handles cases where turn completes while still in grace period
            send({ type: 'CONNECTION_QUALITY_RECOVERED' });
          }
          
          // Handle turnSignalMissing - 4s ohne endOfStream/turnComplete nach Buffer leer
          // Das bedeutet die KI hat aufgehört zu sprechen aber kein Turn-Ende-Signal gesendet
          if (reason === 'turnSignalMissing') {
            logger.network.error('Turn Signal fehlt: 4s ohne turnComplete nach Audio-Ende', {
              gracePeriodSeconds: 4,
              gracePeriodEvents: stats?.gracePeriodEvents
            });

            // Reset audio playing flag immediately so the Visualizer exits the frozen
            // "speaking" wave animation and canStart is no longer blocked.
            isPlayingAudioRef.current = false;

            // Connection reset und Reconnect
            const attempt = reconnectAttemptRef.current;
            if (attempt < MAX_RECONNECT_ATTEMPTS) {
              reconnectAttemptRef.current++;
              const delay = RECONNECT_DELAY_BASE * Math.pow(2, attempt);
              // Transition to ERROR *before* scheduling the retry so that canStart=true
              // when startSession fires. Without this the machine stays in SPEAKING where
              // canStart=false and every retry call is silently blocked forever.
              send({ type: 'NETWORK_ERROR', error: `Reconnecting… (${reconnectAttemptRef.current}/${MAX_RECONNECT_ATTEMPTS})` });
              scheduleRetry(delay, 'turn-signal-missing');
              // Tell onclose not to duplicate the reconnect (we are intentionally closing)
              selfInitiatedCloseRef.current = true;
              // Cleanup session but preserve AudioContexts for quick restart
              cleanupSession(false, true);
            } else {
              logger.network.error('Max reconnect attempts reached after turn signal missing');
              send({ type: 'NETWORK_ERROR', error: 'Connection lost. Please restart.' });
              shouldAutoReconnectRef.current = false;
            }
            return; // Don't play signal tone - we're reconnecting
          }
          
          if (stats) {
            logger.audio.info('PCM Player ended', {
              reason,
              droppedSamples: e.data.droppedSamples || 0,
              totalChunks: stats.totalChunksReceived,
              totalSamplesReceived: stats.totalSamplesReceived,
              totalSamplesPlayed: stats.totalSamplesPlayed,
              underruns: stats.underruns,
              gracePeriodEvents: stats.gracePeriodEvents,
              maxBufferMs: stats.maxBufferMs,
              minBufferMs: stats.minBufferMs,
              peakAmplitude: stats.peakAmplitude,
              resampleRatio: stats.resampleRatio
            });
          }
          
          playSignalToneWithMicMute();
        } else if (e.data.type === 'bufferStatus') {
          const stats = e.data.stats;
          logger.audio.debug('PCM Buffer status', {
            currentBufferMs: stats.currentBufferMs,
            chunksQueued: stats.chunksQueued,
            underruns: stats.underruns,
            minBufferMs: stats.minBufferMs,
            maxBufferMs: stats.maxBufferMs
          });
        } else if (e.data.type === 'stats') {
          logger.audio.info('PCM Player stats', e.data.stats);
        } else if (e.data.type === 'gracePeriodStarted') {
          logger.network.info('Connection degraded: Audio buffer empty, waiting for more data (4s grace period)');
          send({ type: 'CONNECTION_QUALITY_DEGRADED' });
        } else if (e.data.type === 'gracePeriodRecovered') {
          logger.network.info('Connection recovered: Audio data received during grace period');
          send({ type: 'CONNECTION_QUALITY_RECOVERED' });
        }
        } catch (err: unknown) {
          logger.audio.error('Unhandled error in PCM player message handler', err);
        }
      };
      
      if (outputAnalyserRef.current && outputGainNodeRef.current) {
        pcmPlayer.connect(outputAnalyserRef.current);
        outputAnalyserRef.current.connect(outputGainNodeRef.current);
      } else if (outputGainNodeRef.current) {
        pcmPlayer.connect(outputGainNodeRef.current);
      }
      pcmPlayerNodeRef.current = pcmPlayer;
      logger.audio.info('PCM player node READY — audio chunks will now be accepted', {
        outCtxState: outputCtx.state,
        // Turn state at this point — should all be false after cleanupSession
        turnCompleted: turnStateRef.current.turnCompleted,
        speakingTurnEnded: turnStateRef.current.speakingTurnEnded,
        audioEndedAfterTurn: turnStateRef.current.audioEndedAfterTurn,
      });
      
      activeSessionRef.current = session;

      const source = inputCtx.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(inputCtx, 'recorder-processor', {
        processorOptions: { 
          inputSampleRate: inputCtx.sampleRate,
          outputSampleRate: INPUT_SAMPLE_RATE,
          numTaps: 16,
          numPhases: 32,
          gain: 1.0, // Input gain fixed at 1.0, output gain is adjustable
          inputBufferSize: configRef.current.inputBufferSize
        }
      });
      workletNodeRef.current = workletNode;

      sourceNodeRef.current = source;
      source.connect(inputAnalyser);
      inputAnalyser.connect(workletNode);
      workletNode.connect(inputCtx.destination);

      
      workletNode.port.onmessage = (event) => {
          // Discard audio when not in active translation mode (standby)
          // Only process audio in LISTENING or SPEAKING states
          const currentState = sessionStateRef.current;
          if (!activeSessionRef.current || 
              (currentState !== SessionState.LISTENING && currentState !== SessionState.SPEAKING)) {
            // Return buffer to pool if it's an audio message
            if (event.data.type === 'audio' && event.data.buffer) {
              workletNode.port.postMessage({ returnBuffer: event.data.buffer }, [event.data.buffer]);
            }
            return;
          }
          
          // Handle error messages from worklet
          if (event.data.type === 'error') {
              logger.audio.error('Recorder worklet error', {
                context: event.data.context,
                message: event.data.message,
                errorCount: event.data.errorCount
              });
              return;
          }
          
          // Handle stats messages
          if (event.data.type === 'stats') {
              logger.audio.info('Recorder stats', event.data.stats);
              return;
          }
          
          // Handle audio data (Int16, already resampled to 16kHz)
          if (event.data.type === 'audio') {
              const { buffer, length, timestamp, interval } = event.data;

              // Fix B (recorder side): Suppress mic-to-server audio during startup quiet period.
              // On fresh launch the audio session is settling immediately after the permission
              // dialog; returning the buffer early prevents ambient tap noise from reaching the
              // model and triggering a spurious first AI response.
              if (Date.now() < startupQuietUntilRef.current) {
                workletNode.port.postMessage({ returnBuffer: buffer }, [buffer]);
                return;
              }
              
              // Jitter detection for debugging
              if (configRef.current.showDebugInfo && interval !== undefined) {
                // Calculate expected interval based on configured buffer size and input sample rate
                // inputBufferSize samples @ inputSampleRate -> interval in ms
                const expectedInterval = (configRef.current.inputBufferSize / inputCtx.sampleRate) * 1000;
                if (interval > expectedInterval * 1.5 && lastRecorderIntervalRef.current > 0) {
                  // Request resampler reset in worklet
                  workletNode.port.postMessage({ type: 'reset' });
                  logger.audio.debug('Resampler reset due to jitter gap', { 
                    interval: interval.toFixed(2), 
                    expected: expectedInterval.toFixed(2) 
                  });
                }
                lastRecorderIntervalRef.current = interval;
              }
              
              // Pause audio during: manual mute, playback (if speaker not muted),
              // or the 300ms post-AI-speech suppression window (echo prevention).
              const postSpeechActive = Date.now() < postSpeechSuppressUntilRef.current;
              const shouldPauseAudio = isInputMutedRef.current || 
                                       (isPlayingAudioRef.current && !isOutputMutedRef.current) ||
                                       postSpeechActive;
              
              if (shouldPauseAudio) {
                  // If we were streaming and now paused, send audioStreamEnd immediately
                  // This marks the end of user speech
                  if (wasStreamingAudioRef.current) {
                    if (activeSessionRef.current) {
                      try {
                        activeSessionRef.current.sendRealtimeInput({ audioStreamEnd: true });
                        logger.audio.debug('Sent audioStreamEnd signal - end of speech');
                      } catch (e) {
                        logger.audio.warn('Failed to send audioStreamEnd', e);
                      }
                    }
                    wasStreamingAudioRef.current = false;
                  }
                  workletNode.port.postMessage({ returnBuffer: buffer }, [buffer]);
                  return;
              }

              try {
                  // Data is already Int16 at 16kHz from worklet
                  const int16Data = new Int16Array(buffer, 0, length);
                  
                  // Calculate peak from Int16 for VU meter
                  const { peak, clipping } = calculatePeakFromInt16(int16Data, length);
                  inputPeakLevelRef.current = inputPeakLevelRef.current * 0.8 + peak * 0.2; // Smoothing
                  inputClippingRef.current = clipping;
                  
                  // Audio test mode: collect audio instead of sending
                  if (configRef.current.audioTestMode) {
                    if (!audioTestBufferRef.current) {
                      audioTestBufferRef.current = new Float32Array(AUDIO_TEST_BUFFER_SIZE);
                      audioTestIndexRef.current = 0;
                      setAudioTestReady(false);
                    }
                    
                    // Convert Int16 to Float32 for test buffer
                    const remaining = AUDIO_TEST_BUFFER_SIZE - audioTestIndexRef.current;
                    const copyLen = Math.min(length, remaining);
                    
                    if (copyLen > 0) {
                      for (let i = 0; i < copyLen; i++) {
                        audioTestBufferRef.current[audioTestIndexRef.current + i] = int16Data[i] / 32767;
                      }
                      audioTestIndexRef.current += copyLen;
                      
                      if (audioTestIndexRef.current >= AUDIO_TEST_BUFFER_SIZE) {
                        setAudioTestReady(true);
                        logger.audio.info('Audio test buffer full (5 seconds collected)');
                      }
                    }
                    // Don't send to Gemini in test mode
                  } else {
                    // Only send if we're online - prevents sending into a broken connection
                    if (navigator.onLine) {
                      // Detect new speech segment: transition from not-streaming to streaming
                      // This is when user starts speaking after a pause/response
                      const isNewSpeechSegment = !wasStreamingAudioRef.current;
                      
                      // Send Int16 data directly (already at 16kHz)
                      activeSessionRef.current.sendRealtimeInput({ audio: createBlobFromInt16(int16Data, length) });
                      wasStreamingAudioRef.current = true; // Mark that we are actively streaming
                      
                      // Re-arm latency measurement at the START of each new speech segment
                      // This ensures we measure latency for every utterance, not just the first
                      if (isNewSpeechSegment) {
                        awaitingFirstResponseRef.current = false;
                        logger.audio.debug('New speech segment detected - latency measurement armed');
                      }
                    } else {
                      // We're offline but session hasn't closed yet - the WebSocket onclose will handle reconnect
                      logger.audio.debug('Skipping audio send - offline');
                    }
                  }
                  
                  const now = Date.now();
                  
                  // Track last audio send time for latency measurement
                  // We continuously update this timestamp while user is speaking
                  // Latency is measured from when user STOPS speaking (last chunk) to first response
                  if (!configRef.current.audioTestMode) {
                    lastAudioSendTimeRef.current = now;
                  }
                  
                  if (now - lastLatencyUpdateRef.current > 500) {
                    setProcessingTime(now - timestamp);
                    lastLatencyUpdateRef.current = now;
                  }
              } catch (err) { 
                // Log but don't throw - worklet message processing should be resilient
                logger.audio.warn('Error processing worklet audio data', err);
              }
              
              workletNode.port.postMessage({ returnBuffer: buffer }, [buffer]);
              return;
          }
      };

    } catch (err: unknown) {
      // PWA auto-start: mic permission dialog timed out — give up silently, go back to IDLE.
      // The getUserMedia call is still running in the browser background; if the user later
      // grants permission, the stream is simply discarded (micPermissionTimeoutMsRef is cleared).
      if (err instanceof Error && err.name === 'MicPermissionTimeout') {
        logger.session.info('PWA auto-start: mic permission timed out — returning to IDLE (user can start manually)');
        pendingOperationRef.current = false;
        isStartingRef.current = false;
        send({ type: 'HARD_RESET' });
        return;
      }

      logger.session.error('Session start failed', err);
      
      // Extract user-friendly error message
      let errorMsg = String(err);
      if (err instanceof Error && err.message) {
        errorMsg = err.message;
      }

      // For rate-limit errors: how long to wait before the automatic retry (ms).
      let rateLimitRetryDelayMs = RATE_LIMIT_RETRY_DELAY_MS;

      // Track error type for auto-retry logic
      const errorMsgLower = errorMsg.toLowerCase();
      if (errorMsgLower.includes('microphone') || errorMsgLower.includes('mic')) {
        lastErrorTypeRef.current = 'microphone';
      } else if (errorMsgLower.includes('audio')) {
        lastErrorTypeRef.current = 'audio';
      } else if (errorMsgLower.includes('network') || errorMsgLower.includes('internet') || errorMsgLower.includes('connection') || errorMsgLower.includes('offline')) {
        lastErrorTypeRef.current = 'network';
      } else if (errorMsgLower.includes('api') || errorMsgLower.includes('key') || errorMsgLower.includes('model')) {
        lastErrorTypeRef.current = 'api';
      } else {
        lastErrorTypeRef.current = 'other';
      }
      
      // Handle common API errors
      if (errorMsg.includes('401') || errorMsg.includes('UNAUTHENTICATED')) {
        errorMsg = 'Invalid API key. Please check your Google AI API key.';
        lastErrorTypeRef.current = 'api';
      } else if (errorMsg.includes('403') || errorMsg.includes('PERMISSION_DENIED')) {
        errorMsg = 'API key has no permission. Please enable the Gemini API.';
        lastErrorTypeRef.current = 'api';
      } else if (errorMsg.includes('404') || errorMsg.includes('NOT_FOUND') || errorMsg.includes('not found') || errorMsg.includes('model')) {
        errorMsg = 'Model not found. Please check the model name in settings.';
        lastErrorTypeRef.current = 'api';
      } else if (errorMsg.includes('429') || errorMsg.includes('RESOURCE_EXHAUSTED')) {
        // 429 can self-heal after the rate-limit window; retry automatically after delay.
        // Try to parse a Retry-After value from the error string (e.g. "retry_delay { seconds: 30 }").
        const retryAfterMatch = /(?:retry.?after|retry_delay)[^\d]*(\d+)/i.exec(errorMsg);
        const retrySeconds = retryAfterMatch ? parseInt(retryAfterMatch[1], 10) : RATE_LIMIT_RETRY_DELAY_MS / 1000;
        rateLimitRetryDelayMs = retrySeconds * 1000;
        errorMsg = `Rate limit reached — retrying in ${retrySeconds} s. Check your Gemini quota if this persists.`;
        lastErrorTypeRef.current = 'rate_limit';
      } else if (errorMsg.includes('fetch') || errorMsg.includes('network')) {
        errorMsg = 'Network error. Please check your internet connection.';
        lastErrorTypeRef.current = 'network';
      }
      
      logger.session.info('Error type classified', { errorType: lastErrorTypeRef.current });
      send({ type: 'START_FAILED', error: errorMsg });
      
      // Retry decision:
      //  - rate_limit (429): single auto-retry after the API's window resets (~60 s)
      //  - network: exponential-backoff up to MAX_RECONNECT_ATTEMPTS
      //  - api / microphone / audio / other: no self-healing retry
      if (lastErrorTypeRef.current === 'rate_limit' && shouldAutoReconnectRef.current) {
        logger.session.info('Scheduling retry after rate limit', { delayMs: rateLimitRetryDelayMs });
        scheduleRetry(rateLimitRetryDelayMs, 'rate-limited');
        cleanupSession(false, true);
      } else if (lastErrorTypeRef.current === 'network' && 
          shouldAutoReconnectRef.current && 
          reconnectAttemptRef.current < MAX_RECONNECT_ATTEMPTS) {
        const delay = RECONNECT_DELAY_BASE * Math.pow(2, reconnectAttemptRef.current);
        reconnectAttemptRef.current++;
        logger.session.info('Scheduling retry after network error', { attempt: reconnectAttemptRef.current, delay });
        // Schedule retry BEFORE cleanup to preserve the timer
        scheduleRetry(delay, 'start-failed-network');
        // Clean up stale resources but preserve the retry timer
        // Note: Keep microphone for quick retry to reduce latency
        cleanupSession(false, true);
      } else {
        // No retry - full cleanup with microphone release
        logger.session.info('Cleaning up session with microphone release (no retry)', { errorType: lastErrorTypeRef.current });
        cleanupSession(true, false);
      }
      
      pendingOperationRef.current = false;
    }
  }, [canStart, send, cleanupSession, releaseMedia, systemInstruction, context.latency, context.state, scheduleRetry]); 

  // Keep ref updated for reconnect timeout callbacks
  useEffect(() => {
    startSessionRef.current = startSession;
  }, [startSession]);

  // ─────────────────────────────────────────────────────────────────────────────
  // § 6  STOP / TOGGLE
  //      stopSession()   — user-initiated disconnect; disables auto-reconnect.
  //      toggleSession() — single button handler: stop if connected, start if not.
  // ─────────────────────────────────────────────────────────────────────────────

  const stopSession = useCallback(async () => {
    if (!canStop) return;
    
    logger.session.info('Stopping session');
    // Disable auto-reconnect when user manually stops
    shouldAutoReconnectRef.current = false;
    pendingOperationRef.current = false;
    // Sync the ref immediately — useEffect updates it only after paint, but onclose fires
    // synchronously inside cleanupSession. Without this update, onclose reads the stale
    // LISTENING/SPEAKING value and falls into the NETWORK_ERROR branch on manual stop.
    sessionStateRef.current = SessionState.DISCONNECTING;
    send({ type: 'STOP_REQUESTED' });
    
    // Send audioStreamEnd before closing if we were streaming
    if (wasStreamingAudioRef.current && activeSessionRef.current) {
      try {
        activeSessionRef.current.sendRealtimeInput({ audioStreamEnd: true });
        logger.audio.debug('Sent audioStreamEnd signal (stop)');
      } catch (e) { logger.transport.debug('Failed to send audioStreamEnd on stop', e); }
      wasStreamingAudioRef.current = false;
    }
    
    await cleanupSession(true, false);
    
    logger.session.info('Session stopped');
    send({ type: 'STOP_CONFIRMED' });
  }, [canStop, send, cleanupSession]);

  const hardReset = useCallback(async () => {
    // Disable auto-reconnect and reset counters
    shouldAutoReconnectRef.current = false;
    reconnectAttemptRef.current = 0;
    pendingOperationRef.current = true;
    // Sync sessionStateRef so onclose sees DISCONNECTING and short-circuits
    // rather than sending a spurious NETWORK_ERROR during hard reset.
    sessionStateRef.current = SessionState.DISCONNECTING;

    // Send audioStreamEnd before closing if we were streaming
    if (wasStreamingAudioRef.current && activeSessionRef.current) {
      try {
        activeSessionRef.current.sendRealtimeInput({ audioStreamEnd: true });
        logger.audio.debug('Sent audioStreamEnd signal (reset)');
      } catch (e) { logger.transport.debug('Failed to send audioStreamEnd on reset', e); }
      wasStreamingAudioRef.current = false;
    }
    
    await cleanupSession(true, false);
    
    // Reset prewarmed audio state to ensure fresh AudioContexts on next start
    // This fixes the issue where multiple resets were needed to get audio working
    await resetPrewarmedAudio();
    
    send({ type: 'HARD_RESET' });
    setActualInRate(0);
    setActualOutRate(0);
    pendingOperationRef.current = false;
  }, [cleanupSession, send]);

  const toggleSession = useCallback(async () => {
    if (canStart) {
      await startSession();
    } else if (canStop) {
      await stopSession();
    }
  }, [canStart, canStop, startSession, stopSession]);

  // ─────────────────────────────────────────────────────────────────────────────
  // § 6b  AUTO-START, BACKGROUND SUSPENSION & AUDIO RESUME
  //       auto-start: fires once on launch when API key is present.
  //       visibility change: suspends session when app is hidden, resumes on return.
  //       audio resume: periodic AudioContext.resume() for Safari background tabs.
  // ─────────────────────────────────────────────────────────────────────────────

  // Auto-start session ONCE when API key is available on app launch
  // This is intentionally a one-shot mechanism:
  // - Fires on first load if API key exists
  // - Does NOT re-fire after user stops/resets (user is in control)
  // - Manual restarts (via settings, hard reset button) handle their own session starts
  // - Retry after network failures is handled by scheduleRetry, not auto-start
  const autoStartAttemptedRef = useRef<boolean>(false);
  
  useEffect(() => {
    // Only attempt once per app lifecycle
    if (autoStartAttemptedRef.current) return;
    
    // Must have a valid API key
    const hasApiKey = config.userApiKey && config.userApiKey.trim() !== '';
    if (!hasApiKey) {
      return;
    }
    
    // Must be able to start (IDLE or ERROR state)
    if (!canStart) {
      return;
    }

    // Detect PWA standalone mode — auto-start is only allowed when running as an
    // installed PWA (display-mode: standalone). In a regular browser tab the OS
    // permission model differs and the user must tap the button manually.
    const isPWA =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true;

    if (!isPWA) {
      return;
    }

    // Mark as attempted BEFORE async work to prevent race conditions
    autoStartAttemptedRef.current = true;

    // Launching a PWA by tapping its icon counts as a user gesture on all major
    // platforms (iOS 16+, Android Chrome). Try to start immediately after a short
    // settling delay. If the AudioContext is still suspended (older iOS), fall back
    // to the first touch/click as the triggering gesture.
    logger.session.info('Auto-start: PWA standalone mode — attempting immediate start');

    const handleFirstGesture = async () => {
      document.removeEventListener('touchstart', handleFirstGesture, true);
      document.removeEventListener('click', handleFirstGesture, true);
      logger.session.info('Auto-start: gesture fallback triggered, starting session');
      try {
        await startSessionRef.current?.();
      } catch (err) {
        logger.session.warn('Auto-start gesture fallback failed', err);
      }
    };

    // Short delay lets React finish mounting its first frame before we touch audio
    const timerId = window.setTimeout(async () => {
      try {
        await startSessionRef.current?.();
        // Success — no gesture listener needed
      } catch (err) {
        // AudioContext likely suspended (strict iOS); fall back to first gesture
        logger.session.info('Auto-start: immediate attempt failed, falling back to gesture', err);
        document.addEventListener('touchstart', handleFirstGesture, true);
        document.addEventListener('click', handleFirstGesture, true);
      }
    }, 300);

    return () => {
      clearTimeout(timerId);
      document.removeEventListener('touchstart', handleFirstGesture, true);
      document.removeEventListener('click', handleFirstGesture, true);
    };
  }, [config.userApiKey, canStart]);

  // Dedicated pause/resume for background handling - simpler than reusing stopSession
  const pauseForBackground = useCallback(async () => {
    logger.session.info('Pausing session for background');
    
    // Send audioStreamEnd before pausing if we were streaming
    if (wasStreamingAudioRef.current && activeSessionRef.current) {
      try {
        activeSessionRef.current.sendRealtimeInput({ audioStreamEnd: true });
        logger.audio.debug('Sent audioStreamEnd signal (background)');
      } catch (e) { logger.transport.debug('Failed to send audioStreamEnd on background', e); }
      wasStreamingAudioRef.current = false;
    }
    
    // Set flag to block any new startSession attempts and increment abort token
    isPausedForBackgroundRef.current = true;
    sessionAbortTokenRef.current++;
    
    // 1. Cancel ALL outstanding timers/timeouts
    if (sessionTimeoutRef.current) {
      clearTimeout(sessionTimeoutRef.current);
      sessionTimeoutRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (connectionHealthIntervalRef.current) {
      clearInterval(connectionHealthIntervalRef.current);
      connectionHealthIntervalRef.current = null;
    }
    if (sessionValidationTimeoutRef.current) {
      clearTimeout(sessionValidationTimeoutRef.current);
      sessionValidationTimeoutRef.current = null;
    }
    
    // Reset reconnect counters to prevent queued reconnects
    reconnectAttemptRef.current = 0;
    shouldAutoReconnectRef.current = false;
    
    // 2. Close WebSocket/Gemini session
    if (activeSessionRef.current) {
      try { activeSessionRef.current.close(); } catch(e) { logger.transport.debug('Failed to close session on background', e); }
      activeSessionRef.current = null;
    }
    
    // 3. Stop microphone to release for other apps
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
      logger.audio.info('Microphone released for other apps');
    }
    
    // 4. Disconnect worklets but keep AudioContexts
    if (workletNodeRef.current) {
      try {
        // Terminate so process() returns false and the processor can be GC'd.
        workletNodeRef.current.port.postMessage({ type: 'terminate' });
        workletNodeRef.current.port.onmessage = null;
        workletNodeRef.current.disconnect();
      } catch(e) { logger.audio.debug('Failed to disconnect worklet on background', e); }
      workletNodeRef.current = null;
    }
    if (sourceNodeRef.current) {
      try { sourceNodeRef.current.disconnect(); } catch(e) { logger.audio.debug('Failed to disconnect source node on background', e); }
      sourceNodeRef.current = null;
    }
    if (pcmPlayerNodeRef.current) {
      try {
        // Terminate so process() returns false and the processor can be GC'd.
        pcmPlayerNodeRef.current.port.postMessage({ type: 'terminate' });
        pcmPlayerNodeRef.current.port.postMessage({ type: 'clear' });
        pcmPlayerNodeRef.current.port.onmessage = null;
        pcmPlayerNodeRef.current.disconnect();
      } catch(e) { logger.audio.debug('Failed to disconnect PCM player on background', e); }
      pcmPlayerNodeRef.current = null;
    }
    // Disconnect and null the remaining audio graph nodes. Without this, when
    // startSession runs on foreground return it creates new GainNode/SoftClipNode/
    // AnalyserNodes and overwrites the refs — leaving the old nodes permanently
    // connected to outputCtx.destination. This leak grows with every background cycle.
    if (inputAnalyserRef.current) {
      try { inputAnalyserRef.current.disconnect(); } catch(e) { logger.audio.debug('Failed to disconnect input analyser on background', e); }
      inputAnalyserRef.current = null;
    }
    if (outputAnalyserRef.current) {
      try { outputAnalyserRef.current.disconnect(); } catch(e) { logger.audio.debug('Failed to disconnect output analyser on background', e); }
      outputAnalyserRef.current = null;
    }
    if (outputGainNodeRef.current) {
      try { outputGainNodeRef.current.disconnect(); } catch(e) { logger.audio.debug('Failed to disconnect gain node on background', e); }
      outputGainNodeRef.current = null;
    }
    if (softClipNodeRef.current) {
      try { softClipNodeRef.current.disconnect(); } catch(e) { logger.audio.debug('Failed to disconnect soft-clip node on background', e); }
      softClipNodeRef.current = null;
    }
    
    // 5. Suspend audio contexts to save battery
    try {
      if (inputAudioContextRef.current?.state === 'running') {
        await withCtxTimeout(inputAudioContextRef.current.suspend(), 'suspend');
      }
      if (outputAudioContextRef.current?.state === 'running') {
        await withCtxTimeout(outputAudioContextRef.current.suspend(), 'suspend');
      }
    } catch (e) {
      logger.audio.warn('Failed to suspend audio contexts', e);
    }
    
    // 6. Update state machine to IDLE
    pendingOperationRef.current = false;
    isStartingRef.current = false;
    isPlayingAudioRef.current = false;
    turnStateRef.current.audioEndedAfterTurn = false;
    turnStateRef.current.speakingTurnEnded = false;
    sessionValidatedRef.current = false;
    send({ type: 'HARD_RESET' });
    
    logger.session.info('Session paused for background');
  }, [send]);
  
  useEffect(() => {
    const handleVisibilityChange = async () => { 
      if (document.hidden) {
        const bgStart = Date.now();
        backgroundStartRef.current = bgStart;
        
        // Remember if we were connected so we can auto-reconnect when returning
        const wasConnected = isConnectedRef.current || isStartingRef.current;
        wasConnectedBeforeBackgroundRef.current = wasConnected;
        
        if (wasConnected) {
          await pauseForBackground();
        }
        
        // Set timeout for marking as "don't auto-reconnect" after 5 min
        if (backgroundTimeoutRef.current) clearTimeout(backgroundTimeoutRef.current);
        backgroundTimeoutRef.current = setTimeout(() => {
          logger.session.warn('Background timeout (5min), disabling auto-reconnect');
          wasConnectedBeforeBackgroundRef.current = false;
        }, BACKGROUND_TIMEOUT);
      } else {
        // App returned to foreground
        if (backgroundTimeoutRef.current) {
          clearTimeout(backgroundTimeoutRef.current);
          backgroundTimeoutRef.current = null;
        }
        const elapsed = backgroundStartRef.current ? Date.now() - backgroundStartRef.current : 0;
        backgroundStartRef.current = null;
        
        const shouldReconnect = wasConnectedBeforeBackgroundRef.current;
        wasConnectedBeforeBackgroundRef.current = false;
        
        // Clear the background pause flag so startSession can work again
        isPausedForBackgroundRef.current = false;
        
        logger.session.info('App returned to foreground', { 
          elapsedMs: elapsed, 
          shouldReconnect 
        });
        
        // Guard against multiple reconnect attempts
        if (shouldReconnect && !isReconnectingRef.current) {
          isReconnectingRef.current = true;
          logger.session.info('Auto-reconnecting session after background return');
          
          // Resume audio contexts first
          try {
            if (inputAudioContextRef.current?.state === 'suspended') {
              await withCtxTimeout(inputAudioContextRef.current.resume(), 'resume');
            }
            if (outputAudioContextRef.current?.state === 'suspended') {
              await withCtxTimeout(outputAudioContextRef.current.resume(), 'resume');
            }
          } catch (e) {
            logger.audio.warn('Failed to resume audio contexts', e);
          }
          
          // Ensure clean state before reconnecting
          shouldAutoReconnectRef.current = true;
          reconnectAttemptRef.current = 0;
          
          // Small delay to let audio contexts stabilize, then reconnect
          setTimeout(async () => {
            // Final check before actually starting - must still be visible
            if (document.hidden) {
              logger.session.debug('Auto-reconnect cancelled - app went back to background');
              isReconnectingRef.current = false;
              return;
            }
            try {
              await startSessionRef.current?.();
            } catch (e) {
              logger.session.error('Auto-reconnect failed', e);
            } finally {
              isReconnectingRef.current = false;
            }
          }, 300);
          return;
        }
        
        // If not auto-reconnecting, just try to resume suspended contexts
        if (inputAudioContextRef.current?.state === 'suspended') {
          try { await withCtxTimeout(inputAudioContextRef.current.resume(), 'resume'); } catch (e) { logger.audio.debug('Failed to resume input context on foreground', e); }
        }
        if (outputAudioContextRef.current?.state === 'suspended') {
          try { await withCtxTimeout(outputAudioContextRef.current.resume(), 'resume'); } catch (e) { logger.audio.debug('Failed to resume output context on foreground', e); }
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (backgroundTimeoutRef.current) clearTimeout(backgroundTimeoutRef.current);
    };
  }, [pauseForBackground]);

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null;
    
    const resumeAudio = () => {
      if (inputAudioContextRef.current?.state === 'suspended') {
        void inputAudioContextRef.current.resume().catch(e => logger.audio.debug('iOS resume input failed', e));
      }
      if (outputAudioContextRef.current?.state === 'suspended') {
        void outputAudioContextRef.current.resume().catch(e => logger.audio.debug('iOS resume output failed', e));
      }
    };
    
    document.addEventListener('click', resumeAudio);
    document.addEventListener('touchstart', resumeAudio);
    
    if (isConnected) {
      intervalId = setInterval(resumeAudio, 3000);
    }
    
    return () => {
      document.removeEventListener('click', resumeAudio);
      document.removeEventListener('touchstart', resumeAudio);
      if (intervalId) clearInterval(intervalId);
    };
  }, [isConnected]);

  // Reset audio test buffer when test mode is disabled
  useEffect(() => {
    if (!config.audioTestMode) {
      audioTestBufferRef.current = null;
      audioTestIndexRef.current = 0;
      setAudioTestReady(false);
    }
  }, [config.audioTestMode]);

  // Clear test buffer function
  const clearTestBuffer = useCallback(() => {
    audioTestBufferRef.current = null;
    audioTestIndexRef.current = 0;
    setAudioTestReady(false);
  }, []);

  // Play collected test audio at 16kHz, or start session if not connected
  const playTestAudio = useCallback(async () => {
    // If not connected yet, start the session first so user can record
    if (!isConnected) {
      logger.audio.info('Starting session for audio test recording');
      toggleSession();
      return;
    }

    // If no audio recorded yet, just return (user needs to speak first)
    if (!audioTestBufferRef.current || audioTestIndexRef.current === 0) {
      logger.audio.warn('No test audio to play - speak to record first');
      return;
    }

    const samplesToPlay = audioTestIndexRef.current;
    const testData = audioTestBufferRef.current.slice(0, samplesToPlay);
    
    logger.audio.info('Playing test audio', { 
      samples: samplesToPlay, 
      durationMs: (samplesToPlay / INPUT_SAMPLE_RATE * 1000).toFixed(0) 
    });

    // Mute input during playback to prevent echo (using temp mute system)
    requestTempMute('test-audio-playback');
    setIsPlayingTestAudio(true);

    // Hoist playbackCtx outside try so the finally block can always close it,
    // even if source.start() or the playback promise rejects mid-way.
    let playbackCtx: AudioContext | null = null;
    try {
      // Create a new AudioContext for playback at device rate; latencyHint: 0 = browser-minimum
      playbackCtx = new AudioContext({ latencyHint: 0 });
      
      // Create buffer at 16kHz (input sample rate — test audio was captured at INPUT_SAMPLE_RATE)
      const audioBuffer = playbackCtx.createBuffer(1, samplesToPlay, INPUT_SAMPLE_RATE);
      const channelData = audioBuffer.getChannelData(0);
      channelData.set(testData);

      const source = playbackCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(playbackCtx.destination);
      
      // Race playback against a timeout: if onended never fires (e.g. AudioContext
      // is suspended mid-playback), we bail out after duration + 4 s grace period
      // instead of hanging forever with isPlayingTestAudio stuck at true.
      const durationMs = (samplesToPlay / INPUT_SAMPLE_RATE) * 1000;
      const playbackTimeout = new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('Test audio playback timed out')), durationMs + 4_000)
      );
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          source.onended = () => resolve();
          try { source.start(); } catch (startErr) { reject(startErr); }
        }),
        playbackTimeout
      ]);
    } catch (e) {
      logger.audio.error('Failed to play test audio', e);
    } finally {
      // Always close the AudioContext — even if start() threw — to prevent leak
      if (playbackCtx && playbackCtx.state !== 'closed') {
        await playbackCtx.close().catch(_e => {});
      }
      setIsPlayingTestAudio(false);
      // Release temp mute - restores to user's persistent state
      releaseTempMute('test-audio-playback');
    }
  }, [isConnected, toggleSession, requestTempMute, releaseTempMute]);

  const status: ConnectionStatus = (() => {
    switch (context.state) {
      case SessionState.IDLE: return ConnectionStatus.DISCONNECTED;
      case SessionState.CONNECTING: return ConnectionStatus.CONNECTING;
      case SessionState.LISTENING:
      case SessionState.SPEAKING: return ConnectionStatus.CONNECTED;
      case SessionState.DISCONNECTING: return ConnectionStatus.DISCONNECTED;
      case SessionState.ERROR: return ConnectionStatus.ERROR;
      default: return ConnectionStatus.DISCONNECTED;
    }
  })();

  // ─────────────────────────────────────────────────────────────────────────────
  // § 7  HOOK RETURN
  //      Stable surface exported to consumers.  Grouped by concern:
  //      session controls | audio state | config | language | UI helpers
  // ─────────────────────────────────────────────────────────────────────────────

  return {
    status,
    topText: context.topText,
    bottomText: context.bottomText,
    isTurnFinished: context.isTurnFinished,
    latency: context.latency,
    processingTime,
    hasInteracted: context.hasInteracted,
    isOutputMuted,
    setIsOutputMuted,
    isInputMuted,
    setIsInputMuted: setMicMutedPersistent, // Use centralized helper for proper mute tracking
    config,
    setConfig,
    setHasInteracted: (_val: boolean) => {
    },
    resetUI: () => send({ type: 'CLEAR_TEXT' }),
    disconnectGenAI: stopSession,
    startSession: toggleSession,
    inputAnalyserRef,
    outputAnalyserRef,
    isPlayingAudioRef,
    actualInRate,
    actualOutRate,
    inputBaseLatency,
    outputBaseLatency,
    systemInstruction,
    customPrompt,
    setCustomPrompt,
    defaultPrompt: DEFAULT_PROMPT_TEMPLATE,
    sourceLangCode,
    setSourceLangCode,
    targetLangCode,
    setTargetLangCode,
    sourceLang,
    targetLang,
    hardReset,
    sessionState: context.state,
    isSpeaking,
    inputClipping,
    inputPeakLevel,
    errorMessage: context.errorMessage,
    sameScript: sameScriptCacheRef.current,
    lastTextType: context.lastTextType,
    isOnline,
    audioTestReady,
    isPlayingTestAudio,
    playTestAudio,
    clearTestBuffer,
    isConnectionDegraded
  };
};
