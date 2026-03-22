/**
 * Template Variable Interpolation for Scheduler
 *
 * Expands template variables in strings before task execution.
 * Designed for easy extension — just add a new entry to VARIABLES.
 *
 * Syntax:
 *   {{name}}           — basic variable (e.g. {{timestamp}}, {{epoch}})
 *   {{name:format}}    — variable with format arg (e.g. {{date:%Y-%m-%d}})
 *   {{env.NAME}}       — environment variable (e.g. {{env.HOME}}, {{env.USER}})
 *   {{$ENV_VAR}}       — legacy env syntax (e.g. {{$HOME}}) — avoid in CLI, shell expands $
 *   {{task.field}}     — task self-reference (e.g. {{task.name}}, {{task.id}})
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ScheduledTask } from "./db.js";

// ── Variable Definitions ─────────────────────────────────────

interface VariableDef {
  /** What this variable provides */
  description: string;
  /** Resolve the value. `arg` is the part after the colon, if any. */
  resolve: (arg: string | undefined, task: ScheduledTask) => string;
}

/**
 * Registry of built-in template variables.
 * To add a new variable, just add an entry here.
 */
const VARIABLES: Record<string, VariableDef> = {
  date: {
    description: "Current date. Optional strftime-style format: {{date:%Y-%m-%d}}",
    resolve: (format) => formatDate(new Date(), format ?? "%Y-%m-%d"),
  },

  time: {
    description: "Current time. Optional format: {{time:%H:%M:%S}}",
    resolve: (format) => formatDate(new Date(), format ?? "%H:%M:%S"),
  },

  datetime: {
    description: "Current date+time. Optional format: {{datetime:%Y-%m-%d_%H%M%S}}",
    resolve: (format) => formatDate(new Date(), format ?? "%Y-%m-%d_%H%M%S"),
  },

  timestamp: {
    description: "ISO 8601 timestamp (e.g. 2026-03-22T14:30:00.000Z)",
    resolve: () => new Date().toISOString(),
  },

  epoch: {
    description: "Unix epoch in seconds",
    resolve: () => String(Math.floor(Date.now() / 1000)),
  },

  "epoch.ms": {
    description: "Unix epoch in milliseconds",
    resolve: () => String(Date.now()),
  },

  hostname: {
    description: "Machine hostname",
    resolve: () => {
      try {
        return require("node:os").hostname();
      } catch {
        return "unknown";
      }
    },
  },

  uuid: {
    description: "Fresh random UUID",
    resolve: () => crypto.randomUUID(),
  },
};

// ── Date Formatting ──────────────────────────────────────────

/**
 * Minimal strftime-style formatter. Covers the most useful tokens
 * without pulling in a dependency.
 */
function formatDate(d: Date, format: string): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");

  return format
    .replace(/%Y/g, String(d.getFullYear()))
    .replace(/%m/g, pad(d.getMonth() + 1))
    .replace(/%d/g, pad(d.getDate()))
    .replace(/%H/g, pad(d.getHours()))
    .replace(/%M/g, pad(d.getMinutes()))
    .replace(/%S/g, pad(d.getSeconds()))
    .replace(/%j/g, pad(dayOfYear(d), 3))
    .replace(/%u/g, String(d.getDay() || 7))
    .replace(/%s/g, String(Math.floor(d.getTime() / 1000)))
    .replace(
      /%Z/g,
      Intl.DateTimeFormat("en", { timeZoneName: "short" })
        .formatToParts(d)
        .find((p) => p.type === "timeZoneName")?.value ?? "",
    )
    .replace(/%%/g, "%");
}

function dayOfYear(d: Date): number {
  const start = new Date(d.getFullYear(), 0, 0);
  const diff = d.getTime() - start.getTime();
  return Math.floor(diff / 86_400_000);
}

// ── Interpolation Engine ─────────────────────────────────────

/** Pattern: {{name}}, {{name:format}}, {{$ENV}}, {{task.field}} */
const TEMPLATE_RE = /\{\{([^}]+)\}\}/g;

/**
 * Interpolate all template variables in a string.
 * Unknown variables are left as-is (no silent swallowing).
 */
export function interpolate(input: string, task: ScheduledTask): string {
  return input.replace(TEMPLATE_RE, (_match, expr: string) => {
    const trimmed = expr.trim();

    // Environment variable: {{env.HOME}}, {{env.USER}} (preferred)
    if (trimmed.startsWith("env.")) {
      const envName = trimmed.slice(4);
      return process.env[envName] ?? _match;
    }

    // Legacy env syntax: {{$HOME}}, {{$USER}} (works but shell can expand $)
    if (trimmed.startsWith("$")) {
      const envName = trimmed.slice(1);
      return process.env[envName] ?? _match;
    }

    // Task self-reference: {{task.name}}, {{task.id}}
    if (trimmed.startsWith("task.")) {
      const field = trimmed.slice(5);
      return resolveTaskField(task, field) ?? _match;
    }

    // Built-in variable, possibly with format arg
    const colonIdx = trimmed.indexOf(":");
    const name = colonIdx >= 0 ? trimmed.slice(0, colonIdx) : trimmed;
    const arg = colonIdx >= 0 ? trimmed.slice(colonIdx + 1) : undefined;

    const def = VARIABLES[name];
    if (!def) return _match; // Unknown — leave as-is

    return def.resolve(arg, task);
  });
}

/**
 * Interpolate all strings in an array (e.g. args).
 */
export function interpolateAll(inputs: string[], task: ScheduledTask): string[] {
  return inputs.map((s) => interpolate(s, task));
}

// ── Task Field Resolution ────────────────────────────────────

function resolveTaskField(task: ScheduledTask, field: string): string | undefined {
  switch (field) {
    case "id":
      return task.id;
    case "name":
      return task.name;
    case "description":
      return task.description;
    case "type":
      return task.type;
    case "fireAt":
      return task.fireAt;
    case "cronExpr":
      return task.cronExpr;
    case "createdAt":
      return task.createdAt;
    case "firedCount":
      return String(task.firedCount);
    case "lastFiredAt":
      return task.lastFiredAt;
    case "output_dir":
      return resolveOutputDir(task);
    default:
      return undefined;
  }
}

// ── Output Directory ──────────────────────────────────────────

/** Slugify a task name for use as a directory name */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Resolve the output directory for a task.
 * Uses the task's `outputDir` pattern if set, otherwise a default.
 * Interpolates template variables within the pattern (excluding task.output_dir to avoid recursion).
 * Auto-creates the directory.
 */
function resolveOutputDir(task: ScheduledTask): string {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const slug = slugify(task.name);

  const defaultPattern = join(homedir(), ".anima", "tasks", slug, year, month);
  const pattern = task.outputDir ?? defaultPattern;

  // Interpolate variables within the pattern itself (but skip task.output_dir to avoid recursion)
  const resolved = pattern.replace(TEMPLATE_RE, (_match, expr: string) => {
    const trimmed = expr.trim();
    if (trimmed === "task.output_dir") return _match; // prevent recursion

    // Env vars: {{env.HOME}} (preferred) or {{$HOME}} (legacy)
    if (trimmed.startsWith("env.")) {
      return process.env[trimmed.slice(4)] ?? _match;
    }
    if (trimmed.startsWith("$")) {
      return process.env[trimmed.slice(1)] ?? _match;
    }

    // Task fields (except output_dir)
    if (trimmed.startsWith("task.")) {
      const f = trimmed.slice(5);
      if (f === "output_dir") return _match;
      return resolveTaskField(task, f) ?? _match;
    }

    // Built-in variables
    const colonIdx = trimmed.indexOf(":");
    const name = colonIdx >= 0 ? trimmed.slice(0, colonIdx) : trimmed;
    const arg = colonIdx >= 0 ? trimmed.slice(colonIdx + 1) : undefined;
    const def = VARIABLES[name];
    return def ? def.resolve(arg, task) : _match;
  });

  // Auto-create the directory
  mkdirSync(resolved, { recursive: true });

  return resolved;
}

// ── Exports for Discovery ────────────────────────────────────

/** List all available template variables with descriptions. */
export function listVariables(): Array<{ name: string; description: string }> {
  const vars = Object.entries(VARIABLES).map(([name, def]) => ({
    name: `{{${name}}}`,
    description: def.description,
  }));

  vars.push(
    {
      name: "{{env.*}}",
      description:
        "Environment variable (e.g. {{env.HOME}}, {{env.USER}}). Preferred over {{$VAR}} which conflicts with shell expansion.",
    },
    {
      name: "{{$ENV_VAR}}",
      description:
        "Legacy env variable syntax (e.g. {{$HOME}}). Use {{env.*}} from CLI to avoid shell expansion.",
    },
    {
      name: "{{task.*}}",
      description:
        "Task fields: id, name, description, type, fireAt, cronExpr, createdAt, firedCount, lastFiredAt, output_dir",
    },
    {
      name: "{{task.output_dir}}",
      description:
        "Auto-created output directory. Default: ~/.anima/tasks/<task-slug>/YYYY/MM/. Customizable via outputDir on the task.",
    },
  );

  return vars;
}
