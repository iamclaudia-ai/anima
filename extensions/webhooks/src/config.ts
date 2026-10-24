/**
 * Webhooks extension config (`extensions.webhooks.config` in anima.json).
 *
 * {
 *   "port": 30089,
 *   "hooks": {
 *     "zoho-mail": {
 *       "secret": "<long random path secret>",
 *       "signature": "zoho",
 *       "target": "mail.handle_webhook"
 *     },
 *     "github": {
 *       "secret": "<long random path secret>",
 *       "signature": {
 *         "header": "x-hub-signature-256",
 *         "secret": "${GITHUB_WEBHOOK_SECRET}",
 *         "encoding": "hex",
 *         "prefix": "sha256="
 *       }
 *     }
 *   }
 * }
 *
 * A hook is reached at POST /hook/<name>/<secret>. The path secret is the
 * first gate; a signature, when configured, is the second.
 */

import { z } from "zod";

export const DEFAULT_PORT = 30089;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
export const DEFAULT_RETENTION_DAYS = 30;

const HOOK_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

const hmacSignatureSchema = z.object({
  /** Header carrying the signature, e.g. "x-hub-signature-256". */
  header: z.string().min(1),
  /** Shared signing secret. Use "${ENV_VAR}" to keep it out of the file. */
  secret: z.string().min(16),
  encoding: z.enum(["hex", "base64"]),
  /** Text before the digest in the header value, e.g. "sha256=". */
  prefix: z.string().optional(),
});

const hookSchema = z.object({
  /** Path secret. Long and random: it is what keeps the endpoint private. */
  secret: z.string().min(32),
  /**
   * "zoho": Zoho Mail's scheme. The signing secret arrives once, in
   * `x-hook-secret` on the first request, and is learned and stored; every
   * later request must carry a valid `x-hook-signature`.
   */
  signature: z.union([z.literal("zoho"), hmacSignatureSchema]).optional(),
  /** Extension method called with each delivery, e.g. "mail.handle_webhook". */
  target: z
    .string()
    .regex(/^[a-z0-9_-]+\.[a-z0-9_]+$/)
    .optional(),
  enabled: z.boolean().default(true),
});

export const webhooksConfigSchema = z.object({
  host: z.string().default(DEFAULT_HOST),
  port: z.number().int().min(0).max(65535).default(DEFAULT_PORT),
  maxBodyBytes: z.number().int().positive().default(DEFAULT_MAX_BODY_BYTES),
  /** Delivered and failed deliveries older than this are pruned. */
  retentionDays: z.number().int().positive().default(DEFAULT_RETENTION_DAYS),
  hooks: z
    .record(z.string(), hookSchema)
    .default({})
    .superRefine((hooks, issue) => {
      for (const name of Object.keys(hooks)) {
        if (!HOOK_NAME.test(name)) {
          issue.addIssue({
            code: "custom",
            message: `Invalid hook name "${name}" (lowercase letters, digits, dashes)`,
          });
        }
      }
    }),
});

export type WebhooksConfig = z.infer<typeof webhooksConfigSchema>;
export type HookConfig = z.infer<typeof hookSchema>;
export type HmacSignatureConfig = z.infer<typeof hmacSignatureSchema>;

export function parseWebhooksConfig(raw: Record<string, unknown>): WebhooksConfig {
  return webhooksConfigSchema.parse(raw);
}
