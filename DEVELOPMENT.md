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

Run against a workspace:

```bash
npx react-doctor@latest packages/ui
```

Run against changed files only (pre-push friendly):

```bash
npx react-doctor@latest --diff main
npx react-doctor@latest --staged
```

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
