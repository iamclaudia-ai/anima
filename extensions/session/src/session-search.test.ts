import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import { searchSessions, toMatchQuery } from "./session-search";
import { closeSessionDb, setSessionRefs, upsertSession } from "./session-store";
import { createWorkspace, closeDb } from "./workspace";

describe("toMatchQuery", () => {
  it("quotes each word so punctuation can't be read as FTS syntax", () => {
    // Bare, these are FTS5 syntax errors, not searches: `#` and `-` are
    // operators and `/` splits a column filter.
    expect(toMatchQuery("PR #412")).toBe('"PR" AND "412"*');
    expect(toMatchQuery("feat/session-fts ")).toBe('"feat" AND "session" AND "fts"');
  });

  it("prefix-matches the word still being typed, but not a finished one", () => {
    expect(toMatchQuery("reconc")).toBe('"reconc"*');
    expect(toMatchQuery("reconciler ")).toBe('"reconciler"');
  });

  it("returns null when there is nothing to search for", () => {
    expect(toMatchQuery("")).toBeNull();
    expect(toMatchQuery("   ")).toBeNull();
    expect(toMatchQuery("#@!")).toBeNull();
  });

  it("keeps non-latin queries intact", () => {
    expect(toMatchQuery("привет мир")).toBe('"привет" AND "мир"*');
  });
});

describe("searchSessions", () => {
  let tmpHome: string;
  let homedirSpy: ReturnType<typeof spyOn>;
  let originalHome: string | undefined;

  const hit = (sessionId: string, rank: number) => ({
    sessionId,
    cwd: "/w",
    timestamp: "2026-08-15T10:00:00Z",
    snippet: "the «proxy» port drifted",
    role: "assistant" as const,
    matches: 3,
    rank,
  });

  beforeEach(() => {
    tmpHome = mkdtempSync(join(os.tmpdir(), "claudia-session-search-"));
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
    homedirSpy = spyOn(os, "homedir").mockReturnValue(tmpHome);
  });

  afterEach(() => {
    closeSessionDb();
    closeDb();
    homedirSpy.mockRestore();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function seedSession(sessionId: string, workspaceId: string, firstPrompt: string) {
    upsertSession({
      id: sessionId,
      workspaceId,
      providerSessionId: sessionId,
      model: "claude-opus-5",
      agent: "claude",
      purpose: "chat",
      runtimeStatus: "idle",
      metadata: { firstPrompt },
      lastActivity: "2026-08-15T10:00:00Z",
    });
  }

  it("hydrates memory's hits with what session owns", async () => {
    const ws = createWorkspace({ name: "anima", cwd: "/w/hydrate" });
    seedSession("ses_a", ws.id, "fix the proxy port drift");
    setSessionRefs("ses_a", [{ type: "github", key: "anima#39", label: "#39" }]);

    const result = await searchSessions(async () => ({ results: [hit("ses_a", -9)] }), {
      query: "proxy port",
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({
      sessionId: "ses_a",
      workspaceId: ws.id,
      workspaceName: "anima",
      title: "fix the proxy port drift",
      snippet: "the «proxy» port drifted",
      matches: 3,
      archived: false,
    });
    expect(result.hits[0]?.refs[0]?.key).toBe("anima#39");
  });

  it("drops hits no registered workspace can route, and says how many", async () => {
    // Memory indexes ~2,400 sessions; only a few hundred have live rows here.
    // A hit with nowhere to navigate must not render as a dead link.
    const ws = createWorkspace({ name: "anima", cwd: "/w/unroutable" });
    seedSession("ses_known", ws.id, "known session");

    const result = await searchSessions(
      async () => ({ results: [hit("ses_gone", -12), hit("ses_known", -9)] }),
      { query: "proxy" },
    );

    expect(result.hits.map((h) => h.sessionId)).toEqual(["ses_known"]);
    expect(result.unroutable).toBe(1);
  });

  it("passes a ref filter to memory as an allow-list of sessions", async () => {
    const ws = createWorkspace({ name: "anima", cwd: "/w/ref" });
    seedSession("ses_ref", ws.id, "the #61 work");
    setSessionRefs("ses_ref", [{ type: "github", key: "anima#61", label: "#61" }]);

    let sent: Record<string, unknown> | undefined;
    const result = await searchSessions(
      async (_method, params) => {
        sent = params;
        return { results: [hit("ses_ref", -8)] };
      },
      { query: "chips", ref: "anima#61" },
    );

    expect(sent?.sessionIds).toEqual(["ses_ref"]);
    expect(result.hits).toHaveLength(1);
  });

  it("returns nothing when a ref matches no session, without asking memory", async () => {
    let called = false;
    const result = await searchSessions(
      async () => {
        called = true;
        return { results: [] };
      },
      { query: "chips", ref: "anima#99999" },
    );

    expect(result.hits).toEqual([]);
    expect(called).toBe(false);
  });

  it("does not call memory for a query with no searchable characters", async () => {
    let called = false;
    const result = await searchSessions(
      async () => {
        called = true;
        return { results: [] };
      },
      { query: "  ##  " },
    );

    expect(result.hits).toEqual([]);
    expect(called).toBe(false);
  });

  it("honours the limit after unroutable hits are dropped", async () => {
    const ws = createWorkspace({ name: "anima", cwd: "/w/limit" });
    for (let i = 0; i < 5; i++) seedSession(`ses_${i}`, ws.id, `session ${i}`);

    const result = await searchSessions(
      async () => ({ results: [0, 1, 2, 3, 4].map((i) => hit(`ses_${i}`, -10 + i)) }),
      { query: "session", limit: 2 },
    );

    // Ranked order is preserved — memory returns best-first and hydration
    // must not reorder.
    expect(result.hits.map((h) => h.sessionId)).toEqual(["ses_0", "ses_1"]);
  });
});
