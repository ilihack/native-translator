/**
 * Full-screen settings overlay providing controls for API key entry, voice selection,
 * language pair configuration, audio device settings, and session preferences.
 * Persists all settings to localStorage and validates Gemini API key connectivity.
 * @inputs SettingsOverlayProps with current config, visibility state, and change callbacks
 * @exports Default SettingsOverlay component
 */

import { useEffect, useState, useRef } from 'react';
import { AudioConfig, FunnyMode, STORAGE_KEY } from '../hooks/useLiveSession';
import { MALE_VOICES, FEMALE_VOICES, SUPPORTED_LANGUAGES } from '../constants';
import { logger } from '../utils/logger';
import { useToast } from '@/hooks/use-toast';
import { HelpCircle, X, ShieldCheck } from 'lucide-react';
import { ImpressumPage, DatenschutzPage } from './LegalPages';

interface SettingsOverlayProps {
  isVisible: boolean;
  onClose: (didChange: boolean) => void;
  latency: number;
  processingTime: number;
  config: AudioConfig;
  setConfig: React.Dispatch<React.SetStateAction<AudioConfig>>;
  actualInRate?: number;
  actualOutRate?: number;
  inputBaseLatency?: number;
  outputBaseLatency?: number;
  sourceLangCode: string;
  setSourceLangCode: React.Dispatch<React.SetStateAction<string>>;
  targetLangCode: string;
  setTargetLangCode: React.Dispatch<React.SetStateAction<string>>;
  customPrompt: string;
  setCustomPrompt: React.Dispatch<React.SetStateAction<string>>;
  defaultPrompt: string;
  inputClipping?: boolean;
  inputPeakLevel?: number;
  canInstallPWA?: boolean;
  onInstallPWA?: () => void;
  audioTestReady?: boolean;
  isPlayingTestAudio?: boolean;
  playTestAudio?: () => void;
  clearTestBuffer?: () => void;
  isConnected?: boolean;
}

const SettingsOverlay: React.FC<SettingsOverlayProps> = ({
  isVisible,
  onClose,
  latency,
  config,
  setConfig,
  actualInRate: _actualInRate = 0,
  actualOutRate: _actualOutRate = 0,
  inputBaseLatency: _inputBaseLatency = 0,
  outputBaseLatency: _outputBaseLatency = 0,
  sourceLangCode,
  setSourceLangCode,
  targetLangCode,
  setTargetLangCode,
  customPrompt,
  setCustomPrompt,
  defaultPrompt,
  inputClipping: _inputClipping = false,
  inputPeakLevel: _inputPeakLevel = 0,
  canInstallPWA = false,
  onInstallPWA,
  audioTestReady = false,
  isPlayingTestAudio = false,
  playTestAudio,
  clearTestBuffer,
  isConnected = false
}) => {
  const [ping, setPing] = useState<number>(0);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Local string state for the temperature field so the user can type both
  // "0.3" and "0,3" (comma as decimal separator in European locales) without
  // the input jumping or losing focus mid-typing.
  const [tempStr, setTempStr] = useState<string>(() => String(config.temperature));
  const [tempError, setTempError] = useState<boolean>(false);
  const [helpModalOpen, setHelpModalOpen] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string>('...');
  const [showImpressum, setShowImpressum] = useState(false);
  const [showDatenschutz, setShowDatenschutz] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'ok' | 'fail'>('idle');
  const { toast } = useToast();

  useEffect(() => {
    const getVersionFromServiceWorker = async () => {
      try {
        const response = await fetch('/sw.js');
        const text = await response.text();
        const match = text.match(/CACHE_NAME\s*=\s*['"]native-translator-v([^'"]+)['"]/);
        if (match && match[1]) {
          setAppVersion(match[1]);
        }
      } catch (e) {
        logger.ui.debug('Failed to read app version from SW', e);
        setAppVersion('?');
      }
    };
    getVersionFromServiceWorker();
  }, []);

  // Keep the display string in sync when config.temperature changes from outside
  // (e.g. after a hard reset). Only update when we're not actively editing.
  useEffect(() => {
    setTempStr(String(config.temperature));
    setTempError(false);
  }, [config.temperature]);

  const helpContent: Record<string, { title: string; description: string }> = {
    apiKey: {
      title: "API Key",
      description: "The API key is your personal access key to Google Gemini, the AI that translates your speech. You need this key so the app can communicate with the Google service. The key is stored only on your device and is never shared with third parties. You can create a key for free at Google AI Studio."
    },
    languages: {
      title: "Languages",
      description: "Here you choose the source and target language for translation. The translation works bidirectionally - the AI automatically detects which of the two languages you are speaking and translates into the other language. The lower window shows the input language so you can see what was recognized, while the upper window shows the translation output."
    },
    installApp: {
      title: "Install App",
      description: "Installing as an app on your device offers several advantages: The app starts faster, and you have a convenient icon on your home screen. It also runs in full-screen mode without the browser bar. This is optional but recommended for the best user experience. Note: The app always requires an internet connection to work."
    }
  };
  
  const initialConfigRef = useRef<AudioConfig | null>(null);
  const initialSourceRef = useRef<string>('');
  const initialTargetRef = useRef<string>('');
  const initialPromptRef = useRef<string>('');

  const hasApiKey = config.userApiKey && config.userApiKey.trim() !== '';

  useEffect(() => {
    if (isVisible) {
      initialConfigRef.current = { ...config };
      initialSourceRef.current = sourceLangCode;
      initialTargetRef.current = targetLangCode;
      initialPromptRef.current = customPrompt;
    }
  }, [isVisible]);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    if (isVisible) {
      const measurePing = async () => {
        const start = performance.now();
        try {
          await fetch('https://generativelanguage.googleapis.com/', {
            mode: 'no-cors',
            cache: 'no-store',
          });
          const end = performance.now();
          setPing(Math.round(end - start));
        } catch (e) {
          logger.ui.debug('Ping measurement failed', e);
          setPing(-1);
        }
      };
      measurePing();
      interval = setInterval(measurePing, 2000);
    }
    return () => clearInterval(interval);
  }, [isVisible]);

  const updateOutputGain = (val: string) => {
      const num = parseFloat(val);
      if (!isNaN(num)) {
          setConfig(prev => ({ ...prev, outputGain: num }));
      }
  };

  const updateSoftClipDrive = (val: string) => {
      const num = parseFloat(val);
      if (!isNaN(num)) {
          setConfig(prev => ({ ...prev, softClipDrive: num }));
      }
  };

  const handleClose = () => {
      if (!hasApiKey) return;
      
      // Turn off audio test mode and clear buffer when leaving settings
      if (config.audioTestMode) {
        setConfig(prev => ({ ...prev, audioTestMode: false }));
      }
      if (clearTestBuffer) {
        clearTestBuffer();
      }

      // Ensure VAD numeric fields are always valid numbers before closing.
      // If the user cleared an input without blurring it first, '' or NaN could be
      // stored; clamp to safe defaults so the API never receives an invalid value.
      setConfig(prev => {
        const prefix = typeof prev.vadPrefixPaddingMs === 'number' && !isNaN(prev.vadPrefixPaddingMs)
          ? Math.min(500, Math.max(0, prev.vadPrefixPaddingMs))
          : 100;
        const silence = typeof prev.vadSilenceDurationMs === 'number' && !isNaN(prev.vadSilenceDurationMs)
          ? Math.min(2000, Math.max(50, prev.vadSilenceDurationMs))
          : 500;
        if (prefix === prev.vadPrefixPaddingMs && silence === prev.vadSilenceDurationMs) return prev;
        return { ...prev, vadPrefixPaddingMs: prefix, vadSilenceDurationMs: silence };
      });

      const configChanged = JSON.stringify(config) !== JSON.stringify(initialConfigRef.current);
      const langChanged = sourceLangCode !== initialSourceRef.current || targetLangCode !== initialTargetRef.current;
      const promptChanged = customPrompt !== initialPromptRef.current;
      
      if (configChanged || langChanged || promptChanged) {
        logger.ui.info('Settings changed', {
          configChanged,
          langChanged,
          promptChanged,
          sourceLang: sourceLangCode,
          targetLang: targetLangCode,
          voice: config.voiceName,
          model: config.modelName
        });
      }
      
      onClose(configChanged || langChanged || promptChanged);
  };

  const resetAdvancedSettings = async () => {
    if (isResetting) return;
    setIsResetting(true);
    logger.ui.info('Reset advanced settings requested');
    
    // Save API key before clearing
    const savedApiKey = config.userApiKey;
    
    // Clear localStorage but preserve API key
    localStorage.removeItem(STORAGE_KEY);
    
    // Restore only the API key
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ 
      config: { userApiKey: savedApiKey } 
    }));
    
    // Clear Service Worker cache
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      logger.ui.info('Clearing Service Worker cache');
      navigator.serviceWorker.controller.postMessage('clearCache');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // Clear all caches
    if ('caches' in window) {
      const names = await caches.keys();
      logger.ui.info('Clearing browser caches', { count: names.length });
      await Promise.all(names.map(name => caches.delete(name)));
    }
    
    logger.ui.info('Settings reset complete, reloading app');
    window.location.reload();
  };

  const getPingColor = () => {
    if (ping <= 0) return 'text-zinc-400';
    if (ping < 100) return 'text-green-400';
    if (ping <= 500) return 'text-yellow-400';
    return 'text-red-400';
  };

  if (!isVisible) return null;

  const displayPrompt = customPrompt || defaultPrompt;

  return (
    <>
    <ImpressumPage isVisible={showImpressum} onClose={() => setShowImpressum(false)} />
    <DatenschutzPage isVisible={showDatenschutz} onClose={() => setShowDatenschutz(false)} />
    <div data-testid="settings-overlay" className="fixed inset-0 z-50 bg-black/95 backdrop-blur-md flex flex-col p-6 items-center animate-in fade-in duration-200 overflow-y-auto">
      
      <div className="flex flex-col items-center mb-6 mt-4">
        <h1 className="text-blue-400 font-bold text-4xl tracking-tighter">Native Translator</h1>
        <p className="text-zinc-500 text-sm tracking-wide">Intelligent Instant Translator</p>
      </div>

      {!hasApiKey && (
        <div className="bg-blue-600/20 border border-blue-500/50 rounded-lg p-3 mb-4 max-w-lg w-full">
          <p className="text-blue-300 text-sm text-center">
            Welcome! Follow the steps below to get started.
          </p>
        </div>
      )}

      <h2 className="text-xl font-bold mb-4 text-white uppercase tracking-widest shrink-0">
        {hasApiKey ? 'Settings' : 'Setup'}
      </h2>

      <div className="grid grid-cols-2 gap-4 w-full max-w-lg text-sm font-mono pb-8">
        
        <div className="col-span-2 flex items-center gap-2 mt-2">
          <div className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs font-bold">1</div>
          <span className="text-zinc-300 font-bold">API Key</span>
          <button
            data-testid="button-help-api-key"
            onClick={() => setHelpModalOpen('apiKey')}
            className="ml-1 text-zinc-500 hover:text-blue-400 transition-colors"
            aria-label="Hilfe zu API Key"
          >
            <HelpCircle className="w-4 h-4" />
          </button>
        </div>
        
        <div className="bg-zinc-900 p-4 rounded-lg border border-zinc-800 col-span-2">
          <label className="text-zinc-400 block mb-2">Google AI API Key (Gemini)</label>
          <input
            data-testid="input-api-key"
            type="password"
            value={config.userApiKey}
            onChange={(e) => {
              // Auto-strip whitespace: common paste artefact that silently breaks auth
              const cleaned = e.target.value.replace(/\s/g, '');
              setConfig(prev => ({ ...prev, userApiKey: cleaned }));
            }}
            placeholder="AIza..."
            autoComplete="off"
            spellCheck={false}
            className="w-full bg-black text-white p-3 rounded border border-zinc-700 focus:border-green-500 focus:outline-none font-mono"
          />
          {/* Non-blocking format warning: Google AI keys always start with "AIza" followed by 35 chars */}
          {config.userApiKey && !/^AIza[0-9A-Za-z_-]{35}$/.test(config.userApiKey) && (
            <p data-testid="warning-api-key-format" className="text-amber-500 text-xs mt-1" role="alert">
              Key format looks unusual — Google AI Studio keys start with "AIza" and are 39 characters.
            </p>
          )}
          <div className="mt-3 flex gap-2.5 bg-green-950/40 border border-green-800/40 rounded-lg p-3">
            <ShieldCheck className="w-4 h-4 text-green-500 flex-shrink-0 mt-0.5" />
            <p className="text-green-300/80 text-xs leading-relaxed">
              Your API key is stored <span className="font-semibold text-green-300">exclusively locally</span> in your browser (localStorage). It never leaves your device — we do not store, see, or transmit it. The connection to Google Gemini runs directly from your browser.
            </p>
          </div>
          <p className="text-zinc-600 text-xs mt-2">
            On shared devices, remove the key after use. ·{' '}
            <a
              href="https://aistudio.google.com/app/apikey"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:text-blue-300"
            >
              Create key
            </a>
          </p>
        </div>

        <div className="col-span-2 flex items-center gap-2 mt-4">
          <div className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs font-bold">2</div>
          <span className="text-zinc-300 font-bold">Languages</span>
          <button
            data-testid="button-help-languages"
            onClick={() => setHelpModalOpen('languages')}
            className="ml-1 text-zinc-500 hover:text-blue-400 transition-colors"
            aria-label="Hilfe zu Sprachen"
          >
            <HelpCircle className="w-4 h-4" />
          </button>
        </div>

        <div className="bg-zinc-900 p-4 rounded-lg border border-zinc-800 col-span-2">
          <label className="text-zinc-400 block mb-2">Source Language (Input)</label>
          <select
            data-testid="select-source-lang"
            value={sourceLangCode}
            onChange={(e) => setSourceLangCode(e.target.value)}
            className="w-full bg-black text-white p-3 rounded border border-zinc-700 focus:border-green-500 focus:outline-none"
          >
            {SUPPORTED_LANGUAGES.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.nativeName} ({lang.name})
              </option>
            ))}
          </select>
        </div>

        <div className="bg-zinc-900 p-4 rounded-lg border border-zinc-800 col-span-2">
          <label className="text-zinc-400 block mb-2">Target Language (Output)</label>
          <select
            data-testid="select-target-lang"
            value={targetLangCode}
            onChange={(e) => setTargetLangCode(e.target.value)}
            className="w-full bg-black text-white p-3 rounded border border-zinc-700 focus:border-green-500 focus:outline-none"
          >
            {SUPPORTED_LANGUAGES.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.nativeName} ({lang.name})
              </option>
            ))}
          </select>
        </div>

        <div className="col-span-2 flex items-center gap-2 mt-4">
          <div className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs font-bold">3</div>
          <span className="text-zinc-300 font-bold">Install App</span>
          <button
            data-testid="button-help-install-app"
            onClick={() => setHelpModalOpen('installApp')}
            className="ml-1 text-zinc-500 hover:text-blue-400 transition-colors"
            aria-label="Hilfe zur App-Installation"
          >
            <HelpCircle className="w-4 h-4" />
          </button>
        </div>

        <div className="bg-zinc-900 p-4 rounded-lg border border-zinc-800 col-span-2">
          {(() => {
            const isStandalone = window.matchMedia('(display-mode: standalone)').matches || (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
            const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
            const isAndroid = /Android/.test(navigator.userAgent);
            
            if (isStandalone) {
              return (
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-green-600/20 flex items-center justify-center">
                    <svg className="w-5 h-5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-green-400 font-bold">App installed</span>
                    <span className="text-zinc-500 text-xs">You are already using the app</span>
                  </div>
                </div>
              );
            }
            
            if (canInstallPWA) {
              return (
                <div className="flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="text-white font-bold">Install App</span>
                    <span className="text-zinc-500 text-xs">Save as app on your device</span>
                  </div>
                  <button
                    onClick={onInstallPWA}
                    data-testid="button-install-pwa"
                    className="px-4 py-2 bg-blue-600 text-white text-xs font-bold rounded-full hover:bg-blue-500 transition-colors"
                  >
                    INSTALL
                  </button>
                </div>
              );
            }
            
            if (isIOS) {
              return (
                <div className="flex flex-col gap-2">
                  <span className="text-white font-bold">Install App (iOS)</span>
                  <div className="flex items-center gap-2 text-zinc-400 text-sm">
                    <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                    </svg>
                    <span>Tap the Share icon</span>
                  </div>
                  <div className="flex items-center gap-2 text-zinc-400 text-sm">
                    <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                    </svg>
                    <span>Select "Add to Home Screen"</span>
                  </div>
                </div>
              );
            }
            
            if (isAndroid) {
              return (
                <div className="flex flex-col gap-2">
                  <span className="text-white font-bold">Install App (Android)</span>
                  <div className="flex items-center gap-2 text-zinc-400 text-sm">
                    <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
                    </svg>
                    <span>Open the browser menu (⋮)</span>
                  </div>
                  <div className="flex items-center gap-2 text-zinc-400 text-sm">
                    <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                    </svg>
                    <span>Select "Add to Home Screen"</span>
                  </div>
                  <div className="flex items-center gap-2 text-zinc-400 text-sm">
                    <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    <span>Tap "Install"</span>
                  </div>
                </div>
              );
            }
            
            return (
              <div className="flex flex-col gap-2">
                <span className="text-white font-bold">Install App</span>
                <span className="text-zinc-500 text-sm">Use Chrome or Edge for the best experience</span>
              </div>
            );
          })()}
        </div>

        <div className="col-span-2 border-t border-zinc-800 my-4" />

        <div className="col-span-2 text-zinc-500 text-xs uppercase tracking-widest mb-2">Optional Settings</div>

        <div className="bg-zinc-900 p-4 rounded-lg border border-zinc-800 col-span-2">
           <label className="text-zinc-400 block mb-3">Voice <span className="text-zinc-600 text-xs">(Default: Aoede)</span></label>
           <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-zinc-500 text-xs uppercase tracking-wider mb-2 text-center">♂ Male</div>
                <div className="flex flex-col gap-2">
                  {MALE_VOICES.map((v) => (
                    <button 
                      key={v.id}
                      data-testid={`button-voice-${v.id}`}
                      onClick={() => setConfig(prev => ({...prev, voiceName: v.id}))}
                      className={`p-2 rounded text-xs font-bold transition-all relative h-9 flex items-center justify-center text-center leading-tight ${config.voiceName === v.id ? 'bg-green-600 text-white' : 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'}`}
                    >
                      <span className="truncate w-full">{v.label}</span>
                      {v.recommended && (
                        <span className="absolute -top-1 -right-1 bg-blue-500 text-white text-[8px] px-1 rounded-sm">TOP</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-zinc-500 text-xs uppercase tracking-wider mb-2 text-center">♀ Female</div>
                <div className="flex flex-col gap-2">
                  {FEMALE_VOICES.map((v) => (
                    <button 
                      key={v.id}
                      data-testid={`button-voice-${v.id}`}
                      onClick={() => setConfig(prev => ({...prev, voiceName: v.id}))}
                      className={`p-2 rounded text-xs font-bold transition-all relative h-9 flex items-center justify-center text-center leading-tight ${config.voiceName === v.id ? 'bg-green-600 text-white' : 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'}`}
                    >
                      <span className="truncate w-full">{v.label}</span>
                      {v.recommended && (
                        <span className="absolute -top-1 -right-1 bg-blue-500 text-white text-[8px] px-1 rounded-sm">TOP</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
           </div>
        </div>

        <div className="bg-zinc-900 p-4 rounded-lg border border-zinc-800 col-span-2">
          <div className="flex items-center justify-between">
            <div className="flex flex-col text-left">
              <span className="text-white text-sm">Funny Mode</span>
              <span className="text-zinc-500 text-xs">Add a fun personality to translations</span>
            </div>
            <select
              data-testid="select-funny-mode"
              value={config.funnyMode}
              onChange={(e) => setConfig(prev => ({ ...prev, funnyMode: e.target.value as FunnyMode }))}
              className="bg-zinc-800 text-white px-3 py-2 rounded border border-zinc-700 focus:border-green-500 focus:outline-none text-sm max-w-[180px]"
            >
              <option value="off">Off (Default)</option>
              <option value="random">Random</option>
              <option value="Dramatic">Dramatic</option>
              <option value="Clickbait">Clickbait</option>
              <option value="Opposite">Opposite</option>
              <option value="Rambling">Rambling</option>
              <option value="Professor">Professor</option>
            </select>
          </div>
          <p className="text-zinc-500 text-xs mt-2">
            {config.funnyMode === 'off' && ''}
            {config.funnyMode === 'random' && '→ New personality is chosen each session from all available modes.'}
            {config.funnyMode === 'Dramatic' && '→ Telenovela style with extreme emotions.'}
            {config.funnyMode === 'Clickbait' && '→ OMG! Everything is sensational!'}
            {config.funnyMode === 'Opposite' && '→ Lie mode - says the opposite of what was said.'}
            {config.funnyMode === 'Rambling' && '→ Long, winding sentences before getting to the point.'}
            {config.funnyMode === 'Professor' && '→ Obscure scholarly vocabulary, nearly incomprehensible.'}
          </p>
        </div>

        <div className="col-span-2">
          <button
            data-testid="toggle-advanced-settings"
            onClick={() => setAdvancedOpen(!advancedOpen)}
            className="w-full flex items-center justify-between p-4 bg-zinc-800/50 rounded-lg border border-zinc-700 hover:bg-zinc-800 transition-colors"
          >
            <span className="text-zinc-300 font-bold">Advanced Settings</span>
            <svg 
              className={`w-5 h-5 text-zinc-400 transition-transform ${advancedOpen ? 'rotate-180' : ''}`} 
              fill="none" 
              stroke="currentColor" 
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>

        {advancedOpen && (
          <>
            <div className="bg-zinc-900 p-4 rounded-lg border border-zinc-800 col-span-2">
              <div className="flex justify-between items-center mb-1">
                <p className="text-zinc-500">Time to First Response</p>
                <p className="text-green-400 font-mono">
                  {latency > 0 ? `${latency}ms` : '--'}
                </p>
              </div>
              <p className="text-zinc-600 text-[10px] mb-2">Last audio sent → First response audio</p>
              <div className="flex justify-between items-center mb-1">
                <p className="text-zinc-500">Network RTT</p>
                <p className={`font-mono ${getPingColor()}`}>
                  {ping > 0 ? `${ping}ms` : '--'}
                </p>
              </div>
              <p className="text-zinc-600 text-[10px]">WebSocket Ping</p>
            </div>

            <div className="bg-zinc-900 p-4 rounded-lg border border-zinc-800 col-span-2">
              <label className="text-zinc-400 block mb-3">Start Sensitivity</label>
              <div className="flex items-center justify-between">
                <div className="flex flex-col">
                  <span className="text-white text-sm">Speech Detection Sensitivity</span>
                  <span className="text-zinc-500 text-xs">Sensitivity for speech start. Default: Low</span>
                </div>
                <div className="flex gap-1">
                  {(['low', 'high'] as const).map((level) => (
                    <button
                      key={level}
                      data-testid={`button-vad-sensitivity-${level}`}
                      onClick={() => setConfig(prev => ({ ...prev, vadStartSensitivity: level }))}
                      className={`px-3 h-8 rounded text-xs font-bold transition-all ${
                        config.vadStartSensitivity === level 
                          ? 'bg-green-600 text-white' 
                          : 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'
                      }`}
                    >
                      {level === 'low' ? 'Low' : 'High'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="bg-zinc-900 p-4 rounded-lg border border-zinc-800 col-span-2">
              <div className="flex justify-between mb-2">
                <div className="flex flex-col">
                  <label className="text-zinc-400">Input Buffer Size <span className="text-zinc-600 text-xs">(Default: 960 = 20ms)</span></label>
                  <span className="text-zinc-500 text-xs">Samples per audio chunk at 48kHz. Lower = less latency, higher = more stable</span>
                </div>
                <span className="text-white font-bold font-mono">{config.inputBufferSize} <span className="text-zinc-500 text-xs">({(config.inputBufferSize / 48).toFixed(1)}ms)</span></span>
              </div>
              <div className="flex gap-2 mt-2">
                {[
                  { value: 768, label: '768', sublabel: '16ms', top: false },
                  { value: 960, label: '960', sublabel: '20ms', top: true },
                  { value: 1152, label: '1152', sublabel: '24ms', top: false },
                  { value: 1920, label: '1920', sublabel: '40ms', top: false },
                ].map((opt) => (
                  <button
                    key={opt.value}
                    data-testid={`button-buffer-size-${opt.value}`}
                    onClick={() => setConfig(prev => ({ ...prev, inputBufferSize: opt.value }))}
                    className={`flex-1 py-2 px-1 rounded text-xs font-bold transition-all flex flex-col items-center relative ${
                      config.inputBufferSize === opt.value 
                        ? 'bg-blue-600 text-white' 
                        : 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'
                    }`}
                  >
                    {opt.top && (
                      <span className="absolute -top-1 -right-1 bg-blue-500 text-white text-[8px] px-1 rounded-sm">TOP</span>
                    )}
                    <span>{opt.label}</span>
                    <span className="text-[10px] opacity-70">{opt.sublabel}</span>
                  </button>
                ))}
              </div>
              <p className="text-zinc-600 text-[10px] mt-2">
                On mobile networks, values other than 20ms and 40ms may introduce additional latency.
              </p>
            </div>

            <div className="bg-zinc-900 p-4 rounded-lg border border-zinc-800 col-span-2">
              <div className="flex justify-between items-center mb-2">
                <div className="flex flex-col text-left">
                  <label className="text-zinc-400 flex items-center gap-2">
                    Context Window Trigger
                    <span className="text-zinc-600 text-xs">(Default: 0)</span>
                    <span className="bg-amber-500/20 text-amber-400 text-[9px] font-bold px-1.5 py-0.5 rounded border border-amber-500/40 tracking-wide">ALPHA</span>
                  </label>
                  <span className="text-zinc-500 text-xs">Compresses context above this token threshold (≈ 25 tok/s audio). Keeps latency low during long sessions. 0 = off.</span>
                </div>
                <input 
                  type="number"
                  min="0"
                  max="1000000"
                  value={config.triggerTokens} 
                  onChange={(e) => setConfig(prev => ({ ...prev, triggerTokens: Math.max(0, parseInt(e.target.value) || 0) }))}
                  className="w-24 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-white font-mono text-sm focus:outline-none focus:border-blue-500"
                  data-testid="input-trigger-tokens"
                />
              </div>
            </div>

            <div className="bg-zinc-900 p-4 rounded-lg border border-zinc-800 col-span-2">
              <label className="text-zinc-400 block mb-3">
                Voice Activity Detection (VAD)
              </label>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="text-sm text-zinc-500">Prefix Padding</span>
                    <span className="text-zinc-600 text-xs">Delay before speech start (0–500ms). Default: 50ms</span>
                  </div>
                  <input
                    data-testid="input-vad-prefix"
                    type="number"
                    min="0"
                    max="500"
                    step="10"
                    disabled
                    value={config.vadPrefixPaddingMs}
                    onChange={(e) => {
                      const val = parseInt(e.target.value);
                      if (!isNaN(val)) setConfig(prev => ({ ...prev, vadPrefixPaddingMs: val }));
                    }}
                    onBlur={(e) => {
                      const val = parseInt(e.target.value);
                      const clamped = isNaN(val) ? 0 : Math.min(500, Math.max(0, val));
                      setConfig(prev => ({ ...prev, vadPrefixPaddingMs: clamped }));
                    }}
                    className="w-20 h-8 text-center px-2 rounded border font-mono bg-zinc-900 text-zinc-600 border-zinc-800 cursor-not-allowed opacity-50"
                  />
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="text-sm text-zinc-500">Silence Duration</span>
                    <span className="text-zinc-600 text-xs">Pause to end turn (50-2000ms). Default: 300ms</span>
                  </div>
                  <input
                    data-testid="input-vad-silence"
                    type="number"
                    min="50"
                    max="2000"
                    step="50"
                    disabled
                    value={config.vadSilenceDurationMs}
                    onChange={(e) => {
                      const val = parseInt(e.target.value);
                      if (!isNaN(val)) setConfig(prev => ({ ...prev, vadSilenceDurationMs: val }));
                    }}
                    onBlur={(e) => {
                      const val = parseInt(e.target.value);
                      const clamped = isNaN(val) ? 300 : Math.min(2000, Math.max(50, val));
                      setConfig(prev => ({ ...prev, vadSilenceDurationMs: clamped }));
                    }}
                    className="w-20 h-8 text-center px-2 rounded border font-mono bg-zinc-900 text-zinc-600 border-zinc-800 cursor-not-allowed opacity-50"
                  />
                </div>
              </div>
              <p className="text-zinc-700 text-xs mt-2">These settings are currently inactive and have been disabled.</p>
            </div>

            <div className="bg-zinc-900 p-4 rounded-lg border border-zinc-800 col-span-2">
                <div className="flex justify-between mb-2">
                    <div className="flex flex-col">
                      <label className="text-zinc-400">Output Gain (Speaker)</label>
                      <span className="text-zinc-600 text-xs">Default: 125%</span>
                    </div>
                    <span className="text-white font-bold">{Math.round((config.outputGain / 2) * 100)}%</span>
                </div>
                <input 
                    type="range" min="0.5" max="3.0" step="0.1" 
                    value={config.outputGain} 
                    onChange={(e) => updateOutputGain(e.target.value)}
                    className="w-full accent-green-500 h-2 bg-zinc-700 rounded-lg appearance-none cursor-pointer"
                    data-testid="slider-output-gain"
                />
            </div>

            <div className="bg-zinc-900 p-4 rounded-lg border border-zinc-800 col-span-2">
                <div className="flex justify-between mb-2">
                    <label className="text-zinc-400">Soft Clipping <span className="text-zinc-600 text-xs">(Default: 1.5)</span></label>
                    <span className="text-white font-bold">{config.softClipDrive.toFixed(1)}</span>
                </div>
                <input 
                    type="range" min="1.0" max="3.0" step="0.1" 
                    value={config.softClipDrive} 
                    onChange={(e) => updateSoftClipDrive(e.target.value)}
                    className="w-full accent-blue-500 h-2 bg-zinc-700 rounded-lg appearance-none cursor-pointer"
                    data-testid="slider-soft-clip-drive"
                />
                <p className="text-zinc-600 text-[10px] mt-1">Saturation curve to avoid digital clipping (1.0 = linear, 3.0 = strong)</p>
            </div>

            <div className="bg-zinc-900 p-4 rounded-lg border border-zinc-800 col-span-2">
              <label className="text-zinc-400 block mb-2">Model</label>
              <input
                data-testid="input-model-name"
                type="text"
                value={config.modelName}
                onChange={(e) => setConfig(prev => ({ ...prev, modelName: e.target.value }))}
                placeholder="gemini-3.1-flash-live-preview"
                className="w-full bg-black text-white p-3 rounded border border-zinc-700 focus:border-green-500 focus:outline-none font-mono text-xs"
              />
              <p className="text-zinc-600 text-xs mt-2">
                Gemini Live API model ID. Default: gemini-3.1-flash-live-preview
              </p>
            </div>

            <div className="bg-zinc-900 p-4 rounded-lg border border-zinc-800 col-span-2">
                <div className="flex justify-between mb-2">
                    <label className="text-zinc-400">System Prompt</label>
                    {customPrompt && (
                      <button 
                        onClick={() => setCustomPrompt('')}
                        className="text-xs text-zinc-500 hover:text-white"
                      >
                        Reset
                      </button>
                    )}
                </div>
                <textarea 
                    data-testid="textarea-system-prompt"
                    value={displayPrompt}
                    onChange={(e) => setCustomPrompt(e.target.value)}
                    maxLength={800}
                    className="w-full h-32 bg-black text-xs text-zinc-300 p-3 rounded border border-zinc-700 focus:border-green-500 focus:outline-none font-mono leading-relaxed"
                    placeholder="Enter AI instructions here..."
                />
                <p className="text-zinc-500 text-[10px] mt-2">
                  Placeholders: <code className="text-zinc-400">{'{source}'}</code> = Source language, <code className="text-zinc-400">{'{target}'}</code> = Target language
                </p>
            </div>

            <div className="bg-zinc-900 p-4 rounded-lg border border-zinc-800 col-span-2">
              <label className="text-zinc-400 block mb-3">Model Settings</label>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex flex-col text-left">
                    <span className="text-white text-sm">Temperature</span>
                    <span className="text-zinc-500 text-xs">
                      Creativity (0 = precise, 2 = creative) · Default: 0.7 · Comma or period accepted
                    </span>
                    {tempError && (
                      <span className="text-red-400 text-xs mt-0.5">Enter a value between 0 and 2 (e.g. 0.3 or 0,3)</span>
                    )}
                  </div>
                  <input
                    data-testid="input-temperature"
                    type="text"
                    inputMode="decimal"
                    value={tempStr}
                    onChange={(e) => {
                      const raw = e.target.value;
                      setTempStr(raw);
                      // Normalise: replace comma with period so parseFloat works
                      const normalised = raw.replace(',', '.');
                      const val = parseFloat(normalised);
                      if (!isNaN(val) && val >= 0 && val <= 2) {
                        setTempError(false);
                        setConfig(prev => ({ ...prev, temperature: val }));
                      } else {
                        setTempError(raw !== '' && raw !== '.' && raw !== ',');
                      }
                    }}
                    onBlur={() => {
                      const normalised = tempStr.replace(',', '.');
                      const val = parseFloat(normalised);
                      if (isNaN(val) || val < 0 || val > 2) {
                        // Revert to last valid value
                        setTempStr(String(config.temperature));
                        setTempError(false);
                      } else {
                        const clamped = Math.min(2, Math.max(0, val));
                        setTempStr(String(clamped));
                        setTempError(false);
                        setConfig(prev => ({ ...prev, temperature: clamped }));
                      }
                    }}
                    className={`w-20 h-8 bg-black text-white text-center px-2 rounded border focus:outline-none font-mono ${tempError ? 'border-red-500 focus:border-red-500' : 'border-zinc-700 focus:border-green-500'}`}
                  />
                </div>
              </div>
            </div>

            <div className="bg-zinc-900 p-4 rounded-lg border border-zinc-800 col-span-2 flex items-center justify-between">
              <div className="flex flex-col text-left">
                <span className="text-white text-lg">Auto Gain Control</span>
                <span className="text-zinc-500 text-xs">Automatic microphone level adjustment (Default: Off)</span>
              </div>
              <button
                data-testid="toggle-auto-gain"
                onClick={() => setConfig(prev => ({ ...prev, autoGainControl: !prev.autoGainControl }))}
                className={`w-14 h-8 rounded-full transition-colors relative flex-shrink-0 ${
                  config.autoGainControl ? 'bg-green-500' : 'bg-zinc-600'
                }`}
              >
                <div
                  className={`absolute top-1 w-6 h-6 bg-white rounded-full transition-transform ${
                    config.autoGainControl ? 'left-7' : 'left-1'
                  }`}
                />
              </button>
            </div>

            <div className="bg-zinc-900 p-4 rounded-lg border border-zinc-800 col-span-2 flex items-center justify-between">
              <div className="flex flex-col text-left">
                <span className="text-white text-lg">Noise Suppression</span>
                <span className="text-zinc-500 text-xs">Browser noise reduction (Default: Off)</span>
              </div>
              <button
                data-testid="toggle-noise-suppression"
                onClick={() => setConfig(prev => ({ ...prev, noiseSuppression: !prev.noiseSuppression }))}
                className={`w-14 h-8 rounded-full transition-colors relative flex-shrink-0 ${
                  config.noiseSuppression ? 'bg-green-500' : 'bg-zinc-600'
                }`}
              >
                <div
                  className={`absolute top-1 w-6 h-6 bg-white rounded-full transition-transform ${
                    config.noiseSuppression ? 'left-7' : 'left-1'
                  }`}
                />
              </button>
            </div>

            <div className="bg-zinc-900 p-4 rounded-lg border border-zinc-800 col-span-2">
              <div className="flex items-center justify-between mb-3">
                <div className="flex flex-col">
                  <span className="text-white text-lg">Logging</span>
                  <span className="text-zinc-500 text-xs">Collect logs for debugging (Default: Off)</span>
                </div>
                <button
                  data-testid="toggle-debug-info"
                  onClick={() => setConfig(prev => ({ ...prev, showDebugInfo: !prev.showDebugInfo }))}
                  className={`w-14 h-8 rounded-full transition-colors relative flex-shrink-0 ${
                    config.showDebugInfo ? 'bg-blue-500' : 'bg-zinc-600'
                  }`}
                >
                  <div
                    className={`absolute top-1 w-6 h-6 bg-white rounded-full transition-transform ${
                      config.showDebugInfo ? 'left-7' : 'left-1'
                    }`}
                  />
                </button>
              </div>
              {config.showDebugInfo && (
                <div className="flex gap-2">
                  <button
                    data-testid="button-copy-logs"
                    onClick={() => {
                      const current = logger.exportLogs(400_000);
                      const prev = logger.getPreviousSessionLog();
                      const combined = prev
                        ? `${current}\n\n${'─'.repeat(60)}\nLETZTE SITZUNG\n${'─'.repeat(60)}\n${prev}`
                        : current;
                      navigator.clipboard.writeText(combined).then(() => {
                        setCopyStatus('ok');
                        setTimeout(() => setCopyStatus('idle'), 2500);
                      }).catch(() => {
                        setCopyStatus('fail');
                        setTimeout(() => setCopyStatus('idle'), 2500);
                      });
                    }}
                    className={`flex-1 px-3 py-2 text-xs font-bold rounded border transition-colors ${
                      copyStatus === 'ok'
                        ? 'bg-green-600/20 text-green-400 border-green-600/50'
                        : copyStatus === 'fail'
                        ? 'bg-red-600/20 text-red-400 border-red-600/50'
                        : 'bg-blue-600/20 text-blue-400 border-blue-600/50 hover:bg-blue-600/40'
                    }`}
                  >
                    {copyStatus === 'ok'
                      ? '✓ Copied'
                      : copyStatus === 'fail'
                      ? '✗ Error'
                      : logger.hasPreviousSessionLog()
                      ? 'Copy Logs (+ last session)'
                      : 'Copy Logs'}
                  </button>
                  <button
                    data-testid="button-clear-logs"
                    onClick={() => logger.clearBuffer()}
                    className="px-3 py-2 bg-zinc-700 text-zinc-300 text-xs font-bold rounded border border-zinc-600 hover:bg-zinc-600 transition-colors"
                  >
                    Clear
                  </button>
                </div>
              )}
            </div>

            <div className="bg-zinc-900 p-4 rounded-lg border border-zinc-800 col-span-2">
              <div className="flex items-center justify-between mb-3">
                <div className="flex flex-col">
                  <span className="text-white text-lg">Audio Test Mode</span>
                  <span className="text-zinc-500 text-xs leading-snug">Record 5s and play back what Gemini would hear</span>
                </div>
                <button
                  data-testid="toggle-audio-test-mode"
                  onClick={() => setConfig(prev => ({ ...prev, audioTestMode: !prev.audioTestMode }))}
                  className={`w-14 h-8 rounded-full transition-colors relative flex-shrink-0 ${
                    config.audioTestMode ? 'bg-orange-500' : 'bg-zinc-600'
                  }`}
                >
                  <div
                    className={`absolute top-1 w-6 h-6 bg-white rounded-full transition-transform ${
                      config.audioTestMode ? 'left-7' : 'left-1'
                    }`}
                  />
                </button>
              </div>
              {config.audioTestMode && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-zinc-400">Status:</span>
                    <span className={`font-mono ${audioTestReady ? 'text-green-400' : isConnected ? 'text-yellow-400' : 'text-zinc-500'}`}>
                      {isPlayingTestAudio ? 'Playing...' : audioTestReady ? 'Ready (5s recorded)' : isConnected ? 'Recording...' : 'Not started'}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <button
                      data-testid="button-play-test-audio"
                      onClick={() => {
                        if (!isConnected && !audioTestReady) {
                          toast({
                            title: "Session not started",
                            description: "Please start the session before recording audio.",
                            variant: "destructive"
                          });
                          return;
                        }
                        playTestAudio?.();
                      }}
                      disabled={isPlayingTestAudio || (isConnected && !audioTestReady)}
                      className={`flex-1 px-3 py-2 text-xs font-bold rounded border transition-colors ${
                        isPlayingTestAudio || (isConnected && !audioTestReady)
                          ? 'bg-zinc-700 text-zinc-500 border-zinc-600 cursor-not-allowed'
                          : audioTestReady
                            ? 'bg-green-600/20 text-green-400 border-green-600/50 hover:bg-green-600/40'
                            : 'bg-blue-600/20 text-blue-400 border-blue-600/50 hover:bg-blue-600/40'
                      }`}
                    >
                      {isPlayingTestAudio ? 'Playing...' : audioTestReady ? 'Play Recording' : isConnected ? 'Recording...' : 'Start Recording'}
                    </button>
                    <button
                      data-testid="button-clear-test-audio"
                      onClick={clearTestBuffer}
                      disabled={isPlayingTestAudio}
                      className="px-3 py-2 bg-zinc-700 text-zinc-300 text-xs font-bold rounded border border-zinc-600 hover:bg-zinc-600 transition-colors disabled:opacity-50"
                    >
                      Clear
                    </button>
                  </div>
                  <p className="text-orange-400/80 text-[10px] italic border-t border-zinc-800/50 pt-2">
                    Audio will NOT be sent to Gemini while test mode is active. Mic auto-mutes during playback.
                  </p>
                </div>
              )}
            </div>

            <div className="bg-zinc-900/50 p-4 rounded-lg border border-zinc-800 col-span-2 text-center">
              <button
                data-testid="button-reset-advanced"
                onClick={resetAdvancedSettings}
                disabled={isResetting}
                className={`mt-1 px-4 py-2 text-xs font-bold rounded border transition-colors mb-2 flex items-center gap-2 mx-auto ${
                  isResetting
                    ? 'bg-red-600/10 text-red-600/50 border-red-600/20 cursor-not-allowed'
                    : 'bg-red-600/20 text-red-400 border-red-600/50 hover:bg-red-600/40'
                }`}
              >
                {isResetting && (
                  <div className="w-3 h-3 border-2 border-red-400/50 border-t-transparent rounded-full animate-spin" />
                )}
                {isResetting ? 'Resetting…' : 'Reset Settings & Cache'}
              </button>
              <p className="text-zinc-600 text-[10px] mt-1">
                Resets model, prompt, temperature, VAD, noise suppression, and context settings.
              </p>
            </div>
          </>
        )}
      </div>

      <button
        data-testid="button-close-settings"
        onClick={handleClose}
        disabled={!hasApiKey}
        className={`mt-2 mb-6 px-8 py-3 font-bold rounded-full transition-all shrink-0 ${
          hasApiKey 
            ? 'bg-white text-black hover:bg-zinc-200 active:scale-95' 
            : 'bg-zinc-700 text-zinc-500 cursor-not-allowed'
        }`}
      >
        {hasApiKey ? 'SAVE' : 'Enter API Key to continue'}
      </button>

      <div className="text-center mb-8 shrink-0">
        <div className="flex items-center justify-center gap-4 mb-3">
          <button
            onClick={() => setShowImpressum(true)}
            className="text-zinc-500 hover:text-blue-400 text-xs transition-colors"
            data-testid="link-impressum"
          >
            Legal Notice
          </button>
          <span className="text-zinc-700">|</span>
          <button
            onClick={() => setShowDatenschutz(true)}
            className="text-zinc-500 hover:text-blue-400 text-xs transition-colors"
            data-testid="link-datenschutz"
          >
            Privacy Policy
          </button>
        </div>
        <p className="text-zinc-300 font-mono text-xs" data-testid="text-app-version">Native Translator v{appVersion}</p>
        <p className="text-zinc-600 text-[10px] mt-1 uppercase tracking-widest">© 2026 Ilyas Demir</p>
      </div>

      {helpModalOpen && helpContent[helpModalOpen] && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-zinc-900 border border-zinc-700 rounded-lg max-w-sm w-full p-5 relative shadow-xl">
            <button
              data-testid="button-close-help-modal"
              onClick={() => setHelpModalOpen(null)}
              className="absolute top-3 right-3 text-zinc-500 hover:text-white transition-colors"
              aria-label="Hilfe schließen"
            >
              <X className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 mb-3">
              <HelpCircle className="w-5 h-5 text-blue-400" />
              <h3 className="text-white font-bold text-lg">{helpContent[helpModalOpen].title}</h3>
            </div>
            <p className="text-zinc-300 text-sm leading-relaxed">
              {helpContent[helpModalOpen].description}
            </p>
            <button
              data-testid="button-ok-help-modal"
              onClick={() => setHelpModalOpen(null)}
              className="mt-4 w-full py-2 bg-blue-600 text-white text-sm font-bold rounded hover:bg-blue-500 transition-colors"
            >
              Verstanden
            </button>
          </div>
        </div>
      )}
    </div>
    </>
  );
};

export default SettingsOverlay;
