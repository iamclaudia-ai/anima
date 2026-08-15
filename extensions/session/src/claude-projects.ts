import { join } from "node:path";
import { homedir } from "node:os";
import { deriveSessionTitle, deriveTitleFromMessage } from "./session-title";
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
  /**
   * PR / ticket references extracted from the session, rendered as chips under
   * the title. Populated from the database on the list path — filesystem
   * discovery alone doesn't carry them.
   */
  refs?: Array<{ type: string; key: string; label: string; url?: string }>;
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

/**
 * Progressively larger read budgets for title extraction.
 *
 * 8KB covers the overwhelming majority of transcripts in one read. But a
 * session can open with a very large preamble line — a `file-history-snapshot`
 * entry runs to tens of KB — which pushes the first real user message past the
 * budget and leaves the session untitled. Escalating only when the smaller
 * read yields nothing keeps the common case at one read.
 */
const TITLE_READ_BUDGETS = [8192, 65536, 262144];

/**
 * Recover the leading text of a user message from a JSON line that our capped
 * read cut in half.
 *
 * A single transcript line can be enormous — a message with a large paste or
 * inline attachment runs to hundreds of KB — so `JSON.parse` fails and the
 * session ends up untitled even though the prompt sits in the first few
 * hundred bytes. This pulls that prefix out directly rather than escalating
 * the read to cover the whole line.
 *
 * Returns null unless the line is confidently a user message, so a truncated
 * assistant or tool line can't be mistaken for a prompt.
 */
export function salvageTruncatedUserText(line: string): string | null {
  if (!/"type"\s*:\s*"user"/.test(line.slice(0, 200))) return null;

  // Capture a JSON string body, stopping at the first unescaped quote — or at
  // the end of what we have, when the read cut mid-string.
  const match = /"text"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(line);
  if (!match?.[1]) return null;

  // The captured body may end mid-escape (`\` or a partial `\uXXXX`), which
  // would make it invalid JSON on its own. Trim any dangling escape.
  const body = match[1].replace(/\\u[0-9a-fA-F]{0,3}$/, "").replace(/\\$/, "");
  try {
    return JSON.parse(`"${body}"`) as string;
  } catch {
    return null;
  }
}

/**
 * Read the leading user message texts from the head of a transcript.
 *
 * Returns them raw and in order; interpreting them is `deriveSessionTitle`'s
 * job. The read is deliberately capped — this runs per session during
 * discovery, and the title only ever comes from the top of the file.
 */
function readLeadingUserTexts(
  filepath: string,
  budget: number,
): { texts: string[]; atEof: boolean } {
  const texts: string[] = [];
  let atEof = true;
  try {
    const buf = new Uint8Array(budget);
    const fd = openSync(filepath, "r");
    const bytesRead = readSync(fd, buf, 0, budget, 0);
    closeSync(fd);
    atEof = bytesRead < budget;
    const text = new TextDecoder().decode(buf.subarray(0, bytesRead));
    const lines = text.split("\n");

    for (let i = 0; i < lines.length && texts.length < 10; i++) {
      const line = lines[i]?.trim();
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type !== "user") continue;

        const content = msg.message?.content;
        if (typeof content === "string") {
          texts.push(content);
        } else if (Array.isArray(content)) {
          for (const block of content as Array<{ type?: string; text?: string }>) {
            if (block?.type === "text" && block.text) texts.push(block.text);
          }
        }
      } catch {
        // A capped read routinely cuts the last line mid-JSON. Salvage the
        // prompt prefix rather than losing the title to a single huge message.
        const salvaged = salvageTruncatedUserText(line);
        if (salvaged) texts.push(salvaged);
      }
    }
  } catch {
    // skip unreadable files
  }

  return { texts, atEof };
}

/**
 * Derive a readable title for a session.
 *
 * Claude Code's own `sessions-index.json` records the raw first message, so a
 * slash-command session is stored there as `<command-message>…` markup. Run it
 * through the same derivation, and fall back to scanning the transcript when
 * the indexed value yields nothing usable.
 */
function extractFirstPrompt(filepath: string, indexed?: string): string | undefined {
  const fromIndex = indexed ? deriveTitleFromMessage(indexed) : null;
  if (fromIndex) return fromIndex;

  for (const budget of TITLE_READ_BUDGETS) {
    const { texts, atEof } = readLeadingUserTexts(filepath, budget);
    const title = deriveSessionTitle(texts);
    if (title) return title;
    // Short read means we already have the whole file — a bigger budget can
    // only re-read the same bytes.
    if (atEof) break;
  }

  return undefined;
}

export interface DiscoverOptions {
  /**
   * Decide whether a session's title needs (re-)extraction.
   *
   * Deriving a title opens and reads the head of a transcript, so a periodic
   * sweep that titles every session re-reads the whole workspace each pass.
   * The reconciler passes a predicate that returns false for sessions it has
   * already titled and whose mtime hasn't moved, reducing a sweep to a single
   * `readdir` plus one `stat` per file. Entries skipped this way come back with
   * `firstPrompt` undefined — callers must preserve the stored title rather
   * than overwrite it with nothing.
   */
  needsTitle?: (sessionId: string, modified: string) => boolean;
}

export function discoverSessions(cwd: string, options?: DiscoverOptions): SessionIndexEntry[] {
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
    const modified = indexed?.modified || stats.mtime.toISOString();
    const wantTitle = options?.needsTitle ? options.needsTitle(sessionId, modified) : true;
    sessions.push({
      sessionId,
      created: indexed?.created || stats.birthtime.toISOString(),
      modified,
      messageCount: indexed?.messageCount,
      firstPrompt: wantTitle ? extractFirstPrompt(filepath, indexed?.firstPrompt) : undefined,
      gitBranch: indexed?.gitBranch,
    });
  }

  return sessions;
}
