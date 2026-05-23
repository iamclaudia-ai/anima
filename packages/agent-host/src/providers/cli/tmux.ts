/**
 * Minimal tmux helpers for the Claude CLI runtime (#33).
 *
 * The runtime drives a real `claude` TUI living in a detached tmux session.
 * These are thin, synchronous wrappers around the `tmux` binary (input side);
 * the model stream comes back out-of-band via the proxy, not from the pane.
 */

import { execFileSync } from "node:child_process";

/** POSIX single-quote a string for safe embedding in a shell command. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function tmux(args: string[]): string {
  try {
    return execFileSync("tmux", args, { encoding: "utf-8" }).toString();
  } catch (err) {
    const e = err as { stdout?: Buffer | string };
    return e.stdout ? e.stdout.toString() : "";
  }
}

export function hasSession(name: string): boolean {
  try {
    execFileSync("tmux", ["has-session", "-t", name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface NewSessionOptions {
  name: string;
  cwd: string;
  /** [binary, ...args] — quoted and run via the session's shell. */
  command: string[];
  /** Environment assignments prefixed onto the command (empty value clears). */
  env?: Record<string, string>;
}

export function newSession(opts: NewSessionOptions): void {
  const envPrefix = Object.entries(opts.env ?? {})
    .map(([k, v]) => `${k}=${sq(v)}`)
    .join(" ");
  const cmd = `${envPrefix} ${opts.command.map(sq).join(" ")}`.trim();
  execFileSync("tmux", [
    "new-session",
    "-d",
    "-s",
    opts.name,
    "-x",
    "220",
    "-y",
    "50",
    "-c",
    opts.cwd,
    cmd,
  ]);
}

export function capturePane(name: string): string {
  return tmux(["capture-pane", "-t", name, "-p"]);
}

export function sendKey(name: string, key: string): void {
  tmux(["send-keys", "-t", name, key]);
}

/**
 * Send a (possibly multi-line) prompt to the TUI: load it as a tmux buffer and
 * bracketed-paste it (preserves newlines, unlike `send-keys -l`), then submit
 * with Enter after a short settle delay.
 */
export async function sendText(name: string, text: string): Promise<void> {
  tmux(["set-buffer", "--", text]);
  tmux(["paste-buffer", "-t", name, "-d", "-p"]);
  await new Promise((r) => setTimeout(r, 150));
  tmux(["send-keys", "-t", name, "Enter"]);
}

export function killSession(name: string): void {
  if (hasSession(name)) tmux(["kill-session", "-t", name]);
}
