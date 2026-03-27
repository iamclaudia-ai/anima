/**
 * Load .env file from the anima project root.
 * Bun auto-loads .env from cwd, but these scripts may run from
 * the skill directory, so we explicitly load the project root .env.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const ENV_PATH = resolve(PROJECT_ROOT, ".env");

if (existsSync(ENV_PATH)) {
  const lines = readFileSync(ENV_PATH, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    // Don't override existing env vars
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}
