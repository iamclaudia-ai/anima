/**
 * Anima Watchdog
 *
 * Standalone process supervisor + dashboard that manages gateway, agent-host,
 * and claude remote-control as direct child processes. Provides health monitoring,
 * log viewing, and restart capabilities independent of the gateway.
 *
 * ZERO monorepo imports — this file is completely self-contained so it keeps running
 * even when the gateway or shared packages have build errors.
 *
 * Usage:
 *   bun run watchdog                           # Start watchdog (from root)
 *   open http://localhost:30085                # Dashboard with log viewer
 *   curl localhost:30085/status                # JSON status
 *   curl localhost:30085/api/logs              # List log files
 *   curl localhost:30085/api/logs/gateway.log?lines=50  # Tail logs
 *   curl -X POST localhost:30085/restart/gateway        # Restart gateway
 */

import { WATCHDOG_PORT, STARTED_AT, HEALTH_CHECK_INTERVAL, getGatewayToken } from "./constants";
import { log } from "./logger";
import {
  services,
  startService,
  restartService,
  monitorServices,
  stopAllServices,
} from "./services";
import { listLogFiles, tailLogFile } from "./logs";
import { getStatus } from "./status";
import { ensureClaudeUpToDate } from "./claude-update";
import dashboard from "./dashboard/index.html";
import { timingSafeEqual } from "node:crypto";

// ── HTTP Server ──────────────────────────────────────────

function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  return token.length > 0 ? token : null;
}

function validateToken(provided: string | null, expected: string | null): boolean {
  if (!provided || !expected || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided, "utf8"), Buffer.from(expected, "utf8"));
}

function authenticateRequest(req: Request): boolean {
  const expected = getGatewayToken();
  if (!expected) return false;
  const url = new URL(req.url);
  const headerToken = extractBearerToken(req.headers.get("Authorization"));
  if (validateToken(headerToken, expected)) return true;
  return validateToken(url.searchParams.get("token"), expected);
}

function unauthorized(): Response {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

const server = Bun.serve({
  port: WATCHDOG_PORT,
  hostname: "127.0.0.1",
  routes: {
    // JSON status
    "/status": async (req) =>
      authenticateRequest(req) ? Response.json(await getStatus()) : unauthorized(),

    // Server info for client-side uptime/port
    "/api/info": (req) =>
      authenticateRequest(req)
        ? Response.json({ startedAt: STARTED_AT, port: WATCHDOG_PORT })
        : unauthorized(),

    // List log files
    "/api/logs": (req) =>
      authenticateRequest(req) ? Response.json({ files: listLogFiles() }) : unauthorized(),

    // Tail a log file: /api/logs/:filename
    "/api/logs/*": (req) => {
      if (!authenticateRequest(req)) return unauthorized();
      const url = new URL(req.url);
      const fileName = decodeURIComponent(url.pathname.slice("/api/logs/".length));
      const maxLines = parseInt(url.searchParams.get("lines") || "200", 10);
      const byteOffset = parseInt(url.searchParams.get("offset") || "0", 10);

      try {
        const result = tailLogFile(fileName, Math.min(maxLines, 1000), Math.max(byteOffset, 0));
        return Response.json(result);
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          { status: 400 },
        );
      }
    },

    // Restart service: POST /restart/:id
    "/restart/*": async (req) => {
      if (!authenticateRequest(req)) return unauthorized();
      if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
      const url = new URL(req.url);
      const serviceId = url.pathname.split("/restart/")[1];
      const force = ["1", "true", "yes"].includes(
        (url.searchParams.get("force") || "").toLowerCase(),
      );
      const result = await restartService(serviceId, { force });
      return Response.json(result, { status: result.ok ? 200 : 400 });
    },

    // Dashboard — SPA fallback
    "/*": dashboard,
  },
});

// ── Health Monitor ───────────────────────────────────────

setInterval(monitorServices, HEALTH_CHECK_INTERVAL);

// ── Startup ──────────────────────────────────────────────

log("INFO", `Watchdog starting on http://localhost:${WATCHDOG_PORT}`);

console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   Anima Watchdog on http://localhost:${WATCHDOG_PORT}                  ║
║                                                               ║
║   Dashboard:  http://localhost:${WATCHDOG_PORT}                        ║
║   Status:     http://localhost:${WATCHDOG_PORT}/status                 ║
║   Logs:       http://localhost:${WATCHDOG_PORT}/api/logs               ║
║   Restart:    curl -X POST localhost:${WATCHDOG_PORT}/restart/gateway  ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
`);

// Keep the Claude CLI current before services boot — the agent-host's CLI
// runtime spawns whatever `claude` resolves to at session time.
await ensureClaudeUpToDate();

// Start services — spawn as direct child processes
for (const [_id, service] of Object.entries(services)) {
  await startService(service);
}

// Graceful shutdown — kill child processes
process.on("SIGINT", () => {
  log("INFO", "Shutting down — stopping all services...");
  stopAllServices();
  server.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  log("INFO", "Received SIGTERM — stopping all services...");
  stopAllServices();
  server.stop();
  process.exit(0);
});
