import { describe, expect, test } from "bun:test";
import { shouldInjectContext1m } from "./proxy";

/**
 * Regression coverage for #60: the proxy must inject the Opus-tier 1M-context
 * beta ONLY for the session's own 1M model. Blindly injecting it onto a
 * subagent's request (which runs on a different model, e.g. Haiku) 400s the API
 * with "long context beta not yet available for this subscription".
 */
describe("shouldInjectContext1m", () => {
  const SESSION_1M = "claude-opus-4-8";

  test("injects for the session's 1M model (bare id)", () => {
    expect(shouldInjectContext1m("claude-opus-4-8", SESSION_1M)).toBe(true);
  });

  test("injects when the request still carries the [1m] variant suffix", () => {
    // Auxiliary calls (quota probe, etc.) can retain the `[1m]` suffix; they are
    // the same model and still want the window.
    expect(shouldInjectContext1m("claude-opus-4-8[1m]", SESSION_1M)).toBe(true);
  });

  test("does NOT inject for a subagent on a different model (the #60 bug)", () => {
    expect(shouldInjectContext1m("claude-haiku-4-5-20251001", SESSION_1M)).toBe(false);
  });

  test("does NOT inject for a different Opus tier than the session selected", () => {
    expect(shouldInjectContext1m("claude-sonnet-4-6", SESSION_1M)).toBe(false);
  });

  test("does NOT inject when the session is not on a 1M model", () => {
    expect(shouldInjectContext1m("claude-opus-4-8", undefined)).toBe(false);
  });

  test("does NOT inject for model-less requests (HEAD probe, count_tokens)", () => {
    expect(shouldInjectContext1m(undefined, SESSION_1M)).toBe(false);
    expect(shouldInjectContext1m("", SESSION_1M)).toBe(false);
    expect(shouldInjectContext1m(null, SESSION_1M)).toBe(false);
  });

  test("tolerates a [1m]-suffixed session model id on either side", () => {
    expect(shouldInjectContext1m("claude-opus-4-8", "claude-opus-4-8[1m]")).toBe(true);
    expect(shouldInjectContext1m("claude-haiku-4-5-20251001", "claude-opus-4-8[1m]")).toBe(false);
  });
});
