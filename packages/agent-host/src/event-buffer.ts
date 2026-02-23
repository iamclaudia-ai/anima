/**
 * Event Buffer — per-session ring buffer for reconnection replay.
 *
 * Each session maintains a buffer of the last N events with monotonic
 * sequence numbers. When a client reconnects, it sends its lastSeenSeq
 * and the buffer replays everything since.
 */

export interface BufferedEvent {
  seq: number;
  event: unknown;
}

export class EventBuffer {
  private buffer: BufferedEvent[] = [];
  private nextSeq = 1;
  private maxSize: number;

  constructor(maxSize = 500) {
    this.maxSize = maxSize;
  }

  /** Push an event into the buffer. Returns the assigned sequence number. */
  push(event: unknown): number {
    const seq = this.nextSeq++;
    this.buffer.push({ seq, event });
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
    return seq;
  }

  /** Get all events after a given sequence number (for reconnection replay). */
  getAfter(lastSeenSeq: number): BufferedEvent[] {
    return this.buffer.filter((e) => e.seq > lastSeenSeq);
  }

  /** The most recently assigned sequence number. */
  get currentSeq(): number {
    return this.nextSeq - 1;
  }

  /** Number of events currently buffered. */
  get size(): number {
    return this.buffer.length;
  }

  /** Clear all buffered events (e.g., on session close). */
  clear(): void {
    this.buffer = [];
  }
}
