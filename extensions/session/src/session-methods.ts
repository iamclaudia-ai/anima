import { z } from "zod";
import type { ExtensionMethodDefinition } from "@anima/shared";

const SpawnAgentSchema = z.object({
  parentSessionId: z.string().describe("Parent session UUID"),
  agent: z.string().optional().describe("Child agent/provider; defaults to the parent agent"),
  prompt: z.string().min(1).describe("Initial child-agent prompt"),
  purpose: z.enum(["subagent", "review", "test"]).optional().default("subagent"),
  cwd: z.string().optional().describe("Working directory override"),
  model: z.string().optional().describe("Model override"),
  systemPrompt: z
    .string()
    .optional()
    .describe("Optional provider-specific system prompt/instructions"),
  thinking: z.boolean().optional().describe("Provider-specific thinking toggle"),
  effort: z.string().optional().describe("Effort/reasoning override"),
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const GetSubagentSchema = z.object({
  subagentId: z.string().describe("Subagent session ID"),
});

const ListSubagentsSchema = z.object({
  parentSessionId: z.string().optional().describe("Filter by parent session ID"),
  status: z.enum(["running", "completed", "failed", "interrupted"]).optional(),
  agent: z.string().optional().describe("Filter by agent/provider"),
});

const InterruptSubagentSchema = z.object({
  subagentId: z.string().describe("Subagent session ID"),
});

export const sessionMethodDefinitions: ExtensionMethodDefinition[] = [
  {
    name: "session.create_session",
    description: "Create a new agent session for a workspace CWD",
    inputSchema: z.object({
      cwd: z.string().describe("Working directory"),
      agent: z.string().optional().describe("Agent/provider (default: claude)"),
      model: z.string().optional().describe("Model to use"),
      systemPrompt: z.string().optional().describe("System prompt"),
      thinking: z.boolean().optional().describe("Enable thinking"),
      effort: z.enum(["low", "medium", "high", "max"]).optional().describe("Thinking effort"),
    }),
    execution: { lane: "write", concurrency: "serial" },
  },
  {
    name: "session.send_prompt",
    description: "Send a prompt to a session (provider-aware, streaming or await completion)",
    inputSchema: z.object({
      sessionId: z.string().describe("Session UUID"),
      content: z.union([z.string(), z.array(z.unknown())]).describe("Prompt content"),
      cwd: z.string().optional().describe("CWD for auto-resume"),
      model: z.string().optional().describe("Model override for auto-resume"),
      agent: z.string().optional().describe("Agent/provider (default: claude)"),
      streaming: z.boolean().optional().default(true).describe("Stream events or await result"),
      source: z.string().optional().describe("Source for routing (e.g. imessage/+1555...)"),
    }),
    execution: { lane: "long_running", concurrency: "keyed", keyParam: "sessionId" },
  },
  {
    name: "session.interrupt_session",
    description: "Interrupt current response",
    inputSchema: z.object({
      sessionId: z.string().describe("Session UUID"),
    }),
    execution: { lane: "write", concurrency: "keyed", keyParam: "sessionId" },
  },
  {
    name: "session.answer_modal",
    description: "Answer a modal prompt the CLI is blocked on by pressing one of its option keys",
    inputSchema: z.object({
      sessionId: z.string().describe("Session UUID"),
      // A string, not a number: this is a keystroke. The options happen to be
      // digits today, but the TUI is free to render a lettered one.
      key: z.string().describe('Option key to press, as rendered ("1", "2", ...)'),
      fingerprint: z
        .string()
        .optional()
        .describe("Fingerprint from the modal_prompt event — rejects answering a stale prompt"),
    }),
    execution: { lane: "write", concurrency: "keyed", keyParam: "sessionId" },
  },
  {
    name: "session.close_session",
    description: "Close a session (kills CLI process via query.close())",
    inputSchema: z.object({
      sessionId: z.string().describe("Session UUID"),
    }),
    execution: { lane: "write", concurrency: "keyed", keyParam: "sessionId" },
  },
  {
    name: "session.list_sessions",
    description: "List sessions for a workspace (DB-backed metadata, filesystem-enriched)",
    inputSchema: z.object({
      cwd: z.string().describe("Workspace CWD"),
      limit: z
        .number()
        .optional()
        .describe("Max sessions to return (omit for all). Sessions are sorted by modified desc."),
      offset: z
        .number()
        .optional()
        .default(0)
        .describe("Number of sessions to skip from the front"),
    }),
    execution: { lane: "read", concurrency: "parallel" },
  },
  {
    name: "session.search",
    description:
      "Find sessions by what was said in them — full-text over every user message and assistant prose, ranked by relevance. Tool inputs and outputs are not indexed.",
    inputSchema: z.object({
      query: z.string().describe("Free text; punctuation is tokenized, trailing word is a prefix"),
      cwd: z.string().optional().describe("Restrict to one workspace (omit to search all)"),
      ref: z
        .string()
        .optional()
        .describe("Restrict to sessions carrying this PR/ticket key, e.g. 'anima#61'"),
      disposition: z
        .array(z.enum(["open", "needs_review", "blocked", "snoozed", "resolved", "archived"]))
        .optional()
        .describe(
          "Restrict to these dispositions. Omitted searches all of them — unlike the nav, search deliberately reaches resolved and archived work, since finding it again is the point.",
        ),
      limit: z.number().int().positive().max(100).optional().default(20).describe("Max sessions"),
    }),
    execution: { lane: "read", concurrency: "parallel" },
  },
  {
    name: "session.get_history",
    description: "Get session history from JSONL",
    inputSchema: z.object({
      sessionId: z.string().describe("Session UUID"),
      cwd: z.string().optional().describe("Workspace CWD for fast file lookup"),
      limit: z.number().optional().default(50).describe("Max messages"),
      offset: z.number().optional().default(0).describe("Offset from most recent"),
    }),
    execution: { lane: "read", concurrency: "parallel" },
  },
  {
    name: "session.switch_session",
    description: "Switch active session for a workspace",
    inputSchema: z.object({
      sessionId: z.string().describe("Session UUID to switch to"),
      cwd: z.string().describe("Workspace CWD"),
      model: z.string().optional().describe("Model override"),
    }),
    execution: { lane: "write", concurrency: "keyed", keyParam: "sessionId" },
  },
  {
    name: "session.reset_session",
    description: "Create a replacement session for workspace",
    inputSchema: z.object({
      cwd: z.string().describe("Workspace CWD"),
      model: z.string().optional().describe("Model to use"),
    }),
    execution: { lane: "write", concurrency: "serial" },
  },
  {
    name: "session.get_info",
    description: "Get current session and extension info",
    inputSchema: z.object({
      sessionId: z.string().optional().describe("Session UUID (optional)"),
    }),
    execution: { lane: "read", concurrency: "parallel" },
  },
  {
    name: "session.set_permission_mode",
    description: "Set CLI permission mode",
    inputSchema: z.object({
      sessionId: z.string().describe("Session UUID"),
      mode: z.string().describe("Permission mode"),
    }),
    execution: { lane: "write", concurrency: "keyed", keyParam: "sessionId" },
  },
  {
    name: "session.send_notification",
    description:
      "Inject a notification into a session as a user message wrapped in <user_notification> tags. " +
      "Used by child agents/extensions to notify the session when background work completes.",
    inputSchema: z.object({
      sessionId: z.string().describe("Session UUID to notify"),
      text: z
        .string()
        .min(1)
        .describe("Notification text (will be wrapped in <user_notification> tags)"),
    }),
    execution: { lane: "write", concurrency: "keyed", keyParam: "sessionId" },
  },
  {
    name: "session.send_tool_result",
    description: "Send tool result for interactive tools",
    inputSchema: z.object({
      sessionId: z.string().describe("Session UUID"),
      toolUseId: z.string().describe("Tool use ID"),
      content: z.string().describe("Result content"),
      isError: z.boolean().optional().default(false).describe("Is error result"),
    }),
    execution: { lane: "write", concurrency: "keyed", keyParam: "sessionId" },
  },
  {
    name: "session.spawn_agent",
    description: "Spawn a child agent session and send its initial prompt",
    inputSchema: SpawnAgentSchema,
    execution: { lane: "long_running", concurrency: "keyed", keyParam: "parentSessionId" },
  },
  {
    name: "session.get_subagent",
    description: "Get child-agent session status by subagent ID",
    inputSchema: GetSubagentSchema,
    execution: { lane: "read", concurrency: "parallel" },
  },
  {
    name: "session.list_subagents",
    description: "List child-agent sessions with optional filters",
    inputSchema: ListSubagentsSchema,
    execution: { lane: "read", concurrency: "parallel" },
  },
  {
    name: "session.interrupt_subagent",
    description: "Interrupt a child-agent session by subagent ID",
    inputSchema: InterruptSubagentSchema,
    execution: { lane: "write", concurrency: "serial" },
  },
  {
    name: "session.set_title",
    description:
      "Name a session explicitly. The reconciler never overwrites this — pass null to clear it and fall back to the derived title.",
    inputSchema: z.object({
      sessionId: z.string().describe("Session UUID"),
      title: z
        .string()
        .max(200)
        .nullable()
        .describe("New name, or null to clear the rename and use the derived title"),
    }),
    execution: { lane: "write", concurrency: "keyed", keyParam: "sessionId" },
  },
  {
    name: "session.list_attention",
    description:
      "The work queue: every unresolved session across every workspace, newest created first. Not paginated per workspace — membership is the disposition, so nothing can be lost to a page boundary. Snoozed sessions are omitted until their timer passes. A resolved or archived session is not here at all, including the one a tab has open — it lives in its workspace tree, highlighted when current.",
    inputSchema: z.object({
      limit: z.number().int().positive().max(500).optional().default(200),
    }),
    execution: { lane: "read", concurrency: "parallel" },
  },
  {
    name: "session.resolve_stale",
    description:
      "Clear the ACTIVE queue: mark every unresolved session with no activity in N days as resolved. Safe because resolved sessions stay in the workspace tree — they leave the queue, not the sidebar. Reversible with set_status.",
    inputSchema: z.object({
      olderThanDays: z
        .number()
        .int()
        .positive()
        .optional()
        .default(5)
        .describe("Resolve completed sessions with no activity in this many days"),
      dryRun: z.boolean().optional().default(false).describe("Report what would change"),
    }),
    execution: { lane: "write", concurrency: "serial" },
  },
  {
    name: "session.snooze",
    description:
      "Hide a session from the attention list for a while, then let it come back. 'Remind me later', as distinct from 'we're done here' (which is set_status resolved).",
    inputSchema: z.object({
      sessionId: z.string().describe("Session UUID"),
      minutes: z
        .number()
        .int()
        .positive()
        .max(1440)
        .optional()
        .default(30)
        .describe("How long to stay quiet. Pass 0 via clear:true to un-snooze."),
      clear: z.boolean().optional().default(false).describe("Cancel an existing snooze"),
    }),
    execution: { lane: "write", concurrency: "keyed", keyParam: "sessionId" },
  },
  {
    name: "session.set_status",
    description:
      "Set where a session's work stands. This is the human axis — separate from runtime status, which the agent owns. 'resolved' and 'archived' hide the session from the default list.",
    inputSchema: z.object({
      sessionId: z.string().describe("Session UUID"),
      disposition: z
        .enum(["open", "needs_review", "blocked", "snoozed", "resolved", "archived"])
        .describe("Where the work stands"),
    }),
    execution: { lane: "write", concurrency: "keyed", keyParam: "sessionId" },
  },
  {
    name: "session.backfill_refs",
    description:
      "Re-extract PR/ticket refs for recent sessions from their full transcripts (migration tool; the reconciler keeps up incrementally after this)",
    inputSchema: z.object({
      days: z
        .number()
        .int()
        .positive()
        .optional()
        .default(30)
        .describe("How far back to look, by session last activity"),
      rescan: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Re-read whole conversations instead of resuming from each session's watermark, and replace refs rather than merging. Use after changing ref config.",
        ),
      dryRun: z
        .boolean()
        .optional()
        .default(false)
        .describe("Report what would change without writing"),
    }),
    execution: { lane: "write", concurrency: "serial" },
  },
  {
    name: "session.validate_refs",
    description:
      "Check extracted GitHub PR/issue refs against the API, cache the verdicts, and remove the ones that don't exist. Invalid keys are remembered so they're never re-extracted.",
    inputSchema: z.object({
      limit: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .default(50)
        .describe("How many unchecked ref keys to validate this pass"),
      revalidate: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Re-check keys that already have a cached verdict. Use after a repo is renamed or access changes.",
        ),
    }),
    execution: { lane: "write", concurrency: "serial" },
  },
  {
    name: "session.list_workspaces",
    description: "List all workspaces",
    inputSchema: z.object({}),
    execution: { lane: "read", concurrency: "parallel" },
  },
  {
    name: "session.get_workspace",
    description: "Get workspace by ID",
    inputSchema: z.object({
      id: z.string().describe("Workspace ID"),
    }),
    execution: { lane: "read", concurrency: "parallel" },
  },
  {
    name: "session.set_workspace_pinned",
    description: "Pin or unpin a workspace (pinned workspaces sort to the top)",
    inputSchema: z.object({
      id: z.string().describe("Workspace ID"),
      pinned: z.boolean().describe("True to pin, false to unpin"),
    }),
    execution: { lane: "write", concurrency: "serial" },
  },
  {
    name: "session.get_or_create_workspace",
    description: "Get or create workspace for CWD",
    inputSchema: z.object({
      cwd: z.string().describe("Working directory"),
      name: z.string().optional().describe("Workspace name"),
      general: z
        .boolean()
        .optional()
        .describe("Mark workspace as general so archived summaries span all workspaces"),
    }),
    execution: { lane: "write", concurrency: "serial" },
  },
  {
    name: "session.delete_workspace",
    description: "Delete a workspace by CWD",
    inputSchema: z.object({
      cwd: z.string().describe("Working directory of workspace to delete"),
    }),
    execution: { lane: "write", concurrency: "serial" },
  },
  {
    name: "session.get_directories",
    description: "List child directories from a given path (for directory browsing)",
    inputSchema: z.object({
      path: z.string().optional().default("~").describe("Path to list directories from"),
    }),
    execution: { lane: "read", concurrency: "parallel" },
  },
  {
    name: "session.list_commands",
    description:
      "List discoverable skills + slash commands (global ~/.claude + project <cwd>/.claude). Used by the web UI's `/` picker.",
    inputSchema: z.object({
      cwd: z
        .string()
        .optional()
        .describe("Workspace cwd; if provided, project-local commands are merged in"),
    }),
    execution: { lane: "read", concurrency: "parallel" },
  },
  {
    name: "session.list_files",
    description:
      "List files in a workspace cwd as relative paths. Uses `git ls-files` (respects .gitignore) when in a git repo, else walks while skipping heavy dirs (node_modules, .git, etc). Used by the web UI's `@` file picker.",
    inputSchema: z.object({
      cwd: z.string().describe("Workspace cwd to scan"),
    }),
    execution: { lane: "read", concurrency: "parallel" },
  },
  {
    name: "session.health_check",
    description: "Health status of session extension",
    inputSchema: z.object({}),
    execution: { lane: "control", concurrency: "parallel" },
  },
  {
    name: "session.rotate_persistent_sessions",
    description:
      "Check persistent sessions against rotation policy (maxMessages/maxAgeHours) and clear stale ones. Called by scheduler on a cron.",
    inputSchema: z.object({}),
    execution: { lane: "control", concurrency: "parallel" },
  },
  {
    name: "session.get_memory_context",
    description:
      "Preview the memory context that would be injected into a new session. Returns the raw formatted block and the underlying data. If cwd is omitted, uses the caller's working directory.",
    inputSchema: z.object({
      cwd: z
        .string()
        .optional()
        .describe("Workspace directory (defaults to caller's working directory)"),
    }),
    execution: { lane: "read", concurrency: "parallel" },
  },
];
