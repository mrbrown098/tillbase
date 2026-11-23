/**
 * Dates in Tillbase's reports are "business days in the shop's time zone",
 * written YYYY-MM-DD. Timestamps are stored in UTC and never rewritten; these
 * helpers convert between a stored instant and the business day it belongs to.
 *
 * A business day runs from `cutoffHour` on the calendar date up to, but not
 * including, `cutoffHour` on the next date, in the business time zone. With no
 * time zone set it uses the machine's, and with cutoff 0 it is the ordinary
 * midnight-to-midnight day. Start bounds are inclusive and end bounds are
 * exclusive everywhere (`at >= dayStartISO(from) AND at < dayEndISO(to)`).
 * Daylight-saving days are simply 23 or 25 hours long.
 */

export interface BusinessCalendar {
  /** An IANA zone such as "Asia/Karachi". Empty means this machine's zone. */
  timeZone: string;
  /** Hour (0-8) at which a business day begins. */
  cutoffHour: number;
}

let calendar: BusinessCalendar = { timeZone: "", cutoffHour: 0 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function zoneKnown(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Set the calendar every date helper uses. Unknown zones and bad cutoffs fall back to the safe defaults. */
export function setBusinessCalendar(next: Partial<BusinessCalendar>): void {
  const tz = typeof next.timeZone === "string" && next.timeZone !== "" && zoneKnown(next.timeZone) ? next.timeZone : "";
  const h = next.cutoffHour;
  calendar = { timeZone: tz, cutoffHour: Number.isInteger(h) && (h as number) >= 0 && (h as number) <= 8 ? (h as number) : 0 };
}

export function getBusinessCalendar(): BusinessCalendar {
  return { ...calendar };
}

interface Wall { y: number; m: number; d: number; h: number; min: number }

/** The wall-clock reading of an instant in a zone ("" = this machine's). */
function wallOf(ms: number, tz: string): Wall {
  if (tz === "") {
    const d = new Date(ms);
    return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), min: d.getMinutes() };
  }
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
    });
    formatters.set(tz, f);
  }
  const v: Record<string, number> = {};
  for (const p of f.formatToParts(ms)) if (p.type !== "literal") v[p.type] = Number(p.value);
  return { y: v.year as number, m: v.month as number, d: v.day as number, h: (v.hour as number) % 24, min: v.minute as number };
}

/** The first instant at which the wall clock in `tz` reads `y-m-d h:00` (the earlier one when the hour repeats, the end of the gap when it does not exist). */
function instantOf(y: number, m: number, d: number, h: number, tz: string): number {
  if (tz === "") return new Date(y, m - 1, d, h, 0, 0, 0).getTime();
  const guess = Date.UTC(y, m - 1, d, h);
  const offsetAt = (ms: number) => {
    const w = wallOf(ms, tz);
    return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min) - Math.floor(ms / 60_000) * 60_000;
  };
  // Offsets are whole hours or half hours; try the offsets on either side of the guess.
  const candidates = new Set<number>();
  for (const probe of [guess - 36 * 3_600_000, guess, guess + 36 * 3_600_000]) {
    candidates.add(guess - offsetAt(probe));
  }
  const matching = [...candidates].filter((t) => {
    const w = wallOf(t, tz);
    return w.y === y && w.m === m && w.d === d && w.h === h;
  });
  if (matching.length > 0) return Math.min(...matching);
  return Math.max(...candidates);
}

const pad = (n: number) => String(n).padStart(2, "0");

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return [y, m, d];
}

/** A calendar date as YYYY-MM-DD from UTC arithmetic, which has no daylight-saving surprises. */
function fromUtc(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function isDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = parts(s);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function assertDate(label: string, s: string): void {
  if (!isDate(s)) throw new Error(`${label} must be a date like 2026-11-19`);
}

/** The business day a moment belongs to: the date on the shop's clock, minus a day when the clock is before the cutoff hour. */
export function localDate(when: Date | string | number = new Date()): string {
  const w = wallOf(new Date(when).getTime(), calendar.timeZone);
  const day = Date.UTC(w.y, w.m - 1, w.d);
  return fromUtc(w.h < calendar.cutoffHour ? day - 86_400_000 : day);
}

/** The shop's clock reading for a moment, ignoring the cutoff: what a customer sees on the wall. */
export function wallClock(when: Date | string | number): { date: string; hour: number; minute: number; stamp: string } {
  const w = wallOf(new Date(when).getTime(), calendar.timeZone);
  const date = `${w.y}-${pad(w.m)}-${pad(w.d)}`;
  return { date, hour: w.h, minute: w.min, stamp: `${date} ${pad(w.h)}:${pad(w.min)}` };
}

/** UTC instant when the business day begins (inclusive lower bound). */
export function dayStartISO(date: string): string {
  const [y, m, d] = parts(date);
  return new Date(instantOf(y, m, d, calendar.cutoffHour, calendar.timeZone)).toISOString();
}

/** UTC instant when the business day after `date` begins. Use as an exclusive upper bound. */
export function dayEndISO(date: string): string {
  const [y, m, d] = parts(addDays(date, 1));
  return new Date(instantOf(y, m, d, calendar.cutoffHour, calendar.timeZone)).toISOString();
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = parts(date);
  return fromUtc(Date.UTC(y, m - 1, d + n));
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
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
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
