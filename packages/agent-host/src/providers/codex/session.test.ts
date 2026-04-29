import { describe, expect, it } from "bun:test";
import { CodexSession, createCodexProvider } from "./session";

function fakeClient(events: any[]) {
  return {
    startThread: () => ({
      runStreamed: async () => ({
        events: (async function* () {
          for (const event of events) yield event;
        })(),
      }),
    }),
  };
}

describe("CodexSession", () => {
  it("normalizes streamed Codex agent messages to session SSE events", async () => {
    const session = new CodexSession(
      "codex-session-1",
      { cwd: "/repo", model: "gpt-5.2-codex" },
      {
        createClient: () =>
          fakeClient([
            {
              type: "item.updated",
              item: { id: "msg1", type: "agent_message", text: "hel" },
            },
            {
              type: "item.updated",
              item: { id: "msg1", type: "agent_message", text: "hello" },
            },
            {
              type: "item.completed",
              item: { id: "msg1", type: "agent_message", text: "hello" },
            },
          ]),
      },
    );
    const events: Array<Record<string, unknown>> = [];
    session.on("sse", (event) => events.push(event));

    await session.start();
    await session.prompt("say hello");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events.map((event) => event.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_stop",
      "turn_stop",
    ]);
    expect(events[2]).toMatchObject({ delta: { type: "text_delta", text: "hel" } });
    expect(events[3]).toMatchObject({ delta: { type: "text_delta", text: "lo" } });
  });

  it("creates and resumes sessions through a provider factory", () => {
    const provider = createCodexProvider({ apiKey: "test-key" });
    const created = provider.create({ sessionId: "created", cwd: "/repo", model: "m" });
    const resumed = provider.resume("resumed", { cwd: "/repo", model: "m" });

    expect(created.id).toBe("created");
    expect(resumed.id).toBe("resumed");
  });
});
