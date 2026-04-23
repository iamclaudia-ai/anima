#!/usr/bin/env bun

type OutdatedRow = {
  isCatalog: boolean;
  package: string;
  current: string;
  update: string;
  latest: string;
  workspace: string;
};

function fail(message: string): never {
  console.error(`[deps:outdated] ERROR: ${message}`);
  process.exit(1);
}

function parseTable(stdout: string): OutdatedRow[] {
  const rows: OutdatedRow[] = [];
  let headerSeen = false;

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.startsWith("|")) continue;
    if (/^\|[-|]+\|$/.test(line)) continue;

    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());

    if (cells.length !== 5) continue;

    if (
      cells[0] === "Package" &&
      cells[1] === "Current" &&
      cells[2] === "Update" &&
      cells[3] === "Latest" &&
      cells[4] === "Workspace"
    ) {
      headerSeen = true;
      continue;
    }

    if (!headerSeen) continue;

    rows.push({
      isCatalog: cells[4].startsWith("catalog "),
      package: cells[0],
      current: cells[1],
      update: cells[2],
      latest: cells[3],
      workspace: cells[4],
    });
  }

  return rows;
}

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const failOnOutdated = args.includes("--fail-on-outdated");
const passthroughArgs = args.filter((arg) => arg !== "--json" && arg !== "--fail-on-outdated");

if (!passthroughArgs.includes("-r") && !passthroughArgs.includes("--recursive")) {
  passthroughArgs.unshift("-r");
}

const proc = Bun.spawn(["bun", "outdated", ...passthroughArgs, "--no-progress", "--no-summary"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NO_COLOR: "1",
    TERM: "dumb",
  },
  stderr: "pipe",
  stdout: "pipe",
});

const [stdoutText, stderrText, exitCode] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
  proc.exited,
]);

if (exitCode !== 0) {
  if (stderrText.trim()) {
    process.stderr.write(stderrText);
  }
  fail(`bun outdated exited with code ${exitCode}`);
}

const rows = parseTable(stdoutText);

if (jsonMode) {
  console.log(JSON.stringify(rows, null, 2));
} else if (rows.length === 0) {
  console.log("No outdated dependencies.");
} else {
  console.log(["PACKAGE", "CURRENT", "UPDATE", "LATEST", "WORKSPACE"].join("\t"));
  for (const row of rows) {
    console.log(
      [
        row.isCatalog ? `*${row.package}` : row.package,
        row.current,
        row.update,
        row.latest,
        row.workspace,
      ].join("\t"),
    );
  }
}

if (failOnOutdated && rows.length > 0) {
  process.exit(1);
}
