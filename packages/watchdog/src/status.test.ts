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
    gateway.lastHealthReason = "memory_stale_lock";
    gateway.lastHealthDetails = {
      memoryLock: {
        extensionId: "memory",
        stale: true,
      },
    };
    gateway.activeIncident = {
      key: "gateway:memory_stale_lock",
      incidentId: "incident-123",
      reason: "memory_stale_lock",
      openedAt: Date.now() - 15_000,
      firstEvidence: {
        memoryLock: {
          extensionId: "memory",
          stale: true,
        },
      },
      restartRequestedAt: Date.now() - 8_000,
      restartCompletedAt: Date.now() - 4_000,
      restartAttemptId: "attempt-456",
    };

    const status = await getStatus();
    expect(status.gateway).toMatchObject({
      pid: 12345,
      consecutiveFailures: 2,
      lastHealthReason: "memory_stale_lock",
      activeIncident: {
        incidentId: "incident-123",
        reason: "memory_stale_lock",
        restartAttemptId: "attempt-456",
      },
    });
  });
});
