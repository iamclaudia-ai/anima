import { afterEach, describe, expect, it } from "bun:test";
import { getStatus } from "./status";
import { services } from "./services";

const gateway = services.gateway;
const originalActiveIncident = gateway?.activeIncident;
const originalProc = gateway?.proc;
const originalConsecutiveFailures = gateway?.consecutiveFailures;
const originalLastHealthReason = gateway?.lastHealthReason;
const originalLastHealthDetails = gateway?.lastHealthDetails;
const originalHistory = gateway?.history ? [...gateway.history] : [];
const originalLastRestart = gateway?.lastRestart;

afterEach(() => {
  if (!gateway) return;
  gateway.activeIncident = originalActiveIncident ?? null;
  gateway.proc = originalProc ?? null;
  gateway.consecutiveFailures = originalConsecutiveFailures ?? 0;
  gateway.lastHealthReason = originalLastHealthReason ?? null;
  gateway.lastHealthDetails = originalLastHealthDetails ?? null;
  gateway.history = [...originalHistory];
  gateway.lastRestart = originalLastRestart ?? 0;
});

describe("watchdog status", () => {
  it("surfaces correlated incident metadata", async () => {
    if (!gateway) throw new Error("gateway service missing");

    gateway.proc = { pid: 12345, exitCode: null } as typeof gateway.proc;
    gateway.consecutiveFailures = 2;
    gateway.lastRestart = Date.now() - 10_000;
    gateway.lastHealthReason = "zero_extensions";
    gateway.lastHealthDetails = {
      extensionCount: 0,
    };
    gateway.activeIncident = {
      key: "gateway:zero_extensions",
      incidentId: "incident-123",
      reason: "zero_extensions",
      openedAt: Date.now() - 15_000,
      firstEvidence: {
        extensionCount: 0,
      },
      restartRequestedAt: Date.now() - 8_000,
      restartCompletedAt: Date.now() - 4_000,
      restartAttemptId: "attempt-456",
    };

    const status = await getStatus();
    expect(status.gateway).toMatchObject({
      pid: 12345,
      consecutiveFailures: 2,
      lastHealthReason: "zero_extensions",
      activeIncident: {
        incidentId: "incident-123",
        reason: "zero_extensions",
        restartAttemptId: "attempt-456",
      },
    });
  });
});
