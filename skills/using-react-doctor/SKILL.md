---
name: using-react-doctor
description: "MUST be used when running react-doctor audits, reviewing react-doctor warnings, fixing flagged React anti-patterns, deciding whether to ignore a rule, interpreting diagnostics, or working through a cleanup pass on this codebase. Covers the canonical --json + jq workflow, the file-centric working process that avoids stale line numbers, project ignore-list rationale, the pre-push ratchet behavior, and inline-disable conventions. Triggers on: run react-doctor, react-doctor, react-doctor audit, react-doctor warnings, react-doctor diagnostics, audit React code, react anti-patterns, react code health, react-doctor score, fix react-doctor, react-doctor ignore, react-doctor cleanup, react warnings remaining, react lint, monorepo react audit, react best practices scan."
---

# Using React Doctor

[react-doctor](https://github.com/millionco/react-doctor) is the codebase-health linter we run against every workspace that imports React. It catches anti-patterns the TypeScript compiler can't (effect leaks, array-index keys, deprecated APIs, a11y issues, design-system drift). This skill captures the workflow we use in this monorepo so future-Claudia doesn't have to reinvent it.

## When to Use

- Running an audit on the monorepo or a specific workspace
- Working through the warning backlog (the cleanup PRs)
- A pre-push failure mentions react-doctor
- Deciding whether a rule should be ignored, inline-disabled, or fixed
- A new React-using workspace is added — first scan + decide what's relevant
- Updating the ignore list when a new rule surfaces a false positive
- Someone asks "what's the react-doctor score" or "how many issues are left"

## Quick Commands (canonical invocations)

Three bun scripts already wrap the common cases:

```bash
bun run react-doctor          # full monorepo scan (all workspaces)
bun run react-doctor:diff     # only files changed vs main — runs in pre-push
bun run react-doctor:staged   # only staged files — pre-commit ready
```

For ad-hoc scans of a single workspace, invoke directly:

```bash
NO_COLOR=1 npx react-doctor@latest -y packages/ui                  # human-readable
npx react-doctor@latest -y packages/ui --json --offline            # structured data
npx react-doctor@latest -y packages/ui --explain src/foo.tsx:42    # why a rule fired
npx react-doctor@latest -y packages/ui --verbose                   # every rule shown
```

The `-y` flag suppresses the workspace-picker prompt — required for non-interactive use.

## Two output modes, two purposes

**`--json` for analysis.** Writes a structured array of diagnostics to stdout. Pipe to `jq`. This is what you want 90% of the time when working through warnings.

**`NO_COLOR=1` (without `--json`) for reading.** Strips ANSI escape codes from the formatted human-friendly output. Use this when you just want to _look at_ the summary — score, top rules, totals — and show it verbatim to the user.

The temp-folder `diagnostics.json` is identical to what `--json` emits but written to disk. Prefer `--json` directly: no temp path to scrape, no race conditions, deterministic location.

## Diagnostic shape

Each entry in the JSON output looks like:

```json
{
  "filePath": "src/components/MessageList.tsx",
  "plugin": "react-doctor",
  "rule": "no-array-index-as-key",
  "severity": "warning",
  "message": "Array index 'i' used as key — causes bugs when list is reordered or filtered",
  "help": "Use a stable unique identifier: `key={item.id}` or `key={item.slug}` …",
  "line": 202,
  "column": 15,
  "category": "Correctness"
}
```

When aggregating across workspaces, tag each entry with its `package` for filtering downstream.

## jq cookbook

Save the JSON once and re-query:

```bash
npx react-doctor@latest -y packages/ui --json --offline > /tmp/rd.json
```

**Group by rule, sorted by frequency:**

```bash
jq -r 'group_by(.rule) | map({rule: .[0].rule, count: length})
  | sort_by(-.count) | .[] | "\(.count)\t\(.rule)"' /tmp/rd.json
```

**Group by file (build a file-centric checklist):**

```bash
jq -r 'group_by(.filePath)
  | map({file: .[0].filePath, count: length, rules: ([.[].rule] | unique | join(", "))})
  | sort_by(-.count) | .[]
  | "\(.count)\t\(.file)\n      → \(.rules)"' /tmp/rd.json
```

**Filter to errors only (the things the pre-push ratchet cares about):**

```bash
jq -r '.[] | select(.severity == "error")
  | "\(.filePath):\(.line) [\(.rule)] \(.message)"' /tmp/rd.json
```

**Find every site for one specific rule:**

```bash
jq -r '.[] | select(.rule == "no-array-index-as-key")
  | "\(.filePath):\(.line):\(.column)"' /tmp/rd.json
```

## Scanning the whole monorepo

react-doctor scopes itself per-workspace. Running it on `.` won't pick up every package — you have to iterate. Pattern:

```bash
: > /tmp/rd-all.json
for dir in packages/ui extensions/audiobooks extensions/bogart extensions/chat \
           extensions/control extensions/editor extensions/memory \
           extensions/presenter extensions/scheduler clients/vscode \
           packages/gateway packages/shared; do
  npx react-doctor@latest -y "$dir" --json --offline 2>/dev/null \
    | jq --arg pkg "$dir" '[.[] | . + {package: $pkg}]' >> /tmp/rd-all.json
done
jq -s 'add' /tmp/rd-all.json > /tmp/rd-monorepo.json
echo "Total: $(jq 'length' /tmp/rd-monorepo.json) issues"
```

Keep this list in sync with `package.json` workspaces that import React. Add a workspace to the loop the moment it gets its first React file.

## The file-centric working process

Rule-by-rule sweeps are a trap — the moment you edit one file, every line number in the _other_ diagnostic entries pointing at that file shifts. Work **file-by-file** instead:

1. Capture a fresh `--json` snapshot
2. Group by file, sort by issue count desc
3. For the top file: read it fresh, apply every flagged fix in one editing pass
4. Re-run react-doctor on that workspace (it's ~200–300ms, basically free)
5. Confirm the file's issues dropped to zero (or the irreducible inline-disable count)
6. Move to the next file

The source of truth at every step is the **next** react-doctor run, never a stale diagnostic file.

Exception: pure mechanical patterns that span many files (e.g. `w-N h-N` → `size-N`, `useContext` → `use`) can be done as a single regex-based sweep across the whole repo. After the sweep, re-run once and verify nothing slipped through.

## Decision framework: fix vs inline-disable vs global-ignore

When a rule fires, decide which bucket it falls into:

| Bucket             | Use when                                                                                                                                                                                           | How                                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fix it**         | The rule is right for this site. Real bug, real a11y issue, real correctness concern.                                                                                                              | Apply the suggested fix.                                                                                                                       |
| **Inline disable** | The rule is generally right, but wrong _here_ (specific context where the warning is a false positive).                                                                                            | `// react-doctor-disable-next-line <rule-id>` immediately above the line, with a comment explaining why.                                       |
| **Global ignore**  | The rule is wrong for _us_ — across the whole codebase, not just one site. Either a stylistic choice we've made, or an integration constraint (e.g. theme remap), or the rule itself is misguided. | Add to `reactDoctor.ignore.rules` in root `package.json` and document the rationale in `DEVELOPMENT.md` under "Project-wide ignore rationale". |

**Bias toward fix.** Every ignore is a small debt — future readers wonder why. Only ignore when there's a real reason, and document the real reason.

**Bias toward inline over global** for one-off exceptions. Global ignore is a sledgehammer; inline disable scopes the exception to where it actually applies.

## Current project ignore list (as of skill creation)

Authoritative list lives in root `package.json` under `reactDoctor.ignore.rules`. Rationale in `DEVELOPMENT.md` ("Project-wide ignore rationale" section). Summary:

- **`design-no-default-tailwind-palette`** — `gray-*` is remapped to `stone-*` at the `@theme` level in `packages/ui/src/styles/index.css`. The rule is class-name pattern matching and can't see the remap. Also, `packages/ui/src/styles/vscode.css` overrides `.bg-gray-*` etc. to VS Code theme variables, so renaming would silently break VS Code theming.
- **`design-no-em-dash-in-jsx-text`** — flags em dashes as "model-output filler." An AI-detection heuristic that misidentifies correct typography. Em dashes predate LLMs by 500 years.
- **`js-combine-iterations`** — `.map().filter()` is more readable than fused `for...of`/`reduce` on the small arrays we render. Per-site if profiling identifies a hot loop.
- **`no-generic-handler-names`** — `handleX` paired with `onX` props is idiomatic React.
- **`design-no-three-period-ellipsis`** — typography preference, not correctness.

**Don't add to this list lightly.** When considering a new global ignore, ask:

1. Is the rule wrong for _every_ site in this codebase, or just where I'm seeing it? (If just where, inline-disable instead.)
2. Have I checked whether the rule has a deeper insight I'm missing? (Look at the `help` field; read the docs link if present.)
3. Will this decision survive scrutiny in three months? (Document the rationale.)

## The pre-push ratchet

`bun run react-doctor:diff` runs in pre-push with `--fail-on error`. Behavior:

- **Errors block the push.** Currently zero errors; any new error introduced in a changed file fails CI.
- **Warnings are advisory.** The pre-existing 200-ish warnings don't block ordinary pushes — they get worked through in cleanup PRs.
- **`--diff main`** scans only files changed vs main. Untouched files don't get re-evaluated.

This means the error count can only go _down_ from here. If a future change introduces a real bug-class issue (e.g. a new `useEffect` without cleanup), pre-push catches it before it reaches main.

To temporarily bypass (only when truly needed — e.g. emergency revert): `git push --no-verify`. Don't make this a habit.

## Workflow: tackling a cleanup batch

A repeatable rhythm for a cleanup PR:

1. **Pick a rule or theme** — e.g. "all a11y warnings," "all `no-array-index-as-key`," "one specific component." Don't mix unrelated rules in one PR; they review badly.
2. **Capture a baseline** — `npx react-doctor@latest -y . --json --offline > /tmp/rd-before.json`. Save the issue count.
3. **Build the target list** — file-grouped with the jq snippet above.
4. **Work file-by-file** — read fresh, fix every relevant flag, save.
5. **Re-run after each file** — confirm the count dropped. Catch any new flags you accidentally introduced (rare but happens).
6. **Type-check and run tests** — `bun run typecheck && bun run test:unit`. The mechanical fixes occasionally need a TS target bump or a missing import.
7. **Commit locally** with a conventional-commit message that names the rule fixed and the score delta. Pre-commit hook handles formatting + lint.
8. **Update `tmp/react-doctor/progress.md`** if it exists for this workspace — tick off the files you finished.

## Common gotchas

- **`size-N` shorthand only works on Tailwind v3.4+.** This repo is on Tailwind 4 in every workspace, so safe everywhere — but verify before applying to a new workspace.
- **`toSorted` is ES2023.** Requires `target: "ES2023"` or higher in `tsconfig.base.json`. Already bumped in this repo.
- **`useContext` → `use` migration** requires React 19+. Verify the workspace's React version before applying.
- **The rule "fires on a line" but the fix may live elsewhere.** Especially `no-prop-callback-in-effect` and similar — the linter points at the symptom, not the cause. Read the surrounding context.
- **Don't trust the temp-folder `diagnostics.json` after editing.** Re-run before doing more work. Line numbers shift; trusting stale data wastes time.
- **`Children.toArray` already assigns keys to its output.** When you see `key={i}` on a `Children.toArray` result, use `(child as { key?: string | null }).key` instead — that's the React-blessed identifier.
- **A "static branded" key like `frame-${i}` still triggers `no-array-index-as-key`.** The rule sees `${i}` regardless of prefix. If the index _truly_ is the identity (fixed-size, never reordered, never filtered), inline-disable with a comment explaining the invariant. Don't try to outsmart the rule with cosmetic prefixes.

## Notes

- This skill is pure knowledge — no scripts to invoke. The "tooling" is `npx react-doctor@latest` itself, wrapped by `bun run react-doctor*` scripts in root `package.json`.
- Working files for the current cleanup live in `tmp/react-doctor/` (gitignored). Includes `progress.md`, `ignore-decisions.md`, `baseline.json`, `all-diagnostics.json`.
- For the full rule catalog and rule-by-rule docs, see [react-doctor's GitHub](https://github.com/millionco/react-doctor) or run `--verbose` to see every rule name surfaced in a single run.
