import { describe, expect, it } from "bun:test";
import { interpolate, interpolateAll, listVariables } from "./template.js";
import type { ScheduledTask } from "./db.js";

const mockTask: ScheduledTask = {
  id: "task-123",
  name: "nightly-backup",
  description: "Back up the database",
  type: "cron",
  fireAt: "2026-03-22T00:00:00.000Z",
  cronExpr: "0 0 * * *",
  action: { type: "exec", target: "sqlite3", payload: {} },
  missedPolicy: "fire_once",
  concurrency: "skip_if_running",
  enabled: true,
  createdAt: "2026-03-21T00:00:00.000Z",
  firedCount: 5,
  lastFiredAt: "2026-03-21T00:00:00.000Z",
  keepHistory: 50,
};

describe("template interpolation", () => {
  it("interpolates {{date}} with default format", () => {
    const result = interpolate("backup-{{date}}.db", mockTask);
    expect(result).toMatch(/^backup-\d{4}-\d{2}-\d{2}\.db$/);
  });

  it("interpolates {{date:FORMAT}} with custom format", () => {
    const result = interpolate("backup-{{date:%Y%m%d}}.db", mockTask);
    expect(result).toMatch(/^backup-\d{8}\.db$/);
  });

  it("interpolates {{time}} with default format", () => {
    const result = interpolate("log-{{time}}.txt", mockTask);
    expect(result).toMatch(/^log-\d{2}:\d{2}:\d{2}\.txt$/);
  });

  it("interpolates {{datetime}} with default format", () => {
    const result = interpolate("snapshot-{{datetime}}", mockTask);
    expect(result).toMatch(/^snapshot-\d{4}-\d{2}-\d{2}_\d{6}$/);
  });

  it("interpolates {{timestamp}} as ISO string", () => {
    const result = interpolate("{{timestamp}}", mockTask);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("interpolates {{epoch}} as seconds", () => {
    const result = interpolate("{{epoch}}", mockTask);
    const num = Number(result);
    expect(num).toBeGreaterThan(1_700_000_000);
    expect(result).not.toContain(".");
  });

  it("interpolates {{epoch.ms}} as milliseconds", () => {
    const result = interpolate("{{epoch.ms}}", mockTask);
    const num = Number(result);
    expect(num).toBeGreaterThan(1_700_000_000_000);
  });

  it("interpolates {{uuid}} as a valid UUID", () => {
    const result = interpolate("{{uuid}}", mockTask);
    expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("interpolates {{env.HOME}} from environment", () => {
    const result = interpolate("{{env.HOME}}", mockTask);
    expect(result).toBe(process.env.HOME!);
  });

  it("leaves unknown {{env.*}} as-is", () => {
    const result = interpolate("{{env.DEFINITELY_NOT_SET_12345}}", mockTask);
    expect(result).toBe("{{env.DEFINITELY_NOT_SET_12345}}");
  });

  it("interpolates legacy {{$ENV}} from environment", () => {
    const result = interpolate("{{$HOME}}", mockTask);
    expect(result).toBe(process.env.HOME!);
  });

  it("leaves unknown {{$ENV}} as-is", () => {
    const result = interpolate("{{$DEFINITELY_NOT_SET_12345}}", mockTask);
    expect(result).toBe("{{$DEFINITELY_NOT_SET_12345}}");
  });

  it("interpolates {{task.*}} fields", () => {
    expect(interpolate("{{task.id}}", mockTask)).toBe("task-123");
    expect(interpolate("{{task.name}}", mockTask)).toBe("nightly-backup");
    expect(interpolate("{{task.firedCount}}", mockTask)).toBe("5");
    expect(interpolate("{{task.type}}", mockTask)).toBe("cron");
  });

  it("resolves {{task.output_dir}} with default pattern and creates directory", () => {
    const result = interpolate("{{task.output_dir}}", mockTask);
    const now = new Date();
    const year = String(now.getFullYear());
    const month = String(now.getMonth() + 1).padStart(2, "0");
    expect(result).toContain("/.anima/tasks/nightly-backup/");
    expect(result).toContain(`/${year}/${month}`);
    // Directory should exist
    const { existsSync } = require("node:fs");
    expect(existsSync(result)).toBe(true);
  });

  it("resolves {{task.output_dir}} with custom outputDir pattern using env.*", () => {
    const customTask = {
      ...mockTask,
      outputDir: "{{env.HOME}}/my-backups/{{date:%Y}}/{{task.name}}",
    };
    const result = interpolate("{{task.output_dir}}", customTask);
    expect(result).toBe(
      `${process.env.HOME}/my-backups/${new Date().getFullYear()}/nightly-backup`,
    );
    const { existsSync } = require("node:fs");
    expect(existsSync(result)).toBe(true);
  });

  it("leaves unknown task fields as-is", () => {
    expect(interpolate("{{task.bogus}}", mockTask)).toBe("{{task.bogus}}");
  });

  it("leaves unknown variables as-is", () => {
    expect(interpolate("{{nope}}", mockTask)).toBe("{{nope}}");
  });

  it("handles multiple variables in one string", () => {
    const result = interpolate("{{task.name}}-{{date:%Y%m%d}}.db", mockTask);
    expect(result).toMatch(/^nightly-backup-\d{8}\.db$/);
  });

  it("handles strings with no variables", () => {
    expect(interpolate("plain text", mockTask)).toBe("plain text");
  });

  it("interpolateAll processes an array", () => {
    const results = interpolateAll(["{{task.id}}", "{{$HOME}}", "plain"], mockTask);
    expect(results[0]).toBe("task-123");
    expect(results[1]).toBe(process.env.HOME!);
    expect(results[2]).toBe("plain");
  });
});

describe("listVariables", () => {
  it("returns all built-in variables", () => {
    const vars = listVariables();
    const names = vars.map((v) => v.name);
    expect(names).toContain("{{date}}");
    expect(names).toContain("{{timestamp}}");
    expect(names).toContain("{{epoch}}");
    expect(names).toContain("{{uuid}}");
    expect(names).toContain("{{env.*}}");
    expect(names).toContain("{{$ENV_VAR}}");
    expect(names).toContain("{{task.*}}");
  });
});
