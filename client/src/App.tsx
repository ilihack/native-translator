/**
 * Root application component orchestrating the interpreter UI, session lifecycle,
 * and settings management. Renders the main translation interface with visualizer,
 * language selectors, and settings overlay.
 * @inputs useLiveSession hook for Gemini WebSocket session, user preferences from localStorage
 * @exports Default App component mounted by main.tsx
 */

import React, { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

import { ConnectionStatus } from './types';
import { useLiveSession } from './hooks/useLiveSession';
import Visualizer from './components/Visualizer';
import { Toaster } from '@/components/ui/toaster';
import { ServiceWorkerUpdateToast } from '@/components/ServiceWorkerUpdateToast';
import { logger } from './utils/logger';

import { ImpressumPage, DatenschutzPage } from './components/LegalPages';

// Lazy load SettingsOverlay - only needed when user clicks settings
const SettingsOverlay = lazy(() => import('./components/SettingsOverlay'));

// Preload SettingsOverlay after initial render so it's ready when user clicks
const preloadSettingsOverlay = () => import('./components/SettingsOverlay');

const App: React.FC = () => {
  const {
    status,
    topText,
    bottomText,
    isTurnFinished,
    latency,
    processingTime,
    hasInteracted,
    isOutputMuted,
    setIsOutputMuted,
    isInputMuted,
    setIsInputMuted,
    config,
    setConfig,
    setHasInteracted: _setHasInteracted,
    resetUI,
    startSession,
    inputAnalyserRef,
    outputAnalyserRef,
    isPlayingAudioRef,
    actualInRate,
    actualOutRate,
    inputBaseLatency,
    outputBaseLatency,
    sourceLangCode,
    setSourceLangCode,
    targetLangCode,
    setTargetLangCode,
    sourceLang,
    targetLang,
    customPrompt,
    setCustomPrompt,
    defaultPrompt,
    hardReset,
    inputClipping,
    inputPeakLevel,
    errorMessage,
    sameScript,
    lastTextType,
    isOnline,
    audioTestReady,
    isPlayingTestAudio,
    playTestAudio,
    clearTestBuffer,
    isConnectionDegraded
  } = useLiveSession();

  const [showSettings, setShowSettings] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  // AI disclaimer banner — fades out automatically after 2.5 s
  const [disclaimerVisible, setDisclaimerVisible] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setDisclaimerVisible(false), 2500);
    return () => clearTimeout(t);
  }, []);

  const [showPrivacyFromConsent, setShowPrivacyFromConsent] = useState(false);
  const [showImprintFromConsent, setShowImprintFromConsent] = useState(false);

  useEffect(() => {
    const onPrivacy = () => setShowPrivacyFromConsent(true);
    const onImprint = () => setShowImprintFromConsent(true);
    window.addEventListener('open-privacy', onPrivacy);
    window.addEventListener('open-imprint', onImprint);
    return () => {
      window.removeEventListener('open-privacy', onPrivacy);
      window.removeEventListener('open-imprint', onImprint);
    };
  }, []);

  // Handle #privacy / #imprint URL hashes — set when the user clicks those links
  // on the landing page (/) which redirects to /app#privacy or /app#imprint
  useEffect(() => {
    const hash = window.location.hash;
    if (hash === '#privacy') {
      setShowPrivacyFromConsent(true);
      history.replaceState(null, '', '/app');
    } else if (hash === '#imprint') {
      setShowImprintFromConsent(true);
      history.replaceState(null, '', '/app');
    }
  }, []);

  // HTTPS safety check — warn once if page is served over plain HTTP.
  // Localhost is a secure context by spec (browsers allow mic/camera there) so we skip it.
  // In production this path should never be hit (HSTS), but it protects the first visit
  // before HSTS caches the header.
  const isInsecureContext =
    typeof window !== 'undefined' &&
    window.location.protocol !== 'https:' &&
    window.location.hostname !== 'localhost' &&
    window.location.hostname !== '127.0.0.1';

  const partnerScrollRef = useRef<HTMLDivElement>(null);
  const userScrollRef = useRef<HTMLDivElement>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  // Connection quality is tracked by useLiveSession via isConnectionDegraded
  // (8-second silence timeout on the WebSocket) — no external ping needed.

  // Screen Wake Lock - keeps screen on only when actively translating with microphone on
  useEffect(() => {
    const isTranslating = status === ConnectionStatus.CONNECTED && !isInputMuted;
    // cancelled flag: set to true in the cleanup function so any in-flight
    // requestWakeLock() that resolves AFTER the effect is torn down can release
    // the newly acquired lock immediately — otherwise it would sit in wakeLockRef
    // with no one ever releasing it (screen stays on indefinitely in background).
    let cancelled = false;

    const requestWakeLock = async () => {
      if (!('wakeLock' in navigator) || !isTranslating) return;
      try {
        const lock = await navigator.wakeLock.request('screen');
        if (cancelled) {
          // Effect was cleaned up while we were awaiting the lock — release immediately
          lock.release().catch(() => {});
          return;
        }
        wakeLockRef.current = lock;
        logger.ui.info('Wake lock acquired', { status: 'active' });
      } catch (err) {
        logger.ui.warn('Wake lock request failed', { error: String(err) });
      }
    };

    const releaseWakeLock = async () => {
      const lock = wakeLockRef.current;
      if (lock) {
        wakeLockRef.current = null; // Clear ref first to prevent double-release
        await lock.release();
        logger.ui.info('Wake lock released');
      }
    };

    const handleVisibilityChange = () => {
      logger.ui.debug('Visibility changed', { 
        state: document.visibilityState, 
        isTranslating 
      });
      if (document.visibilityState === 'visible' && isTranslating) {
        requestWakeLock();
      }
    };

    if (isTranslating) {
      requestWakeLock();
      document.addEventListener('visibilitychange', handleVisibilityChange);
    } else {
      releaseWakeLock();
    }

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      releaseWakeLock();
    };
  }, [status, isInputMuted]);

  // PWA Install handler
  useEffect(() => {
    const handler = (e: BeforeInstallPromptEvent) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  // Preload SettingsOverlay after initial render so it's instantly available on first click
  useEffect(() => {
    preloadSettingsOverlay();
  }, []);

  const handleToggleInputMute = useCallback(() => {
    setIsInputMuted(!isInputMuted);
  }, [isInputMuted, setIsInputMuted]);

  const installPWA = useCallback(async () => {
    if (!deferredPrompt) return;
    logger.ui.info('PWA install prompt shown');
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    logger.ui.info('PWA install result', { outcome });
    if (outcome === 'accepted') {
      setDeferredPrompt(null);
    }
  }, [deferredPrompt]);

  // Auto-open settings if no API key is configured
  // Note: Auto-start of translation session is handled in useLiveSession.ts
  useEffect(() => {
    if (!config.userApiKey || config.userApiKey.trim() === '') {
      setShowSettings(true);
    }
  }, []);

  // Auto-scroll
  useEffect(() => {
    if (partnerScrollRef.current)
      partnerScrollRef.current.scrollTo({ top: partnerScrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [topText]);
  useEffect(() => {
    if (userScrollRef.current)
      userScrollRef.current.scrollTo({ top: userScrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [bottomText]);

  const handleTextBoxClick = useCallback(() => {
    if (status === ConnectionStatus.DISCONNECTED) {
      startSession();
    }
  }, [status, startSession]);

  const handleSettingsClose = useCallback(async (didChange: boolean) => {
      setShowSettings(false);
      logger.ui.info('Settings closed', { didChange });
      if (didChange) {
          // Full hard reset ensures the new config (model, voice, VAD, temperature …)
          // takes effect cleanly: tears down WebSocket + audio contexts + state machine
          // so the user starts from a clean IDLE state without any stale session state.
          logger.session.info('Hard-resetting session due to settings change');
          await hardReset();
      }
  }, [hardReset]);

  const containerClasses = `flex flex-col h-dvh bg-black text-white font-sans overflow-hidden select-none transition-all duration-300 ${
    status === ConnectionStatus.ERROR ? 'border-4 border-red-600' : ''
  }`;
  const TEXT_STYLE_BASE = "text-3xl md:text-5xl font-medium leading-tight min-h-[1.2em] transition-all duration-300 ease-in-out";
  const PLACEHOLDER_STYLE = "text-zinc-200 font-bold text-4xl md:text-6xl animate-pulse opacity-90 drop-shadow-md";
  // Output is blue, Input is white
  // For sameScript: both fields show same text, color based on whether it's output or input
  const isOutputText = lastTextType === 'output';
  // For sameScript mode: Input = white on both sides, Output = blue on both sides
  // For different scripts: top always blue, bottom always white
  const topTextColor = sameScript ? (isOutputText ? "text-blue-400" : "text-white") : "text-blue-400";
  const bottomTextColor = sameScript ? (isOutputText ? "text-blue-400" : "text-white") : "text-white";

  // Dynamic placeholders based on connection status - now include language name
  const isActive = status === ConnectionStatus.CONNECTED;
  const topPlaceholder = isActive 
    ? `${targetLang.placeholder}` 
    : targetLang.startPlaceholder;
  const bottomPlaceholder = isActive 
    ? `${sourceLang.placeholder}` 
    : sourceLang.startPlaceholder;
  
  // Language badges for display (using nativeName for native representation)
  const sourceLangDisplay = sourceLang.nativeName;
  const targetLangDisplay = targetLang.nativeName;

  return (
    <div className={containerClasses}>
      <style>{` .scrollbar-hide::-webkit-scrollbar { display: none; } .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; } `}</style>

      {/* OFFLINE BANNER - styled consistently with the app's dark theme */}
      {!isOnline && (
        <div className="absolute top-0 left-0 right-0 z-50 bg-zinc-900/95 border-b border-red-600/50 text-zinc-200 text-center py-3 px-4 text-sm font-medium backdrop-blur-sm" data-testid="banner-offline">
          <svg className="w-4 h-4 inline-block mr-2 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a4.978 4.978 0 01-1.414-2.83m-1.414 5.658a9 9 0 01-2.167-9.238m7.824 2.167a1 1 0 111.414 1.414m-1.414-1.414L3 3m8.293 8.293l1.414 1.414" /></svg>
          <span className="text-red-400">No internet connection</span>
          <span className="block text-xs text-zinc-500 mt-1">Audio paused - waiting for connection</span>
        </div>
      )}

      {/* RECONNECTING BANNER - shown when actively trying to reconnect */}
      {isOnline && errorMessage?.toLowerCase().includes('reconnecting') && (
        <div className="absolute top-0 left-0 right-0 z-50 bg-zinc-900/95 border-b border-yellow-600/50 text-zinc-200 text-center py-3 px-4 text-sm font-medium backdrop-blur-sm" data-testid="banner-reconnecting">
          <div className="flex items-center justify-center gap-2">
            <div className="w-4 h-4 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin"></div>
            <span className="text-yellow-400">Reconnecting...</span>
          </div>
          <span className="block text-xs text-zinc-500 mt-1">Audio paused - please wait</span>
        </div>
      )}

      {/* SETTINGS BUTTON (Bottom Right) */}
      <button 
        onClick={(e) => { e.stopPropagation(); setShowSettings(!showSettings); }} 
        className="absolute bottom-[27px] right-3 z-40 w-12 h-12 bg-zinc-800/40 rounded-md flex items-center justify-center text-zinc-600 hover:bg-zinc-700/60 hover:text-zinc-300 backdrop-blur-md transition-all shadow-md border border-zinc-700/50"
        data-testid="button-settings-toggle"
      >
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
      </button>

      {showSettings && (
        <Suspense fallback={null}>
          <SettingsOverlay 
            isVisible={showSettings} 
            onClose={handleSettingsClose}
            latency={latency}
            processingTime={processingTime}
            config={config}
            setConfig={setConfig}
            actualInRate={actualInRate}
            actualOutRate={actualOutRate}
            inputBaseLatency={inputBaseLatency}
            outputBaseLatency={outputBaseLatency}
            sourceLangCode={sourceLangCode}
            setSourceLangCode={setSourceLangCode}
            targetLangCode={targetLangCode}
            setTargetLangCode={setTargetLangCode}
            customPrompt={customPrompt}
            setCustomPrompt={setCustomPrompt}
            defaultPrompt={defaultPrompt}
            inputClipping={inputClipping}
            inputPeakLevel={inputPeakLevel}
            canInstallPWA={!!deferredPrompt}
            onInstallPWA={installPWA}
            audioTestReady={audioTestReady}
            isPlayingTestAudio={isPlayingTestAudio}
            playTestAudio={playTestAudio}
            clearTestBuffer={clearTestBuffer}
            isConnected={status === ConnectionStatus.CONNECTED}
          />
        </Suspense>
      )}

      {/* OBEN: Zielsprache (rotiert) */}
      <div 
        onClick={handleTextBoxClick}
        className={`flex-1 rotate-180 transform border-b border-zinc-900 bg-black flex flex-col p-5 overflow-hidden relative transition-opacity duration-300 ${status === ConnectionStatus.DISCONNECTED ? 'opacity-50 cursor-pointer' : 'opacity-100'}`}
      >
        {/* Sprach-Label am unteren Rand rechts (erscheint oben wegen rotate-180) */}
        <div className="absolute bottom-2 right-3 text-xs text-zinc-600" data-testid="text-target-lang">{targetLangDisplay}</div>
        <div ref={partnerScrollRef} className="flex-1 flex flex-col overflow-y-auto pr-2 scrollbar-hide pb-1">
          <div className="space-y-4 mb-4 pt-1" />
          <div className={TEXT_STYLE_BASE}>
            {topText ? (
                <span className={`${topTextColor} opacity-100`}>
                    {topText}
                </span>
            ) : (
                <span className={PLACEHOLDER_STYLE}>{topPlaceholder}</span>
            )}
          </div>
        </div>
      </div>

      {/* MITTE: Controls */}
      <div className={`h-24 pb-[env(safe-area-inset-bottom)] bg-zinc-900 flex items-center justify-between px-8 z-20 border-y border-zinc-800 relative shadow-[0_0_50px_rgba(0,0,0,0.5)] shrink-0 transition-all duration-500 ${isTurnFinished && status === ConnectionStatus.CONNECTED ? 'border-green-900/50 shadow-[0_0_80px_rgba(34,197,94,0.1)]' : ''}`}>
        
        {/* LINKS: Mute Speaker */}
        <button onClick={() => setIsOutputMuted(!isOutputMuted)} className={`w-16 h-16 rounded-full flex items-center justify-center transition-all duration-300 ${isOutputMuted ? 'bg-orange-500/10 text-orange-500 border border-orange-500/30' : 'bg-zinc-800 text-zinc-500 hover:bg-zinc-700'}`}>
            {isOutputMuted ? 
              <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" /></svg> : 
              <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" /></svg>
            }
        </button>

        {/* MITTE: Visualizer/Status */}
        <div className="absolute left-1/2 -translate-x-1/2 flex flex-col items-center justify-center">
          {!hasInteracted || status !== ConnectionStatus.CONNECTED ? (
            <>
              {(() => {
                const isReconnecting = errorMessage?.toLowerCase().includes('reconnecting');
                const isOfflineError = !isOnline;
                const showWarningState = status === ConnectionStatus.ERROR && !isReconnecting && !isOfflineError;
                const showReconnectingState = status === ConnectionStatus.ERROR && (isReconnecting || isOfflineError);
                
                return (
                  <button 
                    onClick={() => { resetUI(); startSession(); }} 
                    disabled={showReconnectingState}
                    className={`w-20 h-20 rounded-full flex items-center justify-center shadow-[0_0_30px_rgba(255,255,255,0.2)] transition-all ${
                      showReconnectingState 
                        ? 'bg-yellow-600 text-white cursor-not-allowed opacity-80' 
                        : showWarningState 
                          ? 'bg-red-600 text-white animate-pulse hover:scale-110 active:scale-95' 
                          : 'bg-white text-black hover:scale-110 active:scale-95'
                    }`}
                    data-testid="button-mic-main"
                    aria-label={showReconnectingState ? 'Reconnecting…' : status === ConnectionStatus.CONNECTED ? 'Stop translation' : 'Start translation'}
                  >
                    {showReconnectingState ? (
                      <div className="flex flex-col items-center">
                        <div className="w-6 h-6 border-3 border-white border-t-transparent rounded-full animate-spin"></div>
                        <svg className="w-5 h-5 mt-1 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                          <line x1="4" y1="4" x2="20" y2="20" strokeWidth={2} />
                        </svg>
                      </div>
                    ) : showWarningState ? (
                      <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                    ) : status === ConnectionStatus.CONNECTING ? (
                      <div className="w-8 h-8 border-4 border-zinc-300 border-t-black rounded-full animate-spin"></div>
                    ) : (
                      <svg className="w-10 h-10" fill="currentColor" viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
                    )}
                  </button>
                );
              })()}
              {status === ConnectionStatus.CONNECTING && (
                <div className="absolute top-full mt-2 text-zinc-400 text-xs font-medium whitespace-nowrap">
                  Connecting…
                </div>
              )}
              {errorMessage && status === ConnectionStatus.ERROR && !errorMessage?.toLowerCase().includes('reconnecting') && (
                <div className="absolute top-full mt-2 px-3 py-1 bg-red-600/90 text-white text-xs font-medium rounded-full whitespace-nowrap max-w-[200px] truncate">
                  {errorMessage}
                </div>
              )}
            </>
          ) : (
            <Visualizer 
                status={status}
                isTurnFinished={isTurnFinished}
                hasInteracted={hasInteracted}
                inputAnalyserRef={inputAnalyserRef}
                outputAnalyserRef={outputAnalyserRef}
                isMicLocked={isPlayingAudioRef.current}
                isInputMuted={isInputMuted}
                onToggleInputMute={handleToggleInputMute}
            />
          )}
        </div>

        {/* RECHTS: Hard Reset */}
        <button onClick={hardReset} className="w-16 h-16 rounded-full flex items-center justify-center bg-zinc-800 text-zinc-500 hover:bg-zinc-700 hover:text-white transition-all">
          <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
        </button>
      </div>

      {/* UNTEN: Quellsprache */}
      <div 
        onClick={handleTextBoxClick}
        className={`flex-1 flex flex-col p-5 bg-black overflow-hidden relative transition-opacity duration-300 ${status === ConnectionStatus.DISCONNECTED ? 'opacity-50 cursor-pointer' : 'opacity-100'}`}
      >
        {/* Sprach-Label am unteren Rand rechts */}
        <div className="absolute bottom-2 right-3 text-xs text-zinc-600 z-10 flex items-center gap-3" data-testid="text-source-lang">
          {sourceLangDisplay}
          {isConnectionDegraded && (
            <span className="text-orange-500 animate-pulse flex items-center" data-testid="icon-connection-degraded" title="Slow connection - waiting for data">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.14 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0" />
              </svg>
            </span>
          )}
        </div>
        {status === ConnectionStatus.ERROR && !showSettings && (
           <div className="absolute top-10 left-0 right-0 z-40 px-8">
              <div className="bg-zinc-900/90 border border-red-600/50 text-zinc-200 p-4 rounded-xl backdrop-blur-sm">
                 <p className="font-bold uppercase tracking-wider text-sm text-red-400">
                   {errorMessage?.toLowerCase().includes('api') || errorMessage?.toLowerCase().includes('key') ? 'API Key Problem' : 
                    errorMessage?.toLowerCase().includes('microphone') || errorMessage?.toLowerCase().includes('mic') ? 'Microphone Error' : 
                    errorMessage?.toLowerCase().includes('audio') ? 'Audio Error' :
                    errorMessage?.toLowerCase().includes('internet') || errorMessage?.toLowerCase().includes('network') || errorMessage?.toLowerCase().includes('connection') || errorMessage?.toLowerCase().includes('offline') ? 'No Connection' :
                    errorMessage?.toLowerCase().includes('server') || errorMessage?.toLowerCase().includes('unreachable') ? 'Server Error' :
                    errorMessage?.toLowerCase().includes('limit') || errorMessage?.toLowerCase().includes('quota') ? 'Limit Reached' :
                    errorMessage?.toLowerCase().includes('model') ? 'Model Error' :
                    errorMessage?.toLowerCase().includes('timeout') ? 'Timeout' :
                    'Error'}
                 </p>
                 <p className="text-xs mt-1 text-zinc-400">
                   {errorMessage || 'Press the microphone button to restart.'}
                 </p>
                 {(errorMessage?.toLowerCase().includes('microphone') || errorMessage?.toLowerCase().includes('mic') || errorMessage?.toLowerCase().includes('audio')) && (
                   <p className="text-xs mt-1 text-zinc-400">
                     No audio is being sent - Gemini cannot respond.
                   </p>
                 )}
              </div>
           </div>
        )}

        <div ref={userScrollRef} className="flex-1 flex flex-col overflow-y-auto pr-2 scrollbar-hide pb-8">
          <div className="space-y-4 mb-4 pt-1">
            <div className={TEXT_STYLE_BASE}>
              {bottomText ? (
                  <span className={`${bottomTextColor} opacity-100`}>
                      {bottomText}
                  </span>
              ) : (
                  <span className={PLACEHOLDER_STYLE}>{bottomPlaceholder}</span>
              )}
            </div>
          </div>
        </div>
      </div>
      
      {/* AI DISCLAIMER — fades out after 2.5 s; kept in DOM for accessibility */}
      <div
        role="note"
        aria-hidden={!disclaimerVisible}
        data-testid="banner-ai-disclaimer"
        className={`fixed bottom-0 left-0 right-0 z-30 bg-zinc-950/90 border-t border-zinc-800 text-zinc-500 text-center py-1.5 px-4 text-xs backdrop-blur-sm pointer-events-none select-none transition-opacity duration-700 ${disclaimerVisible ? 'opacity-100' : 'opacity-0'}`}
      >
        ⚠ AI translation may contain errors — not for medical or legal decisions
      </div>

      {/* HTTPS-only safety banner — shown only when served over plain HTTP on a non-localhost host.
          A network attacker could MITM an HTTP connection and steal the API key or inject JS.
          In production HSTS prevents this after the first visit, but this banner protects
          the very first request before HSTS takes effect. */}
      {isInsecureContext && (
        <div
          role="alert"
          data-testid="banner-insecure-context"
          className="fixed bottom-7 left-0 right-0 z-50 bg-red-700 text-white text-xs text-center py-2 px-4 font-semibold"
        >
          ⚠ Insecure connection (HTTP). Your API key could be intercepted. Please use HTTPS.
        </div>
      )}

      {/* LEGAL PAGES opened from landing page consent (independent of SettingsOverlay) */}
      <ImpressumPage
        isVisible={showImprintFromConsent}
        onClose={() => setShowImprintFromConsent(false)}
      />
      <DatenschutzPage
        isVisible={showPrivacyFromConsent}
        onClose={() => setShowPrivacyFromConsent(false)}
      />

      <ServiceWorkerUpdateToast />
      <Toaster />
    </div>
  );
};

export default App;
