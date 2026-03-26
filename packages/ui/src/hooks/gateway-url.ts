const TOKEN_STORAGE_KEY = "anima_token";

export function resolveGatewayUrl(input?: string): string {
  const fallback = "ws://localhost:30086/ws";
  let base: string;

  if (!input || input.trim() === "") {
    if (typeof globalThis.location !== "undefined") {
      const protocol = globalThis.location.protocol === "https:" ? "wss:" : "ws:";
      base = `${protocol}//${globalThis.location.host}/ws`;
    } else {
      base = fallback;
    }
  } else {
    const value = input.trim();

    if (value.startsWith("ws://") || value.startsWith("wss://")) {
      base = value;
    } else if (value.startsWith("http://") || value.startsWith("https://")) {
      try {
        const parsed = new URL(value);
        parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
        if (!parsed.pathname || parsed.pathname === "/") {
          parsed.pathname = "/ws";
        }
        base = parsed.toString();
      } catch {
        base = fallback;
      }
    } else {
      // Host-only shorthand, e.g. "localhost:30086" or "claudia.kiliman.dev"
      base = `ws://${value.replace(/\/+$/, "")}/ws`;
    }
  }

  // Append auth token from localStorage (browser only)
  const token = getStoredToken();
  if (token) {
    const separator = base.includes("?") ? "&" : "?";
    return `${base}${separator}token=${encodeURIComponent(token)}`;
  }

  return base;
}

/**
 * Get the stored auth token from localStorage.
 */
export function getStoredToken(): string | null {
  if (typeof globalThis.localStorage === "undefined") return null;
  return globalThis.localStorage.getItem(TOKEN_STORAGE_KEY);
}

/**
 * Store the auth token in localStorage.
 */
export function setStoredToken(token: string): void {
  if (typeof globalThis.localStorage === "undefined") return;
  globalThis.localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

/**
 * Clear the stored auth token (logout).
 */
export function clearStoredToken(): void {
  if (typeof globalThis.localStorage === "undefined") return;
  globalThis.localStorage.removeItem(TOKEN_STORAGE_KEY);
}
