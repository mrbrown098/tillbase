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
