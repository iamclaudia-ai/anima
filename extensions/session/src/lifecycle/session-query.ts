import { createLogger, shortId } from "@anima/shared";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SessionIndexEntry } from "../claude-projects";
import { discoverSessions } from "../claude-projects";
import type { MemoryContextResult } from "../memory-context";
import { formatMemoryContext } from "../memory-context";
import { resolveSessionPath, parseSessionFilePaginated, parseSessionUsage } from "../parse-session";
import { listWorkspaceSessions, upsertSession } from "../session-store";
import { getOrCreateWorkspace, getWorkspaceByCwd } from "../workspace";
import type { SessionRuntimeConfig } from "../session-types";

const log = createLogger("SessionExt:Query", join(homedir(), ".anima", "logs", "session.log"));

interface SessionQueryDeps {
  sessionConfig: SessionRuntimeConfig;
  getMemoryContext: (
    cwd: string,
    includeAllSummaries: boolean,
  ) => Promise<MemoryContextResult | null>;
}

export interface SessionQueryService {
  listSessions: (cwd: string) => { sessions: SessionIndexEntry[] };
  getHistory: (params: { sessionId: string; cwd?: string; limit?: number; offset?: number }) => {
    messages: unknown[];
    total: number;
    hasMore: boolean;
    usage?: unknown;
  };
  getMemoryContext: (cwd?: string) => Promise<{
    formatted: string | null;
    raw: MemoryContextResult | null;
    formattedLength?: number;
    note?: string;
    error?: string;
  }>;
}

export function createSessionQueryService(deps: SessionQueryDeps): SessionQueryService {
  return {
    listSessions: (cwd) => {
      const workspaceResult = getOrCreateWorkspace(cwd);
      const discovered = discoverSessions(cwd);
      for (const entry of discovered) {
        if (!entry.sessionId) continue;
        upsertSession({
          id: entry.sessionId,
          workspaceId: workspaceResult.workspace.id,
          providerSessionId: entry.sessionId,
          model: deps.sessionConfig.model,
          agent: "claude",
          purpose: "chat",
          runtimeStatus: "idle",
          metadata: {
            messageCount: entry.messageCount,
            firstPrompt: entry.firstPrompt,
            gitBranch: entry.gitBranch,
          },
          lastActivity: entry.modified || entry.created,
        });
      }

      const sessions =
        discovered.length > 0
          ? discovered
          : workspaceResult.created
            ? []
            : listWorkspaceSessions(workspaceResult.workspace.id);

      log.info("Listed sessions", { cwd, count: sessions.length });
      return {
        sessions: sessions.sort((a, b) => {
          const aTime = a.modified || a.created || "";
          const bTime = b.modified || b.created || "";
          return bTime.localeCompare(aTime);
        }),
      };
    },

    getHistory: ({ sessionId, cwd, limit, offset }) => {
      const filepath = resolveSessionPath(sessionId, cwd);
      if (!filepath) {
        log.warn("Session file not found", {
          sessionId: shortId(sessionId),
          cwd: cwd || "none",
        });
        return { messages: [], total: 0, hasMore: false };
      }

      const result = parseSessionFilePaginated(filepath, {
        limit: limit || 50,
        offset: offset || 0,
      });
      const usage = parseSessionUsage(filepath);

      log.info("Loaded history", {
        sessionId: shortId(sessionId),
        total: result.total,
        limit: limit || 50,
        offset: offset || 0,
        hasUsage: !!usage,
      });

      return { ...result, usage };
    },

    getMemoryContext: async (cwd) => {
      const effectiveCwd = cwd || process.cwd();
      const workspace = getWorkspaceByCwd(effectiveCwd);

      try {
        const memoryContext = await deps.getMemoryContext(
          effectiveCwd,
          workspace?.general === true,
        );
        if (!memoryContext) {
          return { formatted: null, raw: null, note: "No memory context available" };
        }

        const formatted = formatMemoryContext(memoryContext);
        return {
          formatted,
          raw: memoryContext,
          formattedLength: formatted?.length || 0,
        };
      } catch (err) {
        return { formatted: null, raw: null, error: String(err) };
      }
    },
  };
}
