import { describe, expect, it } from "bun:test";
import { CronParser } from "./cronParser";

const parser = new CronParser();

describe("CronParser", () => {
  describe("parseField — lists with ranges", () => {
    it("parses comma-separated ranges like 19-23,0-4", () => {
      // This is the exact expression that was broken — the overnight window
      const nextRun = parser.getNextRun(
        "*/5 19-23,0-4 * * *",
        new Date(2026, 2, 27, 1, 0), // 1:00 AM — should find 1:05 AM, not skip to 7pm
      );
      expect(nextRun).not.toBeNull();
      const date = new Date(nextRun!);
      expect(date.getHours()).toBe(1);
      expect(date.getMinutes()).toBe(5);
    });

    it("transitions from hour 23 to hour 0 across midnight", () => {
      const nextRun = parser.getNextRun(
        "*/5 19-23,0-4 * * *",
        new Date(2026, 2, 26, 23, 55), // 11:55 PM
      );
      expect(nextRun).not.toBeNull();
      const date = new Date(nextRun!);
      // Next valid: 12:00 AM (hour 0, minute 0)
      expect(date.getHours()).toBe(0);
      expect(date.getMinutes()).toBe(0);
    });

    it("stops after hour 4 (skips to 19 next day)", () => {
      const nextRun = parser.getNextRun(
        "*/5 19-23,0-4 * * *",
        new Date(2026, 2, 27, 4, 55), // 4:55 AM — last slot
      );
      expect(nextRun).not.toBeNull();
      const date = new Date(nextRun!);
      // Next valid: 7:00 PM that same day
      expect(date.getHours()).toBe(19);
      expect(date.getMinutes()).toBe(0);
      expect(date.getDate()).toBe(27);
    });

    it("handles simple comma-separated values like 1,3,5", () => {
      const nextRun = parser.getNextRun("0 1,3,5 * * *", new Date(2026, 2, 27, 2, 0));
      expect(nextRun).not.toBeNull();
      const date = new Date(nextRun!);
      expect(date.getHours()).toBe(3);
    });

    it("handles mixed range and single value like 1-3,7,10-12", () => {
      const nextRun = parser.getNextRun("0 1-3,7,10-12 * * *", new Date(2026, 2, 27, 4, 0));
      expect(nextRun).not.toBeNull();
      const date = new Date(nextRun!);
      expect(date.getHours()).toBe(7);
    });
  });

  describe("parseField — basic patterns", () => {
    it("wildcard * generates full range", () => {
      const nextRun = parser.getNextRun("* * * * *", new Date(2026, 2, 27, 12, 30));
      expect(nextRun).not.toBeNull();
      const date = new Date(nextRun!);
      expect(date.getMinutes()).toBe(31); // next minute
    });

    it("step */5 generates every 5th value", () => {
      const nextRun = parser.getNextRun("*/5 * * * *", new Date(2026, 2, 27, 12, 3));
      expect(nextRun).not.toBeNull();
      const date = new Date(nextRun!);
      expect(date.getMinutes()).toBe(5);
    });

    it("simple range 9-17", () => {
      const nextRun = parser.getNextRun("0 9-17 * * *", new Date(2026, 2, 27, 18, 0));
      expect(nextRun).not.toBeNull();
      const date = new Date(nextRun!);
      // Should wrap to next day 9am
      expect(date.getHours()).toBe(9);
      expect(date.getDate()).toBe(28);
    });
  });

  describe("parseField — step with range", () => {
    it("handles range/step like 0-23/2 (even hours)", () => {
      const nextRun = parser.getNextRun("0 0-23/2 * * *", new Date(2026, 2, 27, 3, 0));
      expect(nextRun).not.toBeNull();
      const date = new Date(nextRun!);
      expect(date.getHours()).toBe(4); // next even hour
    });
  });

  describe("describe()", () => {
    it("describes common patterns", () => {
      expect(parser.describe("0 0 * * *")).toBe("Daily at midnight");
      expect(parser.describe("*/15 * * * *")).toBe("Every 15 minutes");
    });
  });

  describe("isValid()", () => {
    it("validates correct expressions", () => {
      expect(parser.isValid("*/5 19-23,0-4 * * *")).toBe(true);
      expect(parser.isValid("0 9 * * 1-5")).toBe(true);
    });

    it("rejects invalid expressions", () => {
      expect(parser.isValid("not a cron")).toBe(false);
      expect(parser.isValid("* * *")).toBe(false);
    });
  });

  describe("overnight cron — full integration", () => {
    it("generates all expected hours for 19-23,0-4 overnight window", () => {
      // Simulate a full overnight cycle by collecting unique hours
      const hours = new Set<number>();
      let current = new Date(2026, 2, 26, 18, 59); // 6:59 PM
      const endTime = new Date(2026, 2, 27, 5, 1); // 5:01 AM next day

      while (current < endTime) {
        const next = parser.getNextRun("*/5 19-23,0-4 * * *", current);
        if (!next) break;
        const date = new Date(next);
        if (date >= endTime) break;
        hours.add(date.getHours());
        current = date;
      }

      // Should see ALL overnight hours: 19, 20, 21, 22, 23, 0, 1, 2, 3, 4
      expect(hours).toEqual(new Set([19, 20, 21, 22, 23, 0, 1, 2, 3, 4]));
    });
  });
});
