export function resolveGatewayUrl(input?: string): string {
  const fallback = "ws://localhost:30086/ws";
  if (!input || input.trim() === "") {
    if (typeof globalThis.location !== "undefined") {
      const protocol = globalThis.location.protocol === "https:" ? "wss:" : "ws:";
      return `${protocol}//${globalThis.location.host}/ws`;
    }
    return fallback;
  }

  const value = input.trim();

  if (value.startsWith("ws://") || value.startsWith("wss://")) {
    return value;
  }

  if (value.startsWith("http://") || value.startsWith("https://")) {
    try {
      const parsed = new URL(value);
      parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
      if (!parsed.pathname || parsed.pathname === "/") {
        parsed.pathname = "/ws";
      }
      return parsed.toString();
    } catch {
      return fallback;
    }
  }

  // Host-only shorthand, e.g. "localhost:30086" or "claudia.kiliman.dev"
  return `ws://${value.replace(/\/+$/, "")}/ws`;
}
