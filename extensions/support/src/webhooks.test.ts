import { beforeEach, describe, expect, it } from "bun:test";
import { handleGithubDelivery, mentionedTickets } from "./github";
import { handleSentryDelivery, projectFromEventUrl } from "./sentry";
import { SupportStore } from "./store";
import { supportTestDb } from "./test-db";

const REPO = "kiliman/tnh";

function gh(event: string, payload: unknown) {
  return [{ "X-GitHub-Event": event }, JSON.stringify(payload)] as const;
}

describe("GitHub deliveries", () => {
  let store: SupportStore;
  const deps = () => ({
    store,
    findWorkspaceByRepo: async (repo: string) => (repo === REPO ? { id: "ws_tnh" } : null),
  });

  beforeEach(() => {
    store = new SupportStore(supportTestDb());
  });

  it("finds ticket mentions", () => {
    expect(mentionedTickets("Fixes #3\n\nSupport ticket #12, support TICKET #12 and #4")).toEqual([
      12,
    ]);
    expect(mentionedTickets(null)).toEqual([]);
  });

  it("answers ping and ignores other events", async () => {
    expect((await handleGithubDelivery({ "x-github-event": "ping" }, "{}", deps())).status).toBe(
      "ok",
    );
    expect((await handleGithubDelivery({ "x-github-event": "push" }, "{}", deps())).status).toBe(
      "ignored",
    );
  });

  it("links a PR that names a ticket and marks the ticket fixed (reply owed) when it merges", async () => {
    const t = store.createTicket({
      workspaceId: "ws_tnh",
      title: "Stuck turns",
      trusted: true,
      actor: "c",
    });
    store.addReport(
      t.id,
      { source: "email", externalId: "1", reporterEmail: "rae@x.com", trusted: true },
      "c",
    );
    const pr = {
      number: 42,
      title: "Skip lapsed players",
      body: `Support ticket #${t.id}`,
      html_url: `https://github.com/${REPO}/pull/42`,
    };

    let result = await handleGithubDelivery(
      ...gh("pull_request", {
        action: "opened",
        pull_request: pr,
        repository: { full_name: REPO },
      }),
      deps(),
    );
    expect(result.tickets).toEqual([t.id]);
    expect(store.linksFor(t.id)).toMatchObject([{ kind: "pr", ref: `${REPO}#42`, state: "open" }]);
    expect(store.requireTicket(t.id).status).toBe("new");

    result = await handleGithubDelivery(
      ...gh("pull_request", {
        action: "closed",
        pull_request: { ...pr, merged: true },
        repository: { full_name: REPO },
      }),
      deps(),
    );
    expect(store.linksFor(t.id)[0].state).toBe("merged");
    expect(store.requireTicket(t.id)).toMatchObject({ status: "fixed", replyOwed: 1 });
  });

  it("won't link a ticket from another repo", async () => {
    const t = store.createTicket({ workspaceId: "ws_tnh", title: "x", trusted: true, actor: "c" });
    const result = await handleGithubDelivery(
      ...gh("issues", {
        action: "opened",
        issue: { number: 1, body: `Support ticket #${t.id}` },
        repository: { full_name: "evil/repo" },
      }),
      deps(),
    );
    expect(result.tickets).toEqual([]);
    expect(store.linksFor(t.id)).toEqual([]);
  });

  it("fixes a ticket when its issues close, and reopens it when one reopens", async () => {
    const t = store.createTicket({ workspaceId: "ws_tnh", title: "x", trusted: true, actor: "c" });
    store.addLink(t.id, { kind: "issue", ref: `${REPO}#7` }, "c");
    store.addLink(t.id, { kind: "issue", ref: `${REPO}#8` }, "c");
    const close = (n: number) =>
      handleGithubDelivery(
        ...gh("issues", {
          action: "closed",
          issue: { number: n },
          repository: { full_name: REPO },
        }),
        deps(),
      );

    await close(7);
    expect(store.requireTicket(t.id).status).toBe("new");
    await close(8);
    expect(store.requireTicket(t.id).status).toBe("fixed");

    await handleGithubDelivery(
      ...gh("issues", {
        action: "reopened",
        issue: { number: 8 },
        repository: { full_name: REPO },
      }),
      deps(),
    );
    expect(store.requireTicket(t.id).status).toBe("triaged");
  });

  it("leaves a closed-unmerged PR's ticket open", async () => {
    const t = store.createTicket({ workspaceId: "ws_tnh", title: "x", trusted: true, actor: "c" });
    store.addLink(t.id, { kind: "pr", ref: `${REPO}#9` }, "c");
    await handleGithubDelivery(
      ...gh("pull_request", {
        action: "closed",
        pull_request: { number: 9, merged: false },
        repository: { full_name: REPO },
      }),
      deps(),
    );
    expect(store.linksFor(t.id)[0].state).toBe("closed");
    expect(store.requireTicket(t.id).status).toBe("new");
  });
});

describe("Sentry deliveries", () => {
  let store: SupportStore;
  const deps = () => ({
    store,
    findWorkspaceBySentryProject: async (slug: string) =>
      slug === "nutwords" ? { id: "ws_tnh" } : null,
  });
  const issue = {
    id: "1234567890",
    shortId: "NUTWORDS-4F",
    title: "TypeError: Cannot read properties of undefined (reading 'seat')",
    culprit: "app/routes/game.$id.tsx in action",
    level: "error",
    web_url: "https://kiliman.sentry.io/issues/1234567890/",
    count: "3",
    userCount: 2,
    firstSeen: "2026-10-24T20:56:00.679000+00:00",
    project: { slug: "nutwords", name: "NutWords" },
  };
  const send = (resource: string, payload: unknown) =>
    handleSentryDelivery({ "Sentry-Hook-Resource": resource }, JSON.stringify(payload), deps());

  beforeEach(() => {
    store = new SupportStore(supportTestDb());
  });

  it("parses the project slug from an event url", () => {
    expect(
      projectFromEventUrl("https://sentry.io/api/0/projects/test-org/front-end/events/e48/"),
    ).toBe("front-end");
    expect(projectFromEventUrl(undefined)).toBeNull();
  });

  it("opens one trusted ticket per Sentry issue, routed to its project", async () => {
    const created = await send("issue", { action: "created", data: { issue } });
    expect(created).toMatchObject({ status: "created", resource: "issue", action: "created" });
    const ticket = store.requireTicket(created.ticketId as number);
    expect(ticket).toMatchObject({
      workspaceName: "tnh",
      priority: "high",
      trusted: true,
      title: `NUTWORDS-4F: ${issue.title}`,
    });
    expect(store.linksFor(ticket.id)).toMatchObject([
      { kind: "sentry", ref: "NUTWORDS-4F", url: issue.web_url },
    ]);

    // An alert for the same issue lands on the same ticket.
    const alert = await send("event_alert", {
      action: "triggered",
      data: {
        event: {
          issue_id: "1234567890",
          title: issue.title,
          url: "https://sentry.io/api/0/projects/kiliman/nutwords/events/abc/",
        },
        triggered_rule: "New error",
      },
    });
    expect(alert).toMatchObject({ status: "updated", ticketId: ticket.id });
    expect(store.listTickets({ filter: "all", limit: 10 })).toHaveLength(1);
  });

  it("fixes on resolve and reopens on regression", async () => {
    const { ticketId } = await send("issue", { action: "created", data: { issue } });
    await send("issue", { action: "resolved", data: { issue } });
    expect(store.requireTicket(ticketId as number).status).toBe("fixed");
    expect(store.requireTicket(ticketId as number).replyOwed).toBe(0);
    await send("issue", { action: "unresolved", data: { issue } });
    expect(store.requireTicket(ticketId as number).status).toBe("new");
    expect(store.linksFor(ticketId as number)[0].state).toBe("open");
  });

  it("opens a ticket from an alert for an unknown issue, and ignores what it doesn't handle", async () => {
    const alert = await send("event_alert", {
      action: "triggered",
      data: {
        event: {
          issue_id: "555",
          title: "Boom",
          level: "fatal",
          url: "https://sentry.io/api/0/projects/kiliman/nutwords/events/abc/",
        },
        triggered_rule: "Fatal",
      },
    });
    expect(store.requireTicket(alert.ticketId as number)).toMatchObject({
      priority: "urgent",
      workspaceName: "tnh",
    });
    expect((await send("installation", { action: "created" })).status).toBe("ignored");
    expect(
      (await send("issue", { action: "resolved", data: { issue: { id: "999" } } })).status,
    ).toBe("ignored");
    expect((await handleSentryDelivery({}, "not json", deps())).status).toBe("ignored");
  });
});
