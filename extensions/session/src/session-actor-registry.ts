import type { RequestContext } from "./session-types";
import { mergeTags } from "./session-types";

interface RoutingOptions {
  source?: string;
  connectionId?: string;
  tags?: string[];
}

interface PendingTurn {
  resolve: (result: { text: string; sessionId: string; stopReason: string }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface BindPromptResult {
  preservedPrimaryConnectionId: string | null;
}

class SessionPromptActor {
  private requestContext: RequestContext | null = null;
  private primaryContext: RequestContext | null = null;
  private pendingTurn: PendingTurn | null = null;

  bindPromptRequest(
    requestContext: RequestContext,
    options: { promoteToPrimary: boolean },
  ): BindPromptResult {
    const existingPrimary = this.primaryContext;

    if (options.promoteToPrimary) {
      this.primaryContext = requestContext;
    }

    this.requestContext = requestContext;

    if (
      existingPrimary &&
      !options.promoteToPrimary &&
      existingPrimary.connectionId !== requestContext.connectionId
    ) {
      return { preservedPrimaryConnectionId: existingPrimary.connectionId };
    }

    return { preservedPrimaryConnectionId: null };
  }

  bindNotificationRequest(requestContext: RequestContext): void {
    this.requestContext = requestContext;
  }

  getRoutingOptions(): RoutingOptions | undefined {
    const emitOptions: RoutingOptions = {};
    if (this.requestContext?.source) emitOptions.source = this.requestContext.source;

    const connectionId = this.primaryContext?.connectionId ?? this.requestContext?.connectionId;
    if (connectionId) emitOptions.connectionId = connectionId;

    const tags = mergeTags(this.primaryContext?.tags ?? null, this.requestContext?.tags ?? null);
    if (tags) emitOptions.tags = tags;

    return Object.keys(emitOptions).length > 0 ? emitOptions : undefined;
  }

  appendResponseText(text: string): void {
    if (this.requestContext) {
      this.requestContext.responseText += text;
    }
  }

  beginTurn(
    sessionId: string,
    timeoutMs: number,
  ): Promise<{ text: string; sessionId: string; stopReason: string }> {
    if (this.pendingTurn) {
      this.pendingTurn.reject(new Error("Prompt superseded by a newer request"));
      clearTimeout(this.pendingTurn.timer);
      this.pendingTurn = null;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTurn = null;
        this.clearPromptState();
        reject(new Error("Prompt timed out after 5 minutes"));
      }, timeoutMs);

      this.pendingTurn = { resolve, reject, timer };
    });
  }

  completeTurn(sessionId: string, stopReason: string): { responseChars: number } {
    const responseChars = this.requestContext?.responseText.length || 0;
    if (this.pendingTurn) {
      const pending = this.pendingTurn;
      this.pendingTurn = null;
      clearTimeout(pending.timer);
      pending.resolve({
        text: this.requestContext?.responseText || "",
        sessionId,
        stopReason,
      });
      this.clearPromptState();
    }
    return { responseChars };
  }

  failTurn(error: Error): void {
    if (!this.pendingTurn) return;
    const pending = this.pendingTurn;
    this.pendingTurn = null;
    clearTimeout(pending.timer);
    pending.reject(error);
    this.clearPromptState();
  }

  clear(): void {
    this.failTurn(new Error("Session closed"));
    this.clearPromptState();
  }

  getResponseTextLength(): number {
    return this.requestContext?.responseText.length || 0;
  }

  private clearPromptState(): void {
    this.requestContext = null;
    this.primaryContext = null;
  }
}

export class SessionActorRegistry {
  private actors = new Map<string, SessionPromptActor>();

  bindPromptRequest(
    sessionId: string,
    requestContext: RequestContext,
    options: { streaming: boolean },
  ): BindPromptResult {
    return this.getActor(sessionId).bindPromptRequest(requestContext, {
      promoteToPrimary:
        options.streaming && Array.isArray(requestContext.tags) && requestContext.tags.length > 0,
    });
  }

  bindNotificationRequest(sessionId: string, requestContext: RequestContext): void {
    this.getActor(sessionId).bindNotificationRequest(requestContext);
  }

  beginTurn(
    sessionId: string,
    timeoutMs: number,
  ): Promise<{ text: string; sessionId: string; stopReason: string }> {
    return this.getActor(sessionId).beginTurn(sessionId, timeoutMs);
  }

  completeTurn(sessionId: string, stopReason: string): { responseChars: number } {
    return this.getActor(sessionId).completeTurn(sessionId, stopReason);
  }

  failTurn(sessionId: string, error: Error): void {
    const actor = this.actors.get(sessionId);
    actor?.failTurn(error);
  }

  appendResponseText(sessionId: string, text: string): void {
    const actor = this.actors.get(sessionId);
    actor?.appendResponseText(text);
  }

  getRoutingOptions(sessionId: string): RoutingOptions | undefined {
    return this.actors.get(sessionId)?.getRoutingOptions();
  }

  getResponseTextLength(sessionId: string): number {
    return this.actors.get(sessionId)?.getResponseTextLength() || 0;
  }

  clearSession(sessionId: string): void {
    const actor = this.actors.get(sessionId);
    if (!actor) return;
    actor.clear();
    this.actors.delete(sessionId);
  }

  private getActor(sessionId: string): SessionPromptActor {
    let actor = this.actors.get(sessionId);
    if (!actor) {
      actor = new SessionPromptActor();
      this.actors.set(sessionId, actor);
    }
    return actor;
  }
}
