---
name: reviewing-prs-with-claudia
description: "MUST be used when reviewing GitHub PRs with inline code comments. Uses gh-comment and gh-pr-review CLI extensions for line-specific review comments, batch reviews, thread management, and review submission. Handles the file:line mapping automatically — no manual diff position math needed. Triggers on: review PR, PR review, inline comment, code review, approve PR, request changes, review threads, resolve comment, line comment, submit review, gh comment, gh pr-review."
---

# Reviewing PRs with gh-comment and gh-pr-review

Two complementary `gh` CLI extensions for professional PR reviews from the terminal.

| Tool           | Purpose                                                           | Install                                                                |
| -------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `gh comment`   | **Writing** reviews — inline comments, batch, reactions           | `gh extension install silouanwright/gh-comment` (or build from source) |
| `gh pr-review` | **Reading** reviews — threads, resolve/unresolve, pending reviews | `gh extension install agynio/gh-pr-review`                             |

## When to Use

- Submitting a PR review with inline line-specific comments
- Adding comments to specific file:line locations in a PR diff
- Listing, resolving, or replying to review threads
- Managing pending reviews (start → add comments → submit)

## Review Workflow: Always Use a Worktree

**IMPORTANT:** Always check out a git worktree before reviewing a PR. Diffs alone are not enough — you need full file access to:

- Read surrounding context that isn't in the diff
- Understand how changed code interacts with the rest of the codebase
- Grep for related patterns, usages, and callers
- Verify the change follows existing conventions in neighboring files
- Check for missing changes (e.g., did they update the tests? the types? the serializer?)

### Worktree Setup

```bash
# 1. Get the branch name
REVIEW_BRANCH=$(gh pr view <PR_NUMBER> --json headRefName -q .headRefName)

# 2. Fetch and create worktree
git fetch origin "$REVIEW_BRANCH"
WORKTREE_PATH="$HOME/Projects/beehiiv/swarm.worktrees/$REVIEW_BRANCH"
git worktree add "$WORKTREE_PATH" "origin/$REVIEW_BRANCH"

# 3. Review with full file access
#    - Read files: Read tool with $WORKTREE_PATH/path/to/file.rb
#    - Search code: Grep/Glob in $WORKTREE_PATH
#    - Check related files the diff doesn't show

# 4. Submit review using gh comment (see below)

# 5. CLEAN UP — only after the review is live AND verified (see step 8 in Review Process)
git worktree remove "$WORKTREE_PATH" --force
```

### Pre-Review: Check Existing Review State

**Before diving into a full review, always check if the PR has already been reviewed/approved:**

```bash
# Check existing reviews (approvals, comments, change requests)
gh pr view <PR> --json reviews --jq '.reviews[] | {author: .author.login, state: .state, submittedAt: .submittedAt}' -R owner/repo

# Check existing inline comments
gh api repos/owner/repo/pulls/<PR>/comments --jq '.[] | {user: .user.login, path: .path, body: .body[:80]}'
```

**If the PR is already approved:**

- Tell Michael the PR has been approved (by whom, when)
- Summarize any existing review feedback and whether it's been addressed
- **Ask if he still wants a full review** before proceeding
- If yes, continue with the full review process below
- If no, just stamp the approval and move on

### Review Process

1. **Check existing review state** — See above. Don't duplicate work already done.
2. **Get PR metadata** — `gh pr view <PR> --json title,body,files` for context
3. **Read the diff** — `gh pr diff <PR>` to understand what changed
4. **Read the Linear ticket** — `linctl issue get <KEY>` if the PR mentions one. The ticket often lists the **expected files** for a feature; cross-check that they're all in the diff. Missing files = the PR description is making promises the diff doesn't keep.
5. **Explore in worktree** — Read the full files, not just changed lines. Check callers, tests, related code.
6. **Present findings** — Show review findings to Michael for discussion before submitting
7. **Submit review** — For APPROVE/REQUEST_CHANGES use the **split process**: `gh comment review --event COMMENT` for inline comments, then native `gh pr review --approve` for the decision (see [Submitting Reviews](#submitting-reviews-recommended-pattern)). COMMENT-only reviews can stay in one `gh comment` call.
8. **VERIFY both landed** — Query the API to confirm (a) inline comments attached AND (b) the review decision registered. **0 comments = silent failure; missing APPROVED = the decision didn't take** (see [Verifying a Submission](#verifying-a-submission)).
9. **Clean up worktree** — Only after the review is live AND verified. Don't tear down on "I think we're done."

## Submitting Reviews (Recommended Pattern)

### ✅ Split process for APPROVE / REQUEST_CHANGES (preferred)

**Do NOT use `gh comment review --event APPROVE` to approve.** Observed 2026-05-29 (PRs #24710, #24706): the extension's APPROVE _event_ is flaky — it double-submitted the approval on one PR, and on another the approval never surfaced in the GitHub web UI even though the API reported `APPROVED` (Michael had to approve manually). The inline _comments_ landed fine both times — it's the decision event specifically that misbehaves.

So split the two responsibilities: **`gh comment` for the inline comments** (keeps our line-numbering tweak), **native `gh pr review` for the decision** (renders reliably in the UI, no double-submit).

```bash
# Step 1 — inline comments as a COMMENT review (gh comment, line-mapped)
gh comment review <PR> "Inline note(s) below ⬇️ (full review in the approval)" \
  --comment "path/to/file.rb:42:$(cat /tmp/c1.txt)" \
  --event COMMENT \
  -R owner/repo

# Step 2 — the decision + full summary, native CLI
gh pr review <PR> --approve --body "$(cat /tmp/approve_body.txt)" -R owner/repo
# (or: --request-changes / --comment)
```

This yields two clean review entries: one `COMMENTED` (carrying the inline notes) and one `APPROVED` (carrying the summary). Put the rich review body on the **approval** so it reads as the approval rationale.

### Single command: body + inline comments + decision (COMMENT only)

Fine for **COMMENT** reviews (no decision event). Avoid `--event APPROVE`/`REQUEST_CHANGES` here — use the split process above for those.

```bash
gh comment review <PR> "Review summary here" \
  --comment "path/to/file.rb:42:Your comment on line 42" \
  --comment "path/to/file.ts:10:15:Comment spanning lines 10-15" \
  --event COMMENT \
  -R owner/repo
```

**Events:** `APPROVE`, `REQUEST_CHANGES`, `COMMENT` (default) — but for `APPROVE`/`REQUEST_CHANGES` prefer the split process.

### Comment Format

```
file:line:message           # Single line
file:start:end:message      # Line range (multi-line comment)
```

**Important:** Line numbers refer to lines in the NEW version of the file (right side of the diff). The extension handles the diff position mapping automatically.

### Multi-Comment Reviews — Use Temp Files for Long Messages

When inline comments are long or contain code blocks, backticks, suggestion blocks, or other shell-hostile characters, **write each comment body to a temp file** and inject with `$(cat ...)`. This is the pattern that worked when the YAML batch form silently failed (see warning below).

```bash
# 1. Write each comment body to its own file
cat > /tmp/c1.txt <<'EOF'
This `useRoles()` pattern is duplicated three times in this file.
Extract to a `useCanManage()` hook?
EOF

cat > /tmp/c2.txt <<'EOF'
Eager loading note — see line 15 for the N+1.
EOF

# 2. Submit the review, injecting each body via $(cat)
gh comment review <PR> "$(cat /tmp/body.txt)" \
  --comment "client/src/Foo.tsx:42:$(cat /tmp/c1.txt)" \
  --comment "app/models/bar.rb:15:20:$(cat /tmp/c2.txt)" \
  --event COMMENT \
  -R owner/repo
```

**Why this beats inline HEREDOC:** when you have 4+ long comments, inline HEREDOCs become unreadable and easy to misnest. Temp files keep each comment isolated and reviewable. The skill author's own dogfooding session (PR #23577) needed this pattern after the YAML form parsed to 0 comments.

### Examples

```bash
# Approve with comments — SPLIT: inline via gh comment (COMMENT), decision via native CLI
gh comment review 22365 "Inline notes below ⬇️ (full review in the approval)" \
  --comment "app/models/foo.rb:43:Is pending really a processing state here?" \
  --comment "client/src/utils.ts:28:Tiny copy nit — see suggestion below" \
  --event COMMENT \
  -R beehiiv/swarm
gh pr review 22365 --approve --body "Solid work! A few minor suggestions inline." -R beehiiv/swarm

# Request changes — same split
gh comment review 123 "Blocker inline ⬇️" \
  --comment "app/services/bar.rb:15:20:This block needs error handling" \
  --event COMMENT \
  -R beehiiv/swarm
gh pr review 123 --request-changes --body "Needs fixes before merge — see inline." -R beehiiv/swarm

# Comment only (no decision) — single gh comment call is fine
gh comment review 123 "Discussion items" \
  --comment "app/models/user.rb:55:Consider eager loading here" \
  --event COMMENT \
  -R beehiiv/swarm
```

### Shell Escaping with HEREDOC (Single Body or Comment)

For a single review body or a single inline comment with shell-hostile characters, inline HEREDOC works:

```bash
gh comment review <PR> "Inline note below ⬇️ (full review in the approval)" \
  --comment "$(cat <<'EOF'
client/src/components/Foo.tsx:42:Nit: This `roles?.includes('admin') ?? false` logic is duplicated. Consider extracting to a `useCanManage()` hook.
EOF
)" \
  --event COMMENT \
  -R beehiiv/swarm
gh pr review <PR> --approve --body "$(cat <<'EOF'
Clean implementation! The `useRoles()` pattern is consistent with existing code.
One minor suggestion — see inline comment.
EOF
)" -R beehiiv/swarm
```

The `<<'EOF'` (quoted) form prevents ALL shell interpolation — backticks, parentheses, quotes all pass through verbatim.

For 2+ long comments, prefer the temp-file pattern above.

## Verifying a Submission

**Always verify after submitting — BOTH the comments and the decision.** The API reporting `APPROVED` is not enough on its own (it disagreed with the web UI on 2026-05-29), so confirm the roll-up `reviewDecision` too, and that there's exactly one decision review (no double-submit) on the current head.

```bash
# 1. Did MY inline comments actually attach?
gh api repos/<owner>/<repo>/pulls/<PR>/comments \
  --jq '.[] | select(.user.login == "<your-login>") | {path, line, body: .body[:80]}'

# 2. Did the DECISION register? Check the roll-up + the review rows.
gh pr view <PR> -R <owner>/<repo> --json reviewDecision --jq .reviewDecision   # expect APPROVED
gh api repos/<owner>/<repo>/pulls/<PR>/reviews \
  --jq '.[] | select(.user.login == "<your-login>") | "\(.state)\t@\(.commit_id[0:8])"'
gh pr view <PR> -R <owner>/<repo> --json headRefOid --jq .headRefOid           # APPROVED commit must match
```

Expected: one entry per `--comment` you passed, `reviewDecision == APPROVED`, and a single `APPROVED` review on the current head SHA. If comments show 0 → re-submit the `--comment` form. If the decision didn't take → re-run `gh pr review --approve`. **Don't tell Michael the review is done until you've seen both the comments AND `APPROVED` come back from the API.**

## ⚠️ Avoid `gh comment batch` (YAML Form) — Schema is Fragile

The `gh comment batch <PR> review.yaml` form **silently parses to 0 comments** when the YAML schema doesn't match what the installed binary expects (versions drift between the README and the local extension). The review summary still posts, but every inline comment is dropped — and there's no error.

**If you must use it, ALWAYS dry-run first:**

```bash
gh comment batch <PR> /tmp/review.yaml --dry-run --verbose -R owner/repo
# Look for: "Comments to process: N" — if it says 0, the schema is wrong
```

**Recommendation: just use `gh comment review --comment ...` (above).** It's the documented primary path, accepts identical content, and never silently drops comments.

## Reading & Managing Reviews

### List Comments on a PR

```bash
# All comments
gh comment list <PR> -R owner/repo

# Only review (inline) comments
gh comment list <PR> --type review -R owner/repo

# Recent comments by a specific author
gh comment list <PR> --author "username" --recent -R owner/repo

# JSON output for processing
gh comment list <PR> --format json -R owner/repo
```

### List Review Threads

```bash
# All threads
gh pr-review threads list <PR> -R owner/repo

# Unresolved threads only
gh pr-review threads list <PR> --unresolved -R owner/repo

# My threads only
gh pr-review threads list <PR> --mine -R owner/repo
```

### Resolve / Unresolve Threads

```bash
# Resolve a thread by comment ID
gh comment resolve <comment-id> -R owner/repo

# Resolve via gh-pr-review (uses thread ID)
gh pr-review threads resolve <PR> --thread-id <THREAD_ID> -R owner/repo

# Bulk resolve all open threads
gh comment list <PR> --ids-only --type review -R owner/repo | xargs -I {} gh comment resolve {} -R owner/repo
```

### Reply to a Review Comment

```bash
# Reply to an existing comment thread
gh comment review-reply <comment-id> "Fixed in latest commit" -R owner/repo

# Reply and resolve in one step
gh comment review-reply <comment-id> "Done!" --resolve -R owner/repo
```

## Advanced: Pending Reviews (gh-pr-review)

For reviews that need to be built incrementally:

```bash
# 1. Start a pending review (returns a PRR_ ID)
gh pr-review review --start -R owner/repo <PR>

# 2. Add comments one at a time
gh pr-review review --add-comment \
  --review-id PRR_kwDOAAABbcdEFG12 \
  --path src/file.go \
  --line 42 \
  --body "nit: use helper" \
  -R owner/repo <PR>

# 3. Submit the pending review
gh pr-review review --submit \
  --review-id PRR_kwDOAAABbcdEFG12 \
  --body "Overall looks great" \
  --event APPROVE \
  -R owner/repo <PR>
```

## Other Useful Commands

```bash
# Check which lines are commentable in a file's diff
# Default SHOWS the code at each line — leave this default ON so you can see what you're commenting on
gh comment lines <PR> path/to/file.rb -R owner/repo

# Avoid --show-code=false — gives you naked line numbers without the code,
# which makes it easy to comment on the wrong line.
# Only useful if you're scripting / piping into another tool.
# gh comment lines <PR> path/to/file.rb --show-code=false -R owner/repo

# Add a general PR comment (not inline — appears in conversation tab)
gh comment add <PR> "General comment here" -R owner/repo

# React to a comment
gh comment react <comment-id> +1 -R owner/repo
gh comment react <comment-id> rocket -R owner/repo

# Edit an existing comment
gh comment edit <comment-id> "Updated text" -R owner/repo

# Dry run (preview without executing)
gh comment review <PR> "Test" --comment "file.rb:10:test" --dry-run -R owner/repo
```

## Suggestion Syntax

`gh comment` supports GitHub suggestion blocks via shorthand:

```bash
# Single-line suggestion
gh comment add <PR> src/api.js 42 "[SUGGEST: const timeout = 5000;]" -R owner/repo

# Multi-line suggestion
gh comment add <PR> src/api.js 42 "$(cat <<'EOF'
<<<SUGGEST
const config = {
  timeout: 5000,
  retries: 3,
};
SUGGEST>>>
EOF
)" -R owner/repo
```

## Flags Reference

### Global Flags (both tools)

| Flag         | Description                                               |
| ------------ | --------------------------------------------------------- |
| `-R, --repo` | Repository in `owner/repo` format (auto-detects from cwd) |
| `-p, --pr`   | PR number (auto-detects from current branch)              |

### gh comment Flags

| Flag            | Description                                                     |
| --------------- | --------------------------------------------------------------- |
| `--dry-run`     | Preview without executing                                       |
| `--validate`    | Validate line exists in diff before commenting                  |
| `-v, --verbose` | Show detailed API interactions                                  |
| `--event`       | Review event: `APPROVE`, `REQUEST_CHANGES`, `COMMENT`           |
| `--comment`     | Inline comment: `file:line:message` or `file:start:end:message` |

## Troubleshooting

### Review posted but inline comments didn't appear

**Most common cause:** used `gh comment batch` with a YAML schema the local binary didn't recognize → review created with 0 comments. The summary body still posts.

**Recovery:**

1. Verify with the API query in [Verifying a Submission](#verifying-a-submission)
2. Re-submit ONLY the inline comments using `gh comment review` with `--comment` flags. Use a one-liner body like `"(Inline notes referenced in my previous review body 👆)"` so the second review chain reads clean.
3. **Don't** try to delete the first review — it'll just confuse PR notifications.

### "HTTP 422" on inline comments

The line number must exist in the PR diff. Use `gh comment lines <PR> <file>` (with code shown — default) to see which lines are commentable.

### Comments not appearing inline

Make sure you're using `gh comment review` (not `gh comment add`). The `add` command creates general PR conversation comments, not inline review comments.

### gh-comment not installed

It requires building from source (Go):

```bash
cd /tmp && gh repo clone silouanwright/gh-comment && cd gh-comment
go build -o gh-comment .
mkdir -p ~/.local/share/gh/extensions/gh-comment
cp gh-comment ~/.local/share/gh/extensions/gh-comment/
```

### gh-pr-review not installed

```bash
gh extension install agynio/gh-pr-review
```
