/**
 * Test-run isolation: point every module at a throwaway data directory.
 *
 * Preloaded by `bunfig.toml` before any test file, so this wins over module
 * import order — which is exactly where the previous approach failed. Modules
 * that resolved `~/.anima` at import time could not be redirected by a test
 * setting `HOME` afterwards, so `bun test` wrote into the live agent-host
 * session registry and truncated it to zero. That stranded every running
 * CLI's proxy on a port nothing was listening to, and the orphan reaper then
 * killed the panes as untracked.
 *
 * A test suite must never be able to reach the running system's state. This is
 * the floor that guarantees it; individual suites may still override
 * `ANIMA_DATA_DIR` per case for their own fixtures.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.ANIMA_TEST_DATA_DIR) {
  process.env.ANIMA_TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "anima-test-data-"));
}
process.env.ANIMA_DATA_DIR = process.env.ANIMA_TEST_DATA_DIR;

// Git hooks export GIT_DIR (and in a linked worktree, more of these), and a
// spawned `git` honors them over its cwd. A test that runs `git init` or
// `git commit` in a temp dir would then act on the repository being pushed:
// it once set core.bare = true in the main checkout and committed a fixture
// over a branch from a pre-push hook (#87). Tests only ever mean the temp
// repos they create, so drop every variable that points git somewhere else.
for (const key of [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
]) {
  delete process.env[key];
}

// Bun.spawn and Bun.spawnSync without an explicit `env` hand children the
// environment this process STARTED with: neither the deletions above nor the
// ANIMA_DATA_DIR redirect would reach a spawned `git`, `bun` or `anima`.
// (node:child_process does read the live process.env.) Make the live
// process.env the default, so everything a test spawns inherits the
// isolation set up here. An explicit `env` still wins.
type SpawnOptions = { env?: Record<string, string | undefined> };

function withLiveEnv<F extends (...args: never[]) => unknown>(spawn: F): F {
  return ((first: unknown, second?: SpawnOptions) => {
    if (Array.isArray(first)) {
      return spawn(...([first, { ...second, env: second?.env ?? process.env }] as never[]));
    }
    // Object form: Bun.spawn({ cmd, ...options }).
    const options = first as SpawnOptions;
    return spawn(...([{ ...options, env: options.env ?? process.env }] as never[]));
  }) as F;
}

Bun.spawn = withLiveEnv(Bun.spawn);
Bun.spawnSync = withLiveEnv(Bun.spawnSync);
