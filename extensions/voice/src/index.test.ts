import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext, GatewayEvent } from "@anima/shared";
import { cleanForSpeech, createVoiceExtension, StreamingSpeechFilter } from "./index";
import { SentenceChunker } from "./sentence-chunker";

function createTestContext() {
  const listeners = new Map<string, Array<(event: GatewayEvent) => void | Promise<void>>>();
  const emitted: Array<{ type: string; payload: unknown; options?: Record<string, unknown> }> = [];
  let ambientConnectionId: string | null = null;
  let ambientTags: string[] | null = null;

  const ctx: ExtensionContext = {
    on(pattern, handler) {
      const handlers = listeners.get(pattern) ?? [];
      handlers.push(handler);
      listeners.set(pattern, handlers);
      return () => {
        const current = listeners.get(pattern) ?? [];
        listeners.set(
          pattern,
          current.filter((candidate) => candidate !== handler),
        );
      };
    },
    emit(type, payload, options) {
      emitted.push({ type, payload, options });
    },
    async call() {
      return {};
    },
    get connectionId() {
      return ambientConnectionId;
    },
    get tags() {
      return ambientTags;
    },
    config: {},
    log: {
      info() {},
      warn() {},
      error() {},
      child() {
        return this;
      },
    },
    createLogger() {
      return {
        info() {},
        warn() {},
        error() {},
        child() {
          return this;
        },
      };
    },
    store: {
      get() {
        return undefined;
      },
      set() {},
      delete() {
        return true;
      },
      all() {
        return {};
      },
    },
  };

  return {
    ctx,
    emitted,
    setAmbient(connectionId: string | null, tags: string[] | null = null) {
      ambientConnectionId = connectionId;
      ambientTags = tags;
    },
    async trigger(pattern: string, event: GatewayEvent) {
      for (const handler of listeners.get(pattern) ?? []) {
        await handler(event);
      }
    },
    listenerCount(pattern: string) {
      return (listeners.get(pattern) ?? []).length;
    },
  };
}

describe("cleanForSpeech", () => {
  it("removes bullet list items", () => {
    const input = [
      "Here is what I found:",
      "- first bullet",
      "* second bullet",
      "• third bullet",
      "This sentence should stay.",
    ].join("\n");

    expect(cleanForSpeech(input)).toBe("Here is what I found: This sentence should stay.");
  });

  it("removes numbered list items", () => {
    const input = [
      "Plan:",
      "1. first",
      "2) second",
      "3 . spaced separator",
      "4\\. escaped dot in markdown",
      "Done.",
    ].join("\n");

    expect(cleanForSpeech(input)).toBe("Plan: Done.");
  });

  it("removes bold numbered list items", () => {
    const input = ["Summary:", "**1. first**", "  **2) second**", "Done."].join("\n");
    expect(cleanForSpeech(input)).toBe("Summary: Done.");
  });

  it("removes fenced code blocks with indented fences", () => {
    const input = [
      "I checked the implementation:",
      "   ```typescript",
      "   const x = 1;",
      "   console.log(x);",
      "   ```",
      "All good now.",
    ].join("\n");
    expect(cleanForSpeech(input)).toBe("I checked the implementation: All good now.");
  });

  it("filters fenced code blocks across streaming chunks", () => {
    const filter = new StreamingSpeechFilter();
    const chunker = new SentenceChunker();

    const input = [
      "Here is the plan.",
      "```typescript",
      "const x = 1;",
      "console.log(x);",
      "```",
      "This should be spoken.",
    ].join("\n");

    const chunks = [
      input.slice(0, 18),
      input.slice(18, 37),
      input.slice(37, 55),
      input.slice(55, 80),
      input.slice(80),
    ];

    const spoken: string[] = [];
    for (const chunk of chunks) {
      const filtered = filter.feed(chunk);
      if (!filtered) continue;
      for (const sentence of chunker.feed(filtered)) {
        const cleaned = cleanForSpeech(sentence);
        if (cleaned) spoken.push(cleaned);
      }
    }

    const trailingFiltered = filter.flush();
    if (trailingFiltered) {
      for (const sentence of chunker.feed(trailingFiltered)) {
        const cleaned = cleanForSpeech(sentence);
        if (cleaned) spoken.push(cleaned);
      }
    }

    const remaining = chunker.flush();
    if (remaining) {
      const cleaned = cleanForSpeech(remaining);
      if (cleaned) spoken.push(cleaned);
    }

    expect(spoken.join(" ")).toBe("Here is the plan. This should be spoken.");
  });

  it("matches transcript expected output", () => {
    const repoRoot = join(import.meta.dir, "..", "..", "..");
    if (!existsSync(join(repoRoot, "tmp", "transcript.md"))) return;
    const transcript = readFileSync(join(repoRoot, "tmp", "transcript.md"), "utf8");
    const expected = readFileSync(join(repoRoot, "tmp", "transcript-result.md"), "utf8");

    expect(cleanForSpeech(transcript)).toBe(cleanForSpeech(expected));
  });

  it("matches transcript expected output through streaming simulation", () => {
    const repoRoot = join(import.meta.dir, "..", "..", "..");
    if (!existsSync(join(repoRoot, "tmp", "transcript.md"))) return;
    const transcript = readFileSync(join(repoRoot, "tmp", "transcript.md"), "utf8");
    const expected = readFileSync(join(repoRoot, "tmp", "transcript-result.md"), "utf8");

    const filter = new StreamingSpeechFilter();
    const chunker = new SentenceChunker();
    const spoken: string[] = [];

    const chunkSize = 73;
    for (let i = 0; i < transcript.length; i += chunkSize) {
      const filtered = filter.feed(transcript.slice(i, i + chunkSize));
      if (!filtered) continue;
      for (const sentence of chunker.feed(filtered)) {
        const cleaned = cleanForSpeech(sentence);
        if (cleaned) spoken.push(cleaned);
      }
    }

    const trailingFiltered = filter.flush();
    if (trailingFiltered) {
      for (const sentence of chunker.feed(trailingFiltered)) {
        const cleaned = cleanForSpeech(sentence);
        if (cleaned) spoken.push(cleaned);
      }
    }

    const remaining = chunker.flush();
    if (remaining) {
      const cleaned = cleanForSpeech(remaining);
      if (cleaned) spoken.push(cleaned);
    }

    expect(spoken.join(" ")).toBe(cleanForSpeech(expected));
  });
});

describe("voice extension", () => {
  it("declares runtime scheduling metadata for its methods", () => {
    const ext = createVoiceExtension({ apiKey: "test-key" });
    const methodMap = new Map(ext.methods.map((method) => [method.name, method]));

    expect(methodMap.get("voice.health_check")?.execution).toEqual({
      lane: "control",
      concurrency: "parallel",
    });
    expect(methodMap.get("voice.status")?.execution).toEqual({
      lane: "read",
      concurrency: "parallel",
    });
    expect(methodMap.get("voice.speak")?.execution).toEqual({
      lane: "long_running",
      concurrency: "keyed",
      keyContext: "connectionId",
    });
    expect(methodMap.get("voice.stop")?.execution).toEqual({
      lane: "write",
      concurrency: "keyed",
      keyContext: "connectionId",
    });
  });

  it("tracks voiced session state per connection and reports health/status", async () => {
    const mock = createTestContext();
    const ext = createVoiceExtension({ apiKey: "test-key", streaming: true });

    await ext.start(mock.ctx);

    await mock.trigger("session.*.content_block_start", {
      type: "session.s-1.content_block_start",
      payload: { content_block: { type: "text" }, sessionId: "s-1" },
      timestamp: Date.now(),
      connectionId: "conn-a",
      tags: ["voice.speak"],
    });
    await mock.trigger("session.*.content_block_start", {
      type: "session.s-2.content_block_start",
      payload: { content_block: { type: "text" }, sessionId: "s-2" },
      timestamp: Date.now(),
      connectionId: "conn-b",
      tags: ["voice.speak"],
    });

    const status = (await ext.handleMethod("voice.status", {})) as {
      activeConnections: Array<{
        connectionId: string;
        speaking: boolean;
        activeStream: string | null;
        sessionId: string | null;
        queueLength: number;
      }>;
    };
    expect(status.activeConnections).toEqual([
      {
        connectionId: "conn-a",
        speaking: true,
        sessionId: "s-1",
        activeStream: expect.any(String),
        queueLength: 0,
      },
      {
        connectionId: "conn-b",
        speaking: true,
        sessionId: "s-2",
        activeStream: expect.any(String),
        queueLength: 0,
      },
    ]);

    const health = (await ext.handleMethod("voice.health_check", {})) as {
      status: string;
      metrics: Array<{ label: string; value: string | number }>;
    };
    expect(health.status).toBe("healthy");
    expect(health.metrics).toContainEqual({ label: "Speaking", value: "yes" });
    expect(health.metrics).toContainEqual({ label: "Connections", value: "2" });

    expect(mock.listenerCount("session.*.content_block_start")).toBe(1);
    expect(mock.listenerCount("session.*.content_block_delta")).toBe(1);
    expect(mock.listenerCount("session.*.message_stop")).toBe(1);

    await ext.stop();
    expect(ext.health()).toEqual({
      ok: true,
      details: {
        apiKeyConfigured: true,
        streaming: true,
        voiceId: "a0e99841-438c-4a64-b679-ae501e7d6091",
        speaking: false,
        activeConnections: 0,
      },
    });
    expect(mock.listenerCount("session.*.content_block_start")).toBe(0);
    expect(mock.listenerCount("session.*.content_block_delta")).toBe(0);
    expect(mock.listenerCount("session.*.message_stop")).toBe(0);
  });

  it("stops only the current connection when called from a connection-scoped request", async () => {
    const mock = createTestContext();
    const ext = createVoiceExtension({ apiKey: "test-key", streaming: true });

    await ext.start(mock.ctx);

    await mock.trigger("session.*.content_block_start", {
      type: "session.s-1.content_block_start",
      payload: { content_block: { type: "text" }, sessionId: "s-1" },
      timestamp: Date.now(),
      connectionId: "conn-a",
      tags: ["voice.speak"],
    });
    await mock.trigger("session.*.content_block_start", {
      type: "session.s-2.content_block_start",
      payload: { content_block: { type: "text" }, sessionId: "s-2" },
      timestamp: Date.now(),
      connectionId: "conn-b",
      tags: ["voice.speak"],
    });

    mock.setAmbient("conn-a");
    await ext.handleMethod("voice.stop", {});

    const status = (await ext.handleMethod("voice.status", {})) as {
      activeConnections: Array<{
        connectionId: string;
        speaking: boolean;
        activeStream: string | null;
        sessionId: string | null;
        queueLength: number;
      }>;
    };
    expect(status.activeConnections).toEqual([
      {
        connectionId: "conn-b",
        activeStream: expect.any(String),
        queueLength: 0,
        sessionId: "s-2",
        speaking: true,
      },
    ]);
    expect(mock.emitted.some((event) => event.type === "voice.stream_end")).toBe(true);

    await ext.stop();
  });
});
