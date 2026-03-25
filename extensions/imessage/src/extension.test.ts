import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { ExtensionContext } from "@anima/shared";
import { PERSISTENT_SESSION_ID } from "@anima/shared";
import { createIMessageExtension } from "./index";
import { ImsgRpcClient, type ImsgMessage } from "./imsg-client";

function createTestContext(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    on: () => () => {},
    emit: () => {},
    async call() {
      return { text: "default reply", sessionId: "session-1" };
    },
    connectionId: null,
    tags: null,
    config: {},
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => ({
        info: () => {},
        warn: () => {},
        error: () => {},
        child: () => {
          throw new Error("not implemented");
        },
      }),
    },
    createLogger: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      child() {
        return this;
      },
    }),
    store: {
      get: () => undefined,
      set: () => {},
      delete: () => true,
      all: () => ({}),
    },
    ...overrides,
  };
}

function createMessage(overrides: Partial<ImsgMessage> = {}): ImsgMessage {
  return {
    id: 1,
    rowid: 1,
    chat_id: 101,
    guid: "msg-1",
    reply_to_guid: null,
    sender: "+14155551212",
    is_from_me: false,
    text: "hello",
    created_at: "2026-03-21T12:00:00.000Z",
    chat_identifier: "+14155551212",
    chat_guid: "chat-101",
    participants: ["+14155551212"],
    attachments: [],
    reactions: [],
    is_group: false,
    ...overrides,
  };
}

describe("iMessage extension", () => {
  let startSpy: ReturnType<typeof spyOn>;
  let stopSpy: ReturnType<typeof spyOn>;
  let listChatsSpy: ReturnType<typeof spyOn>;
  let subscribeSpy: ReturnType<typeof spyOn>;
  let getHistorySpy: ReturnType<typeof spyOn>;
  let sendSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    startSpy?.mockRestore();
    stopSpy?.mockRestore();
    listChatsSpy?.mockRestore();
    subscribeSpy?.mockRestore();
    getHistorySpy?.mockRestore();
    sendSpy?.mockRestore();
  });

  it("routes incoming messages through the shared persistent session keyed by cwd", async () => {
    let clientInstance: ImsgRpcClient | null = null;
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const emitted: Array<{ eventName: string; payload: unknown }> = [];

    startSpy = spyOn(ImsgRpcClient.prototype, "start").mockImplementation(
      function (this: ImsgRpcClient) {
        clientInstance = this;
        return Promise.resolve();
      },
    );
    stopSpy = spyOn(ImsgRpcClient.prototype, "stop").mockResolvedValue(undefined);
    listChatsSpy = spyOn(ImsgRpcClient.prototype, "listChats").mockResolvedValue([]);
    subscribeSpy = spyOn(ImsgRpcClient.prototype, "subscribe").mockResolvedValue(1);
    getHistorySpy = spyOn(ImsgRpcClient.prototype, "getHistory").mockResolvedValue([]);
    sendSpy = spyOn(ImsgRpcClient.prototype, "send").mockResolvedValue(undefined);

    const ext = createIMessageExtension({
      allowedSenders: ["+14155551212"],
      workspaceCwd: "/repo/general",
    });
    await ext.start(
      createTestContext({
        async call(method, params) {
          calls.push({ method, params: params || {} });
          return { text: "  hello back  ", sessionId: "session-1" };
        },
        emit(eventName, payload) {
          emitted.push({ eventName, payload });
        },
      }),
    );

    await (
      clientInstance as unknown as { onMessage: (message: ImsgMessage) => Promise<void> }
    ).onMessage(createMessage());

    expect(calls).toEqual([
      {
        method: "session.send_prompt",
        params: {
          sessionId: PERSISTENT_SESSION_ID,
          content: "hello",
          cwd: "/repo/general",
          streaming: false,
          source: "imessage/101",
        },
      },
    ]);
    expect(sendSpy).toHaveBeenCalledWith({ chatId: 101, text: "hello back" });
    expect(emitted.map((event) => event.eventName)).toEqual(["imessage.message", "imessage.sent"]);

    await ext.stop();
  });

  it("runs catchup after gateway.extensions_ready and batches unanswered messages", async () => {
    let readyHandler: (() => Promise<void>) | null = null;
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];

    startSpy = spyOn(ImsgRpcClient.prototype, "start").mockResolvedValue(undefined);
    stopSpy = spyOn(ImsgRpcClient.prototype, "stop").mockResolvedValue(undefined);
    listChatsSpy = spyOn(ImsgRpcClient.prototype, "listChats").mockResolvedValue([
      {
        id: 7,
        identifier: "+14155551212",
        guid: "chat-7",
        name: null,
        service: "iMessage",
        last_message_at: "2026-03-21T12:00:00.000Z",
        participants: ["+14155551212"],
      },
    ]);
    subscribeSpy = spyOn(ImsgRpcClient.prototype, "subscribe").mockResolvedValue(1);
    getHistorySpy = spyOn(ImsgRpcClient.prototype, "getHistory").mockResolvedValue([
      createMessage({
        rowid: 3,
        chat_id: 7,
        text: "latest question",
        created_at: "2026-03-21T12:02:00.000Z",
      }),
      createMessage({
        rowid: 2,
        chat_id: 7,
        text: "earlier question",
        created_at: "2026-03-21T12:01:00.000Z",
      }),
      createMessage({
        rowid: 1,
        chat_id: 7,
        is_from_me: true,
        text: "older reply",
        created_at: "2026-03-21T12:00:00.000Z",
      }),
    ]);
    sendSpy = spyOn(ImsgRpcClient.prototype, "send").mockResolvedValue(undefined);

    const ext = createIMessageExtension({
      allowedSenders: ["+14155551212"],
      workspaceCwd: "/repo/general",
      catchupEnabled: true,
    });
    await ext.start(
      createTestContext({
        on(_pattern, handler) {
          readyHandler = handler as () => Promise<void>;
          return () => {};
        },
        async call(method, params) {
          calls.push({ method, params: params || {} });
          return { text: "  catchup reply  ", sessionId: "session-1" };
        },
      }),
    );

    if (!readyHandler) {
      throw new Error("Expected gateway.extensions_ready handler to be registered");
    }
    await (readyHandler as () => Promise<void>)();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("session.send_prompt");
    expect(calls[0]?.params.sessionId).toBe(PERSISTENT_SESSION_ID);
    expect(calls[0]?.params.cwd).toBe("/repo/general");
    expect(calls[0]?.params.source).toBe("imessage/7");
    expect(String(calls[0]?.params.content)).toContain(
      "[Catching up on 2 messages received while I was offline]",
    );
    expect(String(calls[0]?.params.content)).toContain("earlier question");
    expect(String(calls[0]?.params.content)).toContain("latest question");
    expect(sendSpy).toHaveBeenCalledWith({ chatId: 7, text: "catchup reply" });

    await ext.stop();
  });

  it("ignores self-authored and empty inbound messages", async () => {
    let clientInstance: ImsgRpcClient | null = null;
    const callFn = mock(async () => ({ text: "ignored", sessionId: "session-1" }));

    startSpy = spyOn(ImsgRpcClient.prototype, "start").mockImplementation(
      function (this: ImsgRpcClient) {
        clientInstance = this;
        return Promise.resolve();
      },
    );
    stopSpy = spyOn(ImsgRpcClient.prototype, "stop").mockResolvedValue(undefined);
    listChatsSpy = spyOn(ImsgRpcClient.prototype, "listChats").mockResolvedValue([]);
    subscribeSpy = spyOn(ImsgRpcClient.prototype, "subscribe").mockResolvedValue(1);
    getHistorySpy = spyOn(ImsgRpcClient.prototype, "getHistory").mockResolvedValue([]);
    sendSpy = spyOn(ImsgRpcClient.prototype, "send").mockResolvedValue(undefined);

    const ext = createIMessageExtension({
      allowedSenders: ["+14155551212"],
    });
    await ext.start(
      createTestContext({
        call: callFn,
      }),
    );

    const onMessage = (
      clientInstance as unknown as { onMessage: (message: ImsgMessage) => Promise<void> }
    ).onMessage;
    await onMessage(createMessage({ is_from_me: true }));
    await onMessage(createMessage({ text: "   ", attachments: [] }));

    expect(callFn).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();

    await ext.stop();
  });
});
