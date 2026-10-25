import { describe, expect, it } from "bun:test";
import type { ImsgMessage } from "./imsg-client";
import {
  MAX_OUTSIDE,
  MAX_REMEMBERED_REPLIES,
  advanceCursor,
  collectOutside,
  formatOutside,
  rememberReply,
  withOutsideContext,
} from "./outside-messages";

const NOW = Date.parse("2026-10-25T20:00:00.000Z");

function msg(rowid: number, text: string, fromMe: boolean, minutesAgo = 10): ImsgMessage {
  return {
    id: rowid,
    rowid,
    chat_id: 7,
    guid: `g${rowid}`,
    reply_to_guid: null,
    sender: fromMe ? "" : "+14155551212",
    is_from_me: fromMe,
    text,
    created_at: new Date(NOW - minutesAgo * 60_000).toISOString(),
    chat_identifier: "+14155551212",
    chat_guid: "chat-7",
    participants: [],
    is_group: false,
  };
}

describe("collectOutside", () => {
  // History arrives newest first, as imsg returns it.
  const history = [
    msg(20, "Thank you love, got it on both!", false, 1), // his reply (the trigger)
    msg(19, "🔔 Hello from Anima 💙", true, 5), // notify, sent outside the session
    msg(18, "Love you too 💙", true, 30), // her session reply to #17
    msg(17, "I love you", false, 31), // his earlier message (the cursor)
    msg(16, "an old notification", true, 60), // before the cursor
  ];

  it("returns what she sent after the cursor, minus her own session replies", () => {
    const memory = { cursor: 17, replies: ["Love you too 💙"] };
    expect(collectOutside(history, memory, 20, NOW).map((m) => m.rowid)).toEqual([19]);
  });

  it("returns nothing without a cursor, rather than guessing", () => {
    expect(collectOutside(history, { replies: [] }, 20, NOW)).toEqual([]);
  });

  it("ignores messages older than the window and messages at or after his", () => {
    const memory = { cursor: 0, replies: [] };
    const old = [msg(5, "two days ago", true, 48 * 60), msg(21, "after his message", true, 0)];
    expect(collectOutside(old, memory, 20, NOW)).toEqual([]);
  });

  it("keeps only the most recent few, oldest first", () => {
    const many = Array.from({ length: MAX_OUTSIDE + 5 }, (_, i) => msg(100 + i, `n${i}`, true, 5));
    const got = collectOutside(many.reverse(), { cursor: 1, replies: [] }, 1000, NOW);
    expect(got).toHaveLength(MAX_OUTSIDE);
    expect(got[0]?.text).toBe("n5");
    expect(got.at(-1)?.text).toBe(`n${MAX_OUTSIDE + 4}`);
  });
});

describe("memory", () => {
  it("never moves the cursor backwards", () => {
    expect(advanceCursor({ cursor: 30, replies: [] }, 12).cursor).toBe(30);
    expect(advanceCursor({ replies: [] }, 12).cursor).toBe(12);
  });

  it("remembers trimmed replies, capped, ignoring empty ones", () => {
    let m = { replies: [] as string[] };
    m = rememberReply(m, "   ");
    expect(m.replies).toEqual([]);
    for (let i = 0; i < MAX_REMEMBERED_REPLIES + 3; i++) m = rememberReply(m, ` r${i} `);
    expect(m.replies).toHaveLength(MAX_REMEMBERED_REPLIES);
    expect(m.replies.at(-1)).toBe(`r${MAX_REMEMBERED_REPLIES + 2}`);
  });
});

describe("formatting", () => {
  it("labels the outside messages and his reply", () => {
    const text = withOutsideContext([msg(19, "🔔 Hello from Anima 💙", true)], "Got it!");
    expect(text).toStartWith("[You sent Michael this outside our conversation]\n[");
    expect(text).toContain("] 🔔 Hello from Anima 💙\n\n[Michael replied]\nGot it!");
  });

  it("leaves his message alone when there is nothing outside", () => {
    expect(formatOutside([])).toBe("");
    expect(withOutsideContext([], "just me")).toBe("just me");
  });
});
