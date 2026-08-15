#!/usr/bin/env bun
/**
 * Audit transcript-index coverage: what's on disk vs what memory has ingested.
 *
 * Claude Code deletes session transcripts after ~30 days, so `~/.claude/projects`
 * only holds a recent window; `~/.claude/projects-backup` is the durable archive.
 * Memory ingests transcripts into `memory_transcript_entries`, which is the
 * corpus session search will be built on — so a gap here is a permanently
 * unsearchable conversation.
 *
 * The important distinction this makes: a file with **no entries** is only a bug
 * if it actually contains conversation. Plenty of transcripts are pure metadata
 * (`file-history-snapshot` records and nothing else), and those *should* index
 * to zero. This classifies every unindexed file by reading it.
 *
 * Usage:
 *   bun run scripts/audit-transcript-index.ts            # summary
 *   bun run scripts/audit-transcript-index.ts --list 40  # + sample the real gap
 *   bun run scripts/audit-transcript-index.ts --csv out.csv
 */

import { Database } from "bun:sqlite";
import { createReadStream, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, relative } from "node:path";
import { homedir } from "node:os";

const PROJECTS = join(homedir(), ".claude", "projects");
const BACKUP = join(homedir(), ".claude", "projects-backup");
const DB_PATH = process.env.ANIMA_DATA_DIR
  ? join(process.env.ANIMA_DATA_DIR, "anima.db")
  : join(homedir(), ".anima", "anima.db");

const listCount = (() => {
  const i = process.argv.indexOf("--list");
  return i >= 0 ? Number(process.argv[i + 1] ?? 20) : 0;
})();
const csvPath = (() => {
  const i = process.argv.indexOf("--csv");
  return i >= 0 ? process.argv[i + 1] : null;
})();

// ── Disk ────────────────────────────────────────────────────────

interface DiskFile {
  /** Path relative to the projects root — the key memory stores. */
  rel: string;
  /** Absolute path we'll actually read (live copy preferred). */
  abs: string;
  live: boolean;
  backup: boolean;
  isSubagent: boolean;
  size: number;
  mtime: Date;
}

function walkJsonl(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith(".jsonl")) out.push(full);
    }
  }
  return out;
}

const byRel = new Map<string, DiskFile>();

for (const [root, isLive] of [
  [BACKUP, false],
  [PROJECTS, true],
] as const) {
  if (!existsSync(root)) continue;
  for (const abs of walkJsonl(root)) {
    const rel = relative(root, abs);
    let size = 0;
    let mtime = new Date(0);
    try {
      const st = statSync(abs);
      size = st.size;
      mtime = st.mtime;
    } catch {
      continue;
    }
    const existing = byRel.get(rel);
    if (existing) {
      // Live pass runs second, so prefer the live copy for reading.
      existing.live ||= isLive;
      existing.backup ||= !isLive;
      if (isLive) {
        existing.abs = abs;
        existing.size = size;
        existing.mtime = mtime;
      }
      continue;
    }
    byRel.set(rel, {
      rel,
      abs,
      live: isLive,
      backup: !isLive,
      isSubagent: rel.includes("/subagents/"),
      size,
      mtime,
    });
  }
}

// ── Database ────────────────────────────────────────────────────

const db = new Database(DB_PATH, { readonly: true });
const tracked = new Set(
  (db.query("SELECT file_path FROM memory_file_states").all() as { file_path: string }[]).map(
    (r) => r.file_path,
  ),
);
const indexed = new Map(
  (
    db
      .query(
        "SELECT source_file, COUNT(*) AS n FROM memory_transcript_entries GROUP BY source_file",
      )
      .all() as { source_file: string; n: number }[]
  ).map((r) => [r.source_file, r.n]),
);

// ── Classify ────────────────────────────────────────────────────

/**
 * Does this transcript contain any actual conversation?
 *
 * Streams line by line and exits at the first user/assistant message, so the
 * common case costs a few KB rather than the whole file. Only genuinely
 * message-free files are read to the end.
 */
async function hasConversation(abs: string): Promise<boolean> {
  try {
    const rl = createInterface({
      input: createReadStream(abs, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      // Cheap pre-filter before paying for JSON.parse on a large line.
      if (!line.includes('"user"') && !line.includes('"assistant"')) continue;
      try {
        const d = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
        if ((d.type === "user" || d.type === "assistant") && d.message?.content !== undefined) {
          rl.close();
          return true;
        }
      } catch {
        // A truncated or malformed line proves nothing either way.
      }
    }
    return false;
  } catch {
    return false;
  }
}

interface Row extends DiskFile {
  state: "indexed" | "empty-ok" | "MISSING";
  entries: number;
  isTracked: boolean;
}

const rows: Row[] = [];
const all = [...byRel.values()];
let scanned = 0;

for (const file of all) {
  const entries = indexed.get(file.rel) ?? 0;
  let state: Row["state"];
  if (entries > 0) {
    state = "indexed";
  } else {
    // Zero entries is only a gap if there was something to index.
    state = (await hasConversation(file.abs)) ? "MISSING" : "empty-ok";
  }
  rows.push({ ...file, state, entries, isTracked: tracked.has(file.rel) });
  if (++scanned % 1000 === 0) process.stderr.write(`  …scanned ${scanned}/${all.length}\r`);
}
process.stderr.write(" ".repeat(40) + "\r");

// ── Report ──────────────────────────────────────────────────────

const topLevel = rows.filter((r) => !r.isSubagent);
const missing = rows.filter((r) => r.state === "MISSING");
const missingTop = missing.filter((r) => !r.isSubagent);

const count = (rs: Row[], f: (r: Row) => boolean) => rs.filter(f).length;
const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : "—");

console.log("\n╭─ TRANSCRIPT INDEX AUDIT ─────────────────────────────────\n");
console.log(`  db:      ${DB_PATH}`);
console.log(`  live:    ${PROJECTS}`);
console.log(`  backup:  ${BACKUP}\n`);

console.log(`  files on disk (union):    ${rows.length}`);
console.log(`    top-level sessions:     ${topLevel.length}`);
console.log(`    subagent transcripts:   ${rows.length - topLevel.length}`);
console.log(`    live only:              ${count(rows, (r) => r.live && !r.backup)}`);
console.log(`    backup only:            ${count(rows, (r) => r.backup && !r.live)}`);
console.log(`    both:                   ${count(rows, (r) => r.backup && r.live)}\n`);

console.log(`  tracked in memory_file_states: ${count(rows, (r) => r.isTracked)}`);
console.log(`  tracked rows with no file:     ${tracked.size - count(rows, (r) => r.isTracked)}\n`);

console.log("  ── classification ──");
console.log(
  `  indexed (has entries):    ${count(rows, (r) => r.state === "indexed")}  ${pct(
    count(rows, (r) => r.state === "indexed"),
    rows.length,
  )}`,
);
console.log(
  `  no conversation content:  ${count(rows, (r) => r.state === "empty-ok")}  (correctly zero)`,
);
console.log(`  MISSING — real content:   ${missing.length}   ← the actual gap`);
console.log(`    of which top-level:     ${missingTop.length}`);
console.log(`    of which subagent:      ${missing.length - missingTop.length}`);
console.log(
  `    never tracked at all:   ${count(missing, (r) => !r.isTracked)} / tracked but empty: ${count(missing, (r) => r.isTracked)}`,
);

if (missingTop.length) {
  const sorted = [...missingTop].sort((a, b) => a.mtime.getTime() - b.mtime.getTime());
  console.log(
    `\n    date range: ${sorted[0]!.mtime.toISOString().slice(0, 10)} → ${sorted.at(-1)!.mtime.toISOString().slice(0, 10)}`,
  );
  const byYear = new Map<string, number>();
  for (const r of sorted) {
    const k = r.mtime.toISOString().slice(0, 7);
    byYear.set(k, (byYear.get(k) ?? 0) + 1);
  }
  console.log("    by month:");
  for (const [month, n] of [...byYear].sort()) console.log(`      ${month}  ${n}`);
}

if (listCount > 0) {
  console.log(`\n  ── sample of missing top-level sessions (newest ${listCount}) ──`);
  for (const r of [...missingTop]
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
    .slice(0, listCount)) {
    const where = r.live ? "live" : "backup";
    console.log(
      `    ${r.mtime.toISOString().slice(0, 10)}  ${(r.size / 1024).toFixed(0).padStart(6)}KB  ${where.padEnd(6)}  ${r.rel}`,
    );
  }
}

if (csvPath) {
  const lines = ["rel,state,entries,tracked,live,backup,subagent,size,mtime"];
  for (const r of rows) {
    lines.push(
      `"${r.rel}",${r.state},${r.entries},${r.isTracked},${r.live},${r.backup},${r.isSubagent},${r.size},${r.mtime.toISOString()}`,
    );
  }
  writeFileSync(csvPath, lines.join("\n"));
  console.log(`\n  wrote ${rows.length} rows → ${csvPath}`);
}

console.log("\n╰──────────────────────────────────────────────────────────\n");
