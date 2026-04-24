import { describe, expect, it } from "bun:test";
import { extractRecoveredLibbyResponse } from "./libby";

describe("extractRecoveredLibbyResponse", () => {
  it("returns the latest assistant text response", () => {
    const result = extractRecoveredLibbyResponse([
      {
        role: "user",
        blocks: [{ type: "text", content: "Process this transcript" }],
      },
      {
        role: "assistant",
        blocks: [
          { type: "thinking", content: "planning" },
          { type: "text", content: "SUMMARY: captured the main points" },
        ],
      },
    ]);

    expect(result).toBe("SUMMARY: captured the main points");
  });

  it("prefers the most recent assistant text block set", () => {
    const result = extractRecoveredLibbyResponse([
      {
        role: "assistant",
        blocks: [{ type: "text", content: "older" }],
      },
      {
        role: "assistant",
        blocks: [{ type: "tool_use" }, { type: "text", content: "SKIP: duplicate transcript" }],
      },
    ]);

    expect(result).toBe("SKIP: duplicate transcript");
  });

  it("returns null when there is no assistant text to recover", () => {
    const result = extractRecoveredLibbyResponse([
      {
        role: "assistant",
        blocks: [{ type: "tool_use" }],
      },
    ]);

    expect(result).toBeNull();
  });
});
