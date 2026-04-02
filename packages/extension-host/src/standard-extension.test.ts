import { describe, expect, it } from "bun:test";
import { z } from "zod";
import type { ExtensionContext, GatewayEvent } from "@anima/shared";
import { createStandardExtension } from "./standard-extension";

function createTestContext(): ExtensionContext {
  return {
    on() {
      return () => {};
    },
    emit() {},
    async call() {
      return { ok: true };
    },
    connectionId: "conn-standard",
    tags: ["tag-standard"],
    config: {},
    log: {
      info() {},
      warn() {},
      error() {},
      child() {
        return this;
      },
    },
    createLogger() {
      return {
        info() {},
        warn() {},
        error() {},
        child() {
          return this;
        },
      };
    },
    store: {
      get() {
        return undefined;
      },
      set() {},
      delete() {
        return true;
      },
      all() {
        return {};
      },
    },
  };
}

describe("createStandardExtension", () => {
  it("routes method handlers and forwards start/stop/health", async () => {
    let started = false;
    let stopped = false;

    const factory = createStandardExtension({
      id: "standard-fixture",
      name: "Standard Fixture",
      methods: [
        {
          definition: {
            name: "standard.echo",
            description: "Echo the ambient context",
            inputSchema: z.object({}),
            execution: { lane: "read", concurrency: "parallel" },
          },
          handle(_params, ctx) {
            return {
              connectionId: ctx.connectionId,
              tags: ctx.tags,
            };
          },
        },
      ],
      events: ["standard.*"],
      start() {
        started = true;
      },
      stop() {
        stopped = true;
      },
      health() {
        return { ok: true, details: { standard: true } };
      },
    });

    const ext = factory({});
    await ext.start(createTestContext());
    expect(started).toBe(true);
    expect(await ext.handleMethod("standard.echo", {})).toEqual({
      connectionId: "conn-standard",
      tags: ["tag-standard"],
    });
    expect(ext.health()).toEqual({ ok: true, details: { standard: true } });
    await ext.stop();
    expect(stopped).toBe(true);
  });

  it("forwards source responses through the provided handler", async () => {
    const seenSources: string[] = [];
    const seenEvents: GatewayEvent["type"][] = [];

    const factory = createStandardExtension({
      id: "standard-source",
      name: "Standard Source",
      methods: [],
      events: [],
      sourceRoutes: ["standard-src"],
      handleSourceResponse(source, event) {
        seenSources.push(source);
        seenEvents.push(event.type);
      },
    });

    const ext = factory({});
    await ext.start(createTestContext());
    await ext.handleSourceResponse?.("standard-src/client-1", {
      type: "session.done",
      payload: {},
      timestamp: Date.now(),
    });
    expect(seenSources[0]).toBe("standard-src/client-1");
    expect(seenEvents[0]).toBe("session.done");
  });
});
