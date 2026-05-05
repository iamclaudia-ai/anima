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
 */
const VENDOR_SPECS: VendorSpec[] = [
  { specifier: "react", slug: "react", externals: [] },
  { specifier: "react/jsx-runtime", slug: "react-jsx-runtime", externals: ["react"] },
  { specifier: "react/jsx-dev-runtime", slug: "react-jsx-dev-runtime", externals: ["react"] },
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

export interface VendorBundle {
  slug: string;
  specifier: string;
  js: string;
}

const cache = new Map<string, VendorBundle>();

function ensureEntryFile(spec: VendorSpec): string {
  mkdirSync(ENTRY_DIR, { recursive: true });
  const path = join(ENTRY_DIR, `${spec.slug}.ts`);
  // Re-export everything from the upstream module. `export *` covers named
  // exports; Bun's interop layer handles default re-export at consume time.
  const contents = `export * from ${JSON.stringify(spec.specifier)};\n`;
  writeFileSync(path, contents);
  return path;
}

/**
 * Build all vendor bundles. Idempotent — call once at startup. Failures for
 * individual bundles are logged and skipped; the gateway keeps running so
 * the existing static-import SPA path stays operational.
 */
export async function buildVendorBundles(): Promise<Map<string, VendorBundle>> {
  for (const spec of VENDOR_SPECS) {
    if (cache.has(spec.slug)) continue;

    const entryPath = ensureEntryFile(spec);

    try {
      const result = await Bun.build({
        entrypoints: [entryPath],
        target: "browser",
        format: "esm",
        plugins: [exactExternalsPlugin(spec.externals)],
        minify: false,
        sourcemap: "none",
        root: PROJECT_ROOT,
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
