import { useCallback, useEffect, useRef, useState } from "react";
import {
  createGatewayClient,
  type GatewayCallOptions,
  type GatewayClient,
  type GatewayClientOptions,
} from "@claudia/shared";

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
  url: string,
  options: UseGatewayClientOptions = {},
): UseGatewayClientReturn {
  const [isConnected, setIsConnected] = useState(false);
  const clientRef = useRef<GatewayClient | null>(null);

  useEffect(() => {
    const clientOptions: GatewayClientOptions = {
      url,
      requestTimeoutMs: options.requestTimeoutMs,
    };
    const client = createGatewayClient(clientOptions);
    clientRef.current = client;
    const unsubscribeConnection = client.onConnection(setIsConnected);

    if (options.autoConnect !== false) {
      void client.connect().catch(() => {
        setIsConnected(false);
      });
    }

    return () => {
      unsubscribeConnection();
      client.disconnect();
      clientRef.current = null;
    };
  }, [url, options.autoConnect, options.requestTimeoutMs]);

  const call = useCallback(
    <T = unknown>(
      method: string,
      params?: Record<string, unknown>,
      callOptions?: GatewayCallOptions,
    ): Promise<T> => {
      const client = clientRef.current;
      if (!client) {
        return Promise.reject(new Error("Gateway client is not initialized"));
      }
      return client.call<T>(method, params, callOptions);
    },
    [],
  );

  return {
    client: clientRef.current,
    isConnected,
    call,
  };
}
