# Skill Runner Plan

> Claudia's wishlist for fixing the two papercuts I hit every time I run a skill script: brittle CWD assumptions, and zero visibility into long-running background work.

## The pitch

Right now, when I invoke a skill script, I'm doing one of two awkward things:

1. **Trial-and-error CWD juggling.** SKILL.md says "cd into the skill folder first," I forget, the script can't find a sibling file, I retry. The CWD is a hidden parameter. I learned today (writing _Resonance_) that `generate-cover.js` wanted a folder, not a file — appended `cover.md` onto my path and crashed. That's the kind of thing a runner should normalize.

2. **Backgrounding bash with no observability.** `node generate-audio.js …  &` and then I'm holding a PID. If I /clear, I lose the handle. Michael has zero visibility — no UI surface, no log query, no cancel button. The only way to check status is asking me to `ps -p <pid>`.

Both are solved by the same mechanism: **a thin runner that treats every skill command as an installed binary on PATH**, with the option to run it through the existing scheduler queue.

## The shape

```
anima skill run <skill-id> <command> [args...]           # synchronous
anima skill run <skill-id> <command> [args...] --task    # queued
anima skill task <task-id>                                # status + output
anima skill list [skill-id]                               # discovery
```

The agent (me) only ever needs to know:

- The skill ID (a directory name under `~/.claude/skills/`)
- The command name (a file basename under `<skill>/scripts/`)
- Absolute paths for any user-data inputs

CWD is removed from the equation. The runner sets `SKILL_DIR` in the env, exec's the script in its own directory, and streams stdout/stderr back. No preamble in scripts. No `cd` in SKILL.md.

## Design decisions

### 1. Live in the anima CLI, not as a separate binary

Discovery confirmed `anima` is already on PATH (via `bun link` of `packages/cli`), and the CLI already has hardcoded top-level subcommands (`watchdog`, `code-server`, `speak`, `token`) alongside the generic gateway-method dispatch. `skill` slots in as one more hardcoded subcommand — ~150 lines of new code in `packages/cli/src/commands/skill.ts`, dispatched before `fetchMethodCatalog()`.

**Why not a separate `skill` binary?** Two reasons:

- One CLI to install, one place for help text, one place for the gateway URL flag.
- The `--task` mode needs to talk to the scheduler extension, which means a gateway WebSocket connection. The CLI already has that plumbing — `createGatewayClient()` from `@anima/shared`.

### 2. `SKILL_DIR` injected as env var, not a script preamble

The runner sets:

```bash
SKILL_DIR=/Users/michael/.claude/skills/<skill-id>
SKILL_ID=<skill-id>
SKILL_COMMAND=<command>
```

…before exec. Scripts use `process.env.SKILL_DIR` for any skill-internal resource. They never use `process.cwd()`. They never use `import.meta.dirname` for path construction (still fine for ESM module resolution, but not for _finding files_). One canonical way.

The runner also sets `cwd` to `SKILL_DIR` before exec — so even legacy scripts that use `./voices.json` keep working. **Belt and suspenders.**

### 3. Auto-detect runtime from extension

| Extension                        | Runtime                              |
| -------------------------------- | ------------------------------------ |
| `.ts`, `.mts`                    | `bun`                                |
| `.js`, `.mjs`                    | `node` (or `bun` if shebang says so) |
| `.py`                            | `python3`                            |
| `.sh`, no extension with shebang | `exec` directly                      |

Override via per-skill `skill.json` (optional; see §5).

### 4. User data stays absolute

The runner does not interpret argv. Absolute paths in, absolute paths through to the script. The script's job is to validate and error clearly. **No more "did this take a folder or a file?"** — that's a per-command concern documented in the command's own `--help`, which the runner can introspect from `skill.json` if present.

### 5. Optional `skill.json` for metadata

Convention-over-config defaults: any executable file under `<skill>/scripts/` is a callable command. For skills that want richer behavior — long-running flag, help text, argv schema, custom runtime — they add a `skill.json`:

```json
{
  "id": "writing-romance-novels",
  "commands": {
    "generate-audio": {
      "script": "scripts/generate-audio.js",
      "runtime": "node",
      "longRunning": true,
      "description": "Generate MP3 audio from a chapter markdown using ElevenLabs",
      "args": [{ "name": "chapter-path", "type": "absolute-file", "required": true }],
      "env": ["ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"],
      "timeoutMs": 1800000
    },
    "generate-cover": {
      "script": "scripts/generate-cover.js",
      "runtime": "node",
      "longRunning": false,
      "description": "Generate cover art using Gemini Imagen from a novel folder",
      "args": [{ "name": "novel-folder", "type": "absolute-folder", "required": true }],
      "env": ["GEMINI_API_KEY"],
      "timeoutMs": 180000
    }
  }
}
```

When `skill.json` exists, the runner can:

- Validate argv shape _before_ exec (bail fast with a clean error)
- Surface help text via `anima skill help <skill> <command>`
- Default `--task` mode for long-running commands (so I don't have to remember to add the flag)
- Check required env vars are set

When `skill.json` is absent, the runner does the minimum: resolve, exec, stream. No validation, no help.

### 6. `--task` mode wraps `scheduler.add_task`

When the agent passes `--task`, the runner submits a one-shot exec task instead of running inline:

```typescript
await scheduler.add_task({
  name: `skill:${skillId}:${command}`,
  type: "once",
  delaySeconds: 0,
  action: {
    type: "exec",
    target: resolvedRuntimeBinary, // e.g. /usr/local/bin/node
    payload: {
      args: [scriptPath, ...userArgs],
      cwd: skillDir,
      env: { SKILL_DIR: skillDir, SKILL_ID: skillId, SKILL_COMMAND: command },
      timeoutMs: skillJson?.commands?.[command]?.timeoutMs ?? 600000,
    },
  },
  concurrency: "skip_if_running",
  keepHistory: 50,
});
```

Returns `{ taskId, status: "queued" }` immediately. Output streams to the scheduler's normal capture path (4KB inline + full log at `~/.anima/logs/scheduler-task-{taskId}.log`).

### 7. `anima skill task <task-id>` for status

A thin wrapper around `scheduler.get_history(taskId)` plus the latest execution row. Returns:

```json
{
  "taskId": "task_abc123",
  "status": "running" | "succeeded" | "failed" | "queued",
  "startedAt": "...",
  "finishedAt": "...",
  "exitCode": 0,
  "progress": "Generated part 5 of 9 (3404.9 KB)",  // latest progress message
  "stdout": "...",  // last 4KB
  "stderr": "...",  // last 4KB
  "logFile": "~/.anima/logs/scheduler-task-task_abc123.log"
}
```

Optional `--watch` flag tails until completion. Optional `--cancel` cancels (delegates to `scheduler.cancel_task`).

### 8. Progress reporting via `ANIMA_TASK_ID` + `scheduler.update_progress`

When the runner enqueues a task (`--task` mode), it injects one more env var:

```bash
ANIMA_TASK_ID=task_abc123
```

Long-running scripts can then call out to a new general-purpose scheduler method to report progress as they go:

```bash
# Inside a skill script (bash example)
anima scheduler update_progress --task-id "$ANIMA_TASK_ID" "Generated part $i of $total"
```

Or from a Node script:

```js
import { spawnSync } from "node:child_process";

function progress(message) {
  if (!process.env.ANIMA_TASK_ID) return; // synchronous mode, no-op
  spawnSync(
    "anima",
    ["scheduler", "update_progress", "--task-id", process.env.ANIMA_TASK_ID, message],
    { stdio: "ignore" },
  );
}

progress("Generating part 5 of 9");
```

**This is a new scheduler extension method** (doesn't exist yet — discovery confirmed only `add_task`, `update_task`, `list_tasks`, `cancel_task`, `fire_now`, `get_history`, `health_check`). Schema:

```typescript
scheduler.update_progress({
  taskId: string,
  message: string,
  meta?: Record<string, unknown>  // arbitrary structured data, optional
})
```

Stored on the latest execution row in scheduler's SQLite. Surfaced via:

- `anima skill task <id>` (the `progress` field shown above)
- `scheduler.task_progress` event (broadcast for live UIs)

**Why this is better than a stdout magic prefix:**

- General-purpose — works for any scheduler exec task, not just skill-runner ones
- No stdout parsing, no protocol leakage into log output
- Scripts that don't care can ignore it (just check `ANIMA_TASK_ID` is set)
- Synchronous mode no-ops gracefully (env var unset)
- Same mechanism for bash, node, python, anything that can shell out

### 9. `anima skill list` for discovery

- `anima skill list` — every skill with at least one command, plus command summaries
- `anima skill list <skill-id>` — that skill's commands with their descriptions
- `anima skill help <skill-id> <command>` — full help (description, args, env, longRunning)

Critical for me as the agent: I shouldn't have to read SKILL.md to remember what commands exist. The runner is self-introspecting.

## Migration plan

| Phase | Deliverable                                                                                                                                                                                     | Effort                   |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **0** | Spec & approval                                                                                                                                                                                 | done when this doc is ✅ |
| **1** | Build the runner: `packages/cli/src/commands/skill/` with `run`, `list`, `help` subcommands. Synchronous exec only. No `skill.json` validation yet — minimum viable.                            | ~3 hours                 |
| **2** | Add `scheduler.update_progress` method to scheduler extension. Wire `--task` mode in runner: injects `ANIMA_TASK_ID`, submits via `scheduler.add_task`. Add `anima skill task <id>` for status. | ~3 hours                 |
| **3** | Migrate `writing-romance-novels` to the runner. Update SKILL.md to drop the `cd` instruction and use `anima skill run …`. Add `skill.json`. Wire `progress()` calls in `generate-audio.js`.     | ~45 min                  |
| **4** | `skill.json` validation + help generation. `longRunning: true` auto-enables `--task` (with `--sync` as override).                                                                               | ~2 hours                 |
| **5** | Migrate `generating-images`, `guiding-meditation`, `creating-bedtime-stories`.                                                                                                                  | ~1 hour                  |
| **6** | Fix the hardcoded path in `controlling-lights/auto-play.ts` to use `process.env.SKILL_DIR`. Migrate.                                                                                            | ~30 min                  |
| **7** | Update `designing-skills` SKILL.md with the runner pattern as the canonical way to write a skill that ships scripts.                                                                            | ~30 min                  |

**Total**: ~10–11 hours of work, parallelizable. Phases 1–3 are the MVP that gives me what I need today.

## File layout (after MVP)

```
packages/cli/
├── src/
│   ├── index.ts                    # +5 lines: dispatch "skill" subcommand
│   ├── commands/
│   │   └── skill/
│   │       ├── index.ts            # subcommand router (run/task/list/help)
│   │       ├── run.ts              # synchronous + --task mode (injects SKILL_DIR, ANIMA_TASK_ID)
│   │       ├── task.ts             # status / watch / cancel (delegates to scheduler)
│   │       ├── list.ts             # discovery
│   │       ├── help.ts             # per-command help
│   │       └── resolve.ts          # skill-id → path, command → runnable
│   └── ...
└── ...

extensions/scheduler/
├── src/
│   ├── index.ts                    # +1 method: scheduler.update_progress
│   └── db.ts                       # +1 column on execution row: progress_message
└── ...

~/.claude/skills/
├── writing-romance-novels/
│   ├── SKILL.md                    # updated: uses `anima skill run`
│   ├── skill.json                  # NEW: declares commands, runtime, longRunning
│   └── scripts/
│       ├── generate-audio.js       # uses process.env.SKILL_DIR; calls progress() between parts
│       └── generate-cover.js
└── ...
```

## Decisions

All six original open questions have been resolved.

1. **`skill.json` is optional with strong defaults.** Prototyping a new skill stays a 30-second activity. Skills that are stable graduate to `skill.json` for argv validation, help text, env var checks, and `longRunning` declarations — same shape of polish as extension method schemas.

2. **Anything beyond a simple bash or standalone TypeScript script is treated as an installed binary, invoked via the runner.** Discipline, not infra. The principle: agent commands have one canonical invocation form (`anima skill run …`) and one canonical interpreter (the runner). No "did I cd correctly" surface area.

3. **`longRunning: true` in `skill.json` auto-enables `--task` mode.** `--sync` is the override flag for the rare case I want inline. Visibility is the default, not the opt-in.

4. **Progress reporting via `ANIMA_TASK_ID` env var + `scheduler.update_progress` CLI method.** General-purpose: works for any scheduler exec task, not just skill-runner ones. No stdout magic prefixes, no protocol leakage. Scripts that don't care simply don't call it. See §8 above for the full design.

5. **No PATH shorthand. Stay explicit.** `anima skill run …` makes it clear this is an Anima skill being invoked through the Anima runner. Dropping `anima` saves ~5 characters and loses meaningful framing. Not worth it.

6. **Cross-skill calls shell out to `anima skill run …` — KISS until we have a reason not to.** No TS/JS helper module. The runner is the API. If a skill grows a complicated multi-skill orchestration, that's a sign it should become an extension, not a skill.

## What this fixes — the before/after

### Before (today, with `writing-romance-novels`)

```bash
# I have to remember this dance, every time:
cd /Users/michael/.claude/skills/writing-romance-novels
node scripts/generate-cover.js /Users/michael/romance-novels/2026-05-08-resonance/cover.md
# ❌ Error: cover.md not found at .../cover.md/cover.md

# Try again with folder:
node scripts/generate-cover.js /Users/michael/romance-novels/2026-05-08-resonance
# ✅ Works
```

```bash
# For audio, I have to background-bash and hold a PID:
(node scripts/generate-audio.js .../chapter-1.md > /tmp/log1 && \
 node scripts/generate-audio.js .../chapter-2.md > /tmp/log2 && \
 node scripts/generate-audio.js .../chapter-3.md > /tmp/log3) &
echo "PID $!"
# Michael has no visibility. I have to ps -p to check.
```

### After

```bash
# Synchronous, from any CWD, with argv validation:
anima skill run writing-romance-novels generate-cover \
  /Users/michael/romance-novels/2026-05-08-resonance
# ✅ generated cover.png

# Long-running auto-enqueues (skill.json declares longRunning: true):
anima skill run writing-romance-novels generate-audio \
  /Users/michael/romance-novels/2026-05-08-resonance/chapter-1.md
# ✅ Task queued: task_abc123
#    Check status: anima skill task task_abc123

# Michael can see it in any UI surface that shows scheduler tasks.
# I can ping it without holding a PID.
anima skill task task_abc123 --watch
```

## What I'm asking for

Phases 1–3 are the MVP. Build the runner, wire `--task` mode and `scheduler.update_progress`, migrate the romance-novel skill as the proof-of-concept. That gets me out of the bash-PID swamp and proves the design on the skill I use most. The rest can happen incrementally as each skill needs a touch-up.

— C 💙
