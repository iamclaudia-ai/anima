import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateSessionOptions, ResumeSessionOptions } from "./provider-types";
import { resolveProfile, type SessionProfile } from "./profiles";
import { profileCliArgs, writeSessionMcpConfig } from "./providers/cli/profile-args";
import { SessionHost, type AgentRuntimeSession } from "./session-host";

const MAIL: SessionProfile = {
  permissionMode: "dontAsk",
  tools: ["Read", "Grep"],
  allowedTools: ["Read", "Grep", "mcp__anima__mail_read"],
  disallowedTools: ["WebSearch"],
  mcp: "anima-only",
  restricted: true,
};

describe("resolveProfile", () => {
  it("resolves built-ins and configured profiles", () => {
    expect(resolveProfile("yolo")).toEqual({ name: "yolo", permissionMode: "bypassPermissions" });
    expect(resolveProfile("auto").permissionMode).toBe("auto");
    expect(resolveProfile("mail", { mail: MAIL })).toEqual({ name: "mail", ...MAIL });
  });

  it("lets config override a built-in", () => {
    expect(resolveProfile("auto", { auto: { permissionMode: "acceptEdits" } }).permissionMode).toBe(
      "acceptEdits",
    );
  });

  it("fails closed on unknown, malformed or contradictory profiles", () => {
    expect(() => resolveProfile("nope")).toThrow("Unknown session profile");
    expect(() => resolveProfile("constructor")).toThrow("Unknown session profile");
    expect(() => resolveProfile("../x")).toThrow("Invalid session profile name");
    expect(() => resolveProfile("bad", { bad: { permissionMode: "everything" as never } })).toThrow(
      "invalid permissionMode",
    );
    expect(() =>
      resolveProfile("bad", { bad: { permissionMode: "bypassPermissions", restricted: true } }),
    ).toThrow("cannot be restricted and bypass");
  });
});

describe("profileCliArgs", () => {
  it("keeps yolo exactly as before", () => {
    expect(profileCliArgs(resolveProfile("yolo"))).toEqual([
      "--dangerously-skip-permissions",
      "--disallowedTools",
      "AskUserQuestion,EnterPlanMode,ExitPlanMode",
    ]);
  });

  it("locks a mail session down", () => {
    expect(profileCliArgs(resolveProfile("mail", { mail: MAIL }), "/x/mcp.json")).toEqual([
      "--permission-mode",
      "dontAsk",
      "--tools",
      "Read,Grep",
      "--allowedTools",
      "Read,Grep,mcp__anima__mail_read",
      "--disallowedTools",
      "AskUserQuestion,EnterPlanMode,ExitPlanMode,WebSearch",
      "--restricted",
      "--strict-mcp-config",
      "--mcp-config",
      "/x/mcp.json",
    ]);
  });

  it("passes an empty tool list through as no built-in tools", () => {
    const args = profileCliArgs(
      resolveProfile("none", { none: { permissionMode: "dontAsk", tools: [] } }),
    );
    expect(args.slice(0, 4)).toEqual(["--permission-mode", "dontAsk", "--tools", ""]);
  });

  it("refuses an anima-only profile without an MCP config", () => {
    expect(() => profileCliArgs(resolveProfile("mail", { mail: MAIL }))).toThrow(
      "needs Anima's MCP",
    );
  });
});

describe("writeSessionMcpConfig", () => {
  let dir: string;
  const previous = process.env.ANIMA_DATA_DIR;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "anima-mcp-"));
    process.env.ANIMA_DATA_DIR = dir;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.ANIMA_DATA_DIR;
    else process.env.ANIMA_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes an owner-only file holding only Anima's server", () => {
    const path = writeSessionMcpConfig("sess-1", {
      serverName: "anima",
      url: "http://localhost:30086/mcp",
      headers: { Authorization: "Bearer t" },
    });
    expect(path).toBe(join(dir, "agent-host", "mcp", "sess-1.json"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      mcpServers: {
        anima: {
          type: "http",
          url: "http://localhost:30086/mcp",
          headers: { Authorization: "Bearer t" },
        },
      },
    });
  });
});

class ProfileRecordingSession extends EventEmitter {
  closed = false;
  prompts: unknown[] = [];
  constructor(
    readonly id: string,
    readonly profile: string | undefined,
  ) {
    super();
  }
  get isActive() {
    return !this.closed;
  }
  get isProcessRunning() {
    return !this.closed;
  }
  async start() {}
  prompt(content: unknown) {
    this.prompts.push(content);
  }
  interrupt() {}
  async close() {
    this.closed = true;
    this.emit("closed");
  }
  setPermissionMode() {}
  sendToolResult() {}
  getInfo() {
    const now = new Date().toISOString();
    return {
      id: this.id,
      cwd: "/tmp",
      model: "m",
      isActive: this.isActive,
      isProcessRunning: this.isProcessRunning,
      createdAt: now,
      lastActivity: now,
      healthy: true,
      stale: false,
    };
  }
}

describe("SessionHost profiles", () => {
  function makeHost() {
    const launched: ProfileRecordingSession[] = [];
    const host = new SessionHost({
      profiles: { mail: MAIL },
      providers: {
        claude: {
          create: (options: CreateSessionOptions) => {
            const s = new ProfileRecordingSession(
              options.sessionId ?? "new",
              options.profile?.name,
            );
            launched.push(s);
            return s as unknown as AgentRuntimeSession;
          },
          resume: (id: string, options: ResumeSessionOptions) => {
            const s = new ProfileRecordingSession(id, options.profile?.name);
            launched.push(s);
            return s as unknown as AgentRuntimeSession;
          },
        },
      },
    });
    host.setDefaults({ model: "m" });
    return { host, launched };
  }

  it("requires a known profile to create or prompt", async () => {
    const { host } = makeHost();
    await expect(host.create({ cwd: "/tmp", profile: "" })).rejects.toThrow("profile is required");
    await expect(host.create({ cwd: "/tmp", profile: "root" })).rejects.toThrow("Unknown");
    await host.create({ sessionId: "s1", cwd: "/tmp", profile: "mail" });
    await expect(host.prompt("s1", "hi", "/tmp", "m", "claude")).rejects.toThrow(
      "profile is required",
    );
  });

  it("launches with the resolved profile and persists it", async () => {
    const { host, launched } = makeHost();
    await host.create({ sessionId: "s1", cwd: "/tmp", profile: "mail" });
    expect(launched[0].profile).toBe("mail");
    expect(host.getSessionRecords()[0].profile).toBe("mail");
  });

  it("closes and relaunches a session running under the wrong profile", async () => {
    const { host, launched } = makeHost();
    // Restore/adopt can't know the profile, so it comes back as legacy yolo.
    await host.resume({ sessionId: "s1", cwd: "/tmp" });
    expect(launched[0].profile).toBe("yolo");

    await host.prompt("s1", "read your mail", "/tmp", "m", "claude", "mail");
    expect(launched[0].closed).toBe(true);
    expect(launched[1].profile).toBe("mail");
    expect(launched[1].prompts).toEqual(["read your mail"]);
    expect(host.getSessionProfile("s1")).toBe("mail");
  });

  it("leaves a session alone when the profile matches", async () => {
    const { host, launched } = makeHost();
    await host.create({ sessionId: "s1", cwd: "/tmp", profile: "mail" });
    await host.prompt("s1", "hi", "/tmp", "m", "claude", "mail");
    expect(launched).toHaveLength(1);
    expect(launched[0].prompts).toEqual(["hi"]);
  });
});
