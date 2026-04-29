import type { AgentHostSessionInfo } from "./session-types";
import type { AgentHostClient } from "./agent-client";

type SessionEventListener = (event: any) => void;

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

  async spawnSubagent(params: {
    parentSessionId: string;
    subagentId?: string;
    agent?: string;
    prompt: string;
    cwd?: string;
    model?: string;
    systemPrompt?: string;
    thinking?: boolean;
    effort?: string;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    metadata?: Record<string, unknown>;
  }): Promise<{
    subagentId: string;
    sessionId: string;
    parentSessionId: string;
    status: string;
    message: string;
  }> {
    return await this.client.spawnSubagent(params);
  }

  onSessionEvent(listener: SessionEventListener): void {
    this.client.on("session.event", listener);
  }

  offSessionEvent(listener: SessionEventListener): void {
    this.client.removeListener("session.event", listener);
  }
}
