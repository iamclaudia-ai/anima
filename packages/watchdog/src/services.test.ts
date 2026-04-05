import { afterEach, describe, expect, it } from "bun:test";
import { checkHealth, type ManagedService } from "./services";

function makeService(overrides: Partial<ManagedService> = {}): ManagedService {
  return {
    name: "Gateway",
    id: "gateway",
    command: ["bun", "run", "packages/gateway/src/start.ts"],
    cwd: "/tmp/test",
    healthUrl: "http://localhost:30086/health",
    port: 30086,
    requireExtensions: true,
    restartBackoff: 1000,
    lastRestart: 0,
    consecutiveFailures: 0,
    history: [],
    proc: null,
    lastHealthDetails: null,
    ...overrides,
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("watchdog health checks", () => {
  it("marks gateway unhealthy when health endpoint reports zero extensions", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: "ok", extensions: {} }), {
        status: 200,
      })) as unknown as typeof fetch;

    const result = await checkHealth(makeService());
    expect(result.healthy).toBe(false);
    expect(result.reason).toBe("zero_extensions");
  });

  it("marks gateway healthy when at least one extension is loaded", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          status: "ok",
          extensions: { session: { ok: true } },
          runtimeLocks: [],
        }),
        {
          status: 200,
        },
      )) as unknown as typeof fetch;

    const result = await checkHealth(makeService());
    expect(result.healthy).toBe(true);
  });

  it("treats non-gateway service as healthy on HTTP 200", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;

    const result = await checkHealth(
      makeService({
        id: "agent-host",
        name: "Agent Host",
        healthUrl: "http://localhost:30087/health",
        requireExtensions: false,
      }),
    );
    expect(result.healthy).toBe(true);
  });

  it("marks gateway unhealthy when memory lock heartbeat is stale", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          status: "ok",
          extensions: { memory: { ok: true } },
          runtimeLocks: [
            {
              extensionId: "memory",
              lockType: "singleton",
              resourceKey: "__default__",
              holderPid: process.pid,
              holderInstanceId: "memory:test",
              acquiredAt: Date.now() - 600_000,
              updatedAt: Date.now() - 600_000,
              staleAfterMs: 180_000,
              metadata: { actor: "memory", role: "singleton" },
              stale: true,
            },
          ],
        }),
        {
          status: 200,
        },
      )) as unknown as typeof fetch;

    const result = await checkHealth(makeService());
    expect(result.healthy).toBe(false);
    expect(result.reason).toBe("memory_stale_lock");
    expect(result.details).toMatchObject({
      memoryLock: {
        holderPid: process.pid,
        stale: true,
      },
    });
  });
});
