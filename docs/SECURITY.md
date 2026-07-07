# Security Model

Anima is a personal, single-user agent system. It is intentionally powerful: the
agent can operate local tools, long-lived CLI sessions, code, files, and private
state. The security model is therefore built around reducing reachable attack
surface, authenticating every control path, and keeping the system auditable.

This document describes the current baseline and the checks that should keep it
from regressing.

## Threat Model

### In Scope

- Remote access to the web UI and watchdog through Tailscale plus Caddy.
- Local HTTP/WebSocket services: gateway, agent-host, watchdog, CLI proxy, and
  optional webhook servers.
- Browser-held gateway tokens.
- Local configuration, logs, transcripts, databases, and MITM proxy material in
  `~/.anima`.
- Extension, MCP, skill, and dependency supply chain risk.

### Out of Scope

- A fully compromised host OS or user account.
- Multi-user or tenant isolation. Anima is not designed as a hosted SaaS.
- Public internet exposure without an upstream access-control layer.

## Guiding Principles

### Trust No External Code

Do not blindly execute code from package registries, skill hubs, MCP catalogs, or
community repositories. Download counts, stars, ratings, and "official-looking"
names are weak signals. The useful signal is the code that actually runs.

Anima should prefer:

- local extensions and MCP servers we build or review
- small dependency surfaces
- known authors and repositories with real history
- no "download and run" workflows for agent-executed tools

### Permission Fatigue Is Real

Repeated allow/deny prompts stop being meaningful after enough clicks. Anima
does not rely on prompts as the primary security boundary. It relies on network
binding, token authentication, local-first execution, and explicit trust in the
single operator.

### Exposed Agent Servers Are Critical Risk

An exposed agent control server is effectively remote code execution against the
user account. If it can reach tokens, SSH keys, source code, databases, session
history, or shell commands, it must be treated as sensitive infrastructure.

### The Agent Has Local-Admin-Level Consequences

Even without root, an agent running as the user can access highly sensitive
material: source code, credentials, browser-accessible apps, git remotes,
private logs, and shell state. A compromised agent path can become credential
theft, data exfiltration, or persistence.

## Current Security Baseline

### Network Binding

All Anima-owned control services should bind to loopback:

| Service                    | Port                    | Expected bind |
| -------------------------- | ----------------------- | ------------- |
| Gateway                    | `30086`                 | `127.0.0.1`   |
| Agent-host                 | `30087`                 | `127.0.0.1`   |
| Watchdog                   | `30085`                 | `127.0.0.1`   |
| Code server                | `30088`                 | `127.0.0.1`   |
| Claude CLI proxy internals | ephemeral/base          | `127.0.0.1`   |
| Scheduler webhook server   | `30089` default if used | `127.0.0.1`   |

Caddy is the remote entry point for Tailscale-reachable HTTPS routes. Current
intended routes:

- `anima.kiliman.dev` -> `127.0.0.1:30086`
- `watchdog.kiliman.dev` -> `127.0.0.1:30085`
- `webhooks.kiliman.dev` -> `127.0.0.1:30089`
- `code.kiliman.dev` -> `127.0.0.1:30088`

The watchdog route is intentionally available remotely so the gateway can be
restarted when it is stuck. That route is acceptable only because watchdog APIs
also require the Anima gateway token.

### Authentication

Anima uses one local bearer token stored in `~/.anima/anima.json` under
`gateway.token`.

Required behavior:

- Gateway WebSocket and protected HTTP routes require the token.
- Gateway `/health` requires the token.
- Agent-host `/ws` and `/health` require the token.
- Watchdog status, logs, and restart APIs require the token.
- Scheduler webhook APIs require the token if the webhook server is enabled.
- Internal clients still send the token, even on loopback.
- CLI watchdog commands send `Authorization: Bearer <token>`.
- The watchdog dashboard prompts for the Anima token, stores it locally in the
  browser, and sends it as `Authorization`.

Query-string tokens are allowed for browser/WebSocket compatibility, but
headers are preferred for normal HTTP requests.

### File Permissions

Sensitive local state should be owner-only:

- `~/.anima`: `0700`
- `~/.anima/anima.json`: `0600`
- `~/.anima/watchdog.json`: `0600`
- `~/.anima/logs`, `~/.anima/sessions`, databases, transcripts: owner-only
- `~/.anima/mitm`: owner-only
- `~/.anima/bin/watchdog`: `0700`
- repo `.env`: `0600`
- `~/.config/code-server/config.yaml`: `0600`

The goal is simple: another local user account should not be able to read the
gateway token, logs, transcripts, DBs, or proxy keys.

### Browser Token Risk

The web UI and watchdog dashboard store tokens in `localStorage`. That is
pragmatic for a single-user tool, but it means XSS can steal the token.

Current mitigation:

- token validation before UI access
- CSP in `Content-Security-Policy-Report-Only` mode
- CSP reports sent to `/api/csp-report`
- `Referrer-Policy: same-origin`
- `X-Content-Type-Options: nosniff`

The report-only CSP is intentionally not enforced yet because the current SPA
still uses inline bootstrap/importmap behavior. Treat report-only as telemetry,
not protection.

## Verification

Run:

```bash
anima doctor
```

`anima audit` is an alias.

The command checks:

- gateway token exists
- sensitive local files are owner-only
- gateway, agent-host, watchdog, and code-server bind to `127.0.0.1`
- Caddy routes for Anima and watchdog proxy to loopback
- watchdog rejects unauthenticated requests and accepts authenticated requests
- agent-host rejects unauthenticated health checks and accepts authenticated ones
- gateway rejects unauthenticated health checks and accepts authenticated ones

Expected result:

```text
0 failed, 0 warning(s)
```

Run this after changing launch agents, Caddy config, service ports, auth code,
or watchdog/gateway startup behavior.

## Operational Checklist

### Network

- [ ] All Anima control services bind to `127.0.0.1`.
- [ ] Remote access goes through Tailscale plus Caddy, not raw exposed ports.
- [ ] `watchdog.kiliman.dev` remains token-protected.
- [ ] `webhooks.kiliman.dev` proxies to the scheduler webhook server only if
      that server remains token-protected.
- [ ] `code-server` binds to loopback and is reachable only through the intended
      Caddy/Tailscale path.
- [ ] Public DNS exposure is reviewed any time a new `*.kiliman.dev` route is
      added.

### Tokens

- [ ] `gateway.token` exists and is not committed.
- [ ] Token is rotated after accidental exposure.
- [ ] Internal services use the token even over loopback.
- [ ] URLs containing `?token=` are not pasted into logs, tickets, screenshots,
      or public docs.

### Local Files

- [ ] `~/.anima` and all sensitive files are owner-only.
- [ ] `.env` is owner-only.
- [ ] Logs and transcripts are treated as private data.
- [ ] MITM certificates/keys are owner-only.

### Extensions, Skills, MCP, and Dependencies

- [ ] No unreviewed extension is enabled.
- [ ] No external skill or MCP server is installed without code review.
- [ ] Dependency upgrades are reviewed for new postinstall scripts, binary
      downloads, network behavior, and unexpected maintainers.
- [ ] Extension `webConfig` contains only client-safe values; secrets stay in
      server-side `config`.

### Logs and Reports

- [ ] CSP reports are reviewed after UI changes.
- [ ] Logs do not intentionally include bearer tokens, API keys, SSH material, or
      full sensitive request bodies.
- [ ] CLI proxy capture remains disabled unless actively debugging.

## Recommendations

### Near Term

1. Move from CSP report-only to enforced CSP once inline scripts/import maps are
   moved to external assets or nonced responses.
2. Add a redaction layer for logs that catches `anima_sk_...`, API keys, GitHub
   tokens, and common bearer-token patterns.
3. Add a `--fix` mode to `anima doctor` for safe local fixes: chmods and
   code-server bind config.
4. Add watchdog dashboard logout/clear-token UI.
5. Add token rotation guidance that restarts gateway, agent-host, and watchdog in
   the correct order.

### Medium Term

1. Prefer Authorization headers over query tokens everywhere except WebSocket
   upgrade constraints.
2. Consider Caddy-level `forward_auth`, Tailscale identity checks, or basic auth
   for `code.kiliman.dev` if it is ever reachable outside trusted devices.
3. Add CI checks for accidental `0.0.0.0`/`hostname: "::"` service binds in Anima
   packages.
4. Add dependency audit notes to release/update workflow.
5. Split public documentation from private operational details so machine-specific
   domains and paths are not published accidentally.

## Incident Response

If token exposure is suspected:

1. Disconnect remote access if needed: stop Caddy or remove the affected vhost.
2. Generate a new token:

   ```bash
   anima token generate
   ```

3. Restart gateway and agent-host:

   ```bash
   anima watchdog restart gateway --force
   anima watchdog restart agent-host --force
   ```

4. Reload browser tabs and re-enter the new token.
5. Review logs for unexpected access:
   - `~/.anima/logs/gateway.log`
   - `~/.anima/logs/watchdog.log`
   - `~/.anima/logs/agent-host.log`
   - Caddy access logs, if enabled
6. Run:

   ```bash
   anima doctor
   ```

If local compromise is suspected, rotate external credentials too: GitHub tokens,
SSH keys, API keys, cloud credentials, and any service tokens reachable from the
user account.
