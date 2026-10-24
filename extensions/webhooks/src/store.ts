/**
 * Webhook inbox (SQLite). Tables come from gateway migration 025-webhooks.sql.
 *
 * The store takes a Database so tests can hand it an in-memory one; the
 * extension opens ~/.anima/anima.db, resolved per call so ANIMA_DATA_DIR (set
 * by the test preload) is honoured.
 */

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

export type DeliveryStatus = "pending" | "delivered" | "failed";

export interface Delivery {
  id: string;
  hook: string;
  receivedAt: string;
  contentType: string | null;
  headers: Record<string, string>;
  body: string;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  deliveredAt: string | null;
}

interface DeliveryRow {
  id: string;
  hook: string;
  received_at: string;
  content_type: string | null;
  headers: string;
  body: string;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  delivered_at: string | null;
}

export interface NewDelivery {
  id: string;
  hook: string;
  receivedAt: string;
  contentType: string | null;
  headers: Record<string, string>;
  body: string;
}

export interface ListFilter {
  hook?: string;
  status?: DeliveryStatus;
  limit: number;
}

export function openAnimaDb(): Database {
  const dataDir = process.env.ANIMA_DATA_DIR || join(homedir(), ".anima");
  const db = new Database(join(dataDir, "anima.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

function toDelivery(row: DeliveryRow): Delivery {
  return {
    id: row.id,
    hook: row.hook,
    receivedAt: row.received_at,
    contentType: row.content_type,
    headers: JSON.parse(row.headers) as Record<string, string>,
    body: row.body,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    deliveredAt: row.delivered_at,
  };
}

export class WebhookStore {
  constructor(private readonly db: Database) {}

  insert(delivery: NewDelivery): void {
    this.db
      .query(
        `INSERT INTO webhook_deliveries
           (id, hook, received_at, content_type, headers, body, status, next_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        delivery.id,
        delivery.hook,
        delivery.receivedAt,
        delivery.contentType,
        JSON.stringify(delivery.headers),
        delivery.body,
        delivery.receivedAt,
      );
  }

  get(id: string): Delivery | null {
    const row = this.db
      .query<DeliveryRow, [string]>("SELECT * FROM webhook_deliveries WHERE id = ?")
      .get(id);
    return row ? toDelivery(row) : null;
  }

  list(filter: ListFilter): Delivery[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (filter.hook) {
      where.push("hook = ?");
      args.push(filter.hook);
    }
    if (filter.status) {
      where.push("status = ?");
      args.push(filter.status);
    }
    args.push(filter.limit);
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return this.db
      .query<DeliveryRow, Array<string | number>>(
        `SELECT * FROM webhook_deliveries ${clause} ORDER BY received_at DESC, id DESC LIMIT ?`,
      )
      .all(...args)
      .map(toDelivery);
  }

  /** Pending deliveries whose next attempt is due, oldest first. */
  due(now: string, limit: number): Delivery[] {
    return this.db
      .query<DeliveryRow, [string, number]>(
        `SELECT * FROM webhook_deliveries
         WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY next_attempt_at, received_at LIMIT ?`,
      )
      .all(now, limit)
      .map(toDelivery);
  }

  markDelivered(id: string, at: string): void {
    this.db
      .query(
        `UPDATE webhook_deliveries
         SET status = 'delivered', attempts = attempts + 1, delivered_at = ?,
             next_attempt_at = NULL, last_error = NULL
         WHERE id = ?`,
      )
      .run(at, id);
  }

  /** Record a failed attempt: retry at `nextAttemptAt`, or give up when it is null. */
  markAttemptFailed(id: string, error: string, nextAttemptAt: string | null): void {
    this.db
      .query(
        `UPDATE webhook_deliveries
         SET attempts = attempts + 1, last_error = ?, next_attempt_at = ?,
             status = CASE WHEN ? IS NULL THEN 'failed' ELSE 'pending' END
         WHERE id = ?`,
      )
      .run(error, nextAttemptAt, nextAttemptAt, id);
  }

  /** Queue a delivery again from scratch. Returns false if it does not exist. */
  requeue(id: string, now: string): boolean {
    const result = this.db
      .query(
        `UPDATE webhook_deliveries
         SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL,
             delivered_at = NULL
         WHERE id = ?`,
      )
      .run(now, id);
    return result.changes > 0;
  }

  /** Delete finished deliveries received before `cutoff`. Pending ones are kept. */
  prune(cutoff: string): number {
    return this.db
      .query("DELETE FROM webhook_deliveries WHERE status != 'pending' AND received_at < ?")
      .run(cutoff).changes;
  }

  counts(): Record<DeliveryStatus, number> {
    const counts: Record<DeliveryStatus, number> = { pending: 0, delivered: 0, failed: 0 };
    const rows = this.db
      .query<{ status: DeliveryStatus; n: number }, []>(
        "SELECT status, COUNT(*) AS n FROM webhook_deliveries GROUP BY status",
      )
      .all();
    for (const row of rows) counts[row.status] = row.n;
    return counts;
  }

  lastReceivedAt(hook: string): string | null {
    const row = this.db
      .query<{ at: string | null }, [string]>(
        "SELECT MAX(received_at) AS at FROM webhook_deliveries WHERE hook = ?",
      )
      .get(hook);
    return row?.at ?? null;
  }

  getSigningSecret(hook: string): string | null {
    const row = this.db
      .query<{ secret: string }, [string]>(
        "SELECT secret FROM webhook_signing_secrets WHERE hook = ?",
      )
      .get(hook);
    return row?.secret ?? null;
  }

  /** Store a learned secret. Returns false if one is already stored (never overwrites). */
  learnSigningSecret(hook: string, secret: string, at: string): boolean {
    const result = this.db
      .query(
        `INSERT INTO webhook_signing_secrets (hook, secret, learned_at) VALUES (?, ?, ?)
         ON CONFLICT(hook) DO NOTHING`,
      )
      .run(hook, secret, at);
    return result.changes > 0;
  }

  forgetSigningSecret(hook: string): boolean {
    return (
      this.db.query("DELETE FROM webhook_signing_secrets WHERE hook = ?").run(hook).changes > 0
    );
  }
}
