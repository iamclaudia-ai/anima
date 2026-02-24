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
} from "@claudia/shared";
import { existsSync, watch } from "node:fs";
import { join } from "node:path";

import { homedir } from "node:os";
import {
  ExtensionHostProcess,
  type ExtensionRegistration,
  type OnCallCallback,
} from "./extension-host";

const log = createLogger("Startup", join(homedir(), ".claudia", "logs", "gateway.log"));
const ROOT_DIR = join(import.meta.dir, "..", "..", "..");
const config = loadConfig();

/**
 * Kill orphaned extension host processes from previous gateway instances.
 * When bun --watch restarts the gateway, child processes can be orphaned
 * because SIGKILL doesn't allow cleanup handlers to run.
 */
async function killOrphanExtensionHosts(): Promise<void> {
  if (process.env.CLAUDIA_SKIP_ORPHAN_KILL === "true") {
    log.info("Skipping orphan extension host cleanup (CLAUDIA_SKIP_ORPHAN_KILL=true)");
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

function resolveExtensionEntrypoint(extensionId: string): string | null {
  const entryPath = join(ROOT_DIR, "extensions", extensionId, "src", "index.ts");
  if (!existsSync(entryPath)) {
    return null;
  }
  return entryPath;
}

async function spawnOutOfProcessExtension(
  id: string,
  config: Record<string, unknown>,
  sourceRoutes?: string[],
  hot: boolean = true,
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
    try {
      const moduleSpec = resolveExtensionEntrypoint(id);
      if (!moduleSpec) {
        log.warn("Extension entrypoint not found", {
          id,
          expected: `extensions/${id}/src/index.ts`,
        });
        return;
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
        (type, payload, source, connectionId, tags) =>
          handleExtensionEvent(type, payload, source || `extension:${id}`, connectionId, tags),
        (registration: ExtensionRegistration) => {
          // Allow config-level sourceRoutes to augment extension-declared routes.
          if (sourceRoutes?.length) {
            registration.sourceRoutes = Array.from(
              new Set([...(registration.sourceRoutes || []), ...sourceRoutes]),
            );
          }
          extensions.registerRemote(registration, host);
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
    } finally {
      spawningExtensions.delete(id);
    }
  })();

  spawningExtensions.set(id, spawnPromise);
  await spawnPromise;
}

/**
 * Load configured extensions from config.
 * Extensions run out-of-process by default.
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

  for (const [id, ext] of enabledExtensions) {
    try {
      await spawnOutOfProcessExtension(id, ext.config, ext.sourceRoutes, ext.hot !== false);
    } catch (error) {
      log.error("Failed to load extension", { id, error: String(error) });
    }
  }
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
      extensionConfig.hot !== false,
    );
    log.info("Extension started successfully", { id });
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
    // Unregister from gateway extension manager
    extensions.unregisterRemote(id);
    log.info("Extension stopped successfully", { id });
  } catch (error) {
    log.error("Failed to stop extension", { id, error: String(error) });
  }
}

/**
 * Handle config file changes - manage extension enable/disable
 */
async function handleConfigChange(): Promise<void> {
  try {
    log.info("Config file changed, checking for extension enable/disable changes");

    // Clear cache to get fresh config
    clearConfigCache();

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
  const configPath = join(homedir(), ".claudia", "claudia.json");

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

killOrphanExtensionHosts()
  .then(async () => {
    // Initial extension load
    await loadExtensions();

    // Start config file watcher for dynamic extension management
    startConfigWatcher();

    // Start heartbeat timer for extensions
    const heartbeatTimer = startHeartbeat();
    if (heartbeatTimer) {
      log.info("Extension heartbeat system started");
    }
  })
  .catch((err) => log.error("Extension startup failed", { error: String(err) }));
