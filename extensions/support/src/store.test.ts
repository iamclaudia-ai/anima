import { beforeEach, describe, expect, it } from "bun:test";
import { SupportStore } from "./store";
import { supportTestDb } from "./test-db";

describe("SupportStore", () => {
  let store: SupportStore;
  let clock: number;

  beforeEach(() => {
    clock = Date.parse("2026-10-24T22:00:00.000Z");
    store = new SupportStore(supportTestDb(), () => new Date((clock += 1000)));
  });

  it("creates tickets with a project and a timeline", () => {
    const t = store.createTicket({
      workspaceId: "ws_tnh",
      title: "Games stuck when a player leaves",
      trusted: false,
      actor: "support",
    });
    expect(t).toMatchObject({
      id: 1,
      workspaceName: "tnh",
      status: "new",
      priority: "normal",
      trusted: false,
      reportCount: 0,
    });
    expect(store.getDetail(t.id)?.activity.map((a) => a.kind)).toEqual(["created"]);
  });

  it("dedupes reports per ticket and source id, and a trusted report trusts the ticket", () => {
    const t = store.createTicket({
      workspaceId: null,
      title: "Stats wrong",
      trusted: false,
      actor: "support",
    });
    const first = store.addReport(
      t.id,
      {
        source: "email",
        externalId: "123",
        reporterName: "Anne",
        reporterEmail: "Anne@x.ca",
        trusted: true,
      },
      "support",
    );
    expect(first.created).toBe(true);
    expect(first.report.reporterEmail).toBe("anne@x.ca");
    expect(
      store.addReport(t.id, { source: "email", externalId: "123", trusted: true }, "support")
        .created,
    ).toBe(false);
    expect(store.requireTicket(t.id)).toMatchObject({ trusted: true, reportCount: 1 });
    expect(store.ticketsForReport("email", "123")).toEqual([t.id]);
  });

  it("owes a reply once fixed, until reporters are marked replied", () => {
    const t = store.createTicket({
      workspaceId: "ws_tnh",
      title: "Bug",
      trusted: true,
      actor: "claudia",
    });
    store.addReport(
      t.id,
      { source: "email", externalId: "1", reporterEmail: "a@x.com", trusted: true },
      "claudia",
    );
    store.addReport(t.id, { source: "sentry", externalId: "9", trusted: true }, "sentry");
    expect(store.requireTicket(t.id).replyOwed).toBe(0);
    expect(store.listTickets({ filter: "open", limit: 10 })).toHaveLength(1);

    store.setStatus(t.id, "fixed", "github", "PR merged");
    expect(store.requireTicket(t.id).replyOwed).toBe(1);
    expect(store.listTickets({ filter: "open", limit: 10 })).toHaveLength(0);
    expect(store.listTickets({ filter: "needs_reply", limit: 10 }).map((x) => x.id)).toEqual([
      t.id,
    ]);
    expect(store.counts()).toMatchObject({ fixed: 1, needsReply: 1 });

    expect(store.markReplied(t.id, null, "michael")).toBe(1);
    expect(store.listTickets({ filter: "needs_reply", limit: 10 })).toHaveLength(0);
  });

  it("orders by priority, then age, and filters by project", () => {
    store.createTicket({ workspaceId: "ws_tnh", title: "old normal", trusted: true, actor: "c" });
    store.createTicket({
      workspaceId: "ws_other",
      title: "urgent",
      priority: "urgent",
      trusted: true,
      actor: "c",
    });
    store.createTicket({ workspaceId: "ws_tnh", title: "new normal", trusted: true, actor: "c" });
    expect(store.listTickets({ filter: "all", limit: 10 }).map((t) => t.title)).toEqual([
      "urgent",
      "old normal",
      "new normal",
    ]);
    expect(store.listTickets({ filter: "all", workspaceId: "ws_other", limit: 10 })).toHaveLength(
      1,
    );
  });

  it("updates fields with a timeline note, and stamps closed_at", () => {
    const t = store.createTicket({ workspaceId: null, title: "x", trusted: true, actor: "c" });
    const updated = store.updateTicket(
      t.id,
      { status: "closed", priority: "low", workspaceId: "ws_tnh" },
      "michael",
    );
    expect(updated).toMatchObject({ status: "closed", priority: "low", workspaceName: "tnh" });
    expect(updated.closedAt).not.toBeNull();
    const note = store.getDetail(t.id)?.activity.at(-1);
    expect(note?.actor).toBe("michael");
    expect(note?.note).toContain("status new → closed");
  });

  it("upserts links and reports which tickets a state change touched", () => {
    const a = store.createTicket({ workspaceId: "ws_tnh", title: "a", trusted: true, actor: "c" });
    const b = store.createTicket({ workspaceId: "ws_tnh", title: "b", trusted: true, actor: "c" });
    expect(store.addLink(a.id, { kind: "issue", ref: "kiliman/tnh#5" }, "c").created).toBe(true);
    expect(
      store.addLink(a.id, { kind: "issue", ref: "kiliman/tnh#5", title: "T" }, "c"),
    ).toMatchObject({
      created: false,
      link: { title: "T", state: "open" },
    });
    store.addLink(b.id, { kind: "issue", ref: "kiliman/tnh#5" }, "c");
    expect(store.setLinkState("issue", "kiliman/tnh#5", "closed", "github").sort()).toEqual([
      a.id,
      b.id,
    ]);
    expect(store.setLinkState("issue", "kiliman/tnh#5", "closed", "github")).toEqual([]);
  });

  it("counts activity in a window for rate limits", () => {
    const t = store.createTicket({ workspaceId: null, title: "x", trusted: true, actor: "c" });
    const since = new Date(clock).toISOString();
    store.addActivity(t.id, "c", "delegated", "go");
    store.addActivity(t.id, "c", "delegated", "again");
    expect(store.countActivitySince("delegated", since)).toBe(2);
    expect(store.countActivitySince("delegated", new Date(clock + 5000).toISOString())).toBe(0);
  });
});
