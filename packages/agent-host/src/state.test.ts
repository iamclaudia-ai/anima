import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Point the state module at a throwaway data dir.
 *
 * `ANIMA_DATA_DIR` rather than `HOME`: the module resolves its paths per call
 * from that variable, which is what lets a test — and the global test preload —
 * keep the real `~/.anima` out of reach.
 */
async function loadStateModule(dataDir: string) {
  const previous = process.env.ANIMA_DATA_DIR;
  process.env.ANIMA_DATA_DIR = dataDir;
  const mod = await import(`./state.ts?${Date.now()}`);
  return {
    mod,
    restore() {
      if (previous) {
        process.env.ANIMA_DATA_DIR = previous;
      } else {
        delete process.env.ANIMA_DATA_DIR;
      }
    },
  };
}

describe("state persistence", () => {
  it("saves and loads session records from disk", async () => {
    const home = mkdtempSync(join(tmpdir(), "claudia-agent-host-home-"));
    const { mod, restore } = await loadStateModule(home);

    const sessions = [
      {
        id: "s1",
        cwd: "/repo",
        model: "claude-opus-4-6",
        createdAt: "2024-01-01T00:00:00.000Z",
        lastActivity: "2024-01-01T00:00:01.000Z",
      },
    ];

    mod.saveState(sessions);
    const state = mod.loadState();
    expect(state.sessions).toEqual(sessions);

    restore();
    rmSync(home, { recursive: true, force: true });
  });

  it("returns empty state on corrupted JSON", async () => {
    const home = mkdtempSync(join(tmpdir(), "claudia-agent-host-home-"));
    const stateDir = join(home, "agent-host");
    const stateFile = join(stateDir, "sessions.json");

    // Prepare corrupted state file.
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(stateFile, "{not-json");

    const { mod, restore } = await loadStateModule(home);
    const state = mod.loadState();
    expect(state.sessions).toEqual([]);

    restore();
    rmSync(home, { recursive: true, force: true });
  });
});
