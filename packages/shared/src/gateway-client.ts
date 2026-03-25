import type { Event, Message, Pong, Request, Response } from "./protocol";

type WebSocketMessageData = string | ArrayBuffer | ArrayBufferView;

interface WebSocketLike {
  readonly readyState: number;
  onopen: ((...args: any[]) => void) | null;
  onclose: ((...args: any[]) => void) | null;
  onerror: ((...args: any[]) => void) | null;
  onmessage: ((...args: any[]) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

type WebSocketFactory = (url: string) => WebSocketLike;

type PendingRequest = {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type EventListener = (event: string, payload: unknown) => void;
type ConnectionListener = (connected: boolean) => void;

export interface GatewayCallOptions {
  timeoutMs?: number;
  tags?: string[];
}

export interface GatewayClientOptions {
  url: string;
  requestTimeoutMs?: number;
  createSocket?: WebSocketFactory;
  /** Enable auto-reconnect on unexpected disconnects (default: true) */
  autoReconnect?: boolean;
  /** Initial reconnect delay in ms (default: 500). Doubles each attempt up to maxReconnectDelayMs. */
  reconnectDelayMs?: number;
  /** Maximum reconnect delay in ms (default: 30000) */
  maxReconnectDelayMs?: number;
}

export interface GatewayClient {
  readonly url: string;
  readonly isConnected: boolean;
  readonly connectionId: string | null;
  connect(): Promise<void>;
  disconnect(code?: number, reason?: string): void;
  call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: GatewayCallOptions,
  ): Promise<T>;
  subscribe(events: string[], exclusive?: boolean): Promise<unknown>;
  unsubscribe(events: string[]): Promise<unknown>;
  on(pattern: string, listener: EventListener): () => void;
  onConnection(listener: ConnectionListener): () => void;
  emit(event: string, payload: unknown): void;
}

function toMessageString(data: WebSocketMessageData): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  return String(data);
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function matchEventPattern(event: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return event.startsWith(pattern.slice(0, -1));
  return event === pattern;
}

export function createGatewayClient(options: GatewayClientOptions): GatewayClient {
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const socketFactory: WebSocketFactory = options.createSocket ?? ((url) => new WebSocket(url));
  const autoReconnect = options.autoReconnect ?? true;
  const baseReconnectDelay = options.reconnectDelayMs ?? 500;
  const maxReconnectDelay = options.maxReconnectDelayMs ?? 30_000;
  let ws: WebSocketLike | null = null;
  let connectPromise: Promise<void> | null = null;
  let connected = false;
  let currentConnectionId: string | null = null;
  let intentionalDisconnect = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Track active subscriptions so we can restore them after reconnect */
  let activeSubscriptions: { events: string[]; exclusive: boolean }[] = [];
  const pending = new Map<string, PendingRequest>();
  const listeners = new Map<string, Set<EventListener>>();
  const connectionListeners = new Set<ConnectionListener>();

  function notifyConnection(next: boolean): void {
    connected = next;
    for (const listener of connectionListeners) {
      listener(next);
    }
  }

  function clearPending(error: Error): void {
    for (const [id, request] of pending) {
      clearTimeout(request.timeout);
      request.reject(error);
      pending.delete(id);
    }
  }

  function cancelReconnect(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempt = 0;
  }

  function scheduleReconnect(): void {
    if (!autoReconnect || intentionalDisconnect) return;
    // Guard against duplicate timers (e.g. onerror + onclose both firing)
    if (reconnectTimer !== null) return;
    const delay = Math.min(baseReconnectDelay * 2 ** reconnectAttempt, maxReconnectDelay);
    reconnectAttempt++;
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      try {
        await connect();
        // Restore subscriptions after successful reconnect
        for (const sub of activeSubscriptions) {
          try {
            await call("gateway.subscribe", { events: sub.events, exclusive: sub.exclusive });
          } catch {
            // Subscription restore failed — not fatal, UI will still work
          }
        }
      } catch {
        // connect() failed — onclose will fire and schedule another attempt
      }
    }, delay);
  }

  function send(message: Request | Pong): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("Gateway socket is not connected");
    }
    ws.send(JSON.stringify(message));
  }

  function dispatchEvent(event: string, payload: unknown): void {
    for (const [pattern, patternListeners] of listeners) {
      if (!matchEventPattern(event, pattern)) continue;
      for (const listener of patternListeners) {
        listener(event, payload);
      }
    }
  }

  function handleResponse(message: Response): void {
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timeout);
    pending.delete(message.id);
    if (message.ok) {
      request.resolve(message.payload);
      return;
    }
    request.reject(new Error(message.error || "Gateway request failed"));
  }

  async function call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    callOptions: GatewayCallOptions = {},
  ): Promise<T> {
    await connect();
    const id = generateId();
    const timeoutMs = callOptions.timeoutMs ?? requestTimeoutMs;

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Gateway call timed out: ${method}`));
      }, timeoutMs);

      pending.set(id, { resolve: (payload) => resolve(payload as T), reject, timeout });

      try {
        const request: Request = { type: "req", id, method, params };
        if (callOptions.tags?.length) request.tags = callOptions.tags;
        send(request);
      } catch (error) {
        clearTimeout(timeout);
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  function on(pattern: string, listener: EventListener): () => void {
    const bucket = listeners.get(pattern) ?? new Set<EventListener>();
    listeners.set(pattern, bucket);
    bucket.add(listener);

    return () => {
      const current = listeners.get(pattern);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) listeners.delete(pattern);
    };
  }

  function onConnection(listener: ConnectionListener): () => void {
    connectionListeners.add(listener);
    return () => connectionListeners.delete(listener);
  }

  function emit(event: string, payload: unknown): void {
    dispatchEvent(event, payload);
  }

  function disconnect(code?: number, reason?: string): void {
    intentionalDisconnect = true;
    cancelReconnect();
    const socket = ws;
    ws = null;
    connectPromise = null;
    currentConnectionId = null;
    if (socket) socket.close(code, reason);
  }

  async function connect(): Promise<void> {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    if (connectPromise) return connectPromise;

    connectPromise = new Promise<void>((resolve, reject) => {
      const socket = socketFactory(options.url);
      ws = socket;

      socket.onopen = () => {
        reconnectAttempt = 0;
        intentionalDisconnect = false;
        notifyConnection(true);
        resolve();
      };

      socket.onclose = () => {
        ws = null;
        connectPromise = null;
        currentConnectionId = null;
        notifyConnection(false);
        clearPending(new Error("Gateway connection closed"));
        scheduleReconnect();
      };

      socket.onerror = () => {
        if (!connected) {
          connectPromise = null;
          reject(new Error("Failed to connect to gateway"));
          return;
        }
        clearPending(new Error("Gateway socket error"));
      };

      socket.onmessage = (...args: any[]) => {
        const event = args[0] as { data: WebSocketMessageData };
        try {
          const message = JSON.parse(toMessageString(event.data)) as Message;

          if (message.type === "ping") {
            send({ type: "pong", id: message.id });
            return;
          }

          if (message.type === "res") {
            handleResponse(message);
            return;
          }

          if (message.type === "event") {
            if (message.event === "gateway.welcome") {
              const payload = message.payload as { connectionId?: string } | undefined;
              currentConnectionId = payload?.connectionId ?? null;
            }
            dispatchEvent(message.event, message.payload);
          }
        } catch {
          // Ignore malformed gateway messages and keep socket alive.
        }
      };
    });

    return connectPromise;
  }

  return {
    get url() {
      return options.url;
    },
    get isConnected() {
      return connected;
    },
    get connectionId() {
      return currentConnectionId;
    },
    connect,
    disconnect,
    call,
    subscribe(events: string[], exclusive = false) {
      // Track subscription for restore after reconnect
      const existing = activeSubscriptions.find(
        (s) => s.exclusive === exclusive && JSON.stringify(s.events) === JSON.stringify(events),
      );
      if (!existing) {
        activeSubscriptions.push({ events, exclusive });
      }
      return call("gateway.subscribe", { events, exclusive });
    },
    unsubscribe(events: string[]) {
      // Remove from tracked subscriptions
      activeSubscriptions = activeSubscriptions.filter(
        (s) => JSON.stringify(s.events) !== JSON.stringify(events),
      );
      return call("gateway.unsubscribe", { events });
    },
    on,
    onConnection,
    emit,
  };
}
