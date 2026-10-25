import { describe, expect, it } from "bun:test";
import { type ImsgMessage, withRowId } from "./imsg-client";

describe("withRowId", () => {
  it("fills rowid from id, as imsg 0.5.x sends no rowid", () => {
    const fromImsg = { id: 215, text: "hi", is_from_me: true } as unknown as ImsgMessage;
    expect(withRowId(fromImsg).rowid).toBe(215);
  });

  it("keeps a rowid that is already there", () => {
    const m = { id: 1, rowid: 99 } as unknown as ImsgMessage;
    expect(withRowId(m).rowid).toBe(99);
  });
});
