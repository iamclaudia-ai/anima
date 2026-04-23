---
name: using-gh-stack
description: "MUST be used when working with stacked PRs. gh-stack is a CLI tool for managing stacked PR workflows without Graphite. Covers creating stacks, auto-detecting branch chains, pushing/creating PRs with submit, navigating stacks (up/down/top/bottom), syncing with main, restacking, and merging. Triggers on: stacked PR, gh-stack, create stack, submit stack, push stack, restack, sync stack, stack navigation, up down top bottom, PR dependencies, stack visualization, manage PRs, stacked branches."
---

# Using gh-stack

`gh-stack` (v0.2.0+) is a CLI tool for managing stacked PRs in squash-merge repositories. It replaces Graphite and the old `tmp/git-stack*` bash scripts.

**Install:** `bun install -g gh-stack`

## When to Use

- Creating a new stacked PR workflow
- Pushing branches and creating PRs for a stack
- Navigating between branches in a stack
- Syncing a stack with main after changes
- Restacking branches after modifications
- Merging a completed stack

## Terms

| Term          | Meaning                              |
| ------------- | ------------------------------------ |
| **trunk**     | Base branch (usually `main`)         |
| **stack**     | A chain of dependent branches        |
| **upstack**   | Child branches (depend on current)   |
| **downstack** | Parent branches (current depends on) |

## Core Workflow

### 1. Start a Stack

**From existing branches** (e.g., `main → feat-1 → feat-2`):

```bash
# Go to the TOP of the chain — init walks down automatically
git checkout feat-2
gh-stack init
# Auto-detects: main → feat-1 → feat-2
# Creates stack with correct parent relationships
# Auto-detects existing PRs
```

**From scratch:**

```bash
git checkout kiliman/first-pr-WEB-1234
gh-stack init                                    # Creates stack, adds current branch
gh-stack create kiliman/second-pr-WEB-5678       # Creates branch + adds to stack
# ... work, commit ...
gh-stack create kiliman/third-pr-WEB-9012        # Stack another branch on top
```

### 2. Push & Create PRs

```bash
gh-stack submit        # Push all downstack branches, create PRs, add stack viz
gh-stack submit -n     # Auto-generate PR titles (no prompts)
gh-stack submit -t "PR title [WEB-1234]" -b "Description"  # Explicit title and body
gh-stack submit -t "PR title" --body-file /tmp/pr-body.md   # Body from file
gh-stack submit -d     # Create new PRs as drafts
gh-stack submit --dry-run  # Preview what would happen
```

**For agents/CI:** Always use `-t`/`-b` to provide proper PR titles and descriptions:

```bash
gh-stack submit \
  -t "Store raw ElevenLabs JSON and WebVTT [WEB-7409]" \
  -b "$(cat <<'EOF'
## Summary
- Store raw transcription JSON alongside pre-rendered WebVTT
- Add columns to transcriptions table

## Test plan
- [ ] Verify transcription saves both formats
EOF
)"
```

`submit` is **idempotent** — safe to run repeatedly. It:

- Skips pushing branches already up-to-date with origin (avoids unnecessary hook runs)
- Pushes changed branches with `--force-with-lease`
- Creates PRs for branches that don't have them (with correct base branch)
- Updates PR base branches if needed
- Adds stack visualization to all PR descriptions

### 3. Navigate the Stack

```bash
gh-stack up            # Move to child branch (upstack)
gh-stack up 2          # Move up 2 levels
gh-stack down          # Move to parent branch (downstack)
gh-stack down 2        # Move down 2 levels
gh-stack top           # Jump to tip (leaf) of stack
gh-stack bottom        # Jump to base (first branch above trunk)
gh-stack checkout      # Interactive branch picker
gh-stack co            # Alias for checkout
gh-stack log           # View stack tree (default command)
gh-stack ls            # List branches with numbers
```

### 4. Sync & Restack

```bash
gh-stack sync          # Fetch main, rebase base onto main, restack ALL children
gh-stack restack       # Rebase current branch + descendants onto parents
gh-stack restack --dry-run  # Preview rebase plan
```

**⚠️ CRITICAL: Restack propagates UPWARD from the current branch.** Always run restack from the **lowest changed branch**, not from the top of the stack:

```bash
# ✅ Correct: restack from the branch you changed
gh-stack bottom        # go to the changed branch
# ... make changes, commit ...
gh-stack submit        # push this branch
gh-stack restack       # propagates changes UP through children

# ❌ Wrong: restacking from the top
gh-stack top
gh-stack restack       # tries to restack downward first, causes conflicts
```

If you changed a middle branch, navigate to it first, then restack — it will propagate to all branches above it.

**On rebase conflict:**

```bash
# Resolve conflicts manually, then:
git add <files>
git rebase --continue
gh-stack restack --resume    # Continue restacking remaining branches
```

### Changes Across Multiple Branches — Linear Workflow

When you need to make changes to **multiple branches** in a stack (e.g., applying a consistent refactor across PRs 2, 3, and 4), handle **one branch fully** before moving to the next:

```bash
# ✅ Linear: finish each branch before moving on
gh-stack bottom            # or navigate to the lowest-changed branch
# --- Branch 2 ---
# edit → test → commit
git push --force-with-lease
gh-stack restack --yes     # propagates up to 3, 4, ...

gh-stack up                # move to branch 3
# --- Branch 3 ---
# edit → test → commit
git push --force-with-lease
gh-stack restack --yes     # propagates up to 4, ...

gh-stack up                # move to branch 4
# ... and so on
```

```bash
# ❌ Bouncing: commit across branches, restack at the end
gh-stack bottom
# edit → commit (no push)
gh-stack up
# edit → commit (no push)
gh-stack restack --yes     # only pushes the LAST branch; others are unpushed
# Now you have to navigate back and push each branch separately — messy cleanup.
```

**Why linear wins:**

1. **Each branch is self-contained** — if something fails mid-stack, all prior branches are fully committed + pushed + in-sync, not half-done.
2. **Restack after every push** isolates each rebase propagation to a single conceptual change. Easier to debug conflicts when they're not tangled with other pending commits.
3. **Remote stays consistent** — reviewers see each PR update as its own event, not all branches changing at once.
4. **No cleanup step** — no "oh wait I still need to push Phase 2 and 3 separately" realization after the fact.

The pattern is: `edit → test → commit → push → restack` per branch, then `up` and repeat.

### 5. Check Status

```bash
gh-stack status        # PR dashboard: CI, reviews, merge readiness
gh-stack status --current   # Current stack only
gh-stack status --json      # Structured output for agents
```

### 6. Merge & Ship

```bash
gh-stack merge         # Squash-merge stack top-down (PR3 → PR2 → PR1)
gh-stack merge --dry-run   # Preview merge plan
```

### 7. Maintenance

```bash
gh-stack delete        # Remove a branch from stack (re-parents children)
gh-stack undo          # Restore from last snapshot
gh-stack archive       # Manage archived stacks
```

## Agent/CI Mode

All commands work non-interactively with `--yes`/`-y` or `GH_STACK_YES=1`:

```bash
export GH_STACK_YES=1
gh-stack init          # No confirmations for chain detection
gh-stack sync          # No confirmation prompts
gh-stack restack       # No confirmation prompts
```

**For submit, always provide `--title` and `--body`** so PRs get proper descriptions:

```bash
# Preferred: explicit title and body
gh-stack submit -t "Feature title [WEB-1234]" -b "## Summary\nDescription"

# With HEREDOC for multi-line body
gh-stack submit \
  -t "Store raw JSON and WebVTT [WEB-7409]" \
  -b "$(cat <<'EOF'
## Summary
- Store raw transcription JSON alongside pre-rendered WebVTT
- Add columns to transcriptions table

## Test plan
- [ ] Verify transcription saves both formats
EOF
)"

# Or read body from a file
gh-stack submit -t "PR title" --body-file /tmp/pr-body.md

# Fallback: auto-generate titles (not recommended — titles are generic)
gh-stack submit -n
```

**Note:** `--title` implies `--no-edit` (no interactive prompts). The title and body are applied to all new PRs being created in the scope.

## Init Options

```bash
gh-stack init                          # Auto-detect chain, use branch name as stack name
gh-stack init --name my-feature        # Custom stack name
gh-stack init --parent develop         # Different trunk branch
gh-stack init --description "My epic"  # Stack description
```

**Smart chain detection:** `init` finds all local branches whose tips are ancestors of the current branch (excluding already-merged branches), reconstructs the chain, and adds them all. Best used from the **top** of the chain.

## Stack Visualization

`submit` automatically adds a stack section to all PR descriptions:

```markdown
### 📚 Stacked on

<pre>
⚫ main
┃
┣━ ✅ <a href="...">#21729</a> WebVTT renderer WEB-7410
┃
┗━ ⏳ <a href="...">#21730</a> Transcription columns WEB-7409 👈
</pre>
```

### ⚠️ Don't hand-write a second stack section

Because `submit` regenerates the `### 📚 Stacked on` footer on every run, a hand-written `## Stack 📚` section in the PR body is:

- **Redundant** — readers see the same information twice
- **A maintenance burden** — when one PR's title/scope changes (e.g. Phase 5 rescoped from "Resilience tuning" to "Scheduled-at filter"), you have to edit the hand-written list in every other PR in the stack. The auto-footer updates itself for free.
- **A source of drift** — the hand-written list quickly disagrees with reality. Reviewers reading both get confused about which is canonical.

**Rule:** describe _this_ PR in its body. Let `submit` describe the stack. If you want to reference a specific sibling PR, link it inline in prose (`see the Phase 1 [bulk-response fidelity patch](link)`) rather than maintaining a parallel list.

## Metadata

Stack metadata lives at `.git/gh-stack-metadata.json` (never committed):

```json
{
  "version": 2,
  "current_stack": "kiliman/feature-2",
  "stacks": {
    "kiliman/feature-2": {
      "description": "",
      "last_branch": "kiliman/feature-2",
      "branches": {
        "kiliman/feature-1": { "parent": "main", "pr": 21729 },
        "kiliman/feature-2": { "parent": "kiliman/feature-1", "pr": 21730 }
      }
    }
  }
}
```

## Complete Example: 3-PR Stack

```bash
# PR 1: Backend API
git checkout main && git pull
git checkout -b kiliman/backend-api-WEB-123
# ... make changes, commit ...
gh-stack init

# PR 2: Frontend UI
gh-stack create kiliman/frontend-ui-WEB-124
# ... make changes, commit ...

# PR 3: Tests
gh-stack create kiliman/add-tests-WEB-125
# ... make changes, commit ...

# Push everything and create all PRs
gh-stack submit

# View the stack
gh-stack log

# Later: sync with main
gh-stack sync

# Navigate
gh-stack bottom        # Jump to PR 1
gh-stack up            # Move to PR 2
gh-stack top           # Jump to PR 3

# When approved, merge
gh-stack merge
```

## Troubleshooting

**"Working tree is not clean":**

- Commit or stash changes before running `restack`, `sync`, `merge`, or `undo`

**Branch not in any stack:**

- Run `gh-stack init` to create a new stack with it

**Wrong parent detected in chain:**

- Manually edit `.git/gh-stack-metadata.json`
- Or use `--parent` flag: `gh-stack init --parent develop`

**Rebase conflicts during sync/restack:**

- Resolve conflicts, `git add`, `git rebase --continue`
- Then `gh-stack restack --resume` to continue

**Stale branches in chain detection:**

- `init` automatically filters out branches already merged into trunk
- If issues persist, use `--name` flag and manually add branches

## Important Notes

- **Do NOT use `gt` commands** — We use `gh-stack`, not Graphite
- **Squash-merge safe** — Built specifically for squash-merge workflows
- **Tag-based rebasing** — Uses temporary tags for stable rebasing (handles the merge-base problem)
- **Snapshots** — Automatic snapshots before destructive ops; use `gh-stack undo` to restore
- **Metadata is local** — `.git/gh-stack-metadata.json` is never committed
