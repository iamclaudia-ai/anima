/**
 * Shared vendor JS bundler for the web SPA.
 *
 * Each vendor bundle wraps a single bare specifier (e.g. "react", "@anima/ui")
 * as an ESM module served at /vendor/<slug>.js. The SPA's importmap (added
 * in Phase 2) resolves bare imports inside extension bundles to these URLs,
 * so each shared dep ships exactly once.
 *
 * Built once at gateway startup; cached in memory for the lifetime of the
 * process. Stub entry files are written to ~/.anima/cache/web-vendor-entries/
 * since Bun.build requires file paths as entrypoints.
 *
 * Keep VENDOR_SPECS in sync with SHARED_EXTERNALS in extension-bundler.ts.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "@anima/shared";
import { exactExternalsPlugin } from "./extension-bundler";
import { ASSET_PUBLIC_PATH, ingestBuildAssets } from "./asset-cache";

const log = createLogger("VendorBundler", join(homedir(), ".anima", "logs", "gateway.log"));

const PROJECT_ROOT = join(import.meta.dir, "..", "..", "..", "..");
// Entries must live inside the project tree so Bun's node_modules resolution
// finds React, @anima/ui, etc. via workspace hoisting. Gitignored.
const ENTRY_DIR = join(import.meta.dir, "..", "..", ".web-vendor-entries");

interface VendorSpec {
  /** Bare specifier the bundle wraps (e.g. "react", "@anima/ui"). */
  specifier: string;
  /** URL slug used in /vendor/<slug>.js — kept stable + filesystem-safe. */
  slug: string;
  /** Bare specifiers to NOT inline; the importmap resolves these on the client. */
  externals: string[];
}

/**
 * Order matters only for log readability — each spec is independently buildable.
 * The externals form a DAG: lower-level deps appear earlier so it's easy to
 * eyeball that no spec externalizes itself or a downstream package.
 *
 * Note: @anima/shared is intentionally NOT in this list — it imports node:crypto
 * and other Node-only APIs that fail in a browser build. Extensions inline the
 * browser-safe bits they need (mostly types, which are erased anyway).
 *
 * Named-export lists are discovered at runtime via dynamic import — see
 * discoverNamedExports — so this list never needs hand-maintenance when React
 * adds/removes APIs across versions.
 */
const VENDOR_SPECS: VendorSpec[] = [
  { specifier: "react", slug: "react", externals: [] },
  // jsx-runtime intentionally inlines its own React copy. Externalizing react
  // here triggers a Bun CJS-to-ESM lifting bug: React's source has
  //   var React = require("react"); ... React = { react_stack_bottom_frame: ... };
  // which Bun converts into `import * as React from "react"` (immutable
  // binding) + the later reassignment, throwing "Assignment to constant
  // variable" at module evaluation. Inlined React is fine for jsx-runtime —
  // element creation is pure (no hook state), and React's runtime type tags
  // use Symbol.for("react.*") which are globally cached across copies.
  { specifier: "react/jsx-runtime", slug: "react-jsx-runtime", externals: [] },
  { specifier: "react/jsx-dev-runtime", slug: "react-jsx-dev-runtime", externals: [] },
  { specifier: "react-dom", slug: "react-dom", externals: ["react"] },
  {
    specifier: "react-dom/client",
    slug: "react-dom-client",
    externals: ["react", "react-dom"],
  },
  {
    specifier: "@anima/ui",
    slug: "anima-ui",
    externals: [
      "react",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "react-dom",
      "react-dom/client",
    ],
  },
];

/**
 * Dynamic-import the specifier in the gateway runtime to discover its named
 * exports. Bun's CJS interop unifies both CJS and ESM into a flat namespace,
 * so `Object.keys(mod)` gives us every name a browser-side `import { name }`
 * could ask for. Without this, `export *` from a CJS module (React) emits
 * `__reExport(internalObj, ...)` and never exposes ESM named exports — the
 * browser then fails at module evaluation with "does not provide an export
 * named X" the first time anything tries to `import { Fragment } from "react"`.
 */
async function discoverNamedExports(specifier: string): Promise<string[]> {
  try {
    const mod = (await import(specifier)) as Record<string, unknown>;
    return Object.keys(mod).filter((key) => key !== "default");
  } catch (error) {
    log.warn("Failed to discover named exports for vendor module", {
      specifier,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export interface VendorBundle {
  slug: string;
  specifier: string;
  js: string;
}

const cache = new Map<string, VendorBundle>();

/**
 * In-flight build promise. Memoizes `buildVendorBundles()` so concurrent
 * callers (startup warm-up + first /vendor/* request) share one build pass
 * instead of racing. Cleared after settle so a future explicit rebuild
 * (e.g. dev tooling) can re-enter.
 */
let inFlight: Promise<Map<string, VendorBundle>> | null = null;

async function writeEntryFile(spec: VendorSpec, names: string[]): Promise<string> {
  mkdirSync(ENTRY_DIR, { recursive: true });
  const path = join(ENTRY_DIR, `${spec.slug}.ts`);
  const target = JSON.stringify(spec.specifier);
  // Explicit named re-export works correctly for both CJS and ESM sources
  // with Bun. `export *` would silently drop named exports from CJS modules.
  const contents =
    names.length > 0
      ? `export { ${names.join(", ")} } from ${target};\nexport { default } from ${target};\n`
      : `export * from ${target};\nexport { default } from ${target};\n`;
  writeFileSync(path, contents);
  return path;
}

/**
 * Build all vendor bundles. Idempotent — call once at startup. Failures for
 * individual bundles are logged and skipped; the gateway keeps running so
 * the existing static-import SPA path stays operational.
 */
export async function buildVendorBundles(): Promise<Map<string, VendorBundle>> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      return await buildVendorBundlesImpl();
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

async function buildVendorBundlesImpl(): Promise<Map<string, VendorBundle>> {
  for (const spec of VENDOR_SPECS) {
    if (cache.has(spec.slug)) continue;

    const names = await discoverNamedExports(spec.specifier);
    const entryPath = await writeEntryFile(spec, names);

    try {
      const result = await Bun.build({
        entrypoints: [entryPath],
        target: "browser",
        format: "esm",
        plugins: [exactExternalsPlugin(spec.externals)],
        minify: false,
        sourcemap: "none",
        // See note in extension-bundler.ts re: not setting `root`.
        publicPath: ASSET_PUBLIC_PATH,
      });

      if (!result.success || result.outputs.length === 0) {
        log.error("Vendor bundle failed", {
          specifier: spec.specifier,
          slug: spec.slug,
          logs: result.logs.map((entry) => String(entry)),
        });
        continue;
      }

      const jsOutput =
        result.outputs.find((output) => output.kind === "entry-point") ?? result.outputs[0];
      if (!jsOutput) {
        log.error("Vendor bundle had no usable output", { specifier: spec.specifier });
        continue;
      }

      const js = await jsOutput.text();
      // Capture any non-JS assets the bundle emitted (PNGs, fonts, etc.) into
      // the shared asset cache so the gateway's /assets/* route can serve them.
      await ingestBuildAssets(result.outputs);
      cache.set(spec.slug, { slug: spec.slug, specifier: spec.specifier, js });
      log.info("Built vendor bundle", {
        specifier: spec.specifier,
        slug: spec.slug,
        bytes: js.length,
      });
    } catch (error) {
      log.error("Vendor bundle threw", {
        specifier: spec.specifier,
        slug: spec.slug,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return cache;
}

/** Look up a built vendor bundle by slug. Returns null if not found. */
export function getVendorBundle(slug: string): VendorBundle | null {
  return cache.get(slug) ?? null;
}

/**
 * Importmap mapping bare specifiers to /vendor/<slug>.js URLs. Phase 2 will
 * inject this into index.html so extension bundles can use bare imports.
 */
export function getImportmap(): { imports: Record<string, string> } {
  const imports: Record<string, string> = {};
  for (const spec of VENDOR_SPECS) {
    imports[spec.specifier] = `/vendor/${spec.slug}.js`;
  }
  return { imports };
}

/** Names of all vendor specs — used for /vendor/list endpoint sanity checks. */
export function getVendorSlugs(): string[] {
  return VENDOR_SPECS.map((spec) => spec.slug);
}
