/**
 * Session permission profiles.
 *
 * A profile is chosen when a session is created, stored on the session's row
 * by the session extension, and sent with every create and prompt, so a
 * session resumed after a restart or an idle reap comes back with the same
 * powers it started with. It is applied at launch (CLI flags / SDK options):
 * the CLI cannot change its permission mode mid-session.
 *
 * Built-ins:
 *   - `yolo`: everything allowed (`bypassPermissions`). Sessions Michael
 *     creates directly.
 *   - `auto`: Claude Code's auto mode, for unattended spawns.
 *
 * More come from `agentHost.sessionProfiles` in anima.json (which may also
 * override a built-in). An unknown name is an error, never a fallback.
 */

export const PERMISSION_MODES = [
  "bypassPermissions",
  "auto",
  "dontAsk",
  "acceptEdits",
  "plan",
  "default",
] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export interface SessionProfile {
  permissionMode: PermissionMode;
  /**
   * The built-in tools the session has at all (CLI `--tools`, SDK `tools`).
   * Omitted: the default set. `[]`: no built-in tools.
   */
  tools?: string[];
  /** Pre-approved tool rules; with `dontAsk`, everything else is denied. */
  allowedTools?: string[];
  /** Denied tool rules, on top of the interactive tools Anima always denies. */
  disallowedTools?: string[];
  /** `anima-only`: load only Anima's extension MCP server, nothing from user config. */
  mcp?: "default" | "anima-only";
  /**
   * Extra MCP servers for an `anima-only` profile, loaded beside Anima's
   * (e.g. `{ "slack": { "type": "http", "url": "https://mcp.slack.com/mcp", … } }`).
   * Same shape as an `.mcp.json` entry. Their tools still need `allowedTools`
   * rules (`mcp__<name>` allows a whole server).
   */
  mcpServers?: Record<string, Record<string, unknown>>;
  /**
   * Ignore user/project/local settings files (and, on the CLI, `--restricted`:
   * no code-running tools, file tools confined to the working directory,
   * bypass mode refused).
   */
  restricted?: boolean;
}

export interface ResolvedProfile extends SessionProfile {
  name: string;
}

/** Profile name used for sessions whose row predates profiles (all were yolo). */
export const LEGACY_PROFILE = "yolo";

export const BUILTIN_PROFILES: Record<string, SessionProfile> = {
  yolo: { permissionMode: "bypassPermissions" },
  auto: { permissionMode: "auto" },
};

const PROFILE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const MCP_SERVER_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

export function resolveProfile(
  name: string,
  configured: Record<string, SessionProfile> = {},
): ResolvedProfile {
  if (!PROFILE_NAME.test(name)) throw new Error(`Invalid session profile name: ${name}`);
  const profile = Object.hasOwn(configured, name)
    ? configured[name]
    : Object.hasOwn(BUILTIN_PROFILES, name)
      ? BUILTIN_PROFILES[name]
      : undefined;
  if (!profile) throw new Error(`Unknown session profile: ${name}`);
  if (!PERMISSION_MODES.includes(profile.permissionMode)) {
    throw new Error(
      `Session profile ${name} has an invalid permissionMode: ${profile.permissionMode}`,
    );
  }
  if (profile.restricted && profile.permissionMode === "bypassPermissions") {
    throw new Error(`Session profile ${name} cannot be restricted and bypass permissions`);
  }
  for (const [server, definition] of Object.entries(profile.mcpServers ?? {})) {
    if (profile.mcp !== "anima-only") {
      throw new Error(`Session profile ${name}: mcpServers needs mcp: "anima-only"`);
    }
    if (!MCP_SERVER_NAME.test(server) || server === "anima") {
      throw new Error(`Session profile ${name} has an invalid MCP server name: ${server}`);
    }
    if (typeof definition?.type !== "string") {
      throw new Error(`Session profile ${name}: MCP server ${server} needs a type`);
    }
  }
  return { name, ...profile };
}

/** Does this profile skip permission checks entirely? */
export function bypassesPermissions(profile: ResolvedProfile): boolean {
  return profile.permissionMode === "bypassPermissions";
}
