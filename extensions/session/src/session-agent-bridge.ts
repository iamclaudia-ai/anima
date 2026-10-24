import type { AgentHostSessionInfo } from "./session-types";
import type { AgentHostClient } from "./agent-client";

type SessionEventListener = (event: any) => void;

/**
 * The session extension's single funnel to agent-host.
 *
 * Every create and prompt carries the session's permission profile, looked up
 * from its row by `profileOf`, so no call site can forget it and a resumed
 * session can't come back with more powers than it was created with.
 */
export class SessionAgentBridge {
  constructor(
    private readonly client: AgentHostClient,
    /** The stored profile for a session, or null when it has no row yet. */
    private readonly profileOf: (sessionId: string) => string | null,
  ) {}

  private requireProfile(sessionId: string): string {
    const profile = this.profileOf(sessionId);
    if (!profile) throw new Error(`No session row (and so no profile) for ${sessionId}`);
    return profile;
  }

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
    /** Explicit profile; otherwise the one stored on `sessionId`'s row. */
    profile?: string;
  }): Promise<{ sessionId: string }> {
    const profile =
      params.profile ?? (params.sessionId ? this.requireProfile(params.sessionId) : undefined);
    if (!profile) throw new Error("createSession needs a profile or an existing sessionId");
    return await this.client.createSession({ ...params, profile });
  }

  async prompt(
    sessionId: string,
    content: string | unknown[],
    cwd?: string,
    model?: string,
    agent?: string,
  ): Promise<void> {
    await this.client.prompt(sessionId, content, cwd, model, agent, this.requireProfile(sessionId));
  }

  async interruptSession(sessionId: string): Promise<boolean> {
    return await this.client.interrupt(sessionId);
  }

  async answerModal(
    sessionId: string,
    key: string,
    fingerprint?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    return await this.client.answerModal(sessionId, key, fingerprint);
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
    profile: string;
  }): Promise<{
    subagentId: string;
    sessionId: string;
    parentSessionId: string;
    status: string;
    message: string;
  }> {
    return await this.client.spawnSubagent(params);
  }

  /** Run `listener` on every successful connect, including reconnects. */
  onConnected(listener: () => void): void {
    this.client.on("connected", listener);
  }

  /** Subscribe to live sessions so their events reach us — see the client. */
  async subscribeSessions(sessionIds: string[]): Promise<void> {
    await this.client.subscribeSessions(sessionIds);
  }

  onSessionEvent(listener: SessionEventListener): void {
    this.client.on("session.event", listener);
  }

  offSessionEvent(listener: SessionEventListener): void {
    this.client.removeListener("session.event", listener);
  }
}
