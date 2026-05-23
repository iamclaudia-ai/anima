/**
 * Claude CLI auto-update check — runs once at watchdog startup.
 *
 * The Claude CLI runtime (agent-host) drives the real `claude` binary, so the
 * installed version gates model availability and protocol fixes (e.g. Opus 4.7
 * needs CLI v2.1.111+). `claude update` is the official "check latest + install
 * if newer" command for native installs and a fast no-op when already current.
 *
 * We run it BEFORE starting services so the agent-host spawns the freshest CLI.
 * Best-effort: any failure (binary missing, offline, timeout) logs a warning
 * and lets startup proceed — a stale CLI beats a watchdog that won't boot.
 *
 * Zero monorepo imports, matching the rest of the watchdog.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { log } from "./logger";
import { LOGIN_ENV } from "./services";

/** Cap so a hung download can't block startup indefinitely. */
const UPDATE_TIMEOUT_MS = 120_000;

/** Locate the `claude` binary using the captured login PATH. */
function findClaudeBin(): string | null {
  const pathDirs = (LOGIN_ENV.PATH ?? process.env.PATH ?? "").split(":").filter(Boolean);
  const candidates = [
    join(homedir(), ".local", "bin", "claude"),
    ...pathDirs.map((dir) => join(dir, "claude")),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function run(bin: string, args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([bin, ...args], {
    env: LOGIN_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), UPDATE_TIMEOUT_MS);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, out: `${stdout}${stderr}`.trim() };
  } finally {
    clearTimeout(timer);
  }
}

/** Parse the leading semver token from `claude --version` output. */
function parseVersion(versionOutput: string): string {
  return versionOutput.split(/\s+/)[0] || "unknown";
}

/**
 * Check for and install the latest Claude CLI. Never throws.
 */
export async function ensureClaudeUpToDate(): Promise<void> {
  const bin = findClaudeBin();
  if (!bin) {
    log("WARN", "Claude CLI not found on PATH — skipping auto-update check");
    return;
  }

  try {
    const before = parseVersion((await run(bin, ["--version"])).out);
    const { code, out } = await run(bin, ["update"]);
    const after = parseVersion((await run(bin, ["--version"])).out);

    if (after !== before) {
      log("INFO", `Claude CLI updated ${before} → ${after}`);
    } else if (code === 0) {
      log("INFO", `Claude CLI up to date (${after})`);
    } else {
      log("WARN", `Claude CLI update check failed (exit ${code}): ${out.slice(0, 200)}`);
    }
  } catch (err) {
    log("WARN", `Claude CLI auto-update errored: ${String(err)}`);
  }
}
