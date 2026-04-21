---
name: generating-status-updates
description: "Generate a daily status update for Slack from GitHub PRs and Linear tickets. Queries multiple repos for merged/open PRs and Linear for closed/in-review tickets, then formats as copy-pasteable Slack markdown. Use when: status update, daily standup, what did I ship, end of day summary, EOD update, standup report."
---

# Generating Status Updates

Compile Michael's daily status update for Slack by pulling data from GitHub and Linear.

## Arguments

- `$ARGUMENTS` — Optional. A date range like `today`, `yesterday`, `2 days`, `this week`, or a specific date like `2026-04-06`. Defaults to **today** (current UTC date).

## Step 1: Determine the Date Range

Parse `$ARGUMENTS` to determine the start date:

- `today` or empty → today's UTC date
- `yesterday` → yesterday's UTC date
- `2 days` / `3 days` → that many days back from today
- `this week` → Monday of current week
- A specific date like `2026-04-06` → that date

Store as `$SINCE_DATE` in `YYYY-MM-DD` format.

## Step 2: Gather GitHub PRs

Query PRs authored by `kiliman` across **all configured repos**.

**Repos to query:**

- `beehiiv/swarm`
- `beehiiv/subscribe-forms`

> If Michael mentions other repos, add them here. Run all repo queries in parallel.

For each repo:

```bash
gh pr list --author kiliman --state all --search "updated:>=$SINCE_DATE" --limit 50 --repo $REPO --json number,title,state,mergedAt,createdAt,url
```

**Include a PR if:**

- `state` is `MERGED` and `mergedAt >= $SINCE_DATE`
- `state` is `OPEN` (currently in review)

**Sort by:** `mergedAt` (merged PRs first, then open PRs)

## Step 3: Gather Linear Tickets

```bash
linctl issue list --assignee me --include-completed --json --limit 50 --sort updated
```

Filter to tickets where:

- `updatedAt >= $SINCE_DATE`
- State is one of: `Done`, `In Review`, `Closed`, `QA`

## Step 4: Deduplicate Tickets from PRs

Extract ticket IDs from PR titles using regex patterns: `BEE-\d+`, `WEB-\d+` (comma-separated or bracketed).

Remove any Linear ticket from the QA section if its ID already appears in a PR title — those are already represented.

## Step 5: Format as Slack Markdown

```
`Status update`
*Merged*
* :partymerge: [PR title TICKET-ID](PR_URL)

*In Review*
* :partymerge: [PR title TICKET-ID](PR_URL)

*Tickets Closed/In Review*
* [TICKET-ID: "Ticket title"](LINEAR_URL)
```

### Formatting Rules

- **All PRs** use `:partymerge:` emoji (both merged and in-review)
- **Group PRs** into `*Merged*` and `*In Review*` sections

- **PR titles**: Clean up bracket notation — use `scope: description TICKET-ID` format (ticket ID at end, no brackets)
  - `feat(embeds): V3 subscribe form backend setup [BEE-15339]` → `feat(embeds): V3 subscribe form backend setup BEE-15339`
  - If multiple tickets: `fix(forms): fix stuff [BEE-123] [BEE-456]` → `fix(forms): fix stuff BEE-123, BEE-456`
- **Ticket titles**: Include identifier prefix, then the title
- **Linear URLs**: Use the `url` field from linctl JSON output
- **Omit empty sections**

## Step 6: Present to Michael

1. Output the formatted Slack markdown in a **code block** so he can copy-paste directly
2. Show a brief count: "X PRs across Y repos, Z tickets"
3. Ask if he wants to add a headline/theme description or adjust anything
