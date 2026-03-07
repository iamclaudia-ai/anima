import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { shouldExcludeFile } from "./ingest";

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
