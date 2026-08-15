import { describe, expect, test } from "bun:test";
import { parseProxyPortFromEnv } from "./tmux";

describe("parseProxyPortFromEnv", () => {
  // A running CLI reads its proxy URL once at startup and can never be told a
  // new one. Recovering that port is what stops an agent-host restart from
  // stranding it on a dead port ("API Error: Connection refused").
  test("reads the port from ANTHROPIC_BASE_URL", () => {
    const ps =
      "ANTHROPIC_BASE_URL=http://localhost:9602 TERM=xterm /Users/m/.local/bin/claude --session-id abc";
    expect(parseProxyPortFromEnv(ps)).toBe(9602);
  });

  test("falls back to HTTPS_PROXY for mitm sessions", () => {
    expect(parseProxyPortFromEnv("HTTPS_PROXY=http://127.0.0.1:9318 claude --resume abc")).toBe(
      9318,
    );
  });

  test("prefers ANTHROPIC_BASE_URL when both are present", () => {
    const ps = "HTTPS_PROXY=http://127.0.0.1:9318 ANTHROPIC_BASE_URL=http://localhost:9602 claude";
    expect(parseProxyPortFromEnv(ps)).toBe(9602);
  });

  test("handles https and hostnames other than localhost", () => {
    expect(parseProxyPortFromEnv("ANTHROPIC_BASE_URL=https://127.0.0.1:9999 claude")).toBe(9999);
  });

  test("returns null when the CLI has no proxy configured", () => {
    expect(parseProxyPortFromEnv("TERM=xterm claude --session-id abc")).toBeNull();
    expect(parseProxyPortFromEnv("")).toBeNull();
  });

  test("rejects a malformed or out-of-range port rather than binding nonsense", () => {
    expect(parseProxyPortFromEnv("ANTHROPIC_BASE_URL=http://localhost:99999 claude")).toBeNull();
    expect(parseProxyPortFromEnv("ANTHROPIC_BASE_URL=http://localhost:abc claude")).toBeNull();
    expect(parseProxyPortFromEnv("ANTHROPIC_BASE_URL=http://localhost claude")).toBeNull();
  });
});
