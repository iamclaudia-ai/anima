# Scheduler V2 — Cron, SQLite, and GUI

## Goal

Evolve the scheduler from a simple timer with JSON storage into a full task management system that replaces the need for external LaunchAgents, adds cron scheduling, persists to SQLite, and provides a web GUI for management.

## Current State

- **Storage**: JSON file at `~/.anima/scheduled-tasks.json`
- **Task types**: `once` (fire and delete), `interval` (repeat every N seconds)
- **Actions**: `emit`, `notification`, `extension_call`
- **Check loop**: Polls every 5 seconds
- **UI**: None (CLI only, health stats in Mission Control)
- **Unused code**: Cron parser (`cronParser.ts`) and webhook server (`webhookServer.ts`) are built but not wired in

## Design Principles

- **One scheduler to rule them all** — No more managing LaunchAgents separately. The only LaunchAgent is `com.anima.watchdog.plist` (the bootstrap). Everything else lives in the scheduler.
- **Steal from the best** — systemd's `Persistent=`, Kubernetes' `concurrencyPolicy` and `startingDeadlineSeconds`, LaunchAgent's "fire once on wake" behavior.
- **SQLite for durability** — Execution history, atomic updates, query efficiency, concurrent access safety.
- **GUI for visibility** — See what's scheduled, what fired, what failed, all in one place.

## Task Types

| Type       | Use Case                  | Lifecycle                                     |
| ---------- | ------------------------- | --------------------------------------------- |
| `once`     | "Remind me in 10 minutes" | Fires at a specific time, auto-deletes        |
| `interval` | "Check every 30 seconds"  | Repeats every N seconds, in-memory feel       |
| `cron`     | "Every weekday at 9 AM"   | Long-lived, persistent, replaces LaunchAgents |

## Missed Task Policies

When Anima restarts after downtime, cron tasks may have been missed. Each task declares its own policy:

| Policy      | Behavior                                  | Good For                                     |
| ----------- | ----------------------------------------- | -------------------------------------------- |
| `fire_once` | Fire one catchup run on restart (default) | Session rotation, cleanup jobs               |
| `skip`      | Don't fire if missed                      | Daily greeting, time-sensitive notifications |
| `fire_all`  | Fire once per missed interval             | Audit logs, billing (unlikely for us)        |

## Concurrency Policies

What happens if a task's previous run is still executing:

| Policy            | Behavior                 | Good For                             |
| ----------------- | ------------------------ | ------------------------------------ |
| `skip_if_running` | Skip this run (default)  | Memory processing, long-running jobs |
| `allow`           | Run concurrently         | Independent notifications            |
| `cancel_previous` | Kill previous, start new | Session refresh                      |

## Task Schema

```typescript
interface ScheduledTask {
  id: string;
  name: string;
  description?: string;

  // Type + schedule
  type: "once" | "interval" | "cron";
  fireAt: string; // Next fire time (ISO)
  intervalSeconds?: number; // For interval type
  cronExpr?: string; // For cron type: "0 9 * * 1-5"

  // Action
  action: {
    type: "emit" | "extension_call" | "notification";
    target: string;
    payload?: Record<string, unknown>;
  };

  // Policies
  missedPolicy: "fire_once" | "skip" | "fire_all";
  concurrency: "allow" | "skip_if_running" | "cancel_previous";
  startDeadlineSeconds?: number; // Skip if missed by more than N seconds

  // Metadata
  enabled: boolean;
  tags?: string[]; // For grouping: "voice", "maintenance", "reminders"
  createdAt: string;
  firedCount: number;
  lastFiredAt?: string;

  // History
  keepHistory: number; // How many executions to retain (default: 50)
}
```

## SQLite Schema

```sql
-- Core task definition
CREATE TABLE tasks (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  type        TEXT NOT NULL CHECK(type IN ('once', 'interval', 'cron')),
  fire_at     TEXT NOT NULL,           -- ISO timestamp of next fire
  interval_seconds INTEGER,
  cron_expr   TEXT,
  action_type TEXT NOT NULL CHECK(action_type IN ('emit', 'extension_call', 'notification')),
  action_target TEXT NOT NULL,
  action_payload TEXT,                 -- JSON
  missed_policy TEXT NOT NULL DEFAULT 'fire_once',
  concurrency TEXT NOT NULL DEFAULT 'skip_if_running',
  start_deadline_seconds INTEGER,
  enabled     INTEGER NOT NULL DEFAULT 1,
  tags        TEXT,                    -- JSON array
  created_at  TEXT NOT NULL,
  fired_count INTEGER NOT NULL DEFAULT 0,
  last_fired_at TEXT,
  keep_history INTEGER NOT NULL DEFAULT 50
);

-- Execution history
CREATE TABLE task_executions (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  fired_at    TEXT NOT NULL,
  completed_at TEXT,
  status      TEXT NOT NULL CHECK(status IN ('running', 'success', 'error', 'skipped', 'cancelled')),
  duration_ms INTEGER,
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_executions_task ON task_executions(task_id, fired_at DESC);
CREATE INDEX idx_tasks_fire_at ON tasks(fire_at) WHERE enabled = 1;
```

## New API Methods

Existing methods stay the same but gain new fields. New methods:

| Method                   | Description                                                         |
| ------------------------ | ------------------------------------------------------------------- |
| `scheduler.add_task`     | Updated — accepts `cronExpr`, `missedPolicy`, `concurrency`, `tags` |
| `scheduler.update_task`  | New — modify an existing task's schedule, action, or policies       |
| `scheduler.list_tasks`   | Updated — supports filtering by `type`, `tags`, `enabled`           |
| `scheduler.cancel_task`  | Same                                                                |
| `scheduler.fire_now`     | New — immediately execute a task (ignoring schedule)                |
| `scheduler.get_history`  | New — return execution history for a task                           |
| `scheduler.health_check` | Updated — richer metrics                                            |

## GUI Design

New page at `/scheduler` (added to control extension or as its own extension page).

### Task List View

```
┌─────────────────────────────────────────────────────┐
│  Scheduled Tasks                        [+ Add Task]│
├─────────────────────────────────────────────────────┤
│                                                     │
│  🟢 Session Rotation          cron    ⏱ in 2h 15m  │
│     0 */6 * * *  ·  maintenance       [···]         │
│                                                     │
│  🟢 Memory Processing         cron    ⏱ in 45m     │
│     */30 * * * *  ·  maintenance      [···]         │
│                                                     │
│  🟡 Morning Greeting          cron    ⏱ tomorrow   │
│     0 9 * * 1-5  ·  voice             [···]         │
│                                                     │
│  🔵 Standup Reminder          once    ⏱ in 8m      │
│     10:00 AM today  ·  reminders      [···]         │
│                                                     │
│  ⚫ Weekly Backup             cron    disabled      │
│     0 2 * * 0  ·  maintenance         [···]         │
│                                                     │
└─────────────────────────────────────────────────────┘

[···] menu: Fire Now | Edit | Disable/Enable | Delete | View History
```

### Task Detail / History View

```
┌─────────────────────────────────────────────────────┐
│  ← Session Rotation                                 │
│  0 */6 * * *  ·  Every 6 hours                      │
│  Policy: fire_once · skip_if_running                │
├─────────────────────────────────────────────────────┤
│  Recent Executions                                  │
│                                                     │
│  ✅ Mar 21, 9:00 AM     142ms    success            │
│  ✅ Mar 21, 3:00 AM     98ms     success            │
│  ⏭️ Mar 20, 9:00 PM     —        skipped (missed)   │
│  ✅ Mar 20, 3:00 PM     201ms    success            │
│  ❌ Mar 20, 9:00 AM     1,203ms  error: timeout     │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### Add Task Form

Quick presets for common patterns:

- "Every N minutes/hours"
- "Daily at [time]"
- "Weekdays at [time]"
- "Custom cron expression"

Action builder:

- Notification (just enter message text)
- Voice announcement (text → `voice.speak`)
- Extension call (method picker + payload)
- Custom event (event name + payload)

## Startup / Catchup Flow

On extension start:

```
1. Load all enabled cron tasks from SQLite
2. For each task where fire_at < now:
   a. Check missedPolicy:
      - skip → set fire_at to next cron occurrence, log as skipped
      - fire_once → fire the task once, then set fire_at to next occurrence
      - fire_all → fire once per missed interval (with startDeadlineSeconds cutoff)
   b. Check startDeadlineSeconds:
      - If missed by more than deadline, skip regardless of policy
3. Resume normal 5-second check loop
```

## Migration Path

### JSON → SQLite

On first start with V2:

1. Check if `~/.anima/scheduled-tasks.json` exists
2. If yes, read all tasks and insert into SQLite
3. Rename JSON file to `scheduled-tasks.json.migrated`
4. Log migration summary

All existing `once` and `interval` tasks get default policies:

- `missedPolicy: "fire_once"`
- `concurrency: "skip_if_running"`
- `keepHistory: 50`

## Implementation Phases

### Phase 1: SQLite Migration

- Create SQLite schema (tasks + task_executions tables)
- Migrate task CRUD from JSON to SQLite
- Add execution history recording
- Auto-migrate existing JSON tasks on first boot
- Update `health_check` with richer metrics
- **All existing functionality preserved, just different storage**

### Phase 2: Cron Task Type

- Wire in existing `cronParser.ts`
- Add `cron` as a third task type
- Implement `getNextRun()` for rescheduling after fire
- Add `scheduler.update_task` method
- Add `scheduler.fire_now` method
- Add `scheduler.get_history` method

### Phase 3: Missed Task Policies

- Implement startup catchup flow
- Add `missedPolicy`, `concurrency`, `startDeadlineSeconds` fields
- Record skipped executions in history
- Track `lastFiredAt` for intelligent catchup decisions

### Phase 4: Scheduler GUI

- Task list page with type badges, countdown timers, enable/disable toggles
- Task detail view with execution history
- Add task form with presets and action builder
- Wire into extension routes at `/scheduler`

### Phase 5: Polish

- Task tags and filtering
- Cron expression human-readable descriptions (already in cronParser)
- Notification toasts for task events in the web UI
- Wire in webhook server (external triggers creating tasks)

## Files to Create/Modify

### New Files

- `extensions/scheduler/src/db.ts` — SQLite schema, migrations, CRUD
- `extensions/scheduler/src/catchup.ts` — Startup missed-task logic
- `extensions/scheduler/src/routes.ts` — Client-side route declarations
- `extensions/scheduler/src/pages/SchedulerPage.tsx` — Main GUI page

### Modified Files

- `extensions/scheduler/src/index.ts` — Replace JSON with SQLite, add new methods
- `extensions/scheduler/src/cronParser.ts` — Wire into main scheduler
- `extensions/scheduler/package.json` — Add UI dependencies if needed

## Success Criteria

- [ ] All existing tasks work identically after SQLite migration
- [ ] Cron expressions schedule and fire correctly
- [ ] Missed tasks handled per policy on restart
- [ ] Execution history visible in GUI
- [ ] Can manage all tasks from `/scheduler` page
- [ ] No more need for external LaunchAgents (except watchdog bootstrap)
- [ ] Typecheck + tests pass
