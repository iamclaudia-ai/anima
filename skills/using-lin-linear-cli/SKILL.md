---
name: using-lin-linear-cli
description: "MUST be used when creating, updating, searching, assigning, or commenting on Linear issues — anything beyond reading a known ticket ID. `lin` is a human-friendly wrapper over `linctl graphql` that resolves team/project/user names and issue identifiers to IDs internally, so you stop fumbling syntax. Covers child issues with parent links, assigning to other users, fuzzy user/team/project lookup, filtered search, the learned disambiguation cache, and the raw GraphQL escape hatch. Triggers on: linear ticket, create issue, child ticket, sub-issue, assign ticket, assign to, link parent, search linear, find tickets, linear comment, update issue, lin cli, linctl, who is on linear, ambiguous name linear."
---

# Using `lin` — the Linear CLI

`lin` is a thin wrapper over `linctl graphql` (`~/dotfiles/scripts/lin.ts`, symlinked to `~/.local/bin/lin`). It exists because `linctl`'s first-class commands can't set a parent or assign to other users, and because every non-trivial Linear task used to mean fumbling name→ID resolution. `lin` accepts **human values** (team keys, project/user names, issue identifiers) and resolves them to IDs internally.

It shells out to `linctl graphql`, so it inherits linctl's existing auth — no separate token, no MCP.

## When to use `lin` vs `linctl`

- **Reading a known ticket:** either works (`lin get BEE-123` delegates to `linctl issue get`).
- **Everything else** (create, child, assign-to-someone-else, search by filters, comment with multi-line body, update): **use `lin`**. `linctl issue create` literally cannot set `--parent` or assign to anyone but yourself.

## Core commands

```bash
lin who <query>            # fuzzy user lookup (name/displayName/email) + their teams
lin team <query>           # fuzzy team lookup (name or key)
lin project <query>        # fuzzy project lookup (name)
lin get <id>               # show an issue (delegates to linctl)

lin find [filters]         # search: -t/--team --project -a/--assignee -s/--state --query --limit --include-completed
lin new --title ... -t ... # create issue (full power)
lin child <parent> ...     # create child issue — inherits parent's team + project automatically
lin update <id> [opts]     # update title/assignee/state/parent/project/labels/priority
lin comment <id> [opts]    # add a comment

lin cache [clear]          # show (or clear) the learned MRU cache
lin gql '<query>' ['<vars-json>']   # raw GraphQL escape hatch
```

## The five things that used to be painful (now one command each)

```bash
# 1. Child ticket + parent link + assign to another user — one command
lin child BEE-20001 --title "Wire up API" --assignee phil

# 2. Find the right username (disambiguates, shows teams + guest status)
lin who phil

# 3. Filtered search
lin find -t BEE --project group -a me --state "In Progress"

# 4. Create with project/state/priority, all by name
lin new --title "Fix bug" -t WEB --project "group" -a me --priority high

# 5. Assign on update (same --assignee everywhere — no create/update flag drift)
lin update BEE-20001 -a "Phil Mills" -s "In Review"
```

## Name resolution rules (how ambiguity is handled)

Resolution is **fail-loud, never silent**. For users, in order:

1. **`me`** → the authenticated viewer.
2. **Exact** email / displayName / full-name match wins.
3. **Team-membership filter** — if the issue's team is known, candidates not on that team are dropped. _This dissolves most "two people, same name" cases for free._ (Example: there are two Phils, but they never share a team, so `--team BEE` or a BEE project resolves "phil" → Phil Mills unaided.)
4. **Recency (scoped MRU)** — if still ambiguous, the most-recently-resolved matching user _in this scope_ wins, with an `ℹ …` note to stderr.
5. Still ambiguous → **stop with exit 1** and list candidates.

When you hit an ambiguity error, you have two moves:

- Pass an unambiguous value once: `--assignee phil@beehiiv.com` (or the exact display name). **This also teaches it** — see below.
- Add context that disambiguates: `--team BEE`.

## Projects: partial names + the MRU cache

**Never type a full project name, and never type the em-dash.** beehiiv project names are full of `—` (sometimes with double spaces, e.g. `Podcast  — Phase 2`) which is painful and error-prone from a shell. `lin` fuzzy-matches with `containsIgnoreCase`, so pass a **distinctive partial**:

```bash
--project "group sub"   # → Group Subscriptions MVP
--project "505"         # → 505 Podcast Partnership
```

Projects often cluster (`Foo — MVP`, `Foo V2`, `Foo — Phase 2`…), so a partial can match several. Resolution handles that **without an LLM**, fail-loud:

1. Exact or single match → use it, and **record it to the MRU**.
2. Multiple matches → if one (or more) is in the **MRU**, auto-pick the _most recently used_ and print an `ℹ …` note to stderr.
3. Multiple matches, none in MRU → **stop with exit 1**, list candidates. Re-run with a more specific partial; the one that resolves is remembered, so next time the loose query auto-picks it.

The MRU (`projectMru` in the cache) is also fed whenever you **work a specific ticket** — `lin child <id>` / `lin update <id>` push that ticket's project to the front. So in a normal session you rarely hit ambiguity for `new`: you've already touched tickets in the active project, and the loose `--project` partial resolves straight to it.

**Don't hardcode the project** — infer it from the ticket you're working from or the conversation, pass a partial, and let the MRU do the disambiguating. `lin cache` shows the current MRU.

## How learning works: success IS the learning

There is **no explicit teach step** (no `--learn` flag). Every time a name resolves to exactly one user or project, `lin` records it to an MRU; the next ambiguous lookup uses that recency. The cache is "frozen intelligence" — you make the smart call once (by typing an exact name/email), and the dumb script replays it forever.

The flow when two people genuinely share a team:

```bash
lin child BEE-20001 --title "..." --assignee chris      # ✗ two Chrises on BEE → fail loud, lists both
lin child BEE-20001 --title "..." --assignee "Chris Smith"   # ✓ exact → resolves AND records
lin child BEE-20002 --title "..." --assignee chris      # ✓ auto-resolves Chris Smith (recency)
```

**Scoping matters and is deliberate:** projects use one **global** MRU (you move between projects sequentially, so recency = current focus). Users are scoped **project → team → global**, recording into the most specific scope available. A global user MRU would silently mis-pick the same first-name across different projects — exactly the clever-but-silent failure to avoid. So `chris` learned in one project does **not** leak to another; it'll fail loud there until you resolve it once in that context.

## Multi-line descriptions & comments

Three input modes for `--description` (new/update) and `--body` (comment):

```bash
lin comment BEE-1 --body "short inline"
lin comment BEE-1 --body-file notes.md
printf 'multi\nline' | lin comment BEE-1 --body -        # stdin
lin new --title X -t BEE --description "$(cat <<'EOF'     # HEREDOC
Multi-line
body
EOF
)"
```

## Flags (kept close to linctl where they overlap)

`-t/--team` · `--project` · `--parent` · `-a/--assignee` · `-m/--assign-me` · `-d/--description` · `--description-file` · `-b/--body` · `--body-file` · `-s/--state` · `--labels a,b` · `--priority none|urgent|high|normal|low|0-4` · `--query` · `--limit` · `--include-completed` · `-j/--json`

Use `-j/--json` when you need to parse output (e.g. grab `.id`/`.identifier` with `jq`).

## Escape hatch

Anything `lin` doesn't wrap, reach the Linear API directly — this is how the wrapper itself works, and how it was built:

```bash
lin gql 'query($id:String!){ issue(id:$id){ id identifier title } }' '{"id":"BEE-20001"}'
# or call linctl directly:
linctl graphql -j -q '<query>' --variables '<json>'
```

`issueDelete` trashes (soft-deletes / archives) — it won't appear on the active board but lingers under `includeArchived:true` until Linear purges it.

### Closing as duplicate

```bash
lin dupe BEE-19635 BEE-19285                                   # mark BEE-19635 as duplicate of BEE-19285
lin dupe BEE-19635 BEE-19285 -b "shipped in PR #23756"          # same + post a comment in one shot
```

Order matters under the hood: Linear refuses to move an issue into the **Duplicate** workflow state unless the duplicate-of relation already exists (API rejects with `"missing duplicate relation"`). `lin dupe` does relation-then-state-then-optional-comment in the right order. The optional `-b` is recommended when the _why_ isn't obvious from the title — it's the human/AI reasoning the wrapper deliberately doesn't synthesize.

If you ever need to do it by hand (different relation type, batched mutation, etc.) — note that `IssueRelationType` is a GraphQL enum, so the value goes in bare without quotes: `type: duplicate`.

## Extending it

This tool is built to grow. When a Linear task feels clunky, add a command or flag to `~/dotfiles/scripts/lin.ts` (no build step — `#!/usr/bin/env bun` shebang, edit and run). Default values for beehiiv work live in `~/Projects/beehiiv/CLAUDE.md` (team WEB, assignee michael.carter, current project).
