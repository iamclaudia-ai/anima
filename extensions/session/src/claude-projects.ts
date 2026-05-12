import { join } from "node:path";
import { homedir } from "node:os";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  statSync,
} from "node:fs";

export interface SessionIndexEntry {
  sessionId: string;
  created?: string;
  modified?: string;
  messageCount?: number;
  firstPrompt?: string;
  gitBranch?: string;
}

/**
 * Encode a cwd to Claude Code's `~/.claude/projects/<encoded>/` directory
 * naming. Claude Code replaces both `/` and `.` with `-`, so
 * `/Users/me/.hammerspoon` becomes `-Users-me--hammerspoon` (note the
 * double-dash where the dot was).
 */
function encodeCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

export function resolveProjectDir(cwd: string): string | null {
  const projectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) return null;

  // Try the canonical encoding first (cheap path lookup, no directory scan).
  const primary = join(projectsDir, encodeCwd(cwd));
  if (existsSync(primary)) return primary;

  // Legacy encoding (only `/` → `-`) — older session dirs created before
  // Claude Code added the dot-replacement may still use this form.
  const legacy = join(projectsDir, cwd.replace(/\//g, "-"));
  if (legacy !== primary && existsSync(legacy)) return legacy;

  // Last-ditch fallback: scan every project dir's sessions-index.json and
  // match the recorded `originalPath`. Catches encoding schemes we haven't
  // seen yet (and doubles as the canonical recovery path when DBs hold
  // stale entries).
  const dirs = readdirSync(projectsDir);
  for (const dir of dirs) {
    const indexPath = join(projectsDir, dir, "sessions-index.json");
    if (!existsSync(indexPath)) continue;
    try {
      const data = JSON.parse(readFileSync(indexPath, "utf-8"));
      if (data.originalPath === cwd) return join(projectsDir, dir);
    } catch {
      // skip invalid index files
    }
  }

  return null;
}

function readSessionsIndexMap(projectDir: string): Map<string, SessionIndexEntry> {
  const map = new Map<string, SessionIndexEntry>();
  const indexPath = join(projectDir, "sessions-index.json");
  if (!existsSync(indexPath)) return map;

  try {
    const data = JSON.parse(readFileSync(indexPath, "utf-8"));
    const entries: SessionIndexEntry[] =
      data.entries && Array.isArray(data.entries) ? data.entries : Array.isArray(data) ? data : [];
    for (const entry of entries) {
      if (entry.sessionId) map.set(entry.sessionId, entry);
    }
  } catch {
    // skip invalid index files
  }

  return map;
}

function extractFirstPrompt(filepath: string): string | undefined {
  try {
    const buf = new Uint8Array(8192);
    const fd = openSync(filepath, "r");
    const bytesRead = readSync(fd, buf, 0, 8192, 0);
    closeSync(fd);
    const text = new TextDecoder().decode(buf.subarray(0, bytesRead));
    const lines = text.split("\n");

    for (let i = 0; i < Math.min(lines.length, 10); i++) {
      const line = lines[i]?.trim();
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type !== "user") continue;

        const content = msg.message?.content;
        if (typeof content === "string") return content.slice(0, 200);
        if (Array.isArray(content)) {
          // Per-message inner scan with a multi-condition predicate — there's
          // no shared key to hoist into a Map across the outer line loop.
          // react-doctor-disable-next-line react-doctor/js-index-maps
          const textBlock = content.find(
            (block: { type: string; text?: string }) =>
              block.type === "text" &&
              block.text &&
              !block.text.startsWith("<local-command-caveat>"),
          );
          if (textBlock?.text) return textBlock.text.slice(0, 200);
        }
      } catch {
        // skip truncated/invalid lines
      }
    }
  } catch {
    // skip unreadable files
  }

  return undefined;
}

export function discoverSessions(cwd: string): SessionIndexEntry[] {
  const projectDir = resolveProjectDir(cwd);
  if (!projectDir) return [];

  const indexMap = readSessionsIndexMap(projectDir);
  const files = readdirSync(projectDir).filter((file) => file.endsWith(".jsonl"));
  const sessions: SessionIndexEntry[] = [];

  for (const file of files) {
    const sessionId = file.replace(".jsonl", "");
    const filepath = join(projectDir, file);

    let stats;
    try {
      stats = statSync(filepath);
    } catch {
      continue;
    }

    const indexed = indexMap.get(sessionId);
    sessions.push({
      sessionId,
      created: indexed?.created || stats.birthtime.toISOString(),
      modified: indexed?.modified || stats.mtime.toISOString(),
      messageCount: indexed?.messageCount,
      firstPrompt: indexed?.firstPrompt || extractFirstPrompt(filepath),
      gitBranch: indexed?.gitBranch,
    });
  }

  return sessions;
}
