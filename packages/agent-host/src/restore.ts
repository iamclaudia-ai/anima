import type { PersistedState } from "./state";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

type SessionResumer = {
  resume: (params: {
    sessionId: string;
    cwd: string;
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
