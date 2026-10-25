/**
 * Support desk storage (gateway migration 029-support.sql).
 *
 * Takes a Database so tests can pass an in-memory one; production opens
 * ~/.anima/anima.db, resolved per call so ANIMA_DATA_DIR is honoured.
 */

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

export const TICKET_STATUSES = [
  "new",
  "triaged",
  "in_progress",
  "waiting",
  "fixed",
  "closed",
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const OPEN_STATUSES: TicketStatus[] = ["new", "triaged", "in_progress", "waiting"];

export const PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const REPORT_SOURCES = ["email", "sentry", "forum", "github", "manual"] as const;
export type ReportSource = (typeof REPORT_SOURCES)[number];

export const LINK_KINDS = ["issue", "pr", "session", "sentry", "other"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export interface Ticket {
  id: number;
  workspaceId: string | null;
  workspaceName: string | null;
  title: string;
  summary: string | null;
  status: TicketStatus;
  priority: Priority;
  trusted: boolean;
  approved: boolean;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  reportCount: number;
  /** Reporters with an email address who haven't heard back, once it's fixed. */
  replyOwed: number;
}

export interface Report {
  id: number;
  ticketId: number;
  source: ReportSource;
  externalId: string | null;
  reporterName: string | null;
  reporterEmail: string | null;
  url: string | null;
  summary: string | null;
  trusted: boolean;
  receivedAt: string;
  repliedAt: string | null;
  createdAt: string;
}

export interface Link {
  id: number;
  ticketId: number;
  kind: LinkKind;
  ref: string;
  url: string | null;
  title: string | null;
  state: string;
  createdAt: string;
  updatedAt: string;
}

export interface Activity {
  id: number;
  ticketId: number;
  at: string;
  actor: string;
  kind: string;
  note: string | null;
}

export interface TicketDetail {
  ticket: Ticket;
  reports: Report[];
  links: Link[];
  activity: Activity[];
}

export interface NewTicket {
  workspaceId: string | null;
  title: string;
  summary?: string | null;
  priority?: Priority;
  trusted: boolean;
  actor: string;
}

export interface NewReport {
  source: ReportSource;
  externalId?: string | null;
  reporterName?: string | null;
  reporterEmail?: string | null;
  url?: string | null;
  summary?: string | null;
  trusted: boolean;
  receivedAt?: string | null;
}

export interface NewLink {
  kind: LinkKind;
  ref: string;
  url?: string | null;
  title?: string | null;
  state?: string;
}

export interface TicketChanges {
  title?: string;
  summary?: string | null;
  status?: TicketStatus;
  priority?: Priority;
  workspaceId?: string | null;
}

export type TicketFilter = "open" | "needs_reply" | "fixed" | "closed" | "all";

export function openAnimaDb(): Database {
  const dataDir = process.env.ANIMA_DATA_DIR || join(homedir(), ".anima");
  const db = new Database(join(dataDir, "anima.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

interface TicketRow {
  id: number;
  workspace_id: string | null;
  workspace_name: string | null;
  title: string;
  summary: string | null;
  status: TicketStatus;
  priority: Priority;
  trusted: number;
  approved: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  report_count: number;
  reply_owed: number;
}

interface ReportRow {
  id: number;
  ticket_id: number;
  source: ReportSource;
  external_id: string | null;
  reporter_name: string | null;
  reporter_email: string | null;
  url: string | null;
  summary: string | null;
  trusted: number;
  received_at: string;
  replied_at: string | null;
  created_at: string;
}

interface LinkRow {
  id: number;
  ticket_id: number;
  kind: LinkKind;
  ref: string;
  url: string | null;
  title: string | null;
  state: string;
  created_at: string;
  updated_at: string;
}

interface ActivityRow {
  id: number;
  ticket_id: number;
  at: string;
  actor: string;
  kind: string;
  note: string | null;
}

const TICKET_SELECT = `
  SELECT t.*, w.name AS workspace_name,
    (SELECT COUNT(*) FROM support_reports r WHERE r.ticket_id = t.id) AS report_count,
    CASE WHEN t.status = 'fixed' THEN
      (SELECT COUNT(*) FROM support_reports r
        WHERE r.ticket_id = t.id AND r.reporter_email IS NOT NULL AND r.replied_at IS NULL)
    ELSE 0 END AS reply_owed
  FROM support_tickets t
  LEFT JOIN workspaces w ON w.id = t.workspace_id`;

function toTicket(row: TicketRow): Ticket {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    title: row.title,
    summary: row.summary,
    status: row.status,
    priority: row.priority,
    trusted: row.trusted === 1,
    approved: row.approved === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    reportCount: row.report_count,
    replyOwed: row.reply_owed,
  };
}

function toReport(row: ReportRow): Report {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    source: row.source,
    externalId: row.external_id,
    reporterName: row.reporter_name,
    reporterEmail: row.reporter_email,
    url: row.url,
    summary: row.summary,
    trusted: row.trusted === 1,
    receivedAt: row.received_at,
    repliedAt: row.replied_at,
    createdAt: row.created_at,
  };
}

function toLink(row: LinkRow): Link {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    kind: row.kind,
    ref: row.ref,
    url: row.url,
    title: row.title,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toActivity(row: ActivityRow): Activity {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    at: row.at,
    actor: row.actor,
    kind: row.kind,
    note: row.note,
  };
}

const PRIORITY_ORDER =
  "CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END";

export class SupportStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private stamp(): string {
    return this.now().toISOString();
  }

  createTicket(input: NewTicket): Ticket {
    const at = this.stamp();
    const result = this.db
      .query(
        `INSERT INTO support_tickets
           (workspace_id, title, summary, priority, trusted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.workspaceId,
        input.title,
        input.summary ?? null,
        input.priority ?? "normal",
        input.trusted ? 1 : 0,
        at,
        at,
      );
    const id = Number(result.lastInsertRowid);
    this.addActivity(id, input.actor, "created", input.title);
    return this.requireTicket(id);
  }

  getTicket(id: number): Ticket | null {
    const row = this.db.query<TicketRow, [number]>(`${TICKET_SELECT} WHERE t.id = ?`).get(id);
    return row ? toTicket(row) : null;
  }

  requireTicket(id: number): Ticket {
    const ticket = this.getTicket(id);
    if (!ticket) throw new Error(`Unknown ticket #${id}`);
    return ticket;
  }

  getDetail(id: number): TicketDetail | null {
    const ticket = this.getTicket(id);
    if (!ticket) return null;
    return {
      ticket,
      reports: this.db
        .query<ReportRow, [number]>(
          "SELECT * FROM support_reports WHERE ticket_id = ? ORDER BY received_at, id",
        )
        .all(id)
        .map(toReport),
      links: this.linksFor(id),
      activity: this.db
        .query<ActivityRow, [number]>(
          "SELECT * FROM support_activity WHERE ticket_id = ? ORDER BY at, id",
        )
        .all(id)
        .map(toActivity),
    };
  }

  listTickets(options: { filter: TicketFilter; workspaceId?: string; limit: number }): Ticket[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    switch (options.filter) {
      case "open":
        where.push(`t.status IN (${OPEN_STATUSES.map(() => "?").join(", ")})`);
        args.push(...OPEN_STATUSES);
        break;
      case "needs_reply":
        where.push(
          `t.status = 'fixed' AND EXISTS (SELECT 1 FROM support_reports r WHERE r.ticket_id = t.id
             AND r.reporter_email IS NOT NULL AND r.replied_at IS NULL)`,
        );
        break;
      case "fixed":
      case "closed":
        where.push("t.status = ?");
        args.push(options.filter);
        break;
      case "all":
        break;
    }
    if (options.workspaceId) {
      where.push("t.workspace_id = ?");
      args.push(options.workspaceId);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    args.push(options.limit);
    return this.db
      .query<TicketRow, Array<string | number>>(
        `${TICKET_SELECT} ${clause} ORDER BY ${PRIORITY_ORDER}, t.created_at LIMIT ?`,
      )
      .all(...args)
      .map(toTicket);
  }

  updateTicket(id: number, changes: TicketChanges, actor: string): Ticket {
    const before = this.requireTicket(id);
    const sets: string[] = [];
    const args: Array<string | null> = [];
    const notes: string[] = [];
    const set = (column: string, value: string | null) => {
      sets.push(`${column} = ?`);
      args.push(value);
    };
    if (changes.title !== undefined && changes.title !== before.title) {
      set("title", changes.title);
      notes.push(`title → ${changes.title}`);
    }
    if (changes.summary !== undefined && changes.summary !== before.summary) {
      set("summary", changes.summary);
      notes.push("summary updated");
    }
    if (changes.priority !== undefined && changes.priority !== before.priority) {
      set("priority", changes.priority);
      notes.push(`priority ${before.priority} → ${changes.priority}`);
    }
    if (changes.workspaceId !== undefined && changes.workspaceId !== before.workspaceId) {
      set("workspace_id", changes.workspaceId);
      notes.push("project changed");
    }
    if (changes.status !== undefined && changes.status !== before.status) {
      set("status", changes.status);
      set("closed_at", changes.status === "closed" ? this.stamp() : null);
      notes.push(`status ${before.status} → ${changes.status}`);
    }
    if (sets.length === 0) return before;
    set("updated_at", this.stamp());
    this.db.query(`UPDATE support_tickets SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
    this.addActivity(id, actor, "updated", notes.join("; "));
    return this.requireTicket(id);
  }

  setStatus(id: number, status: TicketStatus, actor: string, note: string): Ticket {
    const before = this.requireTicket(id);
    if (before.status === status) return before;
    this.db
      .query("UPDATE support_tickets SET status = ?, closed_at = ?, updated_at = ? WHERE id = ?")
      .run(status, status === "closed" ? this.stamp() : null, this.stamp(), id);
    this.addActivity(id, actor, "status", `${before.status} → ${status}: ${note}`);
    return this.requireTicket(id);
  }

  approve(id: number, actor: string): Ticket {
    this.requireTicket(id);
    this.db
      .query("UPDATE support_tickets SET approved = 1, updated_at = ? WHERE id = ?")
      .run(this.stamp(), id);
    this.addActivity(id, actor, "approved", null);
    return this.requireTicket(id);
  }

  /** Add a report. Returns the existing one when this source/id is already on the ticket. */
  addReport(
    ticketId: number,
    input: NewReport,
    actor: string,
  ): { report: Report; created: boolean } {
    this.requireTicket(ticketId);
    if (input.externalId) {
      const existing = this.db
        .query<ReportRow, [number, string, string]>(
          "SELECT * FROM support_reports WHERE ticket_id = ? AND source = ? AND external_id = ?",
        )
        .get(ticketId, input.source, input.externalId);
      if (existing) return { report: toReport(existing), created: false };
    }
    const at = this.stamp();
    const result = this.db
      .query(
        `INSERT INTO support_reports
           (ticket_id, source, external_id, reporter_name, reporter_email, url, summary,
            trusted, received_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ticketId,
        input.source,
        input.externalId ?? null,
        input.reporterName ?? null,
        input.reporterEmail?.toLowerCase() ?? null,
        input.url ?? null,
        input.summary ?? null,
        input.trusted ? 1 : 0,
        input.receivedAt ?? at,
        at,
      );
    if (input.trusted) {
      this.db.query("UPDATE support_tickets SET trusted = 1 WHERE id = ?").run(ticketId);
    }
    this.db.query("UPDATE support_tickets SET updated_at = ? WHERE id = ?").run(at, ticketId);
    const who = input.reporterName ?? input.reporterEmail ?? input.source;
    this.addActivity(ticketId, actor, "report", `${input.source} report from ${who}`);
    const row = this.db
      .query<ReportRow, [number]>("SELECT * FROM support_reports WHERE id = ?")
      .get(Number(result.lastInsertRowid));
    if (!row) throw new Error("Report vanished after insert");
    return { report: toReport(row), created: true };
  }

  /** Tickets that already have a report with this source and external id. */
  ticketsForReport(source: ReportSource, externalId: string): number[] {
    return this.db
      .query<{ ticket_id: number }, [string, string]>(
        "SELECT DISTINCT ticket_id FROM support_reports WHERE source = ? AND external_id = ?",
      )
      .all(source, externalId)
      .map((r) => r.ticket_id);
  }

  markReplied(ticketId: number, reportIds: number[] | null, actor: string): number {
    this.requireTicket(ticketId);
    const at = this.stamp();
    const changed = reportIds
      ? reportIds.reduce(
          (n, id) =>
            n +
            this.db
              .query(
                "UPDATE support_reports SET replied_at = ? WHERE id = ? AND ticket_id = ? AND replied_at IS NULL",
              )
              .run(at, id, ticketId).changes,
          0,
        )
      : this.db
          .query(
            "UPDATE support_reports SET replied_at = ? WHERE ticket_id = ? AND reporter_email IS NOT NULL AND replied_at IS NULL",
          )
          .run(at, ticketId).changes;
    if (changed > 0) this.addActivity(ticketId, actor, "replied", `${changed} reporter(s)`);
    return changed;
  }

  linksFor(ticketId: number): Link[] {
    return this.db
      .query<LinkRow, [number]>("SELECT * FROM support_links WHERE ticket_id = ? ORDER BY id")
      .all(ticketId)
      .map(toLink);
  }

  /** Add or refresh a link (unique per ticket, kind and ref). */
  addLink(ticketId: number, input: NewLink, actor: string): { link: Link; created: boolean } {
    this.requireTicket(ticketId);
    const at = this.stamp();
    const existing = this.db
      .query<LinkRow, [number, string, string]>(
        "SELECT * FROM support_links WHERE ticket_id = ? AND kind = ? AND ref = ?",
      )
      .get(ticketId, input.kind, input.ref);
    if (existing) {
      this.db
        .query(
          `UPDATE support_links SET url = COALESCE(?, url), title = COALESCE(?, title),
             state = COALESCE(?, state), updated_at = ? WHERE id = ?`,
        )
        .run(input.url ?? null, input.title ?? null, input.state ?? null, at, existing.id);
      const row = this.db
        .query<LinkRow, [number]>("SELECT * FROM support_links WHERE id = ?")
        .get(existing.id);
      return { link: toLink(row as LinkRow), created: false };
    }
    const result = this.db
      .query(
        `INSERT INTO support_links (ticket_id, kind, ref, url, title, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ticketId,
        input.kind,
        input.ref,
        input.url ?? null,
        input.title ?? null,
        input.state ?? "open",
        at,
        at,
      );
    this.db.query("UPDATE support_tickets SET updated_at = ? WHERE id = ?").run(at, ticketId);
    this.addActivity(ticketId, actor, "linked", `${input.kind} ${input.ref}`);
    const row = this.db
      .query<LinkRow, [number]>("SELECT * FROM support_links WHERE id = ?")
      .get(Number(result.lastInsertRowid));
    return { link: toLink(row as LinkRow), created: true };
  }

  /** Set the state of every link with this kind and ref. Returns the tickets touched. */
  setLinkState(kind: LinkKind, ref: string, state: string, actor: string): number[] {
    const rows = this.db
      .query<LinkRow, [string, string]>("SELECT * FROM support_links WHERE kind = ? AND ref = ?")
      .all(kind, ref);
    const at = this.stamp();
    const touched: number[] = [];
    for (const row of rows) {
      if (row.state === state) continue;
      this.db
        .query("UPDATE support_links SET state = ?, updated_at = ? WHERE id = ?")
        .run(state, at, row.id);
      this.addActivity(
        row.ticket_id,
        actor,
        "link_state",
        `${kind} ${ref}: ${row.state} → ${state}`,
      );
      touched.push(row.ticket_id);
    }
    return [...new Set(touched)];
  }

  addActivity(ticketId: number, actor: string, kind: string, note: string | null): void {
    this.db
      .query(
        "INSERT INTO support_activity (ticket_id, at, actor, kind, note) VALUES (?, ?, ?, ?, ?)",
      )
      .run(ticketId, this.stamp(), actor, kind, note);
  }

  /** How many times `kind` was recorded since `sinceIso` (rate limits). */
  countActivitySince(kind: string, sinceIso: string): number {
    const row = this.db
      .query<{ n: number }, [string, string]>(
        "SELECT COUNT(*) AS n FROM support_activity WHERE kind = ? AND at >= ?",
      )
      .get(kind, sinceIso);
    return row?.n ?? 0;
  }

  counts(): Record<TicketStatus, number> & { needsReply: number } {
    const counts = Object.fromEntries(TICKET_STATUSES.map((s) => [s, 0])) as Record<
      TicketStatus,
      number
    >;
    for (const row of this.db
      .query<{ status: TicketStatus; n: number }, []>(
        "SELECT status, COUNT(*) AS n FROM support_tickets GROUP BY status",
      )
      .all()) {
      counts[row.status] = row.n;
    }
    const needsReply = this.listTickets({ filter: "needs_reply", limit: 10_000 }).length;
    return { ...counts, needsReply };
  }
}
