import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import { closeSessionDb, getStoredSession, touchSession, upsertSession } from "./session-store";
import { SessionRegistry } from "./session-registry";
import type { AgentHostSessionInfo } from "./session-types";

/**
 * `recordConnectedSessions` runs on every agent-host reconnect and sweep. It
 * knows a process exists; it does not know what that process is doing — and it
 * used to assert `idle` for every healthy session, which reset the live status
 * the lifecycle had written. A session sitting on a modal prompt (#69) is the
 * case that made this visible: it writes `awaiting_approval` once and then goes
 * silent by definition, so the next sweep cleared it and the row went back to
 * looking like nothing was waiting.
 */
describe("session registry — connected sweep", () => {
  let tmpHome: string;
  let homedirSpy: ReturnType<typeof spyOn>;
  let originalHome: string | undefined;
  /** A real directory — the sweep creates the workspace from the cwd it's given. */
  let workspaceCwd: string;

  const connected = (overrides: Partial<AgentHostSessionInfo> = {}): AgentHostSessionInfo => ({
    id: "ses_live",
    cwd: workspaceCwd,
    model: "claude-opus-5",
    isActive: true,
    isProcessRunning: true,
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    healthy: true,
    stale: false,
    ...overrides,
  });

  const seed = (status: Parameters<typeof touchSession>[1]): void => {
    upsertSession({
      id: "ses_live",
      workspaceId: "ws_live",
      providerSessionId: "ses_live",
      model: "claude-opus-5",
      agent: "claude",
      purpose: "chat",
      runtimeStatus: "idle",
      lastActivity: new Date().toISOString(),
    });
    touchSession("ses_live", status);
  };

  beforeEach(() => {
    tmpHome = mkdtempSync(join(os.tmpdir(), "claudia-session-registry-"));
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
    homedirSpy = spyOn(os, "homedir").mockReturnValue(tmpHome);
    workspaceCwd = join(tmpHome, "repo");
    mkdirSync(workspaceCwd, { recursive: true });
  });

  afterEach(() => {
    closeSessionDb();
    homedirSpy.mockRestore();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("leaves a session waiting on a prompt alone", () => {
    seed("awaiting_approval");
    new SessionRegistry().recordConnectedSessions([connected()]);
    expect(getStoredSession("ses_live")?.runtimeStatus).toBe("awaiting_approval");
  });

  it("still marks a stale live process as stalled", () => {
    seed("running");
    new SessionRegistry().recordConnectedSessions([connected({ stale: true })]);
    expect(getStoredSession("ses_live")?.runtimeStatus).toBe("stalled");
  });
});
