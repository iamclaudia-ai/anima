/**
 * The live-status funnel.
 *
 * These tests care about one thing above all: that an event goes out exactly
 * when the state moved and not otherwise. `applyRuntimeStatus` sits on the
 * per-streamed-event path, so an emit that fires on every call would put a
 * bus message behind every token — which is the failure mode that would make
 * the whole feature worse than the snapshot it replaces.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import { closeSessionDb, getStoredSession, upsertSession } from "./session-store";
import { initRuntime, resetRuntime, type SessionRuntime } from "./runtime";
import {
  applyDisposition,
  applyRuntimeStatus,
  emitListChanged,
  emitStatusChanged,
  SESSION_LIST_CHANGED,
  SESSION_STATUS_CHANGED,
  type SessionStatusChangedPayload,
} from "./session-status-events";
import { createWorkspace } from "./workspace";

describe("session status events", () => {
  let tmpHome: string;
  let homedirSpy: ReturnType<typeof spyOn>;
  let originalHome: string | undefined;
  let emitted: Array<{ event: string; payload: unknown }>;
  let workspaceId: string;

  const emittedOfType = (event: string) => emitted.filter((e) => e.event === event);
  const lastStatus = (): SessionStatusChangedPayload =>
    emittedOfType(SESSION_STATUS_CHANGED).at(-1)?.payload as SessionStatusChangedPayload;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(os.tmpdir(), "anima-status-events-"));
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
    homedirSpy = spyOn(os, "homedir").mockReturnValue(tmpHome);

    emitted = [];
    // Only `ctx.emit` is exercised here; the rest of the runtime is never
    // reached, so a partial stub is honest rather than lazy.
    initRuntime({
      ctx: {
        emit: (event: string, payload: unknown) => {
          emitted.push({ event, payload });
        },
      },
    } as unknown as SessionRuntime);

    const workspace = createWorkspace({ name: "status", cwd: join(tmpHome, "proj") });
    workspaceId = workspace.id;
    upsertSession({
      id: "ses_status",
      workspaceId,
      providerSessionId: "ses_status",
      model: "claude-opus-5",
      agent: "claude",
      purpose: "chat",
    });
  });

  afterEach(() => {
    resetRuntime();
    closeSessionDb();
    homedirSpy.mockRestore();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("emits once per real transition and not at all for a repeat", () => {
    expect(applyRuntimeStatus("ses_status", "running")).toBe(true);
    expect(applyRuntimeStatus("ses_status", "running")).toBe(false);
    expect(applyRuntimeStatus("ses_status", "awaiting_input")).toBe(true);

    const events = emittedOfType(SESSION_STATUS_CHANGED);
    expect(events).toHaveLength(2);
    expect(lastStatus()).toMatchObject({
      sessionId: "ses_status",
      workspaceId,
      runtimeStatus: "awaiting_input",
      previousRuntimeStatus: "running",
      disposition: "open",
    });
  });

  it("carries the workspace cwd so a tab can refetch without a lookup", () => {
    applyRuntimeStatus("ses_status", "running");
    expect(lastStatus().cwd).toBe(join(tmpHome, "proj"));
  });

  it("writes the metadata patch and still reports the transition", () => {
    expect(
      applyRuntimeStatus("ses_status", "completed", {
        metadataPatch: { lastAssistantMessageAt: "2026-08-15T00:00:00.000Z" },
      }),
    ).toBe(true);

    const stored = getStoredSession("ses_status");
    expect(stored?.runtimeStatus).toBe("completed");
    expect(stored?.metadata?.lastAssistantMessageAt).toBe("2026-08-15T00:00:00.000Z");
    expect(emittedOfType(SESSION_STATUS_CHANGED)).toHaveLength(1);
  });

  it("emits both events for a disposition change, since it can hide the row", () => {
    expect(applyDisposition("ses_status", "resolved")).toBe(true);

    expect(emittedOfType(SESSION_STATUS_CHANGED)).toHaveLength(1);
    expect(lastStatus()).toMatchObject({
      disposition: "resolved",
      previousDisposition: "open",
    });

    const listEvents = emittedOfType(SESSION_LIST_CHANGED);
    expect(listEvents).toHaveLength(1);
    expect(listEvents[0]?.payload).toMatchObject({
      workspaceId,
      reason: "disposition_changed",
    });
  });

  it("stays quiet when a disposition is set to what it already is", () => {
    applyDisposition("ses_status", "blocked");
    emitted = [];
    expect(applyDisposition("ses_status", "blocked")).toBe(false);
    expect(emitted).toHaveLength(0);
  });

  // The lifecycle legitimately sees events for sessions the reconciler hasn't
  // upserted yet. That's a missed event on a row nothing renders, not a crash.
  it("reports a miss for an unknown session rather than throwing", () => {
    expect(emitStatusChanged("ses_nope")).toBe(false);
    expect(applyRuntimeStatus("ses_nope", "running")).toBe(false);
    expect(emitted).toHaveLength(0);
  });

  it("survives a bus that throws", () => {
    resetRuntime();
    initRuntime({
      ctx: {
        emit: () => {
          throw new Error("bus is down");
        },
      },
    } as unknown as SessionRuntime);

    // The DB write is the durable half; losing the announcement leaves a tab
    // stale until its next refetch, which is strictly better than throwing out
    // of the lifecycle path.
    expect(() => applyRuntimeStatus("ses_status", "running")).not.toThrow();
    expect(getStoredSession("ses_status")?.runtimeStatus).toBe("running");
    expect(() => emitListChanged(workspaceId, "reconciled")).not.toThrow();
  });
});
