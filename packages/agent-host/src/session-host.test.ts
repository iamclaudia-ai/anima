import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { SessionHost, type AgentRuntimeSession } from "./session-host";

class FakeSession extends EventEmitter {
  public isProcessRunning = false;
  public lastActivityIso = new Date().toISOString();

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
      isActive: this.isActive,
      isProcessRunning: this.isProcessRunning,
      createdAt: new Date().toISOString(),
      lastActivity: this.lastActivityIso,
      healthy: true,
      stale: false,
    };
  }
}

describe("SessionHost", () => {
  it("cleans up event buffers when a session closes", async () => {
    const fake = new FakeSession("s-cleanup");
    const host = new SessionHost({
      create: () => fake as unknown as AgentRuntimeSession,
    });

    await host.create({ cwd: "/repo", model: "claude-opus-4-6" });
    fake.emit("sse", { type: "content_block_delta", delta: { text: "hi" } });

    expect(host.getEventsAfter("s-cleanup", 0)).toHaveLength(1);

    fake.emit("closed");
    expect(host.getEventsAfter("s-cleanup", 0)).toEqual([]);
  });

  it("creates sessions with a caller-supplied session id", async () => {
    const fake = new FakeSession("draft-session-1");
    const created: Array<unknown> = [];
    const host = new SessionHost({
      create: (options) => {
        created.push(options);
        return fake as unknown as AgentRuntimeSession;
      },
    });

    await host.create({
      sessionId: "draft-session-1",
      cwd: "/repo",
      model: "claude-opus-4-6",
    });

    expect(created).toEqual([
      {
        sessionId: "draft-session-1",
        cwd: "/repo",
        model: "claude-opus-4-6",
        systemPrompt: undefined,
        thinking: undefined,
        effort: undefined,
      },
    ]);
  });

  it("auto-resumes inactive sessions with defaults on prompt", async () => {
    const resumed: Array<{ sessionId: string; options: unknown }> = [];
    const fake = new FakeSession("s-resume");
    let startCalls = 0;
    fake.start = async () => {
      startCalls += 1;
    };

    const host = new SessionHost({
      create: () => fake as unknown as AgentRuntimeSession,
      resume: (sessionId, options) => {
        resumed.push({ sessionId, options });
        return fake as unknown as AgentRuntimeSession;
      },
    });

    host.setDefaults({ model: "claude-opus-4-6", thinking: true, effort: "low" });
    await host.prompt("s-resume", "hi", "/repo");

    expect(startCalls).toBe(1);
    expect(resumed).toEqual([
      {
        sessionId: "s-resume",
        options: { cwd: "/repo", model: "claude-opus-4-6", thinking: true, effort: "low" },
      },
    ]);
  });

  it("uses prompt model for auto-resume when provided", async () => {
    const resumed: Array<{ sessionId: string; options: unknown }> = [];
    const fake = new FakeSession("s-explicit-model");
    let startCalls = 0;
    fake.start = async () => {
      startCalls += 1;
    };

    const host = new SessionHost({
      create: () => fake as unknown as AgentRuntimeSession,
      resume: (sessionId, options) => {
        resumed.push({ sessionId, options });
        return fake as unknown as AgentRuntimeSession;
      },
    });

    host.setDefaults({ model: "claude-sonnet-4-6", thinking: true, effort: "low" });
    await host.prompt("s-explicit-model", "hi", "/repo", "claude-opus-4-6");

    expect(startCalls).toBe(1);
    expect(resumed).toEqual([
      {
        sessionId: "s-explicit-model",
        options: { cwd: "/repo", model: "claude-opus-4-6", thinking: true, effort: "low" },
      },
    ]);
  });

  it("reaps stale sessions with running SDK process", async () => {
    const stale = new FakeSession("s-stale");
    stale.isProcessRunning = true;
    stale.lastActivityIso = new Date(1_000).toISOString();

    const fresh = new FakeSession("s-fresh");
    fresh.isProcessRunning = true;
    fresh.lastActivityIso = new Date(299_500).toISOString();

    let createCalls = 0;
    const host = new SessionHost({
      create: () => {
        createCalls += 1;
        return (createCalls === 1 ? stale : fresh) as unknown as AgentRuntimeSession;
      },
    });

    await host.create({ cwd: "/repo", model: "claude-opus-4-6" });
    await host.create({ cwd: "/repo", model: "claude-opus-4-6" });

    const closed = await host.reapIdleRunningSessions(300_000, 301_000);
    expect(closed).toEqual(["s-stale"]);

    expect(host.list().map((s) => (s as { id: string }).id)).toEqual(["s-fresh"]);
  });

  it("persists only sessions with running SDK processes", async () => {
    const running = new FakeSession("s-running");
    running.isProcessRunning = true;

    const idle = new FakeSession("s-idle");
    idle.isProcessRunning = false;

    let createCalls = 0;
    const host = new SessionHost({
      create: () => {
        createCalls += 1;
        return (createCalls === 1 ? running : idle) as unknown as AgentRuntimeSession;
      },
    });

    await host.create({ cwd: "/repo", model: "claude-opus-4-6" });
    await host.create({ cwd: "/repo", model: "claude-opus-4-6" });

    const records = host.getSessionRecords();
    expect(records.map((r) => r.id)).toEqual(["s-running"]);
  });
});
