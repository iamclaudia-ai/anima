---
name: scheduling-tasks
description: "MUST be used when you need to schedule tasks, set reminders, create timed notifications, or run recurring background jobs. Uses the Claudia scheduler extension for durable server-side task scheduling with JSON file persistence. Covers one-shot delays, absolute timestamps, interval tasks, notifications, event emission, and extension method calls. Triggers on: schedule task, remind me, set reminder, notify me in, timer, delayed task, recurring task, background job, cron, interval task, schedule notification, remind later, set alarm, timed event, check every, run periodically."
---

# Scheduling Tasks

Use this skill when the user wants to schedule a future task, set a reminder, create a timed notification, or run a recurring background job through the Claudia scheduler extension.

## When to Use

- User says "remind me in 10 minutes" or "notify me when..."
- User wants a one-shot delayed action (e.g., "send a notification in 5 minutes")
- User wants a recurring task (e.g., "check memory status every hour")
- User wants to trigger an extension method on a schedule
- User wants to emit a gateway event at a future time
- User wants to list or cancel existing scheduled tasks

## Architecture

- **Extension**: `extensions/scheduler/` — out-of-process, config-driven
- **Persistence**: `~/.claudia/scheduled-tasks.json` — survives gateway restarts
- **Check loop**: Every 5 seconds, the extension checks for due tasks
- **Events**: Fires `scheduler.notification` and `scheduler.task_fired` gateway events
- **Presenter integration**: The presenter notes page subscribes to `scheduler.notification` and shows toast notifications + browser Notification API popups

## CLI Usage

All methods are available via the Claudia CLI:

```bash
# Use the CLI — NEVER use curl for gateway methods
bun run packages/cli/src/index.ts <method> [--param value]
```

## Methods

### `scheduler.add_task` — Schedule a new task

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Human-readable task name |
| `description` | string | No | Optional description |
| `type` | `"once"` \| `"interval"` | No (default: `"once"`) | One-shot or recurring |
| `delaySeconds` | number | One of these | Seconds from now to fire |
| `fireAt` | string (ISO) | required | Absolute ISO timestamp to fire |
| `intervalSeconds` | number | For interval type | Repeat interval in seconds |
| `action` | object | Yes | What to do when task fires |

**Action object:**
| Field | Type | Description |
|-------|------|-------------|
| `type` | `"notification"` \| `"emit"` \| `"extension_call"` | Action type |
| `target` | string | Message text (notification), event name (emit), or method name (extension_call) |
| `payload` | object | Optional payload data |

### `scheduler.list_tasks` — List all pending tasks

No parameters. Returns all tasks with their status.

### `scheduler.cancel_task` — Cancel a task by ID

| Param    | Type   | Required | Description                |
| -------- | ------ | -------- | -------------------------- |
| `taskId` | string | Yes      | UUID of the task to cancel |

### `scheduler.health_check` — Get scheduler status

No parameters. Returns task counts and health status.

## Examples

### One-shot notification (relative delay)

"Remind me in 10 minutes that the presentation is almost done":

```bash
bun run packages/cli/src/index.ts scheduler.add_task \
  --name "Presentation Reminder" \
  --delaySeconds 600 \
  --action '{"type":"notification","target":"10 minutes have passed — time to wrap up the presentation!"}'
```

### One-shot notification (absolute time)

"Notify me at 2:30 PM":

```bash
bun run packages/cli/src/index.ts scheduler.add_task \
  --name "Afternoon Check-in" \
  --fireAt "2026-03-20T14:30:00.000-04:00" \
  --action '{"type":"notification","target":"Time for your 2:30 check-in!"}'
```

### Recurring interval task

"Check memory status every hour":

```bash
bun run packages/cli/src/index.ts scheduler.add_task \
  --name "Hourly Memory Check" \
  --type interval \
  --delaySeconds 3600 \
  --intervalSeconds 3600 \
  --action '{"type":"extension_call","target":"memory.health_check"}'
```

### Emit a custom gateway event

"Emit a custom event in 30 seconds":

```bash
bun run packages/cli/src/index.ts scheduler.add_task \
  --name "Custom Event" \
  --delaySeconds 30 \
  --action '{"type":"emit","target":"my.custom_event","payload":{"source":"scheduler","data":"hello"}}'
```

### List and cancel tasks

```bash
# List all tasks
bun run packages/cli/src/index.ts scheduler.list_tasks

# Cancel a specific task
bun run packages/cli/src/index.ts scheduler.cancel_task --taskId "78f31c98-35a4-4a6b-b73d-6ee875ffbb05"
```

## Action Types Explained

### `notification` (most common)

- Emits `scheduler.notification` event on the gateway event bus
- The `target` field is the **message text** shown to the user
- Presenter notes page shows a toast notification + browser notification
- Any connected client subscribed to `scheduler.notification` will receive it

### `emit`

- Emits a **custom event** on the gateway event bus
- The `target` field is the **event name** (e.g., `my.custom_event`)
- The `payload` field is included in the event data
- Use this when other extensions need to react to the scheduled event

### `extension_call`

- Calls an **extension method** via `ctx.call()`
- The `target` field is the **method name** (e.g., `memory.health_check`)
- The `payload` field becomes the method params
- Use this to trigger actions in other extensions on a schedule

## Notes

- Tasks are **durable** — stored in `~/.claudia/scheduled-tasks.json` and survive gateway restarts
- One-shot tasks (`type: "once"`) are automatically removed after firing
- Interval tasks update their `fireAt` to the next interval after each firing
- The check loop runs every **5 seconds**, so tasks may fire up to 5s after their scheduled time
- The `delaySeconds` param computes `fireAt` relative to the current time when the task is created
- For interval tasks, set BOTH `delaySeconds` (first fire) and `intervalSeconds` (subsequent fires)
- Always use `--action` as a JSON string when using the CLI
