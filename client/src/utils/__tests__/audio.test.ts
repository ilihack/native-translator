/**
 * Unit tests for client/src/utils/audio.ts
 *
 * Covers:
 *  - decode(): base64 → Uint8Array round-trip
 *  - encode(): Uint8Array → base64 round-trip
 *  - createBlob(): Float32 PCM → base64 blob with MIME type
 *  - createBlobFromInt16(): Int16 PCM → base64 blob with MIME type
 *  - calculatePeakFromInt16(): peak normalisation + clipping detection
 */
import { describe, it, expect } from 'vitest';
import {
  decode,
  encode,
  createBlob,
  createBlobFromInt16,
  calculatePeakFromInt16,
} from '../audio';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeInt16(values: number[]): Int16Array {
  return new Int16Array(values);
}

function makeFloat32(values: number[]): Float32Array {
  return new Float32Array(values);
}

// ─── decode ──────────────────────────────────────────────────────────────────

describe('decode', () => {
  it('decodes a base64 string to the correct bytes', () => {
    // btoa('ABC') = 'QUJD'
    const result = decode('QUJD');
    expect(result.length).toBe(3);
    expect(result[0]).toBe(0x41); // 'A'
    expect(result[1]).toBe(0x42); // 'B'
    expect(result[2]).toBe(0x43); // 'C'
  });

  it('decodes an empty base64 string to a zero-length Uint8Array', () => {
    const result = decode('');
    expect(result.length).toBe(0);
  });

  it('round-trips through encode → decode', () => {
    const original = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    const b64 = encode(original);
    const restored = decode(b64);
    expect(Array.from(restored)).toEqual(Array.from(original));
  });

  it('returns a Uint8Array', () => {
    expect(decode('QUJD')).toBeInstanceOf(Uint8Array);
  });
});

// ─── encode ──────────────────────────────────────────────────────────────────

describe('encode', () => {
  it('encodes a Uint8Array to valid base64', () => {
    const bytes = new Uint8Array([0x41, 0x42, 0x43]); // 'ABC'
    expect(encode(bytes)).toBe('QUJD');
  });

  it('encodes an empty Uint8Array to empty string', () => {
    expect(encode(new Uint8Array(0))).toBe('');
  });

  it('respects the optional length parameter', () => {
    const bytes = new Uint8Array([0x41, 0x42, 0x43, 0x44]); // 'ABCD'
    // encode only the first 2 bytes → 'AB' → 'QUI='
    const result = encode(bytes, 2);
    const decoded = decode(result);
    expect(Array.from(decoded)).toEqual([0x41, 0x42]);
  });

  it('handles buffers larger than one chunk (>4096 bytes)', () => {
    const large = new Uint8Array(5000).fill(0xAB);
    const b64 = encode(large);
    const restored = decode(b64);
    expect(restored.length).toBe(5000);
    expect(restored.every(b => b === 0xAB)).toBe(true);
  });
});

// ─── createBlob ──────────────────────────────────────────────────────────────

describe('createBlob', () => {
  it('returns an object with data and mimeType fields', () => {
    const blob = createBlob(makeFloat32([0.5, -0.5, 0.0]));
    expect(blob).toHaveProperty('data');
    expect(blob).toHaveProperty('mimeType');
  });

  it('returns mimeType audio/pcm;rate=16000', () => {
    expect(createBlob(makeFloat32([0])).mimeType).toBe('audio/pcm;rate=16000');
  });

  it('data is a valid base64 string', () => {
    const { data } = createBlob(makeFloat32([0.25, -0.25]));
    expect(() => atob(data)).not.toThrow();
  });

  it('encodes 2 bytes per Float32 sample (little-endian Int16)', () => {
    const samples = 4;
    const { data } = createBlob(makeFloat32(new Array(samples).fill(0)));
    const decoded = decode(data);
    expect(decoded.byteLength).toBe(samples * 2);
  });

  it('clips values > 1.0 to max Int16 without error', () => {
    expect(() => createBlob(makeFloat32([2.0, -2.0, 99.0]))).not.toThrow();
  });

  it('respects optional length parameter (encodes only first N samples)', () => {
    const data = makeFloat32([0.1, 0.2, 0.3, 0.4]);
    const full = createBlob(data);
    const partial = createBlob(data, 2);
    const fullBytes = decode(full.data).byteLength;
    const partialBytes = decode(partial.data).byteLength;
    expect(partialBytes).toBe(fullBytes / 2);
  });
});

// ─── createBlobFromInt16 ──────────────────────────────────────────────────────

describe('createBlobFromInt16', () => {
  it('returns mimeType audio/pcm;rate=16000', () => {
    expect(createBlobFromInt16(makeInt16([0])).mimeType).toBe('audio/pcm;rate=16000');
  });

  it('data decodes to 2 * length bytes', () => {
    const samples = makeInt16([100, 200, -100, -200]);
    const { data } = createBlobFromInt16(samples);
    expect(decode(data).byteLength).toBe(8); // 4 samples × 2 bytes
  });

  it('round-trips Int16 values faithfully', () => {
    const original = makeInt16([1000, -2000, 32767, -32768, 0]);
    const { data } = createBlobFromInt16(original);
    const bytes = decode(data);
    const restored = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    expect(Array.from(restored)).toEqual(Array.from(original));
  });

  it('respects optional length parameter', () => {
    const samples = makeInt16([1, 2, 3, 4, 5, 6]);
    const partial = createBlobFromInt16(samples, 3);
    const bytes = decode(partial.data);
    expect(bytes.byteLength).toBe(6); // 3 samples × 2 bytes
  });
});

// ─── calculatePeakFromInt16 ──────────────────────────────────────────────────

describe('calculatePeakFromInt16', () => {
  it('returns peak 0 for silence (all zeros)', () => {
    const { peak, clipping } = calculatePeakFromInt16(makeInt16([0, 0, 0]), 3);
    expect(peak).toBe(0);
    expect(clipping).toBe(false);
  });

  it('returns peak ≈ 1.0 for max positive value (32767)', () => {
    const { peak, clipping } = calculatePeakFromInt16(makeInt16([32767]), 1);
    expect(peak).toBeCloseTo(1.0, 3);
    expect(clipping).toBe(true);
  });

  it('detects clipping at exactly 32767', () => {
    const { clipping } = calculatePeakFromInt16(makeInt16([32767]), 1);
    expect(clipping).toBe(true);
  });

  it('does NOT report clipping for values below 32767', () => {
    const { clipping } = calculatePeakFromInt16(makeInt16([32766]), 1);
    expect(clipping).toBe(false);
  });

  it('treats negative values as positive absolute values (abs)', () => {
    const pos = calculatePeakFromInt16(makeInt16([16000]), 1);
    const neg = calculatePeakFromInt16(makeInt16([-16000]), 1);
    expect(pos.peak).toBeCloseTo(neg.peak, 5);
  });

  it('returns peak ≈ 0.5 for value 16384 (~half of 32767)', () => {
    const { peak } = calculatePeakFromInt16(makeInt16([16384]), 1);
    expect(peak).toBeCloseTo(0.5, 1);
  });

  it('returns the maximum across multiple samples', () => {
    const { peak } = calculatePeakFromInt16(makeInt16([100, 5000, 200, 1000]), 4);
    expect(peak).toBeCloseTo(5000 / 32767, 3);
  });

  it('respects the length parameter — ignores samples beyond it', () => {
    const data = makeInt16([100, 32767, 200]); // max is at index 1
    // Only look at first sample
    const { peak } = calculatePeakFromInt16(data, 1);
    expect(peak).toBeCloseTo(100 / 32767, 3);
    expect(peak).toBeLessThan(0.1);
  });
});
