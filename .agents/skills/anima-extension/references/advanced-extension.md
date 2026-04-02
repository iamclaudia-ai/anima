# Advanced Extension Example

Use this shape for stateful interactive or background extensions.

```ts
import { z } from "zod";
import { createStandardExtension } from "@anima/extension-host";

class ConnectionRegistry {
  private buffers = new Map<string, string[]>();

  append(connectionId: string, text: string): void {
    const existing = this.buffers.get(connectionId) || [];
    existing.push(text);
    this.buffers.set(connectionId, existing);
  }

  read(connectionId: string): string[] {
    return this.buffers.get(connectionId) || [];
  }

  clear(connectionId: string): void {
    this.buffers.delete(connectionId);
  }
}

interface AdvancedRuntime {
  registry: ConnectionRegistry;
  unsubscribers: Array<() => void>;
}

export function createAdvancedExtension(config: Record<string, unknown> = {}) {
  return createStandardExtension<AdvancedRuntime>({
    id: "advanced",
    name: "Advanced",
    createRuntime() {
      return {
        registry: new ConnectionRegistry(),
        unsubscribers: [],
      };
    },
    methods: [
      {
        definition: {
          name: "advanced.append",
          description: "Append text to the current connection buffer",
          inputSchema: z.object({
            text: z.string(),
          }),
          execution: { lane: "write", concurrency: "keyed", keyParam: "connectionId" },
        },
        handle(params, instance) {
          const connectionId = instance.ctx.connectionId;
          if (!connectionId) throw new Error("connectionId required");
          instance.runtime.registry.append(connectionId, String(params.text));
          return { ok: true };
        },
      },
      {
        definition: {
          name: "advanced.read_buffer",
          description: "Read current connection buffer",
          inputSchema: z.object({}),
          execution: { lane: "read", concurrency: "parallel" },
        },
        handle(_params, instance) {
          const connectionId = instance.ctx.connectionId;
          if (!connectionId) return { items: [] };
          return { items: instance.runtime.registry.read(connectionId) };
        },
      },
      {
        definition: {
          name: "advanced.process",
          description: "Run long processing for one resource",
          inputSchema: z.object({
            resourceId: z.string(),
          }),
          execution: { lane: "long_running", concurrency: "keyed", keyParam: "resourceId" },
        },
        async handle(params, instance) {
          instance.ctx.log.info("Processing resource", { resourceId: params.resourceId });
          await Bun.sleep(1000);
          return { ok: true, resourceId: params.resourceId };
        },
      },
    ],
    events: ["advanced.*"],
    async start(instance) {
      const unsub = instance.ctx.on("session.*.message_stop", async (event) => {
        if (!event.connectionId) return;
        instance.runtime.registry.append(event.connectionId, "message_stop");
      });
      instance.runtime.unsubscribers.push(unsub);
    },
    async stop(instance) {
      for (const unsub of instance.runtime.unsubscribers) {
        unsub();
      }
      instance.runtime.unsubscribers.length = 0;
    },
    health(instance) {
      return {
        ok: true,
        details: {
          started: instance !== null,
        },
      };
    },
  })(config);
}
```

Guidance:

- put long-lived clients, registries, watchers, and unsubscribers in runtime
- use keyed concurrency only for the resource that truly needs exclusivity
- do not store per-resource mutable state in loose top-level globals
- prefer small service classes over large bags of maps
