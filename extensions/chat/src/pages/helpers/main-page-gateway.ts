import type { SessionInfo } from "@anima/ui";

export type GatewayCaller = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

export interface ListSessionsResult {
  sessions: SessionInfo[];
  total: number;
  hasMore: boolean;
}

/**
 * Fetch sessions for a workspace. When `limit` is omitted, returns all
 * sessions (legacy behavior). With `limit`/`offset` set, the server
 * paginates and `hasMore` reflects whether further pages remain.
 */
export async function loadSessionsForWorkspace(
  callGateway: GatewayCaller,
  cwd: string,
  options?: { limit?: number; offset?: number },
): Promise<ListSessionsResult> {
  const payload = (await callGateway("session.list_sessions", {
    cwd,
    ...(options?.limit !== undefined ? { limit: options.limit } : {}),
    ...(options?.offset !== undefined ? { offset: options.offset } : {}),
  })) as { sessions?: SessionInfo[]; total?: number; hasMore?: boolean } | null;
  const sessions = payload?.sessions ?? [];
  return {
    sessions,
    total: payload?.total ?? sessions.length,
    hasMore: payload?.hasMore ?? false,
  };
}

export async function createSessionForWorkspace(
  callGateway: GatewayCaller,
  cwd: string,
): Promise<string | null> {
  const payload = (await callGateway("session.create_session", { cwd })) as {
    sessionId?: string;
  } | null;
  return payload?.sessionId ?? null;
}
