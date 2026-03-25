# Logging Guide

How logging should work across the gateway, agent host, and extensions.

## Goals

Logging in Anima serves two different needs:

1. Operators need a clear picture of what the system is doing right now.
2. Engineers need deep traces when debugging one session, one connection, or one background job.

Those needs should not use the same log stream.

The main operational logs should stay readable. High-frequency traces should move into scoped logs.

## Current Model

The shared logger is the standard backend for extension logging.

- `ctx.log` writes to console and the extension's main file at `~/.anima/logs/<extensionId>.log`
- `ctx.log.child("component")` creates a component-scoped logger on the same file
- `ctx.createLogger({ component, fileName })` creates a logger using the same backend with an optional dedicated log file

Examples:

```typescript
ctx.log.info("Voice extension started");

const traceLog = ctx.createLogger({ component: "trace" });
traceLog.info("WebSocket connected");

const sessionLog = ctx.createLogger({
  component: "session",
  fileName: `session-${sessionId}.log`,
});
sessionLog.info("Streaming turn opened");
```

## Log Classes

### Main Operational Logs

Main logs are for coarse, operator-visible events:

- startup and shutdown
- health transitions
- configuration summary
- extension registration
- background worker start/stop
- failures that require attention
- slow calls and timeouts
- important state transitions

Examples:

- `memory` acquired or lost singleton lock
- `scheduler` fired a task
- `voice` connected or failed to connect to Cartesia
- `session` created, switched, reset, or timed out a prompt

These belong in the extension's main log file.

### Scoped Trace Logs

Scoped logs are for noisy or high-cardinality traces:

- streaming event sequences
- per-session protocol traces
- per-connection audio/text streaming
- ingestion of individual files
- per-job or per-conversation background processing details
- external API request/response traces

These should usually go into dedicated files created with `ctx.createLogger({ fileName })`.

Examples:

- `session-ses_<id>.log`
- `voice-conn_<id>.log`
- `memory-conv_<id>.log`
- `scheduler-job_<id>.log`

### Structured Event Sinks

Some files are not general-purpose logs. They are append-only records or machine-readable traces, such as transcript JSONL or SDK event dumps.

Treat those as data sinks, not as operational logs.

They may justify custom formatting or write paths, but they should still follow the same policy:

- keep hot-path noise out of the main operational log
- scope detailed traces by session, connection, or job

## Best Practices

### What To Put In Main Logs

- one line when a component starts
- one line when a component stops
- one line for each meaningful state transition
- one line for slow paths, retries, and timeouts
- one line for errors with enough metadata to identify the failing unit

### What Not To Put In Main Logs

- every streaming event
- every token delta
- every audio chunk
- every heartbeat
- every poll tick
- every file watcher event
- every DB row processed

If it can happen hundreds or thousands of times in a single normal interaction, it does not belong in the main log.

### Scope High-Volume Logs

When detailed tracing is needed, scope it by the unit being debugged:

- session ID
- connection ID
- conversation ID
- task/job ID
- external request ID

This is the preferred pattern because it keeps the main log readable and makes cleanup/inspection straightforward.

### Prefer Stable Correlation Keys

Use IDs that already exist in the system:

- `sessionId`
- `connectionId`
- `conversationId`
- `taskId`
- `traceId`

Do not invent new correlation IDs if an existing one already identifies the work.

### Log State Changes, Not Poll Loops

Prefer:

- "worker entered idle"
- "session create timed out waiting on memory"
- "singleton lock lost"

Avoid:

- "poll tick"
- "still waiting"
- repeated heartbeat noise

### Keep Messages Useful

Each log line should answer at least one of these:

- what changed
- what failed
- which unit was affected
- how long it took
- what happens next

## Recommended File Layout

Main operational logs:

- `~/.anima/logs/gateway.log`
- `~/.anima/logs/agent-host.log`
- `~/.anima/logs/<extensionId>.log`

Scoped traces:

- `~/.anima/logs/session-<sessionId>.log`
- `~/.anima/logs/voice-<connectionId>.log`
- `~/.anima/logs/memory-<conversationId>.log`
- `~/.anima/logs/task-<taskId>.log`

Choose names that make cleanup and grep simple.

## Session Logging Policy

The session extension is the clearest example of why this split matters.

The main `session.log` should contain:

- session lifecycle changes
- prompt start/stop
- slow prompt warnings
- timeout and failure summaries
- session create/switch/reset events

It should not contain:

- every streamed delta
- every SDK event
- every content block event

Those belong in session-scoped files, for example `session-<sessionId>.log`, or in structured transcript/event sinks when the output is intended for replay or analysis.

## Extension Author Checklist

Before adding new logs, ask:

1. Is this line useful to an operator watching the main log?
2. Can this event happen at high frequency during normal use?
3. Is there an existing ID I can use to scope this trace?
4. Should this be a normal log line or a structured data sink?

If the answer to `2` is yes, do not put it in the main log.

## Recommendation

Yes, Anima should keep this dedicated logging doc.

`EXTENSIONS.md` should explain how to use the logger API.
`LOGGING.md` should define policy, best practices, and the distinction between operational logs and scoped traces.
