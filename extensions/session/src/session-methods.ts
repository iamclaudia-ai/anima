import { z } from "zod";
import type { ExtensionMethodDefinition } from "@anima/shared";

const StartTaskSchema = z.object({
  sessionId: z.string().describe("Parent session UUID"),
  agent: z.string().describe("Target delegated agent/provider (currently codex supported)"),
  prompt: z.string().min(1).describe("Task prompt"),
  mode: z.enum(["general", "review", "test"]).optional().default("general"),
  cwd: z.string().optional().describe("Working directory override"),
  worktree: z
    .boolean()
    .optional()
    .describe("Create a git worktree in /tmp/worktrees/<task_id> and run task there"),
  continue: z
    .string()
    .optional()
    .describe("Reuse /tmp/worktrees/<task_id> if present; otherwise run in resolved cwd"),
  model: z.string().optional().describe("Model override"),
  effort: z.string().optional().describe("Effort/reasoning override"),
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
  files: z.array(z.string()).optional().describe("Optional file list for review mode"),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const GetTaskSchema = z.object({
  taskId: z.string().describe("Task ID"),
});

const ListTasksSchema = z.object({
  sessionId: z.string().optional().describe("Filter by session ID"),
  status: z.enum(["running", "completed", "failed", "interrupted"]).optional(),
  agent: z.string().optional().describe("Filter by agent/provider"),
});

const InterruptTaskSchema = z.object({
  taskId: z.string().describe("Task ID"),
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
      "Used by async task agents/extensions to notify the session when background work completes.",
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
    name: "session.start_task",
    description: "Start a delegated task using a specific agent/provider",
    inputSchema: StartTaskSchema,
    execution: { lane: "long_running", concurrency: "keyed", keyParam: "sessionId" },
  },
  {
    name: "session.get_task",
    description: "Get delegated task status by task ID",
    inputSchema: GetTaskSchema,
    execution: { lane: "read", concurrency: "parallel" },
  },
  {
    name: "session.list_tasks",
    description: "List delegated tasks with optional filters",
    inputSchema: ListTasksSchema,
    execution: { lane: "read", concurrency: "parallel" },
  },
  {
    name: "session.interrupt_task",
    description: "Interrupt a delegated task by task ID",
    inputSchema: InterruptTaskSchema,
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
