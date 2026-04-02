# Basic Extension Example

Use this shape for small control/read-heavy extensions.

```ts
import { z } from "zod";
import { createStandardExtension } from "@anima/extension-host";

interface DemoRuntime {
  startedAt: string;
}

export function createDemoExtension(config: Record<string, unknown> = {}) {
  return createStandardExtension<DemoRuntime>({
    id: "demo",
    name: "Demo",
    createRuntime() {
      return {
        startedAt: new Date().toISOString(),
      };
    },
    methods: [
      {
        definition: {
          name: "demo.health_check",
          description: "Health status",
          inputSchema: z.object({}),
          execution: { lane: "control", concurrency: "parallel" },
        },
        handle(_params, instance) {
          return {
            ok: true,
            startedAt: instance.runtime.startedAt,
          };
        },
      },
      {
        definition: {
          name: "demo.read_value",
          description: "Read a value",
          inputSchema: z.object({
            key: z.string(),
          }),
          execution: { lane: "read", concurrency: "parallel" },
        },
        async handle(params, instance) {
          return {
            key: params.key,
            connectionId: instance.ctx.connectionId,
            configEcho: instance.config.example ?? null,
          };
        },
      },
    ],
    events: [],
    async start(instance) {
      instance.ctx.log.info("Demo extension started", {
        startedAt: instance.runtime.startedAt,
      });
    },
    async stop(instance) {
      instance.ctx.log.info("Demo extension stopped", {
        startedAt: instance.runtime.startedAt,
      });
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

Notes:

- use `createRuntime()` even when runtime is small
- keep methods small
- declare `execution` metadata everywhere
- use `control` for health and `read` for cheap reads
