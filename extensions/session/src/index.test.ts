import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { ExtensionContext } from "@anima/shared";
import { clearConfigCache } from "@anima/shared";
import { createSessionExtension } from "./index";
import { AgentHostClient } from "./agent-client";
import { getStoredSession, upsertSession } from "./session-store";
import * as workspace from "./workspace";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";

const testHome = join("/tmp", `claudia-test-home-${Date.now()}`);
mkdirSync(testHome, { recursive: true });
process.env.HOME = testHome;

const sessionId = "session-test-123";

function createTestContext(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    on: () => () => {},
    emit: () => {},
    async call() {
      throw new Error("Not implemented in test");
    },
    connectionId: null,
    tags: null,
    config: {},
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => ({
        info: () => {},
        warn: () => {},
        error: () => {},
        child: () => {
          throw new Error("not implemented");
        },
      }),
    },
    createLogger: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      child() {
        return this;
      },
    }),
    store: (() => {
      const _data: Record<string, unknown> = {};
      return {
        get: <T = unknown>(key: string): T | undefined => _data[key] as T | undefined,
        set: (key: string, value: unknown) => {
          _data[key] = value;
        },
        delete: (key: string) => {
          delete _data[key];
          return true;
        },
        all: () => _data,
      };
    })(),
    ...overrides,
  };
}

describe("session extension", () => {
  let promptSpy: ReturnType<typeof spyOn>;
  let emitEventSpy: ReturnType<typeof spyOn>;
  let createSpy: ReturnType<typeof spyOn>;
  let interruptSpy: ReturnType<typeof spyOn>;
  let closeSpy: ReturnType<typeof spyOn>;
  let listSpy: ReturnType<typeof spyOn>;
  let setPermissionModeSpy: ReturnType<typeof spyOn>;
  let sendToolResultSpy: ReturnType<typeof spyOn>;
  let spawnSubagentSpy: ReturnType<typeof spyOn>;
  let listWorkspacesSpy: ReturnType<typeof spyOn>;
  let getWorkspaceSpy: ReturnType<typeof spyOn>;
  let getOrCreateWorkspaceSpy: ReturnType<typeof spyOn>;
  let closeDbSpy: ReturnType<typeof spyOn>;
  let connectSpy: ReturnType<typeof spyOn>;
  let disconnectSpy: ReturnType<typeof spyOn>;
  let homedirSpy: ReturnType<typeof spyOn>;
  let lastAgentClient: AgentHostClient | null;

  beforeEach(() => {
    clearConfigCache();
    lastAgentClient = null;
    mkdirSync(join(testHome, ".anima"), { recursive: true });
    writeFileSync(
      join(testHome, ".anima", "anima.json"),
      JSON.stringify({
        gateway: { port: 30086, host: "localhost" },
        extensions: {
          session: {
            enabled: true,
            config: { model: "claude-opus-4-6", thinking: false, effort: "medium" },
          },
        },
      }),
      "utf-8",
    );
    homedirSpy = spyOn(os, "homedir").mockReturnValue(testHome);
    emitEventSpy = spyOn(AgentHostClient.prototype, "emit");
    connectSpy = spyOn(AgentHostClient.prototype, "connect").mockImplementation(
      function (this: AgentHostClient) {
        (this as unknown as { _isConnected: boolean })._isConnected = true;
        return Promise.resolve();
      },
    );
    disconnectSpy = spyOn(AgentHostClient.prototype, "disconnect").mockImplementation(
      function (this: AgentHostClient) {
        (this as unknown as { _isConnected: boolean })._isConnected = false;
      },
    );
    createSpy = spyOn(AgentHostClient.prototype, "createSession").mockImplementation(
      async (params: { sessionId?: string }) => ({
        sessionId: params.sessionId || "created-session-1",
      }),
    );
    interruptSpy = spyOn(AgentHostClient.prototype, "interrupt").mockResolvedValue(true);
    closeSpy = spyOn(AgentHostClient.prototype, "close").mockResolvedValue(undefined);
    listSpy = spyOn(AgentHostClient.prototype, "list").mockResolvedValue([
      {
        id: sessionId,
        cwd: "/repo/project",
        model: "claude-test",
        isActive: true,
        isProcessRunning: true,
        createdAt: new Date().toISOString(),
        healthy: true,
        stale: false,
        lastActivity: new Date().toISOString(),
      },
    ]);
    setPermissionModeSpy = spyOn(AgentHostClient.prototype, "setPermissionMode").mockResolvedValue(
      true,
    );
    sendToolResultSpy = spyOn(AgentHostClient.prototype, "sendToolResult").mockResolvedValue(true);
    spawnSubagentSpy = spyOn(AgentHostClient.prototype, "spawnSubagent").mockImplementation(
      async function (
        this: AgentHostClient,
        params: { subagentId?: string; parentSessionId: string },
      ) {
        lastAgentClient = this;
        return {
          subagentId: params.subagentId || "subagent_123",
          sessionId: params.subagentId || "subagent_123",
          parentSessionId: params.parentSessionId,
          status: "running",
          message: "spawned",
        };
      },
    );
    listWorkspacesSpy = spyOn(workspace, "listWorkspaces").mockReturnValue([
      {
        id: "ws-1",
        name: "project",
        cwd: "/repo/project",
        general: false,
        cwdDisplay: "/repo/project",
        createdAt: "2026-02-22T00:00:00.000Z",
        updatedAt: "2026-02-22T00:00:00.000Z",
      },
    ]);
    getWorkspaceSpy = spyOn(workspace, "getWorkspace").mockReturnValue({
      id: "ws-1",
      name: "project",
      cwd: "/repo/project",
      general: false,
      cwdDisplay: "/repo/project",
      createdAt: "2026-02-22T00:00:00.000Z",
      updatedAt: "2026-02-22T00:00:00.000Z",
    });
    getOrCreateWorkspaceSpy = spyOn(workspace, "getOrCreateWorkspace").mockReturnValue({
      workspace: {
        id: "ws-2",
        name: "new-project",
        cwd: "/repo/new-project",
        general: false,
        cwdDisplay: "/repo/new-project",
        createdAt: "2026-02-22T00:00:00.000Z",
        updatedAt: "2026-02-22T00:00:00.000Z",
      },
      created: true,
    });
    closeDbSpy = spyOn(workspace, "closeDb").mockImplementation(() => {});

    promptSpy = spyOn(AgentHostClient.prototype, "prompt").mockImplementation(function (
      this: AgentHostClient,
      sid: string,
    ) {
      this.emit("session.event", {
        eventName: `session.${sid}.content_block_delta`,
        sessionId: sid,
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hello " },
      });

      this.emit("session.event", {
        eventName: `session.${sid}.content_block_delta`,
        sessionId: sid,
        type: "content_block_delta",
        delta: { type: "text_delta", text: "world" },
      });

      this.emit("session.event", {
        eventName: `session.${sid}.turn_stop`,
        sessionId: sid,
        type: "turn_stop",
      });

      return Promise.resolve();
    });
  });

  afterEach(() => {
    clearConfigCache();
    homedirSpy.mockRestore();
    promptSpy.mockRestore();
    emitEventSpy.mockRestore();
    createSpy.mockRestore();
    interruptSpy.mockRestore();
    closeSpy.mockRestore();
    listSpy.mockRestore();
    setPermissionModeSpy.mockRestore();
    sendToolResultSpy.mockRestore();
    spawnSubagentSpy.mockRestore();
    listWorkspacesSpy.mockRestore();
    getWorkspaceSpy.mockRestore();
    getOrCreateWorkspaceSpy.mockRestore();
    closeDbSpy.mockRestore();
    connectSpy.mockRestore();
    disconnectSpy.mockRestore();
  });

  it("returns accumulated text for non-streaming prompts", async () => {
    const ext = createSessionExtension();
    await ext.start(createTestContext());

    const result = (await ext.handleMethod("session.send_prompt", {
      sessionId,
      content: "ping",
      streaming: false,
    })) as { text: string; sessionId: string; stopReason: string };

    expect(result).toEqual({ text: "Hello world", sessionId, stopReason: "unknown" });

    await ext.stop();
  });

  it("keeps prompt state isolated across concurrent sessions", async () => {
    promptSpy.mockImplementation(function (this: AgentHostClient, sid: string) {
      return new Promise<void>((resolve) => {
        const chunks =
          sid === "session-a"
            ? [
                { at: 0, text: "Alpha " },
                { at: 20, text: "done" },
              ]
            : [
                { at: 5, text: "Beta " },
                { at: 10, text: "done" },
              ];

        for (const chunk of chunks) {
          setTimeout(() => {
            this.emit("session.event", {
              eventName: `session.${sid}.content_block_delta`,
              sessionId: sid,
              type: "content_block_delta",
              delta: { type: "text_delta", text: chunk.text },
            });
          }, chunk.at);
        }

        setTimeout(
          () => {
            this.emit("session.event", {
              eventName: `session.${sid}.turn_stop`,
              sessionId: sid,
              type: "turn_stop",
            });
            resolve();
          },
          sid === "session-a" ? 25 : 15,
        );
      });
    });

    const ext = createSessionExtension();
    await ext.start(createTestContext());

    const promptA = ext.handleMethod("session.send_prompt", {
      sessionId: "session-a",
      content: "alpha",
      streaming: false,
    }) as Promise<{ text: string; sessionId: string; stopReason: string }>;

    const promptB = ext.handleMethod("session.send_prompt", {
      sessionId: "session-b",
      content: "beta",
      streaming: false,
    }) as Promise<{ text: string; sessionId: string; stopReason: string }>;

    const listed = (await ext.handleMethod("session.list_workspaces", {})) as {
      workspaces: Array<{ id: string }>;
    };

    const [resultA, resultB] = await Promise.all([promptA, promptB]);

    expect(listed.workspaces).toHaveLength(1);
    expect(resultA).toEqual({
      text: "Alpha done",
      sessionId: "session-a",
      stopReason: "unknown",
    });
    expect(resultB).toEqual({
      text: "Beta done",
      sessionId: "session-b",
      stopReason: "unknown",
    });

    await ext.stop();
  });

  it("propagates envelope data to async stream events", async () => {
    const emitted: Array<{ eventName: string; options?: Record<string, unknown> }> = [];

    const ext = createSessionExtension();
    await ext.start(
      createTestContext({
        connectionId: "conn-voice-1",
        tags: ["voice"],
        emit: (eventName, _payload, options) => {
          emitted.push({ eventName, options: options as Record<string, unknown> | undefined });
        },
      }),
    );

    await ext.handleMethod("session.send_prompt", {
      sessionId,
      content: "ping",
      streaming: false,
      source: "imessage/+15551234567",
    });

    const deltaEvent = emitted.find((e) => e.eventName.endsWith("content_block_delta"));
    expect(deltaEvent).toBeDefined();
    expect(deltaEvent?.options).toEqual({
      source: "imessage/+15551234567",
      connectionId: "conn-voice-1",
      tags: ["voice"],
    });

    await ext.stop();
  });

  it("returns immediately for streaming prompts", async () => {
    promptSpy.mockImplementation(() => Promise.resolve());

    const ext = createSessionExtension();
    await ext.start(
      createTestContext({
        async call(method) {
          if (method === "memory.transition_conversation") return { transitioned: 0 };
          if (method === "memory.get_session_context") {
            return { recentMessages: [], recentSummaries: [] };
          }
          return null;
        },
      }),
    );

    const result = (await ext.handleMethod("session.send_prompt", {
      sessionId,
      content: "ping",
      streaming: true,
    })) as { status: string; sessionId: string };

    expect(result).toEqual({ status: "streaming", sessionId });
    expect(promptSpy).toHaveBeenCalledTimes(1);
    expect(promptSpy).toHaveBeenCalledWith(
      sessionId,
      "ping",
      "/repo/project",
      "claude-test",
      "claude",
    );

    await ext.stop();
  });

  it("propagates envelope data in streaming mode for async events", async () => {
    const emitted: Array<{ eventName: string; options?: Record<string, unknown> }> = [];

    promptSpy.mockImplementation(function (this: AgentHostClient, sid: string) {
      queueMicrotask(() => {
        this.emit("session.event", {
          eventName: `session.${sid}.content_block_delta`,
          sessionId: sid,
          type: "content_block_delta",
          delta: { type: "text_delta", text: "stream" },
        });
      });
      return Promise.resolve();
    });

    const ext = createSessionExtension();
    await ext.start(
      createTestContext({
        connectionId: "conn-stream-1",
        tags: ["voice", "realtime"],
        emit: (eventName, _payload, options) => {
          emitted.push({ eventName, options: options as Record<string, unknown> | undefined });
        },
      }),
    );

    await ext.handleMethod("session.send_prompt", {
      sessionId,
      content: "ping",
      streaming: true,
      source: "chat/browser",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const deltaEvent = emitted.find((e) => e.eventName.endsWith("content_block_delta"));
    expect(deltaEvent).toBeDefined();
    expect(deltaEvent?.options).toEqual({
      source: "chat/browser",
      connectionId: "conn-stream-1",
      tags: ["voice", "realtime"],
    });

    await ext.stop();
  });

  it("rejects non-streaming prompt when manager.prompt fails", async () => {
    promptSpy.mockImplementation(() => Promise.reject(new Error("prompt failed")));

    const ext = createSessionExtension();
    await ext.start(createTestContext());

    await expect(
      ext.handleMethod("session.send_prompt", {
        sessionId,
        content: "ping",
        streaming: false,
      }),
    ).rejects.toThrow("prompt failed");

    expect(emitEventSpy).not.toHaveBeenCalledWith(
      "session.event",
      expect.objectContaining({ type: "turn_stop" }),
    );

    await ext.stop();
  });

  it("creates sessions via session.create_session", async () => {
    const ext = createSessionExtension();
    await ext.start(createTestContext());

    const result = await ext.handleMethod("session.create_session", {
      cwd: "/repo/project",
      model: "claude-opus",
      systemPrompt: "You are strict",
      thinking: true,
      effort: "high",
    });

    expect(result).toMatchObject({ sessionId: expect.any(String) });
    expect(createSpy).not.toHaveBeenCalled();

    await ext.stop();
  });

  it("uses extension config model defaults when params do not override", async () => {
    const ext = createSessionExtension({
      model: "claude-opus-4-6",
      thinking: true,
      effort: "high",
    });
    await ext.start(createTestContext());

    await ext.handleMethod("session.create_session", {
      cwd: "/repo/project",
    });

    expect(createSpy).not.toHaveBeenCalled();

    await ext.stop();
  });

  it("requests global archived summaries only for general workspaces", async () => {
    const memoryCalls: Array<Record<string, unknown>> = [];
    const workspacesByCwd = new Map<
      string,
      {
        id: string;
        name: string;
        cwd: string;
        general: boolean;
        cwdDisplay: string;
        createdAt: string;
        updatedAt: string;
      }
    >();
    getOrCreateWorkspaceSpy.mockImplementation((cwd: string, name?: string, general?: boolean) => {
      const existing = workspacesByCwd.get(cwd);
      if (existing) {
        return { workspace: existing, created: false };
      }

      const workspace = {
        id: cwd === "/repo/general" ? "ws-general" : "ws-project",
        name: name || cwd.split("/").pop() || "workspace",
        cwd,
        general: general === true,
        cwdDisplay: cwd,
        createdAt: "2026-02-22T00:00:00.000Z",
        updatedAt: "2026-02-22T00:00:00.000Z",
      };
      workspacesByCwd.set(cwd, workspace);
      return { workspace, created: true };
    });

    const ext = createSessionExtension();
    await ext.start(
      createTestContext({
        async call(method, params) {
          if (method === "memory.transition_conversation") return { transitioned: 0 };
          if (method === "memory.get_session_context") {
            memoryCalls.push(params || {});
            return { recentMessages: [], recentSummaries: [] };
          }
          return null;
        },
      }),
    );

    await ext.handleMethod("session.get_or_create_workspace", {
      cwd: "/repo/general",
      name: "General",
      general: true,
    });
    const generalResult = (await ext.handleMethod("session.create_session", {
      cwd: "/repo/general",
    })) as { sessionId: string };
    await ext.handleMethod("session.send_prompt", {
      sessionId: generalResult.sessionId,
      cwd: "/repo/general",
      content: "hello",
    });

    await ext.handleMethod("session.get_or_create_workspace", {
      cwd: "/repo/project",
      name: "Project",
      general: false,
    });
    const projectResult = (await ext.handleMethod("session.create_session", {
      cwd: "/repo/project",
    })) as { sessionId: string };
    await ext.handleMethod("session.send_prompt", {
      sessionId: projectResult.sessionId,
      cwd: "/repo/project",
      content: "hello",
    });

    expect(memoryCalls).toEqual([
      { cwd: "/repo/general", includeAllSummaries: true },
      { cwd: "/repo/project", includeAllSummaries: false },
    ]);

    await ext.stop();
  });

  it("fails open when memory transition hangs during first-prompt bootstrap", async () => {
    const timeoutCallbacks: Array<() => void> = [];
    const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
      cb: (...args: unknown[]) => void,
    ) => {
      timeoutCallbacks.push(() => cb());
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});

    const ext = createSessionExtension();
    await ext.start(
      createTestContext({
        async call(method) {
          if (method === "memory.transition_conversation") {
            return new Promise(() => undefined);
          }
          if (method === "memory.get_session_context") {
            return { recentMessages: [], recentSummaries: [] };
          }
          return null;
        },
      }),
    );

    const created = (await ext.handleMethod("session.create_session", {
      cwd: "/repo/project",
    })) as { sessionId: string };
    const pending = ext.handleMethod("session.send_prompt", {
      sessionId: created.sessionId,
      cwd: "/repo/project",
      content: "hello",
    });
    for (let i = 0; i < 20 && timeoutCallbacks.length === 0; i++) {
      await Promise.resolve();
    }
    expect(timeoutCallbacks.length).toBeGreaterThanOrEqual(1);
    timeoutCallbacks[0]?.();

    await expect(pending).resolves.toEqual({ status: "streaming", sessionId: created.sessionId });
    expect(createSpy).toHaveBeenCalledWith({
      sessionId: created.sessionId,
      agent: "claude",
      cwd: "/repo/project",
      model: "claude-opus-4-6",
      systemPrompt: expect.stringContaining("Current local date and time:"),
      thinking: false,
      effort: "medium",
    });

    await ext.stop();
    timeoutSpy.mockRestore();
    clearSpy.mockRestore();
  });

  it("bootstraps memory on the first prompt for draft sessions", async () => {
    const ext = createSessionExtension();
    await ext.start(
      createTestContext({
        async call(method) {
          if (method === "memory.transition_conversation") return { transitioned: 1 };
          if (method === "memory.get_session_context") {
            return {
              recentMessages: [
                {
                  role: "user",
                  content: "continue where we left off",
                  timestamp: "2026-02-22T12:00:00.000Z",
                },
              ],
              recentSummaries: [],
            };
          }
          return null;
        },
      }),
    );

    const created = (await ext.handleMethod("session.create_session", {
      cwd: "/repo/project",
      systemPrompt: "You are strict",
      thinking: true,
      effort: "high",
    })) as { sessionId: string };

    await ext.handleMethod("session.send_prompt", {
      sessionId: created.sessionId,
      cwd: "/repo/project",
      content: "hello",
    });

    expect(createSpy).toHaveBeenCalledWith({
      sessionId: created.sessionId,
      agent: "claude",
      cwd: "/repo/project",
      model: "claude-opus-4-6",
      systemPrompt: expect.stringContaining("You are strict"),
      thinking: true,
      effort: "high",
    });

    await ext.stop();
  });

  it("skips bootstrap when a persisted session file already exists", async () => {
    const ext = createSessionExtension();
    await ext.start(createTestContext());

    const created = (await ext.handleMethod("session.create_session", {
      cwd: "/repo/project",
    })) as { sessionId: string };

    const persistedDir = join(testHome, ".claude", "projects", "-repo-project");
    mkdirSync(persistedDir, { recursive: true });
    writeFileSync(join(persistedDir, `${created.sessionId}.jsonl`), "", "utf-8");

    await ext.handleMethod("session.send_prompt", {
      sessionId: created.sessionId,
      cwd: "/repo/project",
      content: "hello",
    });

    expect(createSpy).not.toHaveBeenCalled();

    await ext.stop();
  });

  it("tracks session message timestamps and skips elapsed reminder without prior assistant metadata", async () => {
    let capturedContent: string | unknown[] | undefined;
    promptSpy.mockImplementationOnce(function (
      this: AgentHostClient,
      sid: string,
      content: string | unknown[],
    ) {
      capturedContent = content;
      this.emit("session.event", {
        eventName: `session.${sid}.content_block_delta`,
        sessionId: sid,
        type: "content_block_delta",
        delta: { type: "text_delta", text: "fresh answer" },
      });
      this.emit("session.event", {
        eventName: `session.${sid}.turn_stop`,
        sessionId: sid,
        type: "turn_stop",
      });
      return Promise.resolve();
    });

    const ext = createSessionExtension();
    await ext.start(createTestContext());

    const created = (await ext.handleMethod("session.create_session", {
      cwd: "/repo/project",
    })) as { sessionId: string };

    await ext.handleMethod("session.send_prompt", {
      sessionId: created.sessionId,
      cwd: "/repo/project",
      content: "hello",
    });

    expect(capturedContent).toBe("hello");
    const stored = getStoredSession(created.sessionId);
    expect(Date.parse(String(stored?.metadata?.lastUserMessageAt))).toBeGreaterThan(0);
    expect(Date.parse(String(stored?.metadata?.lastAssistantMessageAt))).toBeGreaterThan(0);
    expect(stored?.metadata?.lastAssistantMessagePreview).toBeUndefined();

    await ext.stop();
  });

  it("injects elapsed time reminder when prior assistant output is stale", async () => {
    let capturedContent: string | unknown[] | undefined;
    promptSpy.mockImplementationOnce(function (
      this: AgentHostClient,
      sid: string,
      content: string | unknown[],
    ) {
      capturedContent = content;
      this.emit("session.event", {
        eventName: `session.${sid}.turn_stop`,
        sessionId: sid,
        type: "turn_stop",
      });
      return Promise.resolve();
    });

    const ext = createSessionExtension();
    await ext.start(createTestContext());

    const created = (await ext.handleMethod("session.create_session", {
      cwd: "/repo/project",
    })) as { sessionId: string };
    const stored = getStoredSession(created.sessionId);
    expect(stored).toBeTruthy();
    upsertSession({
      id: created.sessionId,
      workspaceId: stored!.workspaceId,
      providerSessionId: created.sessionId,
      model: stored!.model,
      agent: stored!.agent,
      purpose: stored!.purpose,
      runtimeStatus: stored!.runtimeStatus,
      metadata: {
        ...(stored!.metadata || {}),
        lastAssistantMessageAt: "2026-01-01T00:00:00.000Z",
      },
    });

    await ext.handleMethod("session.send_prompt", {
      sessionId: created.sessionId,
      cwd: "/repo/project",
      content: "hello again",
    });

    expect(typeof capturedContent).toBe("string");
    expect(capturedContent as string).toContain("<system-reminder>");
    expect(capturedContent as string).toContain("Current local date and time:");
    expect(capturedContent as string).toContain("Time since last assistant message:");
    expect(capturedContent as string).not.toContain("Last assistant message preview:");
    expect(capturedContent as string).toContain("hello again");

    await ext.stop();
  });

  it("spawns child agents as child sessions and routes their stream", async () => {
    const emitted: Array<{
      eventName: string;
      payload: Record<string, unknown>;
      options?: Record<string, unknown>;
    }> = [];

    const ext = createSessionExtension();
    await ext.start(
      createTestContext({
        connectionId: "conn-subagent-1",
        tags: ["voice.speak"],
        emit: (eventName, payload, options) => {
          emitted.push({
            eventName,
            payload: payload as Record<string, unknown>,
            options: options as Record<string, unknown> | undefined,
          });
        },
      }),
    );

    const started = (await ext.handleMethod("session.spawn_agent", {
      parentSessionId: sessionId,
      agent: "codex",
      prompt: "review this",
      purpose: "subagent",
    })) as Record<string, unknown>;

    const subagentId = String(started.subagentId);
    expect(subagentId).toMatch(/[0-9a-f-]{36}/);
    expect(started.status).toBe("running");
    expect(spawnSubagentSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: sessionId,
        cwd: "/repo/project",
        agent: "codex",
        subagentId,
      }),
    );

    lastAgentClient?.emit("session.event", {
      eventName: `session.${subagentId}.content_block_delta`,
      sessionId: subagentId,
      type: "content_block_delta",
      delta: { type: "text_delta", text: "delta" },
    });

    const mapped = emitted.find((e) => e.eventName === `session.${subagentId}.content_block_delta`);
    expect(mapped).toBeDefined();
    expect(mapped?.options).toEqual({
      source: "gateway.caller",
      connectionId: "conn-subagent-1",
      tags: ["voice.speak"],
    });

    const listed = (await ext.handleMethod("session.list_subagents", {})) as {
      subagents: Array<{ subagentId: string }>;
    };
    expect(listed.subagents.map((s) => s.subagentId)).toContain(subagentId);

    await ext.stop();
  });

  it("sends a user_notification to parent session when subagent completes", async () => {
    const ext = createSessionExtension();
    await ext.start(createTestContext());

    const started = (await ext.handleMethod("session.spawn_agent", {
      parentSessionId: sessionId,
      agent: "codex",
      prompt: "do thing",
      purpose: "subagent",
    })) as { subagentId: string };

    lastAgentClient?.emit("session.event", {
      eventName: `session.${started.subagentId}.turn_stop`,
      sessionId: started.subagentId,
      type: "turn_stop",
      stop_reason: "end_turn",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(promptSpy).toHaveBeenCalledWith(
      sessionId,
      expect.stringContaining("<user_notification>"),
      undefined,
      expect.any(String),
      expect.any(String),
    );

    await ext.stop();
  });

  it("switches and resets sessions through manager methods", async () => {
    createSpy.mockResolvedValueOnce({ sessionId: "reset-session-1" });

    const ext = createSessionExtension();
    await ext.start(createTestContext());

    const switched = await ext.handleMethod("session.switch_session", {
      sessionId: "resume-1",
      cwd: "/repo/project",
      model: "claude-sonnet-4-6",
    });
    expect(promptSpy).toHaveBeenCalledWith("resume-1", "", "/repo/project", "claude-sonnet-4-6");
    expect(switched).toEqual({ sessionId: "resume-1" });

    const reset = await ext.handleMethod("session.reset_session", {
      cwd: "/repo/project",
      model: "claude-opus",
    });
    expect(createSpy).toHaveBeenCalledWith({
      cwd: "/repo/project",
      model: "claude-opus",
    });
    expect(reset).toEqual({ sessionId: "reset-session-1" });

    await ext.stop();
  });

  it("recycles running session when active model drifts from stored model", async () => {
    const ext = createSessionExtension();
    await ext.start(createTestContext());

    // Simulate drift: host reports claude-sonnet-4-6 while request wants opus.
    listSpy.mockResolvedValueOnce([
      {
        id: "drift-session",
        cwd: "/repo/project",
        model: "claude-sonnet-4-6",
        isActive: true,
        isProcessRunning: true,
        createdAt: new Date().toISOString(),
        healthy: true,
        stale: false,
        lastActivity: new Date().toISOString(),
      },
    ]);

    await ext.handleMethod("session.send_prompt", {
      sessionId: "drift-session",
      cwd: "/repo/project",
      content: "ping",
      model: "claude-opus-4-6",
      streaming: true,
    });

    expect(closeSpy).toHaveBeenCalledWith("drift-session");
    expect(promptSpy).toHaveBeenCalledWith(
      "drift-session",
      "ping",
      "/repo/project",
      "claude-opus-4-6",
      "claude",
    );

    await ext.stop();
  });

  it("delegates interrupt/close/permission/tool_result methods", async () => {
    const ext = createSessionExtension();
    await ext.start(createTestContext());

    const interrupted = await ext.handleMethod("session.interrupt_session", { sessionId: "s-1" });
    expect(interruptSpy).toHaveBeenCalledWith("s-1");
    expect(interrupted).toEqual({ ok: true });

    const permission = await ext.handleMethod("session.set_permission_mode", {
      sessionId: "s-1",
      mode: "acceptEdits",
    });
    expect(setPermissionModeSpy).toHaveBeenCalledWith("s-1", "acceptEdits");
    expect(permission).toEqual({ ok: true });

    const toolResult = await ext.handleMethod("session.send_tool_result", {
      sessionId: "s-1",
      toolUseId: "tool-123",
      content: "done",
      isError: true,
    });
    expect(sendToolResultSpy).toHaveBeenCalledWith("s-1", "tool-123", "done", true);
    expect(toolResult).toEqual({ ok: true });

    const closed = await ext.handleMethod("session.close_session", { sessionId: "s-1" });
    expect(closeSpy).toHaveBeenCalledWith("s-1");
    expect(closed).toEqual({ ok: true });

    await ext.stop();
  });

  it("returns expected info and health payloads", async () => {
    const ext = createSessionExtension();
    await ext.start(createTestContext());

    const infoNoSession = (await ext.handleMethod("session.get_info", {})) as {
      activeSessions: unknown[];
    };
    expect(infoNoSession.activeSessions).toHaveLength(1);

    const infoWithSession = (await ext.handleMethod("session.get_info", {
      sessionId,
    })) as { session: { id: string } | null; activeSessions: unknown[] };
    expect(infoWithSession.session?.id).toBe(sessionId);
    expect(infoWithSession.activeSessions).toHaveLength(1);

    const health = (await ext.handleMethod("session.health_check", {})) as {
      ok: boolean;
      label: string;
      status: string;
      metrics?: Array<{ label: string; value: string | number }>;
      items?: Array<{ id: string; label: string; status: string }>;
    };
    expect(health.ok).toBe(true);
    expect(health.label).toBe("Sessions");
    expect(health.status).toBe("healthy");
    expect(health.metrics?.[0]).toEqual({ label: "Agent Host", value: "connected" });
    expect(health.items?.length).toBe(1);
    expect(health.items?.[0]).toMatchObject({
      id: sessionId,
      label: "/repo/project",
      status: "healthy",
    });
    expect(
      (health.items?.[0] as { details?: Record<string, string> }).details?.lastActivityAgo,
    ).toMatch(/ago$/);

    await ext.stop();
  });

  it("throws for unknown methods", async () => {
    const ext = createSessionExtension();
    await ext.start(createTestContext());

    await expect(ext.handleMethod("session.nope", {})).rejects.toThrow(
      "Unknown method: session.nope",
    );

    await ext.stop();
  });

  it("routes workspace CRUD methods through workspace module", async () => {
    const ext = createSessionExtension();
    await ext.start(createTestContext());

    const listed = await ext.handleMethod("session.list_workspaces", {});
    expect(listWorkspacesSpy).toHaveBeenCalledTimes(1);
    expect(listed).toEqual({
      workspaces: [
        {
          id: "ws-1",
          name: "project",
          cwd: "/repo/project",
          general: false,
          cwdDisplay: "/repo/project",
          createdAt: "2026-02-22T00:00:00.000Z",
          updatedAt: "2026-02-22T00:00:00.000Z",
        },
      ],
    });

    const fetched = await ext.handleMethod("session.get_workspace", { id: "ws-1" });
    expect(getWorkspaceSpy).toHaveBeenCalledWith("ws-1");
    expect(fetched).toEqual({
      workspace: {
        id: "ws-1",
        name: "project",
        cwd: "/repo/project",
        general: false,
        cwdDisplay: "/repo/project",
        createdAt: "2026-02-22T00:00:00.000Z",
        updatedAt: "2026-02-22T00:00:00.000Z",
      },
    });

    const created = await ext.handleMethod("session.get_or_create_workspace", {
      cwd: "/repo/new-project",
      name: "new-project",
    });
    expect(getOrCreateWorkspaceSpy).toHaveBeenCalledWith(
      "/repo/new-project",
      "new-project",
      undefined,
    );
    expect(created).toEqual({
      workspace: {
        id: "ws-2",
        name: "new-project",
        cwd: "/repo/new-project",
        general: false,
        cwdDisplay: "/repo/new-project",
        createdAt: "2026-02-22T00:00:00.000Z",
        updatedAt: "2026-02-22T00:00:00.000Z",
      },
      created: true,
    });

    await ext.stop();
  });

  it("lists child directories with tilde expansion and hides dot-directories", async () => {
    const ext = createSessionExtension();
    await ext.start(createTestContext());
    const rootName = `claudia-dir-list-${Date.now()}`;
    const basePath = join(testHome, "Projects", rootName);
    const tildePath = `~/Projects/${rootName}`;

    try {
      mkdirSync(join(basePath, "alpha"), { recursive: true });
      mkdirSync(join(basePath, "beta"), { recursive: true });
      mkdirSync(join(basePath, ".hidden"), { recursive: true });
      writeFileSync(join(basePath, "README.md"), "not a directory");

      const result = (await ext.handleMethod("session.get_directories", {
        path: tildePath,
      })) as { path: string; directories: string[] };

      expect(result.path).toBe(tildePath);
      expect(result.directories).toEqual(["alpha", "beta"]);
    } finally {
      rmSync(basePath, { recursive: true, force: true });
      await ext.stop();
    }
  });

  it("returns an empty directory list for missing paths", async () => {
    const ext = createSessionExtension();
    await ext.start(createTestContext());

    try {
      const result = (await ext.handleMethod("session.get_directories", {
        path: "/definitely/missing/claudia-path",
      })) as { path: string; directories: string[] };
      expect(result.directories).toEqual([]);
    } finally {
      await ext.stop();
    }
  });

  it("lists sessions from ~/.claude/projects sorted by recency", async () => {
    const ext = createSessionExtension();
    await ext.start(createTestContext());
    const cwd = `/tmp/claudia-test-${Date.now()}-sessions`;
    const encodedCwd = cwd.replace(/\//g, "-");
    const projectDir = join(os.homedir(), ".claude", "projects", encodedCwd);
    try {
      mkdirSync(projectDir, { recursive: true });

      writeFileSync(
        join(projectDir, "sessions-index.json"),
        JSON.stringify({
          originalPath: cwd,
          entries: [
            {
              sessionId: "old-session",
              created: "2026-01-01T00:00:00.000Z",
              modified: "2026-01-01T00:00:00.000Z",
              messageCount: 2,
            },
            {
              sessionId: "new-session",
              created: "2026-02-22T00:00:00.000Z",
              modified: "2026-02-22T00:00:00.000Z",
              messageCount: 3,
              gitBranch: "main",
            },
          ],
        }),
      );

      writeFileSync(
        join(projectDir, "old-session.jsonl"),
        `${JSON.stringify({
          type: "user",
          message: { role: "user", content: "older prompt" },
        })}\n`,
      );
      writeFileSync(
        join(projectDir, "new-session.jsonl"),
        `${JSON.stringify({
          type: "user",
          message: { role: "user", content: "newer prompt" },
        })}\n`,
      );

      const result = (await ext.handleMethod("session.list_sessions", { cwd })) as {
        sessions: Array<{ sessionId: string; firstPrompt?: string; gitBranch?: string }>;
      };

      expect(result.sessions).toHaveLength(2);
      expect(result.sessions[0]?.sessionId).toBe("new-session");
      expect(result.sessions[0]?.gitBranch).toBe("main");
      expect(result.sessions[0]?.firstPrompt).toBe("newer prompt");
      expect(result.sessions[1]?.sessionId).toBe("old-session");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      await ext.stop();
    }
  });

  it("discovers sessions via originalPath fallback and extracts first text block prompts", async () => {
    const ext = createSessionExtension();
    await ext.start(createTestContext());
    const cwd = `/tmp/claudia-test-${Date.now()}-fallback`;
    const fallbackDir = join(os.homedir(), ".claude", "projects", `fallback-${Date.now()}`);
    const badDir = join(os.homedir(), ".claude", "projects", `bad-${Date.now()}`);

    try {
      mkdirSync(fallbackDir, { recursive: true });
      mkdirSync(badDir, { recursive: true });

      writeFileSync(join(badDir, "sessions-index.json"), "{ this is not json");
      writeFileSync(
        join(fallbackDir, "sessions-index.json"),
        JSON.stringify({
          originalPath: cwd,
          entries: [{ sessionId: "fallback-session", modified: "2026-02-22T01:00:00.000Z" }],
        }),
      );
      writeFileSync(
        join(fallbackDir, "fallback-session.jsonl"),
        `${JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: "prompt from text block" }],
          },
        })}\n`,
      );

      const result = (await ext.handleMethod("session.list_sessions", { cwd })) as {
        sessions: Array<{ sessionId: string; firstPrompt?: string }>;
      };
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]?.sessionId).toBe("fallback-session");
      expect(result.sessions[0]?.firstPrompt).toBe("prompt from text block");
    } finally {
      rmSync(fallbackDir, { recursive: true, force: true });
      rmSync(badDir, { recursive: true, force: true });
      await ext.stop();
    }
  });

  it("handles delayed turn_stop logging path for streaming prompts", async () => {
    const removeListenerSpy = spyOn(AgentHostClient.prototype, "removeListener");
    promptSpy.mockImplementation(function (this: AgentHostClient, sid: string) {
      setTimeout(() => {
        this.emit("session.event", {
          eventName: `session.${sid}.content_block_delta`,
          sessionId: sid,
          type: "content_block_delta",
          delta: { type: "text_delta", text: "late chunk" },
        });
        this.emit("session.event", {
          eventName: `session.${sid}.turn_stop`,
          sessionId: sid,
          type: "turn_stop",
        });
      }, 0);
      return Promise.resolve();
    });

    const ext = createSessionExtension();
    await ext.start(createTestContext());

    const result = await ext.handleMethod("session.send_prompt", {
      sessionId,
      content: "ping",
      streaming: true,
    });
    expect(result).toEqual({ status: "streaming", sessionId });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(removeListenerSpy).toHaveBeenCalledWith("session.event", expect.any(Function));

    await ext.stop();
    removeListenerSpy.mockRestore();
  });

  it("returns paginated history and empty history when session file is missing", async () => {
    const ext = createSessionExtension();
    await ext.start(createTestContext());
    const cwd = `/tmp/claudia-test-${Date.now()}-history`;
    const encodedCwd = cwd.replace(/\//g, "-");
    const projectDir = join(os.homedir(), ".claude", "projects", encodedCwd);
    try {
      mkdirSync(projectDir, { recursive: true });

      writeFileSync(
        join(projectDir, "hist-session.jsonl"),
        [
          JSON.stringify({
            type: "user",
            timestamp: "2026-02-22T00:00:00.000Z",
            message: { role: "user", content: "first" },
          }),
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-02-22T00:00:01.000Z",
            message: { role: "assistant", content: [{ type: "text", text: "second" }] },
          }),
          JSON.stringify({
            type: "user",
            timestamp: "2026-02-22T00:00:02.000Z",
            message: { role: "user", content: "third" },
          }),
        ].join("\n") + "\n",
      );

      const paged = (await ext.handleMethod("session.get_history", {
        sessionId: "hist-session",
        cwd,
        limit: 2,
        offset: 0,
      })) as {
        messages: Array<{ role: string }>;
        total: number;
        hasMore: boolean;
      };

      expect(paged.total).toBe(3);
      expect(paged.hasMore).toBe(true);
      expect(paged.messages.map((m) => m.role)).toEqual(["assistant", "user"]);

      const missing = (await ext.handleMethod("session.get_history", {
        sessionId: "missing-session",
        cwd,
      })) as { messages: unknown[]; total: number; hasMore: boolean };
      expect(missing).toEqual({ messages: [], total: 0, hasMore: false });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      await ext.stop();
    }
  });

  it("returns empty sessions when project fallback has no matching originalPath", async () => {
    const ext = createSessionExtension();
    await ext.start(createTestContext());
    const cwd = `/tmp/claudia-test-${Date.now()}-no-fallback-match`;
    const badDir = join(os.homedir(), ".claude", "projects", `bad-only-${Date.now()}`);
    try {
      mkdirSync(badDir, { recursive: true });
      writeFileSync(join(badDir, "sessions-index.json"), "{ broken json");

      const result = (await ext.handleMethod("session.list_sessions", { cwd })) as {
        sessions: Array<{ sessionId: string }>;
      };
      expect(result.sessions).toEqual([]);
    } finally {
      rmSync(badDir, { recursive: true, force: true });
      await ext.stop();
    }
  });

  it("keeps sessions when prompt extraction encounters malformed JSONL lines", async () => {
    const ext = createSessionExtension();
    await ext.start(createTestContext());
    const cwd = `/tmp/claudia-test-${Date.now()}-malformed-prompt`;
    const encodedCwd = cwd.replace(/\//g, "-");
    const projectDir = join(os.homedir(), ".claude", "projects", encodedCwd);
    try {
      mkdirSync(projectDir, { recursive: true });

      writeFileSync(
        join(projectDir, "broken-first-prompt.jsonl"),
        [
          "{not-json",
          JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "assistant only" }],
            },
          }),
        ].join("\n") + "\n",
      );

      const result = (await ext.handleMethod("session.list_sessions", { cwd })) as {
        sessions: Array<{ sessionId: string; firstPrompt?: string }>;
      };
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]?.sessionId).toBe("broken-first-prompt");
      expect(result.sessions[0]?.firstPrompt).toBeUndefined();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      await ext.stop();
    }
  });

  it("times out non-streaming prompts when turn_stop never arrives", async () => {
    const timeoutCallbacks: Array<() => void> = [];
    const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
      cb: (...args: unknown[]) => void,
    ) => {
      timeoutCallbacks.push(() => cb());
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});

    promptSpy.mockImplementation(() => Promise.resolve());

    const projectDir = join(testHome, ".claude", "projects", "-repo-project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), "", "utf-8");

    const ext = createSessionExtension();
    await ext.start(createTestContext());

    try {
      const pending = ext.handleMethod("session.send_prompt", {
        sessionId,
        cwd: "/repo/project",
        model: "claude-test",
        content: "ping",
        streaming: false,
      });
      for (let i = 0; i < 20 && timeoutCallbacks.length === 0; i++) {
        await Promise.resolve();
      }
      expect(timeoutCallbacks.length).toBeGreaterThanOrEqual(1);
      timeoutCallbacks[0]?.();
      await expect(pending).rejects.toThrow("Prompt timed out after 5 minutes");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      await ext.stop();
      timeoutSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  it("executes slow-call logging path for non-read methods", async () => {
    const nowSpy = spyOn(Date, "now");
    nowSpy.mockImplementationOnce(() => 1_000).mockImplementationOnce(() => 1_250);

    const ext = createSessionExtension();
    await ext.start(createTestContext());

    const result = await ext.handleMethod("session.create_session", { cwd: "/repo/slow" });
    expect(result).toMatchObject({ sessionId: expect.any(String) });

    await ext.stop();
    nowSpy.mockRestore();
  });
});
