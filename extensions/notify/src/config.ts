/**
 * Notify configuration: where this host's notifications go.
 *
 * Exactly one delivery per host:
 *
 *   "notify": { "enabled": true, "config": {
 *     "host": "sedes",
 *     "delivery": { "type": "imessage", "to": "<Michael's handle>" }
 *   }}
 *
 *   "notify": { "enabled": true, "config": {
 *     "host": "vesuvius",
 *     "delivery": { "type": "relay", "url": "wss://gateway.anima-sedes.com/ws", "token": "…" }
 *   }}
 *
 * `imessage` hands the text to this gateway's `imessage.send`, which reaches
 * Michael's phone and Mac at once. `relay` forwards to another gateway's
 * `notify.send`, for a host without iMessage. Gateway-to-gateway will replace
 * the relay hop; nothing else changes.
 */

import { hostname } from "node:os";
import { z } from "zod";

const DeliverySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("imessage"), to: z.string().min(1) }),
  z.object({
    type: z.literal("relay"),
    url: z.string().regex(/^wss?:\/\//, "relay url must be ws:// or wss://"),
    token: z.string().min(1),
  }),
]);

const ConfigSchema = z.object({
  /** How this host names itself in messages. Defaults to the machine name. */
  host: z.string().min(1).optional(),
  delivery: DeliverySchema,
  /** Identical text within this window is sent once. */
  dedupeWindowMs: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .default(10 * 60_000),
});

export type Delivery = z.infer<typeof DeliverySchema>;

export interface NotifyConfig {
  host: string;
  delivery: Delivery;
  dedupeWindowMs: number;
}

export function parseNotifyConfig(raw: Record<string, unknown>): NotifyConfig {
  const parsed = ConfigSchema.parse(raw);
  return {
    host: parsed.host ?? hostname().replace(/\.local$/, ""),
    delivery: parsed.delivery,
    dedupeWindowMs: parsed.dedupeWindowMs,
  };
}
