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
  emitActivity,
  forgetActivity,
  reconcileInFlightStatuses,
  SESSION_ACTIVITY,
  SESSION_LIST_CHANGED,
  SESSION_STATUS_CHANGED,
  type SessionActivityPayload,
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
  const lastActivity = (): SessionActivityPayload =>
    emittedOfType(SESSION_ACTIVITY).at(-1)?.payload as SessionActivityPayload;

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
    // Both fixtures are seeded here, not inside the tests that use them.
    // `bunfig.toml` points the whole run at one `ANIMA_DATA_DIR`, so the
    // database outlives each test, so the seed has to state `idle` explicitly:
    // an upsert that omits a runtime status now *preserves* the existing one
    // (see `upsertSession`), and a session left `running` by an earlier test
    // would otherwise be counted by the startup reconcile.
    forgetActivity("ses_status");
    forgetActivity("ses_alive");
    for (const id of ["ses_status", "ses_alive"]) {
      upsertSession({
        id,
        workspaceId,
        providerSessionId: id,
        model: "claude-opus-5",
        agent: "claude",
        purpose: "chat",
        runtimeStatus: "idle",
      });
    }
  });

  afterEach(() => {
    resetRuntime();
    closeSessionDb();
    homedirSpy.mockRestore();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  describe("the activity heartbeat", () => {
    // The premise of #2: `status_changed` is an edge, and an edge is only as
    // reliable as the delivery of one message. A tab that missed it showed a
    // resting row for a working session until the next sixty-second poll.
    // These tests pin the two properties that make the heartbeat worth its
    // traffic — it repeats, and it is cheap.

    it("re-asserts a running session without a transition", () => {
      applyRuntimeStatus("ses_status", "running");
      forgetActivity("ses_status");
      emitActivity("ses_status");

      expect(lastActivity()).toMatchObject({
        sessionId: "ses_status",
        workspaceId,
        runtimeStatus: "running",
        disposition: "open",
      });
      // The whole point: no transition happened, so nothing else fired.
      expect(emittedOfType(SESSION_STATUS_CHANGED)).toHaveLength(1);
    });

    it("throttles repeats, so a turn's tokens don't each become a message", () => {
      forgetActivity("ses_status");
      emitActivity("ses_status");
      for (let i = 0; i < 50; i++) emitActivity("ses_status");
      expect(emittedOfType(SESSION_ACTIVITY)).toHaveLength(1);
    });

    it("never throttles a transition — that's how a spinner stops", () => {
      forgetActivity("ses_status");
      emitActivity("ses_status");
      // Back to back with the beat above, so only `force` can get this out.
      applyRuntimeStatus("ses_status", "completed");
      expect(lastActivity().runtimeStatus).toBe("completed");
      expect(emittedOfType(SESSION_ACTIVITY)).toHaveLength(2);
    });

    it("carries the name, so a session titled from its first prompt updates live", () => {
      upsertSession({
        id: "ses_status",
        workspaceId,
        providerSessionId: "ses_status",
        model: "claude-opus-5",
        agent: "claude",
        purpose: "chat",
        metadata: { firstPrompt: "add icons to the active pane" },
      });
      forgetActivity("ses_status");
      emitActivity("ses_status");
      expect(lastActivity()).toMatchObject({
        title: null,
        firstPrompt: "add icons to the active pane",
      });
    });

    it("says nothing for a session it has no row for", () => {
      emitActivity("ses_missing");
      expect(emittedOfType(SESSION_ACTIVITY)).toHaveLength(0);
    });

    it("reads the row rather than trusting a caller's idea of the status", () => {
      applyRuntimeStatus("ses_status", "failed");
      forgetActivity("ses_status");
      emitActivity("ses_status");
      expect(lastActivity().runtimeStatus).toBe("failed");
    });
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

  // The live database had four sessions permanently marked `running` before
  // this existed — each one a turn that died with the extension.
  describe("reconcile against ground truth", () => {
    /** Nothing alive at all. */
    const nothingLive = {
      running: new Set<string>(),
      turnActive: new Set<string>(),
      turnStateUnknown: new Set<string>(),
    };
    const live = (opts: { running?: string[]; turnActive?: string[]; unknown?: string[] }) => ({
      running: new Set(opts.running ?? []),
      turnActive: new Set(opts.turnActive ?? []),
      turnStateUnknown: new Set(opts.unknown ?? []),
    });

    it("stalls in-flight rows with no live process, and spares the ones mid-turn", () => {
      applyRuntimeStatus("ses_status", "running");
      applyRuntimeStatus("ses_alive", "running");
      emitted = [];

      expect(
        reconcileInFlightStatuses(live({ running: ["ses_alive"], turnActive: ["ses_alive"] })),
      ).toBe(1);
      expect(getStoredSession("ses_status")?.runtimeStatus).toBe("stalled");
      expect(getStoredSession("ses_alive")?.runtimeStatus).toBe("running");

      // The correction is a real transition, so the tabs hear about it.
      expect(emittedOfType(SESSION_STATUS_CHANGED)).toHaveLength(1);
      expect(lastStatus()).toMatchObject({ sessionId: "ses_status", runtimeStatus: "stalled" });
    });

    // The case the process check alone could never catch, and the one a human
    // notices: the session is up and answering, but its turn ended without the
    // transition reaching us. A live process is not a live turn.
    it("retires a running claim on a session that is alive but idle", () => {
      applyRuntimeStatus("ses_alive", "running");
      expect(reconcileInFlightStatuses(live({ running: ["ses_alive"] }))).toBe(1);
      // `idle`, not `stalled` — nothing is wrong, there's just no turn.
      expect(getStoredSession("ses_alive")?.runtimeStatus).toBe("idle");
    });

    it("says nothing about a provider that can't report its turn state", () => {
      applyRuntimeStatus("ses_alive", "running");
      expect(
        reconcileInFlightStatuses(live({ running: ["ses_alive"], unknown: ["ses_alive"] })),
      ).toBe(0);
      expect(getStoredSession("ses_alive")?.runtimeStatus).toBe("running");
    });

    // A sweep that only retires claims leaves the opposite error standing: a
    // row at rest while a turn is genuinely running, which is what a missed
    // *opening* transition looks like. Ground truth has to be believed both
    // ways or the column only self-heals downward.
    it("promotes a resting row when a turn is genuinely in flight", () => {
      applyRuntimeStatus("ses_status", "completed");
      expect(
        reconcileInFlightStatuses(live({ running: ["ses_status"], turnActive: ["ses_status"] })),
      ).toBe(1);
      expect(getStoredSession("ses_status")?.runtimeStatus).toBe("running");
    });

    it("leaves resting states alone", () => {
      applyRuntimeStatus("ses_status", "completed");
      expect(reconcileInFlightStatuses(nothingLive)).toBe(0);
      expect(getStoredSession("ses_status")?.runtimeStatus).toBe("completed");
    });

    it("clears the awaiting states too — they also claim a live turn", () => {
      applyRuntimeStatus("ses_status", "awaiting_approval");
      expect(reconcileInFlightStatuses(nothingLive)).toBe(1);
      expect(getStoredSession("ses_status")?.runtimeStatus).toBe("stalled");
    });
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
