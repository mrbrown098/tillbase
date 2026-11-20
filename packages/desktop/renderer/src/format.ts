import { toMinor } from "@tillbase/core/money";

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

/** Start of today and start of tomorrow in the shop's local time, as ISO strings. */
export function todayRange(): { from: string; to: string } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

/** A local calendar day as YYYY-MM-DD. */
export function isoDay(d: Date = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return isoDay(new Date(y, m - 1, d + delta));
}

export const periods = {
  today: () => ({ from: isoDay(), to: isoDay() }),
  yesterday: () => ({ from: shiftDay(isoDay(), -1), to: shiftDay(isoDay(), -1) }),
  week: () => ({ from: shiftDay(isoDay(), -6), to: isoDay() }),
  month: () => {
    const n = new Date();
    return { from: isoDay(new Date(n.getFullYear(), n.getMonth(), 1)), to: isoDay() };
  },
  lastMonth: () => {
    const n = new Date();
    return {
      from: isoDay(new Date(n.getFullYear(), n.getMonth() - 1, 1)),
      to: isoDay(new Date(n.getFullYear(), n.getMonth(), 0)),
    };
  },
} as const;

export const periodLabels: Record<keyof typeof periods, string> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "Last 7 days",
  month: "This month",
  lastMonth: "Last month",
};
