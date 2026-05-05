/**
 * Extension-contributed static URL routes.
 *
 * Three sources contribute, merged by URL `path` in precedence order
 * (lowest → highest):
 *
 *   1. Convention — any `extensions/<id>/static/` directory on disk auto-
 *      registers as `/<id>/static` → that dir. No code or config needed,
 *      so UI-only extensions get static serving for free.
 *   2. Code — declared via `AnimaExtension.webStatic` in the extension's
 *      server-side index.ts. Picked up at extension registration.
 *   3. Config — `extensions.<id>.webStatic` in anima.json. Useful for
 *      relocating homedir-based paths (`~/...`) without touching code.
 *
 * Resolution rules for the `root` field:
 *   "~/foo"  → join(homedir(), "foo")              (home-relative)
 *   "./foo"  → join(extensions/<id>/, "foo")       (extension-relative)
 *   "/abs"   → absolute (used as-is)
 *
 * Security: every served path is verified to remain inside its resolved root —
 * any "../" traversal that escapes is rejected with 404.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize, relative } from "node:path";
import { createLogger } from "@anima/shared";
import type { WebStaticPath } from "@anima/shared";

const log = createLogger("StaticPaths", join(homedir(), ".anima", "logs", "gateway.log"));

// Project root: from packages/gateway/src/web/static-paths.ts → up 4 levels.
const PROJECT_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const EXTENSIONS_DIR = join(PROJECT_ROOT, "extensions");

interface ResolvedStaticEntry {
  /** Owning extension id. */
  extensionId: string;
  /** URL prefix (no trailing slash). */
  urlPrefix: string;
  /** Absolute filesystem root. */
  fsRoot: string;
}

/**
 * Resolve a single WebStaticPath's `root` to an absolute filesystem path.
 * Returns null if the form is unrecognised.
 */
function resolveRoot(extensionId: string, root: string): string | null {
  let resolved: string;
  if (root.startsWith("~/")) {
    resolved = join(homedir(), root.slice(2));
  } else if (root.startsWith("./")) {
    resolved = join(EXTENSIONS_DIR, extensionId, root.slice(2));
  } else if (root.startsWith("/")) {
    resolved = root;
  } else {
    log.warn("Unrecognised webStatic root form (must start with ~/, ./ or /)", {
      extensionId,
      root,
    });
    return null;
  }
  resolved = normalize(resolved);
  if (!existsSync(resolved)) {
    // Still register — directory may be created later. We just won't find
    // files until it does.
    log.warn("webStatic root does not exist on disk", { extensionId, root, resolved });
  }
  return resolved;
}

/**
 * Merge two WebStaticPath lists by `path` — entries from `overrides` replace
 * matching entries in `base`; new override entries get appended. Order from
 * `base` is preserved for stability.
 */
export function mergeWebStatic(
  base: WebStaticPath[] | undefined,
  overrides: WebStaticPath[] | undefined,
): WebStaticPath[] {
  const baseList = base ?? [];
  const overrideList = overrides ?? [];
  if (overrideList.length === 0) return baseList;
  const overrideByPath = new Map(overrideList.map((entry) => [entry.path, entry]));
  const merged: WebStaticPath[] = baseList.map((entry) => overrideByPath.get(entry.path) ?? entry);
  const basePaths = new Set(baseList.map((entry) => entry.path));
  for (const entry of overrideList) {
    if (!basePaths.has(entry.path)) merged.push(entry);
  }
  return merged;
}

/**
 * Discover convention-based webStatic for a single extension by checking for
 * an `extensions/<id>/static/` directory. Returns an empty array if not found.
 */
export function discoverConventionWebStatic(extensionId: string): WebStaticPath[] {
  const dir = join(EXTENSIONS_DIR, extensionId, "static");
  if (!existsSync(dir)) return [];
  try {
    if (!statSync(dir).isDirectory()) return [];
  } catch {
    return [];
  }
  return [{ path: `/${extensionId}/static`, root: "./static" }];
}

/**
 * Walk `extensions/*` to find every extension that has a `static/` subdir.
 * Used at gateway startup to seed the registry with convention entries before
 * any extension registers via NDJSON — so UI-only extensions (like bogart)
 * get static serving without ever spawning a server-side process.
 */
export function discoverAllConventionWebStatic(): Array<{
  extensionId: string;
  paths: WebStaticPath[];
}> {
  const result: Array<{ extensionId: string; paths: WebStaticPath[] }> = [];
  if (!existsSync(EXTENSIONS_DIR)) return result;
  let entries: string[];
  try {
    entries = readdirSync(EXTENSIONS_DIR);
  } catch (error) {
    log.warn("Failed to scan extensions directory for static dirs", {
      error: error instanceof Error ? error.message : String(error),
    });
    return result;
  }
  for (const id of entries) {
    if (id.startsWith(".")) continue;
    const paths = discoverConventionWebStatic(id);
    if (paths.length > 0) result.push({ extensionId: id, paths });
  }
  return result;
}

/**
 * Tracks resolved static-path entries. The caller is responsible for merging
 * the three sources (convention/code/config) and calling `set` with the final
 * list per extension. Lookup is by longest-prefix match.
 */
export class StaticPathRegistry {
  /** Resolved entries keyed by extension id. */
  private byExtension = new Map<string, ResolvedStaticEntry[]>();

  /** Replace this extension's static entries with a fresh resolved set. */
  set(extensionId: string, paths: WebStaticPath[]): void {
    if (paths.length === 0) {
      if (this.byExtension.delete(extensionId)) {
        log.info("Cleared static paths", { extensionId });
      }
      return;
    }
    const resolved: ResolvedStaticEntry[] = [];
    for (const entry of paths) {
      const fsRoot = resolveRoot(extensionId, entry.root);
      if (!fsRoot) continue;
      const urlPrefix = entry.path.replace(/\/+$/, "");
      resolved.push({ extensionId, urlPrefix, fsRoot });
    }
    this.byExtension.set(extensionId, resolved);
    log.info("Registered static paths", {
      extensionId,
      count: resolved.length,
      paths: resolved.map((e) => `${e.urlPrefix} → ${e.fsRoot}`),
    });
  }

  /** Drop all entries owned by an extension. Idempotent. */
  delete(extensionId: string): void {
    if (this.byExtension.delete(extensionId)) {
      log.info("Cleared static paths on unregister", { extensionId });
    }
  }

  /**
   * Resolve a request pathname to an absolute filesystem path, or null if no
   * registered prefix matches. Performs `..` containment so traversal out of
   * the root is rejected.
   */
  resolveFsPath(pathname: string): string | null {
    // Flatten + sort by descending prefix length so a more specific prefix
    // wins over a shorter one if the prefix space overlaps.
    const candidates = Array.from(this.byExtension.values())
      .flat()
      .sort((a, b) => b.urlPrefix.length - a.urlPrefix.length);
    for (const entry of candidates) {
      // Prefix must be followed by "/" or end-of-string to count as a match.
      if (pathname !== entry.urlPrefix && !pathname.startsWith(`${entry.urlPrefix}/`)) {
        continue;
      }
      const tail = pathname.slice(entry.urlPrefix.length).replace(/^\/+/, "");
      if (tail === "") return null; // Don't serve directory listings.
      const candidate = normalize(join(entry.fsRoot, tail));
      // Ensure `..` segments didn't escape the root.
      const rel = relative(entry.fsRoot, candidate);
      if (rel.startsWith("..") || rel.startsWith("/")) return null;
      return candidate;
    }
    return null;
  }

  /** Snapshot of current entries — for diagnostics / health endpoint. */
  list(): ResolvedStaticEntry[] {
    return Array.from(this.byExtension.values()).flat();
  }
}

/**
 * Map a filename's extension to a Content-Type. Conservative defaults; when in
 * doubt we fall back to application/octet-stream and let the browser sniff.
 */
export function contentTypeFor(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return (
    {
      // Audio
      mp3: "audio/mpeg",
      wav: "audio/wav",
      ogg: "audio/ogg",
      m4a: "audio/mp4",
      // Images
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
      // Text / data
      json: "application/json",
      md: "text/markdown; charset=utf-8",
      txt: "text/plain; charset=utf-8",
      // Web
      js: "application/javascript; charset=utf-8",
      css: "text/css; charset=utf-8",
      html: "text/html; charset=utf-8",
    }[ext] ?? "application/octet-stream"
  );
}
