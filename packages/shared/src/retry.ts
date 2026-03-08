export type RetryOptions = {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  shouldRetry?: (error: unknown) => boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 100,
    maxDelayMs = 5_000,
    backoffMultiplier = 2,
    shouldRetry,
  } = opts;

  let attempt = 0;
  let delayMs = initialDelayMs;

  while (attempt < maxAttempts) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;

      if (attempt >= maxAttempts || (shouldRetry && !shouldRetry(error))) {
        throw error;
      }

      await sleep(Math.min(delayMs, maxDelayMs));
      delayMs *= backoffMultiplier;
    }
  }

  throw new Error("retry reached an unexpected state");
}
