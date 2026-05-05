import type {
  AnimaExtension,
  ExtensionContext,
  ExtensionMcpToolDefinition,
  ExtensionMcpToolResult,
  ExtensionMethodDefinition,
  GatewayEvent,
} from "@anima/shared";

export interface StandardExtensionInstance<TRuntime> {
  ctx: ExtensionContext;
  runtime: TRuntime;
  config: Record<string, unknown>;
}

export interface StandardExtensionMethod<TRuntime = void> {
  definition: ExtensionMethodDefinition;
  handle: (
    params: Record<string, unknown>,
    instance: StandardExtensionInstance<TRuntime>,
  ) => Promise<unknown> | unknown;
}

export interface StandardExtensionDefinition<TRuntime = void> {
  id: string;
  name: string;
  methods: StandardExtensionMethod<TRuntime>[];
  mcpTools?: ExtensionMcpToolDefinition[];
  events: string[];
  sourceRoutes?: string[];
  createRuntime?: (
    ctx: ExtensionContext,
    config: Record<string, unknown>,
  ) => Promise<TRuntime> | TRuntime;
  start?: (instance: StandardExtensionInstance<TRuntime>) => Promise<void> | void;
  stop?: (instance: StandardExtensionInstance<TRuntime>) => Promise<void> | void;
  health?: (instance: StandardExtensionInstance<TRuntime> | null) => {
    ok: boolean;
    details?: Record<string, unknown>;
  };
  handleSourceResponse?: (
    source: string,
    event: GatewayEvent,
    instance: StandardExtensionInstance<TRuntime>,
  ) => Promise<void> | void;
}

export function createStandardExtension<TRuntime = void>(
  definition: StandardExtensionDefinition<TRuntime>,
): (config: Record<string, unknown>) => AnimaExtension {
  return (config) => {
    let instance: StandardExtensionInstance<TRuntime> | null = null;
    const handlers = new Map(
      definition.methods.map((method) => [method.definition.name, method.handle]),
    );
    const mcpToolHandlers = new Map(
      (definition.mcpTools ?? []).map((tool) => [tool.name, tool.handle]),
    );

    return {
      id: definition.id,
      name: definition.name,
      methods: definition.methods.map((method) => method.definition),
      mcpTools: definition.mcpTools,
      events: definition.events,
      sourceRoutes: definition.sourceRoutes,
      async start(extensionContext: ExtensionContext): Promise<void> {
        const runtime =
          (await definition.createRuntime?.(extensionContext, config)) ?? (undefined as TRuntime);
        instance = {
          ctx: extensionContext,
          runtime,
          config,
        };
        await definition.start?.(instance);
      },
      async stop(): Promise<void> {
        if (instance) {
          await definition.stop?.(instance);
        }
        instance = null;
      },
      async handleMethod(method: string, params: Record<string, unknown>): Promise<unknown> {
        if (!instance) {
          throw new Error(`Extension ${definition.id} has not started`);
        }
        const handler = handlers.get(method);
        if (!handler) {
          throw new Error(`Unknown method: ${method}`);
        }
        return await handler(params, instance);
      },
      async handleMcpTool(
        name: string,
        args: Record<string, unknown>,
      ): Promise<ExtensionMcpToolResult> {
        if (!instance) {
          throw new Error(`Extension ${definition.id} has not started`);
        }
        const handler = mcpToolHandlers.get(name);
        if (!handler) {
          throw new Error(`Unknown MCP tool: ${name}`);
        }
        const result = await handler(args, instance.ctx);
        return normalizeMcpToolResult(result);
      },
      async handleSourceResponse(source: string, event: GatewayEvent): Promise<void> {
        if (!definition.handleSourceResponse) {
          throw new Error("Extension does not handle source responses");
        }
        if (!instance) {
          throw new Error(`Extension ${definition.id} has not started`);
        }
        await definition.handleSourceResponse(source, event, instance);
      },
      health() {
        return definition.health?.(instance) ?? { ok: true };
      },
    };
  };
}

function normalizeMcpToolResult(result: unknown): ExtensionMcpToolResult {
  if (
    result &&
    typeof result === "object" &&
    Array.isArray((result as ExtensionMcpToolResult).content)
  ) {
    return result as ExtensionMcpToolResult;
  }

  if (typeof result === "string") {
    return { content: [{ type: "text", text: result }] };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result),
      },
    ],
  };
}
