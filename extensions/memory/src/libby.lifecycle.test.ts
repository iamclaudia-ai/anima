import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@anima/shared";
import { closeDb, getDb, setDbPathForTests } from "./db";
import {
  LibbyOpenError,
  LibbySession,
  LibbyWorker,
  MAX_CONVERSATION_ATTEMPTS,
  backoffDelayMs,
} from "./libby";

type Call = { method: string; params: Record<string, unknown> };

/** A ctx whose `call` records every RPC and answers from a handler map. */
function fakeCtx(handlers: Record<string, (params: Record<string, unknown>) => unknown>): {
  ctx: ExtensionContext;
  calls: Call[];
} {
  const calls: Call[] = [];
  const ctx = {
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      const handler = handlers[method];
      return handler ? await handler(params) : {};
    },
  } as unknown as ExtensionContext;
  return { ctx, calls };
}

const closed = (calls: Call[]) =>
  calls.filter((c) => c.method === "session.close_session").map((c) => c.params.sessionId);

const noop = () => {};

describe("LibbySession.open", () => {
  it("closes its session when the system prompt is refused", async () => {
    const { ctx, calls } = fakeCtx({
      "session.list_sessions": () => ({ sessions: [] }),
      "session.create_session": () => ({ sessionId: "libby-1" }),
      "session.send_prompt": () => ({ text: "", stopReason: "refusal" }),
    });
    const session = new LibbySession(ctx, "claude-opus-5-5", noop);

    await expect(session.open()).rejects.toBeInstanceOf(LibbyOpenError);
    expect(closed(calls)).toEqual(["libby-1"]);
    expect(session.sessionId).toBeNull();
  });

  it("closes its session when the system prompt request fails outright", async () => {
    const { ctx, calls } = fakeCtx({
      "session.list_sessions": () => ({ sessions: [] }),
      "session.create_session": () => ({ sessionId: "libby-2" }),
      "session.send_prompt": () => {
        throw new Error("ctx.call(session.send_prompt) timed out after 300000ms");
      },
    });
    const session = new LibbySession(ctx, "claude-opus-5-5", noop);

    await expect(session.open()).rejects.toThrow("timed out");
    expect(closed(calls)).toEqual(["libby-2"]);
  });

  it("keeps the session open once Libby answers", async () => {
    const { ctx, calls } = fakeCtx({
      "session.list_sessions": () => ({ sessions: [] }),
      "session.create_session": () => ({ sessionId: "libby-3" }),
      "session.send_prompt": () => ({ text: "ready" }),
    });
    const session = new LibbySession(ctx, "claude-opus-5-5", noop);

    await session.open();
    expect(session.isOpen).toBe(true);
    expect(closed(calls)).toEqual([]);
  });

  it("closes recently stranded sessions by their sessionId, leaving old ones", async () => {
    const recent = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const { ctx, calls } = fakeCtx({
      "session.list_sessions": () => ({
        sessions: [
          { sessionId: "stranded", modified: recent },
          { sessionId: "ancient", modified: old },
          { sessionId: "undated" },
        ],
      }),
      "session.create_session": () => ({ sessionId: "libby-4" }),
      "session.send_prompt": () => ({ text: "ready" }),
    });

    await new LibbySession(ctx, "claude-opus-5-5", noop).open();
    expect(closed(calls)).toEqual(["stranded"]);
  });
});

describe("backoffDelayMs", () => {
  it("doubles from 5s and caps at 30 minutes", () => {
    expect(backoffDelayMs(1)).toBe(5_000);
    expect(backoffDelayMs(2)).toBe(10_000);
    expect(backoffDelayMs(4)).toBe(40_000);
    expect(backoffDelayMs(50)).toBe(30 * 60 * 1000);
  });
});

describe("LibbyWorker failure accounting", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "anima-libby-failures-"));
    setDbPathForTests(join(tempDir, "anima.test.db"));
    getDb().exec(`
      CREATE TABLE memory_conversations (
        id INTEGER PRIMARY KEY, status TEXT NOT NULL, summary TEXT, files_written TEXT,
        processed_at TEXT, status_at TEXT, metadata TEXT
      );
      INSERT INTO memory_conversations (id, status) VALUES (42, 'processing');
    `);
  });

  afterEach(() => {
    closeDb();
    setDbPathForTests(null);
    rmSync(tempDir, { recursive: true, force: true });
  });

  const status = () =>
    getDb().query("SELECT status, summary FROM memory_conversations WHERE id = 42").get() as {
      status: string;
      summary: string | null;
    };

  // The policy lives in a private method; element access is the test seam.
  const fail = (worker: LibbyWorker, error: unknown) =>
    (worker["recordConversationFailure"] as (id: number, e: unknown) => void).call(
      worker,
      42,
      error,
    );

  it("never counts open failures against the conversation", () => {
    const worker = new LibbyWorker(
      { model: "m", timezone: "UTC", minConversationMessages: 1 },
      null,
      noop,
    );
    for (let i = 0; i < MAX_CONVERSATION_ATTEMPTS + 2; i++) {
      fail(worker, new LibbyOpenError("refused"));
    }
    expect(status().status).toBe("processing");
  });

  it("requeues transcript failures, then parks the conversation for review", () => {
    const worker = new LibbyWorker(
      { model: "m", timezone: "UTC", minConversationMessages: 1 },
      null,
      noop,
    );
    for (let i = 1; i < MAX_CONVERSATION_ATTEMPTS; i++) {
      fail(worker, new Error("processTranscript timed out"));
      expect(status().status).toBe("queued");
    }
    fail(worker, new Error("processTranscript timed out"));
    expect(status().status).toBe("review");
    expect(status().summary).toContain("processTranscript timed out");
  });
});
