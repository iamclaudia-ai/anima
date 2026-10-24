#!/usr/bin/env bun
/**
 * Webhooks Extension — inbound webhooks from the internet.
 *
 * Runs its own listener (127.0.0.1:30089 by default). The only public way in
 * is the `anima-webhooks` Cloudflare tunnel, which forwards
 * https://webhooks.kiliman.dev/hook/* here and stops everything else at the
 * edge with a 404.
 *
 * Each delivery is checked (path secret, then signature), written to the
 * `webhook_deliveries` inbox, and answered 200. Then, in the background:
 *   - `webhooks.received` is emitted (metadata only; fetch the body with
 *     `webhooks.get_delivery`), and
 *   - the hook's `target` method, if configured, is called with the full
 *     delivery, retrying with backoff until it succeeds or gives up.
 */

import type {
  AnimaExtension,
  ExtensionContext,
  HealthCheckResponse,
  LoggerLike,
} from "@anima/shared";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { type WebhooksConfig, parseWebhooksConfig } from "./config";
import { Dispatcher } from "./dispatcher";
import { startWebhookServer } from "./server";
import { type Delivery, type NewDelivery, WebhookStore, openAnimaDb } from "./store";

const RETRY_TICK_MS = 15_000;
const PRUNE_TICK_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface WebhooksExtensionOptions {
  /** Injected by tests; production opens ~/.anima/anima.db. */
  db?: Database;
}

/** A delivery without its body, for listings and events. */
function summarize(delivery: Delivery | NewDelivery) {
  const { body, headers: _headers, ...rest } = delivery;
  return { ...rest, bytes: Buffer.byteLength(body) };
}

export function createWebhooksExtension(
  rawConfig: Record<string, unknown> = {},
  options: WebhooksExtensionOptions = {},
): AnimaExtension {
  const config: WebhooksConfig = parseWebhooksConfig(rawConfig);
  let ctx: ExtensionContext | null = null;
  let db: Database | null = null;
  let store: WebhookStore | null = null;
  let dispatcher: Dispatcher | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;
  const timers: Array<ReturnType<typeof setInterval>> = [];

  function requireStore(): WebhookStore {
    if (!store) throw new Error("Webhooks extension is not started");
    return store;
  }

  function prune(log: LoggerLike): void {
    const cutoff = new Date(Date.now() - config.retentionDays * DAY_MS).toISOString();
    const removed = requireStore().prune(cutoff);
    if (removed > 0) log.info("Pruned old webhook deliveries", { removed });
  }

  function hookSummaries() {
    return Object.entries(config.hooks).map(([name, hook]) => ({
      name,
      enabled: hook.enabled,
      target: hook.target ?? null,
      signature:
        hook.signature === undefined
          ? "none"
          : hook.signature === "zoho"
            ? "zoho"
            : `hmac:${hook.signature.header}`,
      // Only the zoho scheme learns a secret; whether it has one matters for setup.
      signingSecretLearned:
        hook.signature === "zoho" ? requireStore().getSigningSecret(name) !== null : null,
      lastReceivedAt: requireStore().lastReceivedAt(name),
    }));
  }

  const hookName = z.string().min(1).describe("Hook name from extensions.webhooks.config.hooks");

  return {
    id: "webhooks",
    name: "Webhooks",
    methods: [
      {
        name: "webhooks.health_check",
        description: "Return health status of the webhooks extension",
        inputSchema: z.object({}),
      },
      {
        name: "webhooks.list_hooks",
        description: "List configured hooks: target, signature scheme, last delivery (no secrets)",
        inputSchema: z.object({}),
      },
      {
        name: "webhooks.list_deliveries",
        description: "List recent deliveries, newest first (bodies omitted)",
        inputSchema: z.object({
          hook: hookName.optional(),
          status: z.enum(["pending", "delivered", "failed"]).optional(),
          limit: z.number().int().min(1).max(500).default(50),
        }),
      },
      {
        name: "webhooks.get_delivery",
        description: "Get one delivery, including its headers and raw body",
        inputSchema: z.object({ id: z.string().min(1) }),
      },
      {
        name: "webhooks.redeliver",
        description: "Queue a delivery again (attempts reset) and dispatch it now",
        inputSchema: z.object({ id: z.string().min(1) }),
      },
      {
        name: "webhooks.reset_signing_secret",
        description:
          "Forget a hook's learned signing secret so the sender's next handshake can set a new one",
        inputSchema: z.object({ hook: hookName }),
      },
    ],
    events: ["webhooks.received"],

    async start(context: ExtensionContext) {
      ctx = context;
      db = options.db ?? openAnimaDb();
      store = new WebhookStore(db);
      const log = context.log;

      dispatcher = new Dispatcher({
        store,
        getConfig: () => config,
        call: (method, params) => context.call(method, params),
        log,
      });
      const activeDispatcher = dispatcher;

      server = startWebhookServer({
        config,
        store,
        log,
        onAccepted(delivery) {
          context.emit("webhooks.received", summarize(delivery));
          queueMicrotask(() => void activeDispatcher.dispatch(delivery.id));
        },
      });

      // Retries, plus anything left pending by a crash or restart.
      timers.push(setInterval(() => void activeDispatcher.drain(), RETRY_TICK_MS));
      timers.push(setInterval(() => prune(log), PRUNE_TICK_MS));
      prune(log);
      void activeDispatcher.drain();

      log.info("Webhooks listening", {
        host: config.host,
        port: server.port,
        hooks: Object.keys(config.hooks),
      });
    },

    async stop() {
      for (const timer of timers) clearInterval(timer);
      timers.length = 0;
      await server?.stop(true);
      server = null;
      dispatcher = null;
      store = null;
      if (db && !options.db) db.close();
      db = null;
      ctx = null;
    },

    async handleMethod(method: string, params: Record<string, unknown>) {
      switch (method) {
        case "webhooks.health_check": {
          const counts = requireStore().counts();
          const response: HealthCheckResponse = {
            ok: server !== null,
            status: server === null ? "error" : counts.failed > 0 ? "degraded" : "healthy",
            label: "Webhooks",
            metrics: [
              { label: "Listening", value: server ? `${config.host}:${server.port}` : "no" },
              { label: "Hooks", value: Object.keys(config.hooks).join(", ") || "none" },
              { label: "Pending", value: counts.pending },
              { label: "Delivered", value: counts.delivered },
              { label: "Failed", value: counts.failed },
            ],
          };
          return response;
        }

        case "webhooks.list_hooks":
          return { hooks: hookSummaries() };

        case "webhooks.list_deliveries": {
          const { hook, status, limit } = params as {
            hook?: string;
            status?: "pending" | "delivered" | "failed";
            limit: number;
          };
          return { deliveries: requireStore().list({ hook, status, limit }).map(summarize) };
        }

        case "webhooks.get_delivery": {
          const delivery = requireStore().get(String(params.id));
          if (!delivery) throw new Error(`Delivery not found: ${String(params.id)}`);
          return delivery;
        }

        case "webhooks.redeliver": {
          const id = String(params.id);
          if (!requireStore().requeue(id, new Date().toISOString())) {
            throw new Error(`Delivery not found: ${id}`);
          }
          await dispatcher?.dispatch(id);
          const delivery = requireStore().get(id);
          return delivery ? summarize(delivery) : null;
        }

        case "webhooks.reset_signing_secret": {
          const hook = String(params.hook);
          const cleared = requireStore().forgetSigningSecret(hook);
          ctx?.log.info("Signing secret reset", { hook, cleared });
          return { hook, cleared };
        }

        default:
          throw new Error(`Unknown method: ${method}`);
      }
    },

    health() {
      return {
        ok: server !== null,
        details: { port: server?.port ?? null, hooks: Object.keys(config.hooks) },
      };
    },
  };
}

export default createWebhooksExtension;

// ── Direct execution with HMR ────────────────────────────────
import { runExtensionHost } from "@anima/extension-host";
if (import.meta.main) runExtensionHost(createWebhooksExtension);
