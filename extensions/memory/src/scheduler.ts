import type { ExtensionContext } from "@anima/shared";
import { markConversationsReady, queueConversations } from "./db";

const DEFAULT_INTERVAL_MS = 30_000;

export interface MemorySchedulerConfig {
  gapMinutes: number;
  autoProcess: boolean;
  processBatchSize: number;
  intervalMs?: number;
}

export interface MemorySchedulerDiagnostics {
  running: boolean;
  lastRunAt: string | null;
  lastReadyCount: number;
  lastQueuedCount: number;
  lastErrorAt: string | null;
  lastError: string | null;
}

export class MemoryScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private runningTick = false;
  private readonly diagnostics: MemorySchedulerDiagnostics = {
    running: false,
    lastRunAt: null,
    lastReadyCount: 0,
    lastQueuedCount: 0,
    lastErrorAt: null,
    lastError: null,
  };

  constructor(
    private readonly config: MemorySchedulerConfig,
    private readonly ctx: ExtensionContext | null,
    private readonly log: (level: string, msg: string) => void,
    private readonly onQueued?: () => void,
  ) {}

  start(): void {
    if (this.timer) return;
    this.diagnostics.running = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.intervalMs ?? DEFAULT_INTERVAL_MS);
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.diagnostics.running = false;
  }

  getDiagnostics(): MemorySchedulerDiagnostics {
    return { ...this.diagnostics };
  }

  async tick(): Promise<void> {
    if (this.runningTick) return;
    this.runningTick = true;

    try {
      const marked = markConversationsReady(this.config.gapMinutes);
      this.diagnostics.lastReadyCount = marked;

      if (marked > 0) {
        this.log("INFO", `Marked ${marked} conversations as ready (scheduler)`);
        this.ctx?.emit("memory.conversation_ready", { count: marked });
      }

      let queued = 0;
      if (this.config.autoProcess) {
        queued = queueConversations(this.config.processBatchSize);
        this.diagnostics.lastQueuedCount = queued;
        if (queued > 0) {
          this.log("INFO", `Auto-queued ${queued} conversations for processing`);
          this.ctx?.emit("memory.processing_started", { count: queued });
          this.onQueued?.();
        }
      } else {
        this.diagnostics.lastQueuedCount = 0;
      }

      this.diagnostics.lastRunAt = new Date().toISOString();
      this.diagnostics.lastErrorAt = null;
      this.diagnostics.lastError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.diagnostics.lastErrorAt = new Date().toISOString();
      this.diagnostics.lastError = message;
      this.log("ERROR", `Scheduler tick failed: ${message}`);
    } finally {
      this.runningTick = false;
    }
  }
}
