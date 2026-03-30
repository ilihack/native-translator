/**
 * AudioWorkletProcessor source code (as string) for playing back PCM Int16 audio
 * from Gemini at 24kHz. Handles ring-buffer management, sample rate conversion to
 * device output rate, and adaptive underrun protection with fade-in/fade-out.
 * @inputs PCM Int16 chunks via MessagePort, processorOptions for sampleRate
 * @exports PCM_PLAYER_WORKLET_CODE string constant for Blob URL registration
 */
export const PCM_PLAYER_WORKLET_CODE = `
class PCMPlayerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.sourceSampleRate = options.processorOptions?.sampleRate || 24000;
    this.targetSampleRate = sampleRate;
    this.resampleRatio = this.sourceSampleRate / this.targetSampleRate;
    this.loggingEnabled = options.processorOptions?.loggingEnabled || false;
    
    this.chunks = [];
    this.readIndex = 0;       // deque read pointer — avoids O(n) shift() in hot path
    this.currentChunk = null;
    this.chunkPosition = 0;
    this.isPlaying = false;

    // Float32Array pool keyed by length — avoids allocation on every incoming PCM chunk
    this.floatPool = new Map();
    
    // Grace period: wait 4 seconds before declaring underrun
    this.gracePeriodSeconds = 4.0;
    this.graceStartTime = null;
    this.endOfStreamReceived = false;
    this.inGracePeriod = false;
    this.gracePeriodWarningReported = false;
    // Delay before reporting "connection degraded" warning (to avoid false alarms from timing jitter)
    this.gracePeriodWarningDelaySeconds = 0.3;
    
    // Post-stream delay: wait after endOfStream + buffer empty before signaling ended.
    // Catches late-arriving audio packets (network jitter). Gemini jitter is typically
    // <80 ms, so 180 ms gives a comfortable margin while halving the perceptible
    // delay between the last spoken word and the ready-to-speak signal tone.
    this.postStreamDelaySeconds = 0.18;
    this.postStreamDelayStart = null;
    this.inPostStreamDelay = false;
    
    this.stats = {
      totalChunksReceived: 0,
      totalSamplesReceived: 0,
      totalSamplesPlayed: 0,
      underruns: 0,
      gracePeriodEvents: 0,
      maxBufferLevel: 0,
      minBufferLevelWhilePlaying: Infinity,
      playStartTime: 0,
      lastStatsReport: 0,
      peakAmplitude: 0
    };
    
    // Error handling
    this.errorCount = 0;
    this.lastErrorTime = 0;
    
    this.port.onmessage = (e) => {
      try {
      if (e.data.type === 'pcm') {
        const int16 = new Int16Array(e.data.buffer, 0, e.data.length / 2);
        // Reuse a Float32Array from the pool to avoid allocation on every chunk
        const len = int16.length;
        const pool = this.floatPool.get(len);
        const floatData = (pool && pool.length > 0) ? pool.pop() : new Float32Array(len);
        let maxAmp = 0;
        for (let i = 0; i < len; i++) {
          floatData[i] = int16[i] / 32768.0;
          const abs = floatData[i] < 0 ? -floatData[i] : floatData[i];
          if (abs > maxAmp) maxAmp = abs;
        }
        this.chunks.push(floatData);
        
        this.stats.totalChunksReceived++;
        this.stats.totalSamplesReceived += floatData.length;
        if (maxAmp > this.stats.peakAmplitude) this.stats.peakAmplitude = maxAmp;
        
        // Reset grace period and post-stream delay when new data arrives
        // NOTE: endOfStreamReceived wird NICHT zurückgesetzt - wenn turnComplete kam, bleibt es
        // Der 400ms Delay wird nur zurückgesetzt um das neue Audio abzuspielen
        if (this.inGracePeriod) {
          // Only send recovery message if warning was actually reported
          if (this.gracePeriodWarningReported) {
            this.port.postMessage({ type: 'gracePeriodRecovered' });
          }
          this.inGracePeriod = false;
          this.graceStartTime = null;
          this.gracePeriodWarningReported = false;
        }
        if (this.inPostStreamDelay) {
          // Spätes Audio während Nachlaufzeit erhalten: Nachlauf-Start zurücksetzen
          // So wird die Zeit ab dem LETZTEN empfangenen Chunk gerechnet
          this.postStreamDelayStart = currentTime;
        }
        // endOfStreamReceived wird bewusst NICHT zurückgesetzt - Turn ist beendet
        
        const bufferLevel = this.getBufferLevelMs();
        if (bufferLevel > this.stats.maxBufferLevel) {
          this.stats.maxBufferLevel = bufferLevel;
        }
        
        if (!this.isPlaying) {
          this.isPlaying = true;
          this.stats.playStartTime = currentTime;
          this.stats.minBufferLevelWhilePlaying = bufferLevel;
          // Neuer Turn beginnt - endOfStreamReceived vom vorherigen Turn zurücksetzen
          this.endOfStreamReceived = false;
          this.port.postMessage({ type: 'started', bufferMs: bufferLevel });
        }
      } else if (e.data.type === 'endOfStream') {
        // Server signaled turn complete - can end gracefully when buffer empty
        this.endOfStreamReceived = true;
      } else if (e.data.type === 'clear') {
        const hadData = this.chunks.length > 0 || this.currentChunk !== null;
        const droppedSamples = this.getTotalBufferedSamples();

        // Return pooled arrays before clearing to avoid GC.
        // Cap at 8 per size-bucket so the pool cannot grow without bound
        // during long sessions or repeated clear() calls (burst traffic).
        for (let i = this.readIndex; i < this.chunks.length; i++) {
          const arr = this.chunks[i];
          if (arr) {
            const pool = this.floatPool.get(arr.length) || [];
            if (pool.length < 8) pool.push(arr);
            this.floatPool.set(arr.length, pool);
          }
        }
        if (this.currentChunk) {
          const pool = this.floatPool.get(this.currentChunk.length) || [];
          if (pool.length < 8) pool.push(this.currentChunk);
          this.floatPool.set(this.currentChunk.length, pool);
        }

        this.chunks = [];
        this.readIndex = 0;
        this.currentChunk = null;
        this.chunkPosition = 0;
        this.graceStartTime = null;
        this.inGracePeriod = false;
        this.gracePeriodWarningReported = false;
        this.endOfStreamReceived = false;
        this.postStreamDelayStart = null;
        this.inPostStreamDelay = false;
        if (this.isPlaying) {
          this.isPlaying = false;
          this.port.postMessage({ 
            type: 'ended', 
            reason: 'clear',
            droppedSamples,
            stats: this.getStatsSnapshot()
          });
        }
      } else if (e.data.type === 'enableLogging') {
        this.loggingEnabled = e.data.enabled;
      } else if (e.data.type === 'getStats') {
        this.port.postMessage({ type: 'stats', stats: this.getStatsSnapshot() });
      } else if (e.data.type === 'terminate') {
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
  
  reportError(context, err) {
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
  
  getTotalBufferedSamples() {
    let total = 0;
    // Only count chunks from readIndex onward (already-consumed chunks stay in array)
    for (let i = this.readIndex; i < this.chunks.length; i++) {
      total += this.chunks[i].length;
    }
    if (this.currentChunk) {
      total += this.currentChunk.length - Math.floor(this.chunkPosition);
    }
    return total;
  }
  
  getBufferLevelMs() {
    const samples = this.getTotalBufferedSamples();
    return Math.round((samples / this.sourceSampleRate) * 1000);
  }
  
  getStatsSnapshot() {
    const bufferMs = this.getBufferLevelMs();
    return {
      totalChunksReceived: this.stats.totalChunksReceived,
      totalSamplesReceived: this.stats.totalSamplesReceived,
      totalSamplesPlayed: this.stats.totalSamplesPlayed,
      underruns: this.stats.underruns,
      gracePeriodEvents: this.stats.gracePeriodEvents,
      inGracePeriod: this.inGracePeriod,
      maxBufferMs: this.stats.maxBufferLevel,
      minBufferMs: this.stats.minBufferLevelWhilePlaying === Infinity ? 0 : this.stats.minBufferLevelWhilePlaying,
      currentBufferMs: bufferMs,
      chunksQueued: this.chunks.length - this.readIndex,
      peakAmplitude: Math.round(this.stats.peakAmplitude * 100) / 100,
      resampleRatio: this.resampleRatio,
      sourceSampleRate: this.sourceSampleRate,
      targetSampleRate: this.targetSampleRate
    };
  }
  
  process(inputs, outputs, parameters) {
    // Return false immediately after terminate so the Web Audio engine can GC this processor.
    if (this.terminated) return false;
    try {
      const output = outputs[0];
      if (!output || output.length === 0) return true;

      // Compact consumed chunk slots at frame boundary — NOT inside the sample loop.
      // splice(0, N) is O(remaining) and must never run mid-sample to avoid
      // audio glitches or unpredictable micro-stalls on the real-time thread.
      // Threshold 32 → fires at most once every ~640 ms (32 × 20 ms chunks).
      if (this.readIndex >= 32) {
        this.chunks.splice(0, this.readIndex);
        this.readIndex = 0;
      }

      const channel = output[0];
      const frameSize = channel.length;
      let samplesPlayedThisFrame = 0;
      
      for (let i = 0; i < frameSize; i++) {
        if (!this.currentChunk) {
          if (this.readIndex < this.chunks.length) {
            this.currentChunk = this.chunks[this.readIndex++];
            // NOTE: chunkPosition is intentionally NOT reset here.
            // When a chunk is exhausted the sub-sample fractional carry is stored
            // in chunkPosition so the next chunk's interpolation starts at the
            // correct phase. Resetting to 0 would cause a tiny discontinuity at
            // every chunk boundary and accumulate ~0.1% pitch drift per minute.
          } else {
            // Buffer empty - handle with grace period logic
            if (this.isPlaying) {
              // If endOfStream received, wait 400ms before ending (to catch late packets)
              if (this.endOfStreamReceived) {
                if (!this.inPostStreamDelay) {
                  // Start post-stream delay
                  this.postStreamDelayStart = currentTime;
                  this.inPostStreamDelay = true;
                } else {
                  // Check if delay expired
                  const elapsed = currentTime - this.postStreamDelayStart;
                  if (elapsed >= this.postStreamDelaySeconds) {
                    this.isPlaying = false;
                    this.endOfStreamReceived = false;
                    this.graceStartTime = null;
                    this.inGracePeriod = false;
                    this.postStreamDelayStart = null;
                    this.inPostStreamDelay = false;
                    this.port.postMessage({ 
                      type: 'ended', 
                      reason: 'complete',
                      stats: this.getStatsSnapshot()
                    });
                  }
                }
              } else if (!this.inGracePeriod) {
                // Start grace period - wait for more data
                this.graceStartTime = currentTime;
                this.inGracePeriod = true;
                this.gracePeriodWarningReported = false;
                this.stats.gracePeriodEvents++;
                // Don't report warning immediately - wait for gracePeriodWarningDelaySeconds
              } else {
                // In grace period - check elapsed time
                const elapsed = currentTime - this.graceStartTime;
                
                // Report warning after delay (to avoid false alarms from timing jitter)
                if (!this.gracePeriodWarningReported && elapsed >= this.gracePeriodWarningDelaySeconds) {
                  this.gracePeriodWarningReported = true;
                  this.port.postMessage({ type: 'gracePeriodStarted' });
                }
                
                // Check if grace period fully expired
                if (elapsed >= this.gracePeriodSeconds) {
                  // Grace period expired - Turn Signal fehlt (kein endOfStream nach 4s)
                  this.stats.underruns++;
                  this.isPlaying = false;
                  this.graceStartTime = null;
                  this.inGracePeriod = false;
                  this.port.postMessage({ 
                    type: 'ended', 
                    reason: 'turnSignalMissing',
                    stats: this.getStatsSnapshot()
                  });
                }
              }
            }
            channel.fill(0, i);
            break;
          }
        }
        
        const srcPos = this.chunkPosition;
        const srcIdx = Math.floor(srcPos);
        const frac = srcPos - srcIdx;
        
        if (srcIdx >= this.currentChunk.length - 1) {
          // Carry the sub-sample fractional position to the next chunk.
          // Without this, chunkPosition resets to 0 at each boundary which:
          //   (a) silently drops the last sample of every chunk as an s0 value,
          //   (b) discards the interpolation phase, causing a micro-discontinuity,
          //   (c) accumulates ~0.1% pitch drift over long playback sessions.
          // "frac" is already computed above (srcPos - srcIdx), always in [0, 1).
          // Return exhausted chunk to the pool for reuse (cap at 8 to bound memory)
          const pool = this.floatPool.get(this.currentChunk.length) || [];
          if (pool.length < 8) pool.push(this.currentChunk);
          this.floatPool.set(this.currentChunk.length, pool);
          this.currentChunk = null;
          this.chunkPosition = frac; // Fractional carry — consumed by next chunk load
          i--;
          continue;
        }
        
        const s0 = this.currentChunk[srcIdx];
        const s1 = this.currentChunk[srcIdx + 1];
        channel[i] = s0 + (s1 - s0) * frac;
        samplesPlayedThisFrame++;
        
        this.chunkPosition += this.resampleRatio;
      }
      
      this.stats.totalSamplesPlayed += samplesPlayedThisFrame;
      
      if (this.isPlaying && this.loggingEnabled) {
        const bufferMs = this.getBufferLevelMs();
        if (bufferMs < this.stats.minBufferLevelWhilePlaying) {
          this.stats.minBufferLevelWhilePlaying = bufferMs;
        }
        
        if (currentTime - this.stats.lastStatsReport > 1.0) {
          this.stats.lastStatsReport = currentTime;
          this.port.postMessage({ type: 'bufferStatus', stats: this.getStatsSnapshot() });
        }
      }
      
      for (let ch = 1; ch < output.length; ch++) {
        output[ch].set(channel);
      }
    } catch (err) {
      this.reportError('process', err);
    }
    
    return true;
  }
}
registerProcessor('pcm-player-processor', PCMPlayerProcessor);
`;
