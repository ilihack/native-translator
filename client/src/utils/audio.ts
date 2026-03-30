/**
 * Audio utility functions for PCM encoding/decoding: base64-to-Int16 decode,
 * Int16-to-Blob conversion, peak level measurement, and signal tone generation.
 * Uses pooled buffers to minimize GC pressure during real-time streaming.
 * @exports decode, createBlobFromInt16, calculatePeakFromInt16, playSignalTone
 */
import { logger } from './logger';

const pcmBufferPool = {
  buffer: null as ArrayBuffer | null,
  dataView: null as DataView | null,
  uint8: null as Uint8Array | null,
  maxSize: 0,
  
  acquire(size: number): { dataView: DataView; uint8: Uint8Array } {
    const byteSize = size * 2;
    if (byteSize > this.maxSize || !this.buffer || !this.dataView || !this.uint8) {
      this.maxSize = Math.max(byteSize, 2048);
      this.buffer = new ArrayBuffer(this.maxSize);
      this.dataView = new DataView(this.buffer);
      this.uint8 = new Uint8Array(this.buffer);
    }
    return { dataView: this.dataView, uint8: this.uint8 };
  }
};

const decodePool = {
  buffer: null as Uint8Array | null,
  maxSize: 0,
  
  acquire(size: number): Uint8Array {
    if (size > this.maxSize || !this.buffer) {
      this.maxSize = Math.max(size, 4096);
      this.buffer = new Uint8Array(this.maxSize);
    }
    return this.buffer;
  }
};

export function decode(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = decodePool.acquire(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Uint8Array(bytes.buffer, 0, len);
}

export function encode(bytes: Uint8Array, length?: number): string {
  const len = length ?? bytes.byteLength;
  const chunks: string[] = [];
  const chunkSize = 4096;
  
  for (let offset = 0; offset < len; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, len);
    const subarray = bytes.subarray(offset, end);
    chunks.push(String.fromCharCode.apply(null, subarray as unknown as number[]));
  }
  
  return btoa(chunks.join(''));
}

export async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer, data.byteOffset, data.byteLength / 2);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

export function createBlob(data: Float32Array, length?: number): { data: string; mimeType: string } {
  const l = length ?? data.length;
  const { dataView, uint8 } = pcmBufferPool.acquire(l);
  
  for (let i = 0; i < l; i++) {
    const s = Math.max(-1, Math.min(1, data[i]));
    const int16Value = s < 0 ? s * 0x8000 : s * 0x7FFF;
    dataView.setInt16(i * 2, int16Value, true);
  }
  
  return {
    data: encode(uint8, l * 2),
    mimeType: 'audio/pcm;rate=16000',
  };
}

// Create blob directly from Int16 data (already converted in worklet)
export function createBlobFromInt16(int16Data: Int16Array, length?: number): { data: string; mimeType: string } {
  const l = length ?? int16Data.length;
  const uint8 = new Uint8Array(int16Data.buffer, int16Data.byteOffset, l * 2);
  
  return {
    data: encode(uint8, l * 2),
    mimeType: 'audio/pcm;rate=16000',
  };
}

// Calculate peak level from Int16 data (for VU meter)
export function calculatePeakFromInt16(int16Data: Int16Array, length: number): { peak: number; clipping: boolean } {
  let maxAbs = 0;
  for (let i = 0; i < length; i++) {
    const abs = int16Data[i] > 0 ? int16Data[i] : -int16Data[i];
    if (abs > maxAbs) maxAbs = abs;
  }
  const peak = maxAbs / 32767;
  return { peak, clipping: maxAbs >= 32767 };
}

// outputNode — optional insertion point in the audio graph (e.g. the session's
// GainNode). When provided the tone is routed through it so the user's volume
// setting is respected. Falls back to ctx.destination when null/undefined (e.g.
// before the output graph is wired up).
export function playSignalTone(ctx: AudioContext, outputNode?: AudioNode | null): Promise<void> {
  return new Promise((resolve) => {
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime); // High A
      osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.06);
      
      gain.gain.setValueAtTime(0.8, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.02, ctx.currentTime + 0.06);
      
      osc.connect(gain);
      // Route through the session's gain node when available so the user's
      // volume setting applies to the tone just as it does to AI audio.
      const destination = outputNode ?? ctx.destination;
      gain.connect(destination);

      // Disconnect both nodes as soon as the oscillator finishes — this removes
      // the reference from destination (e.g. the session's GainNode) immediately
      // instead of relying on GC, which matters if cleanupSession has already
      // disconnected outputGainNodeRef and we want dangling references gone fast.
      osc.onended = () => {
        try { osc.disconnect(); } catch (_e) { /* context may already be closed */ }
        try { gain.disconnect(); } catch (_e) { /* context may already be closed */ }
      };
      
      osc.start();
      osc.stop(ctx.currentTime + 0.07);
      
      // Wait for tone to finish plus small delay
      setTimeout(resolve, 100);
    } catch (e) {
      logger.audio.warn('Signal tone playback failed', e);
      resolve();
    }
  });
}
