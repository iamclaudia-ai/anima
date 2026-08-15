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
