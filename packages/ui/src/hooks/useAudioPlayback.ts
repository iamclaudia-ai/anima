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

import { useCallback, useEffect, useRef, useState } from "react";
import type { UseChatGatewayReturn } from "./useChatGateway";
import {
  clearVoiceStreams,
  createAudioPlaybackState,
  endVoiceStream,
  shouldAcceptVoiceChunk,
  startVoiceStream,
} from "./audioPlaybackState";
import { getAudioConfig, setAudioStatus, subscribeAudioConfig } from "./audioConfig";
import { AUDIO_PLAYER_WORKLET_SOURCE } from "./audioPlayerWorklet";

const CARTESIA_SAMPLE_RATE = 24000;

export interface UseAudioPlaybackReturn {
  /** Whether audio is currently playing (ring buffer non-empty + past primer). */
  isPlaying: boolean;
  /** Whether a voice stream is active (may still be buffering). */
  isStreaming: boolean;
  /** Stop playback and clear the ring buffer. */
  stop(): void;
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
  const [isPlaying, setIsPlaying] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const workletReadyRef = useRef<Promise<AudioWorkletNode> | null>(null);
  const moduleUrlRef = useRef<string | null>(null);
  const playbackStateRef = useRef(createAudioPlaybackState());
  const isPlayingRef = useRef(false);
  const isStreamingRef = useRef(false);
  const streamGenerationRef = useRef(0);
  const batchSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

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

      const cfg = getAudioConfig();
      const primerSamples = Math.floor((cfg.primerBufferMs / 1000) * ctx.sampleRate);
      const bufferSize = Math.floor((cfg.ringBufferMs / 1000) * ctx.sampleRate);

      const node = new AudioWorkletNode(ctx, "anima-pcm-player", {
        outputChannelCount: [1],
        processorOptions: { primerSamples, bufferSize },
      });

      node.port.onmessage = (e: MessageEvent) => {
        const msg = e.data as
          | { type: "fill"; fillMs: number; underruns: number; overflows: number }
          | { type: "drained" };
        if (msg.type === "fill") {
          setAudioStatus({
            fillMs: msg.fillMs,
            underruns: msg.underruns,
            overflows: msg.overflows,
          });
          const playing = msg.fillMs > 0;
          if (playing !== isPlayingRef.current) {
            isPlayingRef.current = playing;
            setIsPlaying(playing);
          }
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

  /** Push a Float32 PCM block (already at AudioContext sample rate) to the worklet. */
  const pushPcm = useCallback((samples: Float32Array) => {
    const node = workletNodeRef.current;
    if (!node) return;
    // Transfer the underlying buffer to avoid a copy.
    node.port.postMessage({ type: "pcm", samples }, [samples.buffer]);
  }, []);

  /** Decode WAV chunk → Float32 → resample → push. */
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
      pushPcm(resampled);
    },
    [ensureAudioContext, ensureWorklet, pushPcm],
  );

  const clearWorkletBuffer = useCallback(() => {
    workletNodeRef.current?.port.postMessage({ type: "reset" });
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
    isPlayingRef.current = false;
    isStreamingRef.current = false;
    setIsPlaying(false);
    setIsStreaming(false);
    setAudioStatus({ fillMs: 0 });
    gateway.sendRequest("voice.stop");
  }, [clearWorkletBuffer, stopBatchSources, gateway]);

  // Push live config changes to the worklet (primer can be tuned live).
  useEffect(() => {
    return subscribeAudioConfig(() => {
      const node = workletNodeRef.current;
      if (!node) return;
      const ctx = audioContextRef.current;
      if (!ctx) return;
      const cfg = getAudioConfig();
      const primerSamples = Math.floor((cfg.primerBufferMs / 1000) * ctx.sampleRate);
      node.port.postMessage({ type: "config", primerSamples });
      // ringBufferMs requires recreating the node — skip live mutation for that.
    });
  }, []);

  // Subscribe to voice events
  useEffect(() => {
    return gateway.onEvent((event: string, payload: unknown) => {
      const data = payload as Record<string, unknown>;

      if (event === "voice.stream_start") {
        const streamId = (data.streamId as string) || "?";
        startVoiceStream(playbackStateRef.current, streamId);
        isStreamingRef.current = true;
        setIsStreaming(true);
        // Make sure context + worklet exist before chunks land.
        void ensureWorklet();
        return;
      }

      if (event === "voice.audio_chunk") {
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
        return;
      }

      if (event === "voice.stream_end") {
        const streamId = (data.streamId as string) || "?";
        if (!shouldAcceptVoiceChunk(playbackStateRef.current, streamId)) return;
        const hasActiveStreams = endVoiceStream(playbackStateRef.current, streamId);
        isStreamingRef.current = hasActiveStreams;
        setIsStreaming(hasActiveStreams);
        return;
      }

      // Batch mode: full encoded audio (wav/mp3/etc.) in one event.
      if (event === "voice.audio") {
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
        isStreamingRef.current = true;
        setIsStreaming(true);
        const generation = streamGenerationRef.current;

        void ctx
          .decodeAudioData(arrayBuffer.slice(0))
          .then((buffer) => {
            if (generation !== streamGenerationRef.current) return;
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(ctx.destination);
            batchSourcesRef.current.add(source);
            isPlayingRef.current = true;
            setIsPlaying(true);
            source.onended = () => {
              batchSourcesRef.current.delete(source);
              if (batchSourcesRef.current.size === 0) {
                isPlayingRef.current = false;
                setIsPlaying(false);
                if (!isStreamingRef.current) setIsStreaming(false);
              }
            };
            source.start();
          })
          .catch((err) => {
            console.warn("[AudioPlayback] Failed to decode batch audio:", err);
          });
      }
    });
  }, [
    gateway,
    ensureWorklet,
    handleStreamingChunk,
    ensureAudioContext,
    clearWorkletBuffer,
    stopBatchSources,
  ]);

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

  return { isPlaying, isStreaming, stop };
}
