/**
 * Cron Expression Parser for Scheduler Extension
 *
 * Supports standard 5-field cron expressions:
 * - minute (0-59)
 * - hour (0-23)
 * - day of month (1-31)
 * - month (1-12)
 * - day of week (0-6, 0=Sunday)
 *
 * Examples:
 * - "0 9 * * *" - Every day at 9 AM
 * - "star/15 * * * *" - Every 15 minutes (replace star with asterisk)
 * - "0 0 * * 1" - Every Monday at midnight
 * - "30 14 * * 1-5" - Every weekday at 2:30 PM
 */

interface CronField {
  values: number[];
  isWildcard: boolean;
  isRange: boolean;
  isStep: boolean;
}

export class CronParser {
  /**
   * Parse a cron expression and return the next run time
   */
  getNextRun(cronExpression: string, fromDate: Date = new Date()): string | null {
    try {
      const fields = this.parseCronExpression(cronExpression);
      const nextRun = this.findNextRun(fields, fromDate);
      return nextRun ? nextRun.toISOString() : null;
    } catch (error) {
      console.error("Failed to parse cron expression:", cronExpression, error);
      return null;
    }
  }

  /**
   * Parse cron expression into structured fields
   */
  private parseCronExpression(expression: string): {
    minute: CronField;
    hour: CronField;
    dayOfMonth: CronField;
    month: CronField;
    dayOfWeek: CronField;
  } {
    const parts = expression.trim().split(/\s+/);

    if (parts.length !== 5) {
      throw new Error(`Invalid cron expression: expected 5 fields, got ${parts.length}`);
    }

    return {
      minute: this.parseField(parts[0], 0, 59),
      hour: this.parseField(parts[1], 0, 23),
      dayOfMonth: this.parseField(parts[2], 1, 31),
      month: this.parseField(parts[3], 1, 12),
      dayOfWeek: this.parseField(parts[4], 0, 6),
    };
  }

  /**
   * Parse individual cron field (supports *, ranges, steps, lists)
   *
   * Evaluation order matters — lists (,) must be checked first since
   * list items can contain ranges and steps (e.g., "19-23,0-4").
   */
  private parseField(field: string, min: number, max: number): CronField {
    const result: CronField = {
      values: [],
      isWildcard: false,
      isRange: false,
      isStep: false,
    };

    if (field === "*") {
      result.isWildcard = true;
      result.values = this.range(min, max);
      return result;
    }

    // Handle lists FIRST — items can contain ranges/steps (e.g., "19-23,0-4")
    if (field.includes(",")) {
      const allValues = new Set<number>();
      for (const item of field.split(",")) {
        const parsed = this.parseField(item.trim(), min, max);
        for (const v of parsed.values) allValues.add(v);
      }
      // Spread is required to convert Set → Array; toSorted would double-allocate.
      // react-doctor-disable-next-line react-doctor/js-tosorted-immutable
      result.values = [...allValues].sort((a, b) => a - b);
      return result;
    }

    // Handle step values (*/5, 0-23/2)
    if (field.includes("/")) {
      result.isStep = true;
      const [range, step] = field.split("/");
      const stepValue = parseInt(step);

      let rangeValues: number[];
      if (range === "*") {
        rangeValues = this.range(min, max);
      } else if (range.includes("-")) {
        const [start, end] = range.split("-").map((n) => parseInt(n));
        rangeValues = this.range(start, end);
      } else {
        rangeValues = [parseInt(range)];
      }

      result.values = rangeValues.filter((_, index) => index % stepValue === 0);
      return result;
    }

    // Handle ranges (1-5, 9-17)
    if (field.includes("-")) {
      result.isRange = true;
      const [start, end] = field.split("-").map((n) => parseInt(n));
      result.values = this.range(start, end);
      return result;
    }

    // Single value
    result.values = [parseInt(field)];
    return result;
  }

  /**
   * Generate range of numbers (inclusive)
   */
  private range(start: number, end: number): number[] {
    const result: number[] = [];
    for (let i = start; i <= end; i++) {
      result.push(i);
    }
    return result;
  }

  /**
   * Find the next valid run time based on parsed cron fields
   */
  private findNextRun(fields: any, fromDate: Date): Date | null {
    // Start from the next minute to avoid running immediately
    const candidate = new Date(fromDate);
    candidate.setSeconds(0, 0);
    candidate.setMinutes(candidate.getMinutes() + 1);

    // Limit search to prevent infinite loops (max 2 years ahead)
    const maxDate = new Date(fromDate.getTime() + 2 * 365 * 24 * 60 * 60 * 1000);

    while (candidate <= maxDate) {
      if (this.isValidTime(candidate, fields)) {
        return candidate;
      }

      // Increment by 1 minute and try again
      candidate.setMinutes(candidate.getMinutes() + 1);
    }

    return null; // No valid time found
  }

  /**
   * Check if given date matches all cron field requirements
   */
  private isValidTime(date: Date, fields: any): boolean {
    const minute = date.getMinutes();
    const hour = date.getHours();
    const dayOfMonth = date.getDate();
    const month = date.getMonth() + 1; // Date.getMonth() returns 0-11
    const dayOfWeek = date.getDay(); // 0=Sunday

    return (
      fields.minute.values.includes(minute) &&
      fields.hour.values.includes(hour) &&
      fields.dayOfMonth.values.includes(dayOfMonth) &&
      fields.month.values.includes(month) &&
      fields.dayOfWeek.values.includes(dayOfWeek)
    );
  }

  /**
   * Get human-readable description of cron expression
   */
  describe(cronExpression: string): string {
    try {
      const fields = this.parseCronExpression(cronExpression);

      // Common patterns
      if (cronExpression === "0 0 * * *") return "Daily at midnight";
      if (cronExpression === "0 9 * * *") return "Daily at 9:00 AM";
      if (cronExpression === "*/15 * * * *") return "Every 15 minutes";
      if (cronExpression === "0 */6 * * *") return "Every 6 hours";
      if (cronExpression === "0 0 * * 1") return "Every Monday at midnight";
      if (cronExpression === "30 14 * * 1-5") return "Weekdays at 2:30 PM";

      // Generic description
      let desc = "At ";

      if (fields.minute.isWildcard) {
        desc += "every minute ";
      } else if (fields.minute.values.length === 1) {
        desc += `minute ${fields.minute.values[0]} `;
      } else {
        desc += `minutes ${fields.minute.values.join(", ")} `;
      }

      if (!fields.hour.isWildcard) {
        if (fields.hour.values.length === 1) {
          desc += `of hour ${fields.hour.values[0]} `;
        } else {
          desc += `of hours ${fields.hour.values.join(", ")} `;
        }
      }

      return desc.trim();
    } catch (error) {
      return `Invalid cron expression: ${cronExpression}`;
    }
  }

  /**
   * Validate cron expression
   */
  isValid(cronExpression: string): boolean {
    try {
      this.parseCronExpression(cronExpression);
      return true;
    } catch {
      return false;
    }
  }
}

export const cronParser = new CronParser();
