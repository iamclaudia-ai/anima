/**
 * Secret and signature checks for inbound webhooks.
 *
 * Every comparison goes through `secretsEqual`, which hashes both sides first
 * so neither the content nor the length of a secret leaks through timing.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { HmacSignatureConfig } from "./config";

export function secretsEqual(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function hmacSha256(secret: string, body: Uint8Array, encoding: "hex" | "base64"): string {
  return createHmac("sha256", secret).update(body).digest(encoding);
}

/** Verify a header of the form `<prefix><digest>` against the raw body. */
export function verifyHmac(
  config: HmacSignatureConfig,
  headerValue: string | null,
  body: Uint8Array,
): boolean {
  if (!headerValue) return false;
  const prefix = config.prefix ?? "";
  if (!headerValue.startsWith(prefix)) return false;
  const provided = headerValue.slice(prefix.length).trim();
  return secretsEqual(provided, hmacSha256(config.secret, body, config.encoding));
}

/** Zoho Mail: `x-hook-signature` is base64(HMAC-SHA256(x-hook-secret, raw body)). */
export const ZOHO_SECRET_HEADER = "x-hook-secret";
export const ZOHO_SIGNATURE_HEADER = "x-hook-signature";

export function verifyZoho(secret: string, headerValue: string | null, body: Uint8Array): boolean {
  if (!headerValue) return false;
  return secretsEqual(headerValue.trim(), hmacSha256(secret, body, "base64"));
}
