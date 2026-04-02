import type { AgentHostSessionInfo } from "./session-types";
import type { AgentHostClient } from "./agent-client";

type SessionEventListener = (event: any) => void;
type TaskEventListener = (event: any) => void;

export class SessionAgentBridge {
  constructor(private readonly client: AgentHostClient) {}

  get isConnected(): boolean {
    return this.client.isConnected;
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  disconnect(): void {
    this.client.disconnect();
  }

  async listSessions(): Promise<AgentHostSessionInfo[]> {
    return (await this.client.list()) as AgentHostSessionInfo[];
  }

  async createSession(params: {
    sessionId?: string;
    cwd: string;
    model?: string;
    systemPrompt?: string;
    thinking?: boolean;
    effort?: string;
    agent?: string;
  }): Promise<{ sessionId: string }> {
    return await this.client.createSession(params);
  }

  async prompt(
    sessionId: string,
    content: string | unknown[],
    cwd?: string,
    model?: string,
    agent?: string,
  ): Promise<void> {
    if (agent === undefined) {
      await this.client.prompt(sessionId, content, cwd, model);
      return;
    }
    await this.client.prompt(sessionId, content, cwd, model, agent);
  }

  async interruptSession(sessionId: string): Promise<boolean> {
    return await this.client.interrupt(sessionId);
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.client.close(sessionId);
  }

  async setPermissionMode(sessionId: string, mode: string): Promise<boolean> {
    return await this.client.setPermissionMode(sessionId, mode);
  }

  async sendToolResult(
    sessionId: string,
    toolUseId: string,
    content: string,
    isError = false,
  ): Promise<boolean> {
    return await this.client.sendToolResult(sessionId, toolUseId, content, isError);
  }

  async startTask(params: {
    sessionId: string;
    agent: string;
    prompt: string;
    mode?: "general" | "review" | "test";
    cwd?: string;
    worktree?: boolean;
    continue?: string;
    model?: string;
    effort?: string;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    files?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<{
    taskId: string;
    status: string;
    outputFile?: string;
    message: string;
    cwd?: string;
    worktreePath?: string;
    parentRepoPath?: string;
    continuedFromTaskId?: string;
  }> {
    return await this.client.startTask(params);
  }

  async getTask(taskId: string): Promise<unknown> {
    return await this.client.getTask(taskId);
  }

  async listTasks(filters?: {
    sessionId?: string;
    status?: "running" | "completed" | "failed" | "interrupted";
    agent?: string;
  }): Promise<unknown> {
    return await this.client.listTasks(filters);
  }

  async interruptTask(taskId: string): Promise<boolean> {
    return await this.client.interruptTask(taskId);
  }

  onSessionEvent(listener: SessionEventListener): void {
    this.client.on("session.event", listener);
  }

  offSessionEvent(listener: SessionEventListener): void {
    this.client.removeListener("session.event", listener);
  }

  onTaskEvent(listener: TaskEventListener): void {
    this.client.on("task.event", listener);
  }

  offTaskEvent(listener: TaskEventListener): void {
    this.client.removeListener("task.event", listener);
  }
}
