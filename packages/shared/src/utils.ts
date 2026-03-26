/**
 * Shared utility functions
 */

/**
 * Truncate a UUID/ID to first 8 characters for logging.
 * Common pattern across extensions for readable log output.
 */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * Race a promise against a timeout.
 * Rejects with a descriptive error if the timeout expires first.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Format a millisecond timestamp as a human-readable "X ago" string.
 * Returns "Xs ago", "Xm ago", "Xh ago", or "Xd ago".
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "n/a";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
