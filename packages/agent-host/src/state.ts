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

const homeDir = process.env.HOME ?? homedir();
const log = createLogger("State", join(homeDir, ".anima", "logs", "agent-host.log"));

const STATE_DIR = join(homeDir, ".anima", "agent-host");
const STATE_FILE = join(STATE_DIR, "sessions.json");

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
    if (!existsSync(STATE_FILE)) {
      return { updatedAt: new Date().toISOString(), sessions: [] };
    }

    const raw = readFileSync(STATE_FILE, "utf-8");
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
    if (!existsSync(STATE_DIR)) {
      mkdirSync(STATE_DIR, { recursive: true });
    }

    const state: PersistedState = {
      updatedAt: new Date().toISOString(),
      sessions,
    };

    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
    log.info("Saved state", { sessions: sessions.length });
  } catch (error) {
    log.error("Failed to save state", { error: String(error) });
  }
}
