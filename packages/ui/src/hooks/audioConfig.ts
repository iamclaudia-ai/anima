/**
 * Live-tunable audio playback parameters.
 *
 * TEMPORARY debug singleton — exposed via <AudioDebugPanel /> so we can
 * iterate on click/pop tuning without restarting the dev server.
 *
 * Read by useAudioPlayback at scheduling time (every chunk), so mutations
 * take effect on the next chunk after a change. Subscribers (the panel)
 * use the small pub/sub below to re-render their controls.
 */

export interface AudioConfig {
  /** Scheduling lookahead floor: chunks scheduled at max(cursor, now + this). */
  lookaheadMs: number;
  /** Extra cushion at stream_start before first chunk lands. */
  streamStartBufferMs: number;
  /** Edge-fade length in samples (per chunk, both ends). 0 disables. */
  fadeSamples: number;
  /** If true, apply edge fade in pcm16ToAudioBuffer. */
  fadeEnabled: boolean;
  /** Synthetic silence to insert between every chunk (ms). 0 = none. */
  interChunkSilenceMs: number;
}

const DEFAULTS: AudioConfig = {
  lookaheadMs: 100,
  streamStartBufferMs: 120,
  fadeSamples: 64,
  fadeEnabled: true,
  interChunkSilenceMs: 0,
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
