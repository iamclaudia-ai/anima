/**
 * Messages Claudia sent to Michael *outside* her iMessage session.
 *
 * The bridge wakes her session with Michael's message only, and it ignores
 * everything sent from her own account. That was fine while the session was
 * the only thing that ever texted him. Now notify.send (and any other session)
 * can text him too, and when he replies to one of those, his reply arrived
 * with no idea what it was answering ("did I say I love you?").
 *
 * So for each chat the bridge keeps:
 *
 *   - a cursor: the rowid of the last message of his it has processed, and
 *   - the texts it sent as her replies (the last few).
 *
 * When his next message arrives, the messages from her account between the
 * cursor and his message are what she sent without the session. Her own
 * session replies are in that range too, but she already has those in
 * context, so they're recognised by their text and skipped. (A rowid cursor
 * on her reply can't do this: the reply lands in chat.db a moment after it is
 * sent, so there's no reliable rowid to move to.)
 *
 * Nothing is added to her session when a notification goes out, so it never
 * wakes her or reads as Michael's prompt. She only sees it when he answers.
 */

import type { ImsgMessage } from "./imsg-client";

/** How far back outside messages are worth showing. */
export const OUTSIDE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** At most this many outside messages in front of one reply. */
export const MAX_OUTSIDE = 10;
/** Session replies remembered per chat, for recognising them in history. */
export const MAX_REMEMBERED_REPLIES = 20;

export interface ChatMemory {
  /** rowid of the last message from Michael that the bridge processed. */
  cursor?: number;
  /** Trimmed texts of the bridge's own replies in this chat, newest last. */
  replies: string[];
}

export type ChatMemories = Record<string, ChatMemory>;

export const STORE_KEY = "chatMemory";

export function memoryFor(all: ChatMemories | undefined, chatId: number): ChatMemory {
  const found = all?.[String(chatId)];
  return { cursor: found?.cursor, replies: found?.replies ?? [] };
}

/** Remember a reply the bridge sent, keeping the most recent few. */
export function rememberReply(memory: ChatMemory, text: string): ChatMemory {
  const trimmed = text.trim();
  if (!trimmed) return memory;
  return { ...memory, replies: [...memory.replies, trimmed].slice(-MAX_REMEMBERED_REPLIES) };
}

/** Move the cursor forward (never back) to a processed message of his. */
export function advanceCursor(memory: ChatMemory, rowid: number): ChatMemory {
  return { ...memory, cursor: Math.max(memory.cursor ?? 0, rowid) };
}

/**
 * Her messages sent outside the session, after the cursor and before
 * `beforeRowId`, oldest first.
 *
 * Without a cursor (the first message after this feature shipped) there is no
 * reliable starting point: her old session replies would come back as
 * "outside" duplicates. So nothing is returned, and the caller sets the cursor.
 */
export function collectOutside(
  history: ImsgMessage[],
  memory: ChatMemory,
  beforeRowId: number,
  now = Date.now(),
): ImsgMessage[] {
  if (memory.cursor === undefined) return [];
  const cursor = memory.cursor;
  const since = now - OUTSIDE_WINDOW_MS;
  const ownReplies = new Set(memory.replies);
  return history
    .filter(
      (m) =>
        m.is_from_me &&
        m.rowid > cursor &&
        m.rowid < beforeRowId &&
        Boolean(m.text?.trim()) &&
        !ownReplies.has(m.text?.trim() ?? "") &&
        Date.parse(m.created_at) >= since,
    )
    .sort((a, b) => a.rowid - b.rowid)
    .slice(-MAX_OUTSIDE);
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** The context block placed in front of his message. Empty when there's nothing. */
export function formatOutside(messages: ImsgMessage[]): string {
  if (messages.length === 0) return "";
  const lines = messages.map((m) => `[${clock(m.created_at)}] ${m.text?.trim()}`);
  return `[You sent Michael this outside our conversation]\n${lines.join("\n")}`;
}

/** His message with the outside context in front, or the message unchanged. */
export function withOutsideContext(outside: ImsgMessage[], text: string | null): string | null {
  const context = formatOutside(outside);
  if (!context) return text;
  return `${context}\n\n[Michael replied]\n${text?.trim() || "(attachment)"}`;
}
