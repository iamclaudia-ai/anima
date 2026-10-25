#!/usr/bin/env bun
/**
 * Notify Extension — reach Michael on his phone and laptop, from any host.
 *
 * `notify.send` is the one way anything in Anima asks for Michael's
 * attention when he isn't looking at it: a scheduled task that broke, an
 * unattended session that is stuck, a token about to expire.
 *
 * Each host is configured to deliver (Anima Sedes: iMessage, which lands on
 * his phone and Mac together and can be answered) or to relay to a host that
 * delivers (vesuvius → Sedes over Tailscale). See config.ts.
 *
 * Identical messages inside the dedupe window are sent once, so a loop or a
 * task failing every five minutes can't flood his phone.
 */

import type {
  AnimaExtension,
  ExtensionContext,
  ExtensionMethodDefinition,
  HealthCheckResponse,
} from "@anima/shared";
import { z } from "zod";
import { type NotifyConfig, parseNotifyConfig } from "./config";
import { callRemote } from "./relay";

const MAX_RECENT = 20;

const SendSchema = z.object({
  message: z.string().min(1).max(1500).describe("What Michael needs to know, in a sentence or two"),
  title: z.string().min(1).max(120).optional().describe("Short headline (default: Anima)"),
  source: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe("Who is asking: a task, session or extension name"),
  host: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe("Originating host; set by relays, defaults to this host"),
  hops: z.number().int().min(0).max(1).optional().default(0).describe("Relay hops so far"),
});

type SendParams = z.infer<typeof SendSchema>;

interface SentRecord {
  at: string;
  text: string;
  via: string;
  ok: boolean;
  error?: string;
  deduped?: boolean;
}

/** The text Michael reads: headline, message, and where it came from. */
export function formatNotification(params: SendParams, defaultHost: string): string {
  const origin = [params.source, `on ${params.host ?? defaultHost}`].filter(Boolean).join(" ");
  return `🔔 ${params.title ?? "Anima"}\n${params.message}\n— ${origin}`;
}

export function createNotifyExtension(rawConfig: Record<string, unknown> = {}): AnimaExtension {
  const config: NotifyConfig = parseNotifyConfig(rawConfig);
  let ctx: ExtensionContext | null = null;
  const recent: SentRecord[] = [];
  const lastSentAt = new Map<string, number>();

  function remember(record: SentRecord): void {
    recent.unshift(record);
    recent.length = Math.min(recent.length, MAX_RECENT);
  }

  async function deliver(params: SendParams): Promise<{ via: string }> {
    const { delivery } = config;
    if (delivery.type === "imessage") {
      if (!ctx) throw new Error("Notify extension is not started");
      await ctx.call("imessage.send", {
        to: delivery.to,
        text: formatNotification(params, config.host),
      });
      return { via: "imessage" };
    }
    // A relay forwards to a host that delivers. Refusing a second hop stops
    // two misconfigured relays from bouncing a message forever.
    if (params.hops >= 1) throw new Error("Refusing to relay a relayed notification");
    await callRemote(delivery.url, delivery.token, "notify.send", {
      ...params,
      host: params.host ?? config.host,
      hops: params.hops + 1,
    });
    return { via: `relay:${new URL(delivery.url).host}` };
  }

  async function send(params: SendParams) {
    const text = formatNotification(params, config.host);
    const now = Date.now();
    const previous = lastSentAt.get(text);
    if (previous !== undefined && now - previous < config.dedupeWindowMs) {
      remember({ at: new Date(now).toISOString(), text, via: "none", ok: true, deduped: true });
      return { sent: false, deduped: true };
    }
    // Claimed before sending, so two identical calls racing each other
    // still produce one message.
    lastSentAt.set(text, now);
    try {
      const { via } = await deliver(params);
      remember({ at: new Date(now).toISOString(), text, via, ok: true });
      ctx?.log.info("Notification sent", { via, source: params.source ?? null });
      return { sent: true, via };
    } catch (error) {
      lastSentAt.delete(text);
      const message = error instanceof Error ? error.message : String(error);
      remember({ at: new Date(now).toISOString(), text, via: "none", ok: false, error: message });
      ctx?.log.error("Notification failed", { error: message });
      throw error;
    }
  }

  const methods: ExtensionMethodDefinition[] = [
    {
      name: "notify.send",
      description:
        "Notify Michael on his phone and laptop (iMessage via Anima Sedes, relayed from other hosts). For things that need him when he isn't looking: failures, stuck sessions, expiring credentials. Identical text within 10 minutes is sent once.",
      inputSchema: SendSchema,
    },
    {
      name: "notify.health_check",
      description: "Notify delivery route and recent sends",
      inputSchema: z.object({}),
    },
  ];
  const schemas = new Map(methods.map((m) => [m.name, m.inputSchema]));

  return {
    id: "notify",
    name: "Notify",
    methods,
    events: [],

    async start(context: ExtensionContext) {
      ctx = context;
      ctx.log.info("Notify started", { host: config.host, delivery: config.delivery.type });
    },

    async stop() {
      ctx = null;
    },

    async handleMethod(method: string, rawParams: Record<string, unknown>) {
      // The extension host doesn't validate params yet (#86), so defaults
      // only apply if we parse here.
      const schema = schemas.get(method);
      const params = schema ? schema.parse(rawParams) : rawParams;
      switch (method) {
        case "notify.send":
          return send(params as SendParams);

        case "notify.health_check": {
          const failures = recent.filter((r) => !r.ok).length;
          const response: HealthCheckResponse = {
            ok: true,
            status: failures > 0 && recent[0] && !recent[0].ok ? "degraded" : "healthy",
            label: "Notify",
            metrics: [
              { label: "Host", value: config.host },
              {
                label: "Delivery",
                value:
                  config.delivery.type === "relay"
                    ? `relay → ${new URL(config.delivery.url).host}`
                    : "iMessage",
              },
              { label: "Recent sends", value: recent.length },
              { label: "Recent failures", value: failures },
            ],
            items: recent.slice(0, 5).map((r) => ({
              id: r.at,
              label: r.text.split("\n")[1] ?? r.text,
              status: r.deduped ? "inactive" : r.ok ? "healthy" : "dead",
              details: { at: r.at, via: r.via, ...(r.error ? { error: r.error } : {}) },
            })),
          };
          return response;
        }

        default:
          throw new Error(`Unknown method: ${method}`);
      }
    },

    health() {
      return {
        ok: true,
        details: { host: config.host, delivery: config.delivery.type, recent: recent.length },
      };
    },
  };
}

export default createNotifyExtension;

// ── Direct execution with HMR ────────────────────────────────
import { runExtensionHost } from "@anima/extension-host";
if (import.meta.main) runExtensionHost(createNotifyExtension);
