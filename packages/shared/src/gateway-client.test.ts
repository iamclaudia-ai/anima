import { describe, expect, it } from "bun:test";
import { createGatewayClient } from "./gateway-client";

type Handler<T> = ((event: T) => void) | null;

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeSocket.CONNECTING;
  onopen: Handler<unknown> = null;
  onclose: Handler<unknown> = null;
  onerror: Handler<unknown> = null;
  onmessage: Handler<{ data: string }> = null;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({});
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.({});
  }

  message(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

describe("gateway-client", () => {
  it("sends requests and resolves call responses", async () => {
    const socket = new FakeSocket();
    const client = createGatewayClient({
      url: "ws://example/ws",
      createSocket: () => socket,
    });

    const connectPromise = client.connect();
    socket.open();
    await connectPromise;

    const callPromise = client.call<{ ok: boolean }>("gateway.list_methods", {});
    await Bun.sleep(0);

    const req = JSON.parse(socket.sent[0] ?? "{}") as {
      id: string;
      method: string;
      params: Record<string, unknown>;
    };
    expect(req.method).toBe("gateway.list_methods");
    expect(req.params).toEqual({});

    socket.message({ type: "res", id: req.id, ok: true, payload: { ok: true } });
    await expect(callPromise).resolves.toEqual({ ok: true });
  });

  it("responds to ping with pong", async () => {
    const socket = new FakeSocket();
    const client = createGatewayClient({
      url: "ws://example/ws",
      createSocket: () => socket,
    });

    const connectPromise = client.connect();
    socket.open();
    await connectPromise;

    socket.message({ type: "ping", id: "ping-1", timestamp: Date.now() });
    const pong = JSON.parse(socket.sent[0] ?? "{}") as { type: string; id: string };
    expect(pong).toEqual({ type: "pong", id: "ping-1" });
  });

  it("dispatches wildcard event listeners and tracks connectionId", async () => {
    const socket = new FakeSocket();
    const seen: Array<{ event: string; payload: unknown }> = [];
    const client = createGatewayClient({
      url: "ws://example/ws",
      createSocket: () => socket,
    });
    client.on("session.*", (event, payload) => seen.push({ event, payload }));

    const connectPromise = client.connect();
    socket.open();
    await connectPromise;

    socket.message({
      type: "event",
      event: "gateway.welcome",
      payload: { connectionId: "conn-123" },
    });
    socket.message({
      type: "event",
      event: "session.abc.message_stop",
      payload: { done: true },
    });

    expect(client.connectionId).toBe("conn-123");
    expect(seen).toEqual([{ event: "session.abc.message_stop", payload: { done: true } }]);
  });

  it("rejects pending calls when socket closes", async () => {
    const socket = new FakeSocket();
    const client = createGatewayClient({
      url: "ws://example/ws",
      createSocket: () => socket,
    });

    const connectPromise = client.connect();
    socket.open();
    await connectPromise;

    const callPromise = client.call("session.list_workspaces", {});
    await Bun.sleep(0);
    socket.close();

    await expect(callPromise).rejects.toThrow("Gateway connection closed");
  });

  it("times out calls when no response arrives", async () => {
    const socket = new FakeSocket();
    const client = createGatewayClient({
      url: "ws://example/ws",
      createSocket: () => socket,
      requestTimeoutMs: 5,
    });

    const callPromise = client.call("gateway.list_methods", {});
    socket.open();

    await expect(callPromise).rejects.toThrow("Gateway call timed out: gateway.list_methods");
  });
});
