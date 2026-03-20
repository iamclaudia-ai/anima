# Project Rename: Claudia -> Anima

## Mission

Rename the platform/system from `Claudia` to `Anima` while preserving `Claudia` where it refers to the assistant identity, historical content, or live external addresses.

Current state on 2026-03-20:

- Repo directory is already `/Users/michael/Projects/iamclaudia-ai/anima`
- Core code still uses `Claudia` broadly for system/package/runtime naming
- The previous rename plan is stale and underestimates several operational surfaces

## Rename Rules

### Rename to `Anima`

Use `Anima` when the reference is to the platform, infrastructure, runtime, package namespace, UI shell, config files, local data directory, service names, bundle IDs, or developer-facing tooling.

Examples:

- `@claudia/*` -> `@anima/*`
- `ClaudiaConfig` -> `AnimaConfig`
- `ClaudiaExtension` -> `AnimaExtension`
- `~/.claudia` -> `~/.anima`
- `claudia.json` -> `anima.json`
- `CLAUDIA_*` -> `ANIMA_*`
- App/product names such as desktop, VS Code, PWA, watchdog, and launcher metadata

### Do Not Rename

Keep `Claudia` when it refers to the person/assistant, user-facing identity, or preserved historical record.

Examples that should stay:

- Agent IDs such as `claudia-main`
- Email/domain references such as `claudia@iamclaudia.ai` and `iamclaudia-ai`
- Memory transcripts, autobiographical content, historical episode data, and persona prompts
- Intentional copy that refers to Claudia as the assistant rather than the platform

### Treat With Care

These need explicit review, not blind search/replace:

- `memory/**`
- `docs/**`
- `skills/**`
- test fixtures/assertions containing mixed platform/persona language
- comments mentioning both the assistant and the system

## Current Inventory

Measured from the current repo:

- `26` `package.json` files
- `8` `tsconfig*.json` files
- `123` files with `@claudia/` package-scope references
- `71` files with `.claudia` path references
- `22` files with `claudia.json`
- `32` files with `Claudia*` type/component/class names
- `29` files with `CLAUDIA_*` environment variables
- `6` files with `claudia:` localStorage/settings key prefixes

Additional rename surfaces now present:

- VS Code extension commands, config namespace, view type, category labels, and package metadata
- Tauri desktop product name and bundle identifier
- iOS/macOS Xcode project names, asset paths, and bundle identifiers
- LaunchAgent/plist filename and service label
- PWA manifest name/description/shortcuts and service-worker cache/notification tags
- CLI defaults, temp file prefixes, and watchdog install/deploy paths
- file and directory names containing `Claudia` or `claudia`

## Explicit Non-Goals

This rename should not try to rewrite the entire memory archive or historical documents for style consistency. Historical content can be reviewed separately after the platform rename lands.

## Execution Plan

### Phase 0: Safety and Migration Strategy

- [ ] Freeze the exact compatibility rules before editing code
- [ ] Keep the live `~/.claudia` installation untouched until Anima is verified
- [ ] Add a startup migration path from `~/.claudia` to `~/.anima`
- [ ] Perform migration as a one-shot cutover with the old system stopped
- [ ] Decide whether config migration is copy-on-first-run, explicit CLI command, or a manual preflight step
- [ ] Stop/redeploy watchdog only after new binaries and configs exist

Cutover behavior:

- Stop the live Claudia system first
- Copy/migrate data from `~/.claudia` into `~/.anima`
- Start only the Anima system after code/config migration is complete
- If the cutover fails, restart the old Claudia system from the untouched legacy files
- Do not add long-term dual-read support unless cutover testing proves it is necessary

### Phase 1: Rename Files and Directory-Level Identifiers

- [ ] `claudia.example.json` -> `anima.example.json`
- [ ] `scripts/com.claudia.watchdog.plist` -> `scripts/com.anima.watchdog.plist`
- [ ] Review whether these should be renamed now or later:
  - `clients/vscode/src/ClaudiaPanelProvider.ts`
  - `packages/ui/src/components/ClaudiaChat.tsx`
  - `packages/ui/src/components/ClaudiaThinking.tsx`
  - `clients/menubar/Claudia/`
  - `clients/menubar/Claudia.xcodeproj`
- [ ] Review asset filenames that encode the old product name:
  - `assets/claudia.png`
  - `assets/claudia-github.png`
  - `assets/claudia-github.svg`

Note:

- File renames for source files/classes should happen together to avoid broken imports
- Asset renames are optional if references are updated, but the plan should call them out explicitly

### Phase 2: Workspace Package Namespace

- [ ] Rename root package name `claudia` -> `anima`
- [ ] Rename all workspace packages `@claudia/*` -> `@anima/*`
- [ ] Update all internal dependency references in `package.json`
- [ ] Update root script filters such as `bun run --filter @claudia/...`
- [ ] Regenerate the lockfile after package renames

Primary package surface:

- root `package.json`
- `packages/*/package.json`
- `extensions/*/package.json`
- `clients/*/package.json`

### Phase 3: Imports, Exports, and TS Path Mapping

- [ ] Update all `@claudia/*` import/export references to `@anima/*`
- [ ] Update TS path aliases in root and package tsconfig files
- [ ] Verify generated docs/scripts that parse package names

Key files already confirmed:

- `tsconfig.json`
- `tsconfig.tsgo.json`
- `packages/ui/tsconfig.json`
- many TS/TSX sources across `packages/`, `extensions/`, and `clients/`

### Phase 4: Types, Interfaces, and Internal Symbols

- [ ] Rename system-facing types/interfaces/classes from `Claudia*` to `Anima*`
- [ ] Rename system-facing React component/class names where they represent the product rather than the persona
- [ ] Keep assistant/persona references as `Claudia` where the UI literally means the assistant

Examples to rename:

- `ClaudiaConfig`
- `ClaudiaExtension`
- `ClaudiaPanelProvider` if the panel is product-branded rather than persona-branded

Examples requiring judgment:

- `ClaudiaChat`
- `ClaudiaThinking`

If these components represent "chat with Claudia" rather than "the Claudia product shell", the internal symbol may not need to change even if surrounding app branding does.

### Phase 5: Config, Data Paths, and Persistence

- [ ] Rename default config/data directory from `~/.claudia` to `~/.anima`
- [ ] Rename default config file from `claudia.json` to `anima.json`
- [ ] Rename default database path from `~/.claudia/claudia.db` to `~/.anima/anima.db` if desired
- [ ] Update logger paths, watchdog paths, codex output paths, libby logs, and extension storage paths
- [ ] Add the one-shot data/config migration step for cutover
- [ ] Update scripts and tests that assume `claudia.db` or `claudia.json`

Important implementation detail:

- The repo currently has many hardcoded strings in gateway, shared config, watchdog, memory, memory-mcp, session, agent-host, and scripts. This is a larger pass than the old plan assumed.

### Phase 6: Environment Variables and Transitional Compatibility

- [ ] Rename `CLAUDIA_*` env vars to `ANIMA_*`
- [ ] Update code to use only `ANIMA_*` after cutover
- [ ] Update CLI help text, test harnesses, smoke scripts, and docs

Confirmed active env vars now include:

- `CLAUDIA_CONFIG`
- `CLAUDIA_HOME`
- `CLAUDIA_DATA_DIR`
- `CLAUDIA_SKIP_ORPHAN_KILL`
- `CLAUDIA_GATEWAY_URL`
- `CLAUDIA_GATEWAY_HTTP`
- `CLAUDIA_GATEWAY_WS`
- `CLAUDIA_WATCHDOG_URL`
- `CLAUDIA_SESSION_ID`
- `CLAUDIA_PROJECT_DIR`
- `CLAUDIA_AGENT_IDLE_REAP_INTERVAL_MS`
- `CLAUDIA_AGENT_IDLE_STALE_MS`
- `CLAUDIA_SCHEDULER_SESSION_ID`
- `CLAUDIA_SMOKE_*`

### Phase 7: Client/Product Surface Rename

- [ ] VS Code extension:
  - package name/display name/description
  - command IDs like `claudia.openChat`
  - config namespace like `claudia.gatewayUrl`
  - menu categories, titles, view type, README
- [ ] Desktop/Tauri:
  - `productName`
  - window title
  - bundle identifier
  - Rust package metadata if needed
- [ ] Menubar/macOS:
  - Xcode project/app target names
  - bundle identifier
  - README/setup paths
- [ ] iOS:
  - bundle identifier
  - default gateway hostname if product-branded
- [ ] PWA/web shell:
  - manifest app name/short name/description/shortcut text
  - service-worker cache names and notification tags
- [ ] Any UI copy that currently says "Claudia" when it means the platform

### Phase 8: Local Keys, Runtime IDs, and Miscellaneous String Constants

- [ ] Rename localStorage/config key prefixes such as `claudia:*` and `claudia-draft`
- [ ] Rename DOM IDs and runtime identifiers that are product-specific
- [ ] Review temp file prefixes and test tmpdir prefixes for consistency
- [ ] Keep IDs that are intentionally persona-specific

Examples already found:

- `claudia:voice`
- `claudia:thinking:*`
- `claudia:workspace:*`
- `claudia:nav:sessionsCollapsed`
- `claudia-draft`
- `claudia-inline-expansion-panel`

### Phase 9: Operational Assets and Deployment

- [ ] Update watchdog binary name, deploy destination, and install/uninstall logic
- [ ] Update LaunchAgent label and plist references
- [ ] Update bundle IDs and app identifiers across desktop/mobile/macOS
- [ ] Update any hardcoded repo paths still pointing to `/iamclaudia-ai/claudia`
- [ ] Rebuild generated assets if app name changes affect packaging

Already confirmed:

- watchdog build currently outputs `dist/claudia-watchdog`
- CLI install commands still target `com.claudia.watchdog.plist`
- plist contents still point at the old `.../iamclaudia-ai/claudia` repo path

### Phase 10: Documentation and Human Review

- [ ] Update product/system docs to say `Anima`
- [ ] Leave persona/history docs alone unless clearly platform-oriented
- [ ] Review README, development docs, testing docs, and client READMEs manually
- [ ] Review comments touched by search/replace for identity mistakes

Priority docs:

- `README.md`
- `CLAUDE.md`
- `DEVELOPMENT.md`
- `docs/TESTING.md`
- client READMEs
- script comments and generated doc headers

Use caution in:

- `memory/**`
- `PWA_PLAN.md`
- `TODO.md`
- historical notes and autobiographical text

### Phase 11: Validation

- [ ] `bun install`
- [ ] `bun run typecheck`
- [ ] `bun run test:unit`
- [ ] targeted tests for gateway/config/session/watchdog/clients
- [ ] regenerate docs if package names affect generated output
- [ ] verify first-run migration from old config/data paths without touching the live install
- [ ] only then deploy/start the Anima watchdog and app surfaces

## Search Commands

```bash
# Package namespace
rg -n '@claudia/' .

# System-facing symbol names
rg -n 'Claudia(Config|Extension|Client|PanelProvider|Chat|Thinking)' .

# Config and data paths
rg -n '\.claudia|claudia\.json|claudia\.db' .

# Environment variables
rg -n 'CLAUDIA_' .

# Product/runtime IDs
rg -n 'claudia\.|claudia:|claudia-' clients packages extensions scripts

# File names
find . -path './.git' -prune -o -name '*Claudia*' -print | sort
find . -path './.git' -prune -o -name '*claudia*' -print | sort
```

## Success Criteria

- [ ] Platform package scope is fully `@anima/*`
- [ ] System-facing config/types/classes use `Anima` naming
- [ ] Default config/data paths are `~/.anima`
- [ ] Preferred env vars are `ANIMA_*`
- [ ] Product shells are branded `Anima`
- [ ] Legacy `~/.claudia` install remains untouched and recoverable
- [ ] Persona references to Claudia remain intentional and correct
- [ ] Typecheck/tests pass after rename
- [ ] Anima can boot cleanly after the one-shot migration

## Notes

- The hardest part is not the package rename. It is separating platform branding from persona/history without corrupting meaning.
- This should be executed as a deliberate migration with compatibility shims, not as a one-shot global replace.
- The current repo contains enough platform references that this is now a multi-surface rename touching runtime behavior, packaging, and developer tooling, not just TypeScript imports.
