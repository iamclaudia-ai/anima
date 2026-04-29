import { randomUUID } from "node:crypto";
import { listSubagentSessions } from "../session-store";
import type { StoredSession } from "../session-store";
import { getWorkspace } from "../workspace";
import type { AgentHostSessionInfo, RequestContext } from "../session-types";
import { getRuntime } from "../runtime";

export type SubagentStatus = "running" | "completed" | "failed" | "interrupted";
export type SubagentPurpose = "subagent" | "review" | "test";

export interface SessionSubagent {
  subagentId: string;
  parentSessionId: string;
  agent: string;
  cwd?: string;
  prompt: string;
  purpose: SubagentPurpose;
  status: SubagentStatus;
  startedAt: string;
  updatedAt: string;
  error?: string;
  context: {
    connectionId: string | null;
    tags: string[] | null;
  };
}

export function normalizeSubagentPurpose(input?: string): SubagentPurpose {
  if (input === "review" || input === "test") return input;
  return "subagent";
}

function toSubagentStatus(input: string | undefined): SubagentStatus {
  if (input === "completed" || input === "failed" || input === "interrupted") return input;
  return "running";
}

export function toSessionSubagentFromStored(stored: StoredSession | null): SessionSubagent | null {
  if (!stored || !stored.parentSessionId) return null;
  const metadata = stored.metadata || {};
  const purpose =
    stored.purpose === "review" || stored.purpose === "test" ? stored.purpose : "subagent";
  return {
    subagentId: stored.id,
    parentSessionId: stored.parentSessionId,
    agent: stored.agent,
    cwd: typeof metadata.cwd === "string" ? metadata.cwd : undefined,
    prompt: typeof metadata.prompt === "string" ? metadata.prompt : "",
    purpose,
    status: toSubagentStatus(stored.runtimeStatus),
    startedAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    error: typeof metadata.error === "string" ? metadata.error : undefined,
    context: {
      connectionId: typeof metadata.connectionId === "string" ? metadata.connectionId : null,
      tags: Array.isArray(metadata.tags) ? (metadata.tags as string[]) : null,
    },
  };
}

export async function spawnSubagent(
  params: {
    parentSessionId: string;
    agent?: string;
    prompt: string;
    purpose: SubagentPurpose;
    cwd?: string;
    model?: string;
    systemPrompt?: string;
    thinking?: boolean;
    effort?: string;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    metadata?: Record<string, unknown>;
  },
  request: { connectionId: string | null; tags: string[] | null },
): Promise<Record<string, unknown>> {
  const rt = getRuntime();
  const parentSession = rt.registry.getStoredSession(params.parentSessionId);
  const agent = params.agent || parentSession?.agent || "claude";

  let effectiveCwd = params.cwd;
  if (!effectiveCwd && parentSession?.workspaceId) {
    const workspace = getWorkspace(parentSession.workspaceId);
    effectiveCwd = workspace?.cwd;
  }
  if (!effectiveCwd) {
    const activeSessions = (await rt.bridge.listSessions()) as AgentHostSessionInfo[];
    effectiveCwd = activeSessions.find((s) => s.id === params.parentSessionId)?.cwd;
  }
  if (!effectiveCwd) {
    throw new Error(`Unable to resolve cwd for parent session ${params.parentSessionId}`);
  }

  const nowIso = new Date().toISOString();
  const workspaceId =
    parentSession?.workspaceId || rt.registry.getOrCreateWorkspace(effectiveCwd).workspace.id;
  const subagentId = randomUUID();
  const model = params.model || parentSession?.model || rt.sessionConfig.model;
  const subagent: SessionSubagent = {
    subagentId,
    parentSessionId: params.parentSessionId,
    agent,
    cwd: effectiveCwd,
    prompt: params.prompt,
    purpose: params.purpose,
    status: "running",
    startedAt: nowIso,
    updatedAt: nowIso,
    context: {
      connectionId: request.connectionId,
      tags: request.tags,
    },
  };

  rt.subagents.set(subagentId, subagent);
  rt.subagentNotificationsSent.delete(subagentId);
  rt.sessionActors.bindPromptRequest(
    subagentId,
    {
      connectionId: request.connectionId,
      tags: request.tags,
      source: "gateway.caller",
      responseText: "",
    } satisfies RequestContext,
    { streaming: true },
  );

  rt.registry.upsertSession({
    id: subagentId,
    workspaceId,
    providerSessionId: subagentId,
    model,
    agent,
    purpose: params.purpose,
    parentSessionId: params.parentSessionId,
    runtimeStatus: "running",
    metadata: {
      ...(params.metadata || {}),
      prompt: params.prompt,
      cwd: effectiveCwd,
      connectionId: subagent.context.connectionId,
      tags: subagent.context.tags,
      bootstrapSystemPrompt: params.systemPrompt,
      bootstrapThinking: params.thinking,
      bootstrapEffort: params.effort,
    },
    lastActivity: nowIso,
  });

  let result: { status?: string; message?: string };
  try {
    result = await rt.bridge.spawnSubagent({
      parentSessionId: params.parentSessionId,
      subagentId,
      agent,
      prompt: params.prompt,
      cwd: effectiveCwd,
      model,
      systemPrompt: params.systemPrompt,
      thinking: params.thinking,
      effort: params.effort,
      sandbox: params.sandbox,
      metadata: params.metadata,
    });
  } catch (error) {
    const failedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    subagent.status = "failed";
    subagent.error = message;
    subagent.updatedAt = failedAt;
    rt.registry.upsertSession({
      id: subagentId,
      workspaceId,
      providerSessionId: subagentId,
      model,
      agent,
      purpose: params.purpose,
      parentSessionId: params.parentSessionId,
      runtimeStatus: "failed",
      metadata: {
        ...(params.metadata || {}),
        prompt: params.prompt,
        cwd: effectiveCwd,
        connectionId: subagent.context.connectionId,
        tags: subagent.context.tags,
        bootstrapSystemPrompt: params.systemPrompt,
        bootstrapThinking: params.thinking,
        bootstrapEffort: params.effort,
        error: message,
      },
      lastActivity: failedAt,
    });
    throw error;
  }

  return {
    subagentId,
    sessionId: subagentId,
    parentSessionId: params.parentSessionId,
    agent,
    purpose: params.purpose,
    status: result.status || "running",
    cwd: effectiveCwd,
    message: result.message || `Spawned ${agent} subagent`,
  };
}

export function getSubagent(subagentId: string): SessionSubagent | null {
  const rt = getRuntime();
  return (
    rt.subagents.get(subagentId) ||
    toSessionSubagentFromStored(rt.registry.getStoredSession(subagentId))
  );
}

export async function listSubagents(params: {
  parentSessionId?: string;
  status?: SubagentStatus;
  agent?: string;
}): Promise<{ subagents: SessionSubagent[] }> {
  const rt = getRuntime();
  const stored = listSubagentSessions({
    parentSessionId: params.parentSessionId,
    status: params.status,
    agent: params.agent,
  })
    .map((row) => toSessionSubagentFromStored(row))
    .filter((row): row is SessionSubagent => !!row);

  const merged = new Map<string, SessionSubagent>();
  for (const subagent of stored) merged.set(subagent.subagentId, subagent);
  for (const subagent of rt.subagents.values()) {
    if (params.parentSessionId && subagent.parentSessionId !== params.parentSessionId) continue;
    if (params.status && subagent.status !== params.status) continue;
    if (params.agent && subagent.agent !== params.agent) continue;
    merged.set(subagent.subagentId, subagent);
  }
  return { subagents: Array.from(merged.values()) };
}
