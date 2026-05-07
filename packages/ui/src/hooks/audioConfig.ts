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
  /** Total ring buffer capacity (ms). Acts as an overflow safety net. */
  ringBufferMs: number;
}

const DEFAULTS: AudioConfig = {
  primerBufferMs: 120,
  // 30s default — comfortably absorbs Cartesia's faster-than-realtime
  // sentence bursts even on long responses. ~5.7MB at 48kHz Float32 mono,
  // trivial against the rest of a browser tab's footprint.
  ringBufferMs: 30000,
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
  /** Current ring buffer fill in ms. */
  fillMs: number;
  /** Total underrun events since context start. */
  underruns: number;
  /** Total overflow events since context start (chunks dropped on full ring). */
  overflows: number;
}

const status: AudioStatus = { fillMs: 0, underruns: 0, overflows: 0 };
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
