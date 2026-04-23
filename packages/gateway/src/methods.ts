/**
 * Gateway built-in method definitions.
 *
 * Extracted from index.ts so that tooling (e.g. generate-api-reference)
 * can import them without triggering server startup side effects.
 */

import { z, type ZodType } from "zod";

export type GatewayMethodDefinition = {
  method: string;
  description: string;
  inputSchema: ZodType;
};

export const BUILTIN_METHODS: GatewayMethodDefinition[] = [
  {
    method: "gateway.list_methods",
    description: "List all gateway and extension methods with schemas",
    inputSchema: z.object({}),
  },
  {
    method: "gateway.list_extensions",
    description: "List loaded extensions and their methods",
    inputSchema: z.object({}),
  },
  {
    method: "gateway.subscribe",
    description: "Subscribe to events",
    inputSchema: z.object({
      events: z.array(z.string()).optional(),
      exclusive: z.boolean().optional().describe("Last subscriber wins — only one client receives"),
    }),
  },
  {
    method: "gateway.unsubscribe",
    description: "Unsubscribe from events",
    inputSchema: z.object({
      events: z.array(z.string()).optional(),
    }),
  },
  {
    method: "gateway.restart_extension",
    description: "Restart an extension host process (manual HMR for non-hot extensions)",
    inputSchema: z.object({
      extension: z.string().describe("Extension ID to restart (e.g. session, memory, voice)"),
    }),
  },
  {
    method: "gateway.acquire_liveness_lock",
    description: "Acquire or steal a gateway-managed runtime liveness lock for an extension",
    inputSchema: z.object({
      extension: z.string().optional().describe("Extension ID. Omitted for extension ctx.call()."),
      lockType: z.enum(["singleton", "processing", "lease"]).default("singleton"),
      resourceKey: z.string().optional().describe("Resource key for non-singleton leases"),
      holderPid: z.number().int().optional().describe("Owning process PID"),
      holderInstanceId: z.string().describe("Stable instance ID for the lock holder"),
      staleAfterMs: z.number().int().positive().optional().describe("Staleness threshold in ms"),
      metadata: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Extension-defined lock metadata"),
    }),
  },
  {
    method: "gateway.renew_liveness_lock",
    description: "Renew a gateway-managed runtime liveness lock for an extension",
    inputSchema: z.object({
      extension: z.string().optional().describe("Extension ID. Omitted for extension ctx.call()."),
      lockType: z.enum(["singleton", "processing", "lease"]).default("singleton"),
      resourceKey: z.string().optional().describe("Resource key for non-singleton leases"),
      holderPid: z.number().int().optional().describe("Owning process PID"),
      holderInstanceId: z.string().describe("Stable instance ID for the lock holder"),
      staleAfterMs: z.number().int().positive().optional().describe("Staleness threshold in ms"),
      metadata: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Extension-defined lock metadata"),
    }),
  },
  {
    method: "gateway.release_liveness_lock",
    description: "Release a gateway-managed runtime liveness lock for an extension",
    inputSchema: z.object({
      extension: z.string().optional().describe("Extension ID. Omitted for extension ctx.call()."),
      lockType: z.enum(["singleton", "processing", "lease"]).default("singleton"),
      resourceKey: z.string().optional().describe("Resource key for non-singleton leases"),
      holderPid: z.number().int().optional().describe("Owning process PID"),
      holderInstanceId: z.string().describe("Stable instance ID for the lock holder"),
    }),
  },
  {
    method: "gateway.list_liveness_locks",
    description: "List gateway-managed runtime liveness locks",
    inputSchema: z.object({
      extension: z.string().optional().describe("Filter by extension ID"),
    }),
  },
  {
    method: "gateway.register_extension",
    description:
      "Register this WebSocket connection as an extension host. " +
      "Allows native apps to expose methods and emit events via the gateway.",
    inputSchema: z.object({
      id: z.string().describe("Extension ID (e.g. 'menubar', 'ios')"),
      name: z.string().describe("Human-readable extension name"),
      methods: z
        .array(
          z.object({
            name: z.string().describe("Fully-qualified method name (e.g. 'menubar.notify')"),
            description: z.string().describe("Short description for CLI/help output"),
            inputSchema: z
              .record(z.string(), z.unknown())
              .optional()
              .describe("JSON Schema for input validation"),
          }),
        )
        .default([]),
      events: z.array(z.string()).default([]).describe("Events this extension emits"),
      sourceRoutes: z.array(z.string()).default([]).describe("Source routing prefixes"),
    }),
  },
];

export const BUILTIN_METHODS_BY_NAME = new Map(BUILTIN_METHODS.map((m) => [m.method, m] as const));
