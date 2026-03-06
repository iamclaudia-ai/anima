/**
 * Claudia Voice Extension
 *
 * Provides TTS (text-to-speech) capabilities using Cartesia Sonic 3.0.
 * Hooks into session events to speak assistant responses in real-time.
 *
 * Features:
 * - Real-time streaming TTS via Cartesia WebSocket API
 * - Ultra-fast <200ms latency with Sonic 3.0
 * - Emotion controls and voice cloning support
 * - Sentence-level chunking for low-latency speech
 * - Auto-speak assistant responses (configurable)
 * - Audio saving for future playback
 * - Per-connection state isolation (multiple tabs / sessions)
 */

import type {
  ClaudiaExtension,
  ExtensionContext,
  GatewayEvent,
  HealthCheckResponse,
} from "@claudia/shared";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { CartesiaStream } from "./cartesia-stream";
import { SentenceChunker } from "./sentence-chunker";
import { saveAudio, getAudioPath, pcmToWav } from "./audio-store";

// ============================================================================
// File Logging (tail -f ~/.claudia/logs/voice.log)
// ============================================================================

const LOG_DIR = join(homedir(), ".claudia", "logs");
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = join(LOG_DIR, "voice.log");

function fileLog(level: string, msg: string): void {
  try {
    const ts = new Date().toISOString();
    appendFileSync(LOG_FILE, `[${ts}] [${level}] ${msg}\n`);
  } catch {
    // Ignore log write errors
  }
}

// ============================================================================
// Configuration
// ============================================================================

export interface VoiceConfig {
  /** Cartesia API key */
  apiKey?: string;
  /** Cartesia pronunciation dictionary ID */
  dictionaryId?: string;
  /** Voice ID to use */
  voiceId?: string;
  /** Model to use (default: sonic-3) */
  model?: string;
  /** Word count threshold for summarization */
  summarizeThreshold?: number;
  /** Emotion controls like ["positivity:high", "curiosity"] */
  emotions?: string[];
  /** Speed control (0.5-2.0) */
  speed?: number;
  /** Use streaming WebSocket (true) or batch REST API (false) */
  streaming?: boolean;
}

const DEFAULT_CONFIG: Required<VoiceConfig> = {
  apiKey: "",
  dictionaryId: "",
  voiceId: "a0e99841-438c-4a64-b679-ae501e7d6091", // Barbershop - Man
  model: "sonic-3",
  summarizeThreshold: 150,
  emotions: ["positivity:high", "curiosity"],
  speed: 1.0,
  streaming: true,
};

// ============================================================================
// Text Processing Utilities
// ============================================================================

/**
 * Clean text for speech (strip markdown, emojis, etc.)
 */
export function cleanForSpeech(text: string): string {
  return (
    text
      // Remove code blocks entirely (including language specifiers)
      .replace(/```[\s\S]*?```/g, "")
      .replace(/~~~[\s\S]*?~~~/g, "")
      // Remove inline code
      .replace(/`[^`\n]*`/g, "")
      // Remove HTML/XML tags
      .replace(/<[^>]+>/g, "")
      // Remove markdown links, keep text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      // Remove reference-style links
      .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
      // Remove markdown emphasis
      .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, "$1")
      // Remove headers
      .replace(/^#{1,6}\s+/gm, "")
      // Remove strikethrough
      .replace(/~~([^~]+)~~/g, "$1")
      // Remove blockquotes (often contain code/technical content)
      .replace(/^>\s+.*$/gm, "")
      // Remove horizontal rules
      .replace(/^[-*_]{3,}$/gm, "")
      // Remove table syntax
      .replace(/\|.*\|/g, "")
      // Remove emojis
      .replace(
        /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu,
        "",
      )
      // Remove entire list lines (bullets and numbered lists — typically technical)
      .replace(/^[\s]*[-*•]\s+.*$/gm, "")
      .replace(/^[\s]*\d+\s*(?:[.)]|\\\.)\s+.*$/gm, "")
      // Remove URLs (often technical/not worth reading aloud)
      .replace(/https?:\/\/[^\s]+/g, "")
      // Remove file paths and technical identifiers
      .replace(/[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*[:][0-9]+/g, "")
      // Collapse multiple spaces/newlines
      .replace(/\s+/g, " ")
      .trim()
  );
}

// ============================================================================
// Batch TTS (fallback, used for voice.speak method)
// ============================================================================

const CARTESIA_API_BASE = "https://api.cartesia.ai";

async function batchSpeak(text: string, cfg: Required<VoiceConfig>): Promise<Buffer> {
  const voiceConfig: any = {
    mode: "id",
    id: cfg.voiceId,
  };

  // Add experimental controls for emotions and speed
  if (cfg.emotions?.length || cfg.speed !== 1.0) {
    voiceConfig.__experimental_controls = {};

    if (cfg.emotions?.length) {
      voiceConfig.__experimental_controls.emotion = cfg.emotions;
    }

    if (cfg.speed !== 1.0) {
      voiceConfig.__experimental_controls.speed = cfg.speed;
    }
  }

  const res = await fetch(`${CARTESIA_API_BASE}/tts/bytes`, {
    method: "POST",
    headers: {
      "Cartesia-Version": "2024-06-30",
      "X-API-Key": cfg.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model_id: cfg.model,
      transcript: text,
      voice: voiceConfig,
      output_format: {
        container: "wav",
        encoding: "pcm_s16le",
        sample_rate: 24000,
      },
      ...(cfg.dictionaryId ? { pronunciation_dict_id: cfg.dictionaryId } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Cartesia API error ${res.status}: ${body}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

// ============================================================================
// Per-Connection Voice State
// ============================================================================

/** Sentence queue entries carry their own routing context so sentences
 *  from a previous stream continue to synthesize even after a new stream starts. */
interface QueueEntry {
  text: string;
  streamId: string;
  sessionId: string;
  connectionId: string;
}

/** All mutable voice state scoped to a single client connection (tab). */
interface ConnectionVoiceState {
  connectionId: string;
  currentChunker: SentenceChunker | null;
  currentStreamId: string | null;
  currentSessionId: string | null;
  streamGeneration: number;
  streamChunkIndex: number;
  sentenceQueue: QueueEntry[];
  processingQueue: boolean;
  activeSentenceStream: CartesiaStream | null;
  queueDrainResolve: (() => void) | null;
  abortRequested: boolean;
  currentBlockType: string | null;
  textBuffer: string;
  currentAudioChunks: Buffer[];
  isSpeaking: boolean;
}

function createConnectionState(connectionId: string): ConnectionVoiceState {
  return {
    connectionId,
    currentChunker: null,
    currentStreamId: null,
    currentSessionId: null,
    streamGeneration: 0,
    streamChunkIndex: 0,
    sentenceQueue: [],
    processingQueue: false,
    activeSentenceStream: null,
    queueDrainResolve: null,
    abortRequested: false,
    currentBlockType: null,
    textBuffer: "",
    currentAudioChunks: [],
    isSpeaking: false,
  };
}

// ============================================================================
// Voice Extension
// ============================================================================

export function createVoiceExtension(config: VoiceConfig = {}): ClaudiaExtension {
  // Filter out undefined values so they don't override defaults
  const defined = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined));
  const cfg: Required<VoiceConfig> = { ...DEFAULT_CONFIG, ...defined };

  let ctx: ExtensionContext | null = null;
  let unsubscribers: Array<() => void> = [];

  // Per-connection voice state — keyed by connectionId
  const connections = new Map<string, ConnectionVoiceState>();

  function getOrCreateConnection(connectionId: string): ConnectionVoiceState {
    let state = connections.get(connectionId);
    if (!state) {
      state = createConnectionState(connectionId);
      connections.set(connectionId, state);
      fileLog("INFO", `Created voice state for connection=${connectionId}`);
    }
    return state;
  }

  /** Generate a unique stream ID for this utterance */
  function newStreamId(): string {
    return crypto.randomUUID().slice(0, 8);
  }

  /** Get emit options for connection-scoped routing */
  function callerEmitOptions(connectionId: string): { connectionId: string; source: string } {
    return {
      connectionId,
      source: "gateway.caller",
    };
  }

  // --- Per-connection streaming functions ---

  function resolveQueueDrainIfIdle(cs: ConnectionVoiceState): void {
    if (!cs.processingQueue && cs.sentenceQueue.length === 0 && cs.queueDrainResolve) {
      cs.queueDrainResolve();
      cs.queueDrainResolve = null;
    }
  }

  async function waitForQueueDrain(cs: ConnectionVoiceState): Promise<void> {
    if (!cs.processingQueue && cs.sentenceQueue.length === 0) return;
    await new Promise<void>((resolve) => {
      cs.queueDrainResolve = resolve;
    });
  }

  async function sendSentenceToCartesia(
    cs: ConnectionVoiceState,
    sentence: string,
    streamId: string,
    sessionId: string,
    connectionId: string,
  ): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      if (cs.abortRequested) return;

      let streamHadError = false;
      const sentenceStream = new CartesiaStream({
        apiKey: cfg.apiKey,
        voiceId: cfg.voiceId,
        model: cfg.model,
        dictionaryId: cfg.dictionaryId,
        emotions: cfg.emotions,
        speed: cfg.speed,
        log: fileLog,
        onAudioChunk: ({ audio }) => {
          if (cs.abortRequested) return;

          const pcmChunk = Buffer.from(audio, "base64");
          const wavChunk = pcmToWav(pcmChunk, 24000, 1);
          const index = cs.streamChunkIndex++;
          ctx?.emit(
            "voice.audio_chunk",
            { audio: wavChunk.toString("base64"), format: "wav", index, streamId, sessionId },
            callerEmitOptions(connectionId),
          );
          cs.currentAudioChunks.push(pcmChunk);
        },
        onError: (error) => {
          streamHadError = true;
          lastError = error;
        },
        onDone: () => {
          fileLog(
            "INFO",
            `Sentence done: stream=${streamId}, conn=${connectionId}, queued=${cs.sentenceQueue.length}`,
          );
        },
      });

      cs.activeSentenceStream = sentenceStream;
      try {
        await sentenceStream.connect();
        sentenceStream.startStream();
        sentenceStream.sendText(sentence);
        await sentenceStream.endStream();

        if (!streamHadError) {
          return;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      } finally {
        await sentenceStream.close();
        if (cs.activeSentenceStream === sentenceStream) {
          cs.activeSentenceStream = null;
        }
      }

      if (attempt < 2) {
        fileLog(
          "WARN",
          `Sentence send failed, retrying (attempt=${attempt + 1}): ${sentence.substring(0, 80)}`,
        );
      }
    }

    const err = lastError ?? new Error("Failed to send sentence to Cartesia");
    ctx?.emit("voice.error", { error: err.message, streamId }, callerEmitOptions(connectionId));
    fileLog("ERROR", `Dropped sentence after retries: ${err.message}`);
  }

  async function processSentenceQueue(cs: ConnectionVoiceState): Promise<void> {
    if (cs.processingQueue) return;
    cs.processingQueue = true;
    try {
      while (!cs.abortRequested && cs.sentenceQueue.length > 0) {
        const entry = cs.sentenceQueue.shift();
        if (!entry) continue;
        await sendSentenceToCartesia(
          cs,
          entry.text,
          entry.streamId,
          entry.sessionId,
          entry.connectionId,
        );
      }
    } finally {
      cs.processingQueue = false;
      resolveQueueDrainIfIdle(cs);
    }
  }

  function enqueueSentence(cs: ConnectionVoiceState, sentence: string): void {
    if (!cs.currentStreamId || !cs.currentSessionId) return;
    cs.sentenceQueue.push({
      text: sentence,
      streamId: cs.currentStreamId,
      sessionId: cs.currentSessionId,
      connectionId: cs.connectionId,
    });
    void processSentenceQueue(cs);
  }

  async function startStream(cs: ConnectionVoiceState, sessionId: string): Promise<void> {
    if (!cfg.apiKey) {
      fileLog("WARN", "startStream called but no apiKey");
      return;
    }

    // If a previous stream is active, flush its remaining text into the queue
    // but do NOT wait for drain or clear the queue — old sentences keep playing.
    if (cs.currentStreamId && cs.currentChunker) {
      const remaining = cs.currentChunker.flush();
      if (remaining) {
        const cleaned = cleanForSpeech(remaining);
        if (cleaned) {
          fileLog(
            "INFO",
            `startStream: flushing previous stream text before new stream: "${cleaned.substring(0, 80)}"`,
          );
          enqueueSentence(cs, cleaned);
        }
      }
      // Emit stream_end for the old stream so clients can track segments
      ctx?.emit(
        "voice.stream_end",
        { streamId: cs.currentStreamId, sessionId: cs.currentSessionId },
        callerEmitOptions(cs.connectionId),
      );
    }

    const streamId = newStreamId();
    cs.currentStreamId = streamId;
    cs.currentSessionId = sessionId;
    cs.currentAudioChunks = [];
    cs.currentChunker = new SentenceChunker();
    // NOTE: sentenceQueue is NOT cleared — old sentences keep synthesizing
    cs.streamChunkIndex = 0;
    cs.streamGeneration++;
    cs.abortRequested = false;

    fileLog(
      "INFO",
      `startStream: session=${sessionId}, stream=${streamId}, connection=${cs.connectionId}`,
    );

    cs.isSpeaking = true;
    ctx?.emit(
      "voice.stream_start",
      { streamId: cs.currentStreamId, sessionId: cs.currentSessionId },
      callerEmitOptions(cs.connectionId),
    );
    ctx?.log.info(`Streaming TTS started (stream=${cs.currentStreamId}, conn=${cs.connectionId})`);
  }

  async function feedStreamingText(cs: ConnectionVoiceState, text: string): Promise<void> {
    if (!cs.currentChunker || !cs.currentStreamId) return;

    fileLog("INFO", `FEEDING TEXT [conn=${cs.connectionId}]: "${text}"`);
    const sentences = cs.currentChunker.feed(text);
    for (const sentence of sentences) {
      const cleaned = cleanForSpeech(sentence);
      if (cleaned) {
        fileLog("INFO", `SPEAKING SENTENCE [conn=${cs.connectionId}]: "${cleaned}"`);
        enqueueSentence(cs, cleaned);
      }
    }
  }

  async function endStream(cs: ConnectionVoiceState): Promise<void> {
    if (!cs.currentChunker || !cs.currentStreamId) return;

    // Capture generation so we can detect if a new stream started while we await.
    const generation = cs.streamGeneration;
    const streamId = cs.currentStreamId;
    const sessionId = cs.currentSessionId;

    // Flush any remaining text in the chunker
    const remaining = cs.currentChunker.flush();
    if (remaining) {
      const cleaned = cleanForSpeech(remaining);
      if (cleaned) {
        fileLog("INFO", `endStream: flushing remaining text: "${cleaned.substring(0, 80)}"`);
        enqueueSentence(cs, cleaned);
      }
    }

    // Wait until all queued sentences are synthesized.
    fileLog(
      "INFO",
      `endStream: waiting for sentence queue drain (stream=${streamId}, conn=${cs.connectionId})`,
    );
    await waitForQueueDrain(cs);
    fileLog("INFO", `endStream: session ended (stream=${streamId}, conn=${cs.connectionId})`);

    // If a new stream started while we were waiting, don't touch current state.
    if (cs.streamGeneration !== generation) {
      fileLog(
        "INFO",
        `endStream: stale generation (${generation} != ${cs.streamGeneration}), skipping state reset`,
      );
      // Still save audio for this stream segment
      if (streamId && sessionId && cs.currentAudioChunks.length > 0) {
        const fullAudio = Buffer.concat(cs.currentAudioChunks);
        saveAudio(fullAudio, sessionId, streamId).catch(() => {});
      }
      return;
    }

    ctx?.log.info(`Streaming TTS ended (stream=${streamId}, conn=${cs.connectionId})`);

    // Save accumulated audio from all sentences to disk
    if (streamId && sessionId && cs.currentAudioChunks && cs.currentAudioChunks.length > 0) {
      const fullAudio = Buffer.concat(cs.currentAudioChunks);
      saveAudio(fullAudio, sessionId, streamId)
        .then((path) => {
          ctx?.log.info(
            `Full response audio saved: ${path} (${(fullAudio.length / 1024).toFixed(1)}KB)`,
          );
        })
        .catch((err) => {
          ctx?.log.error(`Failed to save full audio: ${err.message}`);
        });
    }

    // Signal stream end to clients
    if (streamId) {
      ctx?.emit("voice.stream_end", { streamId, sessionId }, callerEmitOptions(cs.connectionId));
    }

    // Reset streaming state — safe because generation matches.
    cs.isSpeaking = false;
    cs.currentChunker = null;
    cs.currentStreamId = null;
    cs.currentSessionId = null;
    cs.currentAudioChunks = [];
    cs.streamChunkIndex = 0;

    // Clean up connection state if fully idle
    if (!cs.processingQueue && cs.sentenceQueue.length === 0) {
      connections.delete(cs.connectionId);
      fileLog("INFO", `Cleaned up voice state for connection=${cs.connectionId}`);
    }
  }

  function abortStream(cs: ConnectionVoiceState): void {
    const streamId = cs.currentStreamId;
    fileLog("INFO", `Aborting stream: stream=${streamId || "none"}, conn=${cs.connectionId}`);

    // Signal abort to clients
    if (streamId) {
      ctx?.emit(
        "voice.stream_end",
        { streamId, sessionId: cs.currentSessionId, aborted: true },
        callerEmitOptions(cs.connectionId),
      );
      ctx?.log.info(`Streaming TTS aborted (stream=${streamId}, conn=${cs.connectionId})`);
    }

    cs.abortRequested = true;
    cs.sentenceQueue = [];
    cs.streamGeneration++; // invalidate any in-flight endStream()
    resolveQueueDrainIfIdle(cs);
    cs.activeSentenceStream?.abort();
    cs.activeSentenceStream = null;

    cs.isSpeaking = false;
    cs.currentChunker = null;
    cs.currentStreamId = null;
    cs.currentSessionId = null;
    cs.currentAudioChunks = [];
    cs.streamChunkIndex = 0;

    connections.delete(cs.connectionId);
    fileLog("INFO", `Cleaned up voice state for connection=${cs.connectionId}`);
  }

  /** Abort all active connections (used on extension stop) */
  function abortAll(): void {
    for (const cs of connections.values()) {
      abortStream(cs);
    }
    connections.clear();
  }

  // --- Batch TTS (for voice.speak method) ---

  async function speakBatch(text: string): Promise<void> {
    if (!cfg.apiKey) {
      throw new Error("No CARTESIA_API_KEY configured");
    }

    if (!text.trim()) return;

    ctx?.emit("voice.speaking", { text: text.substring(0, 100) });

    try {
      const audioBuffer = await batchSpeak(text, cfg);
      const base64Audio = audioBuffer.toString("base64");
      ctx?.emit("voice.audio", {
        format: "wav",
        data: base64Audio,
        text: text.substring(0, 100),
      });
      ctx?.emit("voice.done", { text: text.substring(0, 100) });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      ctx?.log.error(`Batch TTS error: ${errorMsg}`);
      ctx?.emit("voice.error", { error: errorMsg });
      throw error;
    }
  }

  // ============================================================================
  // Extension Implementation
  // ============================================================================

  return {
    id: "voice",
    name: "Voice (TTS)",
    methods: [
      {
        name: "voice.speak",
        description: "Synthesize text to speech and emit a voice.audio event",
        inputSchema: z.object({
          text: z.string().min(1),
        }),
      },
      {
        name: "voice.stop",
        description: "Stop active streaming TTS playback for the current stream",
        inputSchema: z.object({}),
      },
      {
        name: "voice.status",
        description: "Get current voice extension status and active stream state",
        inputSchema: z.object({}),
      },
      {
        name: "voice.replay",
        description: "Replay previously saved response audio by session and stream id",
        inputSchema: z.object({
          sessionId: z.string().min(1),
          streamId: z.string().min(1),
        }),
      },
      {
        name: "voice.health_check",
        description: "Return standardized health_check payload for Voice extension",
        inputSchema: z.object({}),
      },
    ],
    events: [
      "voice.speaking",
      "voice.done",
      "voice.audio",
      "voice.error", // batch compat
      "voice.stream_start",
      "voice.audio_chunk",
      "voice.stream_end", // streaming
    ],

    async start(context: ExtensionContext) {
      ctx = context;
      fileLog(
        "INFO",
        `Voice extension starting (streaming=${cfg.streaming}, apiKey=${!!cfg.apiKey}, voice=${cfg.voiceId}, dictionaryId=${cfg.dictionaryId || "none"})`,
      );
      ctx.log.info("Starting voice extension...");

      if (!cfg.apiKey) {
        ctx.log.warn("No CARTESIA_API_KEY - TTS will not work");
      } else {
        ctx.log.info(
          `Cartesia configured (voice=${cfg.voiceId}, streaming=${cfg.streaming}, model=${cfg.model})`,
        );
      }

      // --- Event Subscriptions ---
      // Voice activates when events carry the "voice.speak" tag on the envelope.
      // Tags are set by the client (e.g., web chat sends tags: ["voice.speak"]).
      // State is tracked per connectionId so multiple tabs and non-voiced
      // sessions (e.g., Libby) never interfere with each other.

      // Track content block type — start streaming if voice.speak tag present.
      unsubscribers.push(
        ctx.on("session.*.content_block_start", (event: GatewayEvent) => {
          const wantsVoice = event.tags?.includes("voice.speak") ?? false;
          if (!wantsVoice || !event.connectionId) return;

          const payload = event.payload as {
            content_block?: { type: string };
            sessionId?: string;
          };
          const blockType = payload.content_block?.type || null;

          const cs = getOrCreateConnection(event.connectionId);
          cs.currentBlockType = blockType;

          fileLog(
            "INFO",
            `content_block_start: type=${blockType}, conn=${event.connectionId}, session=${payload.sessionId || event.sessionId || "?"}`,
          );

          if (cs.currentBlockType === "text") {
            cs.textBuffer = "";

            if (cfg.streaming && cfg.apiKey) {
              const sessionId = payload.sessionId || event.sessionId || "unknown";
              startStream(cs, sessionId);
            }
          }
        }),
      );

      // Process text deltas — only for voiced events
      unsubscribers.push(
        ctx.on("session.*.content_block_delta", (event: GatewayEvent) => {
          const wantsVoice = event.tags?.includes("voice.speak") ?? false;
          if (!wantsVoice || !event.connectionId) return;

          const cs = connections.get(event.connectionId);
          if (!cs || cs.currentBlockType !== "text") return;

          const payload = event.payload as {
            delta?: { type: string; text?: string };
          };

          if (payload.delta?.type === "text_delta" && payload.delta.text) {
            const deltaText = payload.delta.text;
            cs.textBuffer += deltaText;

            // Stream text to Cartesia in real-time
            if (cfg.streaming && cs.currentStreamId) {
              feedStreamingText(cs, deltaText).catch((err) => {
                fileLog("ERROR", `feedStreamingText error: ${err.message}`);
              });
            }
          }
        }),
      );

      // On message complete — only for voiced events
      unsubscribers.push(
        ctx.on("session.*.message_stop", async (event: GatewayEvent) => {
          const wantsVoice = event.tags?.includes("voice.speak") ?? false;
          if (!wantsVoice || !event.connectionId) return;

          const cs = connections.get(event.connectionId);
          if (!cs) return;

          fileLog(
            "INFO",
            `message_stop: conn=${cs.connectionId}, hasActiveStream=${!!cs.currentStreamId}, textBuffer=${cs.textBuffer.length} chars`,
          );

          if (cfg.streaming && cs.currentStreamId) {
            await endStream(cs);
          } else if (!cfg.streaming && cs.textBuffer && cs.currentStreamId) {
            const cleaned = cleanForSpeech(cs.textBuffer);
            if (cleaned) {
              await speakBatch(cleaned);
            }
          }

          // Reset for next content block
          cs.textBuffer = "";
          cs.currentBlockType = null;
        }),
      );

      ctx.log.info("Voice extension started");
    },

    async stop() {
      ctx?.log.info("Stopping voice extension...");

      // Abort all active connection streams
      abortAll();

      for (const unsub of unsubscribers) {
        unsub();
      }
      unsubscribers = [];
      ctx = null;
    },

    async handleMethod(method: string, params: Record<string, unknown>) {
      switch (method) {
        case "voice.speak": {
          const text = params.text as string;
          if (!text) throw new Error('Missing "text" parameter');
          const cleaned = cleanForSpeech(text);
          if (!cfg.apiKey) throw new Error("No CARTESIA_API_KEY configured");
          await speakBatch(cleaned);
          return { ok: true };
        }

        case "voice.stop": {
          // Stop all active streams (could be refined to stop by connectionId)
          abortAll();
          return { ok: true };
        }

        case "voice.status": {
          const activeConnections = Array.from(connections.entries()).map(([connId, cs]) => ({
            connectionId: connId,
            speaking: cs.isSpeaking,
            activeStream: cs.currentStreamId,
            sessionId: cs.currentSessionId,
            queueLength: cs.sentenceQueue.length,
          }));
          return {
            streaming: cfg.streaming,
            voiceId: cfg.voiceId,
            model: cfg.model,
            activeConnections,
          };
        }

        case "voice.replay": {
          const sessionId = params.sessionId as string;
          const streamId = params.streamId as string;
          if (!sessionId || !streamId) throw new Error("Missing sessionId or streamId");

          const path = getAudioPath(sessionId, streamId);
          if (!path) throw new Error("Audio not found");

          const audio = await Bun.file(path).arrayBuffer();
          ctx?.emit("voice.audio", {
            format: "wav",
            data: Buffer.from(audio).toString("base64"),
            streamId,
          });
          return { ok: true };
        }

        case "voice.health_check": {
          const anyActive = Array.from(connections.values()).some((cs) => cs.isSpeaking);
          const response: HealthCheckResponse = {
            ok: !!cfg.apiKey,
            status: cfg.apiKey ? "healthy" : "disconnected",
            label: "Voice (Cartesia)",
            metrics: [
              { label: "Streaming", value: cfg.streaming ? "on" : "off" },
              { label: "Voice", value: cfg.voiceId },
              { label: "Model", value: cfg.model },
              { label: "Emotions", value: cfg.emotions?.join(", ") || "none" },
              { label: "Speed", value: cfg.speed?.toString() || "1.0" },
              { label: "Speaking", value: anyActive ? "yes" : "no" },
              { label: "Connections", value: connections.size.toString() },
            ],
          };
          return response;
        }

        default:
          throw new Error(`Unknown method: ${method}`);
      }
    },

    health() {
      const anyActive = Array.from(connections.values()).some((cs) => cs.isSpeaking);
      return {
        ok: !!cfg.apiKey,
        details: {
          apiKeyConfigured: !!cfg.apiKey,
          streaming: cfg.streaming,
          voiceId: cfg.voiceId,
          speaking: anyActive,
          activeConnections: connections.size,
        },
      };
    },
  };
}

export default createVoiceExtension;

// ── Direct execution with HMR ────────────────────────────────
import { runExtensionHost } from "@claudia/extension-host";
if (import.meta.main) runExtensionHost(createVoiceExtension);
