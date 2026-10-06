import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_EXTENSIONS_DIR,
  extensionCliPath,
  formatLocalCommands,
  isValidNamespace,
  listExtensionCliNamespaces,
  loadExtensionCli,
} from "./extension-cli";

describe("extension CLI loader", () => {
  let dir: string;

  function writeCli(namespace: string, source: string): void {
    mkdirSync(join(dir, namespace, "src"), { recursive: true });
    writeFileSync(join(dir, namespace, "src", "cli.ts"), source);
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "anima-ext-cli-"));
    writeCli(
      "good",
      `export const cli = { commands: {
        zeta: { description: "last", usage: "<x>", run: async () => 3 },
        alpha: { description: "first", usage: "", run: async () => {} },
      } };`,
    );
    writeCli("noexport", `export const other = 1;`);
    writeCli(
      "badcmd",
      `export const cli = { commands: { broken: { description: "no usage or run" } } };`,
    );
    // Server-only extension: has a directory but contributes no CLI.
    mkdirSync(join(dir, "serveronly", "src"), { recursive: true });
    writeFileSync(join(dir, "serveronly", "src", "index.ts"), "export default {};");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects namespaces that could escape the extensions directory", () => {
    for (const bad of ["", "../etc", "a/b", "Skills", "-x", ".hidden", "a b"]) {
      expect(isValidNamespace(bad)).toBe(false);
      expect(extensionCliPath(bad, dir)).toBeNull();
    }
    expect(isValidNamespace("skills")).toBe(true);
    expect(isValidNamespace("code-server")).toBe(true);
  });

  it("returns null for an extension with no cli.ts", async () => {
    expect(await loadExtensionCli("serveronly", dir)).toBeNull();
    expect(await loadExtensionCli("does-not-exist", dir)).toBeNull();
  });

  it("loads a well-formed contribution and runs its commands", async () => {
    const cli = await loadExtensionCli("good", dir);
    expect(cli).not.toBeNull();
    expect(Object.keys(cli!.commands).sort()).toEqual(["alpha", "zeta"]);
    expect(await cli!.commands.zeta.run([], { gatewayUrl: "ws://x" })).toBe(3);
  });

  it("fails loudly when cli.ts exists but is malformed", async () => {
    await expect(loadExtensionCli("noexport", dir)).rejects.toThrow("must export `cli`");
    await expect(loadExtensionCli("badcmd", dir)).rejects.toThrow('command "broken"');
  });

  it("lists only namespaces that ship a cli.ts, sorted, without importing them", () => {
    expect(listExtensionCliNamespaces(dir)).toEqual(["badcmd", "good", "noexport"]);
    expect(listExtensionCliNamespaces(join(dir, "missing"))).toEqual([]);
  });

  it("formats local commands sorted by name", async () => {
    const cli = await loadExtensionCli("good", dir);
    expect(formatLocalCommands("good", cli!)).toEqual([
      "anima good alpha  — first",
      "anima good zeta <x>  — last",
    ]);
  });
});

/**
 * Conventions every real contribution must keep. These read source statically
 * and never import an extension's server entry, so they cannot reach live state.
 */
describe("real extension CLI contributions", () => {
  const namespaces = listExtensionCliNamespaces();

  it("finds at least the skills contribution", () => {
    expect(namespaces).toContain("skills");
  });

  for (const ns of namespaces) {
    const srcDir = join(DEFAULT_EXTENSIONS_DIR, ns, "src");
    const cliEntry = join(srcDir, "cli.ts");
    const cliDir = join(srcDir, "cli");

    it(`${ns}: cli.ts is well-formed`, async () => {
      const cli = await loadExtensionCli(ns);
      expect(Object.keys(cli!.commands).length).toBeGreaterThan(0);
    });

    it(`${ns}: cli.ts never reaches the server entry or extension-host`, () => {
      const serverEntry = join(srcDir, "index.ts");
      const offenders = localImportGraph(cliEntry).filter(
        ({ specifier }) =>
          specifier === serverEntry || specifier.startsWith("@anima/extension-host"),
      );
      expect(offenders).toEqual([]);
    });

    it(`${ns}: no local command shadows a gateway method`, async () => {
      const cli = await loadExtensionCli(ns);
      const serverSource = sourceFiles(srcDir)
        .filter((f) => f !== cliEntry && !f.startsWith(`${cliDir}/`))
        .map((f) => readFileSync(f, "utf8"))
        .join("\n");
      const shadowed = Object.keys(cli!.commands).filter((name) =>
        serverSource.includes(`"${ns}.${name}"`),
      );
      expect(shadowed).toEqual([]);
    });
  }
});

/** Every import reachable from `entry`, following relative imports only. */
function localImportGraph(entry: string): Array<{ file: string; specifier: string }> {
  const seen = new Set<string>();
  const edges: Array<{ file: string; specifier: string }> = [];
  const queue = [entry];
  // `from "x"`, dynamic `import("x")`, and bare side-effect `import "x"`.
  const importRe = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g;

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(importRe)) {
      const raw = match[1];
      if (!raw.startsWith(".")) {
        edges.push({ file, specifier: raw });
        continue;
      }
      const resolved = resolve(dirname(file), raw).replace(/\.js$/, ".ts");
      const target = existsSync(resolved) ? resolved : `${resolved}.ts`;
      edges.push({ file, specifier: target });
      if (existsSync(target)) queue.push(target);
    }
  }
  return edges;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"))
    .map((e) => join(e.parentPath, e.name));
}
