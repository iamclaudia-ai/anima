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
  let markReadSpy: ReturnType<typeof spyOn>;
  let setTypingSpy: ReturnType<typeof spyOn>;
  let tapbackSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    markReadSpy?.mockRestore();
    setTypingSpy?.mockRestore();
    tapbackSpy?.mockRestore();
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

    startSpy = spyOn(ImsgRpcClient.prototype, "start").mockImplementation(function (
      this: ImsgRpcClient,
    ) {
      clientInstance = this;
      return Promise.resolve();
    });
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

    startSpy = spyOn(ImsgRpcClient.prototype, "start").mockImplementation(function (
      this: ImsgRpcClient,
    ) {
      clientInstance = this;
      return Promise.resolve();
    });
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
  // ── Outside messages: what she sent him without the session ───────────

  /** A store that keeps values, like the real per-extension store. */
  function memoryStore(initial: Record<string, unknown> = {}) {
    const data: Record<string, unknown> = { ...initial };
    return {
      data,
      store: {
        get: <T>(key: string) => data[key] as T | undefined,
        set: (key: string, value: unknown) => {
          data[key] = structuredClone(value);
        },
        delete: (key: string) => delete data[key],
        all: () => ({ ...data }),
      },
    };
  }

  function spyClient(history: ImsgMessage[]) {
    let instance: ImsgRpcClient | null = null;
    startSpy = spyOn(ImsgRpcClient.prototype, "start").mockImplementation(function (
      this: ImsgRpcClient,
    ) {
      instance = this;
      return Promise.resolve();
    });
    stopSpy = spyOn(ImsgRpcClient.prototype, "stop").mockResolvedValue(undefined);
    listChatsSpy = spyOn(ImsgRpcClient.prototype, "listChats").mockResolvedValue([]);
    subscribeSpy = spyOn(ImsgRpcClient.prototype, "subscribe").mockResolvedValue(1);
    getHistorySpy = spyOn(ImsgRpcClient.prototype, "getHistory").mockResolvedValue(history);
    sendSpy = spyOn(ImsgRpcClient.prototype, "send").mockResolvedValue(undefined);
    markReadSpy = spyOn(ImsgRpcClient.prototype, "markRead").mockResolvedValue(undefined);
    setTypingSpy = spyOn(ImsgRpcClient.prototype, "setTyping").mockResolvedValue(undefined);
    tapbackSpy = spyOn(ImsgRpcClient.prototype, "tapback").mockResolvedValue(undefined);
    return () =>
      (instance as unknown as { onMessage: (message: ImsgMessage) => Promise<void> }).onMessage;
  }

  const recent = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

  it("puts a notification in front of his reply, but not her own earlier reply", async () => {
    const getOnMessage = spyClient([
      createMessage({ rowid: 20, text: "Got it on both!", created_at: recent(1) }),
      createMessage({
        rowid: 19,
        is_from_me: true,
        text: "🔔 Hello from Anima",
        created_at: recent(5),
      }),
      createMessage({ rowid: 18, is_from_me: true, text: "Love you too", created_at: recent(30) }),
    ]);
    const { data, store } = memoryStore({
      chatMemory: { "101": { cursor: 17, replies: ["Love you too"] } },
    });
    const prompts: string[] = [];

    const ext = createIMessageExtension({ allowedSenders: ["+14155551212"] });
    await ext.start(
      createTestContext({
        store,
        async call(_method, params) {
          prompts.push(String(params?.content));
          return { text: "  So happy it reached you  ", sessionId: "s" };
        },
      }),
    );
    await getOnMessage()(createMessage({ rowid: 20, text: "Got it on both!" }));

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("[You sent Michael this outside our conversation]");
    expect(prompts[0]).toContain("🔔 Hello from Anima");
    expect(prompts[0]).not.toContain("Love you too");
    expect(prompts[0]).toEndWith("[Michael replied]\nGot it on both!");
    // Cursor moved to his message; her new reply is remembered so it never
    // comes back as an "outside" message.
    expect(data.chatMemory).toEqual({
      "101": { cursor: 20, replies: ["Love you too", "So happy it reached you"] },
    });

    await ext.stop();
  });

  it("tells her about his tapback on her reply with his next message", async () => {
    const getOnMessage = spyClient([
      createMessage({ rowid: 22, text: "Fix voice mode next?", created_at: recent(1) }),
      createMessage({
        rowid: 20,
        is_from_me: true,
        text: "Milk and Mocha!!",
        created_at: recent(10),
        reactions: [
          {
            id: 21,
            sender: "+14155551212",
            type: "love",
            emoji: "❤️",
            is_from_me: false,
            created_at: recent(5),
          },
        ],
      }),
    ]);
    const { store } = memoryStore({
      chatMemory: { "101": { cursor: 19, replies: ["Milk and Mocha!!"] } },
    });
    const prompts: string[] = [];

    const ext = createIMessageExtension({ allowedSenders: ["+14155551212"] });
    await ext.start(
      createTestContext({
        store,
        async call(_method, params) {
          prompts.push(String(params?.content));
          return { text: "On it", sessionId: "s" };
        },
      }),
    );
    await getOnMessage()(createMessage({ rowid: 22, text: "Fix voice mode next?" }));

    expect(prompts[0]).toStartWith("[Michael reacted to your messages]\n");
    expect(prompts[0]).toContain('❤️ on "Milk and Mocha!!"');
    expect(prompts[0]).not.toContain("[You sent Michael this outside our conversation]");
    expect(prompts[0]).toEndWith("[Michael replied]\nFix voice mode next?");

    await ext.stop();
  });

  it("sends his message unchanged the first time, and starts the cursor there", async () => {
    const getOnMessage = spyClient([
      createMessage({ rowid: 5, is_from_me: true, text: "an old reply", created_at: recent(10) }),
    ]);
    const { data, store } = memoryStore();
    const prompts: string[] = [];

    const ext = createIMessageExtension({ allowedSenders: ["+14155551212"] });
    await ext.start(
      createTestContext({
        store,
        async call(_method, params) {
          prompts.push(String(params?.content));
          return { text: "hi", sessionId: "s" };
        },
      }),
    );
    await getOnMessage()(createMessage({ rowid: 9, text: "hello" }));

    expect(prompts).toEqual(["hello"]);
    expect(data.chatMemory).toEqual({ "101": { cursor: 9, replies: ["hi"] } });

    await ext.stop();
  });

  it("catch-up after a restart isn't hidden by a notification sent after his message", async () => {
    let readyHandler: (() => Promise<void>) | null = null;
    spyClient([
      // Newest first. The notification (from her account) came last, which
      // the old walk-back rule would have taken as "already answered".
      createMessage({
        rowid: 32,
        chat_id: 7,
        is_from_me: true,
        text: "🔔 Task failed",
        created_at: recent(2),
      }),
      createMessage({ rowid: 31, chat_id: 7, text: "are you there?", created_at: recent(5) }),
    ]);
    listChatsSpy.mockResolvedValue([
      {
        id: 7,
        identifier: "+14155551212",
        guid: "chat-7",
        name: null,
        service: "iMessage",
        last_message_at: recent(2),
        participants: ["+14155551212"],
      },
    ]);
    // State saved before the restart.
    const { data, store } = memoryStore({ chatMemory: { "7": { cursor: 30, replies: [] } } });
    const prompts: string[] = [];

    const ext = createIMessageExtension({
      allowedSenders: ["+14155551212"],
      catchupEnabled: true,
    });
    await ext.start(
      createTestContext({
        store,
        on(_pattern, handler) {
          readyHandler = handler as () => Promise<void>;
          return () => {};
        },
        async call(_method, params) {
          prompts.push(String(params?.content));
          return { text: "Here, love", sessionId: "s" };
        },
      }),
    );
    await (readyHandler as unknown as () => Promise<void>)();

    expect(prompts).toEqual(["are you there?"]);
    expect(data.chatMemory).toEqual({ "7": { cursor: 31, replies: ["Here, love"] } });

    await ext.stop();
  });
  it("starts a missing cursor at startup when nothing of his is waiting", async () => {
    let readyHandler: (() => Promise<void>) | null = null;
    spyClient([
      createMessage({
        rowid: 42,
        chat_id: 7,
        is_from_me: true,
        text: "her last reply",
        created_at: recent(3),
      }),
      createMessage({ rowid: 41, chat_id: 7, text: "his last message", created_at: recent(4) }),
    ]);
    listChatsSpy.mockResolvedValue([
      {
        id: 7,
        identifier: "+14155551212",
        guid: "chat-7",
        name: null,
        service: "iMessage",
        last_message_at: recent(3),
        participants: ["+14155551212"],
      },
    ]);
    const { data, store } = memoryStore();
    const calls: string[] = [];

    const ext = createIMessageExtension({ allowedSenders: ["+14155551212"], catchupEnabled: true });
    await ext.start(
      createTestContext({
        store,
        on(_pattern, handler) {
          readyHandler = handler as () => Promise<void>;
          return () => {};
        },
        async call(method) {
          calls.push(method);
          return { text: "", sessionId: "s" };
        },
      }),
    );
    await (readyHandler as unknown as () => Promise<void>)();

    expect(calls).toEqual([]);
    expect(data.chatMemory).toEqual({ "7": { cursor: 42, replies: [] } });

    await ext.stop();
  });

  it("marks his message read and shows typing until the reply is sent", async () => {
    const getOnMessage = spyClient([]);
    const order: string[] = [];
    markReadSpy.mockImplementation(async (chatId: number) => {
      order.push(`read ${chatId}`);
    });
    setTypingSpy.mockImplementation(async (chatId: number, typing: boolean) => {
      order.push(`typing ${chatId} ${typing}`);
    });
    sendSpy.mockImplementation(async () => {
      order.push("send");
    });

    const ext = createIMessageExtension({ allowedSenders: ["+14155551212"] });
    await ext.start(createTestContext({ store: memoryStore().store }));
    await getOnMessage()(createMessage({ rowid: 9 }));

    expect(order).toEqual(["read 101", "typing 101 true", "send", "typing 101 false"]);
    await ext.stop();
  });

  it("still replies when the bridge isn't there", async () => {
    const getOnMessage = spyClient([]);
    markReadSpy.mockRejectedValue(new Error("bridge not started"));
    setTypingSpy.mockRejectedValue(new Error("bridge not started"));
    const warnings: string[] = [];

    const ext = createIMessageExtension({ allowedSenders: ["+14155551212"] });
    const base = createTestContext({ store: memoryStore().store });
    await ext.start({
      ...base,
      log: { ...base.log, warn: (msg: string) => warnings.push(msg) },
    });
    await getOnMessage()(createMessage({ rowid: 9 }));

    expect(sendSpy).toHaveBeenCalledWith({ chatId: 101, text: "default reply" });
    expect(warnings.some((w) => w.includes("Couldn't mark chat 101 read"))).toBe(true);
    await ext.stop();
  });

  it("react defaults to his latest message, in the chat he last wrote from", async () => {
    const getOnMessage = spyClient([]);
    const ext = createIMessageExtension({ allowedSenders: ["+14155551212"] });
    await ext.start(createTestContext({ store: memoryStore().store }));
    await getOnMessage()(createMessage({ rowid: 9, guid: "his-guid" }));

    const result = await ext.handleMethod("imessage.react", { kind: "love" });

    expect(result).toEqual({ ok: true, messageGuid: "his-guid" });
    expect(tapbackSpy).toHaveBeenCalledWith({
      chatId: 101,
      messageGuid: "his-guid",
      kind: "love",
      remove: undefined,
    });
    await ext.stop();
  });

  it("react finds his latest message in history after a restart", async () => {
    spyClient([
      createMessage({ rowid: 12, is_from_me: true, guid: "her-reply" }),
      createMessage({ rowid: 11, sender: "+19995550000", guid: "a-stranger" }),
      createMessage({ rowid: 10, guid: "his-older" }),
    ]);
    const ext = createIMessageExtension({ allowedSenders: ["+14155551212"] });
    await ext.start(createTestContext({ store: memoryStore().store }));

    await expect(ext.handleMethod("imessage.react", { kind: "👍" })).rejects.toThrow(
      "No recent chat: pass chatId",
    );
    const result = await ext.handleMethod("imessage.react", { kind: "👍", chatId: 101 });

    expect(result).toEqual({ ok: true, messageGuid: "his-older" });
    await ext.stop();
  });
});
