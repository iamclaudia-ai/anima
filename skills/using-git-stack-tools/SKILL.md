---
name: using-git-stack-tools
description: "MUST be used when working with stacked PRs in the beehiiv/swarm repository. Custom git workflow tools (tmp/git-stack, tmp/git-stack-init, tmp/git-stack-sync) for managing named PR stacks without Graphite. Covers creating stacks, adding branches, visualizing dependencies, switching between stacks, and interactive restacking after merges. Triggers on: stacked PR, git stack, create stack, add to stack, switch stack, restack, PR dependencies, stack visualization, manage PRs, stack metadata, tmp/git-stack."
---

# Using Git Stack Tools

Custom bash scripts for managing stacked PRs in the beehiiv/swarm repository. These tools replace Graphite and provide named stack management, visualization, and interactive restacking.

## When to Use

- Creating a new stacked PR workflow
- Adding a branch to an existing stack
- Visualizing PR dependencies
- Switching between different PR stacks
- Restacking after a PR merge
- Managing stack metadata

## Available Tools

All tools are located in `tmp/` directory of the beehiiv/swarm repo:

- **`tmp/git-stack`** — Visualize the current PR stack with dependency tree
- **`tmp/git-stack-init`** — Create and manage named stacks
- **`tmp/git-stack-sync`** — Interactive rebase tool for restacking after merges
- **`tmp/git-stack-update-pr`** — Update PR descriptions with stack visualization links

## Stack Metadata Structure

Stacks are stored in `.git/git-stack-metadata.json`:

```json
{
  "stacks": {
    "stack-name": {
      "description": "What this stack does",
      "last_branch": "last-visited-branch",
      "branches": {
        "branch-name": {
          "parent": "parent-branch-or-main",
          "pr": 12345,
          "description": "What this PR does"
        }
      }
    }
  },
  "current_stack": "stack-name"
}
```

## Common Workflows

### Creating a New Stack

```bash
# 1. Checkout main and pull latest
git checkout main && git pull

# 2. Create first branch
git checkout -b kiliman/feature-name-TICKET-123

# 3. Initialize stack (creates new stack interactively)
tmp/git-stack-init --add --description "First PR description"
# Script will prompt for stack name if creating new stack

# 4. Make changes, commit
git add . && git commit -m "feat: implement feature"

# 5. Push and create PR
git push -u origin kiliman/feature-name-TICKET-123
gh pr create
```

### Adding to Existing Stack

```bash
# 1. Checkout the last branch in your stack
git checkout kiliman/previous-pr-TICKET-123

# 2. Create new branch off of it
git checkout -b kiliman/next-feature-TICKET-124

# 3. Add to current stack
tmp/git-stack-init --add --description "Next PR description"
# Script will auto-detect parent from current branch

# 4. Make changes, commit, push, create PR
git add . && git commit -m "feat: next feature"
git push -u origin kiliman/next-feature-TICKET-124
gh pr create
```

### Visualizing the Stack

```bash
# View current stack
tmp/git-stack

# Output shows:
# - Stack name and description
# - Dependency tree with PR numbers
# - Current branch highlighted
# - Tip for switching stacks
```

Example output:

```
📚 PR Stack: podcast-mvp
   Podcast hosting MVP feature

◯ main
┃
┣━◯ [1] kiliman/first-pr-TICKET-123
┃   #21147: First PR description
┃
┣━◯ [2] kiliman/second-pr-TICKET-124
┃   #21148: Second PR description
┃
┗━◯ [3] kiliman/third-pr-TICKET-125 (current)
    #21149: Third PR description
```

### Updating PR Descriptions with Stack Links

```bash
# Update current branch's PR
tmp/git-stack-update-pr

# Update specific branch's PR
tmp/git-stack-update-pr kiliman/branch-name-TICKET-123

# Script will:
# - Read stack from metadata file
# - Generate stack visualization with PR links
# - Append/update "📚 Stacked on" section in PR body
# - Works even if some PRs haven't been created yet
```

The script adds a visual stack tree to the PR description:

```markdown
### 📚 Stacked on

<pre>
⚫ main
┃
┣━ <a href="https://github.com/beehiiv/swarm/pull/21147">#21147</a> First PR
┃
┗━ <a href="https://github.com/beehiiv/swarm/pull/21148">#21148</a> Second PR 👈
</pre>
```

**Update all PRs in stack:**

```bash
# Get all branches in current stack
for branch in $(jq -r '.stacks[.current_stack].branches | keys[]' .git/git-stack-metadata.json); do
  tmp/git-stack-update-pr "$branch" 2>/dev/null || true
done
```

### Switching Between Stacks

```bash
# Interactive stack switcher
tmp/git-stack --switch

# Shows list of all stacks
# Switches to last_branch of selected stack
# Updates current_stack in metadata
```

### Restacking After PR Merge

When PR #1 merges to main, you need to rebase PR #2 (and PR #3, etc.) onto the new main:

```bash
# 1. Update main
git checkout main && git pull

# 2. Run interactive restack
tmp/git-stack-sync

# Script will:
# - Detect which PRs need rebasing
# - Show you the rebase plan
# - Prompt for confirmation
# - Rebase each branch interactively
# - Handle conflicts
# - Prompt to force push after each rebase
# - Update metadata
```

The script handles:

- Detecting merged PRs
- Finding dependent branches
- Interactive rebase with conflict handling
- Optional force push prompts
- Metadata cleanup
- State persistence for resuming

### Manual Stack Management

```bash
# View all stacks
tmp/git-stack-init --show

# Manually edit metadata if needed
# Location: .git/git-stack-metadata.json
# Use jq for safe JSON editing
```

## Key Patterns

### Branch Naming Convention

Always use `kiliman/` prefix for beehiiv branches:

```
kiliman/descriptive-name-TICKET-123
```

### Stack Descriptions

- Stack description: High-level feature name
- Branch description: Specific PR scope

### Parent Relationships

- First PR: parent is `main`
- Subsequent PRs: parent is previous branch in stack
- All PRs target `main` on GitHub (not parent branch)

## Restacking Strategy

After a PR merges (squash merge):

1. **PR #1 merges** → Update main locally
2. **Rebase PR #2** → `git rebase main` (skip duplicate commits)
3. **Rebase PR #3** → Use `--onto` if needed to avoid manual skipping
4. **Force push** → `git push --force` for each rebased branch
5. **Verify** → Check GitHub PR shows only new changes

## Important Notes

- **Never use `gt` commands** — Those are for Graphite, we use `tmp/git-stack*` instead
- **Squash merges change commit SHAs** — Use `git rebase --skip` for duplicates
- **Stack metadata is local** — Only stored in `.git/`, not pushed to remote
- **Interactive prompts** — Scripts ask before destructive operations
- **State files** — tmp/git-stack-sync creates `.git/git-stack-sync-state.json` for resuming
- **Gentle guidance** — Scripts don't auto-fix, they guide you to correct actions

## Troubleshooting

**Branch not in any stack:**

- Run `tmp/git-stack-init --add` to add it
- Or switch to correct stack with `tmp/git-stack --switch`

**Rebase conflicts:**

- Resolve conflicts manually
- `git add <files>` then `git rebase --continue`
- Script will resume from where you left off

**Wrong parent:**

- Manually edit `.git/git-stack-metadata.json`
- Use jq to update parent safely

**Lost metadata:**

- Metadata is local only - not recoverable from remote
- Recreate stack manually with `tmp/git-stack-init`

## Examples

### Example: Creating 3-PR Stack

```bash
# PR 1: Backend API
git checkout main && git pull
git checkout -b kiliman/backend-api-WEB-123
# ... make changes ...
git commit -m "feat(api): add endpoint"
tmp/git-stack-init --add --description "Backend API endpoint"
# Enter new stack name: "user-management"
git push -u origin kiliman/backend-api-WEB-123
gh pr create

# PR 2: Frontend UI
git checkout -b kiliman/frontend-ui-WEB-124
# ... make changes ...
git commit -m "feat(ui): add component"
tmp/git-stack-init --add --description "Frontend UI component"
git push -u origin kiliman/frontend-ui-WEB-124
gh pr create

# PR 3: Tests
git checkout -b kiliman/add-tests-WEB-125
# ... make changes ...
git commit -m "test: add coverage"
tmp/git-stack-init --add --description "Add test coverage"
git push -u origin kiliman/add-tests-WEB-125
gh pr create

# View the stack
tmp/git-stack
```

### Example: Restacking After Merge

```bash
# PR #1 merged to main
git checkout main && git pull

# Restack remaining PRs
tmp/git-stack-sync
# Follow prompts:
# - Confirms rebase plan
# - Rebases PR #2 onto main
# - Prompts to force push
# - Rebases PR #3 onto main
# - Prompts to force push
# - Updates metadata

# Verify on GitHub
# PR #2 should now show only its changes (PR #1 removed)
# PR #3 should now show only its changes
```
