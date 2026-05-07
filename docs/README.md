# Anima Documentation

Detailed design docs for Anima's architecture, APIs, and subsystems.

For a high-level overview, see the [project README](../README.md). For dev setup and tooling, see [DEVELOPMENT.md](../DEVELOPMENT.md).

## Architecture & Design

| Doc                                      | Description                                                                                   |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| [ARCHITECTURE.md](./ARCHITECTURE.md)     | Full system architecture — gateway hub, extension system, session lifecycle, data flow        |
| [GATEWAY.md](./GATEWAY.md)               | Gateway internals — WebSocket protocol, method routing, event broadcasting, ctx.call() hub    |
| [EXTENSIONS.md](./EXTENSIONS.md)         | Extension system — authoring guide, direct execution, HMR, ctx.call(), hooks, source routing  |
| [BRIDGE-PATTERN.md](./BRIDGE-PATTERN.md) | Bridge extensions — wiring foreign runtimes (browser, code-server, …) through the gateway     |
| [WEB-BUNDLER.md](./WEB-BUNDLER.md)       | Browser bundler — SPA, vendor, and extension bundles; importmap; shared-deps; Bun quirks      |
| [LOGGING.md](./LOGGING.md)               | Logging policy — main vs scoped logs, logger API usage, and best practices                    |
| [SESSION.md](./SESSION.md)               | Session system — draft sessions, prompt lifecycle, activation flows, tasks, and event bridges |
| [skills.md](./skills.md)                 | Agent skills — discovery, prompt integration, and `SKILL.md` structure                        |

## API & Contracts

| Doc                                    | Description                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------- |
| [API-REFERENCE.md](./API-REFERENCE.md) | Complete WebSocket API — all methods, schemas, request/response examples    |
| [HEALTHCHECKS.md](./HEALTHCHECKS.md)   | Extension health check contract — response shape, status meanings, coverage |

## Operations & Testing

| Doc                          | Description                                                     |
| ---------------------------- | --------------------------------------------------------------- |
| [TESTING.md](./TESTING.md)   | Testing strategy — unit, smoke, E2E, and how to run them        |
| [SCRIPTS.md](./SCRIPTS.md)   | Script reference — smoke tests, E2E scripts, utility scripts    |
| [SECURITY.md](./SECURITY.md) | Security model — trust model, Tailscale networking, permissions |

## Subsystems

| Doc                                | Description                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| [MEMORY.md](./MEMORY.md)           | Memory system — MCP server, persistent memory architecture                                  |
| [DOMINATRIX.md](./DOMINATRIX.md)   | Browser control — Chrome extension bridge for page automation                               |
| [EDITOR.md](./EDITOR.md)           | code-server integration — `.vsix` bridge for open_file / get_selection / active-file events |
| [ENTITLEMENT.md](./ENTITLEMENT.md) | Entitlement system — capabilities and permission model                                      |
