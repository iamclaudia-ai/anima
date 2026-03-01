/**
 * Audio Playback Hook
 *
 * Schedules streaming TTS chunks on a shared timeline so playback stays
 * continuous without manual per-chunk resampling.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import type { UseChatGatewayReturn } from "./useChatGateway";

export interface UseAudioPlaybackReturn {
  /** Whether audio is currently playing */
  isPlaying: boolean;
  /** Whether a voice stream is active (may still be buffering) */
  isStreaming: boolean;
  /** Stop playback and clear queue */
  stop(): void;
}

/** Decode a base64 string to an ArrayBuffer */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function pcm16ToAudioBuffer(
  ctx: AudioContext,
  pcmArrayBuffer: ArrayBuffer,
  sampleRate: number = 24000,
): AudioBuffer {
  const pcmData = new Int16Array(pcmArrayBuffer);
  const audioBuffer = ctx.createBuffer(1, pcmData.length, sampleRate);
  const channelData = audioBuffer.getChannelData(0);

  for (let i = 0; i < pcmData.length; i++) {
    channelData[i] = pcmData[i] / 32768;
  }

  // Small edge fade to reduce clicks between chunk boundaries.
  const fadeSamples = Math.min(64, Math.floor(pcmData.length / 4));
  for (let i = 0; i < fadeSamples; i++) {
    const gain = i / Math.max(1, fadeSamples);
    channelData[i] *= gain;
    channelData[channelData.length - 1 - i] *= gain;
  }

  return audioBuffer;
}

export function useAudioPlayback(gateway: UseChatGatewayReturn): UseAudioPlaybackReturn {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const isPlayingRef = useRef(false);
  const isStreamingRef = useRef(false);
  const playbackCursorRef = useRef(0);

  /** Ensure AudioContext is initialized and resumed */
  const ensureAudioContext = useCallback((): AudioContext => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }
    if (audioContextRef.current.state === "suspended") {
      void audioContextRef.current.resume();
    }
    return audioContextRef.current;
  }, []);

  const onSourceEnded = useCallback(() => {
    if (activeSourcesRef.current.size > 0) return;

    isPlayingRef.current = false;
    setIsPlaying(false);
    if (!isStreamingRef.current) {
      setIsStreaming(false);
    }
  }, []);

  const chunkCounterRef = useRef(0);

  const scheduleBuffer = useCallback(
    (buffer: AudioBuffer) => {
      const ctx = ensureAudioContext();
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);

      const now = ctx.currentTime;
      const startAt = Math.max(playbackCursorRef.current, now + 0.01);
      const gap = startAt - now;
      playbackCursorRef.current = startAt + buffer.duration;
      const chunkNum = ++chunkCounterRef.current;

      console.log(
        `[Audio] #${chunkNum} dur=${buffer.duration.toFixed(3)}s startAt=${startAt.toFixed(3)} now=${now.toFixed(3)} gap=${gap.toFixed(3)}s cursor→${playbackCursorRef.current.toFixed(3)} queued=${activeSourcesRef.current.size}`,
      );

      activeSourcesRef.current.add(source);
      isPlayingRef.current = true;
      setIsPlaying(true);

      source.onended = () => {
        activeSourcesRef.current.delete(source);
        onSourceEnded();
      };

      source.start(startAt);
    },
    [ensureAudioContext, onSourceEnded],
  );

  /** Stop playback and clear all scheduled sources */
  const stop = useCallback(() => {
    for (const source of activeSourcesRef.current) {
      try {
        source.stop();
      } catch {
        // no-op
      }
    }
    activeSourcesRef.current.clear();

    isPlayingRef.current = false;
    isStreamingRef.current = false;
    playbackCursorRef.current = 0;
    setIsPlaying(false);
    setIsStreaming(false);

    gateway.sendRequest("voice.stop");
  }, [gateway]);

  // Subscribe to voice events
  useEffect(() => {
    return gateway.onEvent((event: string, payload: unknown) => {
      const data = payload as Record<string, unknown>;

      if (event === "voice.stream_start") {
        const ctx = ensureAudioContext();
        const streamId = (data.streamId as string) || "?";

        isStreamingRef.current = true;
        setIsStreaming(true);
        const oldCursor = playbackCursorRef.current;
        playbackCursorRef.current = Math.max(playbackCursorRef.current, ctx.currentTime + 0.02);
        console.log(
          `[Audio] STREAM_START id=${streamId} now=${ctx.currentTime.toFixed(3)} cursor=${oldCursor.toFixed(3)}→${playbackCursorRef.current.toFixed(3)}`,
        );
        return;
      }

      if (event === "voice.audio_chunk") {
        const audio = data.audio as string | undefined;
        const format = data.format as string | undefined;
        if (!audio) return;
        // Play all audio chunks regardless of streamId — sentences from
        // previous streams should continue playing seamlessly.

        const ctx = ensureAudioContext();
        const arrayBuffer = base64ToArrayBuffer(audio);

        if (format === "wav") {
          void ctx
            .decodeAudioData(arrayBuffer.slice(0))
            .then((buffer) => {
              scheduleBuffer(buffer);
            })
            .catch((err) => {
              console.warn("[AudioPlayback] Failed to decode WAV chunk:", err);
            });
        } else {
          const buffer = pcm16ToAudioBuffer(ctx, arrayBuffer, 24000);
          scheduleBuffer(buffer);
        }
        return;
      }

      if (event === "voice.stream_end") {
        const streamId = (data.streamId as string) || "?";
        console.log(
          `[Audio] STREAM_END id=${streamId} aborted=${data.aborted ?? false} activeSources=${activeSourcesRef.current.size}`,
        );
        // Only mark streaming as done if this wasn't an intermediate stream_end
        // (a new stream_start may have already fired). Check aborted flag for
        // explicit stop requests.
        const aborted = data.aborted as boolean | undefined;
        if (aborted) {
          isStreamingRef.current = false;
          if (!isPlayingRef.current && activeSourcesRef.current.size === 0) {
            setIsStreaming(false);
          }
        }
        // For non-aborted stream_end, let isStreaming stay true — it will
        // clear naturally when the last AudioBufferSourceNode finishes.
        return;
      }

      // Batch mode compatibility (`voice.audio` is full encoded audio: wav/mp3/etc.)
      if (event === "voice.audio") {
        const audioData = data.data as string | undefined;
        if (!audioData) return;

        const ctx = ensureAudioContext();
        const arrayBuffer = base64ToArrayBuffer(audioData);

        isStreamingRef.current = true;
        setIsStreaming(true);

        void ctx
          .decodeAudioData(arrayBuffer.slice(0))
          .then((buffer) => {
            scheduleBuffer(buffer);
          })
          .catch((err) => {
            console.warn("[AudioPlayback] Failed to decode batch audio:", err);
          });
      }
    });
  }, [gateway, ensureAudioContext, scheduleBuffer]);

  // Cleanup AudioContext on unmount
  useEffect(() => {
    return () => {
      for (const source of activeSourcesRef.current) {
        try {
          source.stop();
        } catch {
          // no-op
        }
      }
      activeSourcesRef.current.clear();

      if (audioContextRef.current) {
        void audioContextRef.current.close();
        audioContextRef.current = null;
      }
    };
  }, []);

  return { isPlaying, isStreaming, stop };
}
