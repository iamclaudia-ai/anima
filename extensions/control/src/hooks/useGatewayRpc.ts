import { useCallback } from "react";
import { useGatewayClient } from "@claudia/ui";

export function useGatewayRpc() {
  const { call, isConnected } = useGatewayClient();

  const request = useCallback(
    <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> => {
      return call<T>(method, params, { timeoutMs: 10000 });
    },
    [call],
  );

  return { request, connected: isConnected };
}
