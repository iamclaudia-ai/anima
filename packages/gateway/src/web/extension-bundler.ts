/**
 * Per-extension JS bundler for the web SPA.
 *
 * Each extension's `src/routes.ts` is bundled into a standalone ESM module
 * that the SPA can dynamically import (Phase 2). Shared dependencies (React,
 * @anima/ui, etc.) are externalized — the browser resolves them via importmap
 * to vendor bundles served by the gateway, so each shared dep ships exactly
 * once regardless of how many extensions depend on it.
 *
 * Bundles are built lazily on first request and cached in memory keyed by
 * extension ID. To force a rebuild, restart the gateway (or call
 * clearExtensionBundleCache).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "@anima/shared";
import { ASSET_PUBLIC_PATH, ingestBuildAssets } from "./asset-cache";

const log = createLogger("ExtensionBundler", join(homedir(), ".anima", "logs", "gateway.log"));

// Project root: from packages/gateway/src/web/extension-bundler.ts → up 4 levels.
const PROJECT_ROOT = join(import.meta.dir, "..", "..", "..", "..");

/**
 * Bare specifiers shared with vendor bundles + importmap. Every extension
 * bundle externalizes these so the runtime resolves them to vendor URLs.
 *
 * Keep this in sync with VENDOR_SPECS in vendor-bundler.ts.
 *
 * Note: @anima/shared is NOT externalized — it pulls in node:crypto and
 * other Node-only APIs that don't survive a browser build. Extensions inline
 * whatever browser-safe slices they import (mostly types, which are erased).
 */
export const SHARED_EXTERNALS = [
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "react-dom/client",
  "@anima/ui",
];

/**
 * Bun.build's `external: [...]` config does package-name *prefix* matching —
 * `["react"]` also externalizes `react/jsx-runtime`, which would turn the
 * jsx-runtime vendor bundle into an infinite-loop re-export. We need exact
 * specifier matching, which means going through a plugin's onResolve hook.
 *
 * The filter MUST be narrow. A `/.*\/` filter intercepts every internal
 * path lookup during barrel-import optimization (e.g. lucide-react's per-icon
 * sub-modules), which breaks Bun's tree-shaking and leaves dangling
 * `default<N>` references in the bundle. Restrict to bare specifiers only —
 * those that start with a letter or `@` (so we match "react", "react/x",
 * "@anima/ui" but skip relative/absolute paths and node:* imports).
 */
export function exactExternalsPlugin(specifiers: readonly string[]): Bun.BunPlugin {
  const set = new Set(specifiers);
  // Build a regex that matches just the bare specifiers we care about, plus
  // any subpaths off the same package roots. Anchored to avoid catching
  // unrelated imports.
  const escaped = specifiers.map((s) => s.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const filter = new RegExp(`^(${escaped.join("|")})$`);
  return {
    name: "exact-externals",
    setup(build) {
      build.onResolve({ filter }, (args) => {
        if (set.has(args.path)) {
          return { path: args.path, external: true };
        }
        return undefined;
      });
    },
  };
}

export interface ExtensionBundle {
  js: string;
  builtAt: number;
}

const cache = new Map<string, ExtensionBundle>();
const inFlight = new Map<string, Promise<ExtensionBundle | null>>();

/** Resolve the path to an extension's routes entry, if any. */
export function getExtensionRoutesPath(extensionId: string): string | null {
  const candidates = [
    join(PROJECT_ROOT, "extensions", extensionId, "src", "routes.ts"),
    join(PROJECT_ROOT, "extensions", extensionId, "src", "routes.tsx"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Build (or return cached) JS bundle for an extension's web contribution.
 * Returns null when the extension has no routes.ts or the build fails —
 * callers should treat null as "this extension contributes no web routes."
 */
export async function buildExtensionBundle(extensionId: string): Promise<ExtensionBundle | null> {
  const cached = cache.get(extensionId);
  if (cached) return cached;

  const existing = inFlight.get(extensionId);
  if (existing) return existing;

  const promise = (async (): Promise<ExtensionBundle | null> => {
    const entryPath = getExtensionRoutesPath(extensionId);
    if (!entryPath) {
      log.info("Extension has no routes entry; skipping web bundle", { extensionId });
      return null;
    }

    try {
      const result = await Bun.build({
        entrypoints: [entryPath],
        target: "browser",
        format: "esm",
        plugins: [exactExternalsPlugin(SHARED_EXTERNALS)],
        minify: false,
        sourcemap: "none",
        // NOTE: do NOT set `root` — it causes Bun to compute asset URLs as
        // relative paths from the entry to the asset, producing nonsense
        // like "/assets/../../foo.png". Without root, asset URLs are clean
        // "/assets/<filename>" off publicPath. Workspace resolution still
        // works because the entry files live inside the project tree.
        publicPath: ASSET_PUBLIC_PATH,
      });

      if (!result.success || result.outputs.length === 0) {
        log.error("Extension bundle failed", {
          extensionId,
          logs: result.logs.map((entry) => String(entry)),
        });
        return null;
      }

      const jsOutput =
        result.outputs.find((output) => output.kind === "entry-point") ?? result.outputs[0];
      if (!jsOutput) {
        log.error("Extension bundle had no usable output", { extensionId });
        return null;
      }

      const js = await jsOutput.text();
      await ingestBuildAssets(result.outputs);
      const bundle: ExtensionBundle = { js, builtAt: Date.now() };
      cache.set(extensionId, bundle);
      log.info("Built extension web bundle", { extensionId, bytes: js.length });
      return bundle;
    } catch (error) {
      log.error("Extension bundle threw", {
        extensionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      inFlight.delete(extensionId);
    }
  })();

  inFlight.set(extensionId, promise);
  return promise;
}
