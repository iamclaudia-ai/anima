export interface RepoSyncDiagnostics {
  running: boolean;
  syncing: boolean;
  pending: boolean;
  pendingRequests: number;
  lastRequestedAt: string | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastDurationMs: number | null;
  lastErrorAt: string | null;
  lastError: string | null;
}

export class RepoSyncService {
  private active = false;
  private draining = false;
  private pendingRequests = 0;
  private drainPromise: Promise<void> | null = null;
  private readonly diagnostics: RepoSyncDiagnostics = {
    running: false,
    syncing: false,
    pending: false,
    pendingRequests: 0,
    lastRequestedAt: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastDurationMs: null,
    lastErrorAt: null,
    lastError: null,
  };

  constructor(
    private readonly sync: () => Promise<void>,
    private readonly log: (level: string, msg: string) => void,
  ) {}

  start(): void {
    if (this.active) return;
    this.active = true;
    this.diagnostics.running = true;
    this.maybeDrain();
  }

  async stop(): Promise<void> {
    this.active = false;
    this.diagnostics.running = false;
    await this.drainPromise;
  }

  requestSync(reason = "memory-update"): void {
    this.pendingRequests++;
    this.diagnostics.pending = true;
    this.diagnostics.pendingRequests = this.pendingRequests;
    this.diagnostics.lastRequestedAt = new Date().toISOString();
    this.log("INFO", `RepoSync: queued sync request (${reason})`);
    this.maybeDrain();
  }

  getDiagnostics(): RepoSyncDiagnostics {
    return { ...this.diagnostics };
  }

  private maybeDrain(): void {
    if (!this.active || this.draining || this.pendingRequests === 0) return;
    this.drainPromise = this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    try {
      while (this.active && this.pendingRequests > 0) {
        const batchSize = this.pendingRequests;
        this.pendingRequests = 0;
        this.diagnostics.pending = false;
        this.diagnostics.pendingRequests = 0;
        this.diagnostics.syncing = true;
        this.diagnostics.lastStartedAt = new Date().toISOString();

        const startedAt = Date.now();
        try {
          this.log("INFO", `RepoSync: starting sync run (${batchSize} queued request(s))`);
          await this.sync();
          this.diagnostics.lastCompletedAt = new Date().toISOString();
          this.diagnostics.lastDurationMs = Date.now() - startedAt;
          this.diagnostics.lastErrorAt = null;
          this.diagnostics.lastError = null;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.diagnostics.lastCompletedAt = new Date().toISOString();
          this.diagnostics.lastDurationMs = Date.now() - startedAt;
          this.diagnostics.lastErrorAt = new Date().toISOString();
          this.diagnostics.lastError = message;
          this.log("ERROR", `RepoSync: sync failed: ${message}`);
        } finally {
          this.diagnostics.syncing = false;
          this.diagnostics.pending = this.pendingRequests > 0;
          this.diagnostics.pendingRequests = this.pendingRequests;
        }
      }
    } finally {
      this.draining = false;
      this.drainPromise = null;
      if (this.active && this.pendingRequests > 0) {
        this.maybeDrain();
      }
    }
  }
}
