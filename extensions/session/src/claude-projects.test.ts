import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { discoverSessions, salvageTruncatedUserText } from "./claude-projects";

describe("salvageTruncatedUserText", () => {
  // Real case: a transcript whose first user line is 372KB (large paste), so a
  // capped read cuts it mid-JSON and the session was left untitled — even
  // though the prompt sits in the first few hundred bytes.
  const truncatedUserLine =
    '{"type":"user","message":{"role":"user","content":[{"type":"text",' +
    '"text":"[Image #1]BEE-23513 can you take a look at this?","cache":{"blob":"AAAA';

  test("recovers the prompt from a line cut mid-JSON", () => {
    expect(salvageTruncatedUserText(truncatedUserLine)).toBe(
      "[Image #1]BEE-23513 can you take a look at this?",
    );
  });

  test("decodes JSON escapes in the salvaged text", () => {
    const line =
      '{"type":"user","message":{"content":[{"type":"text",' +
      '"text":"line one\\nline \\"two\\" \\u00e9","more';
    expect(salvageTruncatedUserText(line)).toBe('line one\nline "two" é');
  });

  test("stops at the end of the text value, not at later text fields", () => {
    const line =
      '{"type":"user","message":{"content":[{"type":"text","text":"the prompt"}]},' +
      '"extra":{"text":"not the prompt"}}';
    expect(salvageTruncatedUserText(line)).toBe("the prompt");
  });

  test("tolerates a cut inside an escape sequence", () => {
    expect(salvageTruncatedUserText('{"type":"user","content":[{"text":"hi there\\u00')).toBe(
      "hi there",
    );
    expect(salvageTruncatedUserText('{"type":"user","content":[{"text":"hi there\\')).toBe(
      "hi there",
    );
  });

  test("ignores non-user lines", () => {
    // A truncated assistant or tool line must never be mistaken for a prompt.
    expect(
      salvageTruncatedUserText('{"type":"assistant","message":{"content":[{"text":"my reply'),
    ).toBeNull();
    expect(
      salvageTruncatedUserText('{"type":"file-history-snapshot","text":"some file content'),
    ).toBeNull();
  });

  test("returns null when there is no text field to salvage", () => {
    expect(salvageTruncatedUserText('{"type":"user","message":{"content":[{"type":"im')).toBeNull();
    expect(salvageTruncatedUserText("")).toBeNull();
  });
});

describe("discoverSessions needsTitle", () => {
  // Reading each transcript's head is the expensive part of discovery — on a
  // 247-session workspace it's the difference between 154ms and 0.7ms. The
  // reconciler relies on being able to skip it for unchanged sessions.
  const home = join(tmpdir(), `anima-discover-${Date.now()}`);
  const cwd = "/tmp/anima-discover-fixture";
  const projectDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"));

  // `resolveProjectDir` reads os.homedir(), which ignores a reassigned
  // process.env.HOME once the process is running.
  const homedirSpy = spyOn(os, "homedir").mockReturnValue(home);

  mkdirSync(projectDir, { recursive: true });
  for (const id of ["one", "two"]) {
    writeFileSync(
      join(projectDir, `${id}.jsonl`),
      `${JSON.stringify({ type: "user", message: { role: "user", content: `prompt ${id}` } })}\n`,
    );
  }

  afterAll(() => {
    homedirSpy.mockRestore();
    rmSync(home, { recursive: true, force: true });
  });

  test("extracts every title by default", () => {
    const sessions = discoverSessions(cwd);
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.firstPrompt?.startsWith("prompt "))).toBe(true);
  });

  test("skips extraction when the predicate declines, still listing the session", () => {
    const sessions = discoverSessions(cwd, { needsTitle: () => false });
    expect(sessions).toHaveLength(2);
    // firstPrompt undefined signals "unchanged" — the caller keeps the stored
    // title rather than overwriting it with nothing.
    expect(sessions.every((s) => s.firstPrompt === undefined)).toBe(true);
  });

  test("extracts only for sessions the predicate selects", () => {
    const sessions = discoverSessions(cwd, { needsTitle: (id) => id === "two" });
    const byId = new Map(sessions.map((s) => [s.sessionId, s]));
    expect(byId.get("two")?.firstPrompt).toBe("prompt two");
    expect(byId.get("one")?.firstPrompt).toBeUndefined();
  });

  test("passes the session id and modified time to the predicate", () => {
    const seen: Array<[string, string]> = [];
    discoverSessions(cwd, {
      needsTitle: (id, modified) => {
        seen.push([id, modified]);
        return false;
      },
    });
    expect(seen).toHaveLength(2);
    for (const [, modified] of seen) expect(Number.isFinite(Date.parse(modified))).toBe(true);
  });
});
