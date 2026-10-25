/**
 * GitHub webhook handling (`github` hook → `support.handle_github`).
 *
 * The webhooks extension has already checked `x-hub-signature-256`. Events:
 * - `ping`: nothing to do.
 * - `issues` and `pull_request` that mention "Support ticket #N" in their body
 *   are linked to ticket N, but only from the ticket's own repo.
 * - Closed, reopened and merged issues and PRs update their links, and move
 *   tickets: a merged PR or all linked issues closed makes a ticket `fixed`.
 */

import type { SupportStore } from "./store";

export interface GithubDeps {
  store: SupportStore;
  /** The workspace for a repo ("owner/repo"), or null. */
  findWorkspaceByRepo(repo: string): Promise<{ id: string } | null>;
}

export interface GithubResult {
  status: "ok" | "ignored";
  event: string;
  reason?: string;
  tickets?: number[];
}

const MENTION = /support ticket #(\d+)/gi;

interface GithubThing {
  number?: number;
  title?: string;
  body?: string | null;
  html_url?: string;
  state?: string;
  merged?: boolean;
}

interface GithubPayload {
  action?: string;
  issue?: GithubThing;
  pull_request?: GithubThing;
  repository?: { full_name?: string };
}

export function header(headers: Record<string, string>, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return null;
}

/** Ticket numbers mentioned as "Support ticket #N". */
export function mentionedTickets(text: string | null | undefined): number[] {
  if (!text) return [];
  return [...new Set([...text.matchAll(MENTION)].map((m) => Number(m[1])))];
}

/**
 * Move tickets whose code links changed: a merged PR, or every linked issue
 * closed, makes an open ticket `fixed`.
 */
export function settleTickets(store: SupportStore, ticketIds: number[], actor: string): void {
  for (const id of ticketIds) {
    const ticket = store.getTicket(id);
    if (!ticket || ticket.status === "fixed" || ticket.status === "closed") continue;
    const links = store.linksFor(id);
    const merged = links.find((l) => l.kind === "pr" && l.state === "merged");
    const issues = links.filter((l) => l.kind === "issue");
    if (merged) {
      store.setStatus(id, "fixed", actor, `PR ${merged.ref} merged`);
    } else if (issues.length > 0 && issues.every((l) => l.state === "closed")) {
      store.setStatus(id, "fixed", actor, "all linked issues closed");
    }
  }
}

export async function handleGithubDelivery(
  headers: Record<string, string>,
  body: string,
  deps: GithubDeps,
): Promise<GithubResult> {
  const event = header(headers, "x-github-event") ?? "unknown";
  if (event === "ping") return { status: "ok", event };
  if (event !== "issues" && event !== "pull_request") {
    return { status: "ignored", event, reason: "not an issues or pull_request event" };
  }

  let payload: GithubPayload;
  try {
    payload = JSON.parse(body) as GithubPayload;
  } catch {
    return { status: "ignored", event, reason: "body is not JSON" };
  }
  const repo = payload.repository?.full_name;
  const thing = event === "issues" ? payload.issue : payload.pull_request;
  if (!repo || !thing?.number) return { status: "ignored", event, reason: "no repo or number" };

  const kind = event === "issues" ? "issue" : "pr";
  const ref = `${repo}#${thing.number}`;
  const { store } = deps;
  const touched = new Set<number>();

  // Link anything that names a ticket, but only from that ticket's own repo,
  // so another repo can't attach itself to (or close) someone else's ticket.
  const mentions = mentionedTickets(thing.body);
  if (mentions.length > 0) {
    const workspace = await deps.findWorkspaceByRepo(repo);
    for (const id of mentions) {
      const ticket = store.getTicket(id);
      if (!ticket || !workspace || ticket.workspaceId !== workspace.id) continue;
      store.addLink(
        id,
        { kind, ref, url: thing.html_url ?? null, title: thing.title ?? null },
        "github",
      );
      touched.add(id);
    }
  }

  const action = payload.action ?? "";
  let state: string | null = null;
  if (action === "closed") state = kind === "pr" && thing.merged ? "merged" : "closed";
  else if (action === "reopened") state = "open";

  if (state) {
    for (const id of store.setLinkState(kind, ref, state, "github")) touched.add(id);
    if (state === "open") {
      for (const id of touched) {
        const ticket = store.getTicket(id);
        if (ticket?.status === "fixed") store.setStatus(id, "triaged", "github", `${ref} reopened`);
      }
    }
  }

  const tickets = [...touched];
  settleTickets(store, tickets, "github");
  return { status: "ok", event, tickets };
}
