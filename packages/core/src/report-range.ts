import { addDays, assertDate, localDate, startOfMonth } from "./dates.js";

export type RangePreset = "today" | "yesterday" | "this_week" | "this_month";

/**
 * The whole-day range for a preset. A week starts on Monday. `today` is a business day (see dates.ts):
 * with a cut-off of 4, a sale at 1 a.m. belongs to the day before.
 */
export function presetRange(preset: RangePreset, today: string = localDate()): { from: string; to: string } {
  assertDate("Today", today);
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case "this_week": {
      const [yy, mm, dd] = today.split("-").map(Number) as [number, number, number];
      const dow = (new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay() + 6) % 7; // Monday = 0
      return { from: addDays(today, -dow), to: today };
    }
    case "this_month":
      return { from: startOfMonth(today), to: today };
  }
}
