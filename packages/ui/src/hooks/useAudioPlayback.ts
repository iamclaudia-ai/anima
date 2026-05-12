/**
 * Audio Playback Hook (AudioWorklet ring-buffer edition)
 *
 * Continuous PCM streaming through a single persistent AudioWorkletNode.
 * Decoded samples are pushed into a ring buffer that the audio thread
 * drains directly — no per-chunk AudioBufferSourceNode scheduling, no
 * boundary clicks, and main-thread jitter only ever shows up as buffer
 * underruns (audible silence) rather than pops.
 *
 * Batch playback (`voice.audio` event with a full encoded file) still
 * goes through `decodeAudioData` + a one-shot AudioBufferSourceNode
 * since there are no boundaries to worry about there.
 */

import { useCallback, useEffect, useReducer, useRef } from "react";
import type { UseChatGatewayReturn } from "./useChatGateway";
import {
  clearVoiceStreams,
  createAudioPlaybackState,
  endVoiceStream,
  shouldAcceptVoiceChunk,
  startVoiceStream,
} from "./audioPlaybackState";
import { AUDIO_PLAYER_WORKLET_SOURCE } from "./audioPlayerWorklet";

const CARTESIA_SAMPLE_RATE = 24000;

// Tuned values from the audio debug session — these absorb Cartesia's
// faster-than-realtime sentence bursts cleanly with no overflows even
// across multi-minute responses.
const PRIMER_BUFFER_MS = 120;
const HIGH_WATERMARK_MS = 2000;
const RING_BUFFER_MS = 8000;

export interface UseAudioPlaybackReturn {
  /** Whether audio is currently playing (ring buffer non-empty + past primer). */
  isPlaying: boolean;
  /** Whether a voice stream is active (may still be buffering). */
  isStreaming: boolean;
  /** Stop playback and clear the ring buffer. */
  stop(): void;
}

// ── Playback state reducer ─────────────────────────────────
// Two orthogonal observable flags. They're independent (4 valid combinations)
// so this isn't an FSM — but routing every transition through a reducer makes
// each event flow explicit and keeps the event-handler effect down to a single
// dispatch per branch, which both reads more clearly and quiets the
// no-cascading-set-state lint.

interface PlaybackFlags {
  isPlaying: boolean;
  isStreaming: boolean;
}

const INITIAL_FLAGS: PlaybackFlags = { isPlaying: false, isStreaming: false };

type PlaybackAction =
  | { type: "STREAM_STARTED" }
  | { type: "STREAM_ENDED"; hasActiveStreams: boolean }
  | { type: "BATCH_STARTED" }
  | { type: "BATCH_PLAY_STARTED" }
  | { type: "BATCH_PLAY_ENDED" }
  | { type: "WORKLET_FILL"; playing: boolean }
  | { type: "STOPPED" };

function playbackReducer(state: PlaybackFlags, action: PlaybackAction): PlaybackFlags {
  switch (action.type) {
    case "STREAM_STARTED":
      return state.isStreaming ? state : { ...state, isStreaming: true };
    case "STREAM_ENDED":
      return state.isStreaming === action.hasActiveStreams
        ? state
        : { ...state, isStreaming: action.hasActiveStreams };
    case "BATCH_STARTED":
      // Streaming flag flips on the moment we accept the batch — playback flips
      // separately when decode finishes and the buffer source starts.
      return { ...state, isStreaming: true };
    case "BATCH_PLAY_STARTED":
      return state.isPlaying ? state : { ...state, isPlaying: true };
    case "BATCH_PLAY_ENDED":
      // Drop the playing flag. `isStreaming` was set true on batch start and
      // stays true until `stop()` or a `voice.stream_end` clears it — matches
      // the pre-refactor behavior where the equivalent check guarded
      // setIsStreaming(false) behind `!isStreamingRef.current`.
      return state.isPlaying ? { ...state, isPlaying: false } : state;
    case "WORKLET_FILL":
      return state.isPlaying === action.playing ? state : { ...state, isPlaying: action.playing };
    case "STOPPED":
      return INITIAL_FLAGS;
  }
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** Convert Int16 PCM → Float32 in [-1, 1]. */
function pcm16ToFloat32(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    out[i] = pcm[i] / 32768;
  }
  return out;
}

/** Linear-interpolation resampler. Quality is fine for speech. */
function resampleLinear(input: Float32Array, srcRate: number, dstRate: number): Float32Array {
  if (srcRate === dstRate) return input;
  const ratio = srcRate / dstRate;
  const length = Math.floor(input.length / ratio);
  const out = new Float32Array(length);
  const lastIdx = input.length - 1;
  for (let i = 0; i < length; i++) {
    const srcIdx = i * ratio;
    const idx0 = Math.floor(srcIdx);
    const frac = srcIdx - idx0;
    const s0 = input[idx0];
    const s1 = input[Math.min(idx0 + 1, lastIdx)];
    out[i] = s0 + (s1 - s0) * frac;
  }
  return out;
}

/** Strip a RIFF/WAVE header from a buffer, returning the raw PCM body. */
function stripWavHeader(buf: ArrayBuffer): ArrayBuffer {
  const view = new DataView(buf);
  // RIFF....WAVE
  if (view.byteLength < 44) return buf;
  if (view.getUint32(0, false) !== 0x52494646) return buf; // "RIFF"
  if (view.getUint32(8, false) !== 0x57415645) return buf; // "WAVE"
  // Walk chunks until we find "data"
  let offset = 12;
  while (offset + 8 < view.byteLength) {
    const chunkId = view.getUint32(offset, false);
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === 0x64617461) {
      // "data"
      return buf.slice(offset + 8, offset + 8 + chunkSize);
    }
    offset += 8 + chunkSize;
  }
  return buf;
}

export function useAudioPlayback(gateway: UseChatGatewayReturn): UseAudioPlaybackReturn {
  const [flags, dispatch] = useReducer(playbackReducer, INITIAL_FLAGS);

  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const workletReadyRef = useRef<Promise<AudioWorkletNode> | null>(null);
  const moduleUrlRef = useRef<string | null>(null);
  const playbackStateRef = useRef(createAudioPlaybackState());
  const streamGenerationRef = useRef(0);
  const batchSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  // Back-pressure queue: chunks wait here until the worklet has room.
  // (Cartesia generates audio faster than realtime; this absorbs the burst.)
  const chunkQueueRef = useRef<Float32Array[]>([]);
  const queueMsRef = useRef(0);
  const lastReportedFillMsRef = useRef(0);
  const lastReportedAtRef = useRef(0); // audioContext.currentTime
  const pushedSinceReportMsRef = useRef(0);
  // drainQueue is referenced inside ensureWorklet's message handler, but
  // declared after it — bridge the temporal gap with a ref.
  const drainQueueRef = useRef<() => void>(() => {});

  const ensureAudioContext = useCallback((): AudioContext => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }
    if (audioContextRef.current.state === "suspended") {
      void audioContextRef.current.resume();
    }
    return audioContextRef.current;
  }, []);

  const ensureWorklet = useCallback(async (): Promise<AudioWorkletNode> => {
    if (workletNodeRef.current) return workletNodeRef.current;
    if (workletReadyRef.current) return workletReadyRef.current;

    const ctx = ensureAudioContext();
    const promise = (async () => {
      if (!moduleUrlRef.current) {
        const blob = new Blob([AUDIO_PLAYER_WORKLET_SOURCE], {
          type: "text/javascript",
        });
        moduleUrlRef.current = URL.createObjectURL(blob);
        await ctx.audioWorklet.addModule(moduleUrlRef.current);
      }

      const primerSamples = Math.floor((PRIMER_BUFFER_MS / 1000) * ctx.sampleRate);
      const bufferSize = Math.floor((RING_BUFFER_MS / 1000) * ctx.sampleRate);

      const node = new AudioWorkletNode(ctx, "anima-pcm-player", {
        outputChannelCount: [1],
        processorOptions: { primerSamples, bufferSize },
      });

      node.port.onmessage = (e: MessageEvent) => {
        const msg = e.data as { type: "fill"; fillMs: number } | { type: "drained" };
        if (msg.type === "fill") {
          // Update tracking refs so estimateWorkletFillMs stays accurate.
          lastReportedFillMsRef.current = msg.fillMs;
          lastReportedAtRef.current = ctx.currentTime;
          pushedSinceReportMsRef.current = 0;

          const playing = msg.fillMs > 0 || chunkQueueRef.current.length > 0;
          dispatch({ type: "WORKLET_FILL", playing });
          // Buffer drained below watermark? Push more from queue.
          drainQueueRef.current();
        } else if (msg.type === "drained") {
          // Buffer hit empty mid-stream; ring will re-prime on next push.
        }
      };

      node.connect(ctx.destination);
      workletNodeRef.current = node;
      return node;
    })();

    workletReadyRef.current = promise;
    return promise;
  }, [ensureAudioContext]);

  /** Estimated current worklet fill (ms), interpolating between reports. */
  const estimateWorkletFillMs = useCallback((): number => {
    const ctx = audioContextRef.current;
    if (!ctx) return 0;
    const elapsedMs = (ctx.currentTime - lastReportedAtRef.current) * 1000;
    return Math.max(0, lastReportedFillMsRef.current + pushedSinceReportMsRef.current - elapsedMs);
  }, []);

  /** Drain the JS chunk queue into the worklet up to the high watermark. */
  const drainQueue = useCallback(() => {
    const node = workletNodeRef.current;
    const ctx = audioContextRef.current;
    if (!node || !ctx) return;
    while (chunkQueueRef.current.length > 0 && estimateWorkletFillMs() < HIGH_WATERMARK_MS) {
      const samples = chunkQueueRef.current.shift();
      if (!samples) break;
      const chunkMs = (samples.length / ctx.sampleRate) * 1000;
      queueMsRef.current = Math.max(0, queueMsRef.current - chunkMs);
      pushedSinceReportMsRef.current += chunkMs;
      // Transfer the underlying buffer to avoid a copy.
      node.port.postMessage({ type: "pcm", samples }, [samples.buffer]);
    }
  }, [estimateWorkletFillMs]);

  // Keep the ref in sync so ensureWorklet's message handler always calls the latest.
  drainQueueRef.current = drainQueue;

  /** Decode WAV chunk → Float32 → resample → enqueue + drain. */
  const handleStreamingChunk = useCallback(
    async (arrayBuffer: ArrayBuffer, format: string | undefined) => {
      const ctx = ensureAudioContext();
      await ensureWorklet();
      let pcmFloat: Float32Array;
      if (format === "wav") {
        // Strip header so we don't hand RIFF metadata to the worklet.
        const pcmBytes = stripWavHeader(arrayBuffer);
        pcmFloat = pcm16ToFloat32(new Int16Array(pcmBytes));
      } else {
        pcmFloat = pcm16ToFloat32(new Int16Array(arrayBuffer));
      }
      const resampled = resampleLinear(pcmFloat, CARTESIA_SAMPLE_RATE, ctx.sampleRate);
      const chunkMs = (resampled.length / ctx.sampleRate) * 1000;
      chunkQueueRef.current.push(resampled);
      queueMsRef.current += chunkMs;
      drainQueue();
    },
    [ensureAudioContext, ensureWorklet, drainQueue],
  );

  const clearWorkletBuffer = useCallback(() => {
    workletNodeRef.current?.port.postMessage({ type: "reset" });
    chunkQueueRef.current = [];
    queueMsRef.current = 0;
    pushedSinceReportMsRef.current = 0;
    lastReportedFillMsRef.current = 0;
  }, []);

  const stopBatchSources = useCallback(() => {
    for (const src of batchSourcesRef.current) {
      try {
        src.stop();
      } catch {
        // no-op
      }
    }
    batchSourcesRef.current.clear();
  }, []);

  const stop = useCallback(() => {
    clearWorkletBuffer();
    stopBatchSources();
    clearVoiceStreams(playbackStateRef.current);
    streamGenerationRef.current += 1;
    dispatch({ type: "STOPPED" });
    gateway.sendRequest("voice.stop");
  }, [clearWorkletBuffer, stopBatchSources, gateway]);

  // ── Per-event handlers ───────────────────────────────────
  // Each branch of the old `onEvent` callback is now a named function. The
  // event-subscription effect below routes by type. Splitting them up makes
  // each transition obvious at a glance and keeps any single useEffect to
  // ≤1 dispatch per branch.

  const handleStreamStart = useCallback(
    (data: Record<string, unknown>) => {
      const streamId = (data.streamId as string) || "?";
      startVoiceStream(playbackStateRef.current, streamId);
      dispatch({ type: "STREAM_STARTED" });
      // Make sure context + worklet exist before chunks land.
      void ensureWorklet();
    },
    [ensureWorklet],
  );

  const handleAudioChunk = useCallback(
    (data: Record<string, unknown>) => {
      const audio = data.audio as string | undefined;
      const format = data.format as string | undefined;
      const streamId = data.streamId as string | undefined;
      if (!audio) return;
      if (!streamId || !shouldAcceptVoiceChunk(playbackStateRef.current, streamId)) return;

      const generation = streamGenerationRef.current;
      const arrayBuffer = base64ToArrayBuffer(audio);
      void handleStreamingChunk(arrayBuffer, format).then(() => {
        if (generation !== streamGenerationRef.current) {
          // Stream was reset between schedule and push — ring already cleared.
        }
      });
    },
    [handleStreamingChunk],
  );

  const handleStreamEnd = useCallback((data: Record<string, unknown>) => {
    const streamId = (data.streamId as string) || "?";
    if (!shouldAcceptVoiceChunk(playbackStateRef.current, streamId)) return;
    const hasActiveStreams = endVoiceStream(playbackStateRef.current, streamId);
    dispatch({ type: "STREAM_ENDED", hasActiveStreams });
  }, []);

  const handleBatchAudio = useCallback(
    (data: Record<string, unknown>) => {
      const audioData = data.data as string | undefined;
      if (!audioData) return;

      const ctx = ensureAudioContext();
      const arrayBuffer = base64ToArrayBuffer(audioData);

      // Batch playback uses a one-shot AudioBufferSourceNode (no boundaries
      // to worry about). Clear any in-flight stream first.
      clearVoiceStreams(playbackStateRef.current);
      streamGenerationRef.current += 1;
      clearWorkletBuffer();
      stopBatchSources();
      dispatch({ type: "BATCH_STARTED" });
      const generation = streamGenerationRef.current;

      void ctx
        .decodeAudioData(arrayBuffer.slice(0))
        .then((buffer) => {
          if (generation !== streamGenerationRef.current) return;
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          source.connect(ctx.destination);
          batchSourcesRef.current.add(source);
          dispatch({ type: "BATCH_PLAY_STARTED" });
          source.onended = () => {
            batchSourcesRef.current.delete(source);
            if (batchSourcesRef.current.size === 0) {
              dispatch({ type: "BATCH_PLAY_ENDED" });
            }
          };
          source.start();
        })
        .catch((err) => {
          console.warn("[AudioPlayback] Failed to decode batch audio:", err);
        });
    },
    [ensureAudioContext, clearWorkletBuffer, stopBatchSources],
  );

  // Subscribe to voice events — pure dispatcher now.
  useEffect(() => {
    return gateway.onEvent((event: string, payload: unknown) => {
      const data = payload as Record<string, unknown>;
      switch (event) {
        case "voice.stream_start":
          handleStreamStart(data);
          break;
        case "voice.audio_chunk":
          handleAudioChunk(data);
          break;
        case "voice.stream_end":
          handleStreamEnd(data);
          break;
        case "voice.audio":
          handleBatchAudio(data);
          break;
      }
    });
  }, [gateway, handleStreamStart, handleAudioChunk, handleStreamEnd, handleBatchAudio]);

  // Resume AudioContext when tab becomes visible (browser suspends backgrounded tabs).
  useEffect(() => {
    const onVisible = () => {
      if (
        document.visibilityState === "visible" &&
        audioContextRef.current?.state === "suspended"
      ) {
        void audioContextRef.current.resume();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      stopBatchSources();
      try {
        workletNodeRef.current?.disconnect();
      } catch {
        /* noop */
      }
      workletNodeRef.current = null;
      workletReadyRef.current = null;
      if (moduleUrlRef.current) {
        URL.revokeObjectURL(moduleUrlRef.current);
        moduleUrlRef.current = null;
      }
      if (audioContextRef.current) {
        void audioContextRef.current.close();
        audioContextRef.current = null;
      }
    };
  }, [stopBatchSources]);

  return { isPlaying: flags.isPlaying, isStreaming: flags.isStreaming, stop };
}
