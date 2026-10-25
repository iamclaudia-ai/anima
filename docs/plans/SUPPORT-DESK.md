# Support Desk

Status: in progress (started 2026-10-24)

## Why

Michael runs NutWords (and other projects) on the side. Support email, forum
posts and Sentry errors arrive faster than he can answer them, and users wait
weeks. On Oct 24 six NutWords support emails were forwarded to Claudia's
mailbox. The Mail session summarized them well, but it could not act: it has no
shell, so it can't open the code, file an issue, or hand the work to anyone.

The goal is a small support desk that runs without Michael prompting it:

1. Something arrives from outside: an email, a Sentry alert, a GitHub event.
2. The front-desk session ("Support Lady", today's Mail session) triages it into
   a **ticket**, grouped with others about the same problem.
3. She **delegates** real work to an `auto` session in the right project, or
   files a **GitHub issue**.
4. GitHub events move tickets forward: when the fixing PR merges, its tickets
   become "fixed, reply owed", and the people who reported it get an answer.
5. Michael sees everything open, across projects, on one page.

## Pieces

### 1. Workspace project fields (session extension)

Workspaces already map a name to a folder. They gain:

| Field            | Example                                                     | Source                     |
| ---------------- | ----------------------------------------------------------- | -------------------------- |
| `description`    | "NutWords: word game, revival of The Nuthouse"              | set by hand                |
| `aliases`        | `["nutwords", "the nuthouse", "tnh"]`                       | set by hand                |
| `emailDomains`   | `["nutwords.com", "mail.nutwords.com", "the-nuthouse.com"]` | set by hand                |
| `githubRepo`     | `kiliman/tnh`                                               | detected from git `origin` |
| `sentryProjects` | `["nutwords-api", "nutwords-web"]`                          | set by hand                |

- `session.update_workspace` sets them (`detect: true` fills `githubRepo` from git).
- `session.find_workspace` resolves a name, alias, email domain, GitHub repo or
  Sentry project to one workspace. Everything else (delegation, Sentry and
  GitHub routing) goes through it, so "NutWords" means one thing everywhere.

### 2. Support extension (`extensions/support`)

A Linear-lite. GitHub stays the source of truth for code work; the support
extension tracks **people and problems** and links out to issues and PRs.

Why not just GitHub Issues: one bug reported by three people is one issue but
three people owed a reply. GitHub can't track "Gail hasn't heard back", and it
has no view across repos.

**Tables** (migration 029):

- `support_tickets`: `#id`, workspace, title, summary, status
  (`new → triaged → in_progress → waiting → fixed → closed`), priority, whether
  it came from a **trusted** source, whether Michael **approved** it, timestamps.
- `support_reports`: each report that fed a ticket: source (`email`, `sentry`,
  `forum`, `github`, `manual`), external id (Zoho message id, Sentry issue id),
  reporter name and email, URL, summary, trusted, `replied_at`. Unique on
  `(source, external_id)`, so the same email or Sentry issue never makes two
  tickets.
- `support_links`: GitHub issues, PRs, delegated sessions and Sentry issues, with
  their state (`open`, `closed`, `merged`, `resolved`).
- `support_activity`: a timeline per ticket (who did what, when).

**Reply owed** is computed, not stored: a ticket that is `fixed` and has a
report with a reporter email and no `replied_at`.

**Methods** (CLI and web): `list_tickets`, `get_ticket`, `create_ticket`,
`update_ticket`, `add_report`, `link`, `note`, `mark_replied`, `approve`,
`delegate`, `create_issue`, `list_projects`, `handle_github`, `handle_sentry`.

**MCP tools for Support Lady** (no shell): list/get/create/update tickets, add a
report, link, note, delegate, create an issue, list projects. Not exposed:
`approve`, `mark_replied`, and any report source other than `email` and `forum`.

**Web page** `/support`: open tickets grouped by project, oldest first, with a
"needs reply" filter; ticket detail with reports, links and the timeline;
buttons to change status, approve, and mark replied.

### 3. Delegation

`support.delegate({ ticketId, task })` starts an `auto` session in the ticket's
workspace (`session.spawn_agent`, `parentSessionId: "NEW"`). The extension
decides everything that matters for safety:

- **Profile**: always `auto`. Never a parameter.
- **Folder**: the workspace's `cwd`. Never a parameter.
- **Who can trigger it**: only a ticket from a trusted source (an email
  verified from Michael, Sentry, GitHub, or one created by Michael or Claudia)
  or one Michael approved. A stranger's email can't start a session by itself.
- **Rate**: at most `delegation.maxPerHour` (default 4).
- **Prompt**: built by the extension: the ticket, the task, the reports (email
  ids so OC can `mail_read` them, marked untrusted), and the boundaries: read
  production data only, no deploys, merges, production writes or contacting
  users; code in its own git worktree; put `Support ticket #N` in any PR body.
- The session is linked to the ticket (`kind: session`) and titled
  `<Project> · #N <title>`.

`support.create_issue` runs `gh issue create` in the workspace's `githubRepo`
(as Claudia's GitHub account). A public repo needs the ticket approved first,
so a customer's words never land in a public issue unreviewed.

### 4. Webhooks

Both arrive through the webhooks extension (`https://webhooks.kiliman.dev/hook/<name>/<secret>`),
which verifies the HMAC and retries the target on failure.

**GitHub** (`github` hook, `x-hub-signature-256`, hex, `sha256=` prefix, raw body):

- `ping` → ok.
- `issues` `closed`/`reopened` → update linked issue links; a ticket whose
  links are all closed or merged becomes `fixed`.
- `pull_request` `opened`/`edited` with `Support ticket #N` in the body, in the
  ticket's own repo → link the PR to ticket N.
- `pull_request` `closed` with `merged: true` → mark the PR link merged; its
  tickets become `fixed` (reply owed if anyone reported it).

**Sentry** (`sentry` hook, internal integration, `sentry-hook-signature`, hex,
HMAC-SHA256 with the client secret over the raw body; `sentry-hook-resource`
names the resource):

- `issue.created` → a ticket for the workspace whose `sentryProjects` include
  `data.issue.project.slug` (a report with `source: sentry`, `external_id` =
  issue id, linked to the Sentry issue).
- `issue.resolved` → the Sentry link becomes `resolved`; the ticket `fixed`.
- `issue.unresolved` (regression) → reopened.
- `event_alert.triggered` → the same as `issue.created` for its issue (alert
  rules decide what's worth a ticket).
- Anything else → ignored (stored by the webhooks inbox anyway).

Sentry wants a response within 1 second. The webhooks extension replies 200 as
soon as the delivery is stored and calls the target afterwards, so that holds.

### 5. The front desk wakes for tickets too

Today the mail wake queue owns the daily session. New tickets from Sentry (and
later GitHub) need to reach the same session. Plan: the queue accepts generic
notices (`mail.notify`, called by the support extension), and the session is
renamed from "Mail" to "Support" once it handles more than mail.

### 6. Replies (was mail Step 4)

Reply drafts for "reply owed" tickets, sent only to the reporter, after
Michael approves each one (or a standing rule he sets). Until then, Support Lady
drafts and Michael sends.

## Safety model

Michael's bar: "we don't need a bulletproof system, just so OC doesn't reformat
the computer." So:

- Support Lady reads strangers' words, so she gets **narrow tools**: no shell,
  no file access, no choice of profile or folder.
- Delegated sessions run in `auto` mode, which blocks destructive commands, and
  their prompt sets the boundaries above.
- Trust is computed by the extension, never claimed by the caller: email trust
  comes from the mail extension (DMARC-verified and in `trustedSenders`), and
  Sentry and GitHub trust from their signatures.

## Build order

1. Workspace project fields. ✅ (e473be3, 0721209)
2. Support extension: tables, methods, MCP tools, web page. ✅ (3d664a2)
3. Delegation and `create_issue`. ✅ The Mail session's wake prompt and
   profile include the support tools (5dafc9e).
4. GitHub and Sentry handlers. ✅ Both hooks are configured in
   `extensions.webhooks.config.hooks`; `github` is tested end to end through
   the tunnel (signed deliveries reach `support.handle_github`, a forged one
   gets 401). Still to do on the services:
   - **GitHub**: add a webhook on `kiliman/nutwords` (issues + pull requests,
     JSON) pointing at the `github` hook. Needs repo admin.
   - **Sentry**: create an internal integration with webhooks for `issue`
     (and alert rule action) pointing at the `sentry` hook, put its client
     secret in the hook's signature, and set `enabled: true`. Then set the
     tnh workspace's `sentryProjects` to the API and web project slugs.
5. Front-desk notices (Sentry wakes Support Lady), rename Mail → Support.
6. Replies.

Seeded on Oct 24: tickets #1–#6 from the forwarded NutWords emails, linked
to the issues (#127–#129, #132, #133), draft PRs (#130, #131, #134) and the two
OC sessions that investigated them.

Later: tnh's skills and scripts as MCP tools; a generic method → MCP bridge for
trusted sessions; per-session MCP tokens so the gateway enforces a profile's
tool list.
