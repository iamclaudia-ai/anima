/**
 * Replies from the Mail session (`mail.reply`, MCP `mail_reply`).
 *
 * The one way the restricted `mail` profile can send: a reply, in the thread,
 * to the sender of a DMARC-verified message from Michael or a contact. The
 * recipient always comes from the original message, never from the caller,
 * so an email can't talk her into mailing anyone else. Every reply notifies
 * Michael, and a rate limit stops an auto-reply loop.
 */

import { z } from "zod";

export const replySchema = z.object({
  messageId: z.string().regex(/^\d{1,25}$/, "a Zoho message id (digits)"),
  folderId: z
    .string()
    .regex(/^\d{1,25}$/, "a Zoho folder id (digits)")
    .optional(),
  body: z.string().min(1).max(50_000),
  format: z.enum(["plaintext", "html"]).default("plaintext"),
});

export type ReplyParams = z.infer<typeof replySchema>;

export interface ReplyLimits {
  perRecipientPerHour: number;
  perDay: number;
}

interface StateLike {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
}

interface SentReply {
  to: string;
  at: number;
}

const STATE_KEY = "replyLog";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** "Re: <subject>", without stacking prefixes. */
export function replySubject(subject: string): string {
  const flat = subject.replace(/[\r\n]+/g, " ").trim();
  return /^re:/i.test(flat) ? flat : `Re: ${flat || "(no subject)"}`;
}

/** Replies sent in the last day, persisted so a restart doesn't reset the limit. */
export class ReplyLimiter {
  constructor(
    private readonly deps: { state: StateLike; limits: ReplyLimits; now?: () => number },
  ) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private recent(): SentReply[] {
    const cutoff = this.now() - DAY_MS;
    return (this.deps.state.get<SentReply[]>(STATE_KEY) ?? []).filter((r) => r.at > cutoff);
  }

  /** Throw if one more reply to `to` would go over a limit. */
  check(to: string): void {
    const recent = this.recent();
    const { perRecipientPerHour, perDay } = this.deps.limits;
    if (recent.length >= perDay) {
      throw new Error(`Reply limit reached: ${perDay} replies in the last 24 hours`);
    }
    const hourAgo = this.now() - HOUR_MS;
    const toThem = recent.filter((r) => r.to === to.toLowerCase() && r.at > hourAgo);
    if (toThem.length >= perRecipientPerHour) {
      throw new Error(
        `Reply limit reached: ${perRecipientPerHour} replies to ${to} in the last hour (an auto-reply loop?). Tell Michael instead.`,
      );
    }
  }

  record(to: string): void {
    this.deps.state.set(STATE_KEY, [...this.recent(), { to: to.toLowerCase(), at: this.now() }]);
  }
}
