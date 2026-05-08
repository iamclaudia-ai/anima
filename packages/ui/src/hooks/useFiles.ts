import { useEffect, useState } from "react";
import { useGatewayClient } from "./useGatewayClient";

interface UseFilesState {
  files: string[];
  source: "git" | "walk" | null;
  isLoading: boolean;
  error: string | null;
}

/**
 * Fetches the file list for the workspace cwd. Used by the `@` file picker.
 * Caches in component state per cwd; refetches when cwd changes.
 */
export function useFiles(cwd?: string): UseFilesState {
  const { call, isConnected } = useGatewayClient();
  const [state, setState] = useState<UseFilesState>({
    files: [],
    source: null,
    isLoading: false,
    error: null,
  });

  useEffect(() => {
    if (!isConnected || !cwd) return;

    let cancelled = false;
    setState((prev) => ({ ...prev, isLoading: true, error: null }));

    call<{ files: string[]; source: "git" | "walk" }>("session.list_files", { cwd })
      .then((result) => {
        if (cancelled) return;
        setState({
          files: result.files,
          source: result.source,
          isLoading: false,
          error: null,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          files: [],
          source: null,
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
