#!/usr/bin/env bun

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const APPLY = process.argv.includes("--apply");

const SOURCE_DIR = join(homedir(), ".claudia");
const TARGET_DIR = join(homedir(), ".anima");

const FILES: Array<{ source: string; target: string; rewrite: boolean }> = [
  {
    source: join(SOURCE_DIR, "claudia.json"),
    target: join(TARGET_DIR, "anima.json"),
    rewrite: true,
  },
  {
    source: join(SOURCE_DIR, "claudia.db"),
    target: join(TARGET_DIR, "anima.db"),
    rewrite: false,
  },
  {
    source: join(SOURCE_DIR, "watchdog.json"),
    target: join(TARGET_DIR, "watchdog.json"),
    rewrite: true,
  },
];

function log(message: string): void {
  console.log(`[migrate-to-anima] ${message}`);
}

function fail(message: string): never {
  console.error(`[migrate-to-anima] ERROR: ${message}`);
  process.exit(1);
}

function rewriteConfig(path: string): void {
  const original = readFileSync(path, "utf-8");
  const updated = original
    .replaceAll(".claudia", ".anima")
    .replaceAll("claudia.json", "anima.json")
    .replaceAll("claudia.db", "anima.db")
    .replaceAll("CLAUDIA_", "ANIMA_")
    .replaceAll("com.claudia.watchdog", "com.anima.watchdog")
    .replaceAll("claudia-watchdog", "anima-watchdog")
    .replaceAll("/Projects/iamclaudia-ai/claudia", "/Projects/iamclaudia-ai/anima");

  if (updated !== original) {
    writeFileSync(path, updated);
    log(`rewrote ${path}`);
  }
}

for (const file of FILES) {
  if (!existsSync(file.source)) {
    fail(`required source file is missing: ${file.source}`);
  }
}

log(`source: ${SOURCE_DIR}`);
log(`target: ${TARGET_DIR}`);

for (const file of FILES) {
  log(`will copy ${file.source} -> ${file.target}`);
}

if (!APPLY) {
  log("dry run only; rerun with --apply to perform the migration");
  process.exit(0);
}

mkdirSync(TARGET_DIR, { recursive: true });

for (const file of FILES) {
  if (existsSync(file.target)) {
    fail(`target file already exists: ${file.target}`);
  }

  mkdirSync(dirname(file.target), { recursive: true });
  copyFileSync(file.source, file.target);
  log(`copied ${file.source} -> ${file.target}`);

  if (file.rewrite) {
    rewriteConfig(file.target);
  }
}

log("migration complete");
log("legacy ~/.claudia files were not modified");
