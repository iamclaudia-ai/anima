/**
 * One request to another gateway, over a short-lived WebSocket.
 *
 * Notifications are rare, so a connection per send is simpler than keeping a
 * client alive and reconnecting it: connect with the token in the query (as
 * the web UI does), send one `req`, wait for its `res`, close.
 */

const RELAY_TIMEOUT_MS = 15_000;

export async function callRemote(
  url: string,
  token: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = RELAY_TIMEOUT_MS,
): Promise<unknown> {
  const target = `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
  const id = crypto.randomUUID();
  const ws = new WebSocket(target);

  try {
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`relay to ${url} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      const finish = (fn: () => void) => {
        clearTimeout(timer);
        fn();
      };
      ws.onopen = () => ws.send(JSON.stringify({ type: "req", id, method, params }));
      ws.onmessage = (event) => {
        let msg: { type?: string; id?: string; ok?: boolean; payload?: unknown; error?: unknown };
        try {
          msg = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (msg.type !== "res" || msg.id !== id) return;
        finish(() =>
          msg.ok
            ? resolve(msg.payload)
            : reject(new Error(`relay ${method} failed: ${describeError(msg.error)}`)),
        );
      };
      ws.onerror = () => finish(() => reject(new Error(`relay to ${url} failed to connect`)));
      ws.onclose = (event) =>
        finish(() => reject(new Error(`relay to ${url} closed (${event.code}) before replying`)));
    });
  } finally {
    ws.onclose = null;
    ws.close();
  }
}

function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return JSON.stringify(error);
}
