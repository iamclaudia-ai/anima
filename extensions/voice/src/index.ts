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
  AnimaExtension,
  ExtensionContext,
  GatewayEvent,
  HealthCheckResponse,
  LoggerLike,
} from "@anima/shared";
import { createStandardExtension } from "@anima/extension-host";
import { z } from "zod";
import { CartesiaStream } from "./cartesia-stream";
import { SentenceChunker } from "./sentence-chunker";
import { saveAudio, getAudioPath, pcmToWav } from "./audio-store";

const noopLogger: LoggerLike = {
  info() {},
  warn() {},
  error() {},
  child: () => noopLogger,
};

function loggerFileLog(logger: LoggerLike, level: string, msg: string): void {
  if (level === "ERROR") logger.error(msg);
  else if (level === "WARN") logger.warn(msg);
  else logger.info(msg);
}

function connectionFileLog(cs: ConnectionVoiceState, level: string, msg: string): void {
  loggerFileLog(cs.traceLog, level, msg);
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

function normalizeLineForListDetection(line: string): string {
  let normalized = line.trimStart();
  normalized = normalized.replace(/^(?:>\s*)+/, "");

  // Strip leading markdown decorators so patterns like "**1. item**" are
  // evaluated as "1. item" for list detection.
  while (true) {
    const next = normalized.replace(/^(?:\*\*|__|\*|_|`|~~)+/, "").trimStart();
    if (next === normalized) break;
    normalized = next;
  }

  return normalized;
}

function isListLine(line: string): boolean {
  const normalized = normalizeLineForListDetection(line);
  return /^[\s]*[-*+•]\s+/.test(normalized) || /^[\s]*\d+\s*(?:[.)]|\\\.)\s+/.test(normalized);
}

function isFenceLine(line: string): boolean {
  return /^(?:```|~~~)/.test(line.trimStart());
}

export class StreamingSpeechFilter {
  private lineBuffer = "";
  private inCodeFence = false;

  feed(text: string): string {
    this.lineBuffer += text;
    return this.drainCompleteLines(false);
  }

  flush(): string {
    return this.drainCompleteLines(true);
  }

  reset(): void {
    this.lineBuffer = "";
    this.inCodeFence = false;
  }

  private drainCompleteLines(forceRemainder: boolean): string {
    const out: string[] = [];
    let newlineIndex = this.lineBuffer.indexOf("\n");

    while (newlineIndex !== -1) {
      const rawLine = this.lineBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      const kept = this.processLine(rawLine);
      if (kept !== null) out.push(`${kept}\n`);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }

    if (forceRemainder && this.lineBuffer.length > 0) {
      const rawLine = this.lineBuffer.replace(/\r$/, "");
      this.lineBuffer = "";
      const kept = this.processLine(rawLine);
      if (kept !== null) out.push(kept);
    }

    return out.join("\n");
  }

  private processLine(line: string): string | null {
    if (isFenceLine(line)) {
      this.inCodeFence = !this.inCodeFence;
      return null;
    }

    if (this.inCodeFence) {
      return null;
    }

    if (isListLine(line)) {
      return null;
    }

    return line;
  }
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
  const filter = new StreamingSpeechFilter();
  const filtered = [filter.feed(text), filter.flush()].filter(Boolean).join("\n");

  return (
    filtered
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
      .replace(/^[\s]*[-*+•]\s+.*$/gm, "")
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
  traceLog: LoggerLike;
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
  streamingFilter: StreamingSpeechFilter;
}

function createConnectionState(connectionId: string, traceLog: LoggerLike): ConnectionVoiceState {
  return {
    connectionId,
    traceLog,
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
    streamingFilter: new StreamingSpeechFilter(),
  };
}

// ============================================================================
// Voice Extension
// ============================================================================

interface VoiceExtensionRuntime {
  manager: VoiceConnectionManager;
  traceLog: LoggerLike;
  unsubscribers: Array<() => void>;
}

class VoiceConnectionManager {
  private readonly connections = new Map<string, ConnectionVoiceState>();

  constructor(
    private readonly ctx: ExtensionContext,
    private readonly cfg: Required<VoiceConfig>,
  ) {}

  handleContentBlockStart(event: GatewayEvent): void {
    const wantsVoice = event.tags?.includes("voice.speak") ?? false;
    if (!wantsVoice || !event.connectionId) return;

    const payload = event.payload as {
      content_block?: { type: string };
      sessionId?: string;
    };
    const blockType = payload.content_block?.type || null;
    const cs = this.getOrCreateConnection(event.connectionId);
    cs.currentBlockType = blockType;

    connectionFileLog(
      cs,
      "INFO",
      `content_block_start: type=${blockType}, conn=${event.connectionId}, session=${payload.sessionId || event.sessionId || "?"}`,
    );

    if (cs.currentBlockType === "text") {
      cs.textBuffer = "";
      if (this.cfg.streaming && this.cfg.apiKey) {
        const sessionId = payload.sessionId || event.sessionId || "unknown";
        void this.startStream(cs, sessionId).catch((error) => {
          connectionFileLog(cs, "ERROR", `startStream error: ${String(error)}`);
        });
      }
    }
  }

  handleContentBlockDelta(event: GatewayEvent): void {
    const wantsVoice = event.tags?.includes("voice.speak") ?? false;
    if (!wantsVoice || !event.connectionId) return;

    const cs = this.connections.get(event.connectionId);
    if (!cs || cs.currentBlockType !== "text") return;

    const payload = event.payload as {
      delta?: { type: string; text?: string };
    };
    if (payload.delta?.type !== "text_delta" || !payload.delta.text) return;

    const deltaText = payload.delta.text;
    cs.textBuffer += deltaText;

    if (this.cfg.streaming && cs.currentStreamId) {
      void this.feedStreamingText(cs, deltaText).catch((err) => {
        connectionFileLog(cs, "ERROR", `feedStreamingText error: ${err.message}`);
      });
    }
  }

  async handleMessageStop(event: GatewayEvent): Promise<void> {
    const wantsVoice = event.tags?.includes("voice.speak") ?? false;
    if (!wantsVoice || !event.connectionId) return;

    const cs = this.connections.get(event.connectionId);
    if (!cs) return;

    connectionFileLog(
      cs,
      "INFO",
      `message_stop: conn=${cs.connectionId}, hasActiveStream=${!!cs.currentStreamId}, textBuffer=${cs.textBuffer.length} chars`,
    );

    if (this.cfg.streaming && cs.currentStreamId) {
      await this.endStream(cs);
    } else if (!this.cfg.streaming && cs.textBuffer && cs.currentStreamId) {
      const cleaned = cleanForSpeech(cs.textBuffer);
      if (cleaned) {
        await this.speakBatch(cleaned);
      }
    }

    cs.textBuffer = "";
    cs.currentBlockType = null;
  }

  async speakBatch(text: string): Promise<void> {
    if (!this.cfg.apiKey) {
      throw new Error("No CARTESIA_API_KEY configured");
    }

    if (!text.trim()) return;

    this.ctx.emit("voice.speaking", { text: text.substring(0, 100) });

    try {
      const audioBuffer = await batchSpeak(text, this.cfg);
      const base64Audio = audioBuffer.toString("base64");
      this.ctx.emit("voice.audio", {
        format: "wav",
        data: base64Audio,
        text: text.substring(0, 100),
      });
      this.ctx.emit("voice.done", { text: text.substring(0, 100) });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      this.ctx.log.error(`Batch TTS error: ${errorMsg}`);
      this.ctx.emit("voice.error", { error: errorMsg });
      throw error;
    }
  }

  async replay(sessionId: string, streamId: string): Promise<void> {
    const path = getAudioPath(sessionId, streamId);
    if (!path) throw new Error("Audio not found");

    const audio = await Bun.file(path).arrayBuffer();
    this.ctx.emit("voice.audio", {
      format: "wav",
      data: Buffer.from(audio).toString("base64"),
      sessionId,
      streamId,
    });
  }

  stopForConnection(connectionId: string | null): void {
    if (connectionId) {
      const state = this.connections.get(connectionId);
      if (state) {
        this.abortStream(state);
      }
      return;
    }
    this.abortAll();
  }

  abortAll(): void {
    for (const cs of this.connections.values()) {
      this.abortStream(cs);
    }
    this.connections.clear();
  }

  getStatus(): {
    streaming: boolean;
    voiceId: string;
    model: string;
    activeConnections: Array<{
      connectionId: string;
      speaking: boolean;
      activeStream: string | null;
      sessionId: string | null;
      queueLength: number;
    }>;
  } {
    return {
      streaming: this.cfg.streaming,
      voiceId: this.cfg.voiceId,
      model: this.cfg.model,
      activeConnections: Array.from(this.connections.entries()).map(([connId, cs]) => ({
        connectionId: connId,
        speaking: cs.isSpeaking,
        activeStream: cs.currentStreamId,
        sessionId: cs.currentSessionId,
        queueLength: cs.sentenceQueue.length,
      })),
    };
  }

  buildHealthCheck(): HealthCheckResponse {
    return {
      ok: !!this.cfg.apiKey,
      status: this.cfg.apiKey ? "healthy" : "degraded",
      label: "Voice (Cartesia)",
      metrics: [
        { label: "Streaming", value: this.cfg.streaming ? "on" : "off" },
        { label: "Voice", value: this.cfg.voiceId },
        { label: "Model", value: this.cfg.model },
        { label: "Emotions", value: this.cfg.emotions?.join(", ") || "none" },
        { label: "Speed", value: this.cfg.speed?.toString() || "1.0" },
        { label: "Speaking", value: this.hasActiveSpeech() ? "yes" : "no" },
        { label: "Connections", value: this.connections.size.toString() },
      ],
    };
  }

  buildRuntimeHealth() {
    return {
      ok: !!this.cfg.apiKey,
      details: {
        apiKeyConfigured: !!this.cfg.apiKey,
        streaming: this.cfg.streaming,
        voiceId: this.cfg.voiceId,
        speaking: this.hasActiveSpeech(),
        activeConnections: this.connections.size,
      },
    };
  }

  private hasActiveSpeech(): boolean {
    return Array.from(this.connections.values()).some((cs) => cs.isSpeaking);
  }

  private getOrCreateConnection(connectionId: string): ConnectionVoiceState {
    let state = this.connections.get(connectionId);
    if (!state) {
      const connectionTraceLog = this.ctx.createLogger({
        component: `conn:${connectionId.slice(0, 8)}`,
        fileName: `voice-${connectionId}.log`,
      });
      state = createConnectionState(connectionId, connectionTraceLog);
      this.connections.set(connectionId, state);
      connectionFileLog(state, "INFO", `Created voice state for connection=${connectionId}`);
    }
    return state;
  }

  private newStreamId(): string {
    return crypto.randomUUID().slice(0, 8);
  }

  private callerEmitOptions(connectionId: string): { connectionId: string; source: string } {
    return {
      connectionId,
      source: "gateway.caller",
    };
  }

  private resolveQueueDrainIfIdle(cs: ConnectionVoiceState): void {
    if (!cs.processingQueue && cs.sentenceQueue.length === 0 && cs.queueDrainResolve) {
      cs.queueDrainResolve();
      cs.queueDrainResolve = null;
    }
  }

  private async waitForQueueDrain(cs: ConnectionVoiceState): Promise<void> {
    if (!cs.processingQueue && cs.sentenceQueue.length === 0) return;
    await new Promise<void>((resolve) => {
      cs.queueDrainResolve = resolve;
    });
  }

  private async sendSentenceToCartesia(
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
        apiKey: this.cfg.apiKey,
        voiceId: this.cfg.voiceId,
        model: this.cfg.model,
        dictionaryId: this.cfg.dictionaryId,
        emotions: this.cfg.emotions,
        speed: this.cfg.speed,
        log: (level, msg) => connectionFileLog(cs, level, msg),
        onAudioChunk: ({ audio }) => {
          if (cs.abortRequested) return;

          const pcmChunk = Buffer.from(audio, "base64");
          const wavChunk = pcmToWav(pcmChunk, 24000, 1);
          const index = cs.streamChunkIndex++;
          this.ctx.emit(
            "voice.audio_chunk",
            { audio: wavChunk.toString("base64"), format: "wav", index, streamId, sessionId },
            this.callerEmitOptions(connectionId),
          );
          cs.currentAudioChunks.push(pcmChunk);
        },
        onError: (error) => {
          streamHadError = true;
          lastError = error;
        },
        onDone: () => {
          connectionFileLog(
            cs,
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
        connectionFileLog(
          cs,
          "WARN",
          `Sentence send failed, retrying (attempt=${attempt + 1}): ${sentence.substring(0, 80)}`,
        );
      }
    }

    const err = lastError ?? new Error("Failed to send sentence to Cartesia");
    this.ctx.emit(
      "voice.error",
      { error: err.message, streamId },
      this.callerEmitOptions(connectionId),
    );
    connectionFileLog(cs, "ERROR", `Dropped sentence after retries: ${err.message}`);
  }

  private async processSentenceQueue(cs: ConnectionVoiceState): Promise<void> {
    if (cs.processingQueue) return;
    cs.processingQueue = true;
    try {
      while (!cs.abortRequested && cs.sentenceQueue.length > 0) {
        const entry = cs.sentenceQueue.shift();
        if (!entry) continue;
        await this.sendSentenceToCartesia(
          cs,
          entry.text,
          entry.streamId,
          entry.sessionId,
          entry.connectionId,
        );
      }
    } finally {
      cs.processingQueue = false;
      this.resolveQueueDrainIfIdle(cs);
    }
  }

  private enqueueSentence(cs: ConnectionVoiceState, sentence: string): void {
    if (!cs.currentStreamId || !cs.currentSessionId) return;
    cs.sentenceQueue.push({
      text: sentence,
      streamId: cs.currentStreamId,
      sessionId: cs.currentSessionId,
      connectionId: cs.connectionId,
    });
    void this.processSentenceQueue(cs);
  }

  private async startStream(cs: ConnectionVoiceState, sessionId: string): Promise<void> {
    if (!this.cfg.apiKey) {
      connectionFileLog(cs, "WARN", "startStream called but no apiKey");
      return;
    }

    if (cs.currentStreamId && cs.currentChunker) {
      const trailingFiltered = cs.streamingFilter.flush();
      if (trailingFiltered) {
        const trailingSentences = cs.currentChunker.feed(trailingFiltered);
        for (const sentence of trailingSentences) {
          const cleaned = cleanForSpeech(sentence);
          if (cleaned) {
            this.enqueueSentence(cs, cleaned);
          }
        }
      }

      const remaining = cs.currentChunker.flush();
      if (remaining) {
        const cleaned = cleanForSpeech(remaining);
        if (cleaned) {
          connectionFileLog(
            cs,
            "INFO",
            `startStream: flushing previous stream text before new stream: "${cleaned.substring(0, 80)}"`,
          );
          this.enqueueSentence(cs, cleaned);
        }
      }

      this.ctx.emit(
        "voice.stream_end",
        { streamId: cs.currentStreamId, sessionId: cs.currentSessionId },
        this.callerEmitOptions(cs.connectionId),
      );
    }

    const streamId = this.newStreamId();
    cs.currentStreamId = streamId;
    cs.currentSessionId = sessionId;
    cs.currentAudioChunks = [];
    cs.currentChunker = new SentenceChunker();
    cs.streamingFilter.reset();
    cs.streamChunkIndex = 0;
    cs.streamGeneration++;
    cs.abortRequested = false;

    connectionFileLog(
      cs,
      "INFO",
      `startStream: session=${sessionId}, stream=${streamId}, connection=${cs.connectionId}`,
    );

    cs.isSpeaking = true;
    this.ctx.emit(
      "voice.stream_start",
      { streamId: cs.currentStreamId, sessionId: cs.currentSessionId },
      this.callerEmitOptions(cs.connectionId),
    );
    this.ctx.log.info(
      `Streaming TTS started (stream=${cs.currentStreamId}, conn=${cs.connectionId})`,
    );
  }

  private async feedStreamingText(cs: ConnectionVoiceState, text: string): Promise<void> {
    if (!cs.currentChunker || !cs.currentStreamId) return;

    connectionFileLog(cs, "INFO", `FEEDING TEXT [conn=${cs.connectionId}]: "${text}"`);
    const filtered = cs.streamingFilter.feed(text);
    if (!filtered) return;

    const sentences = cs.currentChunker.feed(filtered);
    for (const sentence of sentences) {
      const cleaned = cleanForSpeech(sentence);
      if (cleaned) {
        connectionFileLog(cs, "INFO", `SPEAKING SENTENCE [conn=${cs.connectionId}]: "${cleaned}"`);
        this.enqueueSentence(cs, cleaned);
      }
    }
  }

  private async endStream(cs: ConnectionVoiceState): Promise<void> {
    if (!cs.currentChunker || !cs.currentStreamId) return;

    const generation = cs.streamGeneration;
    const streamId = cs.currentStreamId;
    const sessionId = cs.currentSessionId;

    const trailingFiltered = cs.streamingFilter.flush();
    if (trailingFiltered) {
      const trailingSentences = cs.currentChunker.feed(trailingFiltered);
      for (const sentence of trailingSentences) {
        const cleaned = cleanForSpeech(sentence);
        if (cleaned) {
          connectionFileLog(
            cs,
            "INFO",
            `endStream: flushing trailing text: "${cleaned.substring(0, 80)}"`,
          );
          this.enqueueSentence(cs, cleaned);
        }
      }
    }

    const remaining = cs.currentChunker.flush();
    if (remaining) {
      const cleaned = cleanForSpeech(remaining);
      if (cleaned) {
        connectionFileLog(
          cs,
          "INFO",
          `endStream: flushing remaining text: "${cleaned.substring(0, 80)}"`,
        );
        this.enqueueSentence(cs, cleaned);
      }
    }

    connectionFileLog(
      cs,
      "INFO",
      `endStream: waiting for sentence queue drain (stream=${streamId}, conn=${cs.connectionId})`,
    );
    await this.waitForQueueDrain(cs);
    connectionFileLog(
      cs,
      "INFO",
      `endStream: session ended (stream=${streamId}, conn=${cs.connectionId})`,
    );

    if (cs.streamGeneration !== generation) {
      connectionFileLog(
        cs,
        "INFO",
        `endStream: stale generation (${generation} != ${cs.streamGeneration}), skipping state reset`,
      );
      if (streamId && sessionId && cs.currentAudioChunks.length > 0) {
        const fullAudio = Buffer.concat(cs.currentAudioChunks);
        saveAudio(fullAudio, sessionId, streamId).catch(() => {});
      }
      return;
    }

    this.ctx.log.info(`Streaming TTS ended (stream=${streamId}, conn=${cs.connectionId})`);

    if (streamId && sessionId && cs.currentAudioChunks.length > 0) {
      const fullAudio = Buffer.concat(cs.currentAudioChunks);
      saveAudio(fullAudio, sessionId, streamId)
        .then((path) => {
          this.ctx.log.info(
            `Full response audio saved: ${path} (${(fullAudio.length / 1024).toFixed(1)}KB)`,
          );
        })
        .catch((err) => {
          this.ctx.log.error(`Failed to save full audio: ${err.message}`);
        });
    }

    if (streamId) {
      this.ctx.emit(
        "voice.stream_end",
        { streamId, sessionId },
        this.callerEmitOptions(cs.connectionId),
      );
    }

    cs.isSpeaking = false;
    cs.currentChunker = null;
    cs.currentStreamId = null;
    cs.currentSessionId = null;
    cs.currentAudioChunks = [];
    cs.streamChunkIndex = 0;
    cs.streamingFilter.reset();

    if (!cs.processingQueue && cs.sentenceQueue.length === 0) {
      this.connections.delete(cs.connectionId);
      connectionFileLog(cs, "INFO", `Cleaned up voice state for connection=${cs.connectionId}`);
    }
  }

  private abortStream(cs: ConnectionVoiceState): void {
    const streamId = cs.currentStreamId;
    connectionFileLog(
      cs,
      "INFO",
      `Aborting stream: stream=${streamId || "none"}, conn=${cs.connectionId}`,
    );

    if (streamId) {
      this.ctx.emit(
        "voice.stream_end",
        { streamId, sessionId: cs.currentSessionId, aborted: true },
        this.callerEmitOptions(cs.connectionId),
      );
      this.ctx.log.info(`Streaming TTS aborted (stream=${streamId}, conn=${cs.connectionId})`);
    }

    cs.abortRequested = true;
    cs.sentenceQueue = [];
    cs.streamGeneration++;
    this.resolveQueueDrainIfIdle(cs);
    cs.activeSentenceStream?.abort();
    cs.activeSentenceStream = null;

    cs.isSpeaking = false;
    cs.currentChunker = null;
    cs.currentStreamId = null;
    cs.currentSessionId = null;
    cs.currentAudioChunks = [];
    cs.streamChunkIndex = 0;
    cs.streamingFilter.reset();

    this.connections.delete(cs.connectionId);
    connectionFileLog(cs, "INFO", `Cleaned up voice state for connection=${cs.connectionId}`);
  }
}

const voiceMethodDefinitions = [
  {
    name: "voice.speak",
    description: "Synthesize text to speech and emit a voice.audio event",
    inputSchema: z.object({
      text: z.string().min(1),
    }),
    execution: { lane: "long_running", concurrency: "keyed", keyContext: "connectionId" } as const,
  },
  {
    name: "voice.stop",
    description: "Stop active streaming TTS playback for the current connection",
    inputSchema: z.object({}),
    execution: { lane: "write", concurrency: "keyed", keyContext: "connectionId" } as const,
  },
  {
    name: "voice.status",
    description: "Get current voice extension status and active stream state",
    inputSchema: z.object({}),
    execution: { lane: "read", concurrency: "parallel" } as const,
  },
  {
    name: "voice.replay",
    description: "Replay previously saved response audio by session and stream id",
    inputSchema: z.object({
      sessionId: z.string().min(1),
      streamId: z.string().min(1),
    }),
    execution: { lane: "read", concurrency: "parallel" } as const,
  },
  {
    name: "voice.health_check",
    description: "Return standardized health_check payload for Voice extension",
    inputSchema: z.object({}),
    execution: { lane: "control", concurrency: "parallel" } as const,
  },
];

export function createVoiceExtension(config: VoiceConfig = {}): AnimaExtension {
  const defined = Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== undefined),
  );
  const cfg: Required<VoiceConfig> = { ...DEFAULT_CONFIG, ...defined };

  return createStandardExtension<VoiceExtensionRuntime>({
    id: "voice",
    name: "Voice (TTS)",
    createRuntime(ctx) {
      return {
        manager: new VoiceConnectionManager(ctx, cfg),
        traceLog: ctx.createLogger({ component: "trace", fileName: "voice-trace.log" }),
        unsubscribers: [],
      };
    },
    methods: voiceMethodDefinitions.map((definition) => ({
      definition,
      async handle(params, instance) {
        switch (definition.name) {
          case "voice.speak": {
            const text = params.text as string;
            if (!text) throw new Error('Missing "text" parameter');
            const cleaned = cleanForSpeech(text);
            await instance.runtime.manager.speakBatch(cleaned);
            return { ok: true };
          }
          case "voice.stop": {
            instance.runtime.manager.stopForConnection(instance.ctx.connectionId);
            return { ok: true };
          }
          case "voice.status":
            return instance.runtime.manager.getStatus();
          case "voice.replay": {
            const sessionId = params.sessionId as string;
            const streamId = params.streamId as string;
            if (!sessionId || !streamId) throw new Error("Missing sessionId or streamId");
            await instance.runtime.manager.replay(sessionId, streamId);
            return { ok: true };
          }
          case "voice.health_check":
            return instance.runtime.manager.buildHealthCheck();
          default:
            throw new Error(`Unknown method: ${definition.name}`);
        }
      },
    })),
    events: [
      "voice.speaking",
      "voice.done",
      "voice.audio",
      "voice.error",
      "voice.stream_start",
      "voice.audio_chunk",
      "voice.stream_end",
    ],
    async start(instance) {
      loggerFileLog(
        instance.runtime.traceLog,
        "INFO",
        `Voice extension starting (streaming=${cfg.streaming}, apiKey=${!!cfg.apiKey}, voice=${cfg.voiceId}, dictionaryId=${cfg.dictionaryId || "none"})`,
      );
      instance.ctx.log.info("Starting voice extension...");

      if (!cfg.apiKey) {
        instance.ctx.log.warn("No CARTESIA_API_KEY - TTS will not work");
      } else {
        instance.ctx.log.info(
          `Cartesia configured (voice=${cfg.voiceId}, streaming=${cfg.streaming}, model=${cfg.model})`,
        );
      }

      instance.runtime.unsubscribers.push(
        instance.ctx.on("session.*.content_block_start", (event: GatewayEvent) => {
          instance.runtime.manager.handleContentBlockStart(event);
        }),
      );
      instance.runtime.unsubscribers.push(
        instance.ctx.on("session.*.content_block_delta", (event: GatewayEvent) => {
          instance.runtime.manager.handleContentBlockDelta(event);
        }),
      );
      instance.runtime.unsubscribers.push(
        instance.ctx.on("session.*.message_stop", async (event: GatewayEvent) => {
          await instance.runtime.manager.handleMessageStop(event);
        }),
      );

      instance.ctx.log.info("Voice extension started");
    },
    async stop(instance) {
      instance.ctx.log.info("Stopping voice extension...");
      instance.runtime.manager.abortAll();

      for (const unsub of instance.runtime.unsubscribers) {
        unsub();
      }
      instance.runtime.unsubscribers.length = 0;
    },
    health(instance) {
      if (!instance) {
        return {
          ok: !!cfg.apiKey,
          details: {
            apiKeyConfigured: !!cfg.apiKey,
            streaming: cfg.streaming,
            voiceId: cfg.voiceId,
            speaking: false,
            activeConnections: 0,
          },
        };
      }
      return instance.runtime.manager.buildRuntimeHealth();
    },
  })(defined);
}

export default createVoiceExtension;

// ── Direct execution with HMR ────────────────────────────────
import { runExtensionHost } from "@anima/extension-host";
if (import.meta.main) runExtensionHost(createVoiceExtension);
