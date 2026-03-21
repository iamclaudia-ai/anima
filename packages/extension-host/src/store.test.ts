import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as os from "node:os";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createExtensionStore } from "./store";

describe("createExtensionStore", () => {
  const testHome = join("/tmp", `anima-store-test-${Date.now()}`);
  let homedirSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mkdirSync(testHome, { recursive: true });
    homedirSpy = spyOn(os, "homedir").mockReturnValue(testHome);
  });

  afterEach(() => {
    homedirSpy.mockRestore();
    rmSync(testHome, { recursive: true, force: true });
  });

  it("persists nested values with dot notation", () => {
    const store = createExtensionStore("imessage");

    store.set("session.id", "abc-123");
    store.set("session.rotatedAt", "2026-03-21");

    expect(store.get<string>("session.id")).toBe("abc-123");
    expect(store.get<{ id: string; rotatedAt: string }>("session")).toEqual({
      id: "abc-123",
      rotatedAt: "2026-03-21",
    });

    const persistedPath = join(testHome, ".anima", "imessage", "store.json");
    expect(existsSync(persistedPath)).toBe(true);
  });

  it("deletes nested keys without disturbing siblings", () => {
    const store = createExtensionStore("voice");

    store.set("session.id", "abc-123");
    store.set("session.mode", "general");

    expect(store.delete("session.id")).toBe(true);
    expect(store.get<{ mode: string }>("session")).toEqual({ mode: "general" });
    expect(store.delete("session.missing")).toBe(false);
  });

  it("recovers from a corrupted persisted file by starting fresh", () => {
    const dir = join(testHome, ".anima", "session");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "store.json"), "{not-json", "utf-8");

    const store = createExtensionStore("session");

    expect(store.all()).toEqual({});
    store.set("persistentSessions.cwd", {
      sessionId: "session-1",
      messageCount: 1,
      createdAt: "2026-03-21T00:00:00.000Z",
    });
    expect(
      store.get<{ sessionId: string; messageCount: number; createdAt: string }>(
        "persistentSessions.cwd",
      ),
    ).toEqual({
      sessionId: "session-1",
      messageCount: 1,
      createdAt: "2026-03-21T00:00:00.000Z",
    });
  });
});
