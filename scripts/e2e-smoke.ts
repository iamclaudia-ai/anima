#!/usr/bin/env bun

const gatewayWs = process.env.ANIMA_GATEWAY_WS || "ws://localhost:30086/ws";
const model = process.env.ANIMA_SMOKE_MODEL || "claude-3-5-haiku-latest";
const thinking = process.env.ANIMA_SMOKE_THINKING === "true";
const effort = process.env.ANIMA_SMOKE_EFFORT || "low";
const timeoutMs = Number(process.env.ANIMA_SMOKE_TIMEOUT_MS || 60000);

interface Message {
  type: "req" | "res" | "event";
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
  ok?: boolean;
  payload?: unknown;
  error?: string;
  event?: string;
}

function genId(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function runE2E(): Promise<void> {
  const ws = new WebSocket(gatewayWs);
  const pending = new Map<
    string,
    { method: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();

  const request = (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const id = genId();
    return new Promise((resolve, reject) => {
      pending.set(id, { method, resolve, reject });
      ws.send(JSON.stringify({ type: "req", id, method, params } satisfies Message));
    });
  };

  let accumulated = "";
  let gotStop = false;
  let activeSessionId: string | null = null;

  await new Promise<void>((resolveOpen, rejectOpen) => {
    ws.onopen = () => resolveOpen();
    ws.onerror = () => rejectOpen(new Error(`WebSocket failed: ${gatewayWs}`));

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string) as Message;

      if (msg.type === "res" && msg.id) {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (!msg.ok) {
          p.reject(new Error(msg.error || `${p.method} failed`));
        } else {
          p.resolve(msg.payload);
        }
        return;
      }

      if (msg.type !== "event") return;
      if (activeSessionId && msg.event === `session.${activeSessionId}.content_block_delta`) {
        const payload = (msg.payload ?? {}) as { delta?: { type?: string; text?: string } };
        if (payload.delta?.type === "text_delta" && payload.delta.text) {
          accumulated += payload.delta.text;
        }
      }
      if (activeSessionId && msg.event === `session.${activeSessionId}.message_stop`) {
        gotStop = true;
      }
    };
  });

  try {
    await request("gateway.subscribe", { events: ["session.*"] });
    const wsResult = (await request("session.get_or_create_workspace", {
      cwd: process.cwd(),
      name: "Smoke Test",
    })) as {
      workspace?: { id: string };
    };

    const sessionResult = (await request("session.create_session", {
      cwd: process.cwd(),
      model,
      thinking,
      effort,
      title: "E2E Smoke Session",
    })) as { sessionId?: string };

    const sessionId = sessionResult.sessionId;
    if (!sessionId) throw new Error("session.create_session returned no session id");
    activeSessionId = sessionId;

    await request("session.send_prompt", {
      sessionId,
      content: "Reply with exactly: SMOKE_OK",
      model,
      thinking,
      effort,
    });

    const start = Date.now();
    while (!gotStop && Date.now() - start < timeoutMs) {
      await Bun.sleep(50);
    }

    if (!gotStop) throw new Error("Did not receive session.message_stop");
    if (!accumulated.includes("SMOKE_OK")) {
      throw new Error(`Unexpected model output: ${accumulated.slice(0, 160)}`);
    }

    console.log(`[e2e] OK: session ${sessionId} replied with SMOKE_OK using model ${model}`);
  } finally {
    ws.close();
  }
}

runE2E().catch((err) => {
  console.error(`[e2e] FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
