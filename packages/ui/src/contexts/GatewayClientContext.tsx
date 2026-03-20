import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createGatewayClient, type GatewayClient } from "@anima/shared/gateway-client";
import { resolveGatewayUrl } from "../hooks/gateway-url";

interface GatewayClientContextValue {
  client: GatewayClient | null;
  isConnected: boolean;
  resolvedUrl: string;
}

const GatewayClientContext = createContext<GatewayClientContextValue | null>(null);

export interface GatewayClientProviderProps {
  children: ReactNode;
  url?: string;
  requestTimeoutMs?: number;
  autoConnect?: boolean;
}

export function GatewayClientProvider({
  children,
  url,
  requestTimeoutMs,
  autoConnect = true,
}: GatewayClientProviderProps) {
  const resolvedUrl = useMemo(() => resolveGatewayUrl(url), [url]);
  const client = useMemo(
    () => createGatewayClient({ url: resolvedUrl, requestTimeoutMs }),
    [resolvedUrl, requestTimeoutMs],
  );
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    const unsubscribeConnection = client.onConnection(setIsConnected);

    if (autoConnect) {
      void client.connect().catch(() => {
        setIsConnected(false);
      });
    }

    return () => {
      unsubscribeConnection();
      client.disconnect();
      setIsConnected(false);
    };
  }, [client, autoConnect]);

  const value = useMemo<GatewayClientContextValue>(
    () => ({ client, isConnected, resolvedUrl }),
    [client, isConnected, resolvedUrl],
  );

  return <GatewayClientContext.Provider value={value}>{children}</GatewayClientContext.Provider>;
}

export function useGatewayClientContext(): GatewayClientContextValue | null {
  return useContext(GatewayClientContext);
}
