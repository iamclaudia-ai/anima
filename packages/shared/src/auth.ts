/**
 * Gateway Authentication Utilities
 *
 * Shared token validation and extraction for all clients (gateway, CLI, web UI).
 * Single bearer token model — no user management, no sessions.
 */

import { randomUUID } from "node:crypto";
import { timingSafeEqual } from "node:crypto";

const TOKEN_PREFIX = "anima_sk_";

/**
 * Generate a new gateway token with the `anima_sk_` prefix.
 * Format: anima_sk_<32 hex chars> — easy to identify in logs and config.
 */
export function generateToken(): string {
  const random = randomUUID().replace(/-/g, "");
  return `${TOKEN_PREFIX}${random}`;
}

/**
 * Validate a provided token against the expected token.
 * Uses constant-time comparison to prevent timing attacks.
 */
export function validateToken(provided: string | null | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  if (provided.length !== expected.length) return false;

  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return timingSafeEqual(a, b);
}

/**
 * Extract a bearer token from an Authorization header value.
 * Returns null if the header is missing or malformed.
 */
export function extractBearerToken(authHeader: string | null | undefined): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  return token.length > 0 ? token : null;
}
