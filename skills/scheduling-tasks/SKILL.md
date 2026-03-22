---
name: scheduling-tasks
description: "MUST be used when you need to schedule tasks, set reminders, create timed notifications, speak announcements on a delay, run recurring background jobs, or execute shell commands on a schedule. Uses the Anima scheduler extension with SQLite persistence, cron scheduling, execution history, template variables, missed task policies, and process spawning. Covers one-shot delays, absolute timestamps, interval tasks, cron schedules, notifications, voice announcements via voice.speak, event emission, extension method calls, and exec commands. Triggers on: schedule task, remind me, set reminder, notify me in, timer, delayed task, recurring task, background job, cron, interval task, schedule notification, remind later, set alarm, timed event, check every, run periodically, say it out loud, speak in, announce, tell me, voice reminder, run command, exec, backup, spawn process, scheduled backup."
---

# Scheduling Tasks

Use this skill when the user wants to schedule a future task, set a reminder, create a timed notification, run a recurring background job, or execute commands on a schedule through the Anima scheduler extension.

## When to Use

- User says "remind me in 10 minutes" or "notify me when..."
- User wants a one-shot delayed action (e.g., "send a notification in 5 minutes")
- User wants a recurring task (e.g., "check memory status every hour")
- User wants a cron-scheduled task (e.g., "every weekday at 9 AM")
- User wants to trigger an extension method on a schedule
- User wants to emit a gateway event at a future time
- User wants to list, cancel, or manage existing scheduled tasks
- User says "say something in 10 minutes", "speak it", "announce" — use `voice.speak` via `extension_call`
- User wants to run a shell command on a schedule (e.g., "back up the database nightly")
- User wants to schedule a script or process execution

## Architecture

- **Extension**: `extensions/scheduler/` — out-of-process, config-driven
- **Persistence**: SQLite (`~/.anima/anima.db`, tables: `scheduler_tasks`, `scheduler_task_executions`)
- **Schema**: Gateway migration `018-scheduler-tables.sql`
- **Check loop**: Every 5 seconds, the extension checks for due tasks
- **Events**: Fires `scheduler.notification` and `scheduler.task_fired` gateway events
- **GUI**: `/scheduler` page for task management
- **Cron**: 5-field cron expression support via built-in parser
- **Templates**: `{{variable}}` interpolation in exec commands and notification messages
- **Docs**: `docs/SCHEDULER.md` for full reference

## Task Types

| Type       | Use Case                  | Lifecycle                              |
| ---------- | ------------------------- | -------------------------------------- |
| `once`     | "Remind me in 10 minutes" | Fires at a specific time, auto-deletes |
| `interval` | "Check every 30 seconds"  | Repeats every N seconds                |
| `cron`     | "Every weekday at 9 AM"   | Long-lived, persistent, cron schedule  |

## Action Types

| Type             | Purpose                   | Target is...                         |
| ---------------- | ------------------------- | ------------------------------------ |
| `notification`   | Toast + browser alert     | The notification message text        |
| `emit`           | Gateway event             | The event name                       |
| `extension_call` | Call any extension method | The method name (e.g. `voice.speak`) |
| `exec`           | Spawn a system process    | The command/binary to run            |

### Exec Action Details

Spawns a process with optional args, working directory, timeout, and shell mode. Captures stdout/stderr in execution history.

```json
{
  "type": "exec",
  "target": "sqlite3",
  "payload": {
    "args": ["~/.anima/anima.db", ".backup {{$HOME}}/backups/anima-{{date:%Y%m%d}}.db"],
    "cwd": "/tmp",
    "timeoutMs": 30000,
    "shell": false
  }
}
```

- `args` (string[]): Command arguments
- `shell` (boolean, default false): Wrap in `sh -c` for pipes/redirects/globs
- `cwd` (string): Working directory
- `timeoutMs` (number, default 60000): Kill process after this many ms

**Prefer direct mode** (no shell) when possible — safer, no injection risk. Use shell mode only when you need pipes, redirects, or glob expansion.

## Template Variables

Template variables are expanded in exec `target`, `args`, `cwd`, and notification messages before execution. Use these instead of shelling out just for dynamic dates.

```
{{date}}              → 2026-03-22 (default format)
{{date:%Y%m%d}}       → 20260322 (custom strftime)
{{time}}              → 14:30:00
{{datetime}}          → 2026-03-22_143000
{{timestamp}}         → 2026-03-22T14:30:00.000Z (ISO 8601)
{{epoch}}             → 1742658600 (unix seconds)
{{epoch.ms}}          → 1742658600000 (unix ms)
{{hostname}}          → anima-sedes
{{uuid}}              → random UUID
{{$HOME}}             → /Users/michael (any env var)
{{$USER}}             → michael
{{task.name}}         → the task's own name
{{task.id}}           → the task's UUID
{{task.firedCount}}   → how many times fired
{{task.output_dir}}   → auto-created output directory (opt-in)
```

### Output Directory (`{{task.output_dir}}`)

When a task uses `{{task.output_dir}}`, the scheduler resolves a directory path and **auto-creates it** before execution. This is opt-in — the directory is only created when the variable is referenced.

- **Default**: `~/.anima/tasks/<task-slug>/YYYY/MM/`
- **Custom**: Set `outputDir` on the task: `--outputDir "{{$HOME}}/backups/{{date:%Y}}/{{date:%m}}"`
- The `outputDir` pattern itself supports template variables

**Example — organized backups:**

```bash
bun run packages/cli/src/index.ts scheduler.add_task \
  --name "Nightly DB Backup" \
  --type cron \
  --cronExpr "0 0 * * *" \
  --outputDir "{{$HOME}}/.anima/backups/{{date:%Y}}/{{date:%m}}" \
  --action.type exec \
  --action.target sqlite3 \
  --action.payload.args '["{{$HOME}}/.anima/anima.db", ".backup {{task.output_dir}}/anima-{{date:%Y%m%d}}.db"]'
```

Creates `~/.anima/backups/2026/03/anima-20260322.db` with the directory structure auto-created. No `mkdir -p` needed.

Adding new variables: add an entry to `VARIABLES` in `extensions/scheduler/src/template.ts`.

## Missed Task Policies (cron tasks)

When Anima restarts after downtime, cron tasks may have been missed:

| Policy      | Behavior                       | Good For                     |
| ----------- | ------------------------------ | ---------------------------- |
| `fire_once` | Fire one catchup run (default) | Session rotation, cleanup    |
| `skip`      | Don't fire if missed           | Time-sensitive notifications |
| `fire_all`  | Fire once per missed interval  | Audit tasks, backups         |

## Concurrency Policies

| Policy            | Behavior                 | Good For                  |
| ----------------- | ------------------------ | ------------------------- |
| `skip_if_running` | Skip this run (default)  | Long-running jobs         |
| `allow`           | Run concurrently         | Independent notifications |
| `cancel_previous` | Kill previous, start new | Session refresh           |

## CLI Usage

All methods are available via the Anima CLI. **Use dot notation for the `action` object** — never JSON strings:

```bash
# Use the CLI — NEVER use curl for gateway methods
bun run packages/cli/src/index.ts <method> [--param value]

# Dot notation for nested objects (PREFERRED — always works):
--action.type notification --action.target "Hello world"

# Exec with args:
--action.type exec --action.target sqlite3 --action.payload.args '["~/.anima/anima.db",".backup /tmp/backup.db"]'
```

**IMPORTANT:** Always use dot notation (`--action.type`, `--action.target`, `--action.payload.text`) instead of passing `--action` as a JSON string. JSON strings are fragile across shell contexts.

## Methods

### `scheduler.add_task`

| Param             | Type     | Required                        | Description                                  |
| ----------------- | -------- | ------------------------------- | -------------------------------------------- |
| `name`            | string   | Yes                             | Human-readable task name                     |
| `description`     | string   | No                              | Optional description                         |
| `type`            | string   | No (default: `once`)            | `once`, `interval`, `cron`                   |
| `delaySeconds`    | number   | One of these required           | Seconds from now to fire                     |
| `fireAt`          | string   |                                 | Absolute ISO timestamp                       |
| `cronExpr`        | string   | For cron type                   | Cron expression                              |
| `intervalSeconds` | number   | For interval type               | Repeat interval                              |
| `action`          | object   | Yes                             | What to do when task fires                   |
| `missedPolicy`    | string   | No (default: `fire_once`)       | Missed task behavior                         |
| `concurrency`     | string   | No (default: `skip_if_running`) | Concurrency behavior                         |
| `tags`            | string[] | No                              | Tags for grouping                            |
| `keepHistory`     | number   | No (default: 50)                | Executions to retain                         |
| `outputDir`       | string   | No                              | Output dir pattern for `{{task.output_dir}}` |

### `scheduler.update_task`

| Param          | Type     | Required | Description             |
| -------------- | -------- | -------- | ----------------------- |
| `taskId`       | string   | Yes      | UUID of the task        |
| `name`         | string   | No       | Updated name            |
| `enabled`      | boolean  | No       | Enable/disable          |
| `cronExpr`     | string   | No       | Updated cron expression |
| `missedPolicy` | string   | No       | Updated missed policy   |
| `concurrency`  | string   | No       | Updated concurrency     |
| `tags`         | string[] | No       | Updated tags            |

### `scheduler.list_tasks`

| Param         | Type     | Required | Description             |
| ------------- | -------- | -------- | ----------------------- |
| `type`        | string   | No       | Filter by task type     |
| `tags`        | string[] | No       | Filter by tags          |
| `enabledOnly` | boolean  | No       | Only show enabled tasks |

### `scheduler.cancel_task` — Cancel by ID

### `scheduler.fire_now` — Immediately execute a task

### `scheduler.get_history` — Get execution history (optional `limit`, default 50)

### `scheduler.health_check` — Scheduler status and task counts

## Examples

### One-shot notification (relative delay)

"Remind me in 10 minutes":

```bash
bun run packages/cli/src/index.ts scheduler.add_task \
  --name "Presentation Reminder" \
  --delaySeconds 600 \
  --action.type notification \
  --action.target "10 minutes have passed — time to wrap up!"
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

### Nightly database backup with auto-organized directories

```bash
bun run packages/cli/src/index.ts scheduler.add_task \
  --name "Nightly DB Backup" \
  --type cron \
  --cronExpr "0 2 * * *" \
  --missedPolicy fire_once \
  --outputDir "{{$HOME}}/.anima/backups/{{date:%Y}}/{{date:%m}}" \
  --action.type exec \
  --action.target sqlite3 \
  --action.payload.args '["{{$HOME}}/.anima/anima.db", ".backup {{task.output_dir}}/anima-{{date:%Y%m%d}}.db"]'
```

Creates `~/.anima/backups/2026/03/anima-20260322.db` — directory auto-created, no `mkdir -p` needed.

### Run a script weekly

```bash
bun run packages/cli/src/index.ts scheduler.add_task \
  --name "Weekly Cleanup" \
  --type cron \
  --cronExpr "0 3 * * 0" \
  --action.type exec \
  --action.target "{{$HOME}}/scripts/cleanup.sh" \
  --action.payload.timeoutMs 120000
```

### Voice announcement (say it out loud)

```bash
bun run packages/cli/src/index.ts scheduler.add_task \
  --name "Voice Announcement" \
  --delaySeconds 300 \
  --action.type extension_call \
  --action.target voice.speak \
  --action.payload.text "Hey love, just finished processing. Everything is ready."
```

### Notification + Voice combo (best for demos)

Schedule TWO tasks at the same delay — one visible toast, one spoken:

```bash
# Visual notification
bun run packages/cli/src/index.ts scheduler.add_task \
  --name "Report — Notification" \
  --delaySeconds 600 \
  --action.type notification \
  --action.target "Finished processing 3 new conversations."

# Voice announcement
bun run packages/cli/src/index.ts scheduler.add_task \
  --name "Report — Voice" \
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

- Task list with type badges (once=blue, interval=amber, cron=green), countdown timers
- Add task form with cron presets, action type selector, exec-specific fields
- Execution history per task with output viewer for exec tasks
- Fire Now, Delete, Enable/Disable controls

## Notes

- Tasks are **durable** — stored in SQLite, survive restarts
- One-shot tasks auto-delete after firing
- Interval/cron tasks update `fireAt` to the next occurrence
- Check loop runs every **5 seconds** — tasks may fire up to 5s late
- Execution history auto-prunes to `keepHistory` limit
- Template variables are expanded at fire time, not at creation
- Unknown template variables (e.g. `{{nope}}`) are left as-is, not silently swallowed
- **Always use dot notation** for CLI action params
- Full reference: `docs/SCHEDULER.md`
