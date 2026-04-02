import type {
  AnimaExtension,
  ExtensionContext,
  ExtensionMethodDefinition,
  GatewayEvent,
} from "@anima/shared";

export interface StandardExtensionMethod {
  definition: ExtensionMethodDefinition;
  handle: (params: Record<string, unknown>, ctx: ExtensionContext) => Promise<unknown> | unknown;
}

export interface StandardExtensionDefinition {
  id: string;
  name: string;
  methods: StandardExtensionMethod[];
  events: string[];
  sourceRoutes?: string[];
  start?: (ctx: ExtensionContext) => Promise<void> | void;
  stop?: () => Promise<void> | void;
  health?: () => { ok: boolean; details?: Record<string, unknown> };
  handleSourceResponse?: (
    source: string,
    event: GatewayEvent,
    ctx: ExtensionContext,
  ) => Promise<void> | void;
}

export function createStandardExtension(
  definition: StandardExtensionDefinition,
): (config: Record<string, unknown>) => AnimaExtension {
  return () => {
    let ctx: ExtensionContext | null = null;
    const handlers = new Map(
      definition.methods.map((method) => [method.definition.name, method.handle]),
    );

    return {
      id: definition.id,
      name: definition.name,
      methods: definition.methods.map((method) => method.definition),
      events: definition.events,
      sourceRoutes: definition.sourceRoutes,
      async start(extensionContext: ExtensionContext): Promise<void> {
        ctx = extensionContext;
        await definition.start?.(extensionContext);
      },
      async stop(): Promise<void> {
        await definition.stop?.();
        ctx = null;
      },
      async handleMethod(method: string, params: Record<string, unknown>): Promise<unknown> {
        if (!ctx) {
          throw new Error(`Extension ${definition.id} has not started`);
        }
        const handler = handlers.get(method);
        if (!handler) {
          throw new Error(`Unknown method: ${method}`);
        }
        return await handler(params, ctx);
      },
      async handleSourceResponse(source: string, event: GatewayEvent): Promise<void> {
        if (!definition.handleSourceResponse) {
          throw new Error("Extension does not handle source responses");
        }
        if (!ctx) {
          throw new Error(`Extension ${definition.id} has not started`);
        }
        await definition.handleSourceResponse(source, event, ctx);
      },
      health() {
        return definition.health?.() ?? { ok: true };
      },
    };
  };
}
