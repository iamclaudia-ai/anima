import { useCallback, useEffect, useRef, useState } from "react";
import {
  createGatewayClient,
  type GatewayCallOptions,
  type GatewayClient,
  type GatewayClientOptions,
} from "@claudia/shared/gateway-client";
import { useGatewayClientContext } from "../contexts/GatewayClientContext";
import { resolveGatewayUrl } from "./gateway-url";

export interface UseGatewayClientOptions {
  requestTimeoutMs?: number;
  autoConnect?: boolean;
}

export interface UseGatewayClientReturn {
  client: GatewayClient | null;
  isConnected: boolean;
  call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: GatewayCallOptions,
  ): Promise<T>;
}

export function useGatewayClient(
  url?: string,
  options: UseGatewayClientOptions = {},
): UseGatewayClientReturn {
  const context = useGatewayClientContext();
  const [localIsConnected, setLocalIsConnected] = useState(false);
  const clientRef = useRef<GatewayClient | null>(null);
  const resolvedUrl = resolveGatewayUrl(url);
  const useSharedClient = Boolean(context && (!url || context.resolvedUrl === resolvedUrl));

  useEffect(() => {
    if (useSharedClient) return;

    const clientOptions: GatewayClientOptions = {
      url: resolvedUrl,
      requestTimeoutMs: options.requestTimeoutMs,
    };
    const client = createGatewayClient(clientOptions);
    clientRef.current = client;
    const unsubscribeConnection = client.onConnection(setLocalIsConnected);

    if (options.autoConnect !== false) {
      void client.connect().catch(() => {
        setLocalIsConnected(false);
      });
    }

    return () => {
      unsubscribeConnection();
      client.disconnect();
      clientRef.current = null;
    };
  }, [resolvedUrl, options.autoConnect, options.requestTimeoutMs, useSharedClient]);

  const activeClient = useSharedClient ? (context?.client ?? null) : clientRef.current;
  const isConnected = useSharedClient ? (context?.isConnected ?? false) : localIsConnected;

  const call = useCallback(
    <T = unknown>(
      method: string,
      params?: Record<string, unknown>,
      callOptions?: GatewayCallOptions,
    ): Promise<T> => {
      const client = useSharedClient ? (context?.client ?? null) : clientRef.current;
      if (!client) {
        return Promise.reject(new Error("Gateway client is not initialized"));
      }
      return client.call<T>(method, params, callOptions);
    },
    [context?.client, useSharedClient],
  );

  return {
    client: activeClient,
    isConnected,
    call,
  };
}
