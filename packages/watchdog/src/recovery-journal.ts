import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { RECOVERY_JOURNAL_FILE } from "./constants";

export interface RecoveryJournalEntry {
  timestamp: string;
  serviceId: string;
  servicePid?: number | null;
  incidentId?: string;
  attemptId?: string | null;
  event:
    | "health_check_failed"
    | "memory_stale_lock_detected"
    | "restart_requested"
    | "restart_completed"
    | "health_restored";
  reason?: string | null;
  decision?: {
    action:
      | "observe"
      | "restart_service"
      | "restart_extension"
      | "wait_for_health_restore"
      | "no_action";
    target?: string | null;
    triggerThreshold?: number | null;
  };
  outcome?: "recovered" | "recovered_after_restart" | "restart_in_progress" | "observed";
  durations?: {
    incidentMs?: number;
    restartRequestedMs?: number;
    restartCompletedMs?: number;
    recoveryMs?: number;
  };
  evidence?: {
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
  };
  details?: Record<string, unknown>;
}

export function recordRecoveryEvent(entry: RecoveryJournalEntry): void {
  try {
    const dir = dirname(RECOVERY_JOURNAL_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(RECOVERY_JOURNAL_FILE, `${JSON.stringify(entry)}\n`);
  } catch {
    // Never let journal writes break recovery.
  }
}
