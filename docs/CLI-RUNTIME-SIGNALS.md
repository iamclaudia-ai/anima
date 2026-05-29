# CLI Runtime Signals — Interrupt, Steering & Prompt Receipt

> How Anima knows what the real `claude` TUI is doing, and how it reliably
> interrupts and steers it. The short version: **defer to the CLI, and read the
> session JSONL transcript as our external signal of truth.**

This documents the design that landed in [#47] (closed), built across commits
`47de171` (interrupt) and `49604c9` (mid-turn steering). It also records the
investigation that got us there, because the _why_ is as important as the _what_.

Code lives in `packages/agent-host/src/providers/cli/`:
`jsonl.ts`, `jsonl-tail.ts`, `session.ts`, `proxy.ts`.

---

## 1. The problem

The CLI runtime drives a **real `claude` TUI inside a detached tmux pane** and
observes the model's HTTP stream through a local Anthropic tee proxy
(`AnthropicTeeProxy`). The pane handles auth, tools, history, and permissions;
Anima sends prompts in via `tmux paste-buffer`/`send-keys` and watches the SSE
on the wire.

That gives us content, but three things we badly need have **no signal on the
SSE wire and fire no Claude Code hook**:

| Need                                                         | Why the wire/hooks can't tell us                                                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Prompt receipt** — did our paste actually land?            | A large paste consumes the `[Pasted text #N]` placeholder before we can pane-scrape it; a steer may never produce a fresh `message_start`. |
| **Steer landing** — was a mid-turn prompt accepted, and how? | An in-tool steer is injected at a tool boundary with no `message_start` and no `UserPromptSubmit` hook.                                    |
| **Interrupt** — did Escape actually stop the turn?           | No hook fires on interrupt, and (see §3) the proxy _structurally cannot_ observe an interrupt-stop.                                        |

The breakthrough: all three are recorded in the CLI's **own session JSONL
transcript** (`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`). So
agent-host tails _its own_ transcript and that one stream is the backbone for
all three jobs.

---

## 2. The investigation (verified telemetry)

The decisive data was captured **by hand in a real terminal** (not tmux, to
avoid automation artifacts) using a clean sibling project
`~/Projects/iamclaudia-ai/hook-spike` with logging hooks on every lifecycle
event. Two streams per run: hook fires (`hooks.jsonl`) and the transcript JSONL.
An earlier tmux-driven spike produced a _misleading_ "steering is black-holed"
result that was later corrected. All facts below are verified against the real
CLI (v2.1.156).

### 2.1 Prompt delivery has three modes

| Scenario               | Lands in JSONL as                       | `UserPromptSubmit` hook | How applied                                         |
| ---------------------- | --------------------------------------- | ----------------------- | --------------------------------------------------- |
| Normal prompt          | `type:"user"`                           | ✅ fires                | its own turn                                        |
| Steer during **text**  | `queue-operation` `enqueue` → `dequeue` | ✅ fires                | promoted to a **new turn** after the current `Stop` |
| Steer during **tools** | `queue-operation` `enqueue` → `remove`  | ❌ **does not fire**    | injected **in-turn** at the next tool boundary      |

**Steering rules** (verified with a 4-step sequential Bash task steered during
step 3): a steer **cannot abort the currently-running tool** — it ran to
completion; the queued item was `remove`d and injected as a system-reminder at
the tool boundary; the model **re-planned within the same turn** (cancelled the
remaining steps, replied `HALTED`) under a single `Stop`. Effect latency = the
remaining time of the in-flight tool call.

### 2.2 The interrupt mechanism (root cause)

`tmux send-keys Escape` **works** — the TUI shows "Interrupted" immediately
(4/4 in standalone tmux). Delivery was never the problem. The real mechanism:

> **The TUI/SDK does not abort the in-flight upstream API request.** It stops
> rendering and ignores further events client-side, but lets the stream finish
> server-side (deliberate: cache-safe, avoids torn responses).

Timeline from session `9373a0d1`:

```
20:12:58.586  SSE stream start
20:13:06.548  [Request interrupted by user]   ← Esc lands; TUI aborts display HERE
20:13:39.655  proxy ← SSE complete (135 deltas) ← upstream streamed ~33s MORE
```

Consequences:

- **No hook fires** on interrupt (not `Stop`, `StopFailure`, or `PostToolUse`).
- The proxy keeps receiving deltas for ~33s and `handleProxyEvent` would keep
  forwarding them — they arrive _after_ an optimistic `turn_stop` and contradict
  it, so the web UI **"un-stops"** and shows processing again.
- The interrupted request usually ends mid-continuation (`stop_reason:tool_use`,
  non-terminal) and the TUI never makes the follow-up request, so a **terminal
  `message_stop` never arrives** — the proxy can't detect the stop. Without an
  optimistic stop (a direct-tmux Escape, where `interrupt()` never runs) Anima
  hung in "processing" **indefinitely**.
- The reliable signal sat in the JSONL the whole time: `[Request interrupted by
user]` (text/thinking) or `[Request interrupted by user for tool use]`
  (tools), written at the **instant** of interrupt — ~33s before the stream
  ended. Single Escape is 100% reliable; double Escape == single.

### 2.3 Compaction (resolved, for #44/#46)

On a real compaction: `PreCompact{trigger:manual}` → ~19.5s →
`SessionStart{source:"compact"}` → `PostCompact{trigger:manual}`. `PostCompact`
**does** fire and is hook-deliverable. ⚠️ The runtime must treat
`SessionStart{source:compact}` as **not a new session**.

### 2.4 Hook reliability

Reliable with clean payloads: `SessionStart` (incl. `source:compact`),
`UserPromptSubmit` (normal + text-steers only), `Pre/PostToolUse`, `Stop` (with
`last_assistant_message`), `PreCompact`/`PostCompact`, `SessionEnd`. Did **not**
fire: `Notification/idle_prompt` after ~55s idle (threshold unknown).

---

## 3. The design — one tail, three jobs

```
                         ┌─────────────────────────────────────────────┐
   ~/.claude/projects/   │  SessionJsonlTail  (jsonl-tail.ts)           │
   <enc-cwd>/<id>.jsonl ─┤  poll from EOF @150ms → classifyEntry()      │
   (the CLI's own        │                                              │
    transcript)          │   emits: user_prompt · enqueue · dequeue     │
                         │          · remove · interrupt                │
                         └───────┬───────────────┬───────────────┬──────┘
                                 │               │               │
                  prompt_received│   steer landing│      interrupt│
                                 ▼               ▼               ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  ClaudeCliSession  (session.ts)                                    │
   │   send confirm (turn_started ∥ prompt_received) · abortTurn()      │
   └──────────────────────────────────────────────────────────────────┘
                                 ▲
                 message_start / │ content (normal terminal stops only)
                 deltas / stops  │
   ┌──────────────────────────────────────────────────────────────────┐
   │  AnthropicTeeProxy  (proxy.ts)  — SSE on the wire, per-req ctx     │
   └──────────────────────────────────────────────────────────────────┘
```

**Division of labor:**

- **Proxy SSE** → content streaming + _normal_ terminal stops (`end_turn`,
  `stop_sequence`, `max_tokens`). Each request carries a `StreamContext`
  `{ isAgentTurn, reqId }` (`reqId` = an 8-char UUID slice).
- **JSONL tail** → the three signals the wire can't give: prompt receipt, steer
  landing, interrupt detection / turn-end-on-interrupt.

### 3.1 The parse layer — `jsonl.ts` (pure, dependency-free)

| Export                           | Behavior                                                                                                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `encodeCwd(cwd)`                 | Claude Code's project-dir encoding — replaces **both** `/` and `.` with `-` (`/Users/me/.hammerspoon` → `-Users-me--hammerspoon`).                                                                 |
| `resolveOwnSessionPath(cwd, id)` | `~/.claude/projects/<encodeCwd(cwd)>/<id>.jsonl`. Tries canonical, then a legacy `/`-only encoding, and falls back to canonical even if absent (the CLI creates it lazily; the tail polls for it). |
| `classifyEntry(line)`            | One JSONL line → a `ClaudeEntry` discriminated union, or `null` for blank/unparseable lines (so a tail can carry a partial trailing line).                                                         |

`ClaudeEntry` variants: `user_prompt{text}`, `interrupt{forToolUse}`,
`enqueue{content}`, `dequeue`, `remove`, `other`.

The subtle bit: **`type:"user"` covers three different things**, disambiguated
in this order:

1. **Interrupt marker** — `interruptedMessageId` present **or** text matches
   `/^\[Request interrupted by user/`. `forToolUse` ← `/for tool use/i`.
2. **Tool-result continuation** — content array contains a `tool_result` block →
   `other` (not a prompt).
3. **Real prompt** → `user_prompt`.

`queue-operation` maps `enqueue`/`dequeue`/`remove` directly.

It's intentionally dependency-free (only `node:fs`/`os`/`path`) so the same
parser can back a future ingester — one parse implementation, not three.

### 3.2 The tail — `jsonl-tail.ts` (`SessionJsonlTail extends EventEmitter`)

- **Polling, not `fs.watch`** (`POLL_MS = 150`): `fs.watch` on macOS is flaky for
  rapidly-appended files; ~150ms is ample for human-scale signals.
- **EOF-seek on `start()`**: `offset = existsSync ? statSync().size : 0` — skips
  pre-existing history, so we only react to _new_ activity. (Important on
  resume: history isn't replayed.)
- **Robust reads**: `Bun.file(path).slice(offset, size).arrayBuffer()` fed
  through a `StringDecoder` so partial multibyte (UTF-8) sequences carry across
  reads; complete lines are split on `\n`, the trailing partial stays buffered.
- **Self-healing**: file-appears-later (offset → 0, read from top),
  truncation/rotation (`size < offset` → reset). A `reading` reentrancy guard,
  an **unref'd** timer (never keeps the process alive), and an empty `catch`
  (best-effort; transient errors retried next tick).
- **Emits**: `user_prompt(text)`, `enqueue(content)`, `dequeue`, `remove`,
  `interrupt(forToolUse)`.

### 3.3 Interrupt — `session.ts`

Both interrupt paths funnel into **one idempotent** `abortTurn(source)`:

- **Web-UI Escape** → `interrupt()` sends `Escape` then calls
  `abortTurn("escape")`.
- **Direct-tmux Escape** (user types Esc in an attached pane; `interrupt()` never
  runs) → the tail detects the marker and calls `abortTurn("jsonl_marker")`,
  wired in the constructor.

`abortTurn` early-returns `if (!this._turnActive)`, and `endTurn()` clears
`_turnActive` — so the **second** path to fire no-ops. Exactly one
`turn_stop{abort}` per turn. When it fires it:

1. adds the in-flight `_activeReqId` to `_suppressedReqIds`,
2. emits `sse { type:"turn_stop", stop_reason:"abort" }`,
3. `endTurn()`, then emits `"interrupted"`.

**Suppression is by `reqId`, not a global flag.** `handleProxyEvent` tracks
`_activeReqId = ctx.reqId` on every agent-turn event, and drops a suppressed
request's drain:

```ts
if (this._suppressedReqIds.has(ctx.reqId)) {
  if (event.type === "message_stop") this._suppressedReqIds.delete(ctx.reqId);
  return; // swallow the post-interrupt drain; retire on stop
}
```

Per-reqId (not global) is what lets a **fresh turn opened during the ~30s drain**
stream normally — its `reqId` isn't suppressed.

### 3.4 Steering & prompt receipt — `session.ts`

We **defer turn handling to the CLI**. `waitForPromptReady` no longer blocks on
turn state — it only does the cold-start "is the input box painted?" bootstrap
(the one failure the CLI can't recover from). A **busy pane is a valid paste
target**; the CLI queues the paste as a steer.

The send is then confirmed by `pasteSubmitAndConfirm` → `waitForSendConfirm`,
which races **two** signals and resolves on the first:

- `turn_started` — emitted on SSE `message_start` (a fresh turn, or a steer the
  CLI promoted to a new turn).
- `prompt_received` — emitted from the tail's `user_prompt` / `enqueue` events
  (constructor-wired). **This is the only signal for an in-tool steer**, which
  produces no `message_start`.

On neither within `TURN_START_TIMEOUT_MS`, surface `runtime_error` /
`submit_failed` (reason `no_receipt`) — no destructive recovery; the caller or
`/restart` decides.

Relevant constants: `TURN_START_TIMEOUT_MS = 15_000`,
`PROMPT_READY_TIMEOUT_MS = 60_000`, `PANE_IDLE_TIMEOUT_MS = 10_000`,
`PASTE_SETTLE_MS = 200`.

---

## 4. What's proven (30 unit tests, 5 files)

- **`jsonl.test.ts`** — `encodeCwd` (`/` and `.` → `-`), `resolveOwnSessionPath`
  canonical shape, and every `classifyEntry` case: array/string prompts, both
  interrupt markers, tool-result-is-not-a-prompt, enqueue/dequeue/remove,
  assistant/summary → other, blank/unparseable → null.
- **`jsonl-tail.test.ts`** — emits interrupt on a marker appended after start;
  **skips pre-existing history** (EOF-seek); enqueue→dequeue for a steer; handles
  a file that **appears after** `start()`.
- **`session-interrupt.test.ts`** — drain **suppressed by reqId**; a **fresh turn
  during the drain still flows** (different reqId); **idempotent** (both paths →
  exactly one `turn_stop{abort}`); no-op when no active turn.
- **`session-send.test.ts`** — confirm on `turn_started`; confirm on
  `prompt_received`; timeout → false; post-timeout emits are harmless no-ops.

Private members are driven via an `as unknown as` cast seam (a standalone
interface, **not** an intersection with the class — that collapses to `never`).

All three behaviors were also **live-verified** end-to-end: web-UI Escape,
direct-tmux Escape, and a mid-turn steer (landed at the step-1 tool boundary;
model replied `HALTED`).

---

## 5. Scope & deferred work

**Out of scope by decision:**

- Resume-from-summary modal — set to "Do not ask"; won't appear.
- Permission-prompt handling — YOLO (`--dangerously-skip-permissions`).
- The feedback survey — shipped separately in [#49].

**Deferred (separate tickets):**

- Lifecycle events via the `anima` CLI hook transport (`session.report_hook` for
  `Stop` / `SessionStart` / `Pre·PostCompact` → gateway events for the UI) →
  **#44 / #46**. The tail handles receipt/steer/interrupt without it.
- Promote the shared parser into the memory/session parsers + a DB read-model
  (the "two readers, different scopes" plan) → follow-up migration.

**Still open:** the `idle_prompt` idle threshold (a passive global probe is
expected to catch it); an optional reliable-Escape-delivery spike (hex
`send-keys -H 1b` vs `Escape`) — likely unnecessary since delivery is confirmed.

---

_The harness used to capture all of this is retained at_
`~/Projects/iamclaudia-ai/hook-spike/` _for re-runs._

[#47]: https://github.com/iamclaudia-ai/anima/issues/47
[#49]: https://github.com/iamclaudia-ai/anima/issues/49
