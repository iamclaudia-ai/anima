#!/usr/bin/env bun
/**
 * Gateway Startup Script
 *
 * Extension loading is config-driven and out-of-process by default.
 * Each enabled extension runs in its own host process via stdio NDJSON.
 */

import { extensions, handleExtensionEvent } from "./index";
import {
  getEnabledExtensions,
  createLogger,
  clearConfigCache,
  loadConfig,
  type ExtensionConfig,
} from "@anima/shared";
import { existsSync, watch } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  ExtensionHostProcess,
  type ExtensionHost,
  type ExtensionRegistration,
  type OnCallCallback,
} from "./extension-host";
import {
  acquireExtensionProcessLock,
  renewExtensionProcessLock,
  releaseExtensionProcessLock,
  DEFAULT_EXTENSION_LOCK_STALE_MS,
} from "./db/extension-locks";
import { getDb } from "./db";

const log = createLogger("Startup", join(homedir(), ".anima", "logs", "gateway.log"));
const ROOT_DIR = join(import.meta.dir, "..", "..", "..");
const config = loadConfig();

/**
 * Kill orphaned extension host processes from previous gateway instances.
 * When bun --watch restarts the gateway, child processes can be orphaned
 * because SIGKILL doesn't allow cleanup handlers to run.
 */
async function killOrphanExtensionHosts(): Promise<void> {
  if (process.env.ANIMA_SKIP_ORPHAN_KILL === "true") {
    log.info("Skipping orphan extension host cleanup (ANIMA_SKIP_ORPHAN_KILL=true)");
    return;
  }

  try {
    const proc = Bun.spawn(["pgrep", "-f", "extensions/.*/src/index.ts"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const pids = output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(Number)
      .filter((pid) => pid !== process.pid);

    if (pids.length > 0) {
      log.info("Killing orphaned extension hosts", { pids });
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Process already dead
        }
      }
      // Brief wait for graceful shutdown
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch {
    // pgrep returns exit code 1 when no matches — that's fine
  }
}

const startedExtensions = new Set<string>();
const runningExtensions = new Map<string, ExtensionHostProcess>();
// Track in-progress spawns to prevent concurrent spawns of same extension
const spawningExtensions = new Map<string, Promise<void>>();
const lockedExtensions = new Set<string>();
const GATEWAY_INSTANCE_ID = randomUUID();
const EXTENSION_LOCK_HEARTBEAT_MS = 15_000;
const FORCE_STARTUP = process.argv.includes("--force");

function isPidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveExtensionEntrypoint(extensionId: string): string | null {
  const entryPath = join(ROOT_DIR, "extensions", extensionId, "src", "index.ts");
  if (!existsSync(entryPath)) {
    return null;
  }
  return entryPath;
}

function clearLockTable(tableName: string): number {
  const db = getDb();
  try {
    const exists = db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName);
    if (!exists) return 0;
    const result = db.query(`DELETE FROM ${tableName}`).run();
    return result.changes;
  } catch (error) {
    log.warn("Failed to clear lock table", { tableName, error: String(error) });
    return 0;
  }
}

function forceClearStartupLocks(): void {
  if (!FORCE_STARTUP) return;

  const cleared = {
    extensionProcessLocks: clearLockTable("extension_process_locks"),
    memoryExtensionLocks: clearLockTable("memory_extension_locks"),
    memoryFileLocks: clearLockTable("memory_file_locks"),
  };

  log.warn("Force startup requested; cleared lock tables", cleared);
}

async function spawnOutOfProcessExtension(
  id: string,
  config: Record<string, unknown>,
  sourceRoutes?: string[],
  hot: boolean = false,
): Promise<void> {
  // Check if already started
  if (startedExtensions.has(id)) {
    log.info("Extension already started", { id });
    return;
  }

  // Check if currently spawning — wait for existing spawn to complete
  const existingSpawn = spawningExtensions.get(id);
  if (existingSpawn) {
    log.info("Extension spawn already in progress, waiting", { id });
    await existingSpawn;
    return;
  }

  // Create spawn promise
  const spawnPromise = (async () => {
    let lockHeld = false;
    let spawnSucceeded = false;

    try {
      const moduleSpec = resolveExtensionEntrypoint(id);
      if (!moduleSpec) {
        log.warn("Extension entrypoint not found", {
          id,
          expected: `extensions/${id}/src/index.ts`,
        });
        return;
      }

      let lock = acquireExtensionProcessLock(
        id,
        process.pid,
        GATEWAY_INSTANCE_ID,
        "starting",
        DEFAULT_EXTENSION_LOCK_STALE_MS,
      );
      if (!lock.acquired && !isPidAlive(lock.ownerPid)) {
        log.warn("Detected dead extension lock owner; forcing lock takeover", {
          id,
          previousOwnerPid: lock.ownerPid,
          previousOwnerInstanceId: lock.ownerInstanceId,
          previousOwnerGeneration: lock.ownerGeneration ?? null,
        });
        lock = acquireExtensionProcessLock(id, process.pid, GATEWAY_INSTANCE_ID, "starting", 0);
      }

      if (!lock.acquired) {
        log.warn("Extension singleton lock held by another gateway; skipping spawn", {
          id,
          ownerPid: lock.ownerPid,
          ownerInstanceId: lock.ownerInstanceId,
          ownerGeneration: lock.ownerGeneration ?? null,
        });
        return;
      }
      lockHeld = true;
      lockedExtensions.add(id);

      if (lock.stolen) {
        log.warn("Stole stale extension singleton lock", {
          id,
          previousOwnerPid: lock.ownerPid,
          previousOwnerInstanceId: lock.ownerInstanceId,
          previousOwnerGeneration: lock.ownerGeneration ?? null,
        });
      }

      log.info("Spawning out-of-process extension", { id, module: moduleSpec });

      // ctx.call handler: route calls from this extension through the gateway hub
      const onCall: OnCallCallback = async (callerExtensionId, method, params, meta) => {
        try {
          const result = await extensions.handleMethod(
            method,
            params,
            meta.connectionId,
            {
              traceId: meta.traceId,
              depth: meta.depth,
              deadlineMs: meta.deadlineMs,
            },
            meta.tags,
          );
          return { ok: true as const, payload: result };
        } catch (error) {
          return { ok: false as const, error: String(error) };
        }
      };

      const host = new ExtensionHostProcess(
        id,
        moduleSpec,
        config,
        (type, payload, source, connectionId, tags, generationToken) =>
          handleExtensionEvent(type, payload, source || `extension:${id}`, connectionId, tags, {
            extensionId: id,
            generationToken,
          }),
        (registration: ExtensionRegistration, generationToken) => {
          // Allow config-level sourceRoutes to augment extension-declared routes.
          if (sourceRoutes?.length) {
            registration.sourceRoutes = Array.from(
              new Set([...(registration.sourceRoutes || []), ...sourceRoutes]),
            );
          }
          extensions.registerRemote(registration, host, generationToken);
          renewExtensionProcessLock(
            id,
            process.pid,
            GATEWAY_INSTANCE_ID,
            generationToken ?? host.getGenerationToken() ?? null,
          );

          // If this is a re-registration (HMR restart), send extensions_ready
          // so the extension can re-run its startup work
          if (startedExtensions.has(id)) {
            host.sendEvent({
              type: "gateway.extensions_ready",
              payload: { extensions: Array.from(runningExtensions.keys()), restart: true },
              timestamp: Date.now(),
              source: "gateway",
            });
          }
        },
        onCall,
        hot,
      );

      const registration = await host.spawn();
      log.info("Out-of-process extension ready", {
        id: registration.id,
        methods: registration.methods.map((m) => m.name),
      });

      startedExtensions.add(id);
      runningExtensions.set(id, host);
      spawnSucceeded = true;
    } finally {
      if (lockHeld && !spawnSucceeded) {
        releaseExtensionProcessLock(id, process.pid, GATEWAY_INSTANCE_ID);
        lockedExtensions.delete(id);
      }
      spawningExtensions.delete(id);
    }
  })();

  spawningExtensions.set(id, spawnPromise);
  await spawnPromise;
}

/**
 * Load configured extensions from config.
 * All extensions spawn in parallel — registration happens before start(),
 * so methods are available immediately. After all settle, the gateway
 * broadcasts gateway.extensions_ready so extensions can do startup work
 * that depends on other extensions (e.g., ctx.call).
 */
async function loadExtensions(): Promise<void> {
  const enabledExtensions = getEnabledExtensions();

  if (enabledExtensions.length === 0) {
    log.info("No configured extensions enabled");
    return;
  }

  log.info("Loading configured extensions", {
    extensions: enabledExtensions.map(([id]) => id),
  });

  const results = await Promise.allSettled(
    enabledExtensions.map(([id, ext]) =>
      spawnOutOfProcessExtension(id, ext.config, ext.sourceRoutes, ext.hot === true),
    ),
  );

  const failed = results
    .map((r, i) => (r.status === "rejected" ? enabledExtensions[i][0] : null))
    .filter(Boolean);
  const succeeded = results.filter((r) => r.status === "fulfilled").length;

  if (failed.length > 0) {
    log.error("Some extensions failed to load", { failed });
  }
  log.info("Extension loading complete", { succeeded, failed: failed.length });
}

/**
 * Start a single extension dynamically
 */
async function startExtension(id: string, extensionConfig: ExtensionConfig): Promise<void> {
  if (runningExtensions.has(id)) {
    log.warn("Extension already running", { id });
    return;
  }

  const moduleSpec = resolveExtensionEntrypoint(id);
  if (!moduleSpec) {
    log.warn("Extension entrypoint not found", { id, expected: `extensions/${id}/src/index.ts` });
    return;
  }

  log.info("Starting extension dynamically", { id });

  try {
    await spawnOutOfProcessExtension(
      id,
      extensionConfig.config,
      extensionConfig.sourceRoutes,
      extensionConfig.hot === true,
    );
    log.info("Extension started successfully", { id });

    // Send extensions_ready to this late-joining extension so it can do startup work
    const host = runningExtensions.get(id);
    if (host) {
      host.sendEvent({
        type: "gateway.extensions_ready",
        payload: { extensions: Array.from(runningExtensions.keys()), late: true },
        timestamp: Date.now(),
        source: "gateway",
      });
    }
  } catch (error) {
    log.error("Failed to start extension", { id, error: String(error) });
  }
}

/**
 * Stop a single extension dynamically
 */
async function stopExtension(id: string): Promise<void> {
  // Wait for any in-progress spawn to complete
  const spawning = spawningExtensions.get(id);
  if (spawning) {
    log.info("Extension spawn in progress, waiting before stop", { id });
    await spawning;
  }

  const host = runningExtensions.get(id);
  if (!host) {
    log.warn("Extension not running", { id });
    return;
  }

  log.info("Stopping extension dynamically", { id });

  try {
    await host.kill();
    runningExtensions.delete(id);
    startedExtensions.delete(id);
    releaseExtensionProcessLock(id, process.pid, GATEWAY_INSTANCE_ID);
    lockedExtensions.delete(id);
    // Unregister from gateway extension manager
    extensions.unregisterRemote(id);
    log.info("Extension stopped successfully", { id });
  } catch (error) {
    log.error("Failed to stop extension", { id, error: String(error) });
  }
}

function startExtensionLockHeartbeat(): NodeJS.Timeout {
  log.info("Starting extension singleton lock heartbeat", {
    intervalMs: EXTENSION_LOCK_HEARTBEAT_MS,
  });

  const timer = setInterval(async () => {
    const toStop: string[] = [];

    for (const [id, host] of runningExtensions) {
      const generation = extensions.getGeneration(id) ?? host.getGenerationToken() ?? null;
      const renewed = renewExtensionProcessLock(id, process.pid, GATEWAY_INSTANCE_ID, generation);
      if (!renewed) {
        log.error("Lost extension singleton lock; scheduling stop", { id, generation });
        toStop.push(id);
      }
    }

    for (const id of toStop) {
      await stopExtension(id);
    }
  }, EXTENSION_LOCK_HEARTBEAT_MS);

  return timer;
}

function releaseAllExtensionLocks(): void {
  for (const id of lockedExtensions) {
    releaseExtensionProcessLock(id, process.pid, GATEWAY_INSTANCE_ID);
  }
  lockedExtensions.clear();
}

/**
 * Handle config file changes - manage extension enable/disable
 */
async function handleConfigChange(): Promise<void> {
  try {
    log.info("Config file changed, checking for extension enable/disable changes");

    // Clear cache to get fresh config (including auth token)
    clearConfigCache();

    // Reset auth token cache so a regenerated token takes effect
    const { resetCachedToken } = await import("./auth");
    resetCachedToken();

    const newEnabledExtensions = getEnabledExtensions();
    const newEnabledIds = new Set(newEnabledExtensions.map(([id]) => id));
    const currentRunningIds = new Set(runningExtensions.keys());

    // Find extensions to start (newly enabled)
    const toStart = newEnabledExtensions.filter(([id]) => !currentRunningIds.has(id));

    // Find extensions to stop (newly disabled)
    const toStop = Array.from(currentRunningIds).filter((id) => !newEnabledIds.has(id));

    if (toStart.length === 0 && toStop.length === 0) {
      log.info("No extension enable/disable changes detected");
      return;
    }

    log.info("Processing extension changes", {
      toStart: toStart.map(([id]) => id),
      toStop,
    });

    // Stop disabled extensions
    for (const id of toStop) {
      await stopExtension(id);
    }

    // Start newly enabled extensions
    for (const [id, config] of toStart) {
      await startExtension(id, config);
    }

    log.info("Extension changes processed successfully", {
      started: toStart.map(([id]) => id),
      stopped: toStop,
      note: "Extension config changes require manual restart via CLI",
    });
  } catch (error) {
    log.error("Failed to handle config changes", { error: String(error) });
  }
}

/**
 * Start periodic heartbeat timer for extensions
 */
function startHeartbeat(): NodeJS.Timeout | null {
  const intervalMs = config.gateway.heartbeatIntervalMs || 300000; // Default 5 minutes

  if (intervalMs <= 0) {
    log.info("Heartbeat disabled (heartbeatIntervalMs <= 0)");
    return null;
  }

  log.info("Starting heartbeat timer", { intervalMs: intervalMs / 1000 + "s" });

  const timer = setInterval(async () => {
    try {
      await extensions.broadcast({
        type: "gateway.heartbeat",
        timestamp: Date.now(),
        payload: {
          timestamp: Date.now(),
          uptime: process.uptime(),
        },
        source: "gateway",
      });
      log.info("Heartbeat sent to extensions");
    } catch (error) {
      log.error("Failed to send heartbeat", { error: String(error) });
    }
  }, intervalMs);

  return timer;
}

/**
 * Start config file watcher for dynamic extension management
 */
function startConfigWatcher(): void {
  const configPath = join(homedir(), ".anima", "anima.json");

  if (!existsSync(configPath)) {
    log.warn("Config file not found, skipping file watcher", { configPath });
    return;
  }

  log.info("Starting config file watcher", { configPath });

  try {
    const watcher = watch(configPath, { persistent: true }, (eventType, filename) => {
      log.info("File watcher event detected", {
        eventType,
        filename,
        timestamp: new Date().toISOString(),
      });
      if (eventType === "change" || eventType === "rename") {
        log.info("Config file change detected, processing in 100ms");
        // Debounce rapid file changes
        setTimeout(() => {
          log.info("Executing handleConfigChange");
          handleConfigChange();
        }, 100);
      }
    });

    // Test if watcher is actually working
    setTimeout(() => {
      log.info("File watcher test - manually checking config", {
        watcherActive: !!watcher,
        configExists: existsSync(configPath),
      });
    }, 2000);

    log.info("Config file watcher started successfully", { watcherCreated: !!watcher });
  } catch (error) {
    log.error("Failed to start config file watcher", { error: String(error) });
  }
}

forceClearStartupLocks();

killOrphanExtensionHosts()
  .then(async () => {
    // Initial extension load
    await loadExtensions();

    // Signal all extensions that the platform is ready — extensions that need
    // other extensions (e.g., iMessage calling session.send_prompt for catchup)
    // should listen for this event in their start() method via ctx.on().
    const loadedExtensions = Array.from(runningExtensions.keys());
    log.info("Broadcasting gateway.extensions_ready", { extensions: loadedExtensions });
    extensions.broadcast({
      type: "gateway.extensions_ready",
      payload: { extensions: loadedExtensions },
      timestamp: Date.now(),
      source: "gateway",
    });

    // Start config file watcher for dynamic extension management
    startConfigWatcher();

    // Start heartbeat timer for extensions
    const heartbeatTimer = startHeartbeat();
    if (heartbeatTimer) {
      log.info("Extension heartbeat system started");
    }

    startExtensionLockHeartbeat();
  })
  .catch((err) => log.error("Extension startup failed", { error: String(err) }));

process.on("SIGINT", releaseAllExtensionLocks);
process.on("SIGTERM", releaseAllExtensionLocks);
process.on("exit", releaseAllExtensionLocks);
