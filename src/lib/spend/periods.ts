/**
 * Day, week and month keys for the spend controls (docs/SPEND-CONTROLS-SPEC.md 3.1). Pure: no database, no network.
 *
 * - Ads days, weeks (Sunday to Saturday) and months use the spending ad account's time zone, because Meta paces in it.
 * - Messaging and AI day and month keys use SpendControl.timezone (default Asia/Kolkata).
 * Keys are calendar strings: day "YYYY-MM-DD", month "YYYY-MM", week = the day key of its Sunday. Calendar arithmetic on keys
 * is done in UTC, so it never depends on the server's own zone. Instants (next midnight, start of month) are DST-safe: they
 * are searched for, not computed with a fixed offset, so a 23- or 25-hour day and a zone whose midnight is skipped both work.
 */

export const DEFAULT_TIMEZONE = "Asia/Kolkata";

const MINUTE = 60_000;
const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_KEY = /^(\d{4})-(\d{2})$/;

export type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number };

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** True when the runtime knows the IANA zone name. */
export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string" || timeZone.length === 0 || timeZone.length > 64) return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The zone itself when valid, otherwise Asia/Kolkata (the I11 safe default for a missing or broken value). */
export function resolveTimeZone(timeZone: string | null | undefined): string {
  return isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIMEZONE;
}

/** Wall-clock parts of an instant in a zone. Throws RangeError for an unknown zone. */
export function localParts(at: Date, timeZone: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatterFor(timeZone).formatToParts(at)) parts[p.type] = p.value;
  const hour = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday] ?? 0,
  };
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

function keyOf(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

function parseDayKey(key: string): { year: number; month: number; day: number } {
  const m = DAY_KEY.exec(key);
  if (!m) throw new RangeError(`Not a day key: ${key}`);
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) throw new RangeError(`Not a day key: ${key}`);
  return { year, month, day };
}

function parseMonthKey(key: string): { year: number; month: number } {
  const m = MONTH_KEY.exec(key);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new RangeError(`Not a month key: ${key}`);
  return { year: Number(m[1]), month: Number(m[2]) };
}

/** The local calendar day "YYYY-MM-DD" of an instant in a zone. */
export function dayKey(at: Date, timeZone: string): string {
  const p = localParts(at, timeZone);
  return keyOf(p.year, p.month, p.day);
}

/** The local calendar month "YYYY-MM" of an instant in a zone. */
export function monthKey(at: Date, timeZone: string): string {
  return dayKey(at, timeZone).slice(0, 7);
}

export function monthKeyOfDay(day: string): string {
  parseDayKey(day);
  return day.slice(0, 7);
}

/** Pure calendar arithmetic on a day key. */
export function addDays(day: string, days: number): string {
  const { year, month, day: d } = parseDayKey(day);
  const next = new Date(Date.UTC(year, month - 1, d + days));
  return keyOf(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

/** 0 = Sunday ... 6 = Saturday. */
export function weekdayOfDay(day: string): number {
  const { year, month, day: d } = parseDayKey(day);
  return new Date(Date.UTC(year, month - 1, d)).getUTCDay();
}

/** The Sunday that starts the Sunday-to-Saturday week holding this day (Meta's 7x weekly rule, 4.5). */
export function weekStartOfDay(day: string): string {
  return addDays(day, -weekdayOfDay(day));
}

/** The Sunday of the local week holding the instant. */
export function weekStartKey(at: Date, timeZone: string): string {
  return weekStartOfDay(dayKey(at, timeZone));
}

export function daysInMonth(month: string): number {
  const { year, month: m } = parseMonthKey(month);
  return new Date(Date.UTC(year, m, 0)).getUTCDate();
}

export function monthStartDay(month: string): string {
  parseMonthKey(month);
  return `${month}-01`;
}

export function monthEndDay(month: string): string {
  return `${month}-${pad(daysInMonth(month))}`;
}

export function nextMonthKey(month: string): string {
  const { year, month: m } = parseMonthKey(month);
  return m === 12 ? `${pad(year + 1, 4)}-01` : `${pad(year, 4)}-${pad(m + 1)}`;
}

/** Negative, zero or positive, like a sort comparator. Day keys sort as strings. */
export function compareDays(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Every day key from `from` to `to`, both inclusive. Empty when `to` is before `from`. At most 400 days, as a guard. */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; compareDays(d, to) <= 0 && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

/** A day key as the Date Prisma writes to a `@db.Date` column (UTC midnight of that calendar day). */
export function dayKeyToDate(day: string): Date {
  const { year, month, day: d } = parseDayKey(day);
  return new Date(Date.UTC(year, month - 1, d));
}

/** The day key of a Date read back from a `@db.Date` column. */
export function dateToDayKey(date: Date): string {
  return keyOf(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/**
 * The first instant of a local calendar day: its midnight, or, in a zone whose clocks jump over midnight, the first minute
 * that exists on that day. Found by binary search on whole minutes, so it is right across any DST change.
 */
export function startOfLocalDay(day: string, timeZone: string): Date {
  const { year, month, day: d } = parseDayKey(day);
  const naive = Date.UTC(year, month - 1, d);
  // No zone is more than 14 hours from UTC; search a window that always contains the answer.
  let lo = Math.floor((naive - 15 * 60 * MINUTE) / MINUTE);
  let hi = Math.ceil((naive + 15 * 60 * MINUTE) / MINUTE);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (compareDays(dayKey(new Date(mid * MINUTE), timeZone), day) >= 0) hi = mid;
    else lo = mid + 1;
  }
  return new Date(lo * MINUTE);
}

/** The next local midnight after the instant (the start of the next local day). */
export function nextLocalMidnight(at: Date, timeZone: string): Date {
  return startOfLocalDay(addDays(dayKey(at, timeZone), 1), timeZone);
}

/** The first instant of the local month holding the instant. */
export function startOfLocalMonth(at: Date, timeZone: string): Date {
  return startOfLocalDay(monthStartDay(monthKey(at, timeZone)), timeZone);
}

/** The first instant of the next local month (when monthly limits reset, "resets on 1 Nov"). */
export function nextLocalMonthStart(at: Date, timeZone: string): Date {
  return startOfLocalDay(monthStartDay(nextMonthKey(monthKey(at, timeZone))), timeZone);
}

export type PeriodKeys = { day: string; month: string; weekStart: string };

/** Day, month and week keys of an instant in one zone. */
export function periodKeys(at: Date, timeZone: string): PeriodKeys {
  const day = dayKey(at, timeZone);
  return { day, month: day.slice(0, 7), weekStart: weekStartOfDay(day) };
}
