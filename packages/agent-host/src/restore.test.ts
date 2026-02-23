import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionHost } from "./session-host";
import { restorePersistedSessions } from "./restore";

class FakeSession extends EventEmitter {
  public isActive = true;

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
        ) as unknown as import("../../../extensions/session/src/sdk-session").SDKSession,
      resume: (sessionId, options) =>
        new FakeSession(
          sessionId,
          options.cwd,
          options.model ?? "default",
          prompted,
        ) as unknown as import("../../../extensions/session/src/sdk-session").SDKSession,
    });

    const { sessionId } = await hostA.create({ cwd: "/repo", model: "sonnet" });
    mod.saveState(hostA.getSessionRecords());

    const hostB = new SessionHost({
      create: (options) =>
        new FakeSession(
          `s${nextId++}`,
          options.cwd,
          options.model ?? "default",
          prompted,
        ) as unknown as import("../../../extensions/session/src/sdk-session").SDKSession,
      resume: (sessionId, options) =>
        new FakeSession(
          sessionId,
          options.cwd,
          options.model ?? "default",
          prompted,
        ) as unknown as import("../../../extensions/session/src/sdk-session").SDKSession,
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
});
