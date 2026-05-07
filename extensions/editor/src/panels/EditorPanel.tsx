/**
 * EditorPanel — Embeds code-server in an iframe.
 *
 * code-server runs as a separate process. The iframe URL is config-driven
 * via the editor extension's `webConfig.url` in `~/.anima/anima.json`, read
 * here through `useExtensionConfig("editor")`. When unset, the panel falls
 * back to the same host as the SPA on port 8080 — useful for local dev
 * where code-server runs alongside the gateway.
 *
 * Active-workspace integration: the iframe URL appends `?folder=<cwd>` from
 * `useWorkspace()` — populated by the chat layout's `ChatPageProvider` from
 * the URL's active workspace. Switching workspaces re-templates the URL
 * which causes the iframe to reload at the new folder. (Phase 1 trade-off:
 * code-server session state is lost on workspace switch. The Phase 3 bridge
 * `.vsix` will replace this with a postMessage-driven file-open that
 * preserves session state.)
 *
 * The iframe gets `renderer: 'always'` via the layout manager so it stays
 * in the DOM even when hidden (prevents code-server session reload on tab
 * change).
 */

import { useState, useEffect, useMemo, useRef } from "react";
import { useExtensionConfig, useWorkspace } from "@anima/ui";

interface EditorWebConfig {
  /** Absolute code-server URL (e.g. https://code.kiliman.dev) */
  url?: string;
}

/** Local-dev fallback when no `webConfig.url` is configured. */
function defaultCodeServerBase(): string {
  const hostname = window.location.hostname;
  return `http://${hostname}:8080`;
}

/**
 * Build the code-server URL with `?folder=<cwd>` when the active workspace
 * is known. Uses the URL API so we don't double-encode an existing query
 * string the user may have configured (e.g. `?tkn=...` for auth).
 */
function buildEditorUrl(base: string, cwd: string | undefined): string {
  if (!cwd) return base;
  try {
    const u = new URL(base);
    u.searchParams.set("folder", cwd);
    return u.toString();
  } catch {
    // Fall back to naive concatenation if `base` isn't a valid absolute URL.
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}folder=${encodeURIComponent(cwd)}`;
  }
}

export function EditorPanel() {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { url } = useExtensionConfig<EditorWebConfig>("editor");
  const { cwd } = useWorkspace();

  const baseUrl = url ?? defaultCodeServerBase();
  const codeServerUrl = useMemo(() => buildEditorUrl(baseUrl, cwd), [baseUrl, cwd]);

  useEffect(() => {
    // Probe code-server health on URL change. `no-cors` gives an opaque
    // response — we only care that the request didn't throw.
    let cancelled = false;
    setStatus("loading");
    const check = async () => {
      try {
        await fetch(baseUrl, { mode: "no-cors" });
        if (!cancelled) setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    };
    void check();
    return () => {
      cancelled = true;
    };
  }, [baseUrl]);

  if (status === "error") {
    return (
      <div className="flex h-full w-full items-center justify-center bg-zinc-950 text-zinc-400">
        <div className="text-center">
          <p className="text-lg font-medium text-zinc-300">Code Server Unavailable</p>
          <p className="mt-2 text-sm">
            Expected at{" "}
            <code className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">{baseUrl}</code>
          </p>
          <p className="mt-4 text-xs text-zinc-500">
            Start it with: <code className="text-zinc-400">code-server</code>
          </p>
          <button
            type="button"
            onClick={() => setStatus("loading")}
            className="mt-4 rounded bg-zinc-800 px-4 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-700"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full bg-zinc-950">
      {status === "loading" && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-zinc-950">
          <p className="text-sm text-zinc-500">Connecting to code-server...</p>
        </div>
      )}
      <iframe
        ref={iframeRef}
        src={codeServerUrl}
        title="Code Server"
        className="h-full w-full border-0"
        onLoad={() => setStatus("ready")}
        onError={() => setStatus("error")}
        allow="clipboard-read; clipboard-write"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
      />
    </div>
  );
}
