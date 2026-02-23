import { describe, expect, it } from "bun:test";
import { EventBuffer } from "./event-buffer";

describe("EventBuffer", () => {
  it("assigns monotonic sequence numbers and replays after last seen", () => {
    const buffer = new EventBuffer(5);

    const seq1 = buffer.push({ type: "a" });
    const seq2 = buffer.push({ type: "b" });
    const seq3 = buffer.push({ type: "c" });

    expect([seq1, seq2, seq3]).toEqual([1, 2, 3]);
    expect(buffer.currentSeq).toBe(3);

    const replay = buffer.getAfter(1);
    expect(replay.map((e) => e.seq)).toEqual([2, 3]);
  });

  it("drops older events when capacity is exceeded (gap scenario)", () => {
    const buffer = new EventBuffer(3);

    buffer.push({ type: "e1" }); // seq 1
    buffer.push({ type: "e2" }); // seq 2
    buffer.push({ type: "e3" }); // seq 3
    buffer.push({ type: "e4" }); // seq 4 (seq 1 dropped)
    buffer.push({ type: "e5" }); // seq 5 (seq 2 dropped)

    expect(buffer.size).toBe(3);
    const replay = buffer.getAfter(0);
    expect(replay.map((e) => e.seq)).toEqual([3, 4, 5]);
  });
});
