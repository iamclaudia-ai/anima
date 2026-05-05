import { describe, expect, it } from "bun:test";
import { ExtensionManager } from "./extensions";
import type { ExtensionHost } from "./extension-host";
import type { GatewayEvent } from "@anima/shared";

describe("ExtensionManager integration", () => {
  it("broadcasts events to all registered out-of-process hosts", async () => {
    const manager = new ExtensionManager();

    const allEvents: GatewayEvent[] = [];
    const voiceEvents: GatewayEvent[] = [];

    const allHost: ExtensionHost = {
      sendEvent(event: GatewayEvent) {
        allEvents.push(event);
      },
      async callMethod() {},
      async callMcpTool() {
        return { content: [] };
      },
      async routeToSource() {},
      async health() {
        return { ok: true };
      },
      getRegistration() {
        return null;
      },
      getGenerationToken() {
        return null;
      },
      isRunning() {
        return true;
      },
      async kill() {},
      forceKill() {},
      async restart() {
        throw new Error("Not supported");
      },
    };

    const voiceHost: ExtensionHost = {
      sendEvent(event: GatewayEvent) {
        if (event.type.startsWith("voice.")) {
          voiceEvents.push(event);
        }
      },
      async callMethod() {},
      async callMcpTool() {
        return { content: [] };
      },
      async routeToSource() {},
      async health() {
        return { ok: true };
      },
      getRegistration() {
        return null;
      },
      getGenerationToken() {
        return null;
      },
      isRunning() {
        return true;
      },
      async kill() {},
      forceKill() {},
      async restart() {
        throw new Error("Not supported");
      },
    };

    manager.registerRemote(
      {
        id: "all",
        name: "All",
        methods: [{ name: "all.noop", description: "No-op" }],
        events: [],
        sourceRoutes: [],
      },
      allHost,
    );
    manager.registerRemote(
      {
        id: "voice",
        name: "Voice",
        methods: [{ name: "voice.noop", description: "No-op" }],
        events: [],
        sourceRoutes: [],
      },
      voiceHost,
    );

    await manager.broadcast({
      type: "voice.audio",
      payload: { chunk: 1 },
      timestamp: Date.now(),
      origin: "extension:voice",
    });

    await manager.broadcast({
      type: "session.message_stop",
      payload: {},
      timestamp: Date.now(),
      origin: "session",
    });

    expect(allEvents).toHaveLength(2);
    expect(voiceEvents).toHaveLength(1);
    expect(voiceEvents[0]?.type).toBe("voice.audio");
  });
});
