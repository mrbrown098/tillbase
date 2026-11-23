import { toMinor } from "@tillbase/core/money";
import { addDays, dayEndISO, dayStartISO, localDate, startOfMonth } from "@tillbase/core/dates";

/** Parse what a person typed ("12", "12.5", "1,200.00") into minor units, or null if invalid. */
export function parseMoney(text: string): number | null {
  const t = text.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return toMinor(Number(t));
}

/** Parse a positive or negative quantity such as "3" or "0.5". */
export function parseQty(text: string): number | null {
  const t = text.trim();
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

/** Minor units to a plain editable decimal string, e.g. 1250 -> "12.50". */
export function minorToInput(minor: number): string {
  return (minor / 100).toFixed(2);
}

/** Tax rate basis points to percent text, e.g. 1800 -> "18". */
export function bpToPercent(bp: number): string {
  return String(bp / 100);
}

export function percentToBp(text: string): number | null {
  const t = text.trim();
  if (t === "") return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** The start of today's business day and of the next one, as ISO instants (see core dates.ts). */
export function todayRange(): { from: string; to: string } {
  const today = localDate();
  return { from: dayStartISO(today), to: dayEndISO(today) };
}

/** A business day as YYYY-MM-DD, in the shop's time zone and with its day cut-off. */
export function isoDay(d: Date = new Date()): string {
  return localDate(d);
}

export function shiftDay(day: string, delta: number): string {
  return addDays(day, delta);
}

export const periods = {
  today: () => ({ from: isoDay(), to: isoDay() }),
  yesterday: () => ({ from: shiftDay(isoDay(), -1), to: shiftDay(isoDay(), -1) }),
  week: () => ({ from: shiftDay(isoDay(), -6), to: isoDay() }),
  month: () => ({ from: startOfMonth(isoDay()), to: isoDay() }),
  lastMonth: () => {
    const lastDayPrev = shiftDay(startOfMonth(isoDay()), -1);
    return { from: startOfMonth(lastDayPrev), to: lastDayPrev };
  },
} as const;

export const periodLabels: Record<keyof typeof periods, string> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "Last 7 days",
  month: "This month",
  lastMonth: "Last month",
};
