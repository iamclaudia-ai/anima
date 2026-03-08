import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { createAgentHostServer, type SessionHostLike, type TaskHostLike } from "./server";
import type { SessionEventMessage, TaskEventMessage } from "./protocol";
import type { BufferedEvent } from "./event-buffer";
import type { ClaudiaConfig } from "@claudia/shared";
import type { SessionDefaults } from "./session-host";
import type { TaskRecord } from "./task-host";

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    const timer = setTimeout(() => {
      try {
        server.close();
      } catch {
        // ignore
      }
      reject(new Error("Timed out reserving free port"));
    }, 3000);
    server.listen(0, "127.0.0.1", () => {
      clearTimeout(timer);
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to reserve free port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

class WsClient {
  private ws: WebSocket;
  private inbox: Array<Record<string, unknown>> = [];
  private isOpen = false;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("open", () => {
      this.isOpen = true;
    });
    this.ws.addEventListener("message", (event) => {
      this.inbox.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    });
  }

  async waitOpen(timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (!this.isOpen && Date.now() - start < timeoutMs) {
      await Bun.sleep(10);
    }
    if (!this.isOpen) throw new Error("WebSocket did not open");
  }

  async waitFor(
    predicate: (msg: Record<string, unknown>) => boolean,
    timeoutMs = 5000,
  ): Promise<Record<string, unknown>> {
    const existing = this.inbox.find(predicate);
    if (existing) return existing;

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await Bun.sleep(10);
      const found = this.inbox.find(predicate);
      if (found) return found;
    }
    throw new Error(`Timed out waiting for message. Seen: ${JSON.stringify(this.inbox)}`);
  }

  getMessages(): Array<Record<string, unknown>> {
    return [...this.inbox];
  }

  send(msg: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.ws.close();
  }
}

class FakeSessionHost extends EventEmitter implements SessionHostLike {
  private sessions = new Map<string, { id: string }>();
  private bufferedEvents = new Map<string, BufferedEvent[]>();
  private nextId = 1;

  setDefaults(_defaults: SessionDefaults): void {}

  async create(_params: {
    cwd: string;
    model?: string;
    systemPrompt?: string;
    thinking?: boolean;
    effort?: string;
  }): Promise<{ sessionId: string }> {
    const sessionId = `s${this.nextId++}`;
    this.sessions.set(sessionId, { id: sessionId });
    return { sessionId };
  }

  async resume(params: {
    sessionId: string;
    cwd: string;
    model?: string;
    thinking?: boolean;
    effort?: string;
  }): Promise<{ sessionId: string }> {
    this.sessions.set(params.sessionId, { id: params.sessionId });
    return { sessionId: params.sessionId };
  }

  async prompt(
    _sessionId: string,
    _content: string | unknown[],
    _cwd?: string,
    _model?: string,
    _agent?: string,
  ): Promise<void> {}

  interrupt(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async close(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  setPermissionMode(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  sendToolResult(
    sessionId: string,
    _toolUseId: string,
    _content: string,
    _isError?: boolean,
  ): boolean {
    return this.sessions.has(sessionId);
  }

  list(): Array<unknown> {
    return Array.from(this.sessions.values());
  }

  getSessionRecords() {
    return Array.from(this.sessions.keys()).map((id) => ({
      id,
      cwd: "/repo",
      model: "claude-opus-4-6",
      createdAt: "2024-01-01T00:00:00.000Z",
      lastActivity: "2024-01-01T00:00:01.000Z",
    }));
  }

  getEventsAfter(sessionId: string, lastSeq: number): BufferedEvent[] {
    return (this.bufferedEvents.get(sessionId) ?? []).filter((e) => e.seq > lastSeq);
  }

  closeAll(): Promise<void> {
    this.sessions.clear();
    return Promise.resolve();
  }

  setBufferedEvents(sessionId: string, events: BufferedEvent[]): void {
    this.bufferedEvents.set(sessionId, events);
  }
}

class FakeTaskHost extends EventEmitter implements TaskHostLike {
  private tasks = new Map<string, TaskRecord>();
  private bufferedEvents = new Map<string, BufferedEvent[]>();
  private nextId = 1;

  async start(params: {
    sessionId: string;
    agent: string;
    prompt: string;
    mode?: string;
    cwd?: string;
    model?: string;
    effort?: string;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    files?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<{ taskId: string; status: string; outputFile?: string; message: string }> {
    const taskId = `t${this.nextId++}`;
    const now = new Date().toISOString();
    this.tasks.set(taskId, {
      taskId,
      sessionId: params.sessionId,
      agent: params.agent,
      mode: (params.mode as "general" | "review" | "test") || "general",
      status: "running",
      prompt: params.prompt,
      startedAt: now,
      updatedAt: now,
    });
    return { taskId, status: "running", message: "started" };
  }

  get(taskId: string): TaskRecord | null {
    return this.tasks.get(taskId) || null;
  }

  list(filters?: { sessionId?: string; status?: string; agent?: string }): TaskRecord[] {
    return Array.from(this.tasks.values()).filter((task) => {
      if (filters?.sessionId && task.sessionId !== filters.sessionId) return false;
      if (filters?.status && task.status !== filters.status) return false;
      if (filters?.agent && task.agent !== filters.agent) return false;
      return true;
    });
  }

  interrupt(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    task.status = "interrupted";
    return true;
  }

  getEventsAfter(taskId: string, lastSeq: number): BufferedEvent[] {
    return (this.bufferedEvents.get(taskId) ?? []).filter((e) => e.seq > lastSeq);
  }

  setBufferedEvents(taskId: string, events: BufferedEvent[]): void {
    this.bufferedEvents.set(taskId, events);
  }
}

describe("agent-host server", () => {
  let port: number;
  let serverCtx: Awaited<ReturnType<typeof createAgentHostServer>> | null = null;
  const fakeConfig: ClaudiaConfig = {
    gateway: { port: 0, host: "127.0.0.1" },
    session: {
      model: "claude-opus-4-6",
      thinking: false,
      effort: "medium",
      systemPrompt: null,
      skills: { paths: [] },
      imageProcessing: {
        enabled: true,
        maxWidth: 1600,
        maxHeight: 1600,
        maxFileSizeBytes: 1024 * 1024,
        format: "webp",
        quality: 85,
      },
    },
    extensions: {
      session: {
        enabled: true,
        config: {
          model: "claude-sonnet-4-6",
          thinking: false,
          effort: "medium",
        },
      },
    },
    agentHost: { url: "ws://127.0.0.1:0/ws", port: 0 },
    federation: { enabled: false, nodeId: "test", peers: [] },
  };

  beforeAll(async () => {
    port = await getFreePort();
  });

  afterAll(async () => {
    if (serverCtx) {
      await serverCtx.stop();
    }
  });

  it("replays buffered events on auth resume", async () => {
    if (serverCtx) {
      await serverCtx.stop();
    }
    const fakeHost = new FakeSessionHost();
    fakeHost.setBufferedEvents("s1", [
      { seq: 2, event: { type: "message_start" } },
      { seq: 4, event: { type: "content_block_delta", delta: { text: "hi" } } },
    ]);

    serverCtx = await createAgentHostServer({
      port,
      sessionHost: fakeHost,
      loadConfig: () => fakeConfig,
      loadState: () => ({ updatedAt: new Date().toISOString(), sessions: [] }),
      saveState: () => {},
      stateSaveIntervalMs: null,
    });

    const client = new WsClient(`ws://127.0.0.1:${port}/ws`);
    await client.waitOpen();
    client.send({
      type: "auth",
      extensionId: "session",
      resumeSessions: [{ sessionId: "s1", lastSeq: 1 }],
    });

    await client.waitFor(
      (msg) => msg.type === "session.event" && msg.sessionId === "s1" && msg.seq === 2,
    );
    await client.waitFor(
      (msg) => msg.type === "session.event" && msg.sessionId === "s1" && msg.seq === 4,
    );

    client.close();
  });

  it("broadcasts session events only to subscribed clients", async () => {
    if (serverCtx) {
      await serverCtx.stop();
    }
    const fakeHost = new FakeSessionHost();
    const saveCalls: Array<unknown> = [];

    serverCtx = await createAgentHostServer({
      port: await getFreePort(),
      sessionHost: fakeHost,
      loadConfig: () => fakeConfig,
      loadState: () => ({ updatedAt: new Date().toISOString(), sessions: [] }),
      saveState: (records) => saveCalls.push(records),
      stateSaveIntervalMs: null,
    });

    const clientA = new WsClient(`ws://127.0.0.1:${serverCtx.port}/ws`);
    const clientB = new WsClient(`ws://127.0.0.1:${serverCtx.port}/ws`);
    await clientA.waitOpen();
    await clientB.waitOpen();

    clientA.send({ type: "auth", extensionId: "session" });
    clientB.send({ type: "auth", extensionId: "session" });

    clientA.send({
      type: "session.create",
      requestId: "req-1",
      params: { cwd: "/repo" },
    });

    const res = await clientA.waitFor((msg) => msg.type === "res" && msg.requestId === "req-1");
    const payload = (res.payload ?? {}) as { sessionId?: string };
    const sessionId = String(payload.sessionId);

    const eventMsg: SessionEventMessage = {
      type: "session.event",
      sessionId,
      event: { type: "message_start" },
      seq: 1,
    };
    fakeHost.emit("session.event", eventMsg);

    await clientA.waitFor((msg) => msg.type === "session.event" && msg.sessionId === sessionId);

    await Bun.sleep(100);
    const bEvents = clientB
      .getMessages()
      .filter((msg) => msg.type === "session.event" && msg.sessionId === sessionId);
    expect(bEvents).toHaveLength(0);

    expect(saveCalls.length).toBe(1);

    clientA.close();
    clientB.close();
  });

  it("restores persisted sessions on startup", async () => {
    if (serverCtx) {
      await serverCtx.stop();
    }

    const fakeHost = new FakeSessionHost();
    const resumeCalls: Array<{ sessionId: string; cwd: string; model?: string }> = [];

    // Mock resume to track calls
    const originalResume = fakeHost.resume;
    fakeHost.resume = async (params: { sessionId: string; cwd: string; model?: string }) => {
      resumeCalls.push({ sessionId: params.sessionId, cwd: params.cwd, model: params.model });
      return originalResume.call(fakeHost, params);
    };

    const persistedSessions = [
      {
        id: "session-1",
        cwd: "/workspace/project-a",
        model: "claude-sonnet-4-5",
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
      },
      {
        id: "session-2",
        cwd: "/workspace/project-b",
        model: "claude-opus-4-6",
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
      },
    ];

    serverCtx = await createAgentHostServer({
      port: await getFreePort(),
      sessionHost: fakeHost,
      loadConfig: () => fakeConfig,
      loadState: () => ({
        updatedAt: new Date().toISOString(),
        sessions: persistedSessions,
      }),
      saveState: () => {},
      stateSaveIntervalMs: null,
    });

    // Verify that resume was called for each persisted session
    expect(resumeCalls).toHaveLength(2);
    expect(resumeCalls[0]).toEqual({
      sessionId: "session-1",
      cwd: "/workspace/project-a",
      model: "claude-sonnet-4-5",
    });
    expect(resumeCalls[1]).toEqual({
      sessionId: "session-2",
      cwd: "/workspace/project-b",
      model: "claude-opus-4-6",
    });

    // Verify sessions are active
    const sessions = fakeHost.list();
    expect(sessions).toHaveLength(2);
  });

  it("routes task lifecycle and broadcasts task events to subscribed clients", async () => {
    if (serverCtx) {
      await serverCtx.stop();
    }

    const fakeHost = new FakeSessionHost();
    const fakeTaskHost = new FakeTaskHost();

    serverCtx = await createAgentHostServer({
      port: await getFreePort(),
      sessionHost: fakeHost,
      taskHost: fakeTaskHost,
      loadConfig: () => fakeConfig,
      loadState: () => ({ updatedAt: new Date().toISOString(), sessions: [] }),
      saveState: () => {},
      stateSaveIntervalMs: null,
    });

    const client = new WsClient(`ws://127.0.0.1:${serverCtx.port}/ws`);
    await client.waitOpen();
    client.send({ type: "auth", extensionId: "session" });

    client.send({
      type: "task.start",
      requestId: "task-start-1",
      params: {
        sessionId: "s-test",
        agent: "codex",
        prompt: "hello",
      },
    });

    const startRes = await client.waitFor(
      (msg) => msg.type === "res" && msg.requestId === "task-start-1",
    );
    const startedTaskId = String(((startRes.payload ?? {}) as { taskId?: string }).taskId || "");
    expect(startedTaskId).toBe("t1");

    const taskEvent: TaskEventMessage = {
      type: "task.event",
      taskId: startedTaskId,
      event: { type: "delta", text: "working" },
      seq: 1,
    };
    fakeTaskHost.emit("task.event", taskEvent);

    await client.waitFor(
      (msg) =>
        msg.type === "task.event" &&
        msg.taskId === startedTaskId &&
        (msg.event as { type?: string } | undefined)?.type === "delta",
    );

    client.send({
      type: "task.interrupt",
      requestId: "task-stop-1",
      taskId: startedTaskId,
    });
    const stopRes = await client.waitFor(
      (msg) => msg.type === "res" && msg.requestId === "task-stop-1",
    );
    expect(stopRes.ok).toBe(true);

    client.close();
  });
});
