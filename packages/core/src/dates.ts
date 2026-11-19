/**
 * Dates in Tillbase's reports are "calendar days in the shop's local time",
 * written YYYY-MM-DD. Timestamps are stored in UTC, so these helpers convert
 * between the two. They use the machine's time zone, which is the shop's.
 */

const pad = (n: number) => String(n).padStart(2, "0");

export function isDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

export function assertDate(label: string, s: string): void {
  if (!isDate(s)) throw new Error(`${label} must be a date like 2026-11-19`);
}

/** The local calendar day of a moment. */
export function localDate(when: Date | string | number = new Date()): string {
  const d = new Date(when);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return [y, m, d];
}

/** UTC instant when the local day begins. */
export function dayStartISO(date: string): string {
  const [y, m, d] = parts(date);
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
}

/** UTC instant when the local day after `date` begins. Use as an exclusive upper bound. */
export function dayEndISO(date: string): string {
  const [y, m, d] = parts(date);
  return new Date(y, m - 1, d + 1, 0, 0, 0, 0).toISOString();
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = parts(date);
  return localDate(new Date(y, m - 1, d + n, 12));
}

/** Number of days from `from` to `to`, counting both ends. */
export function daysInclusive(from: string, to: string): number {
  const [y1, m1, d1] = parts(from);
  const [y2, m2, d2] = parts(to);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  return Math.round((b - a) / 86_400_000) + 1;
}

export function daysInMonth(year: number, month1to12: number): number {
  return new Date(year, month1to12, 0).getDate();
}

export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function startOfMonth(date: string): string {
  const [y, m] = parts(date);
  return `${y}-${pad(m)}-01`;
}

export function endOfMonth(date: string): string {
  const [y, m] = parts(date);
  return `${y}-${pad(m)}-${pad(daysInMonth(y, m))}`;
}
