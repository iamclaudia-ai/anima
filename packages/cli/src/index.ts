#!/usr/bin/env bun
/**
 * Anima CLI - Gateway client
 *
 * Usage:
 *   anima "Hello, how are you?"
 *   anima workspace list
 *   anima session send_prompt --sessionId ses_123 --content "Hello"
 *   anima voice speak --text "Hello"
 *   anima methods
 */

import { createGatewayClient } from "@anima/shared";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_GATEWAY_URL = "ws://localhost:30086/ws";
let gatewayUrl = process.env.ANIMA_GATEWAY_URL || DEFAULT_GATEWAY_URL;

function normalizeGatewayUrl(value: string): string {
  const input = value.trim();
  if (!input) return DEFAULT_GATEWAY_URL;

  if (input.startsWith("ws://") || input.startsWith("wss://")) {
    return input;
  }

  if (input.startsWith("http://") || input.startsWith("https://")) {
    const parsed = new URL(input);
    parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    if (!parsed.pathname || parsed.pathname === "/") parsed.pathname = "/ws";
    return parsed.toString();
  }

  return `ws://${input.replace(/\/+$/, "")}/ws`;
}

function extractGlobalConnectionArgs(rawArgs: string[]): {
  args: string[];
  resolvedGatewayUrl: string;
} {
  const args: string[] = [];
  let hostOverride: string | undefined;
  let urlOverride: string | undefined;

  for (let i = 0; i < rawArgs.length; i += 1) {
    const token = rawArgs[i] ?? "";

    if (token === "--host") {
      const next = rawArgs[i + 1];
      if (!next) throw new Error("Missing value for --host");
      hostOverride = next;
      i += 1;
      continue;
    }
    if (token.startsWith("--host=")) {
      hostOverride = token.slice("--host=".length);
      continue;
    }

    if (token === "--gateway-url") {
      const next = rawArgs[i + 1];
      if (!next) throw new Error("Missing value for --gateway-url");
      urlOverride = next;
      i += 1;
      continue;
    }
    if (token.startsWith("--gateway-url=")) {
      urlOverride = token.slice("--gateway-url=".length);
      continue;
    }

    args.push(token);
  }

  const resolvedGatewayUrl = normalizeGatewayUrl(urlOverride || hostOverride || gatewayUrl);
  return { args, resolvedGatewayUrl };
}

export interface JsonSchema {
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  definitions?: Record<string, JsonSchema>;
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  enum?: unknown[];
  items?: JsonSchema | JsonSchema[];
}

export interface MethodCatalogEntry {
  method: string;
  source: "gateway" | "extension";
  extensionId?: string;
  extensionName?: string;
  description?: string;
  inputSchema?: JsonSchema;
}

export interface InjectSessionIdResult {
  didInject: boolean;
  error?: string;
}

export function coerceValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;

  if (/^-?\d+(\.\d+)?$/.test(value)) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }

  // Template variables like {{date}} start with {{ — don't try to parse as JSON
  if (
    (value.startsWith("[") && value.endsWith("]")) ||
    (value.startsWith("{") && value.endsWith("}") && !value.startsWith("{{"))
  ) {
    try {
      return JSON.parse(value);
    } catch (e) {
      throw new Error(
        `Failed to parse JSON parameter: ${value}\n${String(e)}\nHint: Wrap JSON in single quotes — --param '{"key":"value"}'`,
      );
    }
  }

  return value;
}

/**
 * Set a value at a dot-separated path in a nested object.
 * e.g. setNestedValue(obj, "action.type", "notification")
 *   → obj.action = { type: "notification" }
 */
function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (
      current[part] === undefined ||
      typeof current[part] !== "object" ||
      current[part] === null
    ) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

export function parseCliParams(rawArgs: string[]): Record<string, unknown> {
  const params: Record<string, unknown> = {};

  for (let i = 0; i < rawArgs.length; i += 1) {
    const token = rawArgs[i];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${token}. Use --name value.`);
    }

    const flag = token.slice(2);
    if (!flag) throw new Error("Invalid flag: --");

    let key: string;
    let raw: string | undefined;

    const eqIdx = flag.indexOf("=");
    if (eqIdx >= 0) {
      key = flag.slice(0, eqIdx);
      raw = flag.slice(eqIdx + 1);
    } else {
      key = flag;
      const next = rawArgs[i + 1];
      if (!next || next.startsWith("--")) {
        setNestedValue(params, key, true);
        continue;
      }
      raw = next;
      i += 1;
    }

    const value = coerceValue(raw);

    // Support dot notation: --action.type notification → { action: { type: "notification" } }
    if (key.includes(".")) {
      setNestedValue(params, key, value);
    } else {
      params[key] = value;
    }
  }

  return params;
}

export function resolveRef(root: JsonSchema, ref: string): JsonSchema | undefined {
  if (!ref.startsWith("#/")) return undefined;
  const segments = ref
    .slice(2)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = root;
  for (const segment of segments) {
    if (
      !current ||
      typeof current !== "object" ||
      !(segment in (current as Record<string, unknown>))
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current as JsonSchema;
}

export function resolveSchema(
  schema: JsonSchema | undefined,
  root: JsonSchema | undefined,
  depth = 0,
): JsonSchema | undefined {
  if (!schema) return undefined;
  if (!root) return schema;
  if (!schema.$ref || depth > 20) return schema;

  const referenced = resolveRef(root, schema.$ref);
  if (!referenced) return schema;

  const resolvedRef = resolveSchema(referenced, root, depth + 1) ?? referenced;
  const { $ref: _unusedRef, ...inlineOverrides } = schema;
  return { ...resolvedRef, ...inlineOverrides };
}

export function schemaType(schema?: JsonSchema, root?: JsonSchema): string {
  const resolved = resolveSchema(schema, root ?? schema) ?? schema;
  if (!resolved) return "unknown";
  if (resolved.type) return resolved.type;
  if (resolved.anyOf?.length) {
    return resolved.anyOf.map((s) => schemaType(s, root ?? resolved)).join("|");
  }
  if (resolved.allOf?.length) {
    return resolved.allOf.map((s) => schemaType(s, root ?? resolved)).join("&");
  }
  return "unknown";
}

export function matchesSchemaType(value: unknown, schema: JsonSchema, root: JsonSchema): boolean {
  const resolved = resolveSchema(schema, root) ?? schema;
  if (resolved.anyOf?.length) return resolved.anyOf.some((s) => matchesSchemaType(value, s, root));
  if (resolved.allOf?.length) return resolved.allOf.every((s) => matchesSchemaType(value, s, root));
  if (resolved.enum && !resolved.enum.includes(value)) return false;

  switch (resolved.type) {
    case undefined:
      return true;
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array": {
      if (!Array.isArray(value)) return false;
      if (!resolved.items) return true;
      if (Array.isArray(resolved.items)) return true;
      return value.every((v) => matchesSchemaType(v, resolved.items as JsonSchema, root));
    }
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    default:
      return true;
  }
}

export function validateParamsAgainstSchema(
  method: string,
  params: Record<string, unknown>,
  schema?: JsonSchema,
): void {
  if (!schema) return;
  const root = schema;
  const resolvedSchema = resolveSchema(schema, root) ?? schema;
  if (resolvedSchema.type !== "object") return;

  const required = resolvedSchema.required ?? [];
  const missing = required.filter((k) => !(k in params));
  if (missing.length > 0) {
    throw new Error(`Missing required params for ${method}: ${missing.join(", ")}`);
  }

  const properties = resolvedSchema.properties ?? {};
  if (resolvedSchema.additionalProperties === false) {
    const allowed = new Set(Object.keys(properties));
    const unknown = Object.keys(params).filter((k) => !allowed.has(k));
    if (unknown.length > 0) {
      throw new Error(`Unknown params for ${method}: ${unknown.join(", ")}`);
    }
  }

  for (const [key, value] of Object.entries(params)) {
    const propSchema = properties[key];
    if (!propSchema) continue;
    if (!matchesSchemaType(value, propSchema, root)) {
      const expectedType = schemaType(propSchema, root);
      const actualType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      throw new Error(
        `Invalid type for ${method}.${key}: expected ${expectedType}, got ${actualType}`,
      );
    }
  }
}

export function injectSessionIdFromEnv(
  params: Record<string, unknown>,
  methodDef: MethodCatalogEntry,
  resolvedMethod: string,
  env: Record<string, string | undefined> = process.env,
): InjectSessionIdResult {
  if (params.sessionId || !methodDef.inputSchema) {
    return { didInject: false };
  }

  const schema =
    resolveSchema(methodDef.inputSchema, methodDef.inputSchema) ?? methodDef.inputSchema;
  const hasSessionId = schema.type === "object" && schema.properties?.sessionId;
  if (!hasSessionId) return { didInject: false };

  const isRequired = schema.required?.includes("sessionId") ?? false;
  if (env.ANIMA_SESSION_ID) {
    params.sessionId = env.ANIMA_SESSION_ID;
    return { didInject: true };
  }
  if (isRequired) {
    return {
      didInject: false,
      error: `${resolvedMethod} requires --sessionId but $ANIMA_SESSION_ID is not set.`,
    };
  }

  return { didInject: false };
}

/**
 * Auto-inject `cwd` from process.cwd() when the method schema has an
 * optional `cwd` property and the caller didn't provide one explicitly.
 * This lets users run `anima session get_memory_context` without --cwd.
 */
export function injectCwdFromProcess(
  params: Record<string, unknown>,
  methodDef: MethodCatalogEntry,
): void {
  if (params.cwd) return;
  if (!methodDef.inputSchema) return;

  const schema =
    resolveSchema(methodDef.inputSchema, methodDef.inputSchema) ?? methodDef.inputSchema;
  const hasCwd = schema.type === "object" && schema.properties?.cwd;
  if (!hasCwd) return;

  params.cwd = process.cwd();
}

export function splitMethod(method: string): { namespace: string; action: string } | null {
  const idx = method.indexOf(".");
  if (idx <= 0 || idx >= method.length - 1) return null;
  return {
    namespace: method.slice(0, idx),
    action: method.slice(idx + 1),
  };
}

export function formatFlagPlaceholder(name: string, required: boolean): string {
  const token = name.toUpperCase();
  return required ? `<${token}>` : `[${token}]`;
}

export function formatMethodCommand(entry: MethodCatalogEntry): string {
  const split = splitMethod(entry.method);
  if (!split) return `anima ${entry.method}`;

  const rootSchema = entry.inputSchema;
  const schema = resolveSchema(rootSchema, rootSchema) ?? rootSchema;
  if (!schema || schema.type !== "object") {
    return `anima ${split.namespace} ${split.action}`;
  }

  const required = new Set(schema.required ?? []);
  const props = schema.properties ? Object.entries(schema.properties) : [];
  const flagParts = props.map(
    ([name]) => `--${name} ${formatFlagPlaceholder(name, required.has(name))}`,
  );

  const suffix = flagParts.length > 0 ? ` ${flagParts.join(" ")}` : "";
  return `anima ${split.namespace} ${split.action}${suffix}`;
}

export function printMethodHelp(entry: MethodCatalogEntry): void {
  const split = splitMethod(entry.method);
  const command = split ? `anima ${split.namespace} ${split.action}` : `anima ${entry.method}`;

  console.log(`\n`);
  if (entry.description) console.log(`  ${entry.description}`);
  console.log(`  Usage: ${formatMethodCommand(entry)}`);

  const rootSchema = entry.inputSchema;
  const schema = resolveSchema(rootSchema, rootSchema) ?? rootSchema;
  if (!schema || schema.type !== "object") {
    console.log("  No input schema available.");
    return;
  }

  const required = new Set(schema.required ?? []);
  const props = schema.properties ? Object.entries(schema.properties) : [];
  if (props.length === 0) {
    console.log("  No parameters.");
    return;
  }

  console.log("  Parameters:");
  for (const [name, prop] of props) {
    const req = required.has(name) ? "required" : "optional";
    const resolvedProp = resolveSchema(prop, rootSchema) ?? prop;
    const type = schemaType(resolvedProp, rootSchema);
    const desc = resolvedProp.description ? ` - ${resolvedProp.description}` : "";
    const placeholder = formatFlagPlaceholder(name, required.has(name));
    console.log(`    --${name} ${placeholder} (${type}, ${req})${desc}`);
  }
}

export function exampleValueForSchema(
  schema: JsonSchema | undefined,
  root: JsonSchema | undefined,
): string {
  const resolved = resolveSchema(schema, root) ?? schema;
  if (!resolved) return '"value"';

  if (resolved.enum && resolved.enum.length > 0) {
    return JSON.stringify(resolved.enum[0]);
  }

  if (resolved.anyOf && resolved.anyOf.length > 0) {
    return exampleValueForSchema(resolved.anyOf[0], root);
  }
  if (resolved.allOf && resolved.allOf.length > 0) {
    return exampleValueForSchema(resolved.allOf[0], root);
  }

  switch (resolved.type) {
    case "string":
      return '"value"';
    case "number":
      return "1.23";
    case "integer":
      return "1";
    case "boolean":
      return "true";
    case "null":
      return "null";
    case "array":
      if (Array.isArray(resolved.items) || !resolved.items) return "'[]'";
      return `'[${exampleValueForSchema(resolved.items, root)}]'`;
    case "object":
      return "'{}'";
    default:
      return '"value"';
  }
}

export function printMethodExamples(entry: MethodCatalogEntry): void {
  const split = splitMethod(entry.method);
  const command = split ? `${split.namespace} ${split.action}` : entry.method;
  console.log(`\nanima ${command} examples`);

  const rootSchema = entry.inputSchema;
  const schema = resolveSchema(rootSchema, rootSchema) ?? rootSchema;
  if (!schema || schema.type !== "object") {
    console.log(`  anima ${command}`);
    return;
  }

  const props = schema.properties ? Object.entries(schema.properties) : [];
  const required = new Set(schema.required ?? []);
  if (!split) {
    console.log(`  anima ${entry.method}`);
    return;
  }

  const requiredFlags = props
    .filter(([name]) => required.has(name))
    .map(([name, prop]) => `--${name} ${exampleValueForSchema(prop, rootSchema)}`);

  const optionalFlags = props
    .filter(([name]) => !required.has(name))
    .map(([name, prop]) => `--${name} ${exampleValueForSchema(prop, rootSchema)}`);

  if (requiredFlags.length === 0 && optionalFlags.length === 0) {
    console.log(`  anima ${split.namespace} ${split.action}`);
    return;
  }

  const requiredCmd = `anima ${split.namespace} ${split.action} ${requiredFlags.join(" ")}`.trim();
  console.log(`  ${requiredCmd}`);

  if (optionalFlags.length > 0) {
    const mixed =
      `${requiredCmd} ${optionalFlags.slice(0, Math.min(2, optionalFlags.length)).join(" ")}`.trim();
    console.log(`  ${mixed}`);
  }
}

export function getNamespaces(methods: MethodCatalogEntry[]): string[] {
  const names = new Set<string>();
  for (const m of methods) {
    const split = splitMethod(m.method);
    names.add(split ? split.namespace : m.method);
  }
  return Array.from(names).sort();
}

export function printNamespaceHelp(namespace: string, methods: MethodCatalogEntry[]): void {
  const rows = methods
    .filter((m) => splitMethod(m.method)?.namespace === namespace)
    .sort((a, b) => a.method.localeCompare(b.method));

  if (rows.length === 0) {
    console.error(`Unknown namespace: ${namespace}`);
    return;
  }

  console.log(`\nNamespace: ${namespace}`);
  for (const entry of rows) {
    console.log(`  ${formatMethodCommand(entry)}`);
  }
}

export function printMethodList(methods: MethodCatalogEntry[], namespace?: string): void {
  const sorted = [...methods].sort((a, b) => a.method.localeCompare(b.method));
  const filtered = namespace
    ? sorted.filter((m) => splitMethod(m.method)?.namespace === namespace)
    : sorted;

  if (namespace && filtered.length === 0) {
    console.error(`Unknown namespace: ${namespace}`);
    return;
  }

  console.log("Available commands:\n");
  for (const entry of filtered) {
    console.log(`  ${formatMethodCommand(entry)}`);
  }
}

export function printCliHelp(methods: MethodCatalogEntry[]): void {
  console.log("Anima CLI — gateway client for the Anima AI assistant platform.\n");
  console.log("Usage:\n");
  console.log("  anima <namespace> <action> --param value  Call a method");
  console.log("  anima <namespace> <action> --help          Show method help");
  console.log("  anima <namespace> <action> --examples      Show usage examples");
  console.log("  anima <namespace> --help                   List namespace methods");
  console.log("  anima methods [namespace]                  List all available methods");
  console.log("  (global) --host <host[:port]>                Override gateway host for this call");
  console.log("  (global) --gateway-url <ws(s)://.../ws>      Override full gateway URL");

  console.log("\nNamespaces:\n");
  for (const ns of getNamespaces(methods)) {
    console.log(`  ${ns}`);
  }

  console.log("\nSession ID:\n");
  console.log("  Commands that require a --sessionId will auto-detect it from the");
  console.log("  $ANIMA_SESSION_ID environment variable. When running inside a");
  console.log("  Anima session, this is set automatically — one will be provided");
  console.log("  for you at no extra charge. Pass --sessionId explicitly to override.");
}

async function fetchMethodCatalog(): Promise<MethodCatalogEntry[]> {
  const client = createGatewayClient({ url: gatewayUrl });
  try {
    const payload = (await client.call("gateway.list_methods", {})) as {
      methods?: MethodCatalogEntry[];
    };
    return payload.methods ?? [];
  } finally {
    client.disconnect();
  }
}

async function invokeMethod(method: string, params: Record<string, unknown>): Promise<void> {
  const client = createGatewayClient({ url: gatewayUrl });
  const streamPrompt = method === "session.send_prompt";
  let stopStreamResolve: (() => void) | null = null;
  const stopStream = new Promise<void>((resolve) => {
    stopStreamResolve = resolve;
  });
  let unsub: (() => void) | null = null;

  try {
    if (streamPrompt) {
      unsub = client.on("session.*", (event, payload) => {
        const streamPayload = (payload || {}) as Record<string, unknown>;

        if (event.includes(".content_block_delta")) {
          const delta = streamPayload.delta as { type?: string; text?: string } | undefined;
          if (delta?.type === "text_delta" && delta.text) {
            process.stdout.write(delta.text);
          }
        }

        if (event.includes(".message_stop")) {
          process.stdout.write("\n");
          stopStreamResolve?.();
        }
      });

      await client.subscribe(["session.*"]);
    }

    const payload = await client.call(method, params);
    if (!streamPrompt) {
      if (payload !== undefined) {
        console.log(JSON.stringify(payload, null, 2));
      }
      return;
    }

    await Promise.race([stopStream, Bun.sleep(1500)]);
  } finally {
    unsub?.();
    client.disconnect();
  }
}

async function speak(text: string): Promise<void> {
  const client = createGatewayClient({ url: gatewayUrl });
  let playbackQueue = Promise.resolve();
  let finishResolve: (() => void) | null = null;
  let finishReject: ((error: Error) => void) | null = null;
  const done = new Promise<void>((resolve, reject) => {
    finishResolve = resolve;
    finishReject = reject;
  });

  const unsubscribe = client.on("voice.*", (event, payload) => {
    if (event === "voice.audio") {
      const voicePayload = payload as { format: string; data: string };
      playbackQueue = playbackQueue.then(async () => {
        const audioBuffer = Buffer.from(voicePayload.data, "base64");
        const ext = voicePayload.format === "wav" ? "wav" : voicePayload.format || "bin";
        const tempFile = `/tmp/anima-speech-${Date.now()}.${ext}`;
        await Bun.write(tempFile, audioBuffer);

        const proc = Bun.spawn(["afplay", tempFile], { stdout: "ignore", stderr: "ignore" });
        await proc.exited;
        if (await Bun.file(tempFile).exists()) {
          Bun.spawn(["rm", tempFile]);
        }
      });
      return;
    }

    if (event === "voice.done") {
      void playbackQueue.finally(() => finishResolve?.());
      return;
    }

    if (event === "voice.error") {
      const voicePayload = payload as { error: string };
      finishReject?.(new Error(voicePayload.error));
    }
  });

  try {
    await client.subscribe(["voice.*"]);
    await client.call("voice.speak", { text });
    await done;
  } finally {
    unsubscribe();
    client.disconnect();
  }
}

async function promptCompat(args: string[]): Promise<void> {
  let prompt = args.join(" ");
  if (prompt.startsWith("-p ")) {
    prompt = prompt.slice(3);
  }

  if (!prompt) {
    const stdin = await Bun.stdin.text();
    prompt = stdin.trim();
  }

  if (!prompt) {
    console.error('Usage: anima "your message here"');
    process.exit(1);
  }

  const client = createGatewayClient({ url: gatewayUrl });
  let responseText = "";
  let isComplete = false;
  let sessionRecordId: string | null = null;
  const onSigint = () => {
    console.log("\nInterrupted");
    client.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", onSigint);

  const unsub = client.on("session.*", (event, payload) => {
    const streamPayload = payload as Record<string, unknown>;
    if (event.includes(".content_block_delta")) {
      const delta = streamPayload.delta as { type: string; text?: string } | undefined;
      if (delta?.type === "text_delta" && delta.text) {
        process.stdout.write(delta.text);
        responseText += delta.text;
      }
      return;
    }

    if (event.includes(".message_stop")) {
      isComplete = true;
      if (responseText && !responseText.endsWith("\n")) console.log();
    }
  });

  try {
    await client.subscribe(["session.*"]);
    await client.call("session.get_or_create_workspace", { cwd: process.cwd() });

    const sessionsResult = (await client.call("session.list_sessions", {
      cwd: process.cwd(),
    })) as { sessions?: Array<{ sessionId: string }> };

    const existing = sessionsResult.sessions?.[0];
    if (existing) {
      sessionRecordId = existing.sessionId;
      console.error(`[session] Reusing ${sessionRecordId}`);
    } else {
      const created = (await client.call("session.create_session", {
        cwd: process.cwd(),
      })) as { sessionId?: string };
      if (!created.sessionId) {
        throw new Error("session.create_session did not return sessionId");
      }
      sessionRecordId = created.sessionId;
      console.error(`[session] Created ${sessionRecordId}`);
    }

    await client.call("session.send_prompt", {
      sessionId: sessionRecordId,
      content: prompt,
    });

    if (!isComplete) {
      await Bun.sleep(1500);
    }

    if (!isComplete && !responseText) {
      console.error("Connection closed before response");
      process.exit(1);
    }
    process.exit(0);
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    unsub();
    process.off("SIGINT", onSigint);
    client.disconnect();
  }
}

// ── Watchdog CLI ─────────────────────────────────────────

const WATCHDOG_URL = process.env.ANIMA_WATCHDOG_URL || "http://localhost:30085";

const WATCHDOG_METHODS: MethodCatalogEntry[] = [
  {
    method: "watchdog.status",
    source: "gateway",
    description: "Show watchdog and service health status",
  },
  {
    method: "watchdog.restart",
    source: "gateway",
    description: "Restart a managed service (gateway or runtime)",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service to restart: gateway or runtime" },
      },
      required: ["service"],
    },
  },
  {
    method: "watchdog.logs",
    source: "gateway",
    description: "List available log files",
  },
  {
    method: "watchdog.log_tail",
    source: "gateway",
    description: "Tail a log file",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Log file name (e.g. gateway.log)" },
        lines: { type: "integer", description: "Number of lines to show (default: 50)" },
      },
      required: ["file"],
    },
  },
  {
    method: "watchdog.install",
    source: "gateway",
    description: "Install watchdog as a launchd service (start on login)",
  },
  {
    method: "watchdog.uninstall",
    source: "gateway",
    description: "Uninstall watchdog launchd service",
  },
];

function escapePlistValue(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function renderWatchdogPlist(params: {
  homeDir: string;
  projectDir: string;
  executable: string[];
}): string {
  const programArguments = params.executable
    .map((arg) => `    <string>${escapePlistValue(arg)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.anima.watchdog</string>

  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>

  <key>WorkingDirectory</key>
  <string>${escapePlistValue(params.projectDir)}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapePlistValue(process.env.PATH || "")}</string>
    <key>HOME</key>
    <string>${escapePlistValue(params.homeDir)}</string>
    <key>ANIMA_PROJECT_DIR</key>
    <string>${escapePlistValue(params.projectDir)}</string>
  </dict>

  <key>KeepAlive</key>
  <true/>

  <key>RunAtLoad</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${escapePlistValue(resolve(params.homeDir, ".anima", "logs", "watchdog-launchd.log"))}</string>

  <key>StandardErrorPath</key>
  <string>${escapePlistValue(resolve(params.homeDir, ".anima", "logs", "watchdog-launchd.log"))}</string>
</dict>
</plist>
`;
}

function getWatchdogLaunchCommand(projectDir: string): string[] {
  const homeDir = process.env.HOME;
  const deployedBinary = homeDir ? resolve(homeDir, ".anima", "bin", "watchdog") : "";
  if (deployedBinary && existsSync(deployedBinary)) {
    return [deployedBinary];
  }

  const bunPath = process.execPath;
  return [bunPath, "run", "watchdog"];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

async function watchdogCommand(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help") {
    console.log("\nwatchdog commands:\n");
    console.log("  anima watchdog status                  Show service health");
    console.log("  anima watchdog restart <service> [--force]  Restart gateway or runtime");
    console.log("  anima watchdog logs                    List available log files");
    console.log("  anima watchdog logs <file> [lines]     Tail a log file");
    console.log("  anima watchdog install                 Install as launchd service");
    console.log("  anima watchdog uninstall               Uninstall launchd service");
    return;
  }

  if (sub === "status") {
    try {
      const res = await fetch(`${WATCHDOG_URL}/status`, { signal: AbortSignal.timeout(3000) });
      const data = (await res.json()) as Record<
        string,
        {
          name: string;
          processAlive: boolean;
          healthy: boolean;
          consecutiveFailures: number;
          lastRestart: string | null;
          healthReason?: string | null;
        }
      >;
      console.log();
      for (const [id, s] of Object.entries(data)) {
        if (typeof s.processAlive !== "boolean") {
          const healthy = (s as { healthy?: boolean }).healthy === true;
          const dot = healthy ? "\x1b[32m●\x1b[0m" : "\x1b[33m●\x1b[0m";
          console.log(`  ${dot} ${s.name || id} ${healthy ? "healthy" : "unhealthy"}`);
          continue;
        }
        const dot = s.healthy
          ? "\x1b[32m●\x1b[0m"
          : s.processAlive
            ? "\x1b[33m●\x1b[0m"
            : "\x1b[31m●\x1b[0m";
        const status = s.healthy ? "healthy" : s.processAlive ? "unhealthy" : "down";
        const restart = s.lastRestart ? new Date(s.lastRestart).toLocaleTimeString() : "never";
        const reason = s.healthy ? "" : `  reason: ${s.healthReason || "n/a"}`;
        console.log(
          `  ${dot} ${s.name.padEnd(10)} ${status.padEnd(12)} failures: ${s.consecutiveFailures}  last restart: ${restart}${reason}`,
        );
      }
      console.log();
    } catch {
      console.error("Error: Could not connect to watchdog at", WATCHDOG_URL);
      console.error("Is the watchdog running? Start with: bun run watchdog");
      process.exit(1);
    }
    return;
  }

  if (sub === "restart") {
    const service = args[1];
    const force = args.includes("--force");
    if (!service) {
      console.error("Usage: anima watchdog restart <gateway|runtime> [--force]");
      process.exit(1);
    }
    try {
      const suffix = force ? "?force=1" : "";
      const res = await fetch(`${WATCHDOG_URL}/restart/${service}${suffix}`, {
        method: "POST",
        signal: AbortSignal.timeout(10000),
      });
      const data = (await res.json()) as { ok: boolean; message: string };
      console.log(data.ok ? `✓ ${data.message}` : `✗ ${data.message}`);
    } catch {
      console.error("Error: Could not connect to watchdog at", WATCHDOG_URL);
      process.exit(1);
    }
    return;
  }

  if (sub === "logs") {
    const file = args[1];

    if (!file) {
      // List log files
      try {
        const res = await fetch(`${WATCHDOG_URL}/api/logs`, { signal: AbortSignal.timeout(3000) });
        const data = (await res.json()) as {
          files: { name: string; size: number; modified: string }[];
        };
        console.log("\nAvailable log files:\n");
        for (const f of data.files) {
          const mod = new Date(f.modified).toLocaleString();
          console.log(`  ${f.name.padEnd(25)} ${formatBytes(f.size).padStart(8)}  ${mod}`);
        }
        console.log(`\nTail a file: anima watchdog logs <filename> [lines]\n`);
      } catch {
        console.error("Error: Could not connect to watchdog at", WATCHDOG_URL);
        process.exit(1);
      }
      return;
    }

    // Tail a specific log file
    const lineCount = parseInt(args[2] || "50", 10);
    try {
      const res = await fetch(
        `${WATCHDOG_URL}/api/logs/${encodeURIComponent(file)}?lines=${lineCount}`,
        { signal: AbortSignal.timeout(5000) },
      );
      const data = (await res.json()) as { lines?: string[]; error?: string; fileSize?: number };
      if (data.error) {
        console.error(`Error: ${data.error}`);
        process.exit(1);
      }
      if (data.lines) {
        for (const line of data.lines) {
          // Colorize output
          if (line.includes("[ERROR]")) {
            console.log(`\x1b[31m${line}\x1b[0m`);
          } else if (line.includes("[WARN]")) {
            console.log(`\x1b[33m${line}\x1b[0m`);
          } else {
            console.log(line);
          }
        }
        if (data.fileSize) {
          console.log(
            `\n\x1b[90m--- ${data.lines.length} lines (${formatBytes(data.fileSize)} total) ---\x1b[0m`,
          );
        }
      }
    } catch {
      console.error("Error: Could not connect to watchdog at", WATCHDOG_URL);
      process.exit(1);
    }
    return;
  }

  if (sub === "install") {
    const plistName = "com.anima.watchdog.plist";
    const plistDst = `${process.env.HOME}/Library/LaunchAgents/${plistName}`;

    try {
      const homeDir = process.env.HOME;
      if (!homeDir) {
        console.error("Error: HOME is not set");
        process.exit(1);
      }

      const projectDir = resolve(dirname(import.meta.dir), "..", "..");
      const launchCommand = getWatchdogLaunchCommand(projectDir);
      const plist = renderWatchdogPlist({
        homeDir,
        projectDir,
        executable: launchCommand,
      });

      mkdirSync(resolve(homeDir, "Library", "LaunchAgents"), { recursive: true });
      mkdirSync(resolve(homeDir, ".anima", "logs"), { recursive: true });
      await Bun.write(plistDst, plist);
      console.log(`Wrote plist to ${plistDst}`);

      const load = Bun.spawn(["launchctl", "load", plistDst], {
        stdout: "inherit",
        stderr: "inherit",
      });
      await load.exited;
      console.log("✓ Watchdog installed and loaded. It will start on login.");
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
    return;
  }

  if (sub === "uninstall") {
    const plistName = "com.anima.watchdog.plist";
    const plistDst = `${process.env.HOME}/Library/LaunchAgents/${plistName}`;

    try {
      const unload = Bun.spawn(["launchctl", "unload", plistDst], {
        stdout: "inherit",
        stderr: "inherit",
      });
      await unload.exited;

      const file = Bun.file(plistDst);
      if (await file.exists()) {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(plistDst);
      }
      console.log("✓ Watchdog uninstalled and unloaded.");
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown watchdog command: ${sub}`);
  console.error("Run 'anima watchdog --help' for usage.");
  process.exit(1);
}

// ── Main ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const parsed = extractGlobalConnectionArgs(process.argv.slice(2));
  gatewayUrl = parsed.resolvedGatewayUrl;
  const args = parsed.args;

  if (args[0] === "speak") {
    const text = args.slice(1).join(" ");
    if (!text) {
      console.error('Usage: anima speak "text to speak"');
      process.exit(1);
    }
    await speak(text);
    return;
  }

  if (args[0] === "watchdog") {
    await watchdogCommand(args.slice(1));
    return;
  }

  const methods = [...(await fetchMethodCatalog()), ...WATCHDOG_METHODS];
  const methodMap = new Map(methods.map((m) => [m.method, m] as const));

  if (args.length === 0) {
    printCliHelp(methods);
    return;
  }

  if (args[0] === "help" || args[0] === "--help") {
    printCliHelp(methods);
    return;
  }

  if (args[0] === "methods") {
    printMethodList(methods, args[1]);
    return;
  }

  if (args.length === 2 && args[1] === "--help") {
    printNamespaceHelp(args[0], methods);
    return;
  }

  let resolvedMethod: string | null = null;
  let paramArgs: string[] = [];

  if (args[0].includes(".") && methodMap.has(args[0])) {
    resolvedMethod = args[0];
    paramArgs = args.slice(1);
  } else if (args.length >= 2) {
    const candidate = `${args[0]}.${args[1]}`;
    if (methodMap.has(candidate)) {
      resolvedMethod = candidate;
      paramArgs = args.slice(2);
    }
  }

  if (!resolvedMethod) {
    // Check if the first arg looks like a known namespace
    const namespaces = new Set(methods.map((m) => m.method.split(".")[0]));
    if (namespaces.has(args[0])) {
      console.error(`Unknown method: ${args[0]}.${args[1] || "?"}\n`);
      printNamespaceHelp(args[0], methods);
    } else {
      console.error(`Unknown command: ${args.join(" ")}\n`);
      printCliHelp(methods);
    }
    process.exit(1);
  }

  const methodDef = methodMap.get(resolvedMethod)!;

  if (paramArgs.includes("--help")) {
    printMethodHelp(methodDef);
    return;
  }
  if (paramArgs.includes("--examples")) {
    printMethodExamples(methodDef);
    return;
  }

  const params = parseCliParams(paramArgs);

  // Auto-inject sessionId from $ANIMA_SESSION_ID if not explicitly provided
  const injectionResult = injectSessionIdFromEnv(params, methodDef, resolvedMethod);
  if (injectionResult.error) {
    console.error(`Error: ${injectionResult.error}`);
    console.error(`Either pass --sessionId explicitly or run from within a Anima session.\n`);
    printMethodHelp(methodDef);
    process.exit(1);
  }

  // Auto-inject cwd from process.cwd() if the method accepts it and it wasn't provided
  injectCwdFromProcess(params, methodDef);

  validateParamsAgainstSchema(resolvedMethod, params, methodDef.inputSchema);
  await invokeMethod(resolvedMethod, params);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
