import { describe, expect, it } from "bun:test";
import type { ExtensionContext, GatewayEvent, LoggerLike } from "@anima/shared";
import { createEditorExtension } from ".";

type EventHandler = (event: GatewayEvent) => void | Promise<void>;

const noopLogger: LoggerLike = {
  info() {},
  warn() {},
  error() {},
  child: () => noopLogger,
};

interface MockContextOptions {
  connectionId?: string | null;
}

/**
 * Lightweight mock of the gateway-supplied ExtensionContext. Only implements
 * the surface the editor extension actually uses — `on`, `emit`, the
 * connection metadata accessors, and the loggers.
 */
function createMockContext(options: MockContextOptions = {}) {
  const handlers = new Map<string, Set<EventHandler>>();
  const emitted: Array<{ type: string; payload: unknown }> = [];

  const ctx: ExtensionContext = {
    on(pattern, handler) {
      let bucket = handlers.get(pattern);
      if (!bucket) {
        bucket = new Set();
        handlers.set(pattern, bucket);
      }
      bucket.add(handler);
      return () => {
        handlers.get(pattern)?.delete(handler);
      };
    },
    emit(type, payload) {
      emitted.push({ type, payload });
    },
    async call() {
      throw new Error("ctx.call not implemented in test");
    },
    connectionId: options.connectionId ?? null,
    tags: null,
    config: {},
    store: (() => {
      const data: Record<string, unknown> = {};
      return {
        get: <T = unknown>(key: string): T | undefined => data[key] as T | undefined,
        set: (key, value) => {
          data[key] = value;
        },
        delete: (key) => {
          delete data[key];
          return true;
        },
        all: () => data,
      };
    })(),
    log: noopLogger,
    createLogger() {
      return noopLogger;
    },
  };

  function dispatchEvent(event: GatewayEvent): Promise<void> {
    const matches: EventHandler[] = [];
    for (const [pattern, bucket] of handlers) {
      if (pattern === "*" || pattern === event.type) {
        matches.push(...bucket);
      }
    }
    return Promise.all(matches.map((h) => h(event))).then(() => undefined);
  }

  function setConnectionId(connectionId: string | null) {
    (ctx as unknown as { connectionId: string | null }).connectionId = connectionId;
  }

  return { ctx, emitted, dispatchEvent, setConnectionId };
}

/**
 * Pull the most recent emitted `editor.command` event off the mock context
 * and assert it has the expected shape.
 */
function expectCommand(
  emitted: Array<{ type: string; payload: unknown }>,
  expectedAction: string,
): { requestId: string; action: string; params: Record<string, unknown> } {
  // Walk backwards to find the most recent command — `findLast` would also
  // work but our tsconfig targets a lib that doesn't include it.
  let cmd: { type: string; payload: unknown } | undefined;
  for (let i = emitted.length - 1; i >= 0; i--) {
    const entry = emitted[i];
    if (entry?.type === "editor.command") {
      cmd = entry;
      break;
    }
  }
  expect(cmd).toBeTruthy();
  const payload = cmd!.payload as { requestId: string; action: string; params: unknown };
  expect(payload.action).toBe(expectedAction);
  expect(typeof payload.requestId).toBe("string");
  return {
    requestId: payload.requestId,
    action: payload.action,
    params: payload.params as Record<string, unknown>,
  };
}

describe("editor extension", () => {
  it("rejects open_file when no shim is registered", async () => {
    const ext = createEditorExtension();
    const mock = createMockContext();
    await ext.start(mock.ctx);

    await expect(ext.handleMethod("editor.open_file", { path: "/tmp/foo.ts" })).rejects.toThrow(
      /No code-server bridge connected/,
    );

    await ext.stop();
  });

  it("dispatches open_file as an editor.command event with the right shape", async () => {
    const ext = createEditorExtension();
    const mock = createMockContext({ connectionId: "conn-1" });
    await ext.start(mock.ctx);

    await ext.handleMethod("editor.register", {
      instanceId: "shim-abc",
      codeServerVersion: "4.99.0",
    });

    const pending = ext.handleMethod("editor.open_file", {
      path: "/repo/src/file.ts",
      line: 42,
    });
    // Resolve the pending promise so it doesn't leak as a timeout in the test.
    setTimeout(() => {
      void ext.handleMethod("editor.response", {
        requestId: expectCommand(mock.emitted, "open_file").requestId,
        success: true,
        data: { ok: true },
      });
    }, 0);

    const cmd = expectCommand(mock.emitted, "open_file");
    expect(cmd.params).toEqual({ path: "/repo/src/file.ts", line: 42 });

    await expect(pending).resolves.toEqual({ ok: true });
    await ext.stop();
  });

  it("correlates response by requestId and resolves the original call", async () => {
    const ext = createEditorExtension();
    const mock = createMockContext({ connectionId: "conn-1" });
    await ext.start(mock.ctx);

    await ext.handleMethod("editor.register", { instanceId: "shim-1" });

    const selectionPromise = ext.handleMethod("editor.get_selection", {});
    const cmd = expectCommand(mock.emitted, "get_selection");

    await ext.handleMethod("editor.response", {
      requestId: cmd.requestId,
      success: true,
      data: { path: "/x.ts", text: "hello" },
    });

    await expect(selectionPromise).resolves.toEqual({ path: "/x.ts", text: "hello" });
    await ext.stop();
  });

  it("rejects a call when the shim reports failure", async () => {
    const ext = createEditorExtension();
    const mock = createMockContext({ connectionId: "conn-1" });
    await ext.start(mock.ctx);

    await ext.handleMethod("editor.register", { instanceId: "shim-1" });

    const promise = ext.handleMethod("editor.open_file", { path: "/missing" });
    const cmd = expectCommand(mock.emitted, "open_file");

    await ext.handleMethod("editor.response", {
      requestId: cmd.requestId,
      success: false,
      error: "File not found",
    });

    await expect(promise).rejects.toThrow("File not found");
    await ext.stop();
  });

  it("re-emits notify_active_file as an editor.active_file_changed event", async () => {
    const ext = createEditorExtension();
    const mock = createMockContext({ connectionId: "conn-1" });
    await ext.start(mock.ctx);

    await ext.handleMethod("editor.notify_active_file", { path: "/repo/foo.ts" });

    const event = mock.emitted.find((e) => e.type === "editor.active_file_changed");
    expect(event?.payload).toEqual({ path: "/repo/foo.ts" });
    await ext.stop();
  });

  it("removes a shim registration when the underlying connection drops", async () => {
    const ext = createEditorExtension();
    const mock = createMockContext({ connectionId: "conn-1" });
    await ext.start(mock.ctx);

    await ext.handleMethod("editor.register", { instanceId: "shim-1" });

    let health = (await ext.handleMethod("editor.health_check", {})) as {
      ok: boolean;
      status: string;
    };
    expect(health.ok).toBe(true);
    expect(health.status).toBe("healthy");

    // Simulate the gateway broadcasting that conn-1 went away.
    await mock.dispatchEvent({
      type: "client.disconnected",
      payload: {},
      timestamp: Date.now(),
      origin: "gateway",
      connectionId: "conn-1",
    } as GatewayEvent);

    health = (await ext.handleMethod("editor.health_check", {})) as {
      ok: boolean;
      status: string;
    };
    expect(health.ok).toBe(false);
    expect(health.status).toBe("disconnected");

    // open_file should fail again now that there's no bridge.
    await expect(ext.handleMethod("editor.open_file", { path: "/x" })).rejects.toThrow(
      /No code-server bridge connected/,
    );

    await ext.stop();
  });

  it("evicts the previous shim instance when a single connection re-registers", async () => {
    const ext = createEditorExtension();
    const mock = createMockContext({ connectionId: "conn-1" });
    await ext.start(mock.ctx);

    await ext.handleMethod("editor.register", { instanceId: "shim-old" });
    await ext.handleMethod("editor.register", { instanceId: "shim-new" });

    const health = (await ext.handleMethod("editor.health_check", {})) as {
      ok: boolean;
      items?: Array<{ id: string }>;
    };
    expect(health.items).toHaveLength(1);
    expect(health.items?.[0]?.id).toBe("shim-new");
    await ext.stop();
  });

  it("rejects in-flight commands with a clean error on stop()", async () => {
    const ext = createEditorExtension();
    const mock = createMockContext({ connectionId: "conn-1" });
    await ext.start(mock.ctx);
    await ext.handleMethod("editor.register", { instanceId: "shim-1" });

    const inFlight = ext.handleMethod("editor.open_file", { path: "/x" });
    expectCommand(mock.emitted, "open_file"); // event emitted

    await ext.stop();

    await expect(inFlight).rejects.toThrow(/shutting down/);
  });

  it("returns ok: false for a response without a matching request", async () => {
    const ext = createEditorExtension();
    const mock = createMockContext({ connectionId: "conn-1" });
    await ext.start(mock.ctx);

    const result = await ext.handleMethod("editor.response", {
      requestId: "ghost",
      success: true,
      data: {},
    });
    expect(result).toEqual({ ok: false });
    await ext.stop();
  });
});
