import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

type DependencyField =
  | "dependencies"
  | "devDependencies"
  | "peerDependencies"
  | "optionalDependencies";

type Manifest = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

type Usage = {
  field: DependencyField;
  file: string;
  packageName: string;
  resolvedVersion: string;
  version: string;
};

type RootManifest = Manifest & {
  catalog?: Record<string, string>;
  catalogs?: Record<string, Record<string, string>>;
};

const ROOT = process.cwd();
const FIELDS: DependencyField[] = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];
const IGNORE_PREFIXES = ["workspace:", "file:", "link:"];
const FAIL_ON_DRIFT = process.argv.includes("--fail-on-drift");
const rootManifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as RootManifest;

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

function resolveCatalogVersion(dependency: string, version: string): string {
  if (!version.startsWith("catalog:")) return version;

  if (version === "catalog:") {
    return rootManifest.catalog?.[dependency] ?? version;
  }

  const catalogName = version.slice("catalog:".length);
  return rootManifest.catalogs?.[catalogName]?.[dependency] ?? version;
}

function loadUsages(): Map<string, Usage[]> {
  const packageJsonFiles = findPackageJsonFiles(ROOT);
  const usages = new Map<string, Usage[]>();

  for (const file of packageJsonFiles) {
    const manifest = JSON.parse(readFileSync(file, "utf8")) as Manifest;
    const packageName = manifest.name ?? relative(ROOT, file);

    for (const field of FIELDS) {
      const deps = manifest[field];
      if (!deps) continue;

      for (const [dependency, version] of Object.entries(deps)) {
        if (shouldIgnoreVersion(version)) continue;

        if (!usages.has(dependency)) usages.set(dependency, []);
        usages.get(dependency)!.push({
          field,
          file: relative(ROOT, file),
          packageName,
          resolvedVersion: resolveCatalogVersion(dependency, version),
          version,
        });
      }
    }
  }

  return usages;
}

const usages = loadUsages();
const repeated = [...usages.entries()]
  .filter(([, entries]) => entries.length > 1)
  .map(([dependency, entries]) => {
    const versions = [...new Set(entries.map((entry) => entry.resolvedVersion))].sort();
    return {
      dependency,
      entries,
      versions,
      hasDrift: versions.length > 1,
    };
  })
  .sort((a, b) => {
    if (a.hasDrift !== b.hasDrift) return a.hasDrift ? -1 : 1;
    if (a.entries.length !== b.entries.length) return b.entries.length - a.entries.length;
    return a.dependency.localeCompare(b.dependency);
  });

const drifting = repeated.filter((entry) => entry.hasDrift);
const aligned = repeated.filter((entry) => !entry.hasDrift);

if (drifting.length === 0) {
  console.log("No external dependency drift found.");
} else {
  console.log("Dependency drift detected:\n");
  for (const entry of drifting) {
    console.log(`${entry.dependency}`);
    console.log(`  versions: ${entry.versions.join(", ")}`);
    for (const usage of entry.entries) {
      console.log(
        `  - ${usage.version} => ${usage.resolvedVersion} in ${usage.file} (${usage.field}, ${usage.packageName})`,
      );
    }
    console.log("");
  }
}

if (aligned.length > 0) {
  console.log("Shared dependencies already aligned:\n");
  for (const entry of aligned) {
    console.log(`${entry.dependency}  ${entry.entries.length} uses  ${entry.versions[0]}`);
  }
}

if (FAIL_ON_DRIFT && drifting.length > 0) {
  process.exit(1);
}
