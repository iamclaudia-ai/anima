/**
 * Session creation, shared by `session.create_session` (an empty draft the UI
 * fills in) and `session.spawn_agent` with `parentSessionId: "NEW"` (a
 * top-level session created, named, and prompted in one call — what an
 * unattended caller like a scheduled task needs).
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger, shortId } from "@anima/shared";
import { getRuntime } from "../runtime";
import { emitListChanged } from "../session-status-events";

const log = createLogger("SessionExt:Create", join(homedir(), ".anima", "logs", "session.log"));

/** `spawn_agent` parent value that means "no parent: start a top-level session". */
export const NEW_SESSION_PARENT = "NEW";

type Effort = "low" | "medium" | "high" | "max";

export interface DraftSessionParams {
  cwd: string;
  agent?: string;
  model?: string;
  systemPrompt?: string;
  thinking?: boolean;
  effort?: Effort;
}

/**
 * Register a top-level chat session for `cwd` and make it the workspace's
 * active one. Nothing runs yet: the first prompt bootstraps the runtime from
 * the settings stored here.
 */
export function createDraftSession(params: DraftSessionParams): {
  sessionId: string;
  workspaceId: string;
  agent: string;
  model: string;
} {
  const rt = getRuntime();
  const agent = params.agent || "claude";
  const model = params.model || rt.sessionConfig.model;
  const thinking = params.thinking ?? rt.sessionConfig.thinking;
  const effort = params.effort || rt.sessionConfig.effort;
  const systemPrompt = params.systemPrompt || rt.sessionConfig.systemPrompt || undefined;

  log.info("Creating session", { agent, cwd: params.cwd, model, thinking, effort });
  const workspaceResult = rt.registry.getOrCreateWorkspace(params.cwd);
  const workspaceId = workspaceResult.workspace.id;
  const sessionId = randomUUID();
  rt.registry.upsertSession({
    id: sessionId,
    workspaceId,
    providerSessionId: sessionId,
    model,
    agent,
    purpose: "chat",
    runtimeStatus: "idle",
    metadata: {
      bootstrapSystemPrompt: systemPrompt,
      bootstrapThinking: thinking,
      bootstrapEffort: effort,
    },
  });
  rt.registry.setWorkspaceActiveSession(workspaceId, sessionId);
  // The other tabs have no idea this row appeared. `send_prompt` emits the
  // same event for a session created implicitly by a first prompt; this is
  // the explicit path, and it's the one the New Session button takes.
  emitListChanged(workspaceId, "session_created");
  log.info("Session draft created", { sessionId: shortId(sessionId), cwd: params.cwd });
  return { sessionId, workspaceId, agent, model };
}

export interface TopLevelSessionParams extends Omit<DraftSessionParams, "cwd"> {
  cwd?: string;
  prompt: string;
  name?: string;
}

export interface TopLevelSessionDeps {
  createDraft: (params: DraftSessionParams) => { sessionId: string; agent: string; model: string };
  setTitle: (sessionId: string, title: string) => void;
  sendPrompt: (params: {
    sessionId: string;
    content: string;
    cwd: string;
    model: string;
    agent: string;
  }) => Promise<unknown>;
}

/**
 * Create a top-level session, name it, and send its first prompt.
 *
 * The title is stored before the prompt goes out, so the session never shows
 * up in the nav under its first-prompt fallback, not even for one refresh.
 */
export async function startTopLevelSession(
  params: TopLevelSessionParams,
  deps: TopLevelSessionDeps,
): Promise<{
  sessionId: string;
  parentSessionId: null;
  agent: string;
  cwd: string;
  title: string | null;
  status: "running";
}> {
  const cwd = params.cwd;
  if (!cwd) {
    throw new Error(`cwd is required when parentSessionId is "${NEW_SESSION_PARENT}"`);
  }

  const draft = deps.createDraft({
    cwd,
    agent: params.agent,
    model: params.model,
    systemPrompt: params.systemPrompt,
    thinking: params.thinking,
    effort: params.effort,
  });

  const title = params.name?.trim() || null;
  if (title) deps.setTitle(draft.sessionId, title);

  await deps.sendPrompt({
    sessionId: draft.sessionId,
    content: params.prompt,
    cwd,
    model: draft.model,
    agent: draft.agent,
  });

  return {
    sessionId: draft.sessionId,
    parentSessionId: null,
    agent: draft.agent,
    cwd,
    title,
    status: "running",
  };
}
