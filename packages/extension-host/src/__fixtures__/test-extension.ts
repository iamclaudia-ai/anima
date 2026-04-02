import { z } from "zod";
import type { AnimaExtension, ExtensionContext, GatewayEvent } from "@anima/shared";
import { runExtensionHost } from "../index";

function createFixtureExtension(): AnimaExtension {
  let ctx: ExtensionContext | null = null;

  return {
    id: "fixture",
    name: "Fixture Extension",
    methods: [
      {
        name: "fixture.echo",
        description: "Echo params with current request envelope context",
        inputSchema: z.object({ value: z.string().optional() }),
        execution: { lane: "read", concurrency: "parallel" },
      },
      {
        name: "fixture.emit_context",
        description: "Emit an event without overrides (uses ambient request context)",
        inputSchema: z.object({}),
        execution: { lane: "write", concurrency: "parallel" },
      },
      {
        name: "fixture.call_through",
        description: "Make a ctx.call and return the response",
        inputSchema: z.object({}),
        execution: { lane: "write", concurrency: "parallel" },
      },
      {
        name: "fixture.fail",
        description: "Throw an error for protocol error-path testing",
        inputSchema: z.object({}),
        execution: { lane: "write", concurrency: "parallel" },
      },
      {
        name: "fixture.block",
        description: "Sleep for a bounded duration before resolving",
        inputSchema: z.object({ ms: z.number().optional() }),
        execution: { lane: "long_running", concurrency: "keyed", keyParam: "resourceId" },
      },
      {
        name: "fixture.health_check",
        description: "Health check fixture method",
        inputSchema: z.object({}),
        execution: { lane: "control", concurrency: "parallel" },
      },
      {
        name: "fixture.read_fast",
        description: "Read lane method that should bypass a blocked keyed request",
        inputSchema: z.object({ value: z.string().optional() }),
        execution: { lane: "read", concurrency: "parallel" },
      },
    ],
    events: ["fixture.*"],
    sourceRoutes: ["fixture-src"],
    async start(extCtx: ExtensionContext) {
      ctx = extCtx;
      ctx.on("trigger.call", async () => {
        await ctx!.call("from.event", { via: "event" });
        ctx!.emit("fixture.after_event", { ok: true });
      });
      ctx.on("gateway.heartbeat", async () => {
        ctx!.emit("fixture.heartbeat_seen", { ok: true });
      });
    },
    async stop() {
      ctx = null;
    },
    async handleMethod(method: string, params: Record<string, unknown>) {
      if (method === "fixture.echo") {
        return {
          params,
          connectionId: ctx?.connectionId ?? null,
          tags: ctx?.tags ?? null,
        };
      }
      if (method === "fixture.emit_context") {
        ctx?.emit("fixture.context", { ok: true });
        return { ok: true };
      }
      if (method === "fixture.call_through") {
        return await ctx!.call("session.send_prompt", { content: "ping" });
      }
      if (method === "fixture.fail") {
        throw new Error("fixture boom");
      }
      if (method === "fixture.block") {
        const ms = typeof params.ms === "number" ? params.ms : 500;
        await Bun.sleep(ms);
        return { ok: true, ms, resourceId: params.resourceId ?? null };
      }
      if (method === "fixture.health_check") {
        return {
          ok: true,
          connectionId: ctx?.connectionId ?? null,
          tags: ctx?.tags ?? null,
        };
      }
      if (method === "fixture.read_fast") {
        return { ok: true, value: params.value ?? null };
      }
      throw new Error(`Unknown method: ${method}`);
    },
    async handleSourceResponse(source: string, event: GatewayEvent) {
      ctx?.emit("fixture.routed", { source, type: event.type });
    },
    health() {
      return { ok: true, details: { fixture: true } };
    },
  };
}

if (import.meta.main) {
  runExtensionHost(() => createFixtureExtension());
}
