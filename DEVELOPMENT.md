# Development Guide

Last updated: 2026-02-20

## Overview

This repo is Bun-first across packages, extensions, and most clients.

- Package manager/runtime: `bun`
- TypeScript checking:
  - Fast local check: `tsgo` (TypeScript native preview)
  - Canonical check: `tsc`
- Linting: `oxlint`
- Formatting: `oxfmt`
- Git hooks: `husky`
- Staged-file tasks: `lint-staged`

## Prerequisites

- Bun installed
- macOS tools if working on iOS/menubar clients (`xcodebuild`, etc.)

Install dependencies:

```bash
bun install
```

## Common Commands

### Run app

```bash
bun run dev
```

### Build all workspaces

```bash
bun run build
```

### Typecheck

Fast (pre-commit oriented):

```bash
bun run typecheck:fast
```

Canonical (authoritative):

```bash
bun run typecheck
```

Per-workspace aggregate:

```bash
bun run typecheck:all
```

### Lint + format

```bash
bun run lint
bun run format
```

### React Doctor (codebase health audit)

[react-doctor](https://github.com/millionco/react-doctor) audits the React surface for anti-patterns, deprecated APIs, accessibility issues, and design-system drift. Configuration lives in `package.json` under the `reactDoctor` key.

Three bun scripts wrap react-doctor for common workflows:

```bash
bun run react-doctor          # full monorepo scan
bun run react-doctor:diff     # only files changed vs main (runs in pre-push)
bun run react-doctor:staged   # only staged files (pre-commit ready)
```

Or invoke directly for ad-hoc scans:

```bash
npx react-doctor@latest packages/ui            # specific workspace
npx react-doctor@latest --verbose              # show every rule
npx react-doctor@latest --explain file.tsx:42  # debug why a rule fired
```

The pre-push hook runs `react-doctor:diff --fail-on error`, so existing
warnings don't block pushes but any new errors introduced in changed files
will. This is a deliberate ratchet: the codebase's error count can only go
down from here, never up. Warnings are tracked separately and worked
through in cleanup PRs.

Inline ignore for a single line:

```ts
// react-doctor-disable-next-line react-doctor/no-cascading-set-state
useEffect(() => { ... }, [value]);
```

#### Project-wide ignore rationale

The `reactDoctor.ignore.rules` list in `package.json` silences rules that are wrong for _this_ codebase. Decisions:

- **`design-no-default-tailwind-palette`** — the UI deliberately uses `gray-*` class names because `packages/ui/src/styles/index.css` remaps `--color-gray-*` to `--color-stone-*` at the `@theme` level (warm neutral that pairs with the violet/blue accents), and `packages/ui/src/styles/vscode.css` overrides those same classes to map onto VS Code theme variables. The rule is class-name pattern-matching and can't see the remap. Switching the palette would silently break VS Code theming.
- **`js-combine-iterations`** — `.map().filter()` is more readable than fused `for...of`/`reduce` loops on the small arrays we render (chat history, todo lists). Revisit per-site only if profiling identifies a hot loop.
- **`no-generic-handler-names`** — `handleX` paired with `onX` props is idiomatic React. Renaming to action verbs is taste, not correctness.
- **`design-no-three-period-ellipsis`** — `...` vs `…` is pure typography preference.
- **`jsx-a11y/no-gray-on-colored-background`** — the rule does pure class-name pattern matching and false-positives on Tailwind's `prose-*` selectors: classes like `prose-code:bg-violet-50` apply to nested `<code>` tags, not the parent text container, so what looks like "gray text on colored background" is actually "gray text on white" with separately colored inline code chips. Verified visually that the actual rendered contrast is fine in every flagged site.
- **`rerender-state-only-in-handlers`** — the rule's intent ("`useState` updated but never read in render — use `useRef` instead") is sound, but its AST walker misses two normal React patterns we use everywhere: (1) **early-return rendering** — `if (loading) return <Loading/>` reads the state in a guard above the main `return`, which the linter doesn't count, and (2) **state-as-effect-dep** — values like `Bogart.tsx`'s `state`/`direction` or `ChapterPlayer.tsx`'s `isPlaying` aren't rendered directly but are listed in `useEffect` deps so the effect re-runs when they change. Converting either case to `useRef` would silently break the component (the loading→loaded transition wouldn't re-render; the effect wouldn't re-subscribe). Audited all 10 flagged sites — every one fell into one of those two patterns.

For one-off exceptions to otherwise-valid rules, prefer the inline `react-doctor-disable-next-line` comment over expanding the global ignore list.

### Tests

```bash
bun run test:unit
bun run test:integration
bun run test:smoke
bun run test:e2e
bun run test:smoke-all
```

## Git Hooks

### Pre-commit

Runs:

1. `bun run typecheck:fast`
2. `lint-staged`

`lint-staged` tasks:

- `*.{ts,tsx,js,jsx,mjs,cjs}`
  1. `bunx oxfmt --write`
  2. `oxlint`
- `*.{json,md,css,html,yml,yaml}`
  1. `bunx oxfmt --write`

### Pre-push

Runs:

1. `bun run typecheck`
2. `bun run test:unit`
3. `bun run test:ios`
4. `bun run docs:api:check`
5. `bun run react-doctor:diff` — fails on any new react-doctor errors in changed files

## Workspace Script Convention

Each workspace should expose these where applicable:

- `build`
- `test`
- `typecheck`
- optional `dev` and/or `start`

Non-TS clients (iOS/menubar) keep explicit no-op `typecheck` scripts for consistency.

## Notes

- Prefer explicit workspace/session IDs in API calls; avoid implicit active context.
- Keep API method schemas explicit (`inputSchema`) for gateway validation and CLI discoverability.
- Run `bun run test:smoke-all` before larger refactors.
