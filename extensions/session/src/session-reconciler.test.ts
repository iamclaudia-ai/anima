import { describe, expect, test } from "bun:test";
import { selectVanishedSessions } from "./session-reconciler";

describe("selectVanishedSessions", () => {
  const HOUR = 3_600_000;
  const now = Date.parse("2026-08-15T12:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  const stored = (entries: Record<string, string>) =>
    new Map(Object.entries(entries).map(([id, modified]) => [id, { modified }]));

  const onDisk = (...ids: string[]) => ids.map((sessionId) => ({ sessionId }));

  test("archives a session whose transcript is gone", () => {
    // Claude Code deletes transcripts after ~30 days; without this the nav
    // lists sessions forever that load no history.
    const result = selectVanishedSessions(stored({ gone: ago(40 * 24 * HOUR) }), onDisk(), now);
    expect(result).toEqual(["gone"]);
  });

  test("keeps sessions still on disk", () => {
    const result = selectVanishedSessions(
      stored({ alive: ago(40 * 24 * HOUR), gone: ago(40 * 24 * HOUR) }),
      onDisk("alive"),
      now,
    );
    expect(result).toEqual(["gone"]);
  });

  test("spares a just-created session with no transcript yet", () => {
    // Anima writes the session row before the CLI flushes its JSONL — a sweep
    // landing in that window must not archive a live session.
    expect(selectVanishedSessions(stored({ fresh: ago(30_000) }), onDisk(), now)).toEqual([]);
  });

  test("archives once past the grace period", () => {
    expect(selectVanishedSessions(stored({ old: ago(10 * 60_000) }), onDisk(), now)).toEqual([
      "old",
    ]);
  });

  test("treats an unparseable timestamp as recent and keeps the session", () => {
    expect(selectVanishedSessions(stored({ weird: "not-a-date" }), onDisk(), now)).toEqual([]);
    expect(selectVanishedSessions(stored({ empty: "" }), onDisk(), now)).toEqual([]);
  });

  test("archives nothing when everything is on disk", () => {
    const map = stored({ a: ago(40 * 24 * HOUR), b: ago(40 * 24 * HOUR) });
    expect(selectVanishedSessions(map, onDisk("a", "b"), now)).toEqual([]);
  });

  test("handles empty inputs", () => {
    expect(selectVanishedSessions(new Map(), onDisk(), now)).toEqual([]);
    expect(selectVanishedSessions(new Map(), onDisk("a"), now)).toEqual([]);
  });

  test("respects a custom grace period", () => {
    const map = stored({ s: ago(2 * HOUR) });
    expect(selectVanishedSessions(map, onDisk(), now, 3 * HOUR)).toEqual([]);
    expect(selectVanishedSessions(map, onDisk(), now, 1 * HOUR)).toEqual(["s"]);
  });
});
