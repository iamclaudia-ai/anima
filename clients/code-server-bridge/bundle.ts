/**
 * Build script for the Anima Bridge VS Code extension.
 *
 * Bundles src/extension.ts (and its dependencies — `ws`, etc.) into a single
 * dist/extension.js that the VS Code extension host can load directly.
 * `vscode` is externalized — it's provided by the extension host at runtime.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const distDir = join(root, "dist");
const srcDir = join(root, "src");

if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(srcDir, "extension.ts")],
  outdir: distDir,
  target: "node",
  format: "cjs",
  minify: false,
  sourcemap: "external",
  // `vscode` is supplied by the host at runtime — must NOT be bundled.
  // `ws` is a Node module we want inlined so the .vsix is self-contained.
  external: ["vscode"],
});

if (!result.success) {
  console.error("Bundle failed:");
  for (const log of result.logs) {
    console.error(String(log));
  }
  process.exit(1);
}

const output = result.outputs[0];
if (!output) {
  console.error("No bundle output produced");
  process.exit(1);
}
console.log(`Built ${output.path} (${(output.size / 1024).toFixed(1)} KB)`);
