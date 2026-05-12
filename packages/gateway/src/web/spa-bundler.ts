/**
 * SPA bundler — explicit Bun.build for the gateway's web shell.
 *
 * We can't use Bun's implicit HTML auto-bundling for the SPA anymore: the SPA
 * needs to externalize the same shared deps as extension bundles (React,
 * @anima/ui, etc.) so all three (SPA + every extension bundle) resolve to the
 * SAME module instance via importmap. Otherwise React contexts and reconciler
 * state get duplicated and hooks/rendering break across module boundaries.
 *
 * Built once at startup; cached in memory. Like the other bundlers, failures
 * are logged and surfaced as a 503 — the gateway keeps running.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "@anima/shared";
import tailwindPlugin from "bun-plugin-tailwind";
import { exactExternalsPlugin, SHARED_EXTERNALS } from "./extension-bundler";
import { ASSET_PUBLIC_PATH, ingestBuildAssets } from "./asset-cache";

const log = createLogger("SpaBundler", join(homedir(), ".anima", "logs", "gateway.log"));
const PROJECT_ROOT = join(import.meta.dir, "..", "..", "..", "..");

export interface SpaBundle {
  js: string;
  css: string;
  builtAt: number;
}

let cache: SpaBundle | null = null;
let inFlight: Promise<SpaBundle | null> | null = null;

/** Build (or fetch from cache) the SPA bundle. */
export async function buildSpaBundle(): Promise<SpaBundle | null> {
  if (cache) return cache;
  if (inFlight) return inFlight;

  inFlight = (async (): Promise<SpaBundle | null> => {
    const entryPath = join(import.meta.dir, "index.tsx");
    try {
      const result = await Bun.build({
        entrypoints: [entryPath],
        target: "browser",
        format: "esm",
        plugins: [tailwindPlugin, exactExternalsPlugin(SHARED_EXTERNALS)],
        minify: false,
        sourcemap: "none",
        // See note in extension-bundler.ts re: not setting `root`.
        publicPath: ASSET_PUBLIC_PATH,
      });

      if (!result.success || result.outputs.length === 0) {
        log.error("SPA bundle failed", {
          logs: result.logs.map((entry) => String(entry)),
        });
        return null;
      }

      let js = "";
      let css = "";
      for (const output of result.outputs) {
        const path = output.path ?? "";
        if (output.kind === "entry-point" && !js) {
          js = await output.text();
        } else if (path.endsWith(".css") && !css) {
          css = await output.text();
        } else if (!js && path.endsWith(".js")) {
          js = await output.text();
        }
      }

      if (!js) {
        log.error("SPA bundle produced no JS output");
        return null;
      }

      await ingestBuildAssets(result.outputs);
      cache = { js, css, builtAt: Date.now() };
      log.info("Built SPA bundle", { jsBytes: js.length, cssBytes: css.length });
      return cache;
    } catch (error) {
      log.error("SPA bundle threw", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
