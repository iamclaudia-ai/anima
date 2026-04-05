/**
 * Status aggregation — composes service health into a single status object.
 */

import { HEALTH_HISTORY_SIZE } from "./constants";
import { services, isProcessAlive, checkHealth } from "./services";

export async function getStatus(): Promise<Record<string, unknown>> {
  const status: Record<string, unknown> = {};

  for (const [id, service] of Object.entries(services)) {
    const processAlive = isProcessAlive(service);
    const health = processAlive ? await checkHealth(service) : { healthy: false, reason: "dead" };
    const healthy = health.healthy;
    status[id] = {
      name: service.name,
      pid: service.proc?.pid ?? null,
      processAlive,
      healthy,
      healthReason: health.reason ?? null,
      healthDetails: service.lastHealthDetails ?? null,
      consecutiveFailures: service.consecutiveFailures,
      activeIncident: service.activeIncident
        ? {
            incidentId: service.activeIncident.incidentId,
            reason: service.activeIncident.reason,
            openedAt: new Date(service.activeIncident.openedAt).toISOString(),
            restartAttemptId: service.activeIncident.restartAttemptId ?? null,
            restartRequestedAt: service.activeIncident.restartRequestedAt
              ? new Date(service.activeIncident.restartRequestedAt).toISOString()
              : null,
            restartCompletedAt: service.activeIncident.restartCompletedAt
              ? new Date(service.activeIncident.restartCompletedAt).toISOString()
              : null,
          }
        : null,
      lastRestart: service.lastRestart ? new Date(service.lastRestart).toISOString() : null,
      lastHealthReason: service.lastHealthReason ?? null,
      history: service.history.slice(-HEALTH_HISTORY_SIZE),
    };
  }

  return status;
}
