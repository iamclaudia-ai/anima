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
