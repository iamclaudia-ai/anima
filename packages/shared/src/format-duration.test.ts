import { describe, expect, it } from "bun:test";

import { formatDuration } from "./format-duration";

describe("formatDuration", () => {
  it("formats zero", () => {
    expect(formatDuration(0)).toBe("0ms");
  });

  it("formats milliseconds", () => {
    expect(formatDuration(1)).toBe("1ms");
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("formats seconds", () => {
    expect(formatDuration(1_000)).toBe("1s");
    expect(formatDuration(15_000)).toBe("15s");
    expect(formatDuration(2_250)).toBe("2s 250ms");
  });

  it("formats minutes", () => {
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(2 * 60_000 + 15_000)).toBe("2m 15s");
    expect(formatDuration(90_000)).toBe("1m 30s");
  });

  it("formats hours", () => {
    expect(formatDuration(60 * 60_000)).toBe("1h");
    expect(formatDuration(90 * 60_000)).toBe("1h 30m");
    expect(formatDuration(60 * 60_000 + 1_000)).toBe("1h 1s");
  });

  it("formats days", () => {
    expect(formatDuration(24 * 60 * 60_000)).toBe("1d");
    expect(formatDuration(3 * 24 * 60 * 60_000 + 2 * 60 * 60_000)).toBe("3d 2h");
    expect(formatDuration(24 * 60 * 60_000 + 30 * 60_000)).toBe("1d 30m");
  });

  it("handles edge cases", () => {
    expect(formatDuration(-1)).toBe("0ms");
    expect(formatDuration(1.9)).toBe("1ms");
    expect(formatDuration(Number.NaN)).toBe("0ms");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0ms");
  });
});
