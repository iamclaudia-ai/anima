/**
 * Service management — direct process supervision, health checks, auto-restart.
 *
 * Service definitions are loaded from ~/.anima/watchdog.json — no hardcoded commands.
 * Manages services as direct child processes (Bun.spawn).
 * No tmux — stdout/stderr pipe to log files, watchdog owns the process lifecycle.
 */

import {
  config,
  PROJECT_DIR,
  LOGS_DIR,
  HEALTH_HISTORY_SIZE,
  UNHEALTHY_RESTART_THRESHOLD,
  getGatewayToken,
} from "./constants";
import type { ServiceConfig } from "./constants";
import { log } from "./logger";
import { recordRecoveryEvent } from "./recovery-journal";
import { createGatewayClient } from "@anima/shared";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Subprocess } from "bun";

/**
 * Capture the full login shell environment by running `zsh -l -c env`.
 *
 * Compiled Bun binaries launched via launchd don't inherit the user's login
 * shell environment — even with the `zsh -l` wrapper in the plist, the binary
 * sees a minimal process.env. This function spawns a real login shell, runs
 * `env`, and parses the output so we can inject every variable (API keys,
 * PATH additions, etc.) into all child processes.
 *
 * Falls back to process.env on any error so startup never blocks.
 */
async function captureLoginShellEnv(): Promise<Record<string, string>> {
  try {
    // -i (interactive) + -l (login) ensures both .zprofile AND .zshrc are
    // sourced, so files like ~/dotfiles/secrets/apikeys.sh get loaded.
    const proc = Bun.spawn(["/bin/zsh", "-i", "-l", "-c", "env"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    const env: Record<string, string> = {};
    for (const line of output.split("\n")) {
      const idx = line.indexOf("=");
      if (idx > 0) {
        env[line.slice(0, idx)] = line.slice(idx + 1);
      }
    }
    return Object.keys(env).length > 10 ? env : { ...(process.env as Record<string, string>) };
  } catch {
    return { ...(process.env as Record<string, string>) };
  }
}

// Captured once at startup — all services inherit this full environment.
const LOGIN_ENV: Record<string, string> = await captureLoginShellEnv();
log(
  "INFO",
  `Login shell env captured: ${Object.keys(LOGIN_ENV).length} variables (OPENAI_API_KEY=${LOGIN_ENV.OPENAI_API_KEY ? "set" : "missing"}, PATH entries=${LOGIN_ENV.PATH?.split(":").length ?? 0})`,
);

/**
 * Resolve the absolute path to the bun executable.
 *
 * We can't use process.execPath because the watchdog is a compiled Bun binary —
 * process.execPath returns the watchdog binary itself, not the bun runtime.
 * Instead, probe well-known install locations then fall back to PATH lookup.
 */
function findBunBin(): string {
  const home = homedir();
  const candidates = [
    join(home, ".bun", "bin", "bun"), // Standard bun install
    "/opt/homebrew/bin/bun", // Homebrew
    "/usr/local/bin/bun", // Manual install
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  const which = Bun.which("bun");
  if (which) return which;
  throw new Error("Cannot find bun executable — checked ~/.bun/bin, homebrew, and PATH");
}

const BUN_BIN = findBunBin();

// ── Types ────────────────────────────────────────────────

export interface HealthSnapshot {
  timestamp: number;
  processAlive: boolean;
  healthy: boolean;
  reason?: string;
}

export interface ManagedService {
  name: string;
  id: string;
  command: string[];
  cwd: string;
  healthUrl: string | null;
  port: number | null;
  requireExtensions: boolean;
  restartBackoff: number;
  lastRestart: number;
  consecutiveFailures: number;
  history: HealthSnapshot[];
  proc: Subprocess | null;
  lastHealthReason?: string | null;
  lastHealthDetails?: Record<string, unknown> | null;
  activeIncident?: {
    key: string;
    incidentId: string;
    reason: string | null;
    openedAt: number;
    firstEvidence?: Record<string, unknown> | null;
    restartRequestedAt?: number | null;
    restartCompletedAt?: number | null;
    restartAttemptId?: string | null;
  } | null;
}

// ── Build Services from Config ──────────────────────────

function resolvePath(p: string): string {
  return p.startsWith("~") ? p.replace("~", homedir()) : p;
}

function buildService(id: string, cfg: ServiceConfig): ManagedService {
  return {
    name: cfg.name,
    id,
    command: cfg.command,
    cwd: cfg.cwd ? resolvePath(cfg.cwd) : PROJECT_DIR,
    healthUrl: cfg.healthUrl ?? null,
    port: cfg.port ?? null,
    requireExtensions: cfg.healthCheck?.requireExtensions ?? false,
    restartBackoff: 1000,
    lastRestart: 0,
    consecutiveFailures: 0,
    history: [],
    proc: null,
    lastHealthDetails: null,
    activeIncident: null,
  };
}

export const services: Record<string, ManagedService> = {};
for (const [id, cfg] of Object.entries(config.services)) {
  services[id] = buildService(id, cfg);
}

// ── Process Helpers ─────────────────────────────────────

export function isProcessAlive(service: ManagedService): boolean {
  if (!service.proc) return false;
  // Bun subprocess: exitCode is null while running
  return service.proc.exitCode === null;
}

async function killOrphanProcesses(port: number): Promise<void> {
  const proc = Bun.spawn(["lsof", "-ti", `tcp:${port}`], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;

  const pids = output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(Number)
    .filter((n) => !isNaN(n) && n !== process.pid);

  for (const pid of pids) {
    log("WARN", `Killing orphan process on port ${port}: PID ${pid}`);
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  if (pids.length > 0) {
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function drainToLog(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
  logPath: string,
): Promise<void> {
  if (!stream || typeof stream === "number") return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      appendFileSync(logPath, decoder.decode(value, { stream: true }));
    }
  } catch {
    // Stream closed on process exit
  }
}

export interface StartServiceOptions {
  force?: boolean;
}

/**
 * Resolve the executable in a command to its absolute path.
 *
 * "bun" always resolves to process.execPath (the binary running the watchdog).
 * Other executables are resolved via Bun.which() first, then by probing
 * common user install dirs (~/.local/bin, ~/.bun/bin, /opt/homebrew/bin, etc.).
 * This ensures services can be spawned correctly even when launchd provides a
 * minimal PATH that omits user install dirs.
 */
function resolveCommand(cmd: string[]): string[] {
  if (cmd.length === 0) return cmd;
  const [exe, ...rest] = cmd;
  // Already absolute
  if (exe.startsWith("/")) return cmd;
  // bun → always use the binary running this process
  if (exe === "bun") return [BUN_BIN, ...rest];
  // Try Bun.which (works when PATH is populated)
  const which = Bun.which(exe);
  if (which) return [which, ...rest];
  // Probe common user install dirs as fallback (compiled binaries may lack user PATH)
  const home = homedir();
  const searchDirs = [
    `${home}/.local/bin`,
    `${home}/.bun/bin`,
    `/opt/homebrew/bin`,
    `/usr/local/bin`,
  ];
  for (const dir of searchDirs) {
    const candidate = join(dir, exe);
    if (existsSync(candidate)) return [candidate, ...rest];
  }
  log("WARN", `Could not resolve executable "${exe}" in PATH or common dirs`);
  return cmd;
}

function commandForStart(service: ManagedService, force = false): string[] {
  const cmd =
    force && !service.command.includes("--force")
      ? [...service.command, "--force"]
      : service.command;
  return resolveCommand(cmd);
}

export async function startService(
  service: ManagedService,
  options: StartServiceOptions = {},
): Promise<void> {
  const force = options.force === true;

  // Kill existing process if still alive
  if (service.proc && service.proc.exitCode === null) {
    log("INFO", `Stopping ${service.name} (PID ${service.proc.pid})...`);
    service.proc.kill("SIGTERM");
    // Give it a moment to die
    await new Promise((r) => setTimeout(r, 1000));
    // Force kill if still alive
    if (service.proc.exitCode === null) {
      service.proc.kill("SIGKILL");
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // Kill any orphan processes already bound to this port
  if (service.port) {
    await killOrphanProcesses(service.port);
  }

  // Ensure log dir exists
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

  const logPath = join(LOGS_DIR, `${service.id}.log`);
  const command = commandForStart(service, force);

  // Spawn as direct child process. Use pipes + explicit drains to avoid
  // Bun.file stdio redirection issues that can cause runaway CPU.
  service.proc = Bun.spawn(command, {
    cwd: service.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...LOGIN_ENV, FORCE_COLOR: "0" },
  });

  // Drain child output into the service log asynchronously.
  drainToLog(service.proc.stdout, logPath);
  drainToLog(service.proc.stderr, logPath);

  service.lastRestart = Date.now();
  service.consecutiveFailures = 0;
  service.lastHealthReason = null;
  log("INFO", `Started ${service.name} (PID ${service.proc.pid})${force ? " [force]" : ""}`);

  // Monitor for unexpected exit
  service.proc.exited.then((code) => {
    log("WARN", `${service.name} exited with code ${code}`);
  });
}

export interface RestartServiceOptions {
  force?: boolean;
}

function normalizeServiceId(id: string): string {
  if (id === "runtime") return "agent-host";
  return id;
}

export async function restartService(
  id: string,
  options: RestartServiceOptions = {},
): Promise<{ ok: boolean; message: string }> {
  const serviceId = normalizeServiceId(id);
  const service = services[serviceId];
  if (!service) {
    return { ok: false, message: `Unknown service: ${id}` };
  }
  const force = options.force === true;

  log("INFO", `Restarting ${service.name}${force ? " [force]" : ""}...`);
  await startService(service, { force });
  return { ok: true, message: `${service.name} restarted (PID ${service.proc?.pid})` };
}

export interface HealthCheckResult {
  healthy: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

function toGatewayWsUrl(healthUrl: string): string {
  const url = new URL(healthUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  const token = getGatewayToken();
  if (token) {
    url.searchParams.set("token", token);
  }
  return url.toString();
}

async function restartExtensionViaGateway(
  gatewayService: ManagedService,
  extensionId: string,
): Promise<void> {
  if (!gatewayService.healthUrl) {
    throw new Error("Gateway health URL is required for targeted extension restart");
  }

  const client = createGatewayClient({
    url: toGatewayWsUrl(gatewayService.healthUrl),
    requestTimeoutMs: 5000,
    autoReconnect: false,
  });

  try {
    await client.connect();
    await client.call("gateway.restart_extension", { extension: extensionId }, { timeoutMs: 5000 });
  } finally {
    client.disconnect(1000, "watchdog restart complete");
  }
}

export async function checkHealth(service: ManagedService): Promise<HealthCheckResult> {
  // No healthUrl — process-alive is the only check
  if (!service.healthUrl) {
    return isProcessAlive(service) ? { healthy: true } : { healthy: false, reason: "dead" };
  }

  try {
    const headers: Record<string, string> = {};
    const token = getGatewayToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await fetch(service.healthUrl, { signal: AbortSignal.timeout(2000), headers });
    if (!res.ok) {
      return { healthy: false, reason: `http_${res.status}` };
    }

    // If this service requires extensions to be loaded, check for that
    if (service.requireExtensions) {
      const body = (await res.json()) as {
        extensions?: Record<string, unknown>;
        runtimeLocks?: Array<{
          extensionId: string;
          lockType: string;
          resourceKey: string;
          holderPid: number | null;
          holderInstanceId: string;
          acquiredAt: number;
          updatedAt: number;
          staleAfterMs: number;
          metadata: Record<string, unknown> | null;
          stale: boolean;
        }>;
      };
      const extensionCount = body.extensions ? Object.keys(body.extensions).length : 0;
      if (extensionCount === 0) {
        return { healthy: false, reason: "zero_extensions", details: { extensionCount } };
      }

      if (service.id === "gateway") {
        const memoryLock =
          body.runtimeLocks?.find(
            (lock) =>
              lock.extensionId === "memory" &&
              lock.lockType === "singleton" &&
              lock.resourceKey === "__default__",
          ) ?? null;
        if (memoryLock?.stale) {
          return {
            healthy: false,
            reason: "memory_stale_lock",
            details: { memoryLock },
          };
        }
        if (memoryLock) {
          return { healthy: true, details: { memoryLock } };
        }
      }
    } else if (service.id === "gateway") {
      const body = (await res.json()) as {
        runtimeLocks?: Array<{
          extensionId: string;
          lockType: string;
          resourceKey: string;
          holderPid: number | null;
          holderInstanceId: string;
          acquiredAt: number;
          updatedAt: number;
          staleAfterMs: number;
          metadata: Record<string, unknown> | null;
          stale: boolean;
        }>;
      };
      const memoryLock =
        body.runtimeLocks?.find(
          (lock) =>
            lock.extensionId === "memory" &&
            lock.lockType === "singleton" &&
            lock.resourceKey === "__default__",
        ) ?? null;
      if (memoryLock?.stale) {
        return {
          healthy: false,
          reason: "memory_stale_lock",
          details: { memoryLock },
        };
      }
      if (memoryLock) {
        return { healthy: true, details: { memoryLock } };
      }
    }

    return { healthy: true };
  } catch {
    return { healthy: false, reason: "unreachable" };
  }
}

function restartThresholdForReason(reason: string | null): number {
  if (reason === "memory_stale_lock" || reason === "memory_orphaned_lock") {
    return 1;
  }
  return UNHEALTHY_RESTART_THRESHOLD;
}

function incidentKeyFor(service: ManagedService, reason: string | null): string {
  return `${service.id}:${reason ?? "unknown"}`;
}

function buildDurations(
  service: ManagedService,
  now = Date.now(),
): {
  incidentMs?: number;
  restartRequestedMs?: number;
  restartCompletedMs?: number;
  recoveryMs?: number;
} {
  const incident = service.activeIncident;
  if (!incident) return {};
  return {
    incidentMs: now - incident.openedAt,
    restartRequestedMs: incident.restartRequestedAt ? now - incident.restartRequestedAt : undefined,
    restartCompletedMs: incident.restartCompletedAt ? now - incident.restartCompletedAt : undefined,
    recoveryMs: incident.restartCompletedAt ? now - incident.restartCompletedAt : undefined,
  };
}

function openIncident(
  service: ManagedService,
  reason: string | null,
  details: Record<string, unknown> | undefined,
): void {
  const key = incidentKeyFor(service, reason);
  if (service.activeIncident?.key === key) {
    return;
  }

  service.activeIncident = {
    key,
    incidentId: crypto.randomUUID(),
    reason,
    openedAt: Date.now(),
    firstEvidence: details ?? null,
    restartRequestedAt: null,
    restartCompletedAt: null,
    restartAttemptId: null,
  };

  recordRecoveryEvent({
    timestamp: new Date().toISOString(),
    serviceId: service.id,
    servicePid: service.proc?.pid ?? null,
    incidentId: service.activeIncident.incidentId,
    attemptId: null,
    event:
      reason === "memory_stale_lock" || reason === "memory_orphaned_lock"
        ? "memory_stale_lock_detected"
        : "health_check_failed",
    reason,
    decision: {
      action: "observe",
      target: service.id,
      triggerThreshold: restartThresholdForReason(reason),
    },
    outcome: "observed",
    durations: buildDurations(service),
    evidence: {
      before: details,
    },
    details,
  });
}

function markRestartRequested(
  service: ManagedService,
  reason: string | null,
  details: Record<string, unknown>,
): void {
  if (service.activeIncident?.restartRequestedAt) {
    return;
  }
  if (service.activeIncident) {
    service.activeIncident.restartRequestedAt = Date.now();
    service.activeIncident.restartAttemptId = crypto.randomUUID();
  }
  const restartThreshold = restartThresholdForReason(reason);
  const recoveryTarget =
    typeof details.recoveryTarget === "string" ? (details.recoveryTarget as string) : service.id;
  recordRecoveryEvent({
    timestamp: new Date().toISOString(),
    serviceId: service.id,
    servicePid: service.proc?.pid ?? null,
    incidentId: service.activeIncident?.incidentId,
    attemptId: service.activeIncident?.restartAttemptId ?? null,
    event: "restart_requested",
    reason,
    decision: {
      action: recoveryTarget === service.id ? "restart_service" : "restart_extension",
      target: recoveryTarget,
      triggerThreshold: restartThreshold,
    },
    outcome: "restart_in_progress",
    durations: buildDurations(service),
    evidence: {
      before:
        details.health && typeof details.health === "object"
          ? (details.health as Record<string, unknown>)
          : undefined,
    },
    details,
  });
}

function markRestartCompleted(
  service: ManagedService,
  reason: string | null,
  details: Record<string, unknown>,
): void {
  if (service.activeIncident) {
    service.activeIncident.restartCompletedAt = Date.now();
  }
  const recoveryTarget =
    typeof details.recoveryTarget === "string" ? (details.recoveryTarget as string) : service.id;
  recordRecoveryEvent({
    timestamp: new Date().toISOString(),
    serviceId: service.id,
    servicePid: service.proc?.pid ?? null,
    incidentId: service.activeIncident?.incidentId,
    attemptId: service.activeIncident?.restartAttemptId ?? null,
    event: "restart_completed",
    reason,
    decision: {
      action: recoveryTarget === service.id ? "restart_service" : "restart_extension",
      target: recoveryTarget,
      triggerThreshold: restartThresholdForReason(reason),
    },
    outcome: "restart_in_progress",
    durations: buildDurations(service),
    evidence: {
      before: service.activeIncident?.firstEvidence ?? undefined,
      after: details,
    },
    details,
  });
}

function closeIncident(
  service: ManagedService,
  details: Record<string, unknown> | undefined,
): void {
  if (!service.activeIncident) return;
  const outcome = service.activeIncident.restartRequestedAt
    ? "recovered_after_restart"
    : "recovered";
  recordRecoveryEvent({
    timestamp: new Date().toISOString(),
    serviceId: service.id,
    servicePid: service.proc?.pid ?? null,
    incidentId: service.activeIncident.incidentId,
    attemptId: service.activeIncident.restartAttemptId ?? null,
    event: "health_restored",
    reason: service.activeIncident.reason,
    decision: {
      action: "wait_for_health_restore",
      target: service.id,
      triggerThreshold: restartThresholdForReason(service.activeIncident.reason),
    },
    outcome,
    durations: buildDurations(service),
    evidence: {
      before: service.activeIncident.firstEvidence ?? undefined,
      after: details,
    },
    details,
  });
  service.activeIncident = null;
}

// ── Health Monitor Loop ─────────────────────────────────

export async function monitorServices(): Promise<void> {
  for (const [_id, service] of Object.entries(services)) {
    const previousReason = service.lastHealthReason ?? null;
    const processAlive = isProcessAlive(service);
    const health = processAlive ? await checkHealth(service) : { healthy: false, reason: "dead" };
    const healthy = health.healthy;
    const reason = health.reason ?? null;
    service.lastHealthReason = reason;
    service.lastHealthDetails = health.details ?? null;

    // Record snapshot
    service.history.push({
      timestamp: Date.now(),
      processAlive,
      healthy,
      reason: reason ?? undefined,
    });
    if (service.history.length > HEALTH_HISTORY_SIZE) {
      service.history = service.history.slice(-HEALTH_HISTORY_SIZE);
    }

    if (!processAlive) {
      // Process died — restart with backoff
      service.consecutiveFailures++;
      const timeSinceRestart = Date.now() - service.lastRestart;
      if (timeSinceRestart < service.restartBackoff) continue;

      openIncident(service, "dead", undefined);
      log("WARN", `${service.name} process dead — restarting...`);
      await startService(service);
      service.restartBackoff = Math.min(service.restartBackoff * 2, 30000);
    } else if (!healthy) {
      // Process alive but health check failing
      service.consecutiveFailures++;
      const restartThreshold = restartThresholdForReason(reason);
      openIncident(service, reason, health.details);
      if (service.consecutiveFailures >= restartThreshold) {
        const timeSinceRestart = Date.now() - service.lastRestart;
        if (timeSinceRestart < service.restartBackoff) continue;

        const recoveryTarget =
          service.id === "gateway" && reason === "memory_stale_lock" ? "memory" : service.id;
        markRestartRequested(service, reason, {
          consecutiveFailures: service.consecutiveFailures,
          restartBackoff: service.restartBackoff,
          recoveryTarget,
          health: health.details ?? undefined,
        });
        if (service.id === "gateway" && reason === "memory_stale_lock") {
          log(
            "WARN",
            `${service.name} unhealthy for ${service.consecutiveFailures} checks (${reason}) — restarting memory extension via gateway...`,
          );
          await restartExtensionViaGateway(service, "memory");
          service.lastRestart = Date.now();
          markRestartCompleted(service, reason, { recoveryTarget: "memory" });
          service.restartBackoff = Math.min(service.restartBackoff * 2, 30000);
        } else {
          log(
            "WARN",
            `${service.name} unhealthy for ${service.consecutiveFailures} checks (${reason ?? "unknown"}) — restarting...`,
          );
          const useForce = reason === "zero_extensions";
          await startService(service, { force: useForce });
          markRestartCompleted(service, reason, {
            pid: service.proc?.pid ?? null,
            forced: useForce,
            recoveryTarget,
          });
          service.restartBackoff = Math.min(service.restartBackoff * 2, 30000);
        }
      }
    } else {
      // Healthy — reset counters
      if (service.consecutiveFailures > 0 || previousReason || service.activeIncident) {
        closeIncident(service, health.details ?? undefined);
      }
      service.consecutiveFailures = 0;
      if (Date.now() - service.lastRestart > 60000) {
        service.restartBackoff = 1000;
      }
    }
  }
}

// ── Graceful Shutdown ───────────────────────────────────

export function stopAllServices(): void {
  for (const [, service] of Object.entries(services)) {
    if (service.proc && service.proc.exitCode === null) {
      log("INFO", `Stopping ${service.name} (PID ${service.proc.pid})...`);
      service.proc.kill("SIGTERM");
    }
  }
}
