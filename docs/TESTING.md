# Testing Strategy

Last updated: 2026-03-21

## Goals

- Catch contract regressions early (required params, method schemas, routing).
- Keep tests fast and local-first via Bun test runner.
- Provide one manual end-to-end smoke check against a real model.

## Commands

- `bun run test:unit`
- `bun run test:integration`
- `bun run test:smoke`
- `bun run test:e2e`
- `bun run test:smoke-all`

## Phases

1. Unit tests (fast, pure logic)

- CLI argument parsing/coercion.
- CLI JSON Schema `$ref` resolution.
- CLI required param/type validation.
- Extension manager method validation and source routing.

2. Integration tests (gateway + out-of-process extension plumbing)

- Extension event subscription + wildcard routing behavior.
- Gateway extension manager with multiple extensions.

3. End-to-end smoke (manual, low-cost)

- Connect to running gateway.
- Create workspace + session explicitly.
- Send one cheap prompt and assert stream completes.

## Smoke scripts

### Quick smoke (no model call)

`bun run test:smoke`

Checks:

- `GET /health`
- `gateway.list_methods` over gateway WebSocket

Env:

- `ANIMA_GATEWAY_HTTP` (default `http://localhost:30086`)
- `ANIMA_GATEWAY_WS` (default `ws://localhost:30086/ws`)

### E2E smoke (uses model)

`bun run test:e2e`

Checks:

- `session.get_or_create_workspace`
- `session.create_session`
- `session.send_prompt` streaming completion + expected output marker

Env:

- `ANIMA_GATEWAY_WS` (default `ws://localhost:30086/ws`)
- `ANIMA_SMOKE_MODEL` (default `claude-3-5-haiku-latest`)
- `ANIMA_SMOKE_THINKING` (default `false`)
- `ANIMA_SMOKE_EFFORT` (default `low`)
- `ANIMA_SMOKE_TIMEOUT_MS` (default `60000`)

## Notes

- E2E smoke intentionally uses the current explicit `cwd/sessionId/model/thinking/effort` APIs.
- For local development, run `bun run test:smoke-all` before big refactors.
- Add new tests next to changed packages (`*.test.ts` for unit, `*.integration.test.ts` for integration).
- Recent hot paths worth covering directly: `ctx.store`, persistent session resolution/rotation, and `gateway.extensions_ready` startup work.
