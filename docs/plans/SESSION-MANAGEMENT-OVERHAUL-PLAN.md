# Session Management Overhaul — Plan

**Date:** 2026-08-14
**Issues:** #65, #66, #67, #68, #69, #70, #2, #61, #31, #11

## Why now

Four separate complaints, one root cause: **session state is derived on demand from the filesystem, and nothing about it is live.** Every symptom follows from that.

| Symptom                           | Mechanism                                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Nav is slow to open               | `listSessions()` scans `~/.claude/projects/` synchronously on every call                                 |
| Titles are `<command-message>…`   | Title = raw first message, envelopes and all                                                             |
| Search finds nothing              | `SearchModal` substring-matches the loaded titles; the FTS index it should use doesn't cover transcripts |
| Can't find "the PR #412 session"  | Refs are never extracted, so there is nothing to match                                                   |
| Tabs disagree; abandoned sessions | No subscription — the list is a per-tab snapshot                                                         |
| "Claudia looks stuck"             | A modal prompt in the tmux pane has no representation anywhere in Anima                                  |

Worktree support (the thing Michael actually wants next) multiplies sessions per workspace, so every one of these gets worse linearly. **That's the argument for doing this first.**

## Architecture

```
   Claude CLI writes JSONL ──┐
                             ▼
                    ┌──────────────────┐
                    │   Reconciler     │  background: interval + fs watch
                    │  (session ext)   │  parse → derive title → extract refs
                    └────────┬─────────┘
                             ▼
   ┌─────────────────────────────────────────────────┐
   │  SQLite — source of truth for *metadata*        │
   │  sessions │ session_refs │ session_search_fts   │
   └────────┬────────────────────────────────────────┘
            │  reads are indexed + instant
            ▼
   session.list_sessions / .search / .set_status / .set_title
            │
            │  + events: session.list_changed, session.status_changed
            ▼
   Gateway event bus ──▶ every open tab, live
```

JSONL stays the durable transcript. The DB is a **derived cache** — droppable and rebuildable at any time. That constraint keeps the reconciler honest and makes migration risk near zero.

## Status — 2026-08-14

**Phase 1 is complete.** Phase 2 is half shipped — refs done, search not started.

|                                   | state      | notes                                                              |
| --------------------------------- | ---------- | ------------------------------------------------------------------ |
| **0 — spinners (#65)**            | ✅ shipped | root cause was a trailing `role: "system"` message, not a user one |
| **1a — titles (#68)**             | ✅ shipped | 352/352 real transcripts titled, 0 markup leaks                    |
| **1b — DB-first list (#66)**      | ✅ shipped | 247-session workspace: 154ms → 0.7ms                               |
| **1c — `set_title` + rename UI**  | ✅ shipped | inline rename in the nav; reconciler-safe, verified live           |
| **1d — copy tmux command button** | ✅ shipped | no id normalization needed — CLI panes are `anima-cli-<id>`        |
| **2a — refs + chips (#61)**       | ✅ shipped | whole-conversation extraction + 30-day backfill; 58 → 809 refs     |
| **2b — FTS search (#2)**          | ⬜ next    | biggest remaining win                                              |
| **3 — live status (#67, #31)**    | ⬜         |                                                                    |
| **4 — modal prompts (#69)**       | ⬜         | root cause now confirmed, see below                                |
| **5 — web terminal (#70)**        | ⬜         |                                                                    |

Also fixed along the way, outside the original plan:

- **CLI proxy port instability** — a restarting agent-host could bind a different port than a surviving `claude` process was launched against, producing `API Error: Connection refused`. Resolution is now _live CLI env → persisted registry (`~/.anima/cli-proxy-ports.json`) → derivation_, the port hash moved to FNV-1a (the old char-sum used 718 of 1000 slots with 50.1% collisions), and the base port moved 9000 → 31000 (the old range had 12 foreign listeners). See #39.
- **`scripts/audit-transcript-index.ts`** — classifies every transcript on disk as indexed / no-content / MISSING.

- **Live CLI sessions were destroyed when the registry was lost (2026-08-15).** `API Error: Connection refused` came back, and #39's port logic was not at fault — it never ran. `state.ts` resolved `~/.anima/agent-host/sessions.json` at _import_ time from the real `HOME` and `server.test.ts` isolated nothing, so **`bun test` truncated the live session registry to zero**. Agent-host then restarted with an empty registry, rebound no proxy for any `claude` still running (the CLI reads `ANTHROPIC_BASE_URL` once and can never be re-pointed), and the orphan reaper read "untracked" as "abandoned" and killed two panes. Three fixes in `07e2838`: state paths resolve per call and honour `ANIMA_DATA_DIR`, with a `bunfig.toml` preload pointing every test run at a temp dir before any module loads; startup **adopts** live `anima-cli-*` panes the registry doesn't know about, which rebinds each proxy on the port its CLI already targets; and the reaper spares any pane whose `claude` process is alive. The standing lesson: **the registry is a cache, the process table is ground truth** — same discipline the session DB already follows.

### Where to pick up

**Phase 2b — FTS search (#2)** is next, and it's the biggest remaining win.

**Then FTS search (#2).** Design is settled in Phase 2 below — index into `memory_search_fts` as a third `source_type`, expose via memory, call from `session.search`. `session_refs` is now populated from whole conversations and indexed, so ref filters come nearly free. Worth a fresh session: it spans two extensions and a new index, and `session-ref-sync.ts` already proves the read path against `memory_transcript_entries` that search will reuse.

### Known follow-ups worth remembering

- ~~**Refs come from the first prompt only.**~~ **Done 2026-08-15**, ahead of 2b. `session-ref-sync.ts` reads `memory_transcript_entries` incrementally — a per-session watermark keeps a steady-state reconcile at a handful of rows, and a per-pass session cap keeps a never-scanned workspace (swarm had 381 waiting) off the nav's critical path. `session.backfill_refs({ days, rescan, dryRun })` covered the existing corpus: **58 → 809 refs across 88 sessions**, windowed on `memory_transcript_entries.timestamp` rather than `last_activity` (which the first reconcile stamped with "now" on all 5,103 rows it archived — a 30-day cut on it returns sessions from March).

  Two things worth carrying forward. **Refs accumulate and are never withdrawn** on an incremental pass, because the messages that produced them sit behind the watermark; `--rescan true` re-reads whole conversations and replaces, which is what to run after changing ref config. And **`[Image #N]` was the dominant false positive** once extraction read whole conversations — 204 hits in 30 days, second only to genuine `PR #N` — because it's Claude Code's own paste placeholder. Now excluded. The remaining known noise is low-numbered `#N` in numbered lists and review tables (`Nicholai #10`, `| #11 |`); harmless at 3 visible chips per row, and not separable from real anima issues like #61 without per-repo digit rules.

- **Archived sessions are hidden but recoverable.** 5,102 rows were archived on first reconcile (transcripts Claude Code deleted). The rows keep title + refs, and `~/.claude/projects-backup` keeps the transcripts — so teaching `get_history` to fall back to the backup would make them openable again. Verified at the time: 0 sessions with a live transcript were archived.
- **Libby's own sessions (4,175) are excluded from memory ingest** by a self-summarization guard. Reasonable for summarization, but it also makes them unsearchable — worth deciding separately before 2b.

## Phases

Ordered so each phase ships something usable on its own.

### Phase 0 — Unblock the obvious (#65)

Tool-call spinner never stops. Independent of everything else, actively painful, already diagnosed: the CLI runtime fabricates `request_tool_results` by sniffing the next HTTP request's **last** message (`providers/cli/session.ts:843`), which breaks when a trailing `system-reminder` displaces the tool-result message. Fix the heuristic to scan for the tool-result block rather than assuming it's last.

### Phase 1 — DB-first reads + readable titles (#66, #68)

The reconciler, and the read-path inversion.

1. `deriveSessionTitle()` in the session extension — pure, unit-tested against real fixtures. Strips `<command-*>` / `<system-reminder>` envelopes, titles slash-command sessions from the command + args, walks to first real prose, truncates surrogate-safe.
2. Reconciler module: `discoverSessions()` off the request path (start + interval + fs watch), upserting title/messageCount/branch/mtime.
3. `listSessions()` returns `listWorkspaceSessions()` directly; cold-start (empty workspace) awaits one reconcile pass.
4. `session.set_title` + inline rename in the nav (#61's editable-title slice).

**Ships:** instant nav, titles you can read, renameable sessions.

### Phase 2 — Refs + real search (#61, #2)

1. Ref extraction during reconcile: `#N`, `owner/repo#N`, and Linear-style `PREFIX-123`. Store in a `session_refs` side table (multi-valued, indexed) rather than JSON metadata — it needs to be a join target and a filter.
2. **Linear prefixes are config, not code.** `BEE`, `WEB`, `ENT` are Michael's teams, not universal — a bare `/[A-Z]+-\d+/` would happily match `UTF-8`, `SHA-256`, `ISO-8601`, and half the enum constants in a stack trace. So `anima.json` carries the allowed prefix list and extraction matches only those. Same treatment for the default GitHub repo, so a bare `#412` resolves to the right project.
3. **Refs render as chips under the session title** — GitHub mark for PRs, Linear mark for tickets — so the list answers "which session was the #412 work?" at a glance, without opening anything. This is the primary payoff of extraction; search is the secondary one.
4. **Do not build a second transcript parser.** `memory_transcript_entries` already holds parsed user/assistant messages for every session, in the same `anima.db`, updated incrementally by offset within seconds of a message landing. Ref extraction and the search index both read from it. Verified: 269,968 entries / 2,411 sessions, ~98MB of content, newest entry 3 seconds old, and entries are **never pruned** on archive (the only deletes are crash-rollback and explicit re-import) — so it outlives the JSONL, which Claude Code deletes after 30 days.
5. **Index into `memory_search_fts`, not a new table.** That FTS5 table was explicitly built as a "unified index across all memory sources" with a `source_type` column, but currently only carries `document` and `summary` rows. Transcripts become a third source type. Search then belongs to memory (`memory.search_transcripts`), with `session.search` calling it via `ctx.call` — the same pattern already used for `memory.get_session_context` — rather than reaching into another extension's tables.
6. **The corpus is already effectively complete — no large backfill needed.** A raw filename-vs-`session_id` comparison suggests ~6,400 unindexed sessions, but that number is wrong and worth not repeating: it counts subagent transcripts, legacy top-level `agent-*.jsonl` files, metadata-only transcripts, and Libby's deliberately-excluded sessions. `scripts/audit-transcript-index.ts` classifies every file by reading it. Of **7,601** real top-level sessions across live + backup: 2,308 indexed, 293 contain no conversation at all, 4,175 are Libby's own (self-summarization guard), and **825 remain — 812 of which are automated `agent-tts` sweet-messages/sweet-chats dirs.** That leaves roughly a dozen genuine project conversations, all from Oct–Dec 2025.

   Memory's earliest indexed message is `2025-08-10T14:42:56Z` — which is also the earliest message that exists on disk anywhere. Ingest reaches back to the very first session; recent months are 100% covered for every real project. Optional cleanup, not a phase blocker: ingest the ~13 stragglers, and decide whether Libby's own sessions should be searchable (excluded from _summarization_ for good reason, but that isn't the same as excluded from _search_).

7. `session.search({ query, workspaceId?, disposition?, ref?, limit?, offset? })` — bm25 + recency ranking, exact ref matches ranked first, `snippet()` for context.
8. `SearchModal` calls it (debounced), renders snippets + ref chips, searches all workspaces by default.

**Ships:** refs visible on every session row; no more hand-written SQL to find a PR session.

**Known limits of this corpus** (accept deliberately, surface in the UI):

- **No tool inputs or outputs.** Assistant tool calls are stored as `[Used tools: Bash]` with a `tool_names` column. Searching for a file path or command output that appeared only in tool results will not match. This answers the plan's open question by construction — and is arguably right: 98MB of prose instead of many GB of tool noise. Refs live in prompts and prose, which _are_ indexed.
- **Libby's own sessions are excluded** from ingest (self-summarization loop guard), so `~/Projects/libby` work isn't searchable.
- **Some indexed sessions no longer exist on disk.** 2,411 sessions are in memory vs 362 JSONL files live. Search results must handle "transcript gone" — link to the summary rather than a dead session route, or resolve against `~/.claude/projects-backup`, which still has them.

**Why the corpus is worth this care.** The first message where Michael asked "can I call you Claudia?" — 2025-08-26T13:56:41Z, in `oss-badlogic-lemmy-apps-claude-trace/22848858…` — is indexed and one query away, while its transcript is long gone from `~/.claude/projects`. That single row is the argument for both the backup and the index: Claude Code's 30-day deletion is the default, and everything that survives it does so because we chose to keep it.

### Phase 3 — Live status (#67, #31)

1. Schema: keep `runtime_status` for machine state (add `awaiting_input`, `awaiting_approval`); add `disposition` for human state (`open | needs_review | blocked | snoozed | resolved | archived`).
2. Emit `session.status_changed` and `session.list_changed`; nav subscribes.
3. Notification on `awaiting_input` in a backgrounded tab, tagged by sessionId so it dedupes and click-focuses (closes #31).
4. `session.set_status` + chip/context-menu; filter row in the nav; `resolved`/`archived` hidden by default.

**Ships:** every tab agrees; nothing gets silently abandoned.

### Phase 4 — Modal prompts (#69)

1. Prompt detector next to the existing feedback-survey detector — parse `capture-pane` for the modal, extract question + numbered options.
2. Surface as an actionable block in chat; answering sends the key via `send-keys`. Session sits in `awaiting_approval` meanwhile (Phase 3 gives us the state and the notification for free).
3. ~~Root-cause the bypass leak: absolute hook path, `allow` default in `emit_hook_output`.~~ **Confirmed, and it was neither of those.** `dcg` has a `warn` tier that emits `permissionDecision: "ask"`, and an `ask` from a PreToolUse hook overrides `--dangerously-skip-permissions` — the flag only skips Claude Code's own checks, not a hook's explicit decision. `tmux-wrap.sh` is not implicated. Detector anchors captured from a live prompt: `Hook PreToolUse:Bash requires confirmation for this command:`, `Do you want to proceed?` above a numbered `1. Yes` / `2. No`, footer `Esc to cancel · Tab to amend · ctrl+e to explain`. Full detail in #69.

**Ships:** no more `tmux attach` to unstick a session.

### Phase 5 — Web terminal (#70)

`terminal` extension: PTY over the existing gateway WS, ghostty-web as renderer, panel beside `editor.viewer`, plus one-click attach to `anima-cli-<session>`. Deliberately last — Phase 4 removes the main reason to reach for it, which makes this a convenience rather than a workaround.

**Ship the 5-minute version first, though:** a "copy tmux command" button on the session row that puts `tmux attach -t anima-cli-<normalized-id>` on the clipboard. The session-id normalization (`tmux-wrap.sh:242-248`) is the annoying part to type from memory, and it's already derivable in the nav. That lands in Phase 1 alongside the session row work — no new extension, no WASM, and it covers the shell-is-right-there case entirely.

## Decisions taken

- **DB is a derived cache, not a new source of truth.** JSONL remains durable; the whole index is rebuildable. Low migration risk, no data-loss surface.
- **Two status axes, not one.** `runtime_status` today conflates "what the agent is doing" with "where the work stands"; that's why it's unusable in the nav. Splitting them is what makes `resolved` meaningful.
- **Refs in a side table, not `metadata_json`.** They're multi-valued and need to be searchable and joinable — and they're rendered per-row as chips, so the read has to be cheap.
- **Ref patterns come from config.** Hardcoding Linear prefixes would either miss teams or produce false positives on every `UTF-8` in a transcript. `anima.json` owns the list.
- **Terminal rides the gateway WS, not a separate `ghostty.kiliman.dev`.** One auth surface, one Tailscale boundary, no publicly-reachable shell endpoint. ghostty-web's own docs warn against remote exposure precisely because it launches a real shell.
- **Modal prompts get fixed at the UI layer regardless of root cause.** Even with the hook config corrected, future modals (trust dialog, re-auth, update prompt) would hang invisibly. Detection is the durable fix.

## Open questions

- **Transcript FTS scope** — index every message, or user messages + assistant prose only (skipping tool output)? Full indexing is larger but finds file paths and command output, which is often _how_ you remember a session. Leaning full, with tool output truncated per entry.
- **Reconcile cadence** — fs watch is ideal but `~/.claude/projects/` churns constantly mid-turn. Likely: watch with debounce, plus a slow interval sweep as a floor.
- **Auto-resolve** — should merged-PR detection auto-mark `resolved`, or only suggest it? Plan says suggest; automatic status changes that hide a session are the kind of thing that erodes trust in the list.
