#!/usr/bin/env bun

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

type DependencyField =
  | "dependencies"
  | "devDependencies"
  | "peerDependencies"
  | "optionalDependencies";

type Manifest = {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  catalog?: Record<string, string>;
  catalogs?: Record<string, Record<string, string>>;
};

type Usage = {
  field: DependencyField;
  file: string;
  packageName: string;
  version: string;
};

const ROOT = process.cwd();
const ROOT_PACKAGE_JSON = join(ROOT, "package.json");
const FIELDS: DependencyField[] = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];
const IGNORE_PREFIXES = ["workspace:", "file:", "link:"];

function fail(message: string): never {
  console.error(`[deps:catalog] ERROR: ${message}`);
  process.exit(1);
}

function log(message: string): void {
  console.log(`[deps:catalog] ${message}`);
}

function readJson(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

function writeJson(path: string, manifest: Manifest): void {
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function findPackageJsonFiles(dir: string, depth = 0): string[] {
  if (depth > 3) return [];

  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;

    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findPackageJsonFiles(fullPath, depth + 1));
      continue;
    }

    if (entry.isFile() && entry.name === "package.json") {
      files.push(fullPath);
    }
  }

  return files;
}

function shouldIgnoreVersion(version: string): boolean {
  return IGNORE_PREFIXES.some((prefix) => version.startsWith(prefix));
}

function collectUsages(dependency: string): Usage[] {
  const files = findPackageJsonFiles(ROOT);
  const usages: Usage[] = [];

  for (const file of files) {
    const manifest = readJson(file);
    const packageName = manifest.name ?? relative(ROOT, file);

    for (const field of FIELDS) {
      const dependencies = manifest[field];
      if (!dependencies) continue;

      const version = dependencies[dependency];
      if (!version || shouldIgnoreVersion(version)) continue;

      usages.push({
        field,
        file: relative(ROOT, file),
        packageName,
        version,
      });
    }
  }

  return usages;
}

async function promptYesNo(
  rl: ReturnType<typeof createInterface>,
  question: string,
  defaultYes = true,
): Promise<boolean> {
  const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
  const answer = (await rl.question(`${question}${suffix}`)).trim().toLowerCase();

  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

async function resolveLatestVersion(dependency: string): Promise<string> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(dependency).replace(/%2F/g, "/")}`;
  const response = await fetch(url);

  if (!response.ok) {
    fail(
      `failed to fetch package metadata for ${dependency}: ${response.status} ${response.statusText}`,
    );
  }

  const payload = (await response.json()) as {
    "dist-tags"?: {
      latest?: string;
    };
  };

  const latest = payload["dist-tags"]?.latest;
  if (!latest) fail(`npm registry did not return a latest version for ${dependency}`);

  return latest;
}

function normalizeTargetVersion(target: string | undefined, latest: string): string {
  if (!target || target === "latest") return `^${latest}`;
  return target;
}

async function runInstall(): Promise<void> {
  log("running bun install");
  const proc = Bun.spawn(["bun", "install"], {
    cwd: ROOT,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    fail(`bun install failed with exit code ${exitCode}`);
  }
}

const [, , dependency, requestedTarget] = process.argv;

if (!dependency) {
  console.error("Usage: bun run deps:catalog <package-name> [latest|version-range]");
  process.exit(1);
}

const rootManifest = readJson(ROOT_PACKAGE_JSON);
const rootCatalog = { ...(rootManifest.catalog ?? {}) };
const currentCatalogVersion = rootCatalog[dependency];
const usages = collectUsages(dependency);

if (usages.length === 0 && !currentCatalogVersion) {
  fail(`${dependency} is not declared in any workspace manifest`);
}

const rl = createInterface({ input, output });

try {
  if (!currentCatalogVersion) {
    const usageSummary = [...new Set(usages.map((usage) => usage.version))].join(", ");
    log(
      `${dependency} is used in ${usages.length} manifest entries with versions: ${usageSummary}`,
    );

    const shouldCatalog = await promptYesNo(
      rl,
      `Move ${dependency} into the root catalog and rewrite those usages to catalog:?`,
      true,
    );

    if (!shouldCatalog) {
      log("no changes made");
      process.exit(0);
    }
  } else {
    log(`${dependency} is already in the root catalog as ${currentCatalogVersion}`);
  }

  const latest = await resolveLatestVersion(dependency);
  const nextVersion = normalizeTargetVersion(requestedTarget, latest);

  log(`resolved npm latest for ${dependency}: ${latest}`);
  if (!requestedTarget) {
    const confirmLatest = await promptYesNo(
      rl,
      `Use ${nextVersion} for ${dependency} in the root catalog?`,
      true,
    );
    if (!confirmLatest) {
      const manualVersion = (
        await rl.question("Enter the version or range to write into the catalog: ")
      ).trim();
      if (!manualVersion) fail("no version provided");
      rootCatalog[dependency] = manualVersion;
    } else {
      rootCatalog[dependency] = nextVersion;
    }
  } else {
    rootCatalog[dependency] = nextVersion;
  }

  rootManifest.catalog = rootCatalog;
  writeJson(ROOT_PACKAGE_JSON, rootManifest);
  log(`updated root catalog: ${dependency} -> ${rootCatalog[dependency]}`);

  const rewrittenFiles = new Set<string>();
  for (const usage of usages) {
    const filePath = join(ROOT, usage.file);
    const manifest = readJson(filePath);
    const field = manifest[usage.field];

    if (!field || !field[dependency] || field[dependency] === "catalog:") continue;

    field[dependency] = "catalog:";
    writeJson(filePath, manifest);
    rewrittenFiles.add(usage.file);
  }

  if (rewrittenFiles.size > 0) {
    log(`rewrote ${rewrittenFiles.size} manifest file(s) to use catalog:`);
    for (const file of [...rewrittenFiles].sort()) {
      log(`  ${file}`);
    }
  } else {
    log("all existing usages already referenced catalog:");
  }

  await runInstall();
  log("done");
} finally {
  rl.close();
}
