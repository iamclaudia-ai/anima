import { describe, expect, it } from "bun:test";
import { retry } from "./retry";

function mockSetTimeout(): { delays: number[]; restore: () => void } {
  const delays: number[] = [];
  const originalSetTimeout = globalThis.setTimeout;

  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    delays.push(timeout ?? 0);
    if (typeof handler === "function") {
      handler(...args);
    }
    return 0 as unknown as ReturnType<typeof originalSetTimeout>;
  }) as unknown as typeof globalThis.setTimeout;

  return {
    delays,
    restore: () => {
      globalThis.setTimeout = originalSetTimeout;
    },
  };
}

describe("retry", () => {
  it("succeeds first try", async () => {
    let attempts = 0;
    const result = await retry(async () => {
      attempts += 1;
      return "ok";
    });

    expect(result).toBe("ok");
    expect(attempts).toBe(1);
  });

  it("succeeds after retries", async () => {
    const timers = mockSetTimeout();
    let attempts = 0;

    try {
      const result = await retry(
        async () => {
          attempts += 1;
          if (attempts < 3) {
            throw new Error("temporary");
          }
          return "done";
        },
        { initialDelayMs: 10 },
      );

      expect(result).toBe("done");
      expect(attempts).toBe(3);
      expect(timers.delays).toEqual([10, 20]);
    } finally {
      timers.restore();
    }
  });

  it("exhausts all attempts and throws", async () => {
    const error = new Error("always fails");
    let attempts = 0;

    await expect(
      retry(
        async () => {
          attempts += 1;
          throw error;
        },
        { maxAttempts: 3 },
      ),
    ).rejects.toBe(error);

    expect(attempts).toBe(3);
  });

  it("respects maxAttempts", async () => {
    let attempts = 0;

    await expect(
      retry(
        async () => {
          attempts += 1;
          throw new Error("fail");
        },
        { maxAttempts: 2 },
      ),
    ).rejects.toThrow("fail");

    expect(attempts).toBe(2);
  });

  it("uses exponential backoff timing", async () => {
    const timers = mockSetTimeout();
    let attempts = 0;

    try {
      await expect(
        retry(
          async () => {
            attempts += 1;
            throw new Error("fail");
          },
          { maxAttempts: 4, initialDelayMs: 5, backoffMultiplier: 3 },
        ),
      ).rejects.toThrow("fail");

      expect(attempts).toBe(4);
      expect(timers.delays).toEqual([5, 15, 45]);
    } finally {
      timers.restore();
    }
  });

  it("caps delays at maxDelayMs", async () => {
    const timers = mockSetTimeout();

    try {
      await expect(
        retry(
          async () => {
            throw new Error("fail");
          },
          { maxAttempts: 5, initialDelayMs: 100, maxDelayMs: 250, backoffMultiplier: 3 },
        ),
      ).rejects.toThrow("fail");

      expect(timers.delays).toEqual([100, 250, 250, 250]);
    } finally {
      timers.restore();
    }
  });

  it("filters retries with shouldRetry", async () => {
    const errors = [new Error("temporary"), new Error("fatal")];
    let attempts = 0;

    await expect(
      retry(
        async () => {
          const error = errors[attempts];
          attempts += 1;
          throw error;
        },
        {
          maxAttempts: 5,
          shouldRetry: (error) => (error as Error).message !== "fatal",
        },
      ),
    ).rejects.toBe(errors[1]);

    expect(attempts).toBe(2);
  });

  it("uses default options", async () => {
    const timers = mockSetTimeout();
    let attempts = 0;

    try {
      const result = await retry(async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("temporary");
        }
        return 42;
      });

      expect(result).toBe(42);
      expect(attempts).toBe(3);
      expect(timers.delays).toEqual([100, 200]);
    } finally {
      timers.restore();
    }
  });
});
