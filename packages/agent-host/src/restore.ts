import type { PersistedState } from "./state";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

type SessionResumer = {
  resume: (params: {
    sessionId: string;
    cwd: string;
    agent?: string;
    model?: string;
    lastActivity?: string;
  }) => Promise<{ sessionId: string }>;
};

type RestoreLogger = {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
};

function resolveSessionPath(sessionId: string, cwd: string): string | null {
  const projectsDir = join(process.env.HOME ?? homedir(), ".claude", "projects");
  const encodedCwd = cwd.replace(/\//g, "-");
  const directPath = join(projectsDir, encodedCwd, `${sessionId}.jsonl`);
  if (existsSync(directPath)) return directPath;

  if (!existsSync(projectsDir)) return null;
  const entries = readdirSync(projectsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(projectsDir, entry.name, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveFallbackLastActivity(sessionId: string, cwd: string): string | undefined {
  const path = resolveSessionPath(sessionId, cwd);
  if (!path) return undefined;
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return undefined;
  }
}

export async function restorePersistedSessions(
  sessionHost: SessionResumer,
  persistedState: PersistedState,
  log: RestoreLogger,
): Promise<number> {
  let restoredCount = 0;

  for (const record of persistedState.sessions) {
    try {
      const lastActivity =
        record.lastActivity || resolveFallbackLastActivity(record.id, record.cwd);

      await sessionHost.resume({
        sessionId: record.id,
        cwd: record.cwd,
        agent: record.agent,
        model: record.model,
        lastActivity,
      });
      restoredCount += 1;
    } catch (error) {
      log.warn("Failed to restore session", {
        sessionId: record.id.slice(0, 8),
        error: String(error),
      });
    }
  }

  log.info("Sessions restored to memory", { restored: restoredCount });
  return restoredCount;
}

/**
 * Adopt live CLI sessions the persisted registry doesn't know about.
 *
 * `sessions.json` is a cache, and a lost or truncated one used to be fatal for
 * any `claude` still running: nothing rebound its proxy, so the very next
 * request hit `ANTHROPIC_BASE_URL` with nothing listening and failed with
 * ConnectionRefused — the CLI reads that URL once at startup and can never be
 * pointed somewhere new. Worse, the orphan reaper then read "untracked" as
 * "abandoned" and killed the pane.
 *
 * A running `claude` in an `anima-cli-<id>` pane is ground truth, so this
 * treats the filesystem and process table as the source and the registry as
 * the derived thing. Resuming re-binds the proxy on the port the CLI is
 * already targeting (`ensureProxy` prefers the live process's own port), which
 * is exactly the repair.
 *
 * The cwd comes from the pane itself; the model is left to the host default,
 * since neither is recoverable from the process and both only matter for a
 * relaunch, which adoption never triggers — the process is already alive.
 */
export async function adoptLiveCliSessions(
  sessionHost: SessionResumer,
  deps: {
    listTmuxSessions: () => Array<{ name: string }>;
    claudeProcessAlive: (id: string) => boolean;
    paneCurrentPath: (name: string) => string | null;
    /** Ids the registry already covers, so adoption reports only real repairs. */
    isTracked: (id: string) => boolean;
  },
  log: RestoreLogger,
): Promise<number> {
  const PREFIX = "anima-cli-";
  let adopted = 0;

  for (const session of deps.listTmuxSessions()) {
    if (!session.name.startsWith(PREFIX)) continue;
    const sessionId = session.name.slice(PREFIX.length);
    if (deps.isTracked(sessionId)) continue;
    if (!deps.claudeProcessAlive(sessionId)) continue;

    const cwd = deps.paneCurrentPath(session.name);
    if (!cwd) {
      log.warn("Live CLI pane has no readable cwd — cannot adopt", {
        sessionId: sessionId.slice(0, 8),
      });
      continue;
    }

    try {
      await sessionHost.resume({ sessionId, cwd, agent: "claude" });
      adopted += 1;
      log.info("Adopted live CLI session missing from the registry", {
        sessionId: sessionId.slice(0, 8),
        cwd,
      });
    } catch (error) {
      log.warn("Failed to adopt live CLI session", {
        sessionId: sessionId.slice(0, 8),
        error: String(error),
      });
    }
  }

  if (adopted > 0) log.info("Live CLI sessions adopted", { adopted });
  return adopted;
}
