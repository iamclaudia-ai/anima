import type { PersistedState } from "./state";

type SessionResumer = {
  resume: (params: {
    sessionId: string;
    cwd: string;
    model?: string;
  }) => Promise<{ sessionId: string }>;
};

type RestoreLogger = {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
};

export async function restorePersistedSessions(
  sessionHost: SessionResumer,
  persistedState: PersistedState,
  log: RestoreLogger,
): Promise<number> {
  let restoredCount = 0;

  for (const record of persistedState.sessions) {
    try {
      await sessionHost.resume({
        sessionId: record.id,
        cwd: record.cwd,
        model: record.model,
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
