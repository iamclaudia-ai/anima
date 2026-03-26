import type { SessionIndexEntry } from "../claude-projects";
import type { MemoryContextResult } from "../memory-context";

interface SessionQueryDeps {
  sessionConfig: { model: string };
  log: {
    info: (message: string, data?: Record<string, unknown>) => void;
    warn: (message: string, data?: Record<string, unknown>) => void;
  };
  sid: (sessionId: string) => string;
  getOrCreateWorkspace: (cwd: string) => { workspace: { id: string }; created: boolean };
  listWorkspaceSessions: (workspaceId: string) => SessionIndexEntry[];
  discoverSessions: (cwd: string) => SessionIndexEntry[];
  upsertSession: (params: {
    id: string;
    workspaceId: string;
    providerSessionId: string;
    model: string;
    agent: string;
    purpose: "chat";
    runtimeStatus: "idle";
    metadata?: Record<string, unknown> | null;
    lastActivity?: string;
  }) => void;
  resolveSessionPath: (sessionId: string, cwd?: string) => string | null;
  parseSessionFilePaginated: (
    filepath: string,
    options: { limit: number; offset: number },
  ) => { messages: unknown[]; total: number; hasMore: boolean };
  parseSessionUsage: (filepath: string) => unknown;
  getWorkspaceByCwd: (cwd: string) => { general: boolean } | null;
  getMemoryContext: (
    cwd: string,
    includeAllSummaries: boolean,
  ) => Promise<MemoryContextResult | null>;
  formatMemoryContext: (memory: MemoryContextResult) => string | null;
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
      const workspaceResult = deps.getOrCreateWorkspace(cwd);
      const discovered = deps.discoverSessions(cwd);
      for (const entry of discovered) {
        if (!entry.sessionId) continue;
        deps.upsertSession({
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
            : deps.listWorkspaceSessions(workspaceResult.workspace.id);

      deps.log.info("Listed sessions", { cwd, count: sessions.length });
      return {
        sessions: sessions.sort((a, b) => {
          const aTime = a.modified || a.created || "";
          const bTime = b.modified || b.created || "";
          return bTime.localeCompare(aTime);
        }),
      };
    },

    getHistory: ({ sessionId, cwd, limit, offset }) => {
      const filepath = deps.resolveSessionPath(sessionId, cwd);
      if (!filepath) {
        deps.log.warn("Session file not found", {
          sessionId: deps.sid(sessionId),
          cwd: cwd || "none",
        });
        return { messages: [], total: 0, hasMore: false };
      }

      const result = deps.parseSessionFilePaginated(filepath, {
        limit: limit || 50,
        offset: offset || 0,
      });
      const usage = deps.parseSessionUsage(filepath);

      deps.log.info("Loaded history", {
        sessionId: deps.sid(sessionId),
        total: result.total,
        limit: limit || 50,
        offset: offset || 0,
        hasUsage: !!usage,
      });

      return { ...result, usage };
    },

    getMemoryContext: async (cwd) => {
      const effectiveCwd = cwd || process.cwd();
      const workspace = deps.getWorkspaceByCwd(effectiveCwd);

      try {
        const memoryContext = await deps.getMemoryContext(
          effectiveCwd,
          workspace?.general === true,
        );
        if (!memoryContext) {
          return { formatted: null, raw: null, note: "No memory context available" };
        }

        const formatted = deps.formatMemoryContext(memoryContext);
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
