#!/usr/bin/env bun

import { evaluatePolicy } from "./policies";
import { parseShell } from "./parse";

async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "policy";
  const source = await readStdin();

  switch (mode) {
    case "parse":
      writeJson(await parseShell(source));
      return;
    case "policy": {
      const parse = await parseShell(source);
      writeJson(evaluatePolicy(parse));
      return;
    }
    default:
      process.stderr.write(`Unknown mode: ${mode}\n`);
      process.exit(2);
  }
}

main().catch((error) => {
  writeJson({
    ok: false,
    denyReason: null,
    skipTokf: false,
    fallback: "runtime-error",
    warnings: [error instanceof Error ? error.message : String(error)],
  });
  process.exit(0);
});
