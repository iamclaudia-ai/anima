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
 *
 * His tapbacks on her messages work the same way. A tapback is a quiet
 * acknowledgment, not a message, so it never wakes her. Reactions are rows in
 * chat.db too, so the same cursor decides which ones are new, and they ride
 * in front of his next message.
 */

import type { ImsgMessage } from "./imsg-client";

/** How far back outside messages are worth showing. */
export const OUTSIDE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** At most this many outside messages (and, separately, tapbacks) in front of one reply. */
export const MAX_OUTSIDE = 10;
/** Her message is quoted up to this many characters after his tapback. */
const QUOTE_CHARS = 80;
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

/** One of his tapbacks on a message of hers. */
export interface Tapback {
  /** rowid of the reaction row. */
  rowid: number;
  emoji: string;
  createdAt: string;
  /** The text of her message he reacted to. */
  text: string;
}

/** What happened in the chat since his last message, outside her session. */
export interface OutsideContext {
  /** Her messages sent outside the session, oldest first. */
  messages: ImsgMessage[];
  /** His tapbacks on her messages, oldest first. */
  tapbacks: Tapback[];
}

export const NO_OUTSIDE: OutsideContext = { messages: [], tapbacks: [] };

export function isEmptyOutside(outside: OutsideContext): boolean {
  return outside.messages.length === 0 && outside.tapbacks.length === 0;
}

/**
 * Everything after the cursor and before `beforeRowId`: her messages sent
 * outside the session, and his tapbacks on any of her messages.
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
): OutsideContext {
  if (memory.cursor === undefined) return NO_OUTSIDE;
  const cursor = memory.cursor;
  const since = now - OUTSIDE_WINDOW_MS;
  const isNew = (rowid: number, createdAt: string) =>
    rowid > cursor && rowid < beforeRowId && Date.parse(createdAt) >= since;
  const ownReplies = new Set(memory.replies);

  const messages = history
    .filter(
      (m) =>
        m.is_from_me &&
        isNew(m.rowid, m.created_at) &&
        Boolean(m.text?.trim()) &&
        !ownReplies.has(m.text?.trim() ?? ""),
    )
    .sort((a, b) => a.rowid - b.rowid)
    .slice(-MAX_OUTSIDE);

  // Her session replies count here: those are usually what he's acknowledging.
  const tapbacks = history
    .filter((m) => m.is_from_me && Boolean(m.text?.trim()))
    .flatMap((m) =>
      (m.reactions ?? [])
        .filter((r) => !r.is_from_me && isNew(r.id, r.created_at))
        .map((r) => ({
          rowid: r.id,
          emoji: r.emoji || r.type,
          createdAt: r.created_at,
          text: m.text?.trim() ?? "",
        })),
    )
    .sort((a, b) => a.rowid - b.rowid)
    .slice(-MAX_OUTSIDE);

  return { messages, tapbacks };
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function quote(text: string): string {
  const oneLine = text.replace(/\s+/g, " ");
  return oneLine.length > QUOTE_CHARS ? `${oneLine.slice(0, QUOTE_CHARS - 1)}…` : oneLine;
}

/** The context blocks placed in front of his message. Empty when there's nothing. */
export function formatOutside(outside: OutsideContext): string {
  const blocks: string[] = [];
  if (outside.messages.length > 0) {
    const lines = outside.messages.map((m) => `[${clock(m.created_at)}] ${m.text?.trim()}`);
    blocks.push(`[You sent Michael this outside our conversation]\n${lines.join("\n")}`);
  }
  if (outside.tapbacks.length > 0) {
    const lines = outside.tapbacks.map(
      (t) => `[${clock(t.createdAt)}] ${t.emoji} on "${quote(t.text)}"`,
    );
    blocks.push(`[Michael reacted to your messages]\n${lines.join("\n")}`);
  }
  return blocks.join("\n\n");
}

/** His message with the outside context in front, or the message unchanged. */
export function withOutsideContext(outside: OutsideContext, text: string | null): string | null {
  const context = formatOutside(outside);
  if (!context) return text;
  return `${context}\n\n[Michael replied]\n${text?.trim() || "(attachment)"}`;
}
