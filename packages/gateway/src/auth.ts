/**
 * Gateway Authentication
 *
 * Validates bearer tokens on WebSocket upgrade and HTTP requests.
 * Token is auto-generated on first run and stored in ~/.anima/anima.json.
 */

import { ensureToken, extractBearerToken, validateToken, clearConfigCache } from "@anima/shared";
import { createLogger } from "@anima/shared";
import { join } from "node:path";
import { homedir } from "node:os";

const log = createLogger("Gateway:Auth", join(homedir(), ".anima", "logs", "gateway.log"));

let cachedToken: string | null = null;

/**
 * Initialize auth — ensures a token exists (auto-generates if missing).
 * Returns the token and whether it was newly generated.
 */
export function initAuth(): { token: string; generated: boolean } {
  const result = ensureToken();
  cachedToken = result.token;
  if (result.generated) {
    log.info("Generated new gateway token (first run)");
  }
  return result;
}

/**
 * Reset the cached token — call when config file changes so
 * a regenerated token takes effect without restart.
 */
export function resetCachedToken(): void {
  cachedToken = null;
  clearConfigCache();
}

function getToken(): string {
  if (!cachedToken) {
    const result = ensureToken();
    cachedToken = result.token;
  }
  return cachedToken;
}

/**
 * Authenticate an incoming HTTP/WebSocket request.
 *
 * Checks in order:
 * 1. Authorization: Bearer <token> header
 * 2. ?token=<token> query parameter (for WebSocket upgrades)
 */
export function authenticateRequest(
  req: globalThis.Request,
): { ok: true } | { ok: false; status: number; message: string } {
  const expected = getToken();
  const url = new URL(req.url);

  // Try Authorization header first
  const headerToken = extractBearerToken(req.headers.get("Authorization"));
  if (headerToken && validateToken(headerToken, expected)) {
    return { ok: true };
  }

  // Try query param (for WebSocket upgrades from browsers/clients)
  const queryToken = url.searchParams.get("token");
  if (queryToken && validateToken(queryToken, expected)) {
    return { ok: true };
  }

  return { ok: false, status: 401, message: "Unauthorized" };
}
