import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { SessionHost } from "./session-host";

class FakeSession extends EventEmitter {
  constructor(
    public id: string,
    public isActive = true,
  ) {
    super();
  }

  async start(): Promise<void> {}

  prompt(_content: string | unknown[]): void {}

  interrupt(): void {}

  setPermissionMode(_mode: string): void {}

  sendToolResult(_toolUseId: string, _content: string, _isError = false): void {}

  async close(): Promise<void> {
    this.emit("closed");
  }

  getInfo() {
    return {
      id: this.id,
      cwd: "/tmp/test",
      model: "claude-test",
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    };
  }
}

describe("SessionHost", () => {
  it("cleans up event buffers when a session closes", async () => {
    const fake = new FakeSession("s-cleanup");
    const host = new SessionHost({
      create: () => fake as unknown as import("../../../extensions/session/src/sdk-session").SDKSession,
    });

    await host.create({ cwd: "/repo" });
    fake.emit("sse", { type: "content_block_delta", delta: { text: "hi" } });

    expect(host.getEventsAfter("s-cleanup", 0)).toHaveLength(1);

    fake.emit("closed");
    expect(host.getEventsAfter("s-cleanup", 0)).toEqual([]);
  });

  it("auto-resumes inactive sessions with defaults on prompt", async () => {
    const resumed: Array<{ sessionId: string; options: unknown }> = [];
    const fake = new FakeSession("s-resume");
    let startCalls = 0;
    fake.start = async () => {
      startCalls += 1;
    };

    const host = new SessionHost({
      create: () => fake as unknown as import("../../../extensions/session/src/sdk-session").SDKSession,
      resume: (sessionId, options) => {
        resumed.push({ sessionId, options });
        return fake as unknown as import("../../../extensions/session/src/sdk-session").SDKSession;
      },
    });

    host.setDefaults({ model: "sonnet", thinking: true, effort: "low" });
    await host.prompt("s-resume", "hi", "/repo");

    expect(startCalls).toBe(1);
    expect(resumed).toEqual([
      {
        sessionId: "s-resume",
        options: { cwd: "/repo", model: "sonnet", thinking: true, effort: "low" },
      },
    ]);
  });
});
