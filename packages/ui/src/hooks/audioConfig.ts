/**
 * Live-tunable audio playback parameters.
 *
 * TEMPORARY debug singleton — exposed via <AudioDebugPanel /> so we can
 * iterate on buffering parameters without restarting the dev server.
 *
 * Read by useAudioPlayback at decision time. Mutations propagate to the
 * AudioWorklet via a `config` postMessage.
 */

export interface AudioConfig {
  /**
   * Initial primer fill before playback begins (ms). Higher = more
   * tolerance for early-stream stalls; lower = less startup latency.
   */
  primerBufferMs: number;
  /**
   * Target steady-state worklet fill (ms). The feeder pushes from the JS
   * chunk queue whenever the worklet's estimated fill drops below this.
   * Acts as the real "how much audio do I want buffered ahead" knob.
   */
  highWatermarkMs: number;
  /**
   * Worklet ring buffer capacity (ms). Just needs to be bigger than the
   * watermark — overflow is now structurally impossible because the JS
   * queue absorbs production bursts.
   */
  ringBufferMs: number;
}

const DEFAULTS: AudioConfig = {
  primerBufferMs: 120,
  // 2s steady-state target — enough cushion to absorb main-thread jank
  // without committing to long latency.
  highWatermarkMs: 2000,
  // 8s ring; the JS queue holds anything beyond this, so 8s is plenty.
  ringBufferMs: 8000,
};

const state: AudioConfig = { ...DEFAULTS };
const listeners = new Set<() => void>();

export function getAudioConfig(): AudioConfig {
  return state;
}

export function setAudioConfig(patch: Partial<AudioConfig>): void {
  Object.assign(state, patch);
  for (const fn of listeners) fn();
}

export function resetAudioConfig(): void {
  Object.assign(state, DEFAULTS);
  for (const fn of listeners) fn();
}

export function subscribeAudioConfig(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getAudioConfigDefaults(): AudioConfig {
  return { ...DEFAULTS };
}

// ---------------------------------------------------------------------------
// Live status (worklet → main thread → debug panel)
// ---------------------------------------------------------------------------

export interface AudioStatus {
  /** Current worklet ring buffer fill in ms (from worklet reports). */
  fillMs: number;
  /** Pending audio queued on the main thread waiting to be fed (ms). */
  queueMs: number;
  /** Total underrun events since context start. */
  underruns: number;
  /** Total overflow events since context start (should now stay at 0). */
  overflows: number;
}

const status: AudioStatus = { fillMs: 0, queueMs: 0, underruns: 0, overflows: 0 };
const statusListeners = new Set<() => void>();

export function getAudioStatus(): AudioStatus {
  return status;
}

export function setAudioStatus(patch: Partial<AudioStatus>): void {
  Object.assign(status, patch);
  for (const fn of statusListeners) fn();
}

export function subscribeAudioStatus(fn: () => void): () => void {
  statusListeners.add(fn);
  return () => {
    statusListeners.delete(fn);
  };
}
