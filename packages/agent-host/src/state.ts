/**
 * State Persistence — persists session registry to disk for crash recovery.
 *
 * When the agent-host restarts, it reads the persisted session registry.
 * The actual SDK query() processes are dead (they were children of the old process),
 * but the session metadata survives. On the next prompt, lazy-resume recreates
 * the query() using `resume: sessionId` — the SDK picks up from its JSONL history.
 *
 * File: ~/.anima/agent-host/sessions.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "@anima/shared";
import type { SessionRecord } from "./session-host";

const log = createLogger(
  "State",
  join(process.env.HOME ?? homedir(), ".anima", "logs", "agent-host.log"),
);

/**
 * Resolved per call, not once at import.
 *
 * Module-level capture made these paths unoverridable: a test that set
 * `HOME` after the module had loaded still wrote to the real `~/.anima`, and
 * `bun test` duly truncated the live session registry to zero — which then
 * stranded every running CLI's proxy and got two of Michael's sessions reaped
 * as orphans. `ANIMA_DATA_DIR` is the same override the session store already
 * honours, and honouring it here at call time is what makes isolation possible
 * at all.
 */
function stateDir(): string {
  const base = process.env.ANIMA_DATA_DIR || join(process.env.HOME ?? homedir(), ".anima");
  return join(base, "agent-host");
}

function stateFile(): string {
  return join(stateDir(), "sessions.json");
}

export interface PersistedState {
  /** When the state was last written */
  updatedAt: string;
  /** Active session records */
  sessions: SessionRecord[];
}

/**
 * Load persisted session state from disk.
 * Returns empty state if no file exists or it's corrupted.
 */
export function loadState(): PersistedState {
  try {
    if (!existsSync(stateFile())) {
      return { updatedAt: new Date().toISOString(), sessions: [] };
    }

    const raw = readFileSync(stateFile(), "utf-8");
    const state = JSON.parse(raw) as PersistedState;

    log.info("Loaded persisted state", { sessions: state.sessions.length });
    return state;
  } catch (error) {
    log.warn("Failed to load persisted state, starting fresh", { error: String(error) });
    return { updatedAt: new Date().toISOString(), sessions: [] };
  }
}

/**
 * Save session state to disk.
 * Called periodically and on shutdown.
 */
export function saveState(sessions: SessionRecord[]): void {
  try {
    if (!existsSync(stateDir())) {
      mkdirSync(stateDir(), { recursive: true });
    }

    const state: PersistedState = {
      updatedAt: new Date().toISOString(),
      sessions,
    };

    writeFileSync(stateFile(), JSON.stringify(state, null, 2) + "\n");
    log.info("Saved state", { sessions: sessions.length });
  } catch (error) {
    log.error("Failed to save state", { error: String(error) });
  }
}
