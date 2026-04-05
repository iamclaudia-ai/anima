import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { RECOVERY_JOURNAL_FILE } from "./constants";

export interface RecoveryJournalEntry {
  timestamp: string;
  serviceId: string;
  event:
    | "health_check_failed"
    | "memory_stale_lock_detected"
    | "restart_requested"
    | "restart_completed"
    | "health_restored";
  reason?: string | null;
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
