/**
 * AudioWorklet processor for continuous PCM streaming playback.
 *
 * Lives on the audio rendering thread. Maintains a circular Float32 ring
 * buffer; main thread `postMessage`s decoded PCM into it, the worklet's
 * process() callback drains 128 samples per quantum directly to the
 * destination. No per-chunk AudioBufferSourceNodes, no boundary
 * scheduling, no main-thread jitter exposure.
 *
 * Source is shipped as a string and loaded via Blob URL so it survives
 * the Vite bundler without special config.
 *
 * Protocol (main → worklet):
 *   { type: "pcm", samples: Float32Array }   — append to ring buffer
 *   { type: "reset" }                         — clear, re-prime
 *   { type: "config", primerSamples?: number } — live tune
 *
 * Protocol (worklet → main):
 *   { type: "fill", fillMs: number, underruns: number }  — periodic
 *   { type: "drained" }                                  — buffer hit empty
 */

export const AUDIO_PLAYER_WORKLET_SOURCE = /* js */ `
class AnimaPCMPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.bufferSize = opts.bufferSize || Math.floor(sampleRate * 4); // 4s
    this.buffer = new Float32Array(this.bufferSize);
    this.writeIdx = 0;
    this.readIdx = 0;
    this.fillSamples = 0;
    this.primerSamples = opts.primerSamples || Math.floor(sampleRate * 0.1); // 100ms
    this.priming = true;
    this.underruns = 0;
    this.overflows = 0;
    this.lastReportedFillMs = -1;
    this.lastReportedUnderruns = 0;
    this.lastReportedOverflows = 0;
    this.framesSinceReport = 0;
    this.framesPerReport = Math.floor(sampleRate / 128 / 20); // ~50ms
    this.wasDrained = false;
    this.wasOverflowing = false;

    this.port.onmessage = (e) => {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === "pcm") {
        this.write(msg.samples);
      } else if (msg.type === "reset") {
        this.writeIdx = 0;
        this.readIdx = 0;
        this.fillSamples = 0;
        this.priming = true;
        this.wasDrained = false;
      } else if (msg.type === "config") {
        if (typeof msg.primerSamples === "number") {
          this.primerSamples = msg.primerSamples;
        }
      }
    };
  }

  write(samples) {
    const len = samples.length;
    let overflowedThisCall = false;
    for (let i = 0; i < len; i++) {
      this.buffer[this.writeIdx] = samples[i];
      this.writeIdx = (this.writeIdx + 1) % this.bufferSize;
      if (this.fillSamples < this.bufferSize) {
        this.fillSamples++;
      } else {
        // Overflow — advance read pointer, drop oldest sample
        this.readIdx = (this.readIdx + 1) % this.bufferSize;
        overflowedThisCall = true;
      }
    }
    if (overflowedThisCall && !this.wasOverflowing) {
      this.overflows++;
      this.wasOverflowing = true;
    } else if (!overflowedThisCall) {
      this.wasOverflowing = false;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    const need = out.length;

    if (this.priming) {
      if (this.fillSamples >= this.primerSamples) {
        this.priming = false;
        this.wasDrained = false;
      } else {
        out.fill(0);
        this.report();
        return true;
      }
    }

    let dryThisQuantum = false;
    for (let i = 0; i < need; i++) {
      if (this.fillSamples > 0) {
        out[i] = this.buffer[this.readIdx];
        this.readIdx = (this.readIdx + 1) % this.bufferSize;
        this.fillSamples--;
      } else {
        out[i] = 0;
        dryThisQuantum = true;
      }
    }
    if (dryThisQuantum && !this.wasDrained) {
      // Count one underrun per dry-event (entering empty state), not per sample.
      this.underruns++;
      this.wasDrained = true;
      this.priming = true; // re-prime on dry
      this.port.postMessage({ type: "drained" });
    }

    this.report();
    return true;
  }

  report() {
    this.framesSinceReport++;
    if (this.framesSinceReport < this.framesPerReport) return;
    this.framesSinceReport = 0;
    const fillMs = Math.round((this.fillSamples / sampleRate) * 1000);
    if (
      fillMs !== this.lastReportedFillMs ||
      this.underruns !== this.lastReportedUnderruns ||
      this.overflows !== this.lastReportedOverflows
    ) {
      this.port.postMessage({
        type: "fill",
        fillMs,
        underruns: this.underruns,
        overflows: this.overflows,
      });
      this.lastReportedFillMs = fillMs;
      this.lastReportedUnderruns = this.underruns;
      this.lastReportedOverflows = this.overflows;
    }
  }
}

registerProcessor("anima-pcm-player", AnimaPCMPlayer);
`;
