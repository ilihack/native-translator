/**
 * RAF-based VU meter hook that reads peak/clipping data written by the
 * AudioWorklet recorder and batches React state updates to 20 FPS.
 * Exposes mutable refs so the worklet message handler (in useLiveSession)
 * can write raw values without triggering re-renders on every audio frame.
 * @inputs None — creates its own refs internally
 * @exports inputPeakLevel, inputClipping state + refs for worklet to write
 */
import { useState, useEffect, useRef, MutableRefObject } from 'react';

/** Target frame-rate for VU meter updates (20 FPS = one update per 50 ms). */
const LEVEL_UPDATE_INTERVAL = 50;

interface UseAudioLevelMeterReturn {
  /** Smoothed peak level [0..1] for the input VU bar — updated at 20 FPS. */
  inputPeakLevel: number;
  /** True when the input signal is clipping (abs value ≥ 1.0). */
  inputClipping: boolean;
  /** Write raw peak here from the worklet message handler (never triggers render). */
  inputPeakLevelRef: MutableRefObject<number>;
  /** Write raw clipping flag here from the worklet message handler. */
  inputClippingRef: MutableRefObject<boolean>;
}

export function useAudioLevelMeter(): UseAudioLevelMeterReturn {
  const [inputPeakLevel, setInputPeakLevel] = useState(0);
  const [inputClipping, setInputClipping] = useState(false);

  const inputPeakLevelRef = useRef(0);
  const inputClippingRef = useRef(false);
  const levelUpdateRafRef = useRef<number | null>(null);
  const lastLevelUpdateRef = useRef<number>(0);
  const lastDisplayedPeakRef = useRef(0);
  const lastDisplayedClippingRef = useRef(false);

  useEffect(() => {
    const updateLevels = () => {
      const now = performance.now();
      if (now - lastLevelUpdateRef.current >= LEVEL_UPDATE_INTERVAL) {
        lastLevelUpdateRef.current = now;
        const currentPeak = inputPeakLevelRef.current;
        const currentClipping = inputClippingRef.current;
        if (currentPeak !== lastDisplayedPeakRef.current) {
          lastDisplayedPeakRef.current = currentPeak;
          setInputPeakLevel(currentPeak);
        }
        if (currentClipping !== lastDisplayedClippingRef.current) {
          lastDisplayedClippingRef.current = currentClipping;
          setInputClipping(currentClipping);
        }
      }
      levelUpdateRafRef.current = requestAnimationFrame(updateLevels);
    };

    levelUpdateRafRef.current = requestAnimationFrame(updateLevels);
    return () => {
      if (levelUpdateRafRef.current) {
        cancelAnimationFrame(levelUpdateRafRef.current);
        levelUpdateRafRef.current = null;
      }
    };
  }, []);

  return { inputPeakLevel, inputClipping, inputPeakLevelRef, inputClippingRef };
}
