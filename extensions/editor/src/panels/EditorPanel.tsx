/**
 * EditorPanel — Embeds code-server in an iframe.
 *
 * code-server runs as a separate process, serving VS Code on port 8080.
 * The iframe gets `renderer: 'always'` via the layout manager so it
 * stays in the DOM even when hidden (prevents iframe reload).
 *
 * Remote access works via Tailscale — same as the gateway.
 */

import { useState, useEffect, useRef } from "react";

/** code-server URL — same host as current page, port 8080 */
function getCodeServerUrl(): string {
  const hostname = window.location.hostname;
  return `http://${hostname}:8080`;
}

export function EditorPanel() {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const codeServerUrl = getCodeServerUrl();

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
