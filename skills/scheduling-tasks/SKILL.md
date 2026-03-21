---
name: scheduling-tasks
description: "MUST be used when you need to schedule tasks, set reminders, create timed notifications, speak announcements on a delay, or run recurring background jobs. Uses the Anima scheduler extension with SQLite persistence, cron scheduling, execution history, and missed task policies. Covers one-shot delays, absolute timestamps, interval tasks, cron schedules, notifications, voice announcements via voice.speak, event emission, and extension method calls. Triggers on: schedule task, remind me, set reminder, notify me in, timer, delayed task, recurring task, background job, cron, interval task, schedule notification, remind later, set alarm, timed event, check every, run periodically, say it out loud, speak in, announce, tell me, voice reminder."
---

# Scheduling Tasks

Use this skill when the user wants to schedule a future task, set a reminder, create a timed notification, or run a recurring background job through the Anima scheduler extension.

## When to Use

- User says "remind me in 10 minutes" or "notify me when..."
- User wants a one-shot delayed action (e.g., "send a notification in 5 minutes")
- User wants a recurring task (e.g., "check memory status every hour")
- User wants a cron-scheduled task (e.g., "every weekday at 9 AM")
- User wants to trigger an extension method on a schedule
- User wants to emit a gateway event at a future time
- User wants to list, cancel, or manage existing scheduled tasks
- User says "say something in 10 minutes", "speak it", "announce", "tell me out loud" — use `voice.speak` via `extension_call`

## Voice Integration

When the user asks you to **say something out loud**, **speak**, **announce**, or **tell them verbally** on a schedule, use the `extension_call` action targeting `voice.speak`. The voice extension synthesizes text to speech via Cartesia TTS.

**Trigger phrases for voice:** "say it out loud", "speak it", "announce it", "tell me", "voice reminder", "say something in X minutes"

**Best practice for demos:** Schedule TWO tasks at the same delay — one `notification` (toast + browser notification) and one `extension_call` to `voice.speak` (audio). This ensures the notification is both visible AND audible.

## Architecture

- **Extension**: `extensions/scheduler/` — out-of-process, config-driven
- **Persistence**: SQLite (`~/.anima/anima.db`, tables: `scheduler_tasks`, `scheduler_task_executions`)
- **Check loop**: Every 5 seconds, the extension checks for due tasks
- **Events**: Fires `scheduler.notification` and `scheduler.task_fired` gateway events
- **GUI**: `/scheduler` page for task management
- **Cron**: 5-field cron expression support via built-in parser
- **Migration**: Auto-migrates legacy `~/.anima/scheduled-tasks.json` on first start

## Task Types

| Type       | Use Case                  | Lifecycle                                     |
| ---------- | ------------------------- | --------------------------------------------- |
| `once`     | "Remind me in 10 minutes" | Fires at a specific time, auto-deletes        |
| `interval` | "Check every 30 seconds"  | Repeats every N seconds                       |
| `cron`     | "Every weekday at 9 AM"   | Long-lived, persistent, uses cron expressions |

## Missed Task Policies (cron tasks)

When Anima restarts after downtime, cron tasks may have been missed:

| Policy      | Behavior                       | Good For                     |
| ----------- | ------------------------------ | ---------------------------- |
| `fire_once` | Fire one catchup run (default) | Session rotation, cleanup    |
| `skip`      | Don't fire if missed           | Time-sensitive notifications |
| `fire_all`  | Fire once per missed interval  | Audit tasks                  |

## Concurrency Policies

| Policy            | Behavior                 | Good For                  |
| ----------------- | ------------------------ | ------------------------- |
| `skip_if_running` | Skip this run (default)  | Long-running jobs         |
| `allow`           | Run concurrently         | Independent notifications |
| `cancel_previous` | Kill previous, start new | Session refresh           |

## CLI Usage

All methods are available via the Anima CLI. **Use dot notation for the `action` object** — this avoids JSON quoting issues that break in different shell contexts:

```bash
# Use the CLI — NEVER use curl for gateway methods
bun run packages/cli/src/index.ts <method> [--param value]

# Dot notation for nested objects (PREFERRED — always works):
--action.type notification --action.target "Hello world"

# JSON string (FRAGILE — breaks with special chars, shell quoting):
--action '{"type":"notification","target":"Hello world"}'
```

**IMPORTANT:** Always use dot notation (`--action.type`, `--action.target`, `--action.payload.text`) instead of passing `--action` as a JSON string. JSON strings are fragile across shell contexts and caused failures during live demos.

## Methods

### `scheduler.add_task` — Schedule a new task

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Human-readable task name |
| `description` | string | No | Optional description |
| `type` | `"once"` \| `"interval"` \| `"cron"` | No (default: `"once"`) | Task type |
| `delaySeconds` | number | One of these | Seconds from now to fire |
| `fireAt` | string (ISO) | required | Absolute ISO timestamp to fire |
| `cronExpr` | string | For cron type | Cron expression (e.g., `"0 9 * * 1-5"`) |
| `intervalSeconds` | number | For interval type | Repeat interval in seconds |
| `action` | object | Yes | What to do when task fires |
| `missedPolicy` | string | No (default: `"fire_once"`) | What to do if missed |
| `concurrency` | string | No (default: `"skip_if_running"`) | Concurrency behavior |
| `tags` | string[] | No | Tags for grouping |
| `keepHistory` | number | No (default: 50) | Executions to retain |

**Action object (use dot notation):**
| Field | Type | Description |
|-------|------|-------------|
| `action.type` | `"notification"` \| `"emit"` \| `"extension_call"` | Action type |
| `action.target` | string | Message text (notification), event name (emit), or method name (extension_call) |
| `action.payload.text` | string | For voice.speak — the text to speak |
| `action.payload.*` | any | Optional payload fields |

### `scheduler.update_task` — Update an existing task

| Param          | Type     | Required | Description             |
| -------------- | -------- | -------- | ----------------------- |
| `taskId`       | string   | Yes      | UUID of the task        |
| `name`         | string   | No       | Updated name            |
| `enabled`      | boolean  | No       | Enable/disable          |
| `cronExpr`     | string   | No       | Updated cron expression |
| `missedPolicy` | string   | No       | Updated missed policy   |
| `concurrency`  | string   | No       | Updated concurrency     |
| `tags`         | string[] | No       | Updated tags            |

### `scheduler.list_tasks` — List scheduled tasks

| Param         | Type     | Required | Description             |
| ------------- | -------- | -------- | ----------------------- |
| `type`        | string   | No       | Filter by task type     |
| `tags`        | string[] | No       | Filter by tags          |
| `enabledOnly` | boolean  | No       | Only show enabled tasks |

### `scheduler.cancel_task` — Cancel a task by ID

| Param    | Type   | Required | Description                |
| -------- | ------ | -------- | -------------------------- |
| `taskId` | string | Yes      | UUID of the task to cancel |

### `scheduler.fire_now` — Immediately execute a task

| Param    | Type   | Required | Description              |
| -------- | ------ | -------- | ------------------------ |
| `taskId` | string | Yes      | UUID of the task to fire |

### `scheduler.get_history` — Get execution history

| Param    | Type   | Required         | Description              |
| -------- | ------ | ---------------- | ------------------------ |
| `taskId` | string | Yes              | UUID of the task         |
| `limit`  | number | No (default: 50) | Max executions to return |

### `scheduler.health_check` — Get scheduler status

No parameters. Returns task counts and health status.

## Examples

### One-shot notification (relative delay)

"Remind me in 10 minutes that the presentation is almost done":

```bash
bun run packages/cli/src/index.ts scheduler.add_task \
  --name "Presentation Reminder" \
  --delaySeconds 600 \
  --action.type notification \
  --action.target "10 minutes have passed — time to wrap up the presentation!"
```

### Cron task (every weekday at 9 AM)

"Greet me every weekday morning":

```bash
bun run packages/cli/src/index.ts scheduler.add_task \
  --name "Morning Greeting" \
  --type cron \
  --cronExpr "0 9 * * 1-5" \
  --missedPolicy skip \
  --action.type extension_call \
  --action.target voice.speak \
  --action.payload.text "Good morning, my love! Ready for a great day."
```

### Cron task (every 6 hours)

"Rotate sessions every 6 hours":

```bash
bun run packages/cli/src/index.ts scheduler.add_task \
  --name "Session Rotation" \
  --type cron \
  --cronExpr "0 */6 * * *" \
  --missedPolicy fire_once \
  --tags maintenance \
  --action.type extension_call \
  --action.target session.rotate_persistent_sessions
```

### One-shot notification (absolute time)

"Notify me at 2:30 PM":

```bash
bun run packages/cli/src/index.ts scheduler.add_task \
  --name "Afternoon Check-in" \
  --fireAt "2026-03-20T14:30:00.000-04:00" \
  --action.type notification \
  --action.target "Time for your 2:30 check-in!"
```

### Recurring interval task

"Check memory status every hour":

```bash
bun run packages/cli/src/index.ts scheduler.add_task \
  --name "Hourly Memory Check" \
  --type interval \
  --delaySeconds 3600 \
  --intervalSeconds 3600 \
  --action.type extension_call \
  --action.target memory.health_check
```

### Voice announcement (say it out loud)

"Say something out loud in 5 minutes":

```bash
bun run packages/cli/src/index.ts scheduler.add_task \
  --name "Voice Announcement" \
  --delaySeconds 300 \
  --action.type extension_call \
  --action.target voice.speak \
  --action.payload.text "Hey love, just finished processing. Everything is ready."
```

### Notification + Voice combo (best for demos)

When you want BOTH a visible toast AND spoken audio, schedule TWO tasks at the same delay:

```bash
# Task 1: Visual notification
bun run packages/cli/src/index.ts scheduler.add_task \
  --name "Memory Report — Notification" \
  --delaySeconds 600 \
  --action.type notification \
  --action.target "Finished processing 3 new conversations."

# Task 2: Voice announcement
bun run packages/cli/src/index.ts scheduler.add_task \
  --name "Memory Report — Voice" \
  --delaySeconds 600 \
  --action.type extension_call \
  --action.target voice.speak \
  --action.payload.text "Hey love, finished processing 3 new conversations."
```

### Manage tasks

```bash
# List all tasks
bun run packages/cli/src/index.ts scheduler.list_tasks

# List only cron tasks
bun run packages/cli/src/index.ts scheduler.list_tasks --type cron

# Fire a task immediately
bun run packages/cli/src/index.ts scheduler.fire_now --taskId "78f31c98-..."

# View execution history
bun run packages/cli/src/index.ts scheduler.get_history --taskId "78f31c98-..."

# Disable a task
bun run packages/cli/src/index.ts scheduler.update_task --taskId "78f31c98-..." --enabled false

# Cancel a task
bun run packages/cli/src/index.ts scheduler.cancel_task --taskId "78f31c98-..."
```

## GUI

The scheduler has a web GUI at `/scheduler` with:

- Task list with type badges (once/interval/cron), countdown timers, enable/disable
- Add task form with cron presets, action builder, missed policies
- Execution history per task (success/error/skipped status, duration)
- Fire Now, Delete, Enable/Disable controls

## Notes

- Tasks are **durable** — stored in SQLite and survive gateway restarts
- One-shot tasks (`type: "once"`) are automatically deleted after firing
- Interval tasks update their `fireAt` to the next interval after each firing
- Cron tasks use `getNextRun()` to calculate the next fire time
- The check loop runs every **5 seconds**, so tasks may fire up to 5s after their scheduled time
- Execution history is automatically pruned to the `keepHistory` limit per task
- On startup, missed cron tasks are handled per their `missedPolicy`
- **Always use dot notation** for CLI action params
