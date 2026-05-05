/**
 * In-memory cache for build-time-bundled assets.
 *
 * When a TS/TSX module does `import sprite from "./sprite.png"`, Bun's
 * bundler emits the PNG as a separate output (`kind: "asset"`) with a
 * content-hashed filename, and rewrites the import to a URL string of the
 * form `<publicPath>/sprite-<hash>.png`. We capture those asset outputs from
 * each Bun.build call and serve them from the gateway at /assets/<filename>.
 *
 * Hash-based filenames mean any cache duration is safe — different content
 * produces a different URL.
 */

import { basename } from "node:path";
import { contentTypeFor } from "./static-paths";

export interface CachedAsset {
  bytes: Uint8Array;
  contentType: string;
}

const cache = new Map<string, CachedAsset>();

/** URL prefix all bundlers use for emitted asset references. */
export const ASSET_PUBLIC_PATH = "/assets/";

/**
 * Capture every `kind: "asset"` output from a Bun.build result. Idempotent —
 * subsequent builds (e.g. extension hot-reload) overwrite cached entries
 * with the same hashed name.
 */
export async function ingestBuildAssets(outputs: readonly Bun.BuildArtifact[]): Promise<void> {
  for (const output of outputs) {
    if (output.kind !== "asset") continue;
    const filename = basename(output.path ?? "");
    if (!filename) continue;
    const buffer = await output.arrayBuffer();
    const contentType = output.type || contentTypeFor(filename);
    cache.set(filename, { bytes: new Uint8Array(buffer), contentType });
  }
}

export function getAsset(filename: string): CachedAsset | null {
  return cache.get(filename) ?? null;
}

/** For diagnostics — count and total bytes. */
export function assetStats(): { count: number; bytes: number } {
  let bytes = 0;
  for (const asset of cache.values()) bytes += asset.bytes.byteLength;
  return { count: cache.size, bytes };
}
