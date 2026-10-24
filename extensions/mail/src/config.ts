/**
 * Mail extension config (`extensions.mail.config` in anima.json).
 *
 * Credentials come from a Zoho Self Client in Claudia's own account, with
 * scopes ZohoMail.accounts.READ, folders.READ, messages.READ/CREATE/UPDATE and
 * deliberately no DELETE.
 */

import { z } from "zod";

export const mailConfigSchema = z.object({
  /** Zoho data center suffix: "com", "eu", "in", "com.au", … */
  dataCenter: z
    .string()
    .regex(/^[a-z.]+$/)
    .default("com"),
  address: z.email(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  refreshToken: z.string().min(1),
  accountId: z.string().regex(/^\d+$/),
  /** How often to look for mail the webhook missed. */
  reconcileMinutes: z.number().int().min(1).default(30),
  /** Bodies longer than this are cut, with a note saying so. */
  maxBodyChars: z.number().int().positive().default(100_000),
});

export type MailConfig = z.infer<typeof mailConfigSchema>;

export function parseMailConfig(raw: Record<string, unknown>): MailConfig {
  return mailConfigSchema.parse(raw);
}
