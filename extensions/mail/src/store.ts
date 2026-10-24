/**
 * Announced-message ledger (gateway migration 026-mail.sql).
 *
 * Takes a Database so tests can pass an in-memory one; production opens
 * ~/.anima/anima.db, resolved per call so ANIMA_DATA_DIR is honoured.
 */

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SeenMessage {
  messageId: string;
  folderId: string;
  threadId: string | null;
  fromAddress: string;
  sender: string | null;
  subject: string | null;
  receivedAt: string;
  source: "webhook" | "reconcile";
  firstSeenAt: string;
}

interface SeenRow {
  message_id: string;
  folder_id: string;
  thread_id: string | null;
  from_address: string;
  sender: string | null;
  subject: string | null;
  received_at: string;
  source: "webhook" | "reconcile";
  first_seen_at: string;
}

export function openAnimaDb(): Database {
  const dataDir = process.env.ANIMA_DATA_DIR || join(homedir(), ".anima");
  const db = new Database(join(dataDir, "anima.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

export class MailStore {
  constructor(private readonly db: Database) {}

  /** Record a message. Returns false if it was already recorded (not new). */
  recordSeen(message: SeenMessage): boolean {
    const result = this.db
      .query(
        `INSERT INTO mail_messages
           (message_id, folder_id, thread_id, from_address, sender, subject, received_at, source, first_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(message_id) DO NOTHING`,
      )
      .run(
        message.messageId,
        message.folderId,
        message.threadId,
        message.fromAddress,
        message.sender,
        message.subject,
        message.receivedAt,
        message.source,
        message.firstSeenAt,
      );
    return result.changes > 0;
  }

  get(messageId: string): SeenMessage | null {
    const row = this.db
      .query<SeenRow, [string]>("SELECT * FROM mail_messages WHERE message_id = ?")
      .get(messageId);
    if (!row) return null;
    return {
      messageId: row.message_id,
      folderId: row.folder_id,
      threadId: row.thread_id,
      fromAddress: row.from_address,
      sender: row.sender,
      subject: row.subject,
      receivedAt: row.received_at,
      source: row.source,
      firstSeenAt: row.first_seen_at,
    };
  }

  /** Keep the known folder current after a move or archive. */
  updateFolder(messageId: string, folderId: string): void {
    this.db
      .query("UPDATE mail_messages SET folder_id = ? WHERE message_id = ?")
      .run(folderId, messageId);
  }

  count(): number {
    return (
      this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM mail_messages").get()?.n ?? 0
    );
  }

  lastSeenAt(): string | null {
    return (
      this.db
        .query<{ at: string | null }, []>("SELECT MAX(first_seen_at) AS at FROM mail_messages")
        .get()?.at ?? null
    );
  }
}
