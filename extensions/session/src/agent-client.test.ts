import { describe, expect, it } from "bun:test";
import { createServer } from "node:net";
import { AgentHostClient } from "./agent-client";

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    const timer = setTimeout(() => {
      try {
        server.close();
      } catch {
        // ignore
      }
      reject(new Error("Timed out reserving free port"));
    }, 3000);
    server.listen(0, "127.0.0.1", () => {
      clearTimeout(timer);
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to reserve free port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  stepMs = 10,
): Promise<void> {
  const start = Date.now();
  while (!predicate() && Date.now() - start < timeoutMs) {
    await Bun.sleep(stepMs);
  }
  if (!predicate()) {
    throw new Error("Timed out waiting for condition");
  }
}

describe("AgentHostClient", () => {
  it("sends requests and resolves responses", async () => {
    const port = await getFreePort();
    const server = Bun.serve({
      port,
      fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname === "/ws") {
          server.upgrade(req);
          return undefined;
        }
        return new Response("Not Found", { status: 404 });
      },
      websocket: {
        message(ws, message) {
          const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
          const msg = JSON.parse(raw) as Record<string, unknown>;
          if (msg.type === "session.create") {
            ws.send(
              JSON.stringify({
                type: "res",
                requestId: msg.requestId,
                ok: true,
                payload: { sessionId: "s1" },
              }),
            );
          } else if (msg.type === "session.prompt") {
            ws.send(JSON.stringify({ type: "res", requestId: msg.requestId, ok: true }));
          } else if (msg.type === "session.list") {
            ws.send(
              JSON.stringify({ type: "res", requestId: msg.requestId, ok: true, payload: [] }),
            );
          } else if (msg.type === "auth") {
            // no-op
          }
        },
      },
    });

    const client = new AgentHostClient(`ws://127.0.0.1:${port}/ws`);
    await client.connect();

    const created = await client.createSession({ cwd: "/repo" });
    expect(created).toEqual({ sessionId: "s1" });

    await expect(client.prompt("s1", "hi")).resolves.toBeUndefined();
    await expect(client.list()).resolves.toEqual([]);

    client.disconnect();
    server.stop();
  });

  it("rejects on error responses", async () => {
    const port = await getFreePort();
    const server = Bun.serve({
      port,
      fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname === "/ws") {
          server.upgrade(req);
          return undefined;
        }
        return new Response("Not Found", { status: 404 });
      },
      websocket: {
        message(ws, message) {
          const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
          const msg = JSON.parse(raw) as Record<string, unknown>;
          if (msg.type === "session.prompt") {
            ws.send(
              JSON.stringify({
                type: "res",
                requestId: msg.requestId,
                ok: false,
                error: "boom",
              }),
            );
          }
        },
      },
    });

    const client = new AgentHostClient(`ws://127.0.0.1:${port}/ws`);
    await client.connect();

    await expect(client.prompt("s1", "hi")).rejects.toThrow("boom");

    client.disconnect();
    server.stop();
  });

  it("reconnects with resume sessions after event delivery", async () => {
    const port = await getFreePort();
    const auths: Array<Record<string, unknown>> = [];
    let latestWs: { send: (data: string) => void; close: () => void } | null = null;

    const server = Bun.serve({
      port,
      fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname === "/ws") {
          server.upgrade(req);
          return undefined;
        }
        return new Response("Not Found", { status: 404 });
      },
      websocket: {
        open(ws) {
          latestWs = ws;
        },
        message(ws, message) {
          const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
          const msg = JSON.parse(raw) as Record<string, unknown>;
          if (msg.type === "auth") {
            auths.push(msg);
          }
          if (msg.type === "session.create") {
            ws.send(
              JSON.stringify({
                type: "res",
                requestId: msg.requestId,
                ok: true,
                payload: { sessionId: "s1" },
              }),
            );
          }
        },
      },
    });

    const client = new AgentHostClient(`ws://127.0.0.1:${port}/ws`);
    const events: Array<Record<string, unknown>> = [];
    client.on("session.event", (payload) => events.push(payload as Record<string, unknown>));

    await client.connect();
    await client.createSession({ cwd: "/repo" });

    latestWs?.send(
      JSON.stringify({
        type: "session.event",
        sessionId: "s1",
        event: { type: "content_block_delta", delta: { text: "hi" } },
        seq: 3,
      }),
    );

    await waitFor(() => events.length === 1);
    latestWs?.close();

    await waitFor(() => auths.length >= 2, 5000);
    const resume = auths[1].resumeSessions as Array<{ sessionId: string; lastSeq: number }>;
    expect(resume).toEqual([{ sessionId: "s1", lastSeq: 3 }]);

    client.disconnect();
    server.stop();
  });
});
