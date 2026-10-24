import { beforeEach, describe, expect, it } from "bun:test";
import { parseWebhooksConfig } from "./config";
import { Dispatcher, RETRY_DELAYS_MS, nextAttemptAt } from "./dispatcher";
import { WebhookStore } from "./store";
import { createRecordingLogger, createTestDb } from "./test-helpers";

const T0 = new Date("2026-10-24T18:00:00.000Z");

describe("nextAttemptAt", () => {
  it("walks the backoff table, then gives up", () => {
    expect(nextAttemptAt(1, T0)).toBe("2026-10-24T18:00:30.000Z");
    expect(nextAttemptAt(RETRY_DELAYS_MS.length, T0)).toBe("2026-10-25T00:00:00.000Z");
    expect(nextAttemptAt(RETRY_DELAYS_MS.length + 1, T0)).toBeNull();
  });
});

describe("Dispatcher", () => {
  let store: WebhookStore;
  let now: Date;
  let calls: Array<{ method: string; params: Record<string, unknown> }>;
  let failWith: string | null;

  function makeDispatcher(target?: string) {
    const config = parseWebhooksConfig({
      hooks: { mail: { secret: "s".repeat(32), ...(target ? { target } : {}) } },
    });
    return new Dispatcher({
      store,
      getConfig: () => config,
      call: async (method, params) => {
        calls.push({ method, params });
        if (failWith) throw new Error(failWith);
        return { ok: true };
      },
      log: createRecordingLogger(),
      now: () => now,
    });
  }

  function insert(id: string) {
    store.insert({
      id,
      hook: "mail",
      receivedAt: now.toISOString(),
      contentType: "application/json",
      headers: { "x-test": "1" },
      body: '{"messageId":1771234567890123456}',
    });
  }

  beforeEach(() => {
    store = new WebhookStore(createTestDb());
    now = T0;
    calls = [];
    failWith = null;
  });

  it("calls the target with the raw body and marks the delivery delivered", async () => {
    const dispatcher = makeDispatcher("mail.handle_webhook");
    insert("d1");
    await dispatcher.dispatch("d1");

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("mail.handle_webhook");
    expect(calls[0].params.body).toBe('{"messageId":1771234567890123456}');
    expect(calls[0].params.headers).toEqual({ "x-test": "1" });
    const stored = store.get("d1");
    expect(stored?.status).toBe("delivered");
    expect(stored?.attempts).toBe(1);
  });

  it("marks a delivery without a target delivered without calling anything", async () => {
    const dispatcher = makeDispatcher();
    insert("d1");
    await dispatcher.dispatch("d1");
    expect(calls).toHaveLength(0);
    expect(store.get("d1")?.status).toBe("delivered");
  });

  it("retries on failure until it succeeds", async () => {
    const dispatcher = makeDispatcher("mail.handle_webhook");
    insert("d1");
    failWith = "mail extension not registered";
    await dispatcher.dispatch("d1");

    let stored = store.get("d1");
    expect(stored?.status).toBe("pending");
    expect(stored?.lastError).toBe("mail extension not registered");
    expect(stored?.nextAttemptAt).toBe("2026-10-24T18:00:30.000Z");

    // Not due yet.
    expect(await dispatcher.drain()).toBe(0);

    now = new Date(T0.getTime() + 31_000);
    failWith = null;
    expect(await dispatcher.drain()).toBe(1);
    stored = store.get("d1");
    expect(stored?.status).toBe("delivered");
    expect(stored?.attempts).toBe(2);
    expect(stored?.lastError).toBeNull();
  });

  it("gives up after the last retry and can be requeued", async () => {
    const dispatcher = makeDispatcher("mail.handle_webhook");
    insert("d1");
    failWith = "boom";
    for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
      await dispatcher.dispatch("d1");
    }
    const stored = store.get("d1");
    expect(stored?.status).toBe("failed");
    expect(stored?.attempts).toBe(RETRY_DELAYS_MS.length + 1);

    // A failed delivery is not attempted again on its own.
    await dispatcher.dispatch("d1");
    expect(calls).toHaveLength(RETRY_DELAYS_MS.length + 1);

    failWith = null;
    expect(store.requeue("d1", now.toISOString())).toBe(true);
    await dispatcher.dispatch("d1");
    expect(store.get("d1")?.status).toBe("delivered");
  });

  it("does not deliver twice when a drain overlaps an immediate dispatch", async () => {
    const dispatcher = makeDispatcher("mail.handle_webhook");
    insert("d1");
    await Promise.all([dispatcher.dispatch("d1"), dispatcher.drain(), dispatcher.dispatch("d1")]);
    expect(calls).toHaveLength(1);
    expect(store.get("d1")?.status).toBe("delivered");
  });
});
