---
name: delegating-to-agents
description: "Use PROACTIVELY when you need to delegate tasks to sub-agents — Cody (OpenAI Codex) or Claude (Haiku/Sonnet/Opus). Agents run as separate processes via agent-host and can execute commands, read/write files, and run tests autonomously. Use this for code review, test writing, refactoring, second opinions, or any work you want done in parallel. Triggers on: ask cody, delegate to cody, cody review, cody test, code review, have cody, let cody, send to cody, codex task, run tests with cody, cody write tests, get a second opinion, delegate task, sub-agent, assistant review, spawn agent, claude agent, haiku task, sonnet task, opus task, parallel task, worktree, delegate to claude."
---

# Delegating Tasks to Sub-Agents

You can spawn sub-agents to work in parallel with you. Agents run inside agent-host (port 30087) as managed tasks — fully isolated from the gateway and your session.

## Available Agents

| Agent    | Provider     | Best For                                                    |
| -------- | ------------ | ----------------------------------------------------------- |
| `codex`  | OpenAI Codex | Deep refactors, code review, test writing, mechanical tasks |
| `claude` | Anthropic    | Research, analysis, creative tasks, architecture review     |

Claude agents can use any model: haiku (fast/cheap), sonnet (balanced), opus (deep reasoning).

## How It Works

```
anima session start_task --agent <agent> --prompt "..."
  → session extension → AgentHostClient → TaskHost → Agent SDK
```

Agent-host owns all SDK processes. Tasks survive gateway/extension restarts.

## Quick Reference

```bash
# Start a task
anima session start_task --agent codex --prompt "Review src/index.ts for bugs"

# Start with worktree isolation (creates /tmp/worktrees/<taskId>)
anima session start_task --agent codex --prompt "Refactor the database layer" --worktree true

# Continue a previous task in its worktree
anima session start_task --agent codex --prompt "Now add tests for the refactor" --continue "task_abc123"

# Spawn a Claude agent
anima session start_task --agent claude --model sonnet --prompt "Analyze the architecture of extensions/"

# List running tasks
anima session list_tasks
anima session list_tasks --agent codex --status running

# Get task details
anima session get_task --taskId "task_abc123"

# Interrupt a task
anima session interrupt_task --taskId "task_abc123"
```

## Parallel Tasks

You can fire **multiple tasks in parallel** — they run concurrently and complete independently. Each sends its own `<user_notification>` when done.

```bash
# Fire off three tasks at once
anima session start_task --agent codex --mode review --prompt "Review session-host.ts for memory leaks" --sandbox "read-only"
anima session start_task --agent codex --mode test --prompt "Write tests for event-buffer.ts" --sandbox "workspace-write"
anima session start_task --agent claude --model haiku --prompt "Summarize the changes in the last 5 commits"

# Monitor all running tasks
anima session list_tasks --status running
```

## Worktree Isolation

Use `--worktree true` to give a task its own git worktree in `/tmp/worktrees/<taskId>` on branch `task/<taskId>`. This prevents file conflicts when multiple agents are working on the same repo, or when an agent's changes shouldn't interfere with your working tree.

```bash
# Isolated refactor — won't touch your working tree
anima session start_task --agent codex \
  --prompt "Refactor the database layer to use prepared statements" \
  --worktree true --sandbox "workspace-write"
```

**IMPORTANT**: When an agent is working in a worktree, do NOT edit the same files in the main tree. The whole point of worktree isolation is parallel work without conflicts. Review and merge when the task completes.

### Continuing in a Worktree

Use `--continue <taskId>` to send a follow-up prompt that reuses the `/tmp/worktrees/<taskId>` directory if it still exists. Great for multi-step workflows where a task needs steering or additional work.

```bash
# Task didn't finish? Continue where it left off
anima session start_task --agent codex \
  --prompt "The tests are failing — fix the import paths" \
  --continue "task_abc123"
```

### Git State Tracking

`get_task` and `list_tasks` return a `git` object for worktree tasks:

```json
{
  "git": {
    "isRepo": true,
    "dirty": false,
    "staged": 0,
    "unstaged": 0,
    "untracked": 0,
    "branchName": "task/task_abc123",
    "worktreeExists": true,
    "mergedToParent": false
  }
}
```

Key fields:

- **`dirty`** — Whether the agent has uncommitted changes (always ask them to commit!)
- **`mergedToParent`** — Whether the task's commits have been merged into the parent repo. Use this to identify tasks that still need your attention.
- **`worktreeExists`** — Whether the worktree directory still exists on disk

### Merging Worktree Changes

Use **rebase + fast-forward merge** to bring worktree changes into the main tree. This keeps linear history and ensures `mergedToParent` detection works correctly.

```bash
# 1. Rebase task branch onto main (resolves conflicts in the worktree, not main)
git -C /tmp/worktrees/<taskId> rebase main

# 2. Fast-forward merge into main repo
git merge --ff-only task/<taskId>
```

**Do NOT use cherry-pick or squash merge** — these rewrite the commit SHA, so `mergedToParent` (which uses `git merge-base --is-ancestor`) won't detect them as merged.

After merging, verify with `get_task` — `mergedToParent` should flip to `true`.

## Interactive Task Control

Tasks are **fully interactive**, not fire-and-forget:

- **Stream events**: Tasks emit real-time events through the gateway event bus — you can watch them work
- **Steer a task**: Use `session.send_prompt` to talk to the agent while it's working and redirect it
- **Interrupt**: Use `session.interrupt_task` to abort if the agent is going astray

## Completion Notifications

When a task finishes, you receive a `<user_notification>` automatically — no polling needed:

```
<user_notification>
Cody completed task task_abc123 (15s). Output: /Users/michael/.anima/codex/task_abc123.md
</user_notification>
```

When you receive this notification:

1. **Read the output file** to get the agent's full results
2. **Summarize the findings** for the user
3. **Act on the results** if appropriate (apply fixes, merge worktree changes, etc.)

## Sharing Context

Each task starts a fresh thread with no prior context. To share context:

- **Write a context file** to `tmp/` with relevant information, then reference it in the prompt
- **Use `--files`** to point the agent at specific source files to read
- **Be explicit in the prompt** — include file paths, function names, and what you want them to focus on

```bash
# Write context, then reference it in the prompt
echo "Review focus: the new provider routing in session extension..." > tmp/review-context.md
anima session start_task --agent codex \
  --prompt "Read tmp/review-context.md for context, then review extensions/session/src/index.ts"
```

## Parameters

| Parameter    | Type    | Description                                                    |
| ------------ | ------- | -------------------------------------------------------------- |
| `--agent`    | string  | **Required.** Agent provider: `codex`, `claude`                |
| `--prompt`   | string  | **Required.** Task prompt                                      |
| `--mode`     | string  | Task mode: `general`, `review`, `test`                         |
| `--cwd`      | string  | Working directory override (defaults to current session's cwd) |
| `--worktree` | boolean | Create isolated git worktree in `/tmp/worktrees/<taskId>`      |
| `--continue` | string  | Reuse worktree from a previous task ID                         |
| `--model`    | string  | Model override (e.g., `haiku`, `sonnet`, `opus`, `o4-mini`)    |
| `--effort`   | string  | Reasoning effort: `minimal`, `low`, `medium`, `high`, `xhigh`  |
| `--sandbox`  | string  | Sandbox: `read-only`, `workspace-write`, `danger-full-access`  |
| `--files`    | array   | Focus on specific files (useful for reviews)                   |
| `--metadata` | object  | Additional provider-specific metadata                          |

## Sample Prompts

### Code Review (Codex)

```bash
# General code review
anima session start_task --agent codex --mode review \
  --prompt "Review extensions/session/src/index.ts for error handling gaps, race conditions, and missing edge cases." \
  --sandbox "read-only"

# Targeted review with file list
anima session start_task --agent codex --mode review \
  --prompt "Review the agent-host protocol for backward compatibility issues." \
  --files '["packages/shared/src/agent-host-protocol.ts", "packages/agent-host/src/server.ts"]' \
  --sandbox "read-only"

# Architecture review with Claude (deeper reasoning)
anima session start_task --agent claude --model opus \
  --prompt "Review the session extension and agent-host boundary. Are there circular dependencies or leaky abstractions? Analyze the separation of concerns." \
  --sandbox "read-only"
```

### Writing Tests

```bash
# Unit tests
anima session start_task --agent codex --mode test \
  --prompt "Write comprehensive bun tests for packages/agent-host/src/task-host.ts. Cover: task creation, status transitions, interrupt handling, error cases, and event emission. Use bun:test." \
  --sandbox "workspace-write"

# Edge case tests
anima session start_task --agent codex --mode test \
  --prompt "Write edge case tests for extensions/voice/src/sentence-chunker.ts covering: emoji, unicode, empty strings, very long inputs, nested emotion tags, and malformed markup." \
  --sandbox "workspace-write"
```

### Refactoring with Worktree

```bash
# Isolated refactor that won't interfere with your working tree
anima session start_task --agent codex \
  --prompt "Refactor extensions/session/src/session-store.ts to use prepared statements for all SQLite queries. Maintain the same public API. Run existing tests to verify." \
  --worktree true --effort high --sandbox "workspace-write"

# Continue if more work is needed
anima session start_task --agent codex \
  --prompt "Good progress. Now update the migration files to match the new prepared statements." \
  --continue "task_abc123"
```

### Claude Agent Tasks

```bash
# Fast analysis with Haiku
anima session start_task --agent claude --model haiku \
  --prompt "Summarize the changes in the last 10 git commits and identify any breaking changes."

# Deep reasoning with Opus
anima session start_task --agent claude --model opus \
  --prompt "Analyze our WebSocket protocol for potential security issues. Consider: auth bypass, event injection, reconnect race conditions, and sequence number manipulation."

# Balanced task with Sonnet
anima session start_task --agent claude --model sonnet \
  --prompt "Read docs/ARCHITECTURE.md and suggest improvements for clarity and completeness."
```

### Parallel Tasks

```bash
# Fire off multiple tasks at once — they run concurrently
anima session start_task --agent codex --mode review --prompt "Review session-host.ts for memory leaks" --sandbox "read-only"
anima session start_task --agent codex --mode test --prompt "Write tests for event-buffer.ts" --sandbox "workspace-write"
anima session start_task --agent claude --model haiku --prompt "Generate JSDoc comments for all exported functions in packages/shared/src/"

# Monitor all running tasks
anima session list_tasks --status running
```

## Streaming Events

Tasks emit real-time events through the gateway event bus:

| Event Pattern                 | What It Means                          |
| ----------------------------- | -------------------------------------- |
| `session.task.{taskId}.start` | Agent started working                  |
| `session.task.{taskId}.delta` | Streaming text output (token by token) |
| `session.task.{taskId}.item`  | Work item completed (command, message) |
| `session.task.{taskId}.stop`  | Agent finished — includes final status |
| `session.task.{taskId}.error` | Something went wrong                   |

Subscribe to `session.task.*` events to watch agents work in real-time.

## Calling from Extension Code

From any Anima extension, delegate via `ctx.call()`:

```typescript
const handle = await ctx.call("session.start_task", {
  sessionId: "your-session-uuid",
  agent: "codex",
  prompt: "Review the session extension for memory leaks",
  mode: "review",
  cwd: "/Users/michael/Projects/iamclaudia-ai/anima",
  sandbox: "read-only",
  worktree: true,
});
// handle = { taskId: "task_abc123", status: "running", outputFile: "~/.anima/codex/task_abc123.md" }
```

## Task Modes and Sandbox Recommendations

| Mode      | Recommended Sandbox | Use Case                      |
| --------- | ------------------- | ----------------------------- |
| `general` | `workspace-write`   | General tasks                 |
| `review`  | `read-only`         | Code review — safe, no writes |
| `test`    | `workspace-write`   | Test writing — needs files    |

## Output Files

Every task writes persistent output to `~/.anima/codex/{taskId}.md`. The file includes:

- The original prompt
- Live command output and agent messages as they stream
- Final status and result

## Important Notes

- **Parallel tasks**: Run as many tasks concurrently as you want. Each completes independently with its own notification.
- **Auto-approve**: Agents auto-approve command executions and file changes by default.
- **Fresh thread per task**: Each task creates a new conversation thread. Share context via files.
- **Task returns immediately**: `session.start_task` returns a task handle right away. Work happens asynchronously.
- **Session ID auto-detected**: The CLI auto-injects `$ANIMA_SESSION_ID`. Only use `--sessionId` to override.
- **Process isolation**: Tasks run inside agent-host (port 30087), isolated from the gateway. Tasks survive restarts.
- **Provider-agnostic API**: Same `session.start_task` API for all agents — just change `--agent`.
- **Worktrees are ephemeral**: `/tmp/worktrees/<taskId>` — short-lived, no clutter in your project folders.
