import { describe, expect, it } from "bun:test";
import {
  buildElapsedTimeReminder,
  buildSessionStartReminder,
  withTimeReminder,
} from "./time-context";

describe("session time context", () => {
  it("builds local system reminders with weekday context", () => {
    const reminder = buildSessionStartReminder(new Date("2026-05-04T13:30:00.000Z"));

    expect(reminder).toContain("<system-reminder>");
    expect(reminder).toContain("Monday");
    expect(reminder).toContain("Current local date and time:");
  });

  it("ignores missing or invalid previous assistant timestamps", () => {
    expect(
      buildElapsedTimeReminder({ metadata: {}, now: new Date("2026-05-04T13:30:00.000Z") }),
    ).toBeNull();
    expect(
      buildElapsedTimeReminder({
        metadata: { lastAssistantMessageAt: "not-a-date" },
        now: new Date("2026-05-04T13:30:00.000Z"),
      }),
    ).toBeNull();
  });

  it("only emits elapsed reminders after the idle threshold", () => {
    const recent = buildElapsedTimeReminder({
      metadata: { lastAssistantMessageAt: "2026-05-04T12:00:00.000Z" },
      now: new Date("2026-05-04T13:30:00.000Z"),
    });
    expect(recent).toBeNull();

    const stale = buildElapsedTimeReminder({
      metadata: {
        lastAssistantMessageAt: "2026-05-04T08:00:00.000Z",
      },
      now: new Date("2026-05-04T13:30:00.000Z"),
    });
    expect(stale).toContain("Time since last assistant message: 5h 30m.");
    expect(stale).toContain("Last assistant message time:");
    expect(stale).not.toContain("Last assistant message preview:");
  });

  it("prepends reminders to text and rich prompt content", () => {
    expect(withTimeReminder("hello", "<system-reminder>time</system-reminder>")).toBe(
      "<system-reminder>time</system-reminder>\n\nhello",
    );
    expect(withTimeReminder([{ type: "text", text: "hello" }], "time")).toEqual([
      { type: "text", text: "time" },
      { type: "text", text: "hello" },
    ]);
  });
});
