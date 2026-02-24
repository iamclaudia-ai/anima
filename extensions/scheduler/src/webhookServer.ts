/**
 * Webhook Server for Scheduler Extension
 *
 * Provides HTTP endpoints for external systems to trigger scheduled tasks:
 * - GitHub webhooks (push, PR, issues)
 * - Calendar events (meeting reminders)
 * - Custom application events
 * - Health monitoring alerts
 */

import { Database } from "bun:sqlite";

export class WebhookServer {
  private server: any;
  private ctx: any;
  private db: Database;
  private log: any;
  private port: number;

  constructor(ctx: any, db: Database, log: any, port: number = 30088) {
    this.ctx = ctx;
    this.db = db;
    this.log = log;
    this.port = port;
  }

  async start() {
    this.log.info("Starting webhook server", { port: this.port });

    this.server = Bun.serve({
      port: this.port,
      fetch: (req) => this.handleRequest(req),
    });

    this.log.info("Webhook server started", {
      port: this.port,
      url: `http://localhost:${this.port}`
    });
  }

  async stop() {
    if (this.server) {
      this.server.stop();
      this.log.info("Webhook server stopped");
    }
  }

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method;
    const path = url.pathname;

    this.log.info("Webhook request received", {
      method,
      path,
      userAgent: req.headers.get('user-agent')
    });

    // CORS headers for browser requests
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: corsHeaders });
    }

    try {
      let response: Response;

      switch (true) {
        case path === '/health':
          response = await this.handleHealth();
          break;

        case path.startsWith('/webhook/github'):
          response = await this.handleGitHubWebhook(req);
          break;

        case path.startsWith('/webhook/calendar'):
          response = await this.handleCalendarWebhook(req);
          break;

        case path.startsWith('/webhook/custom/'):
          response = await this.handleCustomWebhook(req);
          break;

        case path === '/tasks':
          response = await this.handleTasksAPI(req);
          break;

        default:
          response = new Response('Not Found', { status: 404 });
      }

      // Add CORS headers to all responses
      Object.entries(corsHeaders).forEach(([key, value]) => {
        response.headers.set(key, value);
      });

      return response;

    } catch (error) {
      this.log.error("Webhook request failed", { path, error: String(error) });
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }

  private async handleHealth(): Promise<Response> {
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      webhookServer: true
    };

    return new Response(JSON.stringify(health), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleGitHubWebhook(req: Request): Promise<Response> {
    const payload = await req.json();
    const event = req.headers.get('x-github-event') || 'unknown';

    this.log.info("GitHub webhook received", {
      event,
      action: payload.action,
      repository: payload.repository?.name
    });

    // Find webhook tasks that match this event
    const webhookTasks = this.db.prepare(`
      SELECT * FROM scheduled_tasks
      WHERE schedule_type = 'webhook'
      AND enabled = 1
      AND (schedule_value LIKE ? OR schedule_value = 'github')
    `).all(`github.${event}%`);

    const results = [];

    for (const task of webhookTasks) {
      try {
        const result = await this.executeWebhookTask(task, payload);
        results.push({ taskId: task.id, result });
      } catch (error) {
        this.log.error("Webhook task execution failed", {
          taskId: task.id,
          error: String(error)
        });
        results.push({ taskId: task.id, error: String(error) });
      }
    }

    // Common GitHub webhook scenarios
    switch (event) {
      case 'push':
        if (payload.ref === 'refs/heads/main') {
          await this.triggerMainBranchActions(payload);
        }
        break;

      case 'pull_request':
        if (payload.action === 'opened') {
          await this.triggerPRReview(payload);
        }
        break;

      case 'issues':
        if (payload.action === 'opened') {
          await this.triggerIssueNotification(payload);
        }
        break;
    }

    return new Response(JSON.stringify({
      received: true,
      event,
      processed: results.length,
      results
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleCalendarWebhook(req: Request): Promise<Response> {
    const payload = await req.json();

    this.log.info("Calendar webhook received", {
      event: payload.event,
      title: payload.title,
      startTime: payload.startTime
    });

    // Trigger meeting reminder notifications
    if (payload.event === 'reminder') {
      await this.ctx.call('session.notify', {
        message: `📅 Meeting reminder: ${payload.title}`,
        metadata: {
          type: 'calendar_reminder',
          meetingId: payload.meetingId,
          startTime: payload.startTime,
          duration: payload.duration
        }
      });
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleCustomWebhook(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const webhookPath = url.pathname.replace('/webhook/custom/', '');
    const payload = await req.json();

    this.log.info("Custom webhook received", { path: webhookPath, payload });

    // Find matching webhook tasks
    const webhookTasks = this.db.prepare(`
      SELECT * FROM scheduled_tasks
      WHERE schedule_type = 'webhook'
      AND enabled = 1
      AND schedule_value = ?
    `).all(webhookPath);

    const results = [];

    for (const task of webhookTasks) {
      try {
        const result = await this.executeWebhookTask(task, payload);
        results.push({ taskId: task.id, result });
      } catch (error) {
        results.push({ taskId: task.id, error: String(error) });
      }
    }

    return new Response(JSON.stringify({
      received: true,
      path: webhookPath,
      processed: results.length,
      results
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleTasksAPI(req: Request): Promise<Response> {
    if (req.method === 'GET') {
      // List webhook tasks
      const tasks = this.db.prepare(`
        SELECT id, name, description, schedule_value, action_type, action_target, enabled, created_at
        FROM scheduled_tasks
        WHERE schedule_type = 'webhook'
        ORDER BY created_at DESC
      `).all();

      return new Response(JSON.stringify({ tasks }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('Method not allowed', { status: 405 });
  }

  private async executeWebhookTask(task: any, payload: any) {
    const executionId = crypto.randomUUID();
    const startedAt = new Date().toISOString();

    // Record execution start
    this.db.prepare(`
      INSERT INTO task_executions (id, task_id, started_at, status)
      VALUES (?, ?, ?, 'running')
    `).run(executionId, task.id, startedAt);

    const startTime = Date.now();
    let status = 'completed';
    let result: any = null;
    let error: string | null = null;

    try {
      const actionParams = JSON.parse(task.action_params || '{}');

      // Merge webhook payload with action params
      const params = { ...actionParams, webhook: payload };

      switch (task.action_type) {
        case 'extension_call':
          const method = task.action_method || task.action_target;
          result = await this.ctx.call(method, params);
          break;

        case 'notification':
          result = await this.ctx.call('session.notify', {
            message: task.action_target,
            metadata: params
          });
          break;

        default:
          throw new Error(`Unsupported webhook action type: ${task.action_type}`);
      }

    } catch (err) {
      status = 'failed';
      error = String(err);
      this.log.error("Webhook task execution failed", { taskId: task.id, error });
    }

    const completedAt = new Date().toISOString();
    const duration = Date.now() - startTime;

    // Update execution record
    this.db.prepare(`
      UPDATE task_executions
      SET completed_at = ?, status = ?, result = ?, error = ?, duration = ?
      WHERE id = ?
    `).run(completedAt, status, JSON.stringify(result), error, duration, executionId);

    // Update task statistics
    const errorIncrement = status === 'failed' ? 1 : 0;
    this.db.prepare(`
      UPDATE scheduled_tasks
      SET last_run = ?, run_count = run_count + 1, error_count = error_count + ?, updated_at = ?
      WHERE id = ?
    `).run(completedAt, errorIncrement, completedAt, task.id);

    return result;
  }

  // Specialized GitHub webhook handlers

  private async triggerMainBranchActions(payload: any) {
    this.log.info("Main branch push detected, triggering actions", {
      repository: payload.repository.name,
      commits: payload.commits?.length
    });

    // Trigger code review if configured
    try {
      await this.ctx.call('codex.auto_review', {
        repository: payload.repository.name,
        ref: payload.ref,
        commits: payload.commits
      });
    } catch (error) {
      this.log.error("Auto-review failed", { error: String(error) });
    }
  }

  private async triggerPRReview(payload: any) {
    this.log.info("PR opened, triggering review", {
      number: payload.number,
      title: payload.pull_request.title
    });

    try {
      const review = await this.ctx.call('codex.review', {
        prUrl: payload.pull_request.html_url,
        prNumber: payload.number
      });

      if (review.severity === 'high') {
        await this.ctx.call('session.notify', {
          message: `🚨 Critical issues found in PR #${payload.number}: ${payload.pull_request.title}`,
          metadata: { pr: payload.number, review }
        });
      }
    } catch (error) {
      this.log.error("PR review failed", { error: String(error) });
    }
  }

  private async triggerIssueNotification(payload: any) {
    await this.ctx.call('session.notify', {
      message: `📝 New issue: ${payload.issue.title}`,
      metadata: {
        issueNumber: payload.issue.number,
        url: payload.issue.html_url
      }
    });
  }
}