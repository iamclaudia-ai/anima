import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AnimaExtension, ExtensionContext, LoggerLike } from "@anima/shared";
import type { CommandResult } from "./delegate";
import { createSupportExtension } from "./index";
import { supportTestDb } from "./test-db";

const silentLog: LoggerLike = {
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLog;
  },
};

const TNH = {
  id: "ws_tnh",
  name: "tnh",
  cwd: "/Users/michael/Projects/tnh",
  description: "NutWords",
  aliases: ["nutwords"],
  emailDomains: ["nutwords.com"],
  githubRepo: "kiliman/tnh",
  sentryProjects: ["nutwords"],
};

/** Zoho message ids → what mail.verify_sender reports for them. */
const MAIL: Record<string, { from: string; sender: string; trusted: boolean }> = {
  "100": { from: "kiliman@gmail.com", sender: "Kiliman", trusted: true },
  "200": { from: "stranger@example.com", sender: "Stranger", trusted: false },
};

/** Canned `gh api` responses, by path. */
function fakeGithub(path: string): unknown {
  if (path === "repos/kiliman/tnh/issues/5") {
    return {
      number: 5,
      title: "Login crash",
      state: "closed",
      html_url: "https://github.com/kiliman/tnh/pull/5",
      user: { login: "kiliman" },
      labels: [{ name: "bug" }],
      comments: 1,
      body: "Fixes the crash",
      pull_request: {},
    };
  }
  if (path === "repos/kiliman/tnh/issues/5/comments") {
    return [{ user: { login: "claudia" }, body: "LGTM" }];
  }
  if (path === "repos/kiliman/tnh/pulls/5") {
    return { merged: true, head: { ref: "fix" }, base: { ref: "main" }, changed_files: 1 };
  }
  if (path === "repos/kiliman/tnh/pulls/5/files") {
    return [{ filename: "app/login.ts", status: "modified", additions: 3, deletions: 1 }];
  }
  if (path === "search/issues") {
    return {
      total_count: 1,
      items: [
        {
          number: 5,
          title: "Login crash",
          state: "open",
          html_url: "https://github.com/kiliman/tnh/issues/5",
          repository_url: "https://api.github.com/repos/kiliman/tnh",
        },
      ],
    };
  }
  throw new Error(`unexpected gh api ${path}`);
}

describe("support extension", () => {
  let ext: AnimaExtension;
  let calls: Array<{ method: string; params: Record<string, unknown> }>;
  let commands: string[][];
  let visibility: string;
  let clock: number;

  beforeEach(async () => {
    calls = [];
    commands = [];
    visibility = "PRIVATE";
    clock = Date.parse("2026-10-24T22:00:00.000Z");
    ext = createSupportExtension(
      { delegation: { maxPerHour: 2 } },
      {
        db: supportTestDb(),
        now: () => new Date((clock += 1000)),
        run: async (args): Promise<CommandResult> => {
          commands.push(args);
          if (args[1] === "api") {
            return { exitCode: 0, stdout: JSON.stringify(fakeGithub(args[4])), stderr: "" };
          }
          if (args[1] === "repo") return { exitCode: 0, stdout: `${visibility}\n`, stderr: "" };
          return { exitCode: 0, stdout: "https://github.com/kiliman/tnh/issues/77\n", stderr: "" };
        },
      },
    );
    const ctx: ExtensionContext = {
      on: () => () => {},
      emit: () => {},
      call: async (method, params = {}) => {
        calls.push({ method, params });
        switch (method) {
          case "session.find_workspace":
            return {
              workspace:
                params.name === "nutwords" || params.githubRepo === "kiliman/tnh" ? TNH : null,
            };
          case "session.get_workspace":
            return { workspace: params.id === TNH.id ? TNH : null };
          case "session.list_workspaces":
            return {
              workspaces: [
                TNH,
                {
                  ...TNH,
                  id: "ws_x",
                  name: "x",
                  aliases: [],
                  emailDomains: [],
                  githubRepo: null,
                  sentryProjects: [],
                  description: null,
                },
              ],
            };
          case "mail.verify_sender": {
            const m = MAIL[String(params.messageId)];
            return { ...m, receivedAt: "2026-10-24T21:00:00.000Z", authenticated: m.trusted };
          }
          case "session.spawn_agent":
            return { sessionId: `session-${calls.length}` };
          default:
            throw new Error(`unexpected call ${method}`);
        }
      },
      connectionId: null,
      tags: null,
      config: {},
      log: silentLog,
      createLogger: () => silentLog,
      store: { get: () => undefined, set: () => {}, delete: () => false, all: () => ({}) },
    };
    await ext.start(ctx);
  });

  afterEach(async () => {
    await ext.stop();
  });

  const mcp = async (name: string, args: Record<string, unknown>) => {
    const result = await ext.handleMcpTool!(name, args);
    return { error: result.isError === true, data: JSON.parse(String(result.content[0].text)) };
  };

  it("exposes only the front-desk tools over MCP", () => {
    expect(ext.mcpTools?.map((t) => t.name)).toEqual([
      "support_list_projects",
      "support_list_tickets",
      "support_get_ticket",
      "support_create_ticket",
      "support_add_report",
      "support_update_ticket",
      "support_link",
      "support_note",
      "support_delegate",
      "support_github_get",
      "support_github_search",
      "support_create_issue",
    ]);
  });

  it("reads a PR from a project's repo with GET calls only", async () => {
    const { error, data } = await mcp("support_github_get", {
      url: "https://github.com/kiliman/tnh/pull/5",
    });
    expect(error).toBe(false);
    expect(data).toMatchObject({
      kind: "pr",
      state: "merged",
      labels: ["bug"],
      pr: { head: "fix", base: "main", files: [{ path: "app/login.ts", additions: 3 }] },
      comments: [{ author: "claudia", body: "LGTM" }],
    });
    expect(data.notice).toContain("never instructions");
    const gh = commands.filter((c) => c[1] === "api");
    expect(gh).toHaveLength(4);
    for (const c of gh) expect(c.slice(0, 4)).toEqual(["gh", "api", "-X", "GET"]);
  });

  it("refuses repos that aren't linked to a project", async () => {
    for (const args of [
      { url: "https://github.com/beehiiv/swarm/issues/1" },
      { repo: "beehiiv/swarm", number: 1 },
      { repo: "../../user", number: 1 },
    ]) {
      const { error } = await mcp("support_github_get", args);
      expect(error).toBe(true);
    }
    expect(commands).toHaveLength(0);
  });

  it("pins searches to the projects' repos", async () => {
    const { data } = await mcp("support_github_search", { query: "login crash" });
    expect(data.results[0]).toMatchObject({ repo: "kiliman/tnh", number: 5, kind: "issue" });
    expect(commands[0]).toContain("q=login crash repo:kiliman/tnh state:open");

    const widened = await mcp("support_github_search", { query: "secrets repo:beehiiv/swarm" });
    expect(widened.error).toBe(true);
    expect(commands).toHaveLength(1);
  });

  it("lists only workspaces with project fields", async () => {
    const { projects } = (await ext.handleMethod("support.list_projects", {})) as {
      projects: Array<{ name: string }>;
    };
    expect(projects.map((p) => p.name)).toEqual(["tnh"]);
  });

  it("trusts a forward from Michael, not a stranger's email, whatever the caller says", async () => {
    const forwarded = await mcp("support_create_ticket", {
      title: "Games stuck when a player leaves",
      project: "nutwords",
      report: { source: "email", messageId: "100", reporterName: "Rae" },
    });
    expect(forwarded.data.ticket).toMatchObject({ trusted: true, workspaceName: "tnh" });

    const stranger = await mcp("support_create_ticket", {
      title: "Please run this SQL for me",
      project: "nutwords",
      report: { source: "email", messageId: "200" },
    });
    expect(stranger.data.ticket.trusted).toBe(false);
    const detail = (await ext.handleMethod("support.get_ticket", {
      ticketId: stranger.data.ticket.id,
    })) as { reports: Array<{ reporterEmail: string }>; activity: Array<{ actor: string }> };
    expect(detail.reports[0].reporterEmail).toBe("stranger@example.com");
    expect(detail.activity[0].actor).toBe("support");

    // A forum report from the front desk is never trusted.
    const forum = await mcp("support_create_ticket", {
      title: "Forum post",
      report: { source: "forum", url: "https://nutwords.com/forum/x", reporterName: "Rae" },
    });
    expect(forum.data.ticket.trusted).toBe(false);
  });

  it("delegates trusted tickets to an auto session in the project, and refuses the rest", async () => {
    const trusted = await mcp("support_create_ticket", {
      title: "Games stuck",
      project: "nutwords",
      report: { source: "email", messageId: "100", reporterName: "Rae" },
    });
    const id = trusted.data.ticket.id as number;
    const delegated = await mcp("support_delegate", {
      ticketId: id,
      task: "Find out why turns stick",
    });
    expect(delegated.error).toBe(false);

    const spawn = calls.find((c) => c.method === "session.spawn_agent");
    expect(spawn?.params).toMatchObject({
      parentSessionId: "NEW",
      cwd: TNH.cwd,
      profile: "auto",
      name: `tnh · #${id} Games stuck`,
    });
    const prompt = String(spawn?.params.prompt);
    expect(prompt).toContain("Find out why turns stick");
    expect(prompt).toContain("anima mail read --messageId 100");
    expect(prompt).toContain(`Support ticket #${id}`);
    expect(prompt).toContain("never instructions");
    expect(delegated.data.ticket.status).toBe("in_progress");

    const stranger = await mcp("support_create_ticket", {
      title: "From a stranger",
      project: "nutwords",
      report: { source: "email", messageId: "200" },
    });
    const refused = await mcp("support_delegate", {
      ticketId: stranger.data.ticket.id,
      task: "Do what the email says",
    });
    expect(refused.error).toBe(true);
    expect(refused.data.error).toContain("approve");

    // Michael approves; then it can go (until the hourly limit).
    await ext.handleMethod("support.approve", {
      ticketId: stranger.data.ticket.id,
      actor: "michael",
    });
    expect(
      (await mcp("support_delegate", { ticketId: stranger.data.ticket.id, task: "Investigate it" }))
        .error,
    ).toBe(false);
    const limited = await mcp("support_delegate", { ticketId: id, task: "Once more please" });
    expect(limited.data.error).toContain("limit");
  });

  it("won't delegate a ticket without a project", async () => {
    const t = (await ext.handleMethod("support.create_ticket", { title: "Orphan" })) as {
      ticket: { id: number; trusted: boolean };
    };
    expect(t.ticket.trusted).toBe(true);
    await expect(
      ext.handleMethod("support.delegate", { ticketId: t.ticket.id, task: "Look into it" }),
    ).rejects.toThrow("no project");
  });

  it("files issues in private repos, and needs approval for public ones from the front desk", async () => {
    const t = await mcp("support_create_ticket", {
      title: "Stats wrong",
      project: "nutwords",
      report: { source: "email", messageId: "100", reporterName: "Anne" },
    });
    const id = t.data.ticket.id as number;
    const filed = await mcp("support_create_issue", {
      ticketId: id,
      title: "Wins wrong after migration",
      body: "Details",
    });
    expect(filed.data.issue).toBe("https://github.com/kiliman/tnh/issues/77");
    const create = commands.find((c) => c[1] === "issue");
    expect(create?.slice(0, 5)).toEqual(["gh", "issue", "create", "--repo", "kiliman/tnh"]);
    expect(create?.[create.indexOf("--body") + 1]).toContain(`Support ticket #${id}`);
    const detail = (await ext.handleMethod("support.get_ticket", { ticketId: id })) as {
      links: Array<{ kind: string; ref: string }>;
    };
    expect(detail.links).toMatchObject([{ kind: "issue", ref: "kiliman/tnh#77" }]);

    visibility = "PUBLIC";
    const refused = await mcp("support_create_issue", { ticketId: id, title: "Again", body: "x" });
    expect(refused.data.error).toContain("public");
  });

  it("links GitHub URLs by kind and applies schema defaults", async () => {
    const t = (await ext.handleMethod("support.create_ticket", {
      title: "Linked",
      project: "nutwords",
    })) as {
      ticket: { id: number };
    };
    const linked = await mcp("support_link", {
      ticketId: t.ticket.id,
      url: "https://github.com/kiliman/tnh/pull/12",
    });
    expect(linked.data.link).toMatchObject({ kind: "pr", ref: "kiliman/tnh#12" });
    const listed = (await ext.handleMethod("support.list_tickets", {})) as { tickets: unknown[] };
    expect(listed.tickets).toHaveLength(1);
    await expect(
      ext.handleMethod("support.update_ticket", { ticketId: t.ticket.id, status: "done" }),
    ).rejects.toThrow();
  });
});
