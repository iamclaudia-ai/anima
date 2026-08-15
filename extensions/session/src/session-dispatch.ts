import { randomUUID } from "node:crypto";
import { createLogger, shortId, formatElapsed } from "@anima/shared";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readdirSync, statSync } from "node:fs";
import type { ExtensionContext } from "@anima/shared";
import { rotatePersistentSessions } from "./persistent-sessions";
import { listCommands } from "./commands-discovery";
import { listFiles } from "./file-discovery";
import {
  getSubagent,
  listSubagents,
  normalizeSubagentPurpose,
  spawnSubagent,
  type SubagentStatus,
} from "./lifecycle/subagent-workflow";
import { sendSessionNotification } from "./lifecycle/subagent-events";
import { listSessions, getHistory, getMemoryContext } from "./lifecycle/session-query";
import { emitGitStatus } from "./lifecycle/session-events";
import { dropGitStatusDebounce } from "./lifecycle/git-status-debouncer";
import { switchSession, resetSession } from "./lifecycle/session-activation";
import { runPromptLifecycle } from "./lifecycle/prompt-lifecycle";
import type { AgentHostSessionInfo } from "./session-types";
import type { HealthCheckResponse } from "@anima/shared";
import { getRuntime } from "./runtime";
import { backfillSessionRefs } from "./session-ref-sync";
import { resolveRefsConfig } from "./session-reconciler";
import {
  getStoredSession,
  listAttentionSessions,
  resolveStaleCompleted,
  setSessionSnooze,
  setSessionTitle,
  type SessionDisposition,
} from "./session-store";
import { applyDisposition, emitListChanged, emitStatusChanged } from "./session-status-events";
import { searchSessions } from "./session-search";

const log = createLogger("SessionExt:Dispatch", join(homedir(), ".anima", "logs", "session.log"));

export type SessionMethodHandler = (
  params: Record<string, unknown>,
  ctx: ExtensionContext,
) => Promise<unknown> | unknown;

function getDirectories(path: string): string[] {
  try {
    const expandedPath = path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
    if (!existsSync(expandedPath)) return [];
    const stat = statSync(expandedPath);
    if (!stat.isDirectory()) return [];
    const entries = readdirSync(expandedPath, { withFileTypes: true });
    // Include dot-folders — many real dev workspaces live in them
    // (~/.hammerspoon, ~/.config/*, ~/.claude/*, etc.). Sort dot-folders
    // after regular folders for readability.
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => {
        const aHidden = a.startsWith(".");
        const bHidden = b.startsWith(".");
        if (aHidden !== bHidden) return aHidden ? 1 : -1;
        return a.localeCompare(b);
      });
  } catch (error) {
    log.warn("Failed to read directories", { path, error: String(error) });
    return [];
  }
}

async function healthCheckDetailed(): Promise<HealthCheckResponse> {
  const rt = getRuntime();
  if (!rt.bridge.isConnected) {
    return {
      ok: false,
      status: "degraded",
      label: "Sessions",
      metrics: [{ label: "Agent Host", value: "disconnected" }],
      actions: [],
      items: [],
    };
  }

  let sessions: AgentHostSessionInfo[] = [];
  try {
    sessions = (await rt.bridge.listSessions()) as AgentHostSessionInfo[];
  } catch {
    return {
      ok: false,
      status: "degraded",
      label: "Sessions",
      metrics: [
        { label: "Agent Host", value: "connected" },
        { label: "Sessions", value: "unavailable" },
      ],
      actions: [],
      items: [],
    };
  }

  const visible = sessions.filter((s) => s.isProcessRunning);
  return {
    ok: true,
    status: "healthy",
    label: "Sessions",
    metrics: [
      { label: "Agent Host", value: "connected" },
      { label: "Active Sessions", value: visible.filter((s) => s.isActive).length },
      { label: "Running SDK", value: visible.length },
      { label: "Stale", value: visible.filter((s) => s.stale).length },
    ],
    actions: [],
    items: [...visible]
      .sort((a, b) => {
        const aTs = Date.parse(a.lastActivity || "");
        const bTs = Date.parse(b.lastActivity || "");
        return (Number.isFinite(bTs) ? bTs : 0) - (Number.isFinite(aTs) ? aTs : 0);
      })
      .map((s) => ({
        id: s.id,
        label: s.cwd || s.id,
        status: !s.isActive ? "inactive" : s.stale ? "stale" : "healthy",
        details: {
          model: s.model || "unknown",
          running: s.isProcessRunning ? "yes" : "no",
          lastActivity: s.lastActivity || "n/a",
          lastActivityAgo: formatElapsed(Date.now() - Date.parse(s.lastActivity)),
        },
      })),
  };
}

/**
 * Workspaces kept out of the ACTIVE queue, from `anima.json`:
 *
 *   "session": { "config": { "activeQueue": { "excludeWorkspaces": ["libby"] } } }
 *
 * Config rather than a hardcoded list, for the same reason the Linear ref
 * prefixes are: which workspaces are machinery is a fact about Michael's
 * setup, not about Anima. Matched case-insensitively against a workspace's
 * name or its cwd.
 */
function resolveQueueExclusions(): string[] {
  const queue = getRuntime().config?.activeQueue as { excludeWorkspaces?: unknown } | undefined;
  const raw = queue?.excludeWorkspaces;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

export function createSessionReadHandlers(): Record<string, SessionMethodHandler> {
  return {
    "session.list_sessions": async (params) =>
      listSessions(params.cwd as string, {
        limit: params.limit as number | undefined,
        offset: params.offset as number | undefined,
      }),
    "session.get_history": async (params) => {
      const result = getHistory({
        sessionId: params.sessionId as string,
        cwd: params.cwd as string | undefined,
        limit: params.limit as number | undefined,
        offset: params.offset as number | undefined,
      });
      // Fire a fresh git-status pass async so the UI updates from cached → live
      // even on older sessions that haven't had a turn since the cache landed.
      // Only on initial load (offset 0) — pagination shouldn't re-fetch.
      if (!params.offset || params.offset === 0) {
        void emitGitStatus(params.sessionId as string);
      }
      return result;
    },
    "session.get_info": async (params) => {
      const rt = getRuntime();
      const sessionId = params.sessionId as string | undefined;
      const activeSessions = (await rt.bridge.listSessions()) as Array<{ id: string }>;
      if (sessionId) {
        const session = activeSessions.find((entry) => entry.id === sessionId);
        return { session: session || null, activeSessions };
      }
      return { activeSessions };
    },
    "session.get_subagent": async (params) => {
      const subagent = getSubagent(params.subagentId as string);
      return { subagent };
    },
    "session.list_subagents": async (params) =>
      listSubagents({
        parentSessionId: params.parentSessionId as string | undefined,
        status: params.status as SubagentStatus | undefined,
        agent: params.agent as string | undefined,
      }),
    "session.list_workspaces": async () => {
      const rt = getRuntime();
      return { workspaces: rt.registry.listWorkspaces() };
    },
    "session.get_workspace": async (params) => {
      const rt = getRuntime();
      return { workspace: rt.registry.getWorkspace(params.id as string) };
    },
    "session.get_directories": async (params) => {
      const path = (params.path as string | undefined) || "~";
      return { path, directories: getDirectories(path) };
    },
    "session.list_commands": async (params) =>
      listCommands({ cwd: params.cwd as string | undefined }),
    "session.list_files": async (params) => listFiles({ cwd: params.cwd as string }),
    "session.list_attention": async (params) => ({
      sessions: listAttentionSessions({
        includeSessionId: params.currentSessionId as string | undefined,
        limit: params.limit as number | undefined,
        excludeWorkspaces: resolveQueueExclusions(),
      }),
    }),
    "session.health_check": async () => healthCheckDetailed(),
    "session.rotate_persistent_sessions": async () => {
      const rt = getRuntime();
      const rotationConfig = (rt.config.persistentSessionRotation as {
        maxMessages?: number;
        maxAgeHours?: number;
      }) || { maxMessages: 200, maxAgeHours: 24 };
      const maxMessages = rotationConfig.maxMessages ?? 200;
      const maxAgeHours = rotationConfig.maxAgeHours ?? 24;
      return rotatePersistentSessions({
        store: {
          getEntries: () =>
            rt.ctx.store.get<
              Record<string, { sessionId: string; messageCount: number; createdAt: string }>
            >("persistentSessions") || {},
          setEntries: (entries) => {
            rt.ctx.store.set("persistentSessions", entries);
          },
        },
        maxMessages,
        maxAgeHours,
        log,
        formatSessionId: shortId,
      });
    },
    "session.get_memory_context": async (params) =>
      getMemoryContext(params.cwd as string | undefined),
    "session.search": async (params) =>
      searchSessions((method, args) => getRuntime().ctx.call(method, args), {
        query: params.query as string,
        cwd: params.cwd as string | undefined,
        ref: params.ref as string | undefined,
        disposition: params.disposition as SessionDisposition[] | undefined,
        limit: params.limit as number | undefined,
      }),
  };
}

export function createSessionWriteHandlers(): Record<string, SessionMethodHandler> {
  return {
    "session.set_title": async (params) => {
      const sessionId = params.sessionId as string;
      const title = params.title as string | null;
      if (!setSessionTitle(sessionId, title)) {
        throw new Error(`Unknown session: ${sessionId}`);
      }
      log.info("Session renamed", { sessionId: sessionId.slice(0, 8), cleared: !title?.trim() });
      return { sessionId, title: title?.trim() || null };
    },
    "session.resolve_stale": async (params) => {
      const result = resolveStaleCompleted({
        olderThanDays: (params.olderThanDays as number | undefined) ?? 5,
        dryRun: params.dryRun as boolean | undefined,
      });
      if (result.resolved > 0) {
        // One event, not one per row: the banner and the nav both just refetch,
        // and a few thousand status events would be a self-inflicted flood.
        for (const workspaceId of new Set(
          result.sessions
            .map((s) => getStoredSession(s.sessionId)?.workspaceId)
            .filter((id): id is string => Boolean(id)),
        )) {
          emitListChanged(workspaceId, "disposition_changed");
        }
      }
      log.info("Resolved stale sessions", {
        matched: result.matched,
        resolved: result.resolved,
        dryRun: Boolean(params.dryRun),
      });
      return { matched: result.matched, resolved: result.resolved };
    },
    "session.snooze": async (params) => {
      const sessionId = params.sessionId as string;
      const clear = params.clear as boolean | undefined;
      const minutes = (params.minutes as number | undefined) ?? 30;
      const until = clear ? null : new Date(Date.now() + minutes * 60_000).toISOString();
      if (!setSessionSnooze(sessionId, until)) {
        throw new Error(`Unknown session: ${sessionId}`);
      }
      // Snoozing changes what the attention list contains, and the banner is
      // driven by that list — so this has to announce itself, or the banner
      // Michael just silenced stays up until something else moves. Extending
      // an existing snooze isn't a disposition change, hence the fallback.
      if (!applyDisposition(sessionId, clear ? "open" : "snoozed")) {
        emitStatusChanged(sessionId);
      }
      log.info("Session snoozed", { sessionId: shortId(sessionId), until });
      return { sessionId, snoozedUntil: until };
    },
    "session.set_status": async (params) => {
      const sessionId = params.sessionId as string;
      const disposition = params.disposition as SessionDisposition;
      if (!getStoredSession(sessionId)) {
        throw new Error(`Unknown session: ${sessionId}`);
      }
      // A no-op returns cleanly rather than throwing: setting a session to the
      // disposition it already has is a successful outcome, and two tabs
      // racing on the same menu item shouldn't produce an error in one.
      const changed = applyDisposition(sessionId, disposition);
      return { sessionId, disposition, changed };
    },
    "session.backfill_refs": async (params) =>
      backfillSessionRefs(resolveRefsConfig, {
        days: params.days as number | undefined,
        rescan: params.rescan as boolean | undefined,
        dryRun: params.dryRun as boolean | undefined,
      }),
    "session.create_session": async (params) => {
      const rt = getRuntime();
      const cwd = params.cwd as string;
      const agent = (params.agent as string | undefined) || "claude";
      const model = (params.model as string | undefined) || rt.sessionConfig.model;
      const thinking = (params.thinking as boolean | undefined) ?? rt.sessionConfig.thinking;
      const effort =
        (params.effort as "low" | "medium" | "high" | "max" | undefined) || rt.sessionConfig.effort;
      const systemPrompt =
        (params.systemPrompt as string | undefined) || rt.sessionConfig.systemPrompt || undefined;

      log.info("Creating session", { agent, cwd, model, thinking, effort });
      const workspaceResult = rt.registry.getOrCreateWorkspace(cwd);
      const sessionId = randomUUID();
      rt.registry.upsertSession({
        id: sessionId,
        workspaceId: workspaceResult.workspace.id,
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
      rt.registry.setWorkspaceActiveSession(workspaceResult.workspace.id, sessionId);
      // The other tabs have no idea this row appeared. `send_prompt` emits the
      // same event for a session created implicitly by a first prompt; this is
      // the explicit path, and it's the one the New Session button takes.
      emitListChanged(workspaceResult.workspace.id, "session_created");
      log.info("Session draft created", { sessionId: shortId(sessionId), cwd });
      return { sessionId };
    },
    "session.send_prompt": async (params) => {
      const rt = getRuntime();
      return await runPromptLifecycle(
        {
          sessionId: params.sessionId as string,
          content: params.content as string | unknown[],
          cwd: params.cwd as string | undefined,
          model: params.model as string | undefined,
          agent: (params.agent as string | undefined) || "claude",
          streaming: params.streaming !== false,
          source: params.source as string | undefined,
        },
        {
          connectionId: rt.ctx.connectionId,
          tags: rt.ctx.tags,
        },
      );
    },
    "session.interrupt_session": async (params) => {
      const rt = getRuntime();
      log.info("Interrupting session", { sessionId: shortId(params.sessionId as string) });
      const ok = await rt.bridge.interruptSession(params.sessionId as string);
      return { ok };
    },
    "session.close_session": async (params) => {
      const rt = getRuntime();
      log.info("Closing session", { sessionId: shortId(params.sessionId as string) });
      await rt.bridge.closeSession(params.sessionId as string);
      rt.sessionActors.clearSession(params.sessionId as string);
      rt.registry.archiveSession(params.sessionId as string);
      dropGitStatusDebounce(params.sessionId as string);
      log.info("Session closed", { sessionId: shortId(params.sessionId as string) });
      return { ok: true };
    },
    "session.switch_session": async (params) =>
      switchSession({
        sessionId: params.sessionId as string,
        cwd: params.cwd as string,
        model: params.model as string | undefined,
      }),
    "session.reset_session": async (params) =>
      resetSession({
        cwd: params.cwd as string,
        model: params.model as string | undefined,
      }),
    "session.set_permission_mode": async (params) => {
      const rt = getRuntime();
      log.info("Setting permission mode", {
        sessionId: shortId(params.sessionId as string),
        mode: params.mode,
      });
      const ok = await rt.bridge.setPermissionMode(
        params.sessionId as string,
        params.mode as string,
      );
      return { ok };
    },
    "session.send_tool_result": async (params) => {
      const rt = getRuntime();
      log.info("Sending tool result", {
        sessionId: shortId(params.sessionId as string),
        toolUseId: params.toolUseId,
        isError: params.isError,
      });
      const ok = await rt.bridge.sendToolResult(
        params.sessionId as string,
        params.toolUseId as string,
        params.content as string,
        params.isError as boolean,
      );
      return { ok };
    },
    "session.spawn_agent": async (params) => {
      const rt = getRuntime();
      return await spawnSubagent(
        {
          parentSessionId: params.parentSessionId as string,
          agent: params.agent as string | undefined,
          prompt: params.prompt as string,
          purpose: normalizeSubagentPurpose(params.purpose as string | undefined),
          cwd: params.cwd as string | undefined,
          model: params.model as string | undefined,
          systemPrompt: params.systemPrompt as string | undefined,
          thinking: params.thinking as boolean | undefined,
          effort: params.effort as string | undefined,
          sandbox: params.sandbox as "read-only" | "workspace-write" | "danger-full-access",
          metadata: params.metadata as Record<string, unknown> | undefined,
        },
        {
          connectionId: rt.ctx.connectionId,
          tags: rt.ctx.tags,
        },
      );
    },
    "session.interrupt_subagent": async (params) => {
      const rt = getRuntime();
      const subagentId = params.subagentId as string;
      const ok = await rt.bridge.interruptSession(subagentId);
      return { ok, subagentId };
    },
    "session.send_notification": async (params) => {
      const rt = getRuntime();
      const sessionId = params.sessionId as string;
      const text = params.text as string;

      log.info("Sending notification", {
        sessionId: shortId(sessionId),
        content: { kind: "text", chars: text.length },
      });

      await sendSessionNotification(sessionId, text, {
        connectionId: rt.ctx.connectionId,
        tags: rt.ctx.tags,
      });

      return { ok: true, sessionId };
    },
    "session.get_or_create_workspace": async (params) => {
      const rt = getRuntime();
      const cwd = params.cwd as string;
      const result = rt.registry.getOrCreateWorkspace(
        cwd,
        params.name as string | undefined,
        params.general as boolean | undefined,
      );
      log.info("Get/create workspace", {
        cwd,
        created: result.created,
        general: result.workspace.general,
      });
      return result;
    },
    "session.delete_workspace": async (params) => {
      const rt = getRuntime();
      return { deleted: rt.registry.deleteWorkspace(params.cwd as string) };
    },
    "session.set_workspace_pinned": async (params) => {
      const rt = getRuntime();
      const workspace = rt.registry.setWorkspacePinned(
        params.id as string,
        params.pinned as boolean,
      );
      return { workspace };
    },
  };
}

export function createSessionMethodHandlers(): Record<string, SessionMethodHandler> {
  return {
    ...createSessionReadHandlers(),
    ...createSessionWriteHandlers(),
  };
}

export async function dispatchMethod(
  method: string,
  params: Record<string, unknown>,
  ctx: ExtensionContext,
): Promise<unknown> {
  const handler = createSessionMethodHandlers()[method];
  if (!handler) {
    throw new Error(`Unknown method: ${method}`);
  }
  return await handler(params, ctx);
}
