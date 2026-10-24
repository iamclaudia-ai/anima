/**
 * Hands stored deliveries to their hook's target method, retrying with backoff.
 *
 * A delivery is "delivered" once its target returns without throwing (or at
 * once, when the hook has no target: the `webhooks.received` event was its
 * delivery). A target failure schedules a retry; after the last backoff step
 * the delivery is marked "failed" and stays in the inbox for `redeliver`.
 */

import type { LoggerLike } from "@anima/shared";
import type { WebhooksConfig } from "./config";
import type { WebhookStore } from "./store";

/** Delay before retry N (1-based). One initial attempt + these = 6 attempts. */
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000];

/** What a target method receives. */
export interface WebhookDeliveryPayload {
  id: string;
  hook: string;
  receivedAt: string;
  contentType: string | null;
  headers: Record<string, string>;
  /** The raw body, undecoded: parse it yourself (Zoho ids overflow JS numbers). */
  body: string;
}

export interface DispatcherDeps {
  store: WebhookStore;
  getConfig(): WebhooksConfig;
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
  log: LoggerLike;
  now?: () => Date;
}

export function nextAttemptAt(attemptsSoFar: number, from: Date): string | null {
  const delay = RETRY_DELAYS_MS[attemptsSoFar - 1];
  return delay === undefined ? null : new Date(from.getTime() + delay).toISOString();
}

export class Dispatcher {
  private readonly inFlight = new Set<string>();
  private draining = false;

  constructor(private readonly deps: DispatcherDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /**
   * Attempt one delivery. The row is re-read first, so a stale caller (a drain
   * snapshot taken before another attempt finished) can't deliver it twice.
   */
  async dispatch(id: string): Promise<void> {
    if (this.inFlight.has(id)) return;
    const { store, log } = this.deps;
    const delivery = store.get(id);
    if (!delivery || delivery.status !== "pending") return;
    this.inFlight.add(id);
    const attempts = delivery.attempts;

    try {
      const hookConfig = this.deps.getConfig().hooks[delivery.hook];
      const target = hookConfig?.target;
      if (target) {
        const payload: WebhookDeliveryPayload = {
          id: delivery.id,
          hook: delivery.hook,
          receivedAt: delivery.receivedAt,
          contentType: delivery.contentType,
          headers: delivery.headers,
          body: delivery.body,
        };
        await this.deps.call(target, { ...payload });
      }
      store.markDelivered(delivery.id, this.now().toISOString());
      if (target) log.info("Delivered webhook", { hook: delivery.hook, id: delivery.id, target });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryAt = nextAttemptAt(attempts + 1, this.now());
      store.markAttemptFailed(delivery.id, message, retryAt);
      const fields = {
        hook: delivery.hook,
        id: delivery.id,
        attempt: attempts + 1,
        error: message,
      };
      if (retryAt) log.warn("Webhook delivery failed; will retry", { ...fields, retryAt });
      else log.error("Webhook delivery failed; giving up", fields);
    } finally {
      this.inFlight.delete(delivery.id);
    }
  }

  /** Dispatch every pending delivery that is due. Overlapping calls are no-ops. */
  async drain(batchSize = 20): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    try {
      const due = this.deps.store.due(this.now().toISOString(), batchSize);
      for (const delivery of due) {
        await this.dispatch(delivery.id);
      }
      return due.length;
    } finally {
      this.draining = false;
    }
  }
}
