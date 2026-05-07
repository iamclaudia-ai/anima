/**
 * ExtensionConfigContext — exposes per-extension public config to the SPA.
 *
 * Each extension can declare a `webConfig` object in `~/.anima/anima.json`
 * (server-only `config` stays private). The gateway ships those `webConfig`
 * blocks down with `/api/web-contributions` at SPA boot, and the bootstrap
 * wraps the tree in `<ExtensionConfigProvider>` so any panel or page can
 * read its slice synchronously via `useExtensionConfig(id)`.
 *
 * Keep `webConfig` strictly to non-secret values (URLs, feature flags,
 * defaults). API keys, tokens, and paths belong in the server-side `config`.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";

export type ExtensionWebConfig = Record<string, unknown>;
export type ExtensionConfigMap = Record<string, ExtensionWebConfig>;

const ExtensionConfigContext = createContext<ExtensionConfigMap>({});

export interface ExtensionConfigProviderProps {
  children: ReactNode;
  configs: ExtensionConfigMap;
}

export function ExtensionConfigProvider({ children, configs }: ExtensionConfigProviderProps) {
  // Stabilize the value reference so consumers don't re-render on every parent
  // render — the configs map is built once at SPA bootstrap.
  const value = useMemo(() => configs, [configs]);
  return (
    <ExtensionConfigContext.Provider value={value}>{children}</ExtensionConfigContext.Provider>
  );
}

/**
 * Read the public `webConfig` for an extension.
 *
 * Returns an empty object (cast to T) when the extension has no `webConfig`
 * declared so callers can destructure with defaults without null checks:
 *
 * ```tsx
 * const { url = "http://localhost:8080" } =
 *   useExtensionConfig<{ url?: string }>("editor");
 * ```
 */
export function useExtensionConfig<T = ExtensionWebConfig>(id: string): T {
  const map = useContext(ExtensionConfigContext);
  return (map[id] ?? {}) as T;
}
