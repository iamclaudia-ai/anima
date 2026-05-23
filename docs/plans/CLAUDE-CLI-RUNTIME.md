# Plan: Claude CLI Runtime (#33)

**Status:** In progress · **Priority:** P0 · **Deadline:** 2026-06-15

## Why

Anthropic clarified that **Agent SDK usage falls outside Claude Pro/Max subscription
plans** — even for personal, code-centric front-ends like Anima. We must migrate off
the Agent SDK runtime by **June 15, 2026** or be forced onto per-token API pricing
(~$2K/mo vs ~$200/mo).

Anima is a replacement front-end for Claude Code, not a programmatic agent platform.
The compliant path is to **drive the real `claude` CLI** (which authenticates with the
subscription OAuth token, executes tools, persists history, and enforces permissions)
and **observe its model stream via a local proxy** so we can keep our streaming UI,
voice mode, etc.

## Core constraint & strategy

We cannot get partial/streaming content from the CLI any other way:

- **JSONL tailing** → final messages only, no token deltas → long responses feel like a
  pause then a wall of text. Kills voice-mode UX. (Last-resort fallback only.)
- **CLI `--output-format stream-json`** → that's the SDK-equivalent headless mode, likely
  treated as non-subscription. Avoid.
- **Proxy interception** → the real interactive TUI handles auth/tools/history; the proxy
  is a pure observer of the SSE stream. ✅

### Interception: base-URL vs MITM

Billing/entitlement is decided by the **credential in the request** (OAuth subscription
token vs API key), **not** by the URL — Anthropic's server never sees `ANTHROPIC_BASE_URL`
(it's client-side config). So a faithful pass-through that preserves the `Authorization`
header bills against the subscription.

The risk is **client-side**: when `ANTHROPIC_BASE_URL` is set, the `claude` client _knows_
it's a custom endpoint and could withhold the OAuth token or stamp a "non-subscription"
header. The durable answer is **transparent MITM**: the client believes it's talking to the
real `api.anthropic.com`, so it emits a byte-identical, fully-signed subscription request
that Anthropic cannot distinguish and the client cannot refuse.

| Approach                                         | Durability                               | Notes                                                      |
| ------------------------------------------------ | ---------------------------------------- | ---------------------------------------------------------- |
| `ANTHROPIC_BASE_URL` pass-through                | Low — client knows, can be neutered      | Simplest; fine for dev/today                               |
| **Transparent MITM** (own CA, per-process trust) | **High — indistinguishable from normal** | Proven viable (HTTP Toolkit works today ⇒ no cert pinning) |
| JSONL tailing                                    | n/a                                      | Final messages only; last resort                           |

**Why MITM is safe to bet on:** Anthropic is heavily enterprise-focused, and enterprise
Claude Code deployments _require_ routing through TLS-inspecting corporate proxies — which
is why `HTTPS_PROXY` + custom-CA support exists. Hard cert-pinning would break those
deployments, so it's unlikely without notice. (No proxy-support changes announced as of
2026-05.)

## Architecture

The content does **not** return through the CLI — input flows down through tmux, and the
model stream comes back from the **proxy tee**. The proxy is a second data source the
runtime owns, parallel to the tmux pane.

```
         input: prompt / interrupt / ESC
client → gateway → session-ext → agent-host ─┐
                                 (ClaudeCliRuntime)
                                              │ tmux paste-buffer / send-keys / ESC
                                              ▼
                                   claude CLI  (real TUI in tmux pane)
                                              │ HTTPS  (NODE_EXTRA_CA_CERTS ⇒ trusts our CA)
                                              ▼
                                   MITM proxy (Bun.serve, TLS)
                              tee SSE ────────┼──────── forward to real api.anthropic.com
                                              ▼              (real IP via DoH, avoids hosts loop)
                              ClaudeCliRuntime.emit("sse")
                                              │
        session-host buffers ⇒ broadcast ⇒ session-ext ⇒ gateway ⇒ clients
```

### Why the blast radius is small

The proxy emits **native Anthropic SSE**, which is the exact shape `sdk-session.ts`
already emits as `"sse"` events. So event translation is nearly an **identity function**,
and `SessionHost`, the event buffer, the WS protocol, the session extension, and all
clients **need zero changes**.

## Key decisions

1. **Swap under the `"claude"` provider key**, gated by config — clients stay oblivious:

   ```ts
   // packages/agent-host/src/server.ts
   claude: config.claudeRuntime === "cli"
     ? createClaudeCliProvider(config.agentHost?.claudeCli)
     : createAnthropicProvider({ ... }),
   ```

   `agent: "claude"` (and the default) routes to whichever runtime. SDK stays as instant
   rollback. session/chat/voice/UI unchanged.

2. **CLI executes its own tools** — no `sendToolResult` round-trip. `setPermissionMode`
   becomes a no-op; we launch with `--dangerously-skip-permissions`.

3. **Disable interactive tools at parity with the SDK** via `--disallowedTools
AskUserQuestion EnterPlanMode ExitPlanMode` (same list as `DISALLOWED_TOOLS` in
   `sdk-session.ts`; not used in the SDK runtime either). _(Verify exact flag name during
   Phase 0.)_

4. **History/resume are free** — the real CLI writes the same JSONL Claude Code always
   has, so existing `get_history` / `resolveSessionPath` / `--resume` reading works as-is.

### Differences from the SDK runtime

| Concern           | SDK runtime        | CLI runtime                                                   |
| ----------------- | ------------------ | ------------------------------------------------------------- |
| Tool execution    | SDK auto-runs      | Real CLI runs its own tools                                   |
| Permissions       | `canUseTool`       | `--dangerously-skip-permissions`; `setPermissionMode` → no-op |
| Interactive tools | auto-approve logic | disabled via `--disallowedTools`                              |
| History (JSONL)   | SDK writes         | CLI writes identical JSONL → reading unchanged                |
| Streaming content | SDK stdout         | proxy tee                                                     |
| Image paste       | inline base64      | `~/.anima/pastes/{uuid}` + `[Pasted image: <path>]` (Phase 3) |

## Phases

### Phase 0 — Functional spike & recon (do now, while still testable)

- Minimal `Bun.serve` pass-through proxy + one `claude` session via `ANTHROPIC_BASE_URL`.
- Confirm streaming SSE flows into the existing chat UI; terminal-stop logic groups a turn.
- **Recon:** log inbound `Authorization` / `x-api-key` and response `anthropic-ratelimit-*`
  headers to learn _today_ whether base-URL forwards the OAuth token. This decides how
  urgently we need Phase 2. Scratch code in `tmp/`.

**✅ Results (2026-05-23, `tmp/cli-runtime-spike/recon.ts`):**

- base-URL pass-through **forwards the OAuth subscription token** (`Authorization: Bearer
sk-ant-oat01-…`, no `x-api-key`).
- Anthropic billed it against the **subscription** — response carried
  `anthropic-ratelimit-unified-5h/-7d` buckets (the Max plan windows), not API rate limits;
  `overage-status: rejected` (subscription-only org).
- **SSE streamed through the tee intact** (`message_start → content_block_delta → message_stop`).
- The request advertised `user-agent: claude-cli/… sdk-ts, agent-sdk/…` + `oauth-2025-04-20`
  and **still billed as subscription** ⇒ the "SDK outside subscription" enforcement is **not
  active yet**; the risk is a future client/server change (untestable until enforced).

**Implication:** Phase 1 can be built and validated on **base-URL today**; MITM (Phase 2)
is the durability hedge, not a blocker. (Recon used `claude -p` — re-confirm auth/billing
with the real TUI in Phase 1.)

### Phase 1 — `ClaudeCliRuntime` core (interception-agnostic)

New `packages/agent-host/src/providers/cli/session.ts` implementing `AgentRuntimeSession`.

- **tmux orchestration**: spawn with `--session-id` / `--resume`; poll `capture-pane`
  until the prompt renders (replace the prior art's 4s fixed delay); multi-line via
  `load-buffer` + `paste-buffer` (no newline mangling); `ESC` = interrupt; reuse existing
  tmux session gracefully on resume.
- **Proxy**: `Bun.serve` + `response.body.tee()` → parse SSE → `emit("sse", event)`.
- **Event mapping** (mostly identity): pass native SSE through; synthesize `turn_stop`
  from terminal `message_stop`; extract `request_tool_results` from POST bodies; emit
  `process_started` / `process_ended` / `api_error`.
- **Free UX win**: detect Haiku title-gen `message_stop` → emit `session.title_generated`.
- **Deterministic port per session id** (resume hits the same proxy).
- **Config**: add `claudeRuntime` + `claudeCli` block to `AgentHostConfig`
  (`packages/shared/src/config.ts`).

### Phase 2 — MITM hardening (isolated module, slots under Phase 1's proxy)

- **Own CA** at `~/.anima/proxy/ca.pem` (+ leaf for `api.anthropic.com`), generated once.
- **Per-process trust**: `NODE_EXTRA_CA_CERTS` only in the claude subprocess env — no
  system-wide cert install.
- **Transparent redirect**: `api.anthropic.com` → local proxy (lifecycle-managed
  `/etc/hosts` entry) so the client never sees a custom URL.
- **Avoid the upstream loop**: proxy resolves the real Anthropic IP via DoH (1.1.1.1) and
  connects with `SNI/Host = api.anthropic.com`.
- **Pluggable mode**: `interception: "base-url" | "mitm"` — same teed stream either way.

### Phase 3 — Production-ready

- **Image paste fallback**: clients write `~/.anima/pastes/{uuid}.{ext}`, inject
  `[Pasted image: <path>]`; CLI reads via Read tool.
- Health checks + agent-host supervision + crash-restart of the proxy.
- Concurrent sessions: disambiguate interleaved proxy requests by session id in body.
- Voice-mode latency measurement (SSE → `voice.speak`) vs current SDK.
- Flip default `claudeRuntime: "cli"` once stable.

## Open questions / risks

- 🔴 **Subscription billing through the proxy** — untestable until Anthropic enforces.
  Mitigation: MITM makes the request indistinguishable from normal.
- 🟡 Tool-use loop stitching — one prompt → N SSE streams; confirm terminal-stop grouping.
- 🟡 Multi-line paste reliability across the TUI.
- 🟡 Image-paste UX regression (extra Read round-trip).

## Integration map (file → role)

| Component           | File                                                         | Role                                                       |
| ------------------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| Provider interface  | `packages/agent-host/src/provider-types.ts`                  | `AgentRuntimeSession` / `AgentRuntimeFactory` to implement |
| Provider registry   | `packages/agent-host/src/server.ts`                          | register `claude` factory by `claudeRuntime` flag          |
| Session lifecycle   | `packages/agent-host/src/session-host.ts`                    | wires `"sse"` → buffer → broadcast (unchanged)             |
| New runtime         | `packages/agent-host/src/providers/cli/session.ts`           | **new** — tmux + proxy orchestration                       |
| SDK runtime (ref)   | `packages/agent-host/src/providers/anthropic/sdk-session.ts` | event shapes to mirror                                     |
| Codex runtime (ref) | `packages/agent-host/src/providers/codex/session.ts`         | second-runtime pattern to mirror                           |
| Config schema       | `packages/shared/src/config.ts`                              | add `claudeRuntime` + `claudeCli`                          |
| Prior art           | `/Users/michael/Projects/claudia/cctest/claudia-sdk.ts`      | proven proxy/tmux logic to port + improve                  |

## References

- Anthropic clarification: https://x.com/ClaudeDevs/status/2054610152817619388
- Prior art: `/Users/michael/Projects/claudia/cctest/claudia-sdk.ts`
- Issue: #33
