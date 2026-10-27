import { describe, expect, test } from "bun:test";
import {
  LivenessMonitor,
  parseClaudeProcesses,
  parseProxyPortFromEnv,
  type LivenessProbes,
  type ProbeResult,
} from "./liveness";

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

const ok = (stdout: string): ProbeResult => ({ exitCode: 0, stdout, stderr: "" });

/** Probes whose answers a test sets, counting how often each one ran. */
function fakeProbes(initial: { ps?: string; tmux?: string } = {}) {
  const state = {
    ps: initial.ps ?? "",
    tmux: initial.tmux ?? "",
    psResult: null as ProbeResult | null,
    tmuxResult: null as ProbeResult | null,
    psDelayMs: 0,
    psCalls: 0,
    env: "",
  };
  const probes: LivenessProbes = {
    listProcesses: async () => {
      state.psCalls++;
      // Read at call time: a probe sees the world as it was when it started.
      const result = state.psResult ?? ok(state.ps);
      if (state.psDelayMs) await new Promise((r) => setTimeout(r, state.psDelayMs));
      return result;
    },
    listTmuxSessions: async () => state.tmuxResult ?? ok(state.tmux),
    processEnvironment: async () => ok(state.env),
  };
  return { state, probes };
}

describe("parseClaudeProcesses", () => {
  test("maps --resume and --session-id ids to their pid", () => {
    const ps = [
      "  101 /Users/m/.local/bin/claude --resume aaa-111 --model opus",
      "  202 claude --session-id bbb-222",
      "  303 /bin/zsh -l",
    ].join("\n");
    const byId = parseClaudeProcesses(ps);
    expect(byId.get("aaa-111")).toBe(101);
    expect(byId.get("bbb-222")).toBe(202);
    expect(byId.size).toBe(2);
  });

  test("keeps the first pid when a wrapper shell carries the same id", () => {
    const ps = "  50 sh -c claude --resume ccc-333\n  51 claude --resume ccc-333";
    expect(parseClaudeProcesses(ps).get("ccc-333")).toBe(50);
  });
});

describe("LivenessMonitor", () => {
  test("reports nothing alive until primed, then reads the snapshot", async () => {
    const { probes } = fakeProbes({
      ps: "  7 claude --resume s1",
      tmux: "anima-claude-s1\nother",
    });
    const monitor = new LivenessMonitor(probes);
    expect(monitor.primed).toBe(false);
    expect(monitor.claudeAlive("s1")).toBe(false);

    await monitor.refresh();
    expect(monitor.primed).toBe(true);
    expect(monitor.claudeAlive("s1")).toBe(true);
    expect(monitor.claudePid("s1")).toBe(7);
    expect(monitor.tmuxAlive("anima-claude-s1")).toBe(true);
    expect(monitor.claudeAlive("s2")).toBe(false);
  });

  test("a refresh during a running probe waits for one that starts after it", async () => {
    const { state, probes } = fakeProbes({ ps: "" });
    state.psDelayMs = 30;
    const monitor = new LivenessMonitor(probes);

    const first = monitor.refresh();
    // The world changes after the first probe started (a launch).
    state.ps = "  9 claude --session-id fresh";
    const second = monitor.refresh();
    const third = monitor.refresh();

    await Promise.all([first, second, third]);
    expect(monitor.claudeAlive("fresh")).toBe(true);
    // The two late callers shared one probe instead of starting one each.
    expect(state.psCalls).toBe(2);
  });

  test("fresh() skips the probe while the snapshot is young enough", async () => {
    let now = 1_000;
    const { state, probes } = fakeProbes();
    const monitor = new LivenessMonitor(probes, () => now);
    await monitor.fresh(500);
    expect(state.psCalls).toBe(1);
    now += 400;
    await monitor.fresh(500);
    expect(state.psCalls).toBe(1);
    now += 200;
    await monitor.fresh(500);
    expect(state.psCalls).toBe(2);
  });

  test("a failed ps keeps the previous answer instead of reporting every session dead", async () => {
    const { state, probes } = fakeProbes({ ps: "  7 claude --resume s1", tmux: "anima-claude-s1" });
    const monitor = new LivenessMonitor(probes);
    await monitor.refresh();

    state.psResult = { exitCode: 1, stdout: "", stderr: "ps: fork failed" };
    state.tmuxResult = { exitCode: 1, stdout: "", stderr: "server exited unexpectedly" };
    await monitor.refresh();
    expect(monitor.claudeAlive("s1")).toBe(true);
    expect(monitor.tmuxAlive("anima-claude-s1")).toBe(true);
  });

  test("no tmux server means no tmux sessions", async () => {
    const { state, probes } = fakeProbes({ tmux: "anima-claude-s1" });
    const monitor = new LivenessMonitor(probes);
    await monitor.refresh();

    state.tmuxResult = {
      exitCode: 1,
      stdout: "",
      stderr: "no server running on /tmp/tmux-501/default",
    };
    await monitor.refresh();
    expect(monitor.tmuxAlive("anima-claude-s1")).toBe(false);
  });

  test("forget() drops a closed session at once", async () => {
    const { probes } = fakeProbes({ ps: "  7 claude --resume s1", tmux: "anima-claude-s1" });
    const monitor = new LivenessMonitor(probes);
    await monitor.refresh();
    monitor.forget("s1", "anima-claude-s1");
    expect(monitor.claudeAlive("s1")).toBe(false);
    expect(monitor.tmuxAlive("anima-claude-s1")).toBe(false);
  });

  test("proxyPort() reads the live process's environment", async () => {
    const { state, probes } = fakeProbes({ ps: "  7 claude --resume s1" });
    state.env = "claude --resume s1 ANTHROPIC_BASE_URL=http://localhost:9602 TERM=xterm";
    const monitor = new LivenessMonitor(probes);
    await monitor.refresh();
    expect(await monitor.proxyPort("s1")).toBe(9602);
    expect(await monitor.proxyPort("not-running")).toBeNull();
  });

  // #95: the whole point. A slow process listing (a machine with thousands of
  // processes) must cost the caller latency, never the event loop.
  test("a slow probe does not block the event loop", async () => {
    const { state, probes } = fakeProbes({ ps: "  7 claude --resume s1" });
    state.psDelayMs = 300;
    const monitor = new LivenessMonitor(probes);

    const started = performance.now();
    const refreshing = monitor.refresh();
    await new Promise((r) => setTimeout(r, 0));
    const timerLatency = performance.now() - started;
    expect(timerLatency).toBeLessThan(100);

    // Cached reads stay instant while the probe is in flight.
    expect(monitor.claudeAlive("s1")).toBe(false);
    await refreshing;
    expect(monitor.claudeAlive("s1")).toBe(true);
  });
});
