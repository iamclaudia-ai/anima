/**
 * Sentry webhook handling (`sentry` hook → `support.handle_sentry`).
 *
 * The webhooks extension has already checked `sentry-hook-signature` (an
 * internal integration's client secret). `sentry-hook-resource` names what
 * happened:
 * - `issue` `created` → a ticket for the workspace whose `sentryProject` is
 *   the issue's project slug. `resolved` → fixed; `unresolved` → reopened.
 * - `event_alert` `triggered` → the same as `issue.created` for its issue, so
 *   alert rules decide what is worth a ticket.
 * Everything else is ignored (the webhooks inbox keeps it anyway).
 *
 * Sentry issue ids are the report's external id, so an issue never makes two
 * tickets, however many alerts fire for it.
 */

import type { Priority, SupportStore, Ticket } from "./store";
import { header } from "./github";

export interface SentryDeps {
  store: SupportStore;
  findWorkspaceBySentryProject(slug: string): Promise<{ id: string } | null>;
}

export interface SentryResult {
  status: "created" | "updated" | "ignored";
  resource: string;
  action: string;
  reason?: string;
  ticketId?: number;
  ticket?: Ticket;
}

interface SentryIssue {
  id?: string | number;
  shortId?: string;
  title?: string;
  culprit?: string;
  level?: string;
  web_url?: string;
  permalink?: string;
  count?: string | number;
  userCount?: number;
  firstSeen?: string;
  project?: { slug?: string; name?: string };
}

interface SentryEvent {
  issue_id?: string | number;
  title?: string;
  culprit?: string;
  level?: string;
  url?: string;
  web_url?: string;
  datetime?: string;
}

interface SentryPayload {
  action?: string;
  data?: { issue?: SentryIssue; event?: SentryEvent; triggered_rule?: string };
}

const LEVEL_PRIORITY: Record<string, Priority> = {
  fatal: "urgent",
  error: "high",
  warning: "normal",
};

/** Project slug from an event's API url: /api/0/projects/{org}/{project}/events/{id}/ */
export function projectFromEventUrl(url: string | undefined): string | null {
  return url?.match(/\/api\/0\/projects\/[^/]+\/([^/]+)\/events\//)?.[1] ?? null;
}

interface Incoming {
  issueId: string;
  shortId: string | null;
  title: string;
  culprit: string | null;
  level: string | null;
  url: string | null;
  project: string | null;
  note: string;
  receivedAt: string | null;
}

async function openTicket(incoming: Incoming, deps: SentryDeps): Promise<SentryResult> {
  const { store } = deps;
  const existing = store.ticketsForReport("sentry", incoming.issueId);
  if (existing.length > 0) {
    for (const id of existing) store.addActivity(id, "sentry", "alert", incoming.note);
    return { status: "updated", resource: "", action: "", ticketId: existing[0] };
  }

  const workspace = incoming.project
    ? await deps.findWorkspaceBySentryProject(incoming.project)
    : null;
  const label = incoming.shortId ? `${incoming.shortId}: ` : "";
  const ticket = store.createTicket({
    workspaceId: workspace?.id ?? null,
    title: `${label}${incoming.title}`.slice(0, 200),
    summary: [
      incoming.culprit ? `Culprit: ${incoming.culprit}` : null,
      incoming.level ? `Level: ${incoming.level}` : null,
      incoming.project ? `Sentry project: ${incoming.project}` : null,
      incoming.note,
    ]
      .filter(Boolean)
      .join("\n"),
    priority: LEVEL_PRIORITY[incoming.level ?? ""] ?? "low",
    trusted: true,
    actor: "sentry",
  });
  store.addReport(
    ticket.id,
    {
      source: "sentry",
      externalId: incoming.issueId,
      url: incoming.url,
      summary: incoming.note,
      trusted: true,
      receivedAt: incoming.receivedAt,
    },
    "sentry",
  );
  store.addLink(
    ticket.id,
    {
      kind: "sentry",
      ref: incoming.shortId ?? incoming.issueId,
      url: incoming.url,
      title: incoming.title,
    },
    "sentry",
  );
  return {
    status: "created",
    resource: "",
    action: "",
    ticketId: ticket.id,
    ticket: store.requireTicket(ticket.id),
  };
}

export async function handleSentryDelivery(
  headers: Record<string, string>,
  body: string,
  deps: SentryDeps,
): Promise<SentryResult> {
  const resource = header(headers, "sentry-hook-resource") ?? "unknown";
  let payload: SentryPayload;
  try {
    payload = JSON.parse(body) as SentryPayload;
  } catch {
    return { status: "ignored", resource, action: "", reason: "body is not JSON" };
  }
  const action = payload.action ?? "";
  const done = (result: SentryResult): SentryResult => ({ ...result, resource, action });

  if (resource === "issue") {
    const issue = payload.data?.issue;
    if (!issue?.id) return done({ status: "ignored", resource, action, reason: "no issue id" });
    const issueId = String(issue.id);
    const ref = issue.shortId ?? issueId;
    const { store } = deps;

    if (action === "created") {
      const counts = [
        issue.count ? `${issue.count} events` : null,
        issue.userCount ? `${issue.userCount} users` : null,
      ].filter(Boolean);
      return done(
        await openTicket(
          {
            issueId,
            shortId: issue.shortId ?? null,
            title: issue.title ?? "Sentry issue",
            culprit: issue.culprit ?? null,
            level: issue.level ?? null,
            url: issue.web_url ?? issue.permalink ?? null,
            project: issue.project?.slug ?? null,
            note: `New Sentry issue${counts.length ? ` (${counts.join(", ")})` : ""}`,
            receivedAt: issue.firstSeen ?? null,
          },
          deps,
        ),
      );
    }

    if (action === "resolved" || action === "unresolved") {
      const state = action === "resolved" ? "resolved" : "open";
      const tickets = new Set([
        ...store.setLinkState("sentry", ref, state, "sentry"),
        ...store.ticketsForReport("sentry", issueId),
      ]);
      for (const id of tickets) {
        const ticket = store.getTicket(id);
        if (!ticket) continue;
        if (action === "resolved" && ticket.status !== "fixed" && ticket.status !== "closed") {
          store.setStatus(id, "fixed", "sentry", `${ref} resolved in Sentry`);
        } else if (
          action === "unresolved" &&
          (ticket.status === "fixed" || ticket.status === "closed")
        ) {
          store.setStatus(id, "new", "sentry", `${ref} regressed in Sentry`);
        }
      }
      const first = [...tickets][0];
      return done(
        first === undefined
          ? { status: "ignored", resource, action, reason: "no ticket for this issue" }
          : { status: "updated", resource, action, ticketId: first },
      );
    }

    // assigned, archived: note it on any ticket that tracks this issue.
    const tickets = store.ticketsForReport("sentry", issueId);
    for (const id of tickets)
      store.addActivity(id, "sentry", action || "issue", `${ref} ${action}`);
    return done(
      tickets.length > 0
        ? { status: "updated", resource, action, ticketId: tickets[0] }
        : { status: "ignored", resource, action, reason: "no ticket for this issue" },
    );
  }

  if (resource === "event_alert") {
    const event = payload.data?.event;
    if (!event?.issue_id)
      return done({ status: "ignored", resource, action, reason: "no issue id" });
    const rule = payload.data?.triggered_rule;
    return done(
      await openTicket(
        {
          issueId: String(event.issue_id),
          shortId: null,
          title: event.title ?? "Sentry alert",
          culprit: event.culprit ?? null,
          level: event.level ?? null,
          url: event.web_url ?? null,
          project: projectFromEventUrl(event.url),
          note: rule ? `Alert rule "${rule}" triggered` : "Alert triggered",
          receivedAt: event.datetime ?? null,
        },
        deps,
      ),
    );
  }

  return done({ status: "ignored", resource, action, reason: "resource not handled" });
}
