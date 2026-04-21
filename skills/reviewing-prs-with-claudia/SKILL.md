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
- Batch reviewing with multiple comments in one operation
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

# 5. ALWAYS clean up when done
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
4. **Explore in worktree** — Read the full files, not just changed lines. Check callers, tests, related code.
5. **Present findings** — Show review findings to Michael for discussion before submitting
6. **Submit review** — Use `gh comment review` with inline comments
7. **Clean up worktree** — Always remove when done

## Quick Reference

### Submit a Review with Inline Comments (Most Common)

```bash
# Single command: body + inline comments + decision
gh comment review <PR> "Review summary here" \
  --comment "path/to/file.rb:42:Your comment on line 42" \
  --comment "path/to/file.ts:10:15:Comment spanning lines 10-15" \
  --event APPROVE \
  -R owner/repo
```

**Events:** `APPROVE`, `REQUEST_CHANGES`, `COMMENT` (default)

### Comment Format

```
file:line:message           # Single line
file:start:end:message      # Line range (multi-line comment)
```

**Important:** Line numbers refer to lines in the NEW version of the file (right side of the diff). The extension handles the diff position mapping automatically.

### Examples

```bash
# Approve with comments
gh comment review 22365 "Solid work! A few minor suggestions." \
  --comment "app/models/foo.rb:43:Is pending really a processing state here?" \
  --comment "client/src/utils.ts:28:Tiny copy nit — see suggestion below" \
  --event APPROVE \
  -R beehiiv/swarm

# Request changes
gh comment review 123 "Needs fixes before merge" \
  --comment "app/services/bar.rb:15:20:This block needs error handling" \
  --event REQUEST_CHANGES \
  -R beehiiv/swarm

# Comment only (no approval/rejection)
gh comment review 123 \
  --comment "app/models/user.rb:55:Consider eager loading here" \
  --event COMMENT \
  -R beehiiv/swarm
```

### Shell Escaping with HEREDOC

When your review body or inline comments contain backticks, quotes, or special characters (very common in code reviews!), **always use HEREDOC** to avoid shell escaping issues:

```bash
gh comment review <PR> "$(cat <<'EOF'
Clean implementation! The `useRoles()` pattern is consistent with existing code.
One minor suggestion — see inline comment.
EOF
)" \
  --comment "$(cat <<'EOF'
client/src/components/Foo.tsx:42:Nit: This `roles?.includes('admin') ?? false` logic is duplicated. Consider extracting to a `useCanManage()` hook.
EOF
)" \
  --event APPROVE \
  -R beehiiv/swarm
```

**Why HEREDOC?** Without it, backticks trigger command substitution, parentheses cause parse errors, and quotes need careful escaping. The `<<'EOF'` (quoted) form prevents ALL shell interpolation.

**Alternative:** Write to temp files and use `$(cat /tmp/body.txt)` — works but HEREDOC is cleaner for inline use.

### Batch Review from YAML

For complex reviews with many comments, use a YAML config:

```yaml
# /tmp/review.yaml
review:
  body: "Architecture review — looks good overall"
  event: "APPROVE"
  comments:
    - file: "app/models/episode.rb"
      line: 170
      message: "Nice association-aware optimization here"
    - file: "app/workers/publish_worker.rb"
      line: 37
      end_line: 38
      message: "Potential race condition — see detailed comment"
    - file: "client/src/utils.ts"
      line: 25
      message: "Copy nit: episode is already scheduled at this point"
```

```bash
gh comment batch <PR> /tmp/review.yaml -R beehiiv/swarm
```

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
# Check which lines are commentable in a file's diff (shows code by default)
gh comment lines <PR> path/to/file.rb -R owner/repo
# Without code context (just line numbers, useful for scripting)
gh comment lines <PR> path/to/file.rb --show-code=false -R owner/repo

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

### "HTTP 422" on inline comments

The line number must exist in the PR diff. Use `gh comment lines <PR> <file>` to see which lines are commentable.

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
