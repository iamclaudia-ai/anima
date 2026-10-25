import { afterEach, describe, expect, it } from "bun:test";
import type { ExtensionContext } from "@anima/shared";
import { createNotifyExtension, formatNotification } from "./index";

type Call = { method: string; params: Record<string, unknown> };

function fakeContext(calls: Call[], fail?: Error): ExtensionContext {
  const noop = () => {};
  return {
    on: () => noop,
    emit: noop,
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params });
      if (fail) throw fail;
      return { ok: true };
    },
    connectionId: null,
    tags: null,
    log: { info: noop, warn: noop, error: noop, debug: noop },
  } as unknown as ExtensionContext;
}

const IMESSAGE = { host: "sedes", delivery: { type: "imessage", to: "+15555550100" } };

describe("formatNotification", () => {
  it("reads as headline, message, origin", () => {
    const text = formatNotification(
      { message: "Halloween Auto-Play failed", source: "scheduler", hops: 0 },
      "sedes",
    );
    expect(text).toBe("🔔 Anima\nHalloween Auto-Play failed\n— scheduler on sedes");
  });

  it("keeps the originating host of a relayed message", () => {
    const text = formatNotification(
      { message: "x", title: "Token expiring", host: "vesuvius", hops: 1 },
      "sedes",
    );
    expect(text).toBe("🔔 Token expiring\nx\n— on vesuvius");
  });
});

describe("notify.send via iMessage", () => {
  it("hands the formatted text to imessage.send", async () => {
    const calls: Call[] = [];
    const ext = createNotifyExtension(IMESSAGE);
    await ext.start(fakeContext(calls));

    const result = await ext.handleMethod("notify.send", { message: "hello", source: "test" });

    expect(result).toEqual({ sent: true, via: "imessage" });
    expect(calls).toEqual([
      {
        method: "imessage.send",
        params: { to: "+15555550100", text: "🔔 Anima\nhello\n— test on sedes" },
      },
    ]);
  });

  it("sends identical text once inside the dedupe window", async () => {
    const calls: Call[] = [];
    const ext = createNotifyExtension(IMESSAGE);
    await ext.start(fakeContext(calls));

    await ext.handleMethod("notify.send", { message: "same" });
    const second = await ext.handleMethod("notify.send", { message: "same" });
    await ext.handleMethod("notify.send", { message: "different" });

    expect(second).toEqual({ sent: false, deduped: true });
    expect(calls).toHaveLength(2);
  });

  it("lets a failed send be retried at once", async () => {
    const calls: Call[] = [];
    const ext = createNotifyExtension(IMESSAGE);
    await ext.start(fakeContext(calls, new Error("imsg down")));

    await expect(ext.handleMethod("notify.send", { message: "retry me" })).rejects.toThrow(
      "imsg down",
    );
    await expect(ext.handleMethod("notify.send", { message: "retry me" })).rejects.toThrow(
      "imsg down",
    );
    expect(calls).toHaveLength(2);
  });

  it("rejects an empty message", async () => {
    const ext = createNotifyExtension(IMESSAGE);
    await ext.start(fakeContext([]));
    await expect(ext.handleMethod("notify.send", { message: "" })).rejects.toThrow();
  });
});

describe("notify.send via relay", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  afterEach(() => {
    server?.stop(true);
    server = null;
  });

  /** A stand-in gateway that answers one req and records what it got. */
  function fakeGateway(received: Array<{ token: string | null; msg: Record<string, unknown> }>) {
    server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        const token = new URL(req.url).searchParams.get("token");
        return srv.upgrade(req, { data: { token } })
          ? undefined
          : new Response("no", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          const msg = JSON.parse(String(raw)) as Record<string, unknown>;
          received.push({ token: (ws.data as { token: string | null }).token, msg });
          ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, payload: { sent: true } }));
        },
      },
    });
    return `ws://127.0.0.1:${server.port}/ws`;
  }

  it("forwards to the remote notify.send with this host and one hop", async () => {
    const received: Array<{ token: string | null; msg: Record<string, unknown> }> = [];
    const url = fakeGateway(received);
    const ext = createNotifyExtension({
      host: "vesuvius",
      delivery: { type: "relay", url, token: "secret-token" },
    });
    await ext.start(fakeContext([]));

    const result = (await ext.handleMethod("notify.send", { message: "from afar" })) as {
      via: string;
    };

    expect(result.via).toBe(`relay:127.0.0.1:${server?.port}`);
    expect(received).toHaveLength(1);
    expect(received[0]?.token).toBe("secret-token");
    expect(received[0]?.msg).toMatchObject({
      type: "req",
      method: "notify.send",
      params: { message: "from afar", host: "vesuvius", hops: 1 },
    });
  });

  it("refuses to relay a message that was already relayed", async () => {
    const ext = createNotifyExtension({
      host: "vesuvius",
      delivery: { type: "relay", url: "ws://127.0.0.1:1/ws", token: "t" },
    });
    await ext.start(fakeContext([]));
    await expect(ext.handleMethod("notify.send", { message: "loop", hops: 1 })).rejects.toThrow(
      "Refusing to relay",
    );
  });
});

describe("config", () => {
  it("rejects a delivery it doesn't know", () => {
    expect(() => createNotifyExtension({ delivery: { type: "carrier-pigeon" } })).toThrow();
  });
});
