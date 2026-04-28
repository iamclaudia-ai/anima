import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionHost, type AgentRuntimeSession } from "./session-host";
import { restorePersistedSessions } from "./restore";

class FakeSession extends EventEmitter {
  public isActive = true;
  public isProcessRunning = true;

  constructor(
    public id: string,
    private cwd: string,
    private model: string,
    private prompted: string[],
  ) {
    super();
  }

  async start(): Promise<void> {}

  prompt(_content: string | unknown[]): void {
    this.prompted.push(this.id);
  }

  interrupt(): void {}

  setPermissionMode(_mode: string): void {}

  sendToolResult(_toolUseId: string, _content: string, _isError = false): void {}

  async close(): Promise<void> {
    this.emit("closed");
  }

  getInfo() {
    return {
      id: this.id,
      cwd: this.cwd,
      model: this.model,
      isActive: this.isActive,
      isProcessRunning: this.isProcessRunning,
      healthy: true,
      stale: false,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    };
  }
}

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

describe("restorePersistedSessions", () => {
  it("restores sessions into a new host and allows prompting", async () => {
    const home = mkdtempSync(join(tmpdir(), "claudia-agent-host-home-"));
    const { mod, restore } = await loadStateModule(home);

    const prompted: string[] = [];
    let nextId = 1;

    const hostA = new SessionHost({
      create: (options) =>
        new FakeSession(
          `s${nextId++}`,
          options.cwd,
          options.model ?? "default",
          prompted,
        ) as unknown as AgentRuntimeSession,
      resume: (sessionId, options) =>
        new FakeSession(
          sessionId,
          options.cwd,
          options.model ?? "default",
          prompted,
        ) as unknown as AgentRuntimeSession,
    });

    const { sessionId } = await hostA.create({ cwd: "/repo", model: "claude-opus-4-6" });
    mod.saveState(hostA.getSessionRecords());

    const hostB = new SessionHost({
      create: (options) =>
        new FakeSession(
          `s${nextId++}`,
          options.cwd,
          options.model ?? "default",
          prompted,
        ) as unknown as AgentRuntimeSession,
      resume: (sessionId, options) =>
        new FakeSession(
          sessionId,
          options.cwd,
          options.model ?? "default",
          prompted,
        ) as unknown as AgentRuntimeSession,
    });

    const state = mod.loadState();
    await restorePersistedSessions(hostB, state, {
      info: () => {},
      warn: () => {},
    });

    expect(hostB.list()).toHaveLength(1);
    await hostB.prompt(sessionId, "hi", "/repo");
    expect(prompted).toEqual([sessionId]);

    restore();
    rmSync(home, { recursive: true, force: true });
  });

  it("hydrates lastActivity from transcript mtime when persisted value is missing", async () => {
    const home = mkdtempSync(join(tmpdir(), "claudia-agent-host-home-"));
    const previousHome = process.env.HOME;
    process.env.HOME = home;

    const cwd = "/repo/project";
    const sessionId = "s-mtime";
    const encodedCwd = cwd.replace(/\//g, "-");
    const projectDir = join(home, ".claude", "projects", encodedCwd);
    mkdirSync(projectDir, { recursive: true });
    const sessionPath = join(projectDir, `${sessionId}.jsonl`);
    writeFileSync(sessionPath, '{"type":"noop"}\n');
    const mtime = new Date("2026-03-01T12:34:56.000Z");
    utimesSync(sessionPath, mtime, mtime);

    const resumeCalls: Array<{ lastActivity?: string }> = [];
    await restorePersistedSessions(
      {
        resume: async (params: {
          sessionId: string;
          cwd: string;
          model?: string;
          lastActivity?: string;
        }) => {
          resumeCalls.push({ lastActivity: params.lastActivity });
          return { sessionId: params.sessionId };
        },
      },
      {
        updatedAt: new Date().toISOString(),
        sessions: [
          {
            id: sessionId,
            cwd,
            model: "claude-opus-4-6",
            createdAt: new Date().toISOString(),
            lastActivity: "",
          },
        ],
      },
      { info: () => {}, warn: () => {} },
    );

    expect(resumeCalls).toHaveLength(1);
    expect(resumeCalls[0]?.lastActivity).toBe(mtime.toISOString());

    if (previousHome) {
      process.env.HOME = previousHome;
    } else {
      delete process.env.HOME;
    }
    rmSync(home, { recursive: true, force: true });
  });
});
