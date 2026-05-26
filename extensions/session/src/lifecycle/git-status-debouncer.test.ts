import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as store from "../session-store";
import * as events from "./session-events";
import {
  cancelPendingGitStatus,
  dropGitStatusDebounce,
  isMutatingTool,
  noteToolResult,
  noteToolUseStart,
  setGitStatusDebounceMs,
} from "./git-status-debouncer";

describe("git-status-debouncer", () => {
  let emitSpy: ReturnType<typeof spyOn>;
  let storeSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setGitStatusDebounceMs(10);
    emitSpy = spyOn(events, "emitGitStatus").mockImplementation(mock(() => Promise.resolve()));
    storeSpy = spyOn(store, "getStoredSession").mockReturnValue(null);
  });

  afterEach(() => {
    emitSpy.mockRestore();
    storeSpy.mockRestore();
    dropGitStatusDebounce("s1");
    dropGitStatusDebounce("s2");
    dropGitStatusDebounce("parent");
    setGitStatusDebounceMs(500);
  });

  const flush = () => new Promise((r) => setTimeout(r, 25));

  it("identifies mutating tools (whitelist)", () => {
    expect(isMutatingTool("Edit")).toBe(true);
    expect(isMutatingTool("Write")).toBe(true);
    expect(isMutatingTool("MultiEdit")).toBe(true);
    expect(isMutatingTool("NotebookEdit")).toBe(true);
    expect(isMutatingTool("Bash")).toBe(true);
    expect(isMutatingTool("Read")).toBe(false);
    expect(isMutatingTool("Grep")).toBe(false);
    expect(isMutatingTool("TodoWrite")).toBe(false);
  });

  it("does not emit for read-only tool results", async () => {
    noteToolUseStart("s1", "use-1", "Read");
    noteToolResult("s1", "use-1");
    await flush();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("emits once after a mutating tool result, debounced", async () => {
    noteToolUseStart("s1", "use-1", "Edit");
    noteToolResult("s1", "use-1");
    expect(emitSpy).not.toHaveBeenCalled();
    await flush();
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith("s1");
  });

  it("coalesces a burst of mutating results into a single emit", async () => {
    noteToolUseStart("s1", "use-1", "Edit");
    noteToolUseStart("s1", "use-2", "Write");
    noteToolUseStart("s1", "use-3", "Edit");
    noteToolResult("s1", "use-1");
    noteToolResult("s1", "use-2");
    noteToolResult("s1", "use-3");
    await flush();
    expect(emitSpy).toHaveBeenCalledTimes(1);
  });

  it("propagates to parent session for subagent edits", async () => {
    storeSpy.mockImplementation((id: string) =>
      id === "s1"
        ? ({ parentSessionId: "parent" } as ReturnType<typeof store.getStoredSession>)
        : null,
    );
    noteToolUseStart("s1", "use-1", "Edit");
    noteToolResult("s1", "use-1");
    await flush();
    expect(emitSpy).toHaveBeenCalledWith("s1");
    expect(emitSpy).toHaveBeenCalledWith("parent");
    expect(emitSpy).toHaveBeenCalledTimes(2);
  });

  it("cancelPendingGitStatus prevents the scheduled emit", async () => {
    noteToolUseStart("s1", "use-1", "Bash");
    noteToolResult("s1", "use-1");
    cancelPendingGitStatus("s1");
    await flush();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("ignores tool_result for an unknown id", async () => {
    noteToolResult("s1", "never-tracked");
    await flush();
    expect(emitSpy).not.toHaveBeenCalled();
  });
});
