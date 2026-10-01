import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { isWorkspaceExcluded, shouldExcludeFile } from "./ingest";

describe("ingest exclude matching", () => {
  const basePath = `${homedir()}/.claude/projects`;
  const libbyFile = `${basePath}/-Users-michael-libby/abcd.jsonl`;
  const swarmFile = `${basePath}/-Users-michael-Projects-beehiiv-swarm/xyz.jsonl`;

  it("matches relative file-key prefix excludes", () => {
    expect(shouldExcludeFile(libbyFile, basePath, ["-Users-michael-libby/"])).toBe(true);
    expect(shouldExcludeFile(swarmFile, basePath, ["-Users-michael-libby/"])).toBe(false);
  });

  it("matches absolute excludes", () => {
    expect(shouldExcludeFile(libbyFile, basePath, [`${basePath}/-Users-michael-libby`])).toBe(true);
    expect(shouldExcludeFile(swarmFile, basePath, [`${basePath}/-Users-michael-libby`])).toBe(
      false,
    );
  });

  it("matches home-relative absolute excludes", () => {
    expect(
      shouldExcludeFile(libbyFile, basePath, ["~/.claude/projects/-Users-michael-libby"]),
    ).toBe(true);
  });
});

describe("workspace exclude matching", () => {
  const basePath = `${homedir()}/.claude/projects`;

  it("excludes a workspace whose project dir matches a relative pattern", () => {
    expect(isWorkspaceExcluded("/Users/michael/libby", basePath, ["-Users-michael-libby/"])).toBe(
      true,
    );
  });

  it("leaves other workspaces alone, including ones sharing a name prefix", () => {
    const exclude = ["-Users-michael-libby/"];
    expect(isWorkspaceExcluded("/Users/michael/Projects/anima", basePath, exclude)).toBe(false);
    expect(isWorkspaceExcluded("/Users/michael/libby-archive", basePath, exclude)).toBe(false);
  });

  it("encodes dots the way Claude Code does", () => {
    expect(
      isWorkspaceExcluded("/Users/michael/.anima/work", basePath, ["-Users-michael--anima-work/"]),
    ).toBe(true);
  });

  it("matches absolute and home-relative patterns", () => {
    expect(
      isWorkspaceExcluded("/Users/michael/libby", basePath, [`${basePath}/-Users-michael-libby`]),
    ).toBe(true);
    expect(
      isWorkspaceExcluded("/Users/michael/libby", basePath, [
        "~/.claude/projects/-Users-michael-libby",
      ]),
    ).toBe(true);
  });

  it("excludes nothing when there are no patterns", () => {
    expect(isWorkspaceExcluded("/Users/michael/libby", basePath, [])).toBe(false);
  });
});
