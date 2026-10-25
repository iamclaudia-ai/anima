import { describe, expect, it } from "bun:test";
import type { ExtensionContext } from "@anima/shared";
import { notifyTransition, previousOutcome, transitionFor } from "./failure-notify";

describe("transitionFor", () => {
  it("reports the first failure", () => {
    expect(transitionFor(undefined, "error")).toBe("failed");
    expect(transitionFor("success", "error")).toBe("failed");
  });

  it("stays quiet while a task keeps failing", () => {
    expect(transitionFor("error", "error")).toBeNull();
  });

  it("reports recovery, and nothing for a healthy streak", () => {
    expect(transitionFor("error", "success")).toBe("recovered");
    expect(transitionFor("success", "success")).toBeNull();
    expect(transitionFor(undefined, "success")).toBeNull();
  });

  it("ignores runs that never finished", () => {
    expect(transitionFor("skipped", "error")).toBe("failed");
    expect(transitionFor("running", "success")).toBeNull();
  });
});

describe("previousOutcome", () => {
  it("skips the current run and unfinished runs", () => {
    const history = [
      { id: "now", status: "error" },
      { id: "a", status: "skipped" },
      { id: "b", status: "running" },
      { id: "c", status: "error" },
      { id: "d", status: "success" },
    ];
    expect(previousOutcome(history, "now")).toBe("error");
    expect(previousOutcome([{ id: "now", status: "error" }], "now")).toBeUndefined();
  });
});

describe("notifyTransition", () => {
  function ctxWith(onCall: (method: string, params: Record<string, unknown>) => unknown) {
    const warnings: string[] = [];
    const ctx = {
      call: async (method: string, params: Record<string, unknown> = {}) => onCall(method, params),
      log: { info() {}, warn: (m: string) => warnings.push(m), error() {}, debug() {} },
    } as unknown as ExtensionContext;
    return { ctx, warnings };
  }

  it("sends the first line of the error and how to see the rest", async () => {
    const sent: Record<string, unknown>[] = [];
    const { ctx } = ctxWith((_m, p) => sent.push(p));
    await notifyTransition(
      ctx,
      { id: "t1", name: "morning-flight" },
      "failed",
      'Error: Process exited with code 1\nerror: Module not found "flight.ts"',
    );
    expect(sent[0]).toMatchObject({ title: "Task failed", source: "scheduler" });
    expect(String(sent[0]?.message)).toBe(
      'Scheduled task "morning-flight" failed: Process exited with code 1\nanima scheduler get_history --taskId t1',
    );
  });

  it("never throws when notify is unavailable", async () => {
    const { ctx, warnings } = ctxWith(() => {
      throw new Error("Unknown method: notify.send");
    });
    await notifyTransition(ctx, { id: "t1", name: "x" }, "recovered");
    expect(warnings).toEqual(["Could not send task notification"]);
  });
});
