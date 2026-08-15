/**
 * Durable session → proxy-port map.
 *
 * A `claude` process reads `ANTHROPIC_BASE_URL` once at startup and can never
 * be told a new one, so the port it was launched against has to survive
 * agent-host restarts. Deriving it from the session id gets close, but the
 * derived port can be taken at spawn time and free later (or the reverse),
 * which strands the CLI on a dead port.
 *
 * Reading the port back from the running process is ground truth, but only
 * while that process is alive and matchable. This file is the backstop: it
 * records what was actually bound, so a restart can re-offer the same port
 * even when the process lookup comes up empty.
 *
 * Purely a cache — a missing or corrupt file costs a fallback to derivation,
 * never correctness.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface PortEntry {
  port: number;
  updatedAt: string;
}

type Registry = Record<string, PortEntry>;

/** Drop entries untouched for this long, so the file can't grow forever. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function registryPath(): string {
  const dir = process.env.ANIMA_DATA_DIR || join(homedir(), ".anima");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "cli-proxy-ports.json");
}

function read(): Registry {
  try {
    const parsed = JSON.parse(readFileSync(registryPath(), "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Registry;
  } catch {
    // Missing or unreadable — this is a cache, so start empty.
    return {};
  }
}

/** Drop stale entries. Exported for testing; callers get it for free on write. */
export function pruneRegistry(registry: Registry, now: number = Date.now()): Registry {
  const kept: Registry = {};
  for (const [id, entry] of Object.entries(registry)) {
    if (!entry || typeof entry.port !== "number") continue;
    const updated = Date.parse(entry.updatedAt ?? "");
    // Keep anything whose timestamp we can't read rather than silently evicting.
    if (Number.isFinite(updated) && now - updated > MAX_AGE_MS) continue;
    kept[id] = entry;
  }
  return kept;
}

/** The port last bound for this session, if we still have a record of it. */
export function recallPort(sessionId: string): number | null {
  const entry = read()[sessionId];
  const port = entry?.port;
  return typeof port === "number" && port > 0 && port < 65536 ? port : null;
}

/**
 * Record the port actually bound for a session.
 *
 * Written via a temp file and rename so a crash mid-write can't leave a
 * truncated registry behind. Concurrent writers can still lose an entry to a
 * read-modify-write race; that costs one fallback to derivation, which is why
 * this stays a plain JSON file rather than growing a lock.
 */
export function rememberPort(sessionId: string, port: number): void {
  try {
    const registry = pruneRegistry(read());
    registry[sessionId] = { port, updatedAt: new Date().toISOString() };
    const path = registryPath();
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(registry, null, 2));
    renameSync(tmp, path);
  } catch {
    // Best-effort: failing to persist only costs port stability on restart.
  }
}

export function forgetPort(sessionId: string): void {
  try {
    const registry = read();
    if (!(sessionId in registry)) return;
    delete registry[sessionId];
    const path = registryPath();
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(registry, null, 2));
    renameSync(tmp, path);
  } catch {
    // Best-effort.
  }
}
