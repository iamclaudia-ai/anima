/**
 * Reading and writing Claude Code's `skillOverrides` in ~/.claude/settings.json.
 *
 * We are never the only writer: Claude Code's `/skills` screen and Michael
 * edit this file too. So every write re-reads the file, changes only the one
 * `skillOverrides` entry, and lands atomically (temp file + rename in the same
 * directory). A symlinked settings file is written through to its target so
 * the link survives, and the file mode is preserved.
 */

import {
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, basename } from "node:path";
import { SKILL_VISIBILITIES, type SkillVisibility } from "./inventory";

type Settings = Record<string, unknown>;

function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Never overwrite a file we cannot parse: that would destroy whatever is in it.
    throw new Error(
      `${path} is not valid JSON; not modifying it (${err instanceof Error ? err.message : err})`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} does not contain a JSON object; not modifying it`);
  }
  return parsed as Settings;
}

export function readSkillOverrides(path: string): Record<string, unknown> {
  try {
    const overrides = readSettings(path).skillOverrides;
    return overrides && typeof overrides === "object" ? (overrides as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface VisibilityChange {
  name: string;
  previous: SkillVisibility;
  visibility: SkillVisibility;
}

/** Sets one skill's visibility. "on" removes the entry, since that is the default. */
export function setSkillVisibility(
  path: string,
  name: string,
  visibility: SkillVisibility,
): VisibilityChange {
  if (!(SKILL_VISIBILITIES as readonly string[]).includes(visibility)) {
    throw new Error(`Invalid visibility: ${visibility}`);
  }
  const target = existsSync(path) ? realpathSync(path) : path;
  const settings = readSettings(target);
  const overrides = { ...((settings.skillOverrides as Record<string, unknown>) ?? {}) };

  const current = overrides[name];
  const previous = (SKILL_VISIBILITIES as readonly unknown[]).includes(current)
    ? (current as SkillVisibility)
    : "on";

  if (visibility === "on") delete overrides[name];
  else overrides[name] = visibility;

  if (Object.keys(overrides).length > 0) settings.skillOverrides = overrides;
  else delete settings.skillOverrides;

  const tmp = join(dirname(target), `.${basename(target)}.anima-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  if (existsSync(target)) chmodSync(tmp, statSync(target).mode & 0o777);
  renameSync(tmp, target);

  return { name, previous, visibility };
}
