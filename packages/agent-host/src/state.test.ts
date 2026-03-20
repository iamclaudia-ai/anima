import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function loadStateModule(homeDir: string) {
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  const mod = await import(`./state.ts?${Date.now()}`);
  return {
    mod,
    restore() {
      if (previousHome) {
        process.env.HOME = previousHome;
      } else {
        delete process.env.HOME;
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
    const stateDir = join(home, ".anima", "agent-host");
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
