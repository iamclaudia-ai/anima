import { useEffect, useState } from "react";
import { useGatewayClient } from "./useGatewayClient";

export interface CommandItem {
  name: string;
  description: string;
  source: "global" | "project";
}

interface UseCommandsState {
  items: CommandItem[];
  isLoading: boolean;
  error: string | null;
}

/**
 * Fetches the list of available skills + slash commands from the gateway.
 * Refetches whenever `cwd` changes (project-local commands depend on it).
 */
export function useCommands(cwd?: string): UseCommandsState {
  const { call, isConnected } = useGatewayClient();
  const [state, setState] = useState<UseCommandsState>({
    items: [],
    isLoading: false,
    error: null,
  });

  useEffect(() => {
    if (!isConnected) return;

    let cancelled = false;
    setState((prev) => ({ ...prev, isLoading: true, error: null }));

    call<{ items: CommandItem[] }>("session.list_commands", cwd ? { cwd } : {})
      .then((result) => {
        if (cancelled) return;
        setState({ items: result.items, isLoading: false, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          items: [],
          isLoading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [call, cwd, isConnected]);

  return state;
}
