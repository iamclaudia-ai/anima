import { describe, expect, test } from "bun:test";
import { salvageTruncatedUserText } from "./claude-projects";

describe("salvageTruncatedUserText", () => {
  // Real case: a transcript whose first user line is 372KB (large paste), so a
  // capped read cuts it mid-JSON and the session was left untitled — even
  // though the prompt sits in the first few hundred bytes.
  const truncatedUserLine =
    '{"type":"user","message":{"role":"user","content":[{"type":"text",' +
    '"text":"[Image #1]BEE-23513 can you take a look at this?","cache":{"blob":"AAAA';

  test("recovers the prompt from a line cut mid-JSON", () => {
    expect(salvageTruncatedUserText(truncatedUserLine)).toBe(
      "[Image #1]BEE-23513 can you take a look at this?",
    );
  });

  test("decodes JSON escapes in the salvaged text", () => {
    const line =
      '{"type":"user","message":{"content":[{"type":"text",' +
      '"text":"line one\\nline \\"two\\" \\u00e9","more';
    expect(salvageTruncatedUserText(line)).toBe('line one\nline "two" é');
  });

  test("stops at the end of the text value, not at later text fields", () => {
    const line =
      '{"type":"user","message":{"content":[{"type":"text","text":"the prompt"}]},' +
      '"extra":{"text":"not the prompt"}}';
    expect(salvageTruncatedUserText(line)).toBe("the prompt");
  });

  test("tolerates a cut inside an escape sequence", () => {
    expect(salvageTruncatedUserText('{"type":"user","content":[{"text":"hi there\\u00')).toBe(
      "hi there",
    );
    expect(salvageTruncatedUserText('{"type":"user","content":[{"text":"hi there\\')).toBe(
      "hi there",
    );
  });

  test("ignores non-user lines", () => {
    // A truncated assistant or tool line must never be mistaken for a prompt.
    expect(
      salvageTruncatedUserText('{"type":"assistant","message":{"content":[{"text":"my reply'),
    ).toBeNull();
    expect(
      salvageTruncatedUserText('{"type":"file-history-snapshot","text":"some file content'),
    ).toBeNull();
  });

  test("returns null when there is no text field to salvage", () => {
    expect(salvageTruncatedUserText('{"type":"user","message":{"content":[{"type":"im')).toBeNull();
    expect(salvageTruncatedUserText("")).toBeNull();
  });
});
