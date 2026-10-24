import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AnimaExtension, ExtensionContext, HealthCheckResponse } from "@anima/shared";
import { createWebhooksExtension } from "./index";
import { createRecordingLogger, createTestDb } from "./test-helpers";

const SECRET = "s".repeat(40);

function createContext(onCall: (method: string, params?: Record<string, unknown>) => unknown) {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const data: Record<string, unknown> = {};
  const ctx: ExtensionContext = {
    on: () => () => {},
    emit: (type, payload) => emitted.push({ type, payload }),
    call: async (method, params) => onCall(method, params),
    connectionId: null,
    tags: null,
    config: {},
    log: createRecordingLogger(),
    createLogger: () => createRecordingLogger(),
    store: {
      get: <T>(key: string) => data[key] as T | undefined,
      set: (key, value) => {
        data[key] = value;
      },
      delete: (key) => delete data[key],
      all: () => data,
    },
  };
  return { ctx, emitted };
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

describe("webhooks extension", () => {
  let ext: AnimaExtension;
  let calls: Array<{ method: string; params?: Record<string, unknown> }>;
  let emitted: Array<{ type: string; payload: unknown }>;
  let port: number;

  beforeEach(async () => {
    calls = [];
    ext = createWebhooksExtension(
      {
        port: 0,
        hooks: { "zoho-mail": { secret: SECRET, target: "mail.handle_webhook" } },
      },
      { db: createTestDb() },
    );
    const context = createContext((method, params) => {
      calls.push({ method, params });
      return { ok: true };
    });
    emitted = context.emitted;
    await ext.start(context.ctx);
    const health = (await ext.handleMethod("webhooks.health_check", {})) as HealthCheckResponse;
    const listening = health.metrics?.find((m) => m.label === "Listening")?.value;
    port = Number(String(listening).split(":")[1]);
  });

  afterEach(async () => {
    await ext.stop();
  });

  it("accepts a delivery over HTTP, emits an event and calls the target", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/hook/zoho-mail/${SECRET}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"subject":"Hello"}',
    });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };

    await waitFor(() => calls.length === 1);
    expect(calls[0].method).toBe("mail.handle_webhook");
    expect(calls[0].params?.id).toBe(id);
    expect(calls[0].params?.body).toBe('{"subject":"Hello"}');

    const event = emitted.find((e) => e.type === "webhooks.received");
    expect(event?.payload).toMatchObject({ id, hook: "zoho-mail", bytes: 19 });
    expect(JSON.stringify(event?.payload)).not.toContain("Hello");

    const listed = (await ext.handleMethod("webhooks.list_deliveries", { limit: 10 })) as {
      deliveries: Array<{ id: string; status: string; body?: string }>;
    };
    expect(listed.deliveries.map((d) => d.id)).toEqual([id]);
    expect(listed.deliveries[0].body).toBeUndefined();

    const full = (await ext.handleMethod("webhooks.get_delivery", { id })) as { body: string };
    expect(full.body).toBe('{"subject":"Hello"}');
  });

  it("lists hooks without exposing secrets", async () => {
    const result = await ext.handleMethod("webhooks.list_hooks", {});
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result).toMatchObject({
      hooks: [{ name: "zoho-mail", target: "mail.handle_webhook", signature: "none" }],
    });
  });

  it("redelivers on request", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/hook/zoho-mail/${SECRET}`, {
      method: "POST",
      body: "{}",
    });
    const { id } = (await res.json()) as { id: string };
    await waitFor(() => calls.length === 1);

    const redelivered = (await ext.handleMethod("webhooks.redeliver", { id })) as {
      status: string;
    };
    expect(redelivered.status).toBe("delivered");
    expect(calls).toHaveLength(2);
  });
});
