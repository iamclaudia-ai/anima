/**
 * Mail extension config (`extensions.mail.config` in anima.json).
 *
 * Credentials come from a Zoho Self Client in Claudia's own account, with
 * scopes ZohoMail.accounts.READ, folders.READ, messages.READ/CREATE/UPDATE and
 * deliberately no DELETE.
 */

import { homedir } from "node:os";
import { join } from "node:path";
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
  /**
   * Michael's addresses. Their DMARC-verified mail is *trusted*: it wakes
   * Claudia, can be replied to, and its tickets can be delegated.
   */
  principals: z
    .array(z.email())
    .default([])
    .transform((list) => list.map((a) => a.toLowerCase())),
  /**
   * People Claudia corresponds with on Michael's behalf (clients). Their
   * DMARC-verified mail wakes her and can be replied to, but their requests are
   * not commands, and their tickets are never trusted.
   */
  contacts: z
    .array(z.email())
    .default([])
    .transform((list) => list.map((a) => a.toLowerCase())),
  /** Rate limits on mail.reply, so an auto-reply loop can't run away. */
  replyLimits: z
    .object({
      perRecipientPerHour: z.number().int().min(1).default(3),
      perDay: z.number().int().min(1).default(20),
    })
    .default({ perRecipientPerHour: 3, perDay: 20 }),
  wake: z
    .object({
      enabled: z.boolean().default(false),
      cwd: z
        .string()
        .default("~/.anima/mail-session")
        .transform((p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p)),
      profile: z
        .string()
        .default("mail")
        .refine((p) => p !== "yolo", "Mail sessions must not run as yolo"),
      quietMs: z.number().int().min(0).default(120_000),
      maxWaitMs: z.number().int().min(0).default(600_000),
      maxPerHour: z.number().int().min(1).default(6),
      digestHour: z.number().int().min(0).max(23).default(18),
    })
    .default({
      enabled: false,
      cwd: "~/.anima/mail-session",
      profile: "mail",
      quietMs: 120_000,
      maxWaitMs: 600_000,
      maxPerHour: 6,
      digestHour: 18,
    }),
});

export type MailConfig = z.infer<typeof mailConfigSchema>;

export function parseMailConfig(raw: Record<string, unknown>): MailConfig {
  return mailConfigSchema.parse(raw);
}
