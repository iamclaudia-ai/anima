#!/usr/bin/env bun
/**
 * Support Extension — a small support desk across projects (Linear-lite).
 *
 * - Tickets group reports (emails, forum posts, Sentry alerts) about one
 *   problem, and link out to GitHub issues, PRs and delegated sessions.
 *   GitHub stays the source of truth for code work.
 * - `support.delegate` starts an `auto` session in the ticket's workspace with
 *   a prompt built here; `support.create_issue` files a GitHub issue.
 * - `support.handle_github` and `support.handle_sentry` are webhook targets:
 *   merged PRs and resolved Sentry issues move tickets to `fixed`, and new
 *   Sentry issues open tickets.
 * - MCP tools give the shell-less front-desk session (the `mail` profile) just
 *   enough to triage: no approval, no reply bookkeeping, no choice of profile
 *   or folder, and trust is always computed here, never claimed by the caller.
 *
 * Plan: docs/plans/SUPPORT-DESK.md
 */

import type {
  AnimaExtension,
  ExtensionContext,
  ExtensionMcpToolDefinition,
  ExtensionMcpToolResult,
  ExtensionMethodDefinition,
  HealthCheckResponse,
} from "@anima/shared";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { parseSupportConfig, type SupportConfig } from "./config";
import {
  buildDelegationPrompt,
  createGithubIssue,
  parseGithubUrl,
  repoVisibility,
  runCommand,
  type CommandRunner,
  type WorkspaceRef,
} from "./delegate";
import { handleGithubDelivery } from "./github";
import { handleSentryDelivery } from "./sentry";
import {
  LINK_KINDS,
  PRIORITIES,
  REPORT_SOURCES,
  SupportStore,
  TICKET_STATUSES,
  openAnimaDb,
  type NewReport,
  type ReportSource,
  type Ticket,
} from "./store";

export interface SupportExtensionOptions {
  /** Injected by tests. */
  db?: Database;
  run?: CommandRunner;
  now?: () => Date;
}

export const TICKET_CREATED = "support.ticket_created";
export const TICKET_UPDATED = "support.ticket_updated";

interface Workspace extends WorkspaceRef {
  aliases: string[];
  emailDomains: string[];
  sentryProjects: string[];
}

const HOUR_MS = 3_600_000;
const ticketId = z.number().int().positive().describe("Ticket number");
/** Who is acting, for the timeline. MCP calls are always "support". */
const actor = z.enum(["claudia", "michael"]).default("claudia");
const mailId = z.string().regex(/^\d{1,25}$/, "a Zoho message id (digits)");

const reportFields = {
  source: z.enum(REPORT_SOURCES),
  messageId: mailId.optional().describe("For source email: the Zoho message id"),
  externalId: z.string().max(200).optional().describe("Id in the source system"),
  reporterName: z.string().max(200).optional(),
  reporterEmail: z.email().optional().describe("Who to reply to, when they wrote in"),
  url: z.url().optional(),
  summary: z.string().max(4000).optional(),
};

const webhookDelivery = z.looseObject({
  id: z.string(),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
});

export function createSupportExtension(
  rawConfig: Record<string, unknown> = {},
  options: SupportExtensionOptions = {},
): AnimaExtension {
  const config: SupportConfig = parseSupportConfig(rawConfig);
  const run = options.run ?? runCommand;
  const now = options.now ?? (() => new Date());
  let ctx: ExtensionContext | null = null;
  let db: Database | null = null;
  let store: SupportStore | null = null;

  function requireStore(): SupportStore {
    if (!store) throw new Error("Support extension is not started");
    return store;
  }

  function requireCtx(): ExtensionContext {
    if (!ctx) throw new Error("Support extension is not started");
    return ctx;
  }

  async function findWorkspace(query: Record<string, string>): Promise<Workspace | null> {
    const result = (await requireCtx().call("session.find_workspace", query)) as {
      workspace: Workspace | null;
    };
    return result.workspace;
  }

  async function workspaceById(id: string): Promise<Workspace | null> {
    const result = (await requireCtx().call("session.get_workspace", { id })) as {
      workspace: Workspace | null;
    };
    return result.workspace;
  }

  async function resolveProject(project: string | undefined): Promise<string | null> {
    if (!project) return null;
    const workspace = await findWorkspace({ name: project });
    if (!workspace) {
      throw new Error(
        `No single project matches "${project}". List them with support_list_projects.`,
      );
    }
    return workspace.id;
  }

  function emitUpdated(ticket: Ticket): void {
    ctx?.emit(TICKET_UPDATED, { ticketId: ticket.id, status: ticket.status });
  }

  /**
   * Turn report params into a stored report. Email trust comes from the mail
   * extension (DMARC-verified and a trusted sender); other sources are trusted
   * only when Claudia or Michael add them directly.
   */
  async function buildReport(
    p: z.infer<z.ZodObject<typeof reportFields>>,
    trustedCaller: boolean,
  ): Promise<NewReport> {
    if (p.source === "email") {
      if (!p.messageId) throw new Error("An email report needs messageId");
      const verdict = (await requireCtx().call("mail.verify_sender", {
        messageId: p.messageId,
      })) as { from: string; sender: string | null; receivedAt: string | null; trusted: boolean };
      return {
        source: "email",
        externalId: p.messageId,
        // A forward from Michael names the customer explicitly; a customer's
        // own email is from them.
        reporterName: p.reporterName ?? (verdict.trusted ? null : verdict.sender),
        reporterEmail: p.reporterEmail ?? (verdict.trusted ? null : verdict.from),
        url: p.url ?? null,
        summary: p.summary ?? null,
        trusted: verdict.trusted,
        receivedAt: verdict.receivedAt,
      };
    }
    return {
      source: p.source as ReportSource,
      externalId: p.externalId ?? null,
      reporterName: p.reporterName ?? null,
      reporterEmail: p.reporterEmail ?? null,
      url: p.url ?? null,
      summary: p.summary ?? null,
      trusted: trustedCaller,
    };
  }

  // The extension host does not validate params (#86), so each call is
  // parsed here: defaults apply and bad input fails before any handler runs.
  const methods: ExtensionMethodDefinition[] = [
    {
      name: "support.health_check",
      description: "Return health status of the support extension",
      inputSchema: z.object({}),
    },
    {
      name: "support.list_projects",
      description:
        "List projects (workspaces with project fields): name, aliases, email domains, GitHub repo, Sentry project",
      inputSchema: z.object({}),
    },
    {
      name: "support.list_tickets",
      description:
        "List tickets, most urgent and oldest first. filter: open (default), needs_reply, fixed, closed, all",
      inputSchema: z.object({
        filter: z.enum(["open", "needs_reply", "fixed", "closed", "all"]).default("open"),
        project: z.string().optional().describe("Project name or alias"),
        limit: z.number().int().min(1).max(500).default(100),
      }),
    },
    {
      name: "support.get_ticket",
      description: "A ticket with its reports, links and timeline",
      inputSchema: z.object({ ticketId }),
    },
    {
      name: "support.create_ticket",
      description:
        "Open a ticket for a problem, optionally with its first report. Search open tickets first: several reports about one problem belong on one ticket.",
      inputSchema: z.object({
        title: z.string().min(3).max(200),
        summary: z.string().max(4000).optional(),
        project: z.string().optional().describe("Project name or alias"),
        priority: z.enum(PRIORITIES).default("normal"),
        report: z.object(reportFields).optional(),
        actor,
      }),
    },
    {
      name: "support.update_ticket",
      description: "Change a ticket's title, summary, status, priority or project",
      inputSchema: z.object({
        ticketId,
        title: z.string().min(3).max(200).optional(),
        summary: z.string().max(4000).optional(),
        status: z.enum(TICKET_STATUSES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        project: z.string().optional().describe("Project name or alias"),
        actor,
      }),
    },
    {
      name: "support.add_report",
      description: "Add a report (another email, forum post, alert) to an existing ticket",
      inputSchema: z.object({ ticketId, ...reportFields, actor }),
    },
    {
      name: "support.link",
      description: "Link a GitHub issue or PR (by URL), or another URL, to a ticket",
      inputSchema: z.object({
        ticketId,
        kind: z.enum(LINK_KINDS).default("other"),
        url: z.url(),
        ref: z.string().max(200).optional().describe("Defaults to owner/repo#N for GitHub URLs"),
        title: z.string().max(200).optional(),
        actor,
      }),
    },
    {
      name: "support.note",
      description: "Add a note to a ticket's timeline (findings, decisions, context)",
      inputSchema: z.object({ ticketId, note: z.string().min(1).max(8000), actor }),
    },
    {
      name: "support.approve",
      description:
        "Approve a ticket from an untrusted source, so it can be delegated or filed in a public repo",
      inputSchema: z.object({ ticketId, actor }),
    },
    {
      name: "support.mark_replied",
      description:
        "Record that reporters have been answered (all of them, or the given report ids)",
      inputSchema: z.object({
        ticketId,
        reportIds: z.array(z.number().int().positive()).optional(),
        actor,
      }),
    },
    {
      name: "support.delegate",
      description:
        "Start an auto-mode session in the ticket's project to work on it. Profile and folder come from config and the project; the prompt is built from the ticket.",
      inputSchema: z.object({
        ticketId,
        task: z.string().min(10).max(4000).describe("What the session should do"),
        actor,
      }),
    },
    {
      name: "support.create_issue",
      description:
        "File a GitHub issue for a ticket in its project's repo and link it. No customer emails or personal details in the body.",
      inputSchema: z.object({
        ticketId,
        title: z.string().min(3).max(200),
        body: z.string().min(1).max(20000),
        labels: z.array(z.string().min(1).max(50)).max(10).default([]),
        actor,
      }),
    },
    {
      name: "support.handle_github",
      description: "Webhook target for the github hook (called by the webhooks extension)",
      inputSchema: webhookDelivery,
    },
    {
      name: "support.handle_sentry",
      description: "Webhook target for the sentry hook (called by the webhooks extension)",
      inputSchema: webhookDelivery,
    },
  ];
  const schemas = new Map(methods.map((m) => [m.name, m.inputSchema]));

  // ── MCP tools for the front-desk session ───────────────────
  //
  // Narrower than the methods: no approve, no mark_replied, only email and
  // forum reports, and every action is recorded as "support".

  const mcpReport = z.object({
    source: z.enum(["email", "forum"]),
    messageId: mailId.optional().describe("For email: the Zoho message id"),
    reporterName: z.string().max(200).optional(),
    reporterEmail: z
      .email()
      .optional()
      .describe("The customer to reply to (for a forward, the original sender)"),
    url: z.url().optional().describe("For forum: the post URL"),
    summary: z.string().max(4000).optional(),
  });

  const mcpDefinitions: Array<{
    name: string;
    method: string;
    description: string;
    inputSchema: z.ZodType;
  }> = [
    {
      name: "support_list_projects",
      method: "support.list_projects",
      description: "List projects with their aliases, email domains and repos",
      inputSchema: z.object({}),
    },
    {
      name: "support_list_tickets",
      method: "support.list_tickets",
      description:
        "List tickets (filter: open, needs_reply, fixed, closed, all). Check here before opening a new one.",
      inputSchema: z.object({
        filter: z.enum(["open", "needs_reply", "fixed", "closed", "all"]).default("open"),
        project: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
    },
    {
      name: "support_get_ticket",
      method: "support.get_ticket",
      description: "A ticket with its reports, links and timeline",
      inputSchema: z.object({ ticketId }),
    },
    {
      name: "support_create_ticket",
      method: "support.create_ticket",
      description:
        "Open a ticket for one problem, with the email or forum post that reported it. Reports about the same problem go on one ticket (support_add_report).",
      inputSchema: z.object({
        title: z.string().min(3).max(200),
        summary: z.string().max(4000).optional(),
        project: z.string().optional().describe("Project name or alias (support_list_projects)"),
        priority: z.enum(PRIORITIES).default("normal"),
        report: mcpReport.optional(),
      }),
    },
    {
      name: "support_add_report",
      method: "support.add_report",
      description: "Add another email or forum post to an existing ticket",
      inputSchema: mcpReport.extend({ ticketId }),
    },
    {
      name: "support_update_ticket",
      method: "support.update_ticket",
      description: "Change a ticket's title, summary, status, priority or project",
      inputSchema: z.object({
        ticketId,
        title: z.string().min(3).max(200).optional(),
        summary: z.string().max(4000).optional(),
        status: z.enum(TICKET_STATUSES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        project: z.string().optional(),
      }),
    },
    {
      name: "support_link",
      method: "support.link",
      description: "Link a GitHub issue or PR (by URL) to a ticket",
      inputSchema: z.object({
        ticketId,
        url: z.url(),
        title: z.string().max(200).optional(),
      }),
    },
    {
      name: "support_note",
      method: "support.note",
      description: "Add a note to a ticket's timeline",
      inputSchema: z.object({ ticketId, note: z.string().min(1).max(8000) }),
    },
    {
      name: "support_delegate",
      method: "support.delegate",
      description:
        "Hand a ticket to an auto-mode Claudia session in its project (she can read the code and the production data). Only for tickets from a trusted source or approved by Michael.",
      inputSchema: z.object({
        ticketId,
        task: z.string().min(10).max(4000).describe("What to investigate or do"),
      }),
    },
    {
      name: "support_create_issue",
      method: "support.create_issue",
      description:
        "File a GitHub issue for a ticket in its project's repo. Describe the problem; never include customer emails, passwords or personal details.",
      inputSchema: z.object({
        ticketId,
        title: z.string().min(3).max(200),
        body: z.string().min(1).max(20000),
        labels: z.array(z.string().min(1).max(50)).max(10).default([]),
      }),
    },
  ];

  const mcpTools: ExtensionMcpToolDefinition[] = mcpDefinitions.map((def) => ({
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    handle: (args) => runMcpTool(def.name, args),
  }));

  async function runMcpTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ExtensionMcpToolResult> {
    try {
      const def = mcpDefinitions.find((d) => d.name === name);
      if (!def) throw new Error(`Unknown MCP tool: ${name}`);
      const parsed = def.inputSchema.parse(args) as Record<string, unknown>;
      // support_link takes a URL only; the kind comes from it.
      if (name === "support_link") {
        parsed.kind = parseGithubUrl(String(parsed.url))?.kind ?? "other";
      }
      const result = await dispatch(def.method, parsed, "support");
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  }

  return {
    id: "support",
    name: "Support",
    methods,
    events: [TICKET_CREATED, TICKET_UPDATED],
    mcpTools,

    async handleMcpTool(name: string, args: Record<string, unknown>) {
      return await runMcpTool(name, args);
    },

    async start(context: ExtensionContext) {
      ctx = context;
      db = options.db ?? openAnimaDb();
      store = new SupportStore(db, now);
      context.log.info("Support started", { delegation: config.delegation });
    },

    async stop() {
      store = null;
      if (db && !options.db) db.close();
      db = null;
      ctx = null;
    },

    async handleMethod(method: string, params: Record<string, unknown>) {
      const schema = schemas.get(method);
      const parsed = (schema ? schema.parse(params) : params) as Record<string, unknown>;
      return await dispatch(method, parsed, String(parsed.actor ?? "claudia"));
    },

    health() {
      return { ok: store !== null, details: store ? store.counts() : {} };
    },
  };

  async function dispatch(
    method: string,
    params: Record<string, unknown>,
    who: string,
  ): Promise<unknown> {
    const s = requireStore();
    // Tickets opened by Claudia or Michael directly are trusted; the
    // front desk's are trusted only through a verified report.
    const trustedCaller = who !== "support";

    switch (method) {
      case "support.health_check": {
        const counts = s.counts();
        const response: HealthCheckResponse = {
          ok: true,
          status: "healthy",
          label: "Support",
          metrics: [
            {
              label: "Open",
              value: counts.new + counts.triaged + counts.in_progress + counts.waiting,
            },
            { label: "Needs reply", value: counts.needsReply },
            { label: "Fixed", value: counts.fixed },
          ],
        };
        return response;
      }

      case "support.list_projects": {
        const result = (await requireCtx().call("session.list_workspaces", {})) as {
          workspaces: Workspace[];
        };
        return {
          projects: result.workspaces
            .filter(
              (w) =>
                w.description ||
                w.aliases?.length ||
                w.emailDomains?.length ||
                w.githubRepo ||
                w.sentryProjects?.length,
            )
            .map((w) => ({
              name: w.name,
              description: w.description,
              aliases: w.aliases,
              emailDomains: w.emailDomains,
              githubRepo: w.githubRepo,
              sentryProjects: w.sentryProjects,
            })),
        };
      }

      case "support.list_tickets": {
        const p = params as { filter: "open"; project?: string; limit: number };
        const workspaceId = (await resolveProject(p.project)) ?? undefined;
        return { tickets: s.listTickets({ filter: p.filter, workspaceId, limit: p.limit }) };
      }

      case "support.get_ticket": {
        const detail = s.getDetail(params.ticketId as number);
        if (!detail) throw new Error(`Unknown ticket #${params.ticketId}`);
        return detail;
      }

      case "support.create_ticket": {
        const p = params as {
          title: string;
          summary?: string;
          project?: string;
          priority: "normal";
          report?: z.infer<z.ZodObject<typeof reportFields>>;
        };
        const workspaceId = await resolveProject(p.project);
        const report = p.report ? await buildReport(p.report, trustedCaller) : null;
        const ticket = s.createTicket({
          workspaceId,
          title: p.title,
          summary: p.summary,
          priority: p.priority,
          trusted: trustedCaller,
          actor: who,
        });
        if (report) s.addReport(ticket.id, report, who);
        const created = s.requireTicket(ticket.id);
        ctx?.emit(TICKET_CREATED, { ticket: created });
        return { ticket: created };
      }

      case "support.update_ticket": {
        const p = params as {
          ticketId: number;
          title?: string;
          summary?: string;
          status?: (typeof TICKET_STATUSES)[number];
          priority?: (typeof PRIORITIES)[number];
          project?: string;
        };
        const ticket = s.updateTicket(
          p.ticketId,
          {
            title: p.title,
            summary: p.summary,
            status: p.status,
            priority: p.priority,
            workspaceId: p.project === undefined ? undefined : await resolveProject(p.project),
          },
          who,
        );
        emitUpdated(ticket);
        return { ticket };
      }

      case "support.add_report": {
        const p = params as { ticketId: number } & z.infer<z.ZodObject<typeof reportFields>>;
        s.requireTicket(p.ticketId);
        const { report, created } = s.addReport(
          p.ticketId,
          await buildReport(p, trustedCaller),
          who,
        );
        return { report, created, ticket: s.requireTicket(p.ticketId) };
      }

      case "support.link": {
        const p = params as {
          ticketId: number;
          kind: (typeof LINK_KINDS)[number];
          url: string;
          ref?: string;
          title?: string;
        };
        const github = parseGithubUrl(p.url);
        const kind = github && p.kind === "other" ? github.kind : p.kind;
        const ref = p.ref ?? github?.ref ?? p.url;
        return s.addLink(p.ticketId, { kind, ref, url: p.url, title: p.title ?? null }, who);
      }

      case "support.note": {
        const p = params as { ticketId: number; note: string };
        s.requireTicket(p.ticketId);
        s.addActivity(p.ticketId, who, "note", p.note);
        return { ok: true };
      }

      case "support.approve":
        return { ticket: s.approve(params.ticketId as number, who) };

      case "support.mark_replied": {
        const p = params as { ticketId: number; reportIds?: number[] };
        const replied = s.markReplied(p.ticketId, p.reportIds ?? null, who);
        return { replied, ticket: s.requireTicket(p.ticketId) };
      }

      case "support.delegate": {
        const p = params as { ticketId: number; task: string };
        const detail = s.getDetail(p.ticketId);
        if (!detail) throw new Error(`Unknown ticket #${p.ticketId}`);
        const { ticket } = detail;
        if (!ticket.trusted && !ticket.approved) {
          throw new Error(
            `Ticket #${ticket.id} came from an untrusted source. Michael needs to approve it before it can be delegated.`,
          );
        }
        if (!ticket.workspaceId) {
          throw new Error(`Ticket #${ticket.id} has no project. Set one with update_ticket first.`);
        }
        const workspace = await workspaceById(ticket.workspaceId);
        if (!workspace) throw new Error(`Ticket #${ticket.id}'s project no longer exists`);
        const since = new Date(now().getTime() - HOUR_MS).toISOString();
        if (s.countActivitySince("delegated", since) >= config.delegation.maxPerHour) {
          throw new Error(
            `Delegation limit reached (${config.delegation.maxPerHour} per hour). Try again later.`,
          );
        }

        const name = `${workspace.name} · #${ticket.id} ${ticket.title}`.slice(0, 120);
        const result = (await requireCtx().call("session.spawn_agent", {
          parentSessionId: "NEW",
          cwd: workspace.cwd,
          profile: config.delegation.profile,
          name,
          prompt: buildDelegationPrompt(detail, workspace, p.task),
        })) as { sessionId: string };
        s.addLink(
          ticket.id,
          { kind: "session", ref: result.sessionId, title: name, state: "running" },
          who,
        );
        s.addActivity(ticket.id, who, "delegated", p.task);
        const updated =
          ticket.status === "new" || ticket.status === "triaged"
            ? s.setStatus(ticket.id, "in_progress", who, "delegated")
            : s.requireTicket(ticket.id);
        emitUpdated(updated);
        return { sessionId: result.sessionId, name, ticket: updated };
      }

      case "support.create_issue": {
        const p = params as { ticketId: number; title: string; body: string; labels: string[] };
        const ticket = s.requireTicket(p.ticketId);
        if (!ticket.workspaceId) throw new Error(`Ticket #${ticket.id} has no project`);
        const workspace = await workspaceById(ticket.workspaceId);
        if (!workspace?.githubRepo) {
          throw new Error(`Project ${workspace?.name ?? "?"} has no GitHub repo set`);
        }
        if (who === "support" && !ticket.approved) {
          const visibility = await repoVisibility(run, workspace.githubRepo);
          if (visibility !== "PRIVATE" && visibility !== "INTERNAL") {
            throw new Error(
              `${workspace.githubRepo} is ${visibility.toLowerCase()}: Michael needs to approve ticket #${ticket.id} before customer issues go there.`,
            );
          }
        }
        const body = `${p.body.trim()}\n\n---\nSupport ticket #${ticket.id} · filed by Claudia's support desk`;
        const issue = await createGithubIssue(run, workspace.githubRepo, p.title, body, p.labels);
        const { link } = s.addLink(
          ticket.id,
          { kind: "issue", ref: issue.ref, url: issue.url, title: p.title },
          who,
        );
        return { issue: issue.url, link };
      }

      case "support.handle_github": {
        const p = params as { headers: Record<string, string>; body: string };
        const result = await handleGithubDelivery(p.headers, p.body, {
          store: s,
          findWorkspaceByRepo: (repo) => findWorkspace({ githubRepo: repo }),
        });
        for (const id of result.tickets ?? []) emitUpdated(s.requireTicket(id));
        return result;
      }

      case "support.handle_sentry": {
        const p = params as { headers: Record<string, string>; body: string };
        const result = await handleSentryDelivery(p.headers, p.body, {
          store: s,
          findWorkspaceBySentryProject: (slug) => findWorkspace({ sentryProject: slug }),
        });
        if (result.status === "created" && result.ticket) {
          ctx?.emit(TICKET_CREATED, { ticket: result.ticket });
        } else if (result.status === "updated" && result.ticketId) {
          emitUpdated(s.requireTicket(result.ticketId));
        }
        const { ticket: _ticket, ...summary } = result;
        return summary;
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }
}

export default createSupportExtension;

// ── Direct execution with HMR ────────────────────────────────
import { runExtensionHost } from "@anima/extension-host";
if (import.meta.main) runExtensionHost(createSupportExtension);
