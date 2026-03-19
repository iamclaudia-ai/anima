import { useCallback } from "react";
import { useGatewayClient } from "@claudia/ui";

export function useGatewayRpc() {
  const { call, isConnected, client } = useGatewayClient();

  const request = useCallback(
    <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> => {
      return call<T>(method, params, { timeoutMs: 10000 });
    },
    [call],
  );

  const subscribe = useCallback(
    (events: string[]) => {
      if (!client) return Promise.reject(new Error("Not connected"));
      return client.subscribe(events);
    },
    [client],
  );

  const on = useCallback(
    (pattern: string, listener: (event: string, payload: unknown) => void) => {
      if (!client) return () => {};
      return client.on(pattern, listener);
    },
    [client],
  );

  return { request, connected: isConnected, subscribe, on };
}
