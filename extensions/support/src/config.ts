/**
 * Support extension config (`extensions.support.config` in anima.json).
 *
 * {
 *   "delegation": { "profile": "auto", "maxPerHour": 4 }
 * }
 */

import { z } from "zod";

export const supportConfigSchema = z.object({
  delegation: z
    .object({
      /** Profile of delegated sessions. Never yolo: the prompt carries customer text. */
      profile: z
        .string()
        .default("auto")
        .refine((p) => p !== "yolo", "Delegated sessions must not run as yolo"),
      maxPerHour: z.number().int().min(1).max(60).default(4),
    })
    .default({ profile: "auto", maxPerHour: 4 }),
});

export type SupportConfig = z.infer<typeof supportConfigSchema>;

export function parseSupportConfig(raw: Record<string, unknown>): SupportConfig {
  return supportConfigSchema.parse(raw);
}
