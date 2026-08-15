import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { forgetPort, pruneRegistry, recallPort, rememberPort } from "./port-registry";

describe("port registry", () => {
  let dir: string;
  let prevDataDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "anima-ports-"));
    prevDataDir = process.env.ANIMA_DATA_DIR;
    process.env.ANIMA_DATA_DIR = dir;
  });

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.ANIMA_DATA_DIR;
    else process.env.ANIMA_DATA_DIR = prevDataDir;
    rmSync(dir, { recursive: true, force: true });
  });

  test("remembers a port across reads", () => {
    rememberPort("session-a", 31234);
    expect(recallPort("session-a")).toBe(31234);
  });

  test("returns null for an unknown session", () => {
    expect(recallPort("never-seen")).toBeNull();
  });

  test("keeps sessions independent and overwrites on rebind", () => {
    rememberPort("a", 31001);
    rememberPort("b", 31002);
    rememberPort("a", 31009);
    expect(recallPort("a")).toBe(31009);
    expect(recallPort("b")).toBe(31002);
  });

  test("forgets on request", () => {
    rememberPort("a", 31001);
    forgetPort("a");
    expect(recallPort("a")).toBeNull();
  });

  test("survives a corrupt registry rather than throwing", () => {
    // This is a cache — an unreadable file must degrade to derivation, not
    // take down session startup.
    writeFileSync(join(dir, "cli-proxy-ports.json"), "{ not json");
    expect(recallPort("a")).toBeNull();
    rememberPort("a", 31005);
    expect(recallPort("a")).toBe(31005);
  });

  test("rejects an out-of-range persisted port", () => {
    writeFileSync(
      join(dir, "cli-proxy-ports.json"),
      JSON.stringify({ a: { port: 99999, updatedAt: new Date().toISOString() } }),
    );
    expect(recallPort("a")).toBeNull();
  });
});

describe("pruneRegistry", () => {
  const now = Date.parse("2026-08-15T12:00:00.000Z");
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const DAY = 86_400_000;

  test("keeps recent entries and drops long-unused ones", () => {
    const pruned = pruneRegistry(
      {
        fresh: { port: 31001, updatedAt: iso(DAY) },
        stale: { port: 31002, updatedAt: iso(40 * DAY) },
      },
      now,
    );
    expect(Object.keys(pruned)).toEqual(["fresh"]);
  });

  test("keeps entries with an unreadable timestamp rather than evicting them", () => {
    const pruned = pruneRegistry({ odd: { port: 31003, updatedAt: "not-a-date" } }, now);
    expect(pruned.odd?.port).toBe(31003);
  });

  test("drops malformed entries", () => {
    const pruned = pruneRegistry({ bad: { port: "nope", updatedAt: iso(0) } } as never, now);
    expect(Object.keys(pruned)).toEqual([]);
  });
});
