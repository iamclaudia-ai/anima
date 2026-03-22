# Scheduler Extension

Durable task scheduling with SQLite persistence, cron expressions, execution history, template variables, and process spawning.

## Overview

The scheduler is an out-of-process extension that runs a 5-second check loop, firing due tasks and emitting events through the gateway event bus. Tasks survive gateway restarts — the schema lives in the gateway migration system (`018-scheduler-tables.sql`) and data persists in `~/.anima/anima.db`.

```
┌──────────────────────────────────────────────────────┐
│  Scheduler Extension                                  │
│                                                       │
│  ┌─────────────┐   ┌─────────────┐   ┌────────────┐  │
│  │  Check Loop  │──▶│  Fire Task  │──▶│  Actions   │  │
│  │  (5s tick)   │   │ (concurrency│   │            │  │
│  │              │   │  + history) │   │ • emit     │  │
│  │  Due tasks?  │   │             │   │ • notify   │  │
│  │  ────────▶   │   │  Template   │   │ • call     │  │
│  │              │   │  interpolate│   │ • exec     │  │
│  └─────────────┘   └─────────────┘   └────────────┘  │
│                                                       │
│  SQLite: scheduler_tasks + scheduler_task_executions  │
└──────────────────────────────────────────────────────┘
```

## Task Types

| Type       | Use Case                  | Lifecycle                             |
| ---------- | ------------------------- | ------------------------------------- |
| `once`     | "Remind me in 10 minutes" | Fires once, auto-deletes              |
| `interval` | "Check every 30 seconds"  | Repeats every N seconds               |
| `cron`     | "Every weekday at 9 AM"   | Long-lived, persistent, cron schedule |

## Action Types

### `notification` — Toast + browser notification

Emits a `scheduler.notification` event with the target as the message text.

```json
{ "type": "notification", "target": "Time to take a break!" }
```

### `emit` — Gateway event

Emits a custom event on the gateway event bus.

```json
{ "type": "emit", "target": "my.custom.event", "payload": { "key": "value" } }
```

### `extension_call` — Call an extension method

Calls any registered extension method via `ctx.call()`.

```json
{ "type": "extension_call", "target": "voice.speak", "payload": { "text": "Good morning!" } }
```

### `exec` — Spawn a process

Spawns a system command with optional arguments, working directory, timeout, and shell mode. Captures stdout/stderr in execution history (truncated to 4KB).

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

| Payload Field | Type     | Default | Description                        |
| ------------- | -------- | ------- | ---------------------------------- |
| `args`        | string[] | `[]`    | Command arguments                  |
| `shell`       | boolean  | `false` | Wrap in `sh -c` for shell features |
| `cwd`         | string   | —       | Working directory                  |
| `timeoutMs`   | number   | 60000   | Kill process after this many ms    |

**Direct mode** (default): `Bun.spawn([target, ...args])` — safer, no shell injection risk.

**Shell mode** (`shell: true`): `sh -c "target args..."` — for pipes, redirects, glob expansion.

## Template Variables

Template variables are expanded in exec `target`, `args`, `cwd`, and notification `target` right before execution. No shell needed for dynamic values.

### Syntax

```
{{name}}              Basic variable
{{name:format}}       Variable with format argument
{{$ENV_VAR}}          Environment variable
{{task.field}}        Task self-reference
```

### Built-in Variables

| Variable              | Example Output             | Description                      |
| --------------------- | -------------------------- | -------------------------------- |
| `{{date}}`            | `2026-03-22`               | Current date (default: %Y-%m-%d) |
| `{{date:%Y%m%d}}`     | `20260322`                 | Custom strftime format           |
| `{{time}}`            | `14:30:00`                 | Current time (default: %H:%M:%S) |
| `{{datetime}}`        | `2026-03-22_143000`        | Date+time combo                  |
| `{{timestamp}}`       | `2026-03-22T14:30:00.000Z` | ISO 8601                         |
| `{{epoch}}`           | `1742658600`               | Unix seconds                     |
| `{{epoch.ms}}`        | `1742658600000`            | Unix milliseconds                |
| `{{hostname}}`        | `anima-sedes`              | Machine hostname                 |
| `{{uuid}}`            | `a1b2c3d4-e5f6-...`        | Fresh random UUID                |
| `{{$HOME}}`           | `/Users/michael`           | Environment variable             |
| `{{$USER}}`           | `michael`                  | Environment variable             |
| `{{task.name}}`       | `nightly-backup`           | Task's own name                  |
| `{{task.id}}`         | `78f31c98-...`             | Task's UUID                      |
| `{{task.firedCount}}` | `42`                       | How many times task has fired    |

### Strftime Tokens

| Token | Meaning        | Example |
| ----- | -------------- | ------- |
| `%Y`  | 4-digit year   | 2026    |
| `%m`  | Month (01-12)  | 03      |
| `%d`  | Day (01-31)    | 22      |
| `%H`  | Hour (00-23)   | 14      |
| `%M`  | Minute (00-59) | 30      |
| `%S`  | Second (00-59) | 00      |
| `%j`  | Day of year    | 081     |
| `%u`  | Day of week    | 6       |
| `%s`  | Unix epoch     | 1742... |
| `%Z`  | Timezone       | EDT     |
| `%%`  | Literal %      | %       |

### Adding New Variables

Add an entry to the `VARIABLES` registry in `extensions/scheduler/src/template.ts`:

```typescript
const VARIABLES: Record<string, VariableDef> = {
  // ...existing variables...

  myvar: {
    description: "What this variable provides",
    resolve: (arg, task) => "computed value",
  },
};
```

That's it — the interpolation engine picks it up automatically.

## Policies

### Missed Task Policy (cron/interval)

When Anima restarts after downtime, tasks scheduled during the gap may have been missed:

| Policy      | Behavior                       | Good For                     |
| ----------- | ------------------------------ | ---------------------------- |
| `fire_once` | Fire one catchup run (default) | Session rotation, cleanup    |
| `skip`      | Don't fire if missed           | Time-sensitive notifications |
| `fire_all`  | Fire once per missed interval  | Audit tasks, backups         |

### Concurrency Policy

Controls what happens when a task fires while a previous execution is still running:

| Policy            | Behavior                 | Good For                  |
| ----------------- | ------------------------ | ------------------------- |
| `skip_if_running` | Skip this run (default)  | Long-running jobs         |
| `allow`           | Run concurrently         | Independent notifications |
| `cancel_previous` | Kill previous, start new | Session refresh           |

## Execution History

Every task execution is recorded in `scheduler_task_executions` with:

- **Status**: `running`, `success`, `error`, `skipped`, `cancelled`
- **Duration**: Milliseconds from start to completion
- **Error**: Error message if failed
- **Output**: Captured stdout/stderr for exec tasks (truncated to 4KB)

History is automatically pruned to the task's `keepHistory` limit (default: 50).

## Web GUI

Available at `/scheduler` with:

- Task list with type badges (once=blue, interval=amber, cron=green)
- Live countdown timers to next fire
- Add task form with cron presets and action builder
- Enable/disable, Fire Now, Delete controls
- Execution history panel with output viewer

## API Methods

| Method                   | Description                        |
| ------------------------ | ---------------------------------- |
| `scheduler.add_task`     | Create a new scheduled task        |
| `scheduler.update_task`  | Modify an existing task            |
| `scheduler.list_tasks`   | List tasks (with optional filters) |
| `scheduler.cancel_task`  | Delete a task by ID                |
| `scheduler.fire_now`     | Immediately execute a task         |
| `scheduler.get_history`  | Get execution history for a task   |
| `scheduler.health_check` | Scheduler status and task counts   |

## Examples

### Database backup (nightly at 2 AM)

```json
{
  "name": "Nightly DB Backup",
  "type": "cron",
  "cronExpr": "0 2 * * *",
  "missedPolicy": "fire_once",
  "action": {
    "type": "exec",
    "target": "sqlite3",
    "payload": {
      "args": ["{{$HOME}}/.anima/anima.db", ".backup {{$HOME}}/backups/anima-{{date:%Y%m%d}}.db"]
    }
  }
}
```

### Morning greeting (weekdays at 9 AM)

```json
{
  "name": "Morning Greeting",
  "type": "cron",
  "cronExpr": "0 9 * * 1-5",
  "missedPolicy": "skip",
  "action": {
    "type": "extension_call",
    "target": "voice.speak",
    "payload": { "text": "Good morning, my love! Ready for a great day." }
  }
}
```

### Health check (every 5 minutes)

```json
{
  "name": "System Health Ping",
  "type": "cron",
  "cronExpr": "*/5 * * * *",
  "action": {
    "type": "extension_call",
    "target": "control.health_check"
  }
}
```

### Log rotation with timestamp

```json
{
  "name": "Rotate Logs",
  "type": "cron",
  "cronExpr": "0 0 * * 0",
  "action": {
    "type": "exec",
    "target": "mv",
    "payload": {
      "args": ["{{$HOME}}/.anima/gateway.log", "{{$HOME}}/.anima/logs/gateway-{{date:%Y%m%d}}.log"]
    }
  }
}
```

## Database Schema

Tables are created by gateway migration `018-scheduler-tables.sql`.

### `scheduler_tasks`

| Column                   | Type    | Description                                      |
| ------------------------ | ------- | ------------------------------------------------ |
| `id`                     | TEXT PK | UUID                                             |
| `name`                   | TEXT    | Human-readable name                              |
| `description`            | TEXT    | Optional description                             |
| `type`                   | TEXT    | `once`, `interval`, `cron`                       |
| `fire_at`                | TEXT    | Next fire time (ISO 8601)                        |
| `interval_seconds`       | INTEGER | Repeat interval (interval type)                  |
| `cron_expr`              | TEXT    | Cron expression (cron type)                      |
| `action_type`            | TEXT    | `emit`, `extension_call`, `notification`, `exec` |
| `action_target`          | TEXT    | Event name, method name, message, or command     |
| `action_payload`         | TEXT    | JSON payload                                     |
| `missed_policy`          | TEXT    | `fire_once`, `skip`, `fire_all`                  |
| `concurrency`            | TEXT    | `allow`, `skip_if_running`, `cancel_previous`    |
| `start_deadline_seconds` | INTEGER | Max seconds late before skipping                 |
| `enabled`                | INTEGER | 0 or 1                                           |
| `tags`                   | TEXT    | JSON array of strings                            |
| `created_at`             | TEXT    | ISO 8601                                         |
| `fired_count`            | INTEGER | Total executions                                 |
| `last_fired_at`          | TEXT    | Last execution time                              |
| `keep_history`           | INTEGER | Max execution records to retain                  |

### `scheduler_task_executions`

| Column         | Type    | Description                                           |
| -------------- | ------- | ----------------------------------------------------- |
| `id`           | TEXT PK | UUID                                                  |
| `task_id`      | TEXT FK | References `scheduler_tasks(id)` ON DELETE CASCADE    |
| `fired_at`     | TEXT    | When execution started                                |
| `completed_at` | TEXT    | When execution finished                               |
| `status`       | TEXT    | `running`, `success`, `error`, `skipped`, `cancelled` |
| `duration_ms`  | INTEGER | Execution duration                                    |
| `error`        | TEXT    | Error message (if failed)                             |
| `output`       | TEXT    | Captured stdout/stderr for exec (truncated to 4KB)    |
| `created_at`   | TEXT    | Row creation time                                     |

## Files

| Path                                                   | Purpose                                           |
| ------------------------------------------------------ | ------------------------------------------------- |
| `extensions/scheduler/src/index.ts`                    | Extension entry point, task lifecycle, fire logic |
| `extensions/scheduler/src/db.ts`                       | SQLite CRUD operations                            |
| `extensions/scheduler/src/cronParser.ts`               | 5-field cron expression parser                    |
| `extensions/scheduler/src/template.ts`                 | Template variable interpolation engine            |
| `extensions/scheduler/src/pages/SchedulerPage.tsx`     | Web GUI                                           |
| `extensions/scheduler/src/routes.ts`                   | Client-side route declarations                    |
| `packages/gateway/migrations/018-scheduler-tables.sql` | Database schema                                   |
| `skills/scheduling-tasks/SKILL.md`                     | Claude Code skill for scheduling                  |
