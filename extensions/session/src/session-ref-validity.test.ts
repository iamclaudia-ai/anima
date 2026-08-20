import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDb, createWorkspace } from "./workspace";
import { closeSessionDb, getRefsForSessions, getSessionDb, setSessionRefs } from "./session-store";
import { upsertSession } from "./session-store";
import {
  classifyIssueProbe,
  loadInvalidRefKeys,
  rejectKnownInvalidRefs,
  resetGithubToken,
  validateSessionRefs,
} from "./session-ref-validity";
import { syncSessionRefs } from "./session-ref-sync";
import type { RefsConfig } from "./session-refs";

const config: RefsConfig = {
  linear: { prefixes: ["BEE"], workspace: "beehiiv" },
  github: { defaultRepo: "iamclaudia-ai/anima", minDigits: 2 },
};

let dataDir: string;
let prevDataDir: string | undefined;
let prevToken: string | undefined;
let prevGithubToken: string | undefined;
let workspaceId: string;
let realFetch: typeof fetch;

/** Requested paths, in order — lets a test assert the repo probe came first. */
let requested: string[];

/**
 * Stand in for GitHub.
 *
 * `routes` maps an API path to the status it answers with; anything unlisted
 * is a 404, which is the case that matters most here — the module's whole job
 * is deciding when a 404 may be believed.
 */
function stubGithub(routes: Record<string, number>): void {
  requested = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = url.replace("https://api.github.com/", "");
    requested.push(path);
    const status = routes[path] ?? 404;
    if (status === 0) throw new Error("network down");
    return new Response(status === 200 ? "{}" : '{"message":"Not Found"}', { status });
  }) as typeof fetch;
}

function addSession(sessionId: string): void {
  upsertSession({
    id: sessionId,
    workspaceId,
    providerSessionId: sessionId,
    model: "claude-opus-5",
    agent: "claude",
    purpose: "chat",
    runtimeStatus: "idle",
    lastActivity: new Date().toISOString(),
  });
}

function addRef(sessionId: string, key: string, type = "github"): void {
  const existing = getRefsForSessions([sessionId]).get(sessionId) ?? [];
  setSessionRefs(sessionId, [...existing, { type, key, label: key }]);
}

const keysOf = (sessionId: string): string[] =>
  (getRefsForSessions([sessionId]).get(sessionId) ?? []).map((ref) => ref.key);

describe("session ref validity", () => {
  beforeEach(() => {
    prevDataDir = process.env.ANIMA_DATA_DIR;
    prevToken = process.env.GH_TOKEN;
    prevGithubToken = process.env.GITHUB_TOKEN;
    dataDir = mkdtempSync(join(tmpdir(), "anima-ref-validity-"));
    process.env.ANIMA_DATA_DIR = dataDir;
    // A token from the environment keeps the module off `gh` entirely, so no
    // test can accidentally reach the real API.
    process.env.GH_TOKEN = "test-token";
    // This shell exports one too, and it would otherwise satisfy the
    // no-token test's fallback.
    delete process.env.GITHUB_TOKEN;
    resetGithubToken();
    closeDb();
    closeSessionDb();
    workspaceId = createWorkspace({ name: "anima", cwd: join(dataDir, "anima") }).id;
    realFetch = globalThis.fetch;
    requested = [];
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    resetGithubToken();
    closeDb();
    closeSessionDb();
    if (prevDataDir === undefined) delete process.env.ANIMA_DATA_DIR;
    else process.env.ANIMA_DATA_DIR = prevDataDir;
    if (prevToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = prevToken;
    if (prevGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prevGithubToken;
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe("classifyIssueProbe", () => {
    test("only a clean 200 or 404 is conclusive", () => {
      expect(classifyIssueProbe(200)).toBe("valid");
      expect(classifyIssueProbe(404)).toBe("missing");
      // 403 is a rate limit or an SSO wall, 401 a dead token, 0 a dead socket.
      // Treating any of them as "missing" would delete real chips.
      for (const status of [0, 401, 403, 429, 500, 502]) {
        expect(classifyIssueProbe(status)).toBe("unknown");
      }
    });
  });

  test("removes a ref GitHub says doesn't exist, and remembers the miss", async () => {
    addSession("s1");
    addRef("s1", "iamclaudia-ai/anima#71");
    addRef("s1", "iamclaudia-ai/anima#171717");

    stubGithub({
      "repos/iamclaudia-ai/anima": 200,
      "repos/iamclaudia-ai/anima/issues/71": 200,
      // #171717 is Tailwind's gray-900, not an issue — unlisted, so 404.
    });

    const result = await validateSessionRefs();

    expect(result.checked).toBe(2);
    expect(result.valid).toBe(1);
    expect(result.invalid).toBe(1);
    expect(result.removed).toBe(1);
    expect(keysOf("s1")).toEqual(["iamclaudia-ai/anima#71"]);
    // The negative is kept — that's what stops it being re-extracted.
    expect(loadInvalidRefKeys(["iamclaudia-ai/anima#171717"])).toEqual(
      new Set(["iamclaudia-ai/anima#171717"]),
    );
  });

  test("deletes a debunked key from every session carrying it", async () => {
    addSession("s1");
    addSession("s2");
    addRef("s1", "iamclaudia-ai/anima#28651");
    addRef("s2", "iamclaudia-ai/anima#28651");

    stubGithub({ "repos/iamclaudia-ai/anima": 200 });
    const result = await validateSessionRefs();

    // One key checked, but two chips removed.
    expect(result.checked).toBe(1);
    expect(result.removed).toBe(2);
    expect(keysOf("s1")).toEqual([]);
    expect(keysOf("s2")).toEqual([]);
  });

  test("a second pass re-checks nothing", async () => {
    addSession("s1");
    addRef("s1", "iamclaudia-ai/anima#71");
    stubGithub({ "repos/iamclaudia-ai/anima": 200, "repos/iamclaudia-ai/anima/issues/71": 200 });

    await validateSessionRefs();
    const before = requested.length;
    const second = await validateSessionRefs();

    expect(second.checked).toBe(0);
    // Not one extra request — including the repo probe, which is only worth
    // paying for when there's something under it to check.
    expect(requested.length).toBe(before);
  });

  test("revalidate reconsiders a debunked key whose chips are already gone", async () => {
    addSession("s1");
    addRef("s1", "iamclaudia-ai/anima#74");
    // Michael wrote "#74" before filing it, so it genuinely doesn't exist yet.
    stubGithub({ "repos/iamclaudia-ai/anima": 200 });
    await validateSessionRefs();
    expect(keysOf("s1")).toEqual([]);
    expect(loadInvalidRefKeys(["iamclaudia-ai/anima#74"]).size).toBe(1);

    // The issue is filed. A plain pass can't see the key at all now — its
    // `session_refs` rows were deleted — so revalidate must reach the cache.
    stubGithub({ "repos/iamclaudia-ai/anima": 200, "repos/iamclaudia-ai/anima/issues/74": 200 });
    const result = await validateSessionRefs({ revalidate: true });

    expect(result.valid).toBe(1);
    expect(loadInvalidRefKeys(["iamclaudia-ai/anima#74"]).size).toBe(0);

    // Clearing the verdict doesn't restore the chip by itself — nothing
    // recorded which sessions lost it. A rescan is what brings it back, and it
    // can only do so because the cache no longer rejects the key.
    syncSessionRefs([{ sessionId: "s1", titleText: "filed as #74" }], config, { rescan: true });
    expect(keysOf("s1")).toEqual(["iamclaudia-ai/anima#74"]);
  });

  describe("when a 404 can't be trusted", () => {
    test("an unreachable repo leaves every one of its refs alone", async () => {
      addSession("s1");
      addRef("s1", "beehiiv/swarm#28651");
      addRef("s1", "beehiiv/swarm#28329");

      // The token can't read the repo, so GitHub 404s the repo *and* every
      // issue under it. Believing that would strip 176 genuine chips.
      stubGithub({});
      const result = await validateSessionRefs();

      expect(result.checked).toBe(0);
      expect(result.removed).toBe(0);
      expect(result.skipped).toBe(2);
      expect(result.unreachableRepos).toEqual(["beehiiv/swarm"]);
      expect(keysOf("s1")).toEqual(["beehiiv/swarm#28651", "beehiiv/swarm#28329"]);
      // Nothing cached, so the next pass tries again rather than treating an
      // auth blip as a permanent verdict.
      expect(loadInvalidRefKeys(["beehiiv/swarm#28651"]).size).toBe(0);
      // The issues were never even requested — the repo probe short-circuits.
      expect(requested).toEqual(["repos/beehiiv/swarm"]);
    });

    test("a rate-limited check is skipped, not cached as missing", async () => {
      addSession("s1");
      addRef("s1", "iamclaudia-ai/anima#71");
      stubGithub({
        "repos/iamclaudia-ai/anima": 200,
        "repos/iamclaudia-ai/anima/issues/71": 403,
      });

      const result = await validateSessionRefs();

      expect(result.checked).toBe(0);
      expect(result.skipped).toBe(1);
      expect(keysOf("s1")).toEqual(["iamclaudia-ai/anima#71"]);
      expect(loadInvalidRefKeys(["iamclaudia-ai/anima#71"]).size).toBe(0);
    });

    test("a dead network is skipped, not cached as missing", async () => {
      addSession("s1");
      addRef("s1", "iamclaudia-ai/anima#71");
      stubGithub({ "repos/iamclaudia-ai/anima": 0 });

      const result = await validateSessionRefs();

      expect(result.checked).toBe(0);
      expect(keysOf("s1")).toEqual(["iamclaudia-ai/anima#71"]);
    });

    test("no token means no verdicts", async () => {
      delete process.env.GH_TOKEN;
      // A stub `gh` that fails, rather than the real one. The fallback spawns
      // whatever is on PATH, and the real wrapper shells out to
      // `gh auth status` and `jq` — five seconds under load, slow enough to
      // fail intermittently, and reaching the machine's actual credentials
      // besides. Emptying PATH doesn't work: Bun still finds the binary.
      const prevPath = process.env.PATH;
      const binDir = join(dataDir, "bin");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, "gh"), "#!/bin/sh\nexit 1\n");
      chmodSync(join(binDir, "gh"), 0o755);
      process.env.PATH = binDir;
      resetGithubToken();
      addSession("s1");
      addRef("s1", "iamclaudia-ai/anima#171717");
      stubGithub({});

      try {
        const result = await validateSessionRefs();
        expect(result.invalid).toBe(0);
        expect(result.skipped).toBe(1);
        // Never asked, so nothing could be concluded.
        expect(requested).toEqual([]);
        expect(keysOf("s1")).toEqual(["iamclaudia-ai/anima#171717"]);
      } finally {
        process.env.PATH = prevPath;
      }
    });
  });

  describe("what gets checked", () => {
    test("skips bare refs, which have no repo to ask about", async () => {
      addSession("s1");
      addRef("s1", "#4821");
      stubGithub({});

      const result = await validateSessionRefs();

      expect(result.checked).toBe(0);
      expect(requested).toEqual([]);
      expect(keysOf("s1")).toEqual(["#4821"]);
    });

    test("skips Linear refs — GitHub is not their oracle", async () => {
      addSession("s1");
      addRef("s1", "BEE-24118", "linear");
      stubGithub({});

      const result = await validateSessionRefs();

      expect(result.checked).toBe(0);
      expect(requested).toEqual([]);
      expect(keysOf("s1")).toEqual(["BEE-24118"]);
    });

    test("honours the per-pass limit, busiest keys first", async () => {
      addSession("s1");
      addSession("s2");
      // #28651 is on two sessions, #28329 on one, so it should win the budget.
      addRef("s1", "iamclaudia-ai/anima#28651");
      addRef("s2", "iamclaudia-ai/anima#28651");
      addRef("s1", "iamclaudia-ai/anima#28329");
      stubGithub({ "repos/iamclaudia-ai/anima": 200 });

      const result = await validateSessionRefs({ limit: 1 });

      expect(result.checked).toBe(1);
      expect(requested).toContain("repos/iamclaudia-ai/anima/issues/28651");
      expect(keysOf("s1")).toEqual(["iamclaudia-ai/anima#28329"]);
    });
  });

  describe("extraction consults the cache", () => {
    test("a debunked key is not re-added by a later sync", async () => {
      addSession("s1");
      addRef("s1", "iamclaudia-ai/anima#171717");
      stubGithub({ "repos/iamclaudia-ai/anima": 200 });
      await validateSessionRefs();
      expect(keysOf("s1")).toEqual([]);

      // The transcript still says `#171717`, so extraction still finds it.
      // Without the cache this would put the chip straight back.
      syncSessionRefs([{ sessionId: "s1", titleText: "use #171717 for the bg" }], config, {
        rescan: true,
      });

      expect(keysOf("s1")).toEqual([]);
    });

    test("valid refs alongside a debunked one still land", () => {
      addSession("s1");
      syncSessionRefs(
        [{ sessionId: "s1", titleText: "fixes #71 using #171717 as the bg" }],
        config,
        { rescan: true },
      );
      expect(keysOf("s1")).toEqual(["iamclaudia-ai/anima#71", "iamclaudia-ai/anima#171717"]);

      getSessionDb()
        .query(
          `INSERT INTO session_ref_validity (ref_key, ref_type, valid, checked_at)
           VALUES ('iamclaudia-ai/anima#171717', 'github', 0, datetime('now'))`,
        )
        .run();

      syncSessionRefs(
        [{ sessionId: "s1", titleText: "fixes #71 using #171717 as the bg" }],
        config,
        { rescan: true },
      );
      expect(keysOf("s1")).toEqual(["iamclaudia-ai/anima#71"]);
    });

    test("rejectKnownInvalidRefs leaves an unchecked set untouched", () => {
      // Table may not exist yet on a fresh database — the helper must create
      // it rather than throwing through the nav's list call.
      const refs = [{ key: "iamclaudia-ai/anima#71" }, { key: "BEE-24118" }];
      expect(rejectKnownInvalidRefs(refs)).toEqual(refs);
    });
  });
});
