/**
 * EditorPanel — Embeds code-server in an iframe.
 *
 * code-server runs as a separate process. The iframe URL is config-driven
 * via the editor extension's `webConfig.url` in `~/.anima/anima.json`,
 * read here through `useExtensionConfig("editor")`. When unset, the panel
 * falls back to the same host as the SPA on port 8080 — useful for local
 * dev where code-server runs alongside the gateway.
 *
 * The iframe gets `renderer: 'always'` via the layout manager so it stays
 * in the DOM even when hidden (prevents code-server session reload).
 */

import { useState, useEffect, useRef } from "react";
import { useExtensionConfig } from "@anima/ui";

interface EditorWebConfig {
  /** Absolute code-server URL (e.g. https://code.kiliman.dev) */
  url?: string;
}

/** Local-dev fallback when no `webConfig.url` is configured. */
function defaultCodeServerUrl(): string {
  const hostname = window.location.hostname;
  return `http://${hostname}:8080`;
}

export function EditorPanel() {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { url } = useExtensionConfig<EditorWebConfig>("editor");
  const codeServerUrl = url ?? defaultCodeServerUrl();

  useEffect(() => {
    // Probe code-server health
    const check = async () => {
      try {
        const res = await fetch(codeServerUrl, { mode: "no-cors" });
        // no-cors gives opaque response, but if it doesn't throw, server is up
        setStatus("ready");
      } catch {
        setStatus("error");
      }
    };
    void check();
  }, [codeServerUrl]);

  if (status === "error") {
    return (
      <div className="flex h-full w-full items-center justify-center bg-zinc-950 text-zinc-400">
        <div className="text-center">
          <p className="text-lg font-medium text-zinc-300">Code Server Unavailable</p>
          <p className="mt-2 text-sm">
            Expected at{" "}
            <code className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">
              {codeServerUrl}
            </code>
          </p>
          <p className="mt-4 text-xs text-zinc-500">
            Start it with: <code className="text-zinc-400">code-server</code>
          </p>
          <button
            type="button"
            onClick={() => setStatus("loading")}
            className="mt-4 rounded bg-zinc-800 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-700 transition-colors"
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
