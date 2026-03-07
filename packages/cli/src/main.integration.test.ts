import { describe, expect, it } from "bun:test";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const cliEntry = join(repoRoot, "packages", "cli", "src", "index.ts");

function runCli(args: string[], envOverrides?: Record<string, string>) {
  return Bun.spawnSync(["bun", cliEntry, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CLAUDIA_GATEWAY_URL: "ws://127.0.0.1:1/ws",
      CLAUDIA_WATCHDOG_URL: "http://127.0.0.1:1",
      ...envOverrides,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function runCliAsync(
  args: string[],
  envOverrides?: Record<string, string>,
  timeoutMs = 5000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", cliEntry, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CLAUDIA_GATEWAY_URL: "ws://127.0.0.1:1/ws",
      CLAUDIA_WATCHDOG_URL: "http://127.0.0.1:1",
      ...envOverrides,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = Bun.sleep(timeoutMs).then(() => {
    proc.kill();
    throw new Error(`CLI timed out after ${timeoutMs}ms: ${args.join(" ")}`);
  });

  const exitCode = await Promise.race([proc.exited, timeout]);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

async function withGatewayServer(run: (gatewayUrl: string) => void | Promise<void>): Promise<void> {
  const server = Bun.serve({
    port: 0,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const upgraded = server.upgrade(req);
        if (upgraded) return;
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        ws.send(
          JSON.stringify({
            type: "event",
            event: "gateway.welcome",
            payload: { connectionId: "conn-test" },
          }),
        );
      },
      message(ws, raw) {
        const text =
          typeof raw === "string" ? raw : Buffer.from(raw as Uint8Array).toString("utf8");
        const req = JSON.parse(text) as {
          type: "req";
          id: string;
          method: string;
          params?: Record<string, unknown>;
        };
        if (req.type !== "req") return;

        if (req.method === "gateway.list_methods") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: req.id,
              ok: true,
              payload: {
                methods: [
                  {
                    method: "session.send_prompt",
                    source: "extension",
                    extensionId: "session",
                    description: "Send prompt",
                    inputSchema: {
                      type: "object",
                      properties: {
                        sessionId: { type: "string" },
                        content: { type: "string" },
                      },
                      required: ["sessionId", "content"],
                    },
                  },
                ],
              },
            }),
          );
          return;
        }

        if (req.method === "gateway.subscribe") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: req.id,
              ok: true,
              payload: { subscribed: req.params?.events ?? [] },
            }),
          );
          return;
        }

        if (req.method === "session.send_prompt") {
          ws.send(JSON.stringify({ type: "res", id: req.id, ok: true, payload: {} }));
          ws.send(
            JSON.stringify({
              type: "event",
              event: "session.ses_test.content_block_delta",
              payload: { delta: { type: "text_delta", text: "streamed text" } },
            }),
          );
          ws.send(
            JSON.stringify({
              type: "event",
              event: "session.ses_test.message_stop",
              payload: {},
            }),
          );
          return;
        }

        if (req.method === "voice.speak") {
          ws.send(JSON.stringify({ type: "res", id: req.id, ok: true, payload: {} }));
          ws.send(
            JSON.stringify({
              type: "event",
              event: "voice.done",
              payload: {},
            }),
          );
          return;
        }

        ws.send(JSON.stringify({ type: "res", id: req.id, ok: true, payload: {} }));
      },
    },
  });

  try {
    await run(`ws://127.0.0.1:${server.port}/ws`);
  } finally {
    server.stop(true);
  }
}

describe("cli main integration", () => {
  it("prints watchdog help and exits successfully", () => {
    const result = runCli(["watchdog", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString("utf-8")).toContain("watchdog commands:");
  });

  it("fails fast for unknown watchdog command", () => {
    const result = runCli(["watchdog", "bogus"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString("utf-8")).toContain("Unknown watchdog command: bogus");
  });

  it("requires text for speak compat command", () => {
    const result = runCli(["speak"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString("utf-8")).toContain('Usage: claudia speak "text to speak"');
  });

  it("requires service argument for watchdog restart", () => {
    const result = runCli(["watchdog", "restart"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString("utf-8")).toContain(
      "Usage: claudia watchdog restart <gateway|runtime> [--force]",
    );
  });

  it("loads method catalog through gateway client", async () => {
    await withGatewayServer(async (gatewayUrl) => {
      const result = await runCliAsync(["methods"], { CLAUDIA_GATEWAY_URL: gatewayUrl });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("claudia session send_prompt");
    });
  });

  it("prints streamed session output for send_prompt", async () => {
    await withGatewayServer(async (gatewayUrl) => {
      const result = await runCliAsync(
        ["session", "send_prompt", "--sessionId", "ses_test", "--content", "hello"],
        { CLAUDIA_GATEWAY_URL: gatewayUrl },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("streamed text");
    });
  });

  it("handles speak flow via gateway client", async () => {
    await withGatewayServer(async (gatewayUrl) => {
      const result = await runCliAsync(["speak", "hello"], { CLAUDIA_GATEWAY_URL: gatewayUrl });
      expect(result.exitCode).toBe(0);
    });
  });
});
