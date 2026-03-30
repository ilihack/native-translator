/**
 * AudioWorkletProcessor source code (as string) for capturing microphone input,
 * resampling from device rate (typically 48kHz) to 16kHz via polyphase FIR filter,
 * and encoding to Int16 PCM for Gemini Live API consumption.
 * @inputs Float32 audio frames from mic, processorOptions for target sample rate
 * @exports RECORDER_WORKLET_CODE string constant for Blob URL registration
 */
export const RECORDER_WORKLET_CODE = `
// Polyphase Resampler + Int16 Conversion - all in worklet for low latency
class RecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options?.processorOptions || {};
    
    // Sample rates
    this.inputRate = opts.inputSampleRate || 48000;
    this.outputRate = opts.outputSampleRate || 16000;
    this.ratio = this.inputRate / this.outputRate;
    
    // Resampler config (low quality = fast, good enough for speech)
    this.numTaps = opts.numTaps || 16;
    this.numPhases = opts.numPhases || 32;
    // Pre-compute bitmask for power-of-2 numTaps (avoids modulo in hot inner loop)
    const isPow2 = (this.numTaps & (this.numTaps - 1)) === 0;
    this.tapMask = isPow2 ? (this.numTaps - 1) : -1; // -1 signals: use modulo fallback
    
    // Pre-compute filter bank (Blackman-windowed sinc)
    this.filterBank = this.computeFilterBank();
    
    // Resampler state - preallocated
    this.historyBuffer = new Float32Array(this.numTaps);
    this.historyIndex = 0;
    this.position = 0;
    
    // Gain — use explicit undefined check so gain=0 (full mute) is honoured.
    // "opts.gain || 1.0" would silently replace 0 with 1.0 because 0 is falsy.
    this.gain = opts.gain !== undefined ? opts.gain : 1.0;
    
    // Output buffer config - configurable input buffer size
    // Default 960 input samples at 48kHz = 20ms -> 320 output samples at 16kHz
    this.inputBufferSize = opts.inputBufferSize || 960;
    this.maxOutputSize = Math.ceil(this.inputBufferSize / this.ratio) + 16; // +16 safety margin
    
    // Buffer pools - preallocated for zero-allocation runtime
    this.inputPoolSize = 50;
    this.outputPoolSize = 50;
    
    // Input accumulator (Float32) - sized for inputBufferSize + one worklet block (128) for overflow handling
    this.inputBuffer = new Float32Array(this.inputBufferSize + 128);
    this.inputIndex = 0;
    
    // Output buffer pool (Int16 as ArrayBuffer for transfer)
    this.outputPool = [];
    for (let i = 0; i < this.outputPoolSize; i++) {
      this.outputPool.push(new ArrayBuffer(this.maxOutputSize * 2)); // 2 bytes per Int16
    }
    
    // Temp Float32 buffer for resampled output before Int16 conversion
    this.resampledBuffer = new Float32Array(this.maxOutputSize);
    
    // Stats
    this.frameCounter = 0;
    // Do NOT initialise to 0 — with reused AudioContexts (reconnect) currentTime
    // is already large (e.g. 120 s), so the first interval would be ~120000 ms.
    // We use a separate firstSend flag instead to emit interval:0 on the very
    // first frame, signalling "no previous reference point".
    this.lastSendTime = 0;
    this.firstSend = true;
    this.stats = {
      totalFramesSent: 0,
      totalInputSamples: 0,
      totalOutputSamples: 0,
      poolExhausted: 0,
      resamplerResets: 0
    };
    
    // Error counter for rate limiting
    this.errorCount = 0;
    this.lastErrorTime = 0;
    
    // Message handler with error handling
    this.port.onmessage = (e) => {
      try {
        if (e.data.returnBuffer && e.data.returnBuffer instanceof ArrayBuffer) {
          // Cap at initial pool size (50) — same guard as the Float32 pool in the
          // player worklet. In normal operation the pool stays near 50, but without
          // the cap a burst of rapid returnBuffer messages could grow it unbounded.
          if (this.outputPool.length < this.outputPoolSize) {
            this.outputPool.push(e.data.returnBuffer);
          }
        }
        if (e.data.gain !== undefined) {
          this.gain = e.data.gain;
        }
        if (e.data.type === 'getStats') {
          this.port.postMessage({ type: 'stats', stats: this.stats });
        }
        if (e.data.type === 'reset') {
          this.resetResampler();
        }
        if (e.data.type === 'terminate') {
          // Caller is disconnecting this node. Setting this flag makes process() return false,
          // which allows the Web Audio engine to garbage-collect the processor. Without this,
          // process() always returns true and the processor runs forever even after disconnect.
          this.terminated = true;
        }
      } catch (err) {
        this.reportError('onmessage', err);
      }
    };
  }
  
  computeFilterBank() {
    const bank = [];
    const halfTaps = this.numTaps / 2;
    // Cutoff frequency normalized to output Nyquist (ratio = 3 for 48kHz → 16kHz)
    // This prevents aliasing by filtering out frequencies above 8kHz before decimation
    const cutoffScale = 1.0 / this.ratio;
    
    for (let phase = 0; phase < this.numPhases; phase++) {
      const coeffs = new Float32Array(this.numTaps);
      const offset = phase / this.numPhases;
      
      let sum = 0;
      for (let i = 0; i < this.numTaps; i++) {
        // Scale sinc by cutoff to set proper anti-aliasing frequency
        const x = (i - halfTaps + offset) * Math.PI * cutoffScale;
        let sinc;
        
        if (x > -0.0001 && x < 0.0001) {
          sinc = 1.0;
        } else {
          sinc = Math.sin(x) / x;
        }
        
        // Blackman window for good stopband attenuation
        const n = i / (this.numTaps - 1);
        const blackman = 0.42 - 0.5 * Math.cos(2 * Math.PI * n) + 0.08 * Math.cos(4 * Math.PI * n);
        
        // Apply cutoff scale to coefficient as well for proper gain
        coeffs[i] = sinc * blackman * cutoffScale;
        sum += coeffs[i];
      }
      
      // Normalize to unity gain
      if (sum !== 0) {
        for (let i = 0; i < this.numTaps; i++) {
          coeffs[i] /= sum;
        }
      }
      
      bank.push(coeffs);
    }
    
    return bank;
  }
  
  resetResampler() {
    this.historyBuffer.fill(0);
    this.historyIndex = 0;
    this.position = 0;
    this.inputBuffer.fill(0);
    this.inputIndex = 0;
    // Reset firstSend so the next frame after a resampler reset also reports
    // interval:0 — the gap from the reset invalidates the previous send time.
    this.firstSend = true;
    this.stats.resamplerResets++;
  }
  
  reportError(context, err) {
    // Rate limit error reporting to avoid flooding (max 1 per second)
    const now = currentTime * 1000;
    this.errorCount++;
    if (now - this.lastErrorTime < 1000) {
      return; // Throttled - just count, don't report yet
    }
    this.lastErrorTime = now;
    this.port.postMessage({ 
      type: 'error', 
      context: context,
      message: String(err),
      errorCount: this.errorCount
    });
    this.errorCount = 0; // Reset counter after successful report
  }
  
  // Resample Float32 input to Float32 output at target rate
  resample(input, inputLength) {
    let outputIndex = 0;
    const numTaps  = this.numTaps;
    const tapMask  = this.tapMask;    // -1 when numTaps is not power-of-2
    const numPhases = this.numPhases;
    
    for (let i = 0; i < inputLength; i++) {
      // Add to circular history buffer
      this.historyBuffer[this.historyIndex] = input[i];
      // Bitwise AND is faster than modulo for power-of-2 sizes (tapMask = numTaps-1)
      this.historyIndex = tapMask >= 0
        ? (this.historyIndex + 1) & tapMask
        : (this.historyIndex + 1) % numTaps;
      
      // Generate output samples
      while (this.position < 1.0 && outputIndex < this.maxOutputSize) {
        const phaseIndex = (this.position * numPhases) | 0;
        const coeffs = this.filterBank[phaseIndex < numPhases ? phaseIndex : numPhases - 1];
        const baseIndex = this.historyIndex; // oldest sample starts here
        
        let sample = 0;
        if (tapMask >= 0) {
          // Power-of-2 fast path: use bitwise AND instead of modulo
          for (let j = 0; j < numTaps; j++) {
            sample += this.historyBuffer[(baseIndex + j) & tapMask] * coeffs[j];
          }
        } else {
          // General fallback: use modulo
          for (let j = 0; j < numTaps; j++) {
            sample += this.historyBuffer[(baseIndex - numTaps + j + numTaps) % numTaps] * coeffs[j];
          }
        }
        
        this.resampledBuffer[outputIndex++] = sample;
        this.position += this.ratio;
      }
      
      this.position -= 1.0;
    }
    
    return outputIndex;
  }
  
  process(inputs, outputs, parameters) {
    // Return false immediately after terminate so the Web Audio engine can GC this processor.
    if (this.terminated) return false;
    try {
      const input = inputs[0];
      if (!input || input.length === 0) return true;
      
      const channelData = input[0];
      if (!channelData) return true;
      
      const gain = this.gain;
      
      // Accumulate input samples with gain
      for (let i = 0; i < channelData.length; i++) {
        let sample = channelData[i] * gain;
        // Clip to [-1, 1]
        if (sample > 1) sample = 1;
        else if (sample < -1) sample = -1;
        
        this.inputBuffer[this.inputIndex++] = sample;
      }
      
      // Buffer has enough samples - process exactly inputBufferSize and keep overflow
      while (this.inputIndex >= this.inputBufferSize) {
        this.processAndSend();
      }
      
      this.stats.totalInputSamples += channelData.length;
    } catch (err) {
      this.reportError('process', err);
    }
    return true;
  }
  
  processAndSend() {
    // Hoist outside the try block so the catch can return it to the pool if an
    // exception throws after pop() but before postMessage (which transfers ownership).
    // Without this, the buffer is GC-collected instead of being reused, gradually
    // depleting the pool and causing poolExhausted allocations in steady state.
    let outputArrayBuffer = null;
    try {
      // Resample exactly inputBufferSize samples (not the full inputIndex)
      const outputLength = this.resample(this.inputBuffer, this.inputBufferSize);
      
      // Get output buffer from pool
      if (this.outputPool.length > 0) {
        outputArrayBuffer = this.outputPool.pop();
      } else {
        // Pool exhausted - allocate new (shouldn't happen in normal operation)
        outputArrayBuffer = new ArrayBuffer(this.maxOutputSize * 2);
        this.stats.poolExhausted++;
      }
      
      // Convert Float32 to Int16
      const int16View = new Int16Array(outputArrayBuffer, 0, outputLength);
      for (let i = 0; i < outputLength; i++) {
        const s = this.resampledBuffer[i];
        // Scale and clamp to Int16 range
        let val = (s * 32767) | 0;
        if (val > 32767) val = 32767;
        else if (val < -32768) val = -32768;
        int16View[i] = val;
      }
      
      // Send with transfer (zero-copy). After postMessage the ArrayBuffer is
      // detached — do NOT access outputArrayBuffer after this point.
      const now = currentTime * 1000;
      // On the first send after processor creation, report interval:0 rather than
      // (now - 0). With a reused AudioContext (reconnect after 2 min), currentTime
      // would be ~120 000 ms and interval would be a meaningless 120 000 ms —
      // confusing in logs and polluting the jitter-detection reference value.
      const interval = this.firstSend ? 0 : now - this.lastSendTime;
      this.firstSend = false;
      this.port.postMessage(
        {
          type: 'audio',
          buffer: outputArrayBuffer,
          length: outputLength,
          frameId: this.frameCounter++,
          timestamp: now,
          interval
        },
        [outputArrayBuffer]
      );
      outputArrayBuffer = null; // Transferred — prevent accidental pool return below
      
      this.lastSendTime = now;
      this.stats.totalFramesSent++;
      this.stats.totalOutputSamples += outputLength;
    } catch (err) {
      // If we popped a buffer but the send failed, return it to the pool so
      // the next frame can reuse it instead of allocating a fresh ArrayBuffer.
      if (outputArrayBuffer !== null && this.outputPool.length < this.outputPoolSize) {
        this.outputPool.push(outputArrayBuffer);
      }
      this.reportError('processAndSend', err);
    }
    
    // Move overflow samples to beginning of buffer using copyWithin for correctness
    const overflow = this.inputIndex - this.inputBufferSize;
    if (overflow > 0) {
      // copyWithin(target, start, end) - moves samples from [start, end) to target
      this.inputBuffer.copyWithin(0, this.inputBufferSize, this.inputIndex);
    }
    this.inputIndex = overflow;
  }
}
registerProcessor('recorder-processor', RecorderProcessor);
`;
