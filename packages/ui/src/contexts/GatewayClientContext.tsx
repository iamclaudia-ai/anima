import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createGatewayClient, type GatewayClient } from "@claudia/shared";
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
  const [client, setClient] = useState<GatewayClient | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    const next = createGatewayClient({ url: resolvedUrl, requestTimeoutMs });
    setClient(next);
    const unsubscribeConnection = next.onConnection(setIsConnected);

    if (autoConnect) {
      void next.connect().catch(() => {
        setIsConnected(false);
      });
    }

    return () => {
      unsubscribeConnection();
      next.disconnect();
      setClient(null);
      setIsConnected(false);
    };
  }, [resolvedUrl, requestTimeoutMs, autoConnect]);

  const value = useMemo<GatewayClientContextValue>(
    () => ({ client, isConnected, resolvedUrl }),
    [client, isConnected, resolvedUrl],
  );

  return <GatewayClientContext.Provider value={value}>{children}</GatewayClientContext.Provider>;
}

export function useGatewayClientContext(): GatewayClientContextValue | null {
  return useContext(GatewayClientContext);
}
