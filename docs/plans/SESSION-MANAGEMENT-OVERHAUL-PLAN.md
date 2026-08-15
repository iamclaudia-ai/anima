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

1. Ref extraction during reconcile: `#N`, `owner/repo#N`, `ABC-123`. Store in a `session_refs` side table (multi-valued, indexed) rather than JSON metadata — it needs to be a join target and a filter.
2. `session_search_fts` (FTS5, porter unicode61) over transcript content, populated by the reconciler.
3. `session.search({ query, workspaceId?, disposition?, ref?, limit?, offset? })` — bm25 + recency ranking, exact ref matches ranked first, `snippet()` for context.
4. `SearchModal` calls it (debounced), renders snippets + ref chips, searches all workspaces by default.

**Ships:** no more hand-written SQL to find a PR session. Refs as chips in the nav.

### Phase 3 — Live status (#67, #31)

1. Schema: keep `runtime_status` for machine state (add `awaiting_input`, `awaiting_approval`); add `disposition` for human state (`open | needs_review | blocked | snoozed | resolved | archived`).
2. Emit `session.status_changed` and `session.list_changed`; nav subscribes.
3. Notification on `awaiting_input` in a backgrounded tab, tagged by sessionId so it dedupes and click-focuses (closes #31).
4. `session.set_status` + chip/context-menu; filter row in the nav; `resolved`/`archived` hidden by default.

**Ships:** every tab agrees; nothing gets silently abandoned.

### Phase 4 — Modal prompts (#69)

1. Prompt detector next to the existing feedback-survey detector — parse `capture-pane` for the modal, extract question + numbered options.
2. Surface as an actionable block in chat; answering sends the key via `send-keys`. Session sits in `awaiting_approval` meanwhile (Phase 3 gives us the state and the notification for free).
3. Separately, root-cause the bypass leak: absolute hook path, `allow` default in `emit_hook_output`, explicit allow on the passthrough branch.

**Ships:** no more `tmux attach` to unstick a session.

### Phase 5 — Web terminal (#70)

`terminal` extension: PTY over the existing gateway WS, ghostty-web as renderer, panel beside `editor.viewer`, plus one-click attach to `anima-cli-<session>`. Deliberately last — Phase 4 removes the main reason to reach for it, which makes this a convenience rather than a workaround.

## Decisions taken

- **DB is a derived cache, not a new source of truth.** JSONL remains durable; the whole index is rebuildable. Low migration risk, no data-loss surface.
- **Two status axes, not one.** `runtime_status` today conflates "what the agent is doing" with "where the work stands"; that's why it's unusable in the nav. Splitting them is what makes `resolved` meaningful.
- **Refs in a side table, not `metadata_json`.** They're multi-valued and need to be searchable and joinable.
- **Terminal rides the gateway WS, not a separate `ghostty.kiliman.dev`.** One auth surface, one Tailscale boundary, no publicly-reachable shell endpoint. ghostty-web's own docs warn against remote exposure precisely because it launches a real shell.
- **Modal prompts get fixed at the UI layer regardless of root cause.** Even with the hook config corrected, future modals (trust dialog, re-auth, update prompt) would hang invisibly. Detection is the durable fix.

## Open questions

- **Transcript FTS scope** — index every message, or user messages + assistant prose only (skipping tool output)? Full indexing is larger but finds file paths and command output, which is often _how_ you remember a session. Leaning full, with tool output truncated per entry.
- **Reconcile cadence** — fs watch is ideal but `~/.claude/projects/` churns constantly mid-turn. Likely: watch with debounce, plus a slow interval sweep as a floor.
- **Auto-resolve** — should merged-PR detection auto-mark `resolved`, or only suggest it? Plan says suggest; automatic status changes that hide a session are the kind of thing that erodes trust in the list.
