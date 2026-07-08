# Codebase Health Plan — July 2026

**Status:** draft
**Author:** Claudia 💙
**Date:** 2026-07-07
**Scope:** Full-repo review (7 parallel deep-reads: core infra, agent-host/session, chat/voice/imessage/hooks, memory/scheduler/misc extensions, clients, cli/ui, docs audit). No code changed — this is the plan.

---

## Executive Summary

The architecture is sound. The gateway-as-hub + out-of-process extensions + agent-host crash-isolation design has held up well as the system grew from 7 extensions to 15. The problems are the predictable ones of fast growth:

1. **A handful of real bugs** — including one confirmed `undefined` dereference that silently disables zombie-session recovery, and a naming mismatch that makes an entire dominatrix feature dead on arrival.
2. **~1,200+ lines of provably dead code** (webhookServer, elevenlabs-stream, promptCompat, orphaned handlers).
3. **The wire protocol is implemented 5 times** across clients; common extension boilerplate (DB setup, health checks, ctx.call dispatch) is copy-pasted everywhere.
4. **Six files violate the ~500 LOC guideline by 2–3.5×**, all with clean extraction seams.
5. **Docs describe a repo from ~3 months ago.** CLAUDE.md lists a deleted package, misses 2 packages, 8 extensions, and 3 clients; 13 of 19 plan docs describe already-shipped work; the "pure hub" claim is no longer true of the gateway DB.

Recommended order: **Bugs → Dead code → Docs → Consolidation → Decomposition.** Bugs and dead code are cheap and de-risk everything after. Docs before refactors so the refactors land against an accurate map.

---

## Phase 1 — Confirmed Bugs (fix first, each is small)

### P1.1 Agent-host zombie recovery targets `undefined` ⚠️ highest priority

`packages/agent-host/src/index.ts:171` reads `(info as Record<string, unknown>).sessionId`, but `getInfo()` returns the key **`id`** (all three providers). The recovery handler for `ProcessTransport is not ready` therefore throws into a best-effort catch and `close(undefined)` no-ops — **the intended zombie cleanup never runs.** One-line fix: `.id`.

### P1.2 Dominatrix main-world bridge event names never rendezvous

`content-script.ts` uses hyphens (`dmx-bridge-req`/`dmx-bridge-res`, lines 112–125); `main-world-bridge.ts` uses underscores (`dmx_bridge_req`/`dmx_bridge_res`, lines 55–61). Every `callBridge` times out after 5s → `get_source` and `snapshot --sources` are entirely dead. Bonus mismatch: `:434` calls `"get-react-ancestry"` (hyphen) where the bridge switch expects underscore. Pick underscores everywhere (matches DOMINATRIX.md).

### P1.3 Scheduler: overlapping ticks can double-fire; two enum values are lies

- `setInterval(checkAndFireTasks, 5000)` doesn't await the previous tick; `fire_at` only advances at the end of `fireTask` → a slow task with `concurrency: "allow"` fires again mid-run. Guard the loop (skip tick if previous still running).
- `concurrency: "cancel_previous"` is a valid schema value but unimplemented (behaves as `allow`) — implement or remove from the enum.
- `missedPolicy: "fire_all"` is documented as "fire once per missed interval" but the code deliberately fires once — implement or remove.

### P1.4 Memory ingest can silently lose a transcript entry

`ingest.ts:232–295`: offset advances to `stats.size` even when the trailing JSONL line was half-written at capture time; the completed record's first half is permanently orphaned. Fix: advance `lastProcessedOffset` only to the last newline actually parsed.

### P1.5 Memory `review` status is a black hole

Libby can set `status: "review"` but `getActiveWorkItems` doesn't surface it and health metrics have no entry for it — flagged-for-human-review conversations become invisible. Add `review` to the work-items query + Mission Control display.

### P1.6 Gateway `broadcastEvent` has no per-client try/catch

`gateway/src/index.ts:830–839`: one dead socket mid-loop throws and skips all remaining subscribers for that event. Wrap the send (the ping loop already does this correctly).

### P1.7 Watchdog can hang at boot

`services.ts:36–57`: `captureLoginShellEnv` spawns `zsh -i -l -c env` with no timeout at module top-level `await`. A hung `.zshrc` blocks the one process whose job is keeping everything alive. Add a timeout (claude-update.ts already models this at 120s).

### P1.8 Extension auto-restart weaknesses (three related)

- `handleExit` re-spawns without re-acquiring the singleton process lock → a second gateway can end up with duplicate extension copies.
- `restartCount` never resets on healthy uptime → 5 crashes over weeks permanently disables auto-restart. Reset after a healthy window.
- Registration timeout (10s) rejects but never kills the child → orphan until the next boot sweep. Kill the proc and clear the timer.

### P1.9 UI: `sendPrompt` can strand the spinner

`useChatGateway.ts:1214–1275`: `setIsQuerying(true)` + optimistic message push happen **before** the `!sid` guard → no request sent, no `turn_stop`, permanent thinking spinner. Move the guard first.

### P1.10 Voice: non-streaming auto-speak branch is unreachable

`voice/index.ts:412`: the batch branch requires `cs.currentStreamId`, which is only set in the streaming path. With `streaming: false` batch auto-speak silently does nothing. Also: `speakBatch`/`replay` emit `voice.audio` without connection scoping — audio plays in every open tab. Fix both or delete the non-streaming path.

### P1.11 Smaller confirmed items (batch into one cleanup PR)

- Session ext: concurrent lazy-resume double-start race (`session-host.ts:219–247`) — add per-session start mutex.
- Session ext: streaming turn-listener leak on abnormal termination (`prompt-lifecycle.ts:399–411`).
- Hooks: re-dispatch loop risk — `dispatchEvent` should skip `hook.*`-prefixed events; hooks don't actually hot-reload edited files (Bun module cache) — cache-bust or document.
- Dominatrix background: unbounded per-tab console/network buffers — add ring-buffer caps.
- CLI: `session.send_prompt` hard 1500ms stream cutoff truncates long turns — make idle-based.
- Cron parser: DOM/DOW uses AND where POSIX cron is OR — fix or document deviation.
- iMessage: unbounded attachment reads into memory — add size cap.
- menubar: no ping/pong handling → gateway drops it every heartbeat cycle (fixed for free by P4.2).

---

## Phase 2 — Dead Code Removal (zero-risk deletions, ~1,200+ LOC)

| Target                                                                                         | LOC | Evidence                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions/scheduler/src/webhookServer.ts`                                                    | 445 | No importer; queries tables/columns that no longer exist (`scheduled_tasks`, `task_executions`); calls `session.notify` which doesn't exist. **Note:** port was moved to 30089 in commit `1730f72` (today) — confirm with Michael whether webhooks have a future before deleting; if yes, it needs a rewrite against the current schema, not a revival. |
| `extensions/voice/src/elevenlabs-stream.ts`                                                    | 255 | Zero imports anywhere. Duplicates 90% of cartesia-stream. Delete (git history keeps it) or wire in deliberately.                                                                                                                                                                                                                                        |
| `packages/cli` `promptCompat`                                                                  | 90  | Never called; `main()` has no bare-prompt fallthrough. Also fix the file-header docstring advertising the dead feature.                                                                                                                                                                                                                                 |
| Gateway dead handlers (`handleListMethods`, `handleListExtensions`, `handleRestartExtension`)  | ~60 | Zero call sites; superseded by `executeGatewayMethod`.                                                                                                                                                                                                                                                                                                  |
| Session ext `dispatchMethod` export                                                            | ~10 | Nothing imports it; rebuilds handler map per call.                                                                                                                                                                                                                                                                                                      |
| `sdk-session.ts` skills-prompt path (`buildSkillsPrompt` + plumbing)                           | ~40 | Only caller commented out ("SDK loads skills natively").                                                                                                                                                                                                                                                                                                |
| Dead config keys: `voice.summarizeThreshold`, `imessage.historyLimit`, `memory.pollIntervalMs` | —   | Declared/defaulted/documented, never read. Remove from types, example config, and docs.                                                                                                                                                                                                                                                                 |
| `ingestDirectory` (superseded by cooperative variant)                                          | ~30 | Only a test script uses it.                                                                                                                                                                                                                                                                                                                             |
| Dominatrix `performAction` (content-script `:855`)                                             | ~15 | Dead + buggy duplicate of `performActionOnElement`.                                                                                                                                                                                                                                                                                                     |

**Decisions needed from Michael — RESOLVED, see "Decisions (resolved 2026-07-07)" below:**

- `extensions/disco/` — **KEEP** (Claudia↔OC coordination channel); formalize with package.json + README instead of archiving.
- `extensions/testroute/` — move under scripts/ or a test dir (unobjected).
- `clients/desktop/` — **KEEP pending** keyboard-shortcut spike; label experimental.
- `extensions/bogart/` — keep, label as a dev fixture.
- `webhookServer.ts` — **DELETE** (feature intent preserved as a future plan entry; see Decisions #1).
- `elevenlabs-stream.ts` — **DELETE** (audiobook dialog flow doesn't use it; see Decisions #4).

---

## Phase 3 — Documentation Overhaul

The audit's clearest signal: **generated docs (API-REFERENCE.md) are accurate; hand-maintained inventories are where all drift lives.** So: fix the facts now, then shrink the hand-maintained surface so it can't drift again.

### P3.1 Fix the inventory docs (CLAUDE.md, README.md, docs/README.md, ARCHITECTURE.md)

- Remove `packages/memory-mcp` (deleted); add `packages/agent-host` and `packages/shell-parser`.
- Extension tables: 7 listed → 15 real (add scheduler, dominatrix, editor, presenter, audiobooks, disco, bogart, testroute — with enabled/disabled/experimental status column).
- Client list: 3 → 6 (add desktop, dominatrix, code-server-bridge).
- **Kill the `session.start_task` vocabulary in CLAUDE.md** — the shipped API is `session.spawn_agent`/`get_subagent`/`list_subagents`/`interrupt_subagent`. There is no TaskHost; Codex is a provider inside SessionHost.
- Correct the "pure hub" claim: gateway DB owns sessions/memory/scheduler migrations today. Either re-scope the claim or plan migration ownership per-extension (see P5.4).
- Fix stale `AnimaExtension` interface snippet (missing `mcpTools`, `webStatic`, etc.), `bun --hot`-is-default claim (default is `bun run`; `--hot` is opt-in), "validates against Zod" → "Zod-derived JSON Schemas" for the CLI, ElevenLabs listed as a TTS backend (it's dead code), default model string.
- docs/README.md index: add the 4 unlinked docs, fix the ENTITLEMENT.md description (it's a CarPlay request form, not a permissions system!), link docs/architecture/.

### P3.2 Subsystem doc corrections

- **SESSION.md** — remove TaskHost/task-workflow/start_task sections; document subagents-as-child-sessions; fix file map (`subagent-workflow.ts`/`subagent-events.ts`).
- **VOICE-STREAMING.md** — rewrite §6 around per-connection state (`connections: Map<connectionId, ...>`); `streamOrigins` no longer exists; `voice.stream_abort` was never an event (abort = `stream_end` + `{aborted: true}`); add `voice.status`/`voice.replay`.
- **SCHEDULER.md** — once-tasks disable (preserving history), they don't auto-delete; document `update_progress`; remove/fix `fire_all` claim per P1.3 outcome; remove webhook references per P2 decision.
- **MEMORY.md** — add `queued` and `review` to the status lifecycle; remove `pollIntervalMs`; fix the internal "Phase 2 TBD" vs implemented-Libby contradiction.
- **DOMINATRIX.md** — the "open bugs / recommended options" sections describe fixes that already shipped (instanceId persistence, ping/pong, exclusive subscribe, focus-tracking). Rewrite as current-state.
- **EXTENSIONS.md** — iMessage source-routes column (now `[]`, uses sync send_prompt + source pattern); extension table 6 → 15.
- **SCRIPTS.md** — prepush now runs typecheck + unit + `test:ios` + `docs:api:check` + `react-doctor:diff`.
- **WATCHDOG-RECOVERY.md** — update for the two-child reality (gateway + agent-host).

### P3.3 Archive shipped plans

Create `docs/plans/archive/`. Move the 13 PLAN-COMPLETED docs (AGENT-HOST, SCHEDULER-V2, PWA, RENAME, PERSISTENT-SESSIONS, LIVENESS-LOCKS, HEALTH-SCHEMA, IMESSAGE-CATCHUP, MEMORY-RESILIENCE, SESSION-PROVIDER-ROUTING, SKILL-RUNNER, CLAUDE-CLI-RUNTIME, AGENT-HOST-SESSION-CODEX-REVIEW) and the 3 abandoned ones (CODEX-MEMORY-INGESTION, EXTENSION-ACTOR-ARCHITECTURE, FEDERATED-MEMORY — confirm abandonment first). Before archiving, fold still-accurate architecture prose into the canonical subsystem docs. Keep only genuinely open plans (LIBBY-HOUSEKEEPING, EXTENSION-SHUTDOWN-QUIESCE partial, MEMORY-ACTOR partial) in `docs/plans/`.

Also: move `ENTITLEMENT.md` → `clients/ios/`; `PRESENTATION-PERSONAL-AI-AGENTS.md` → `docs/talks/`; root `CONFIG_WATCHER_DESIGN.md` → `docs/architecture/`; fold root `TODO.md` into plans.

### P3.4 Make docs sustainable (the part that actually prevents recurrence)

1. **Generate the component inventory** (packages/extensions/clients + ports + enabled status) from disk + `anima.example.json`, same pattern as `generate-api-reference.ts`. Wire into pre-push like `docs:api:check`.
2. **Status front-matter on every plan** (`Status: draft|in-progress|shipped|abandoned`, `Superseded-by:`) + a tiny lint for past-deadline in-progress plans.
3. **Per-extension README convention** — `extensions/<id>/README.md` co-located with code so docs change in the same PR. Immediately fills the gaps: audiobooks, disco, presenter, bogart, testroute, and **packages/shell-parser** (security-relevant, zero docs today).
4. **docs index completeness check** in CI: every `docs/*.md` linked from the index; every linked path exists.
5. **Quarterly plan reaping** — shipped plans move to archive as routine hygiene.

---

## Phase 4 — Consolidation (DRY across the monorepo)

### P4.1 One TypeScript gateway client

`packages/shared/gateway-client.ts` is the canonical implementation (exponential backoff, subscription restore, ping/pong, injectable socket factory). Migrate:

- `clients/code-server-bridge/src/gateway-client.ts` (222-line hand-rolled copy with worse reconnect) — easy win.
- `clients/dominatrix/src/background.ts` inline WS logic.
  Net: delete ~300–400 lines and every bridge client gets better reconnect for free.

### P4.2 One Swift wire protocol

`ios/VoiceMode/GatewayWireProtocol.swift` is clean and tested. Menubar's `GatewayClient.swift` is a stale fork with no auth and no ping/pong (it gets dropped by the heartbeat today). Adopt the ios protocol file wholesale in menubar — fixes auth + ping in one move.

### P4.3 Extension-host helpers (kill the copy-paste)

- `createAnimaDb(path)` in shared: the `new Database` + WAL + foreign_keys + busy_timeout block is copy-pasted in memory, memory/mcp, scheduler, and disco.
- `buildHealthCheck(...)` helper: every extension hand-builds overlapping `health_check` method + `health()` responses.
- Migrate `imessage` and `hooks` to `createStandardExtension` (voice already uses it) — deletes the hand-rolled `handleMethod` switches and standardizes lifecycle.
- Shared `dispatchCall` for the near-identical ctx.call handling in `extension-host.ts` and `ws-extension-host.ts`; hoist the duplicated `onCall` closures in gateway index/start; shared `normalizeMcpToolResult`; extract duplicated connection-cleanup into `cleanupConnection(ws)`.
- Small dedupes: claude-binary resolution (sdk-session vs cli/session), model-variant stripping, model-drift recycle, `transitionConversation`, episode-path formatter (memory index vs libby), Cartesia voice-config assembly, git-status defaulting + session-reset + error-block-append in useChatGateway, SPA link-click guard (router Link vs drawer rows), `useClickOutside` → shared hooks.

### P4.4 Config source-of-truth for session model

`config.session.model` (agent-host) vs `config.extensions.session.config.model` (gateway banner) — two locations for one concept. Pick one.

---

## Phase 5 — Decomposition (the 500-LOC rule, applied where it pays)

Only files with **clean seams** — no decomposition for its own sake. `cli/session.ts` (874, tmux TUI driving) is essential complexity: leave it.

| File                                  | LOC  | Split into                                                                                                                                                                                                                                                                                                 |
| ------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/index.ts`           | 1775 | `schema.ts`, `args.ts`, `help.ts`, `inject.ts`, `commands/watchdog.ts` (~600 incl. doctor/plist), `commands/code-server.ts` — `main()` stays. The `commands/skill/` dir already proves the pattern.                                                                                                        |
| `packages/gateway/src/index.ts`       | 1421 | `http-routes.ts` (~400), `ws-handlers.ts`, `gateway-methods.ts`, `client-health.ts` — index keeps Bun.serve wiring + event fanout.                                                                                                                                                                         |
| `packages/ui/hooks/useChatGateway.ts` | 1385 | Pure `applyStreamEvent` reducer (~320, independently testable), `useSessionRpc` (~230), `useToolTickSimulation`, `useAutoScroll`, subagent utils. Roughly halves the hook.                                                                                                                                 |
| `extensions/memory/src/index.ts`      | 1168 | `methods/` module (the ~540-line switch), health-metrics builder, episode-path util. Also split `libby.ts` git plumbing into `git.ts`; `db.ts` by concern.                                                                                                                                                 |
| `extensions/voice/src/index.ts`       | 1071 | `speech-filter.ts` (~150 pure), `cartesia-batch.ts`, `voice-connection-manager.ts` (~570); collapse the 3 duplicate flush blocks into `flushPending()`. index → ~250.                                                                                                                                      |
| `packages/watchdog/src/services.ts`   | 631  | `incident-tracker.ts` (~180), `env-resolution.ts` (~130).                                                                                                                                                                                                                                                  |
| Also-rans (as touched)                |      | `imessage/index.ts` → `content-blocks.ts` + `catchup.ts`; `ChatPageContext.tsx` → plain helper functions; `NavigationDrawer.tsx` → extract SearchModal/SettingsPopup; dominatrix `content-script.ts` → extract snapshot/a11y/find modules; `main-world-bridge.ts` source-map machinery → dedicated module. |

### P5.4 (stretch/architectural) Re-honor "pure hub"

The gateway DB currently owns memory/scheduler/session domain migrations. Options: (a) accept and re-document ("gateway owns the shared SQLite file; extensions own their schemas"), or (b) move migrations to per-extension ownership with a shared migration runner. Recommend (a) short-term — cheap honesty — and evaluate (b) only if cross-process SQLITE_BUSY contention (noted risk) actually bites.

---

## Suggested Sequencing

| Wave | Content                                                                                                         | Size                |
| ---- | --------------------------------------------------------------------------------------------------------------- | ------------------- |
| 1    | P1.1, P1.2, P1.6, P1.9 (one-liners + tiny fixes)                                                                | 1 short session     |
| 2    | P1.3–P1.5, P1.7, P1.8, P1.10 + Phase 2 deletions (with Michael's decisions on disco/testroute/desktop/webhooks) | 1–2 sessions        |
| 3    | Phase 3 docs overhaul + generators (P3.4.1 is the keystone)                                                     | 2 sessions          |
| 4    | Phase 4 consolidation (P4.1/P4.2 first — user-visible reliability wins)                                         | 2–3 sessions        |
| 5    | Phase 5 decomposition, one file per PR, tests riding along                                                      | ongoing, as-touched |
| 6    | P1.11 remainder + P5.4 decision                                                                                 | opportunistic       |

Every wave = its own branch, ff-merged per house rules. Each decomposition PR should carry the doc update for the files it touches (the P3.4 convention starts immediately, not after).

---

## Open Questions for Michael — ✅ answered, see "Decisions (resolved 2026-07-07)" at the end

1. **Scheduler webhooks** — dead code today, but you touched its port config _this morning_. Future plans, or delete?
2. **disco** — archive the experiment or is distributed-Claudia-consciousness still on the roadmap? 💙
3. **desktop client** — keep as a labeled experiment, or delete in favor of PWA/browser?
4. **ElevenLabs** — the skills mention it for pre-generated content; is that flow real anywhere, or delete the stream class?
5. **"Pure hub" doctrine** — re-document reality (recommended) or invest in per-extension migration ownership?
6. **Cron DOM/DOW semantics** — match POSIX OR behavior, or keep AND and document it?

---

_Review conducted by 7 parallel deep-read agents; findings cross-checked against code, not docs. Where a doc auditor and a code reader disagreed (SESSION.md, VOICE-STREAMING.md, webhookServer), the code reader's verdict was used._

## Answers

1. I would still like the webhooks. Eventually we'll open up Anima so external service can notify you when things happen. We can just add it to our TODO list. It's not a priority at the moment.
2. I also want to keep disco. We've had instances where you were working in two different workspaces on a related feature (main swarm project and a separate supporting project). I was simply copy+pasting messages between you and OC. Having disco would let you start up a conversation between you and OC and coordinate directly. Granted we could probably create our own Discord server or Slack channel, but what's the fun in that when you can build your own? :D
3. I think we tried a desktop client with both Electron and Tauri. The main reason was to handle keyboard shortcuts, which for some reason we couldn't get to go past the browser UI. If we can solve that without a desktop app, that'll be great. Otherwise, we may still need it. I see that even Claude and Codex have desktop apps (probably wrappers around the web UI though).
4. We originally use ElevenLabs for streaming voice, but for some reason their streaming API would drop the first couple seconds (apparently a known issue). We ended up switching to Cartesia, which works pretty well. We kept ElevenLabs for the dialog API (generate audiobooks from stories you write) because the results were really good and we still had a bunch of credits. But I may be considering moving over to Grok Voice for both. I think our API wrapper is pretty provider agnostic (at least not difficult to support others).
5. The Pure Hub doctrine, I should know what you mean by this, but can you explain it. Is this referring to all communication from extensions should go through the gateway?
6. As for the Cron semantics, feel free to choose what you're most comfortable with, since almost always I'm just going to ask you to schedule something, so whatever format you want is the right one.

### More feedback

- We don't currently use `menubar`, so no need to update it

---

## Decisions (resolved 2026-07-07)

Michael's answers above, translated into plan dispositions:

1. **Webhooks — feature stays, dead code goes.** The vision (external services notifying Anima) is real but not a priority. Disposition: delete the broken `webhookServer.ts` in Phase 2 (it queries a defunct schema and can never run; git history preserves it), and capture the intent as a short future-plan entry ("Anima inbound webhooks") in docs/plans with `Status: draft`. A future implementation is a rewrite against the current schema, not a revival.
2. **disco stays — it's the Claudia↔OC coordination channel.** Use case: two Claudia sessions working related features in different workspaces coordinating directly instead of Michael copy-pasting between them. Disposition: remove from the archive list; instead give it a `package.json` (make it a proper workspace package), a README describing the cross-session coordination vision, and add a revival plan entry. Not scheduled yet.
3. **desktop — keep pending keyboard-shortcut investigation.** It exists because browser UIs couldn't capture certain global shortcuts. Disposition: label experimental in docs; add a spike task to test whether PWA/browser APIs (or the VS Code/code-server surface) can capture the needed shortcuts. If yes → delete; if no → desktop stays and gets documented.
4. **ElevenLabs — delete the dead streaming class, keep the dialog usage.** History: ElevenLabs streaming dropped the first ~2s (known issue) → switched to Cartesia. ElevenLabs remains for the text-to-dialogue audiobook flow (which does not import `elevenlabs-stream.ts` — that file is safe to delete). Note for later: Michael is considering Grok Voice for both paths; the wrapper is provider-agnostic enough to make that a contained change.
5. **Pure hub — option (a), re-document reality.** Update CLAUDE.md/ARCHITECTURE.md to say: the gateway owns the shared SQLite file and runs all migrations at startup; extensions own their tables' contents and logic. Revisit per-extension migration ownership only if cross-process contention becomes a real problem.
6. **Cron semantics — keep AND, document the deviation.** Claudia's call (as the primary scheduler user): the AND reading ("the 13th _and_ a Friday") is what a human intuitively means; POSIX's OR is the surprising one. Zero code change — document the deviation in SCHEDULER.md and a comment in `cronParser.ts`, and drop this item from P1.3's scope.
7. **menubar is unused — no update needed.** P4.2 (unify Swift clients) is descoped to "ios only"; the menubar ping/pong item in P1.11 is dropped. If menubar is ever revived, adopting `GatewayWireProtocol.swift` is the path.
