import { describe, expect, it } from "bun:test";
import { filterFiles } from "./FilePicker";

const files = [
  "packages/ui/src/components/InputArea.tsx",
  "packages/ui/src/components/CommandPicker.tsx",
  "packages/ui/src/components/FilePicker.tsx",
  "packages/ui/src/hooks/useFiles.ts",
  "packages/ui/src/hooks/useCommands.ts",
  "extensions/session/src/file-discovery.ts",
  "extensions/session/src/commands-discovery.ts",
  "README.md",
  "package.json",
];

describe("filterFiles", () => {
  it("returns first N entries when query is empty", () => {
    const result = filterFiles(files, "");
    expect(result.map((r) => r.path)).toEqual(files);
  });

  it("does single-token fuzzy match with VS-Code-style ranking", () => {
    const result = filterFiles(files, "input");
    expect(result[0].path).toBe("packages/ui/src/components/InputArea.tsx");
  });

  it("supports multi-token AND search (`input area`)", () => {
    const result = filterFiles(files, "input area");
    const paths = result.map((r) => r.path);
    expect(paths).toContain("packages/ui/src/components/InputArea.tsx");
    // Files that match `input` but not `area` (none in this set) should not be included.
    // Files that don't match `input` at all (like CommandPicker) should not be included.
    expect(paths).not.toContain("packages/ui/src/components/CommandPicker.tsx");
  });

  it("excludes paths that match only some tokens (AND, not OR)", () => {
    // `useFiles.ts` matches `use` and `files` and `ts` — included.
    // `package.json` matches none of `use files ts` — excluded.
    const result = filterFiles(files, "use files ts");
    const paths = result.map((r) => r.path);
    expect(paths).toContain("packages/ui/src/hooks/useFiles.ts");
    expect(paths).not.toContain("package.json");
    expect(paths).not.toContain("README.md");
  });

  it("returns empty when no path matches all tokens", () => {
    expect(filterFiles(files, "nonexistent input")).toEqual([]);
  });

  it("collapses consecutive whitespace in the query", () => {
    const single = filterFiles(files, "input area");
    const padded = filterFiles(files, "  input    area  ");
    expect(padded.map((r) => r.path)).toEqual(single.map((r) => r.path));
  });

  it("unions match indices across tokens for highlighting", () => {
    const result = filterFiles(files, "input area");
    const inputArea = result.find((r) => r.path.endsWith("InputArea.tsx"))!;
    expect(inputArea.matchIndices.length).toBeGreaterThan(0);
    // Indices should be sorted ascending (we render highlights in document order).
    const sorted = inputArea.matchIndices.toSorted((a, b) => a - b);
    expect([...inputArea.matchIndices]).toEqual(sorted);
  });
});
