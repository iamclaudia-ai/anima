/**
 * Liveness of CLI sessions, read from one shared snapshot (#95).
 *
 * Whether a session's `claude` process and tmux pane are alive used to be
 * answered per session with `execFileSync("pgrep", …)` and
 * `execFileSync("tmux", ["has-session", …])`. Those ran on the event loop,
 * once per session, on every prompt (state persistence asks every session).
 * `pgrep -f` reads the argv of every process on the machine, so its cost follows
 * the machine's process count, not ours. At ~6,400 processes it took ~260 ms,
 * 21 sessions made that ~5 s per prompt, `/health` stopped answering, and the
 * watchdog killed agent-host every minute.
 *
 * Instead, one async `ps` and one async `tmux list-sessions` build a snapshot
 * that every cheap check reads synchronously. A background timer keeps it
 * current. A caller that needs a fresh answer (just before sending a prompt,
 * right after a launch) awaits `refresh()`, which never blocks the event loop.
 */

import { createLogger } from "@anima/shared";
import { join } from "node:path";
import { homedir } from "node:os";

// ANIMA_DATA_DIR first, so `bun test` (which points it at a sandbox) can't
// write fake probe failures into the live agent-host log.
const log = createLogger(
  "Liveness",
  join(process.env.ANIMA_DATA_DIR || join(homedir(), ".anima"), "logs", "agent-host.log"),
);

/** Result of running a probe command. */
export interface ProbeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface LivenessProbes {
  /** Every process as `<pid> <args>`, one per line (`ps -A -ww -o pid=,args=`). */
  listProcesses: () => Promise<ProbeResult>;
  /** Every tmux session name, one per line. */
  listTmuxSessions: () => Promise<ProbeResult>;
  /** One process's command line followed by its environment (`ps eww`). */
  processEnvironment: (pid: number) => Promise<ProbeResult>;
}

async function run(cmd: string[]): Promise<ProbeResult> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export const systemProbes: LivenessProbes = {
  listProcesses: () => run(["ps", "-A", "-ww", "-o", "pid=,args="]),
  listTmuxSessions: () => run(["tmux", "list-sessions", "-F", "#{session_name}"]),
  processEnvironment: (pid) => run(["ps", "eww", "-o", "command=", "-p", String(pid)]),
};

/**
 * Map each session id with a live `claude` to its pid.
 *
 * Matches the CLI's own argv (`--resume <id>` / `--session-id <id>`): it stays
 * true while a tool subprocess is foregrounded mid-turn and survives the binary
 * being renamed across versions. When several processes carry the same id (a
 * wrapper shell and the CLI itself), the first is kept, as `pgrep` did.
 */
export function parseClaudeProcesses(psOutput: string): Map<string, number> {
  const byId = new Map<string, number>();
  for (const line of psOutput.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    for (const arg of match[2]!.matchAll(/--(?:resume|session-id) ([^\s'"]+)/g)) {
      const id = arg[1]!;
      if (!byId.has(id)) byId.set(id, pid);
    }
  }
  return byId;
}

/**
 * Parse the proxy port out of a `ps eww` environment dump.
 *
 * `base-url` sessions carry `ANTHROPIC_BASE_URL`; `mitm` sessions carry
 * `HTTPS_PROXY`.
 */
export function parseProxyPortFromEnv(psOutput: string): number | null {
  const match =
    /ANTHROPIC_BASE_URL=https?:\/\/[^:\s]+:(\d+)/.exec(psOutput) ??
    /HTTPS_PROXY=https?:\/\/[^:\s]+:(\d+)/.exec(psOutput);
  const port = match?.[1] ? Number(match[1]) : NaN;
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

export class LivenessMonitor {
  private claude = new Map<string, number>();
  private tmux = new Set<string>();
  private takenAt = 0;
  private running: Promise<void> | null = null;
  private pending: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly probes: LivenessProbes = systemProbes,
    private readonly now: () => number = Date.now,
  ) {}

  /** True once a snapshot has been taken. Before that, every check reads false. */
  get primed(): boolean {
    return this.takenAt > 0;
  }

  claudeAlive(sessionId: string): boolean {
    return this.claude.has(sessionId);
  }

  claudePid(sessionId: string): number | undefined {
    return this.claude.get(sessionId);
  }

  tmuxAlive(name: string): boolean {
    return this.tmux.has(name);
  }

  /**
   * Take a snapshot that starts after this call.
   *
   * Callers share probes: one already running is not reused, because it may
   * have started before whatever the caller just did (a launch, a kill). The
   * caller waits for the next probe instead, and every caller that arrives
   * meanwhile joins that same one.
   */
  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    if (!this.running) {
      this.running = this.probe().finally(() => {
        this.running = null;
      });
      return this.running;
    }
    this.pending = this.running.then(() => {
      this.pending = null;
      return this.refresh();
    });
    return this.pending;
  }

  /** Refresh only when the snapshot is older than `maxAgeMs`. */
  async fresh(maxAgeMs: number): Promise<void> {
    if (this.primed && this.now() - this.takenAt <= maxAgeMs) return;
    await this.refresh();
  }

  /** Forget a session we just closed, so checks stop reporting it at once. */
  forget(sessionId: string, tmuxName: string): void {
    this.claude.delete(sessionId);
    this.tmux.delete(tmuxName);
  }

  /** The proxy port a live `claude` was launched against, read from its environment. */
  async proxyPort(sessionId: string): Promise<number | null> {
    const pid = this.claude.get(sessionId);
    if (pid === undefined) return null;
    try {
      const result = await this.probes.processEnvironment(pid);
      return result.exitCode === 0 ? parseProxyPortFromEnv(result.stdout) : null;
    } catch {
      return null;
    }
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.refresh();
    }, intervalMs);
    // Never the reason the process stays alive.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Run both probes. A probe that fails keeps its half of the previous snapshot:
   * one failed `ps` must not report every session dead, because state
   * persistence would then drop them all from `sessions.json`.
   */
  private async probe(): Promise<void> {
    const [procs, tmux] = await Promise.allSettled([
      this.probes.listProcesses(),
      this.probes.listTmuxSessions(),
    ]);

    if (procs.status === "fulfilled" && procs.value.exitCode === 0) {
      this.claude = parseClaudeProcesses(procs.value.stdout);
    } else {
      log.warn("Process probe failed; keeping the previous snapshot", {
        error: procs.status === "rejected" ? String(procs.reason) : procs.value.stderr.trim(),
      });
    }

    if (tmux.status === "fulfilled") {
      const { exitCode, stdout, stderr } = tmux.value;
      if (exitCode === 0) {
        this.tmux = new Set(stdout.split("\n").filter(Boolean));
      } else if (/no server running|error connecting to/i.test(stderr)) {
        // No tmux server is a real answer: no sessions at all.
        this.tmux = new Set();
      } else {
        log.warn("tmux probe failed; keeping the previous snapshot", { error: stderr.trim() });
      }
    } else {
      log.warn("tmux probe failed; keeping the previous snapshot", { error: String(tmux.reason) });
    }

    this.takenAt = this.now();
  }
}

/** The host-wide monitor. agent-host primes it at startup and keeps it running. */
export const liveness = new LivenessMonitor();
