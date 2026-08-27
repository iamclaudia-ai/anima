/**
 * Environment that every agent session exports so tools running *inside* it can
 * identify themselves back to Anima.
 *
 * The `anima` CLI reads `$ANIMA_SESSION_ID` and auto-injects it as `sessionId`
 * into any method whose input schema declares that property
 * (`injectSessionIdFromEnv` in `packages/cli/src/index.ts`). Dominatrix's
 * per-session tab binding is the main consumer: it is the whole reason a
 * session can omit `--tabId` and still land on the tab it opened.
 *
 * **Every provider must merge this into the environment of the process it
 * spawns.** Adding a new runtime (grok-code, opencode, …)? Call this — it is
 * the single place the contract lives. Omitting it does not fail loudly; it
 * degrades silently into "no session identity" (see issue #74).
 */
export function animaSessionEnv(sessionId: string): Record<string, string> {
  return { ANIMA_SESSION_ID: sessionId };
}

/**
 * {@link animaSessionEnv} merged onto the current process environment.
 *
 * For spawn APIs that *replace* rather than extend the child environment —
 * the Agent SDK's `env`, and `@openai/codex-sdk`, which documents "when
 * provided, the SDK will not inherit variables from `process.env`".
 */
export function animaSessionEnvWithProcess(
  sessionId: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) base[key] = value;
  }
  return { ...base, ...overrides, ...animaSessionEnv(sessionId) };
}
