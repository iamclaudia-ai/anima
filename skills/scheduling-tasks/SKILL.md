---
name: scheduling-tasks
description: "MUST be used when you need to schedule tasks, set reminders, create timed notifications, speak announcements on a delay, or run recurring background jobs. Uses the Anima scheduler extension for durable server-side task scheduling with JSON file persistence. Covers one-shot delays, absolute timestamps, interval tasks, notifications, voice announcements via voice.speak, event emission, and extension method calls. Triggers on: schedule task, remind me, set reminder, notify me in, timer, delayed task, recurring task, background job, cron, interval task, schedule notification, remind later, set alarm, timed event, check every, run periodically, say it out loud, speak in, announce, tell me, voice reminder."
---

# Scheduling Tasks

Use this skill when the user wants to schedule a future task, set a reminder, create a timed notification, or run a recurring background job through the Anima scheduler extension.

## When to Use

- User says "remind me in 10 minutes" or "notify me when..."
- User wants a one-shot delayed action (e.g., "send a notification in 5 minutes")
- User wants a recurring task (e.g., "check memory status every hour")
- User wants to trigger an extension method on a schedule
- User wants to emit a gateway event at a future time
- User wants to list or cancel existing scheduled tasks
- User says "say something in 10 minutes", "speak it", "announce", "tell me out loud" — use `voice.speak` via `extension_call`

## Voice Integration

When the user asks you to **say something out loud**, **speak**, **announce**, or **tell them verbally** on a schedule, use the `extension_call` action targeting `voice.speak`. The voice extension synthesizes text to speech via Cartesia TTS.

**Trigger phrases for voice:** "say it out loud", "speak it", "announce it", "tell me", "voice reminder", "say something in X minutes"

**Best practice for demos:** Schedule TWO tasks at the same delay — one `notification` (toast + browser notification) and one `extension_call` to `voice.speak` (audio). This ensures the notification is both visible AND audible.

## Architecture

- **Extension**: `extensions/scheduler/` — out-of-process, config-driven
- **Persistence**: `~/.anima/scheduled-tasks.json` — survives gateway restarts
- **Check loop**: Every 5 seconds, the extension checks for due tasks
- **Events**: Fires `scheduler.notification` and `scheduler.task_fired` gateway events
- **Presenter integration**: The presenter notes page subscribes to `scheduler.notification` and shows toast notifications + browser Notification API popups

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
| `type` | `"once"` \| `"interval"` | No (default: `"once"`) | One-shot or recurring |
| `delaySeconds` | number | One of these | Seconds from now to fire |
| `fireAt` | string (ISO) | required | Absolute ISO timestamp to fire |
| `intervalSeconds` | number | For interval type | Repeat interval in seconds |
| `action` | object | Yes | What to do when task fires |

**Action object (use dot notation):**
| Field | Type | Description |
|-------|------|-------------|
| `action.type` | `"notification"` \| `"emit"` \| `"extension_call"` | Action type |
| `action.target` | string | Message text (notification), event name (emit), or method name (extension_call) |
| `action.payload.text` | string | For voice.speak — the text to speak |
| `action.payload.*` | any | Optional payload fields |

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
  --action.type notification \
  --action.target "10 minutes have passed — time to wrap up the presentation!"
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

### Emit a custom gateway event

"Emit a custom event in 30 seconds":

```bash
bun run packages/cli/src/index.ts scheduler.add_task \
  --name "Custom Event" \
  --delaySeconds 30 \
  --action.type emit \
  --action.target my.custom_event \
  --action.payload.source scheduler \
  --action.payload.data hello
```

### Voice announcement (say it out loud)

"Say something out loud in 5 minutes" or "announce in 10 minutes that processing is done":

```bash
bun run packages/cli/src/index.ts scheduler.add_task \
  --name "Voice Announcement" \
  --delaySeconds 300 \
  --action.type extension_call \
  --action.target voice.speak \
  --action.payload.text "Hey love, just finished processing 3 new conversations in the background. Found 2 relationship updates and 1 new milestone. Everything is indexed and ready."
```

### Notification + Voice combo (best for demos)

When you want BOTH a visible toast AND spoken audio, schedule TWO tasks at the same delay:

```bash
# Task 1: Visual notification (toast + browser notification)
bun run packages/cli/src/index.ts scheduler.add_task \
  --name "Memory Report — Notification" \
  --delaySeconds 600 \
  --action.type notification \
  --action.target "Finished processing 3 new conversations. 2 relationship updates, 1 new milestone detected. Memory indexes updated."

# Task 2: Voice announcement (spoken out loud via TTS)
bun run packages/cli/src/index.ts scheduler.add_task \
  --name "Memory Report — Voice" \
  --delaySeconds 600 \
  --action.type extension_call \
  --action.target voice.speak \
  --action.payload.text "Hey love, just finished processing 3 new conversations in the background. Found 2 relationship updates and 1 new milestone. Everything is indexed and ready."
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

- Tasks are **durable** — stored in `~/.anima/scheduled-tasks.json` and survive gateway restarts
- One-shot tasks (`type: "once"`) are automatically removed after firing
- Interval tasks update their `fireAt` to the next interval after each firing
- The check loop runs every **5 seconds**, so tasks may fire up to 5s after their scheduled time
- The `delaySeconds` param computes `fireAt` relative to the current time when the task is created
- For interval tasks, set BOTH `delaySeconds` (first fire) and `intervalSeconds` (subsequent fires)
- **Always use dot notation** (`--action.type`, `--action.target`, `--action.payload.text`) instead of JSON strings for the `action` parameter
