/**
 * Animated circular audio visualizer displaying real-time microphone/speaker levels.
 * Renders concentric rings with dynamic scaling based on audio amplitude and connection state.
 * @inputs audioLevel, speakerLevel, connectionStatus, isSpeaking flag
 * @exports Default Visualizer component
 */

import { memo, useEffect, useRef, useState } from 'react';
import { ConnectionStatus } from '../types';
import { Mic, MicOff, Volume2 } from 'lucide-react';

interface VisualizerProps {
  status: ConnectionStatus;
  isTurnFinished: boolean;
  hasInteracted: boolean;
  inputAnalyserRef: React.MutableRefObject<AnalyserNode | null>;
  outputAnalyserRef: React.MutableRefObject<AnalyserNode | null>;
  isMicLocked: boolean;
  isInputMuted: boolean;
  onToggleInputMute: () => void;
}

const COLORS = {
  listening: 'hsl(142, 71%, 45%)',
  speaking: 'hsl(38, 92%, 50%)',
  error: 'hsl(0, 84%, 60%)',
  muted: 'hsl(0, 84%, 60%)',
  glowListening: 'rgba(34, 197, 94',
  glowSpeaking: 'rgba(245, 158, 11',
  glowError: 'rgba(239, 68, 68',
  glowMuted: 'rgba(239, 68, 68',
};

const Visualizer: React.FC<VisualizerProps> = ({
  status,
  isTurnFinished,
  hasInteracted,
  inputAnalyserRef,
  outputAnalyserRef,
  isMicLocked,
  isInputMuted,
  onToggleInputMute,
}) => {
  const barRefs = useRef<(HTMLDivElement | null)[]>([]);
  const animationFrameRef = useRef<number>(0);
  const [showStatusIcon, setShowStatusIcon] = useState(false);
  const hideTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Handle icon visibility for mute toggle
  useEffect(() => {
    setShowStatusIcon(true);
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    
    // Only auto-hide if NOT muted (i.e., we just unmuted)
    if (!isInputMuted) {
      hideTimeoutRef.current = setTimeout(() => {
        setShowStatusIcon(false);
      }, 2000);
    }

    return () => {
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    };
  }, [isInputMuted]);

  useEffect(() => {
    // Set CSS transition ONCE per mode change — never inside the RAF loop.
    // isMicLocked (speaking) uses a slower height transition for a smoother wave effect.
    const transition = isMicLocked
      ? 'height 0.1s ease-out, background-color 0.3s'
      : 'height 0.05s ease-out, background-color 0.3s';
    barRefs.current.forEach((bar) => { if (bar) bar.style.transition = transition; });

    // Pre-allocate frequency data arrays once per effect lifetime (not per frame)
    const dataArrayInput  = new Uint8Array(32);
    const dataArrayOutput = new Uint8Array(32);

    // Per-bar style caches — skip DOM write when computed value is unchanged
    const lastHeight    = new Array<number>(7).fill(-1);
    const lastOpacity   = new Array<number>(7).fill(-1);
    const lastBgColor   = new Array<string>(7).fill('');
    const lastBoxShadow = new Array<string>(7).fill('');

    // Constant speaking-mode shadow — pre-built once, avoids string allocation per frame
    const SHADOW_SPEAKING = `0 0 15px ${COLORS.glowSpeaking}, 0.6)`;

    // animate receives the RAF DOMHighResTimeStamp for free — no Date.now() overhead
    const animate = (timestamp: number) => {
      let inputVol = 0;
      let outputVol = 0;

      if (inputAnalyserRef.current && !isInputMuted) {
        inputAnalyserRef.current.getByteFrequencyData(dataArrayInput);
        let sum = 0;
        for (let i = 0; i < dataArrayInput.length; i++) sum += dataArrayInput[i];
        inputVol = sum / dataArrayInput.length / 255;
      }

      if (outputAnalyserRef.current) {
        outputAnalyserRef.current.getByteFrequencyData(dataArrayOutput);
        let sum = 0;
        for (let i = 0; i < dataArrayOutput.length; i++) sum += dataArrayOutput[i];
        outputVol = sum / dataArrayOutput.length / 255;
      }

      const combinedActivity = isMicLocked
        ? Math.max(outputVol, 0.4 + Math.sin(timestamp / 200) * 0.1)
        : Math.max(inputVol, 0.1);

      const isAlive = isTurnFinished || (hasInteracted && status === ConnectionStatus.DISCONNECTED);
      const isError = status === ConnectionStatus.ERROR;

      barRefs.current.forEach((bar, i) => {
        if (!bar) return;

        let targetHeight: number;
        let bgColor: string;
        let opacity: number;
        let boxShadow: string;

        if (isMicLocked) {
          const waveHeight = (Math.sin(timestamp / 300 + i * 0.5) + 1) * 0.5;
          targetHeight = Math.min(100, 20 + waveHeight * 40 + outputVol * 40);
          bgColor    = COLORS.speaking;
          opacity    = 1;
          boxShadow  = SHADOW_SPEAKING;
        } else {
          const waveFactor     = 1 - Math.abs(3 - i) * 0.1;
          const idlePulse      = isAlive ? Math.sin(timestamp / 500) * 0.05 + 0.1 : 0;
          const adjustedActivity = isInputMuted ? 0 : Math.max(0, combinedActivity - 0.08);
          const displayActivity  = Math.max(Math.pow(adjustedActivity, 0.5) * 2.0, idlePulse);

          targetHeight = 5 + displayActivity * 120 * waveFactor;
          if (adjustedActivity > 0.02) targetHeight += Math.random() * 15;
          targetHeight = Math.min(100, Math.max(5, targetHeight));

          bgColor  = isInputMuted ? COLORS.muted : (isError ? COLORS.error : COLORS.listening);
          opacity  = Math.max(0.3, displayActivity + 0.3);

          const glowIntensity = isAlive ? Math.max(0.5, displayActivity) : 0;
          const glowColor     = isInputMuted ? COLORS.glowMuted : (isError ? COLORS.glowError : COLORS.glowListening);
          // Round intensity to 2-digit steps → many frames share the same string → fewer allocs
          boxShadow = glowIntensity > 0
            ? `0 0 ${Math.round(glowIntensity * 20)}px ${glowColor}, ${(Math.round(glowIntensity * 50) / 50).toFixed(2)})`
            : 'none';
        }

        // Write to DOM only when the computed value differs from the last written value
        const h = Math.round(targetHeight * 10) / 10;
        if (lastHeight[i] !== h)    { bar.style.height = `${h}%`; lastHeight[i] = h; }
        if (lastBgColor[i] !== bgColor) { bar.style.backgroundColor = bgColor; lastBgColor[i] = bgColor; }
        const op = Math.round(opacity * 100) / 100;
        if (lastOpacity[i] !== op)  { bar.style.opacity = String(op); lastOpacity[i] = op; }
        if (lastBoxShadow[i] !== boxShadow) { bar.style.boxShadow = boxShadow; lastBoxShadow[i] = boxShadow; }
      });

      animationFrameRef.current = requestAnimationFrame(animate);
    };

    animationFrameRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationFrameRef.current);
  }, [status, isTurnFinished, hasInteracted, inputAnalyserRef, outputAnalyserRef, isMicLocked, isInputMuted]);

  if (!hasInteracted || status !== ConnectionStatus.CONNECTED) {
      return null; 
  }

  const muteLabel = isInputMuted ? 'Mikrofon aktivieren' : 'Mikrofon stummschalten';

  return (
    <div 
      className="flex items-center justify-center gap-1.5 h-16 w-52 relative cursor-pointer group"
      onClick={onToggleInputMute}
      role="button"
      tabIndex={0}
      aria-label={muteLabel}
      aria-pressed={isInputMuted}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggleInputMute();
        }
      }}
      data-testid="button-mute-input"
    >
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <div
          key={i}
          ref={(el) => {
            barRefs.current[i] = el;
          }}
          className="w-2 rounded-full"
          style={{ height: '10%', opacity: 0.3 }}
          aria-hidden="true"
        />
      ))}
      
      {(showStatusIcon || isMicLocked) && (
        <div 
          className="absolute inset-0 flex items-center justify-center animate-in fade-in zoom-in duration-200"
          aria-hidden="true"
        >
          <div className={`p-1.5 rounded-full backdrop-blur-sm ${
            isMicLocked 
              ? 'bg-amber-500/20 text-amber-500' 
              : isInputMuted 
                ? 'bg-destructive/20 text-destructive' 
                : 'bg-green-500/20 text-green-500'
          }`}>
            {isMicLocked 
              ? <Volume2 className="w-5 h-5" /> 
              : isInputMuted 
                ? <MicOff className="w-5 h-5" /> 
                : <Mic className="w-5 h-5" />
            }
          </div>
        </div>
      )}
    </div>
  );
};

// memo: prevents re-renders from parent's 20 FPS inputPeakLevel state updates.
// Visualizer reads audio levels via AnalyserNode refs in its own RAF loop,
// so it only needs to re-render when its display-relevant props change.
export default memo(Visualizer);
