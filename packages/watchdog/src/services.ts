/**
 * Service management — direct process supervision, health checks, auto-restart.
 *
 * Manages gateway as a direct child process (Bun.spawn).
 * No tmux — stdout/stderr pipe to log files, watchdog owns the process lifecycle.
 */

import {
  PROJECT_DIR,
  LOGS_DIR,
  HEALTH_HISTORY_SIZE,
  UNHEALTHY_RESTART_THRESHOLD,
} from "./constants";
import { log } from "./logger";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";

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
  healthUrl: string;
  port: number;
  restartBackoff: number;
  lastRestart: number;
  consecutiveFailures: number;
  history: HealthSnapshot[];
  proc: Subprocess | null;
  lastHealthReason?: string | null;
}

function gatewayCommand(): string[] {
  // Watch mode is useful for local dev, but too expensive for always-on watchdog usage.
  if (process.env.CLAUDIA_GATEWAY_WATCH === "true") {
    return ["bun", "run", "--watch", "packages/gateway/src/start.ts"];
  }
  return ["bun", "run", "packages/gateway/src/start.ts"];
}

// ── Service Definitions ─────────────────────────────────

export const services: Record<string, ManagedService> = {
  // Agent-host starts BEFORE gateway — extensions need to connect to it during startup
  "agent-host": {
    name: "Agent Host",
    id: "agent-host",
    command: ["bun", "run", "packages/agent-host/src/index.ts"],
    healthUrl: "http://localhost:30087/health",
    port: 30087,
    restartBackoff: 1000,
    lastRestart: 0,
    consecutiveFailures: 0,
    history: [],
    proc: null,
  },
  gateway: {
    name: "Gateway",
    id: "gateway",
    command: gatewayCommand(),
    healthUrl: "http://localhost:30086/health",
    port: 30086,
    restartBackoff: 1000,
    lastRestart: 0,
    consecutiveFailures: 0,
    history: [],
    proc: null,
  },
};

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

function commandForStart(service: ManagedService, force = false): string[] {
  if (!force || service.command.includes("--force")) {
    return service.command;
  }
  return [...service.command, "--force"];
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
  await killOrphanProcesses(service.port);

  // Ensure log dir exists
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

  const logPath = join(LOGS_DIR, `${service.id}.log`);
  const command = commandForStart(service, force);

  // Spawn as direct child process. Use pipes + explicit drains to avoid
  // Bun.file stdio redirection issues that can cause runaway CPU.
  service.proc = Bun.spawn(command, {
    cwd: PROJECT_DIR,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FORCE_COLOR: "0" },
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
}

export async function checkHealth(service: ManagedService): Promise<HealthCheckResult> {
  try {
    const res = await fetch(service.healthUrl, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) {
      return { healthy: false, reason: `http_${res.status}` };
    }

    if (service.id !== "gateway") {
      return { healthy: true };
    }

    const body = (await res.json()) as { extensions?: Record<string, unknown> };
    const extensionCount = body.extensions ? Object.keys(body.extensions).length : 0;
    if (extensionCount === 0) {
      return { healthy: false, reason: "zero_extensions" };
    }

    return { healthy: true };
  } catch {
    return { healthy: false, reason: "unreachable" };
  }
}

// ── Health Monitor Loop ─────────────────────────────────

export async function monitorServices(): Promise<void> {
  for (const [_id, service] of Object.entries(services)) {
    const processAlive = isProcessAlive(service);
    const health = processAlive ? await checkHealth(service) : { healthy: false, reason: "dead" };
    const healthy = health.healthy;
    const reason = health.reason ?? null;
    service.lastHealthReason = reason;

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

      log("WARN", `${service.name} process dead — restarting...`);
      await startService(service);
      service.restartBackoff = Math.min(service.restartBackoff * 2, 30000);
    } else if (!healthy) {
      // Process alive but health check failing
      service.consecutiveFailures++;
      if (service.consecutiveFailures >= UNHEALTHY_RESTART_THRESHOLD) {
        const timeSinceRestart = Date.now() - service.lastRestart;
        if (timeSinceRestart < service.restartBackoff) continue;

        log(
          "WARN",
          `${service.name} unhealthy for ${service.consecutiveFailures} checks (${reason ?? "unknown"}) — restarting...`,
        );
        const useForce = reason === "zero_extensions";
        await startService(service, { force: useForce });
        service.restartBackoff = Math.min(service.restartBackoff * 2, 30000);
      }
    } else {
      // Healthy — reset counters
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
