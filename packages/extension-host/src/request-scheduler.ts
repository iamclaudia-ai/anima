import type {
  ExtensionMethodConcurrency,
  ExtensionMethodDefinition,
  ExtensionMethodExecution,
  ExtensionMethodLane,
} from "@anima/shared";

interface ScheduleOptions {
  method: string;
  params: Record<string, unknown>;
  connectionId?: string | null;
  work: () => Promise<void>;
}

interface MethodExecutionPolicy {
  lane: ExtensionMethodLane;
  concurrency: ExtensionMethodConcurrency;
  keyParam?: string;
  keyContext?: "connectionId";
}

const DEFAULT_POLICY: MethodExecutionPolicy = {
  lane: "write",
  concurrency: "serial",
};

export class RequestScheduler {
  private readonly policies = new Map<string, MethodExecutionPolicy>();
  private readonly laneChains = new Map<string, Promise<void>>();
  private readonly keyChains = new Map<string, Promise<void>>();

  constructor(methods: ExtensionMethodDefinition[]) {
    for (const method of methods) {
      this.policies.set(method.name, this.normalizePolicy(method.execution));
    }
  }

  schedule(options: ScheduleOptions): void {
    const policy = this.policies.get(options.method) ?? DEFAULT_POLICY;

    if (policy.concurrency === "parallel") {
      void options.work();
      return;
    }

    if (policy.concurrency === "keyed") {
      const keyValue = this.resolveKeyValue(policy, options);
      const chainKey = `${policy.lane}:${keyValue}`;
      this.enqueue(this.keyChains, chainKey, options.work);
      return;
    }

    this.enqueue(this.laneChains, policy.lane, options.work);
  }

  private enqueue(
    chains: Map<string, Promise<void>>,
    key: string,
    work: () => Promise<void>,
  ): void {
    const previous = chains.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(work)
      .finally(() => {
        if (chains.get(key) === next) {
          chains.delete(key);
        }
      });
    chains.set(key, next);
  }

  private normalizePolicy(execution?: ExtensionMethodExecution): MethodExecutionPolicy {
    return {
      lane: execution?.lane ?? DEFAULT_POLICY.lane,
      concurrency: execution?.concurrency ?? DEFAULT_POLICY.concurrency,
      keyParam: execution?.keyParam,
      keyContext: execution?.keyContext,
    };
  }

  private resolveKeyValue(policy: MethodExecutionPolicy, options: ScheduleOptions): string {
    if (policy.keyParam) {
      const paramValue = options.params[policy.keyParam];
      if (typeof paramValue === "string") return paramValue;
      if (typeof paramValue === "number") return String(paramValue);
    }

    if (policy.keyContext === "connectionId" && options.connectionId) {
      return options.connectionId;
    }

    return "__default__";
  }
}
