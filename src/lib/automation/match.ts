export type Schedule = { timezone: string; days: number[]; start: string; end: string };

export const normalizeText = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** contains: whole word or phrase anywhere in the text. exact: the whole message equals a keyword. Both case-insensitive. */
export function matchesKeywords(text: string, keywords: string[], mode: string): boolean {
  const haystack = normalizeText(text);
  if (!haystack) return false;
  return keywords.some((raw) => {
    const keyword = normalizeText(raw);
    if (!keyword) return false;
    if (mode === "exact") return haystack === keyword;
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegex(keyword)}(?![\\p{L}\\p{N}_])`, "u");
    return pattern.test(haystack);
  });
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMinutes = (hhmm: string) => {
  const m = TIME.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Returns a clean Schedule or null when the value is not a usable schedule. */
export function parseSchedule(value: unknown): Schedule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const { timezone, days, start, end } = v;
  if (typeof timezone !== "string" || !isValidTimezone(timezone)) return null;
  if (!Array.isArray(days) || days.length === 0 || days.some((d) => !Number.isInteger(d) || (d as number) < 0 || (d as number) > 6)) return null;
  if (typeof start !== "string" || typeof end !== "string" || toMinutes(start) === null || toMinutes(end) === null) return null;
  return { timezone, days: [...new Set(days as number[])].sort(), start, end };
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Local weekday (0 = Sunday) and minutes since local midnight in the given timezone. */
export function localParts(date: Date, timezone: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { day: WEEKDAYS[get("weekday")] ?? 0, minutes: (Number(get("hour")) % 24) * 60 + Number(get("minute")) };
}

/**
 * True when `date` falls inside the OPEN hours. A window belongs to the day it starts on, so with days [5] and 22:00-06:00
 * Saturday 02:00 is open. start equal to end means open all day on the listed days.
 */
export function isWithinOpenHours(schedule: Schedule, date: Date): boolean {
  const start = toMinutes(schedule.start);
  const end = toMinutes(schedule.end);
  if (start === null || end === null) return false;
  const { day, minutes } = localParts(date, schedule.timezone);
  const listed = (d: number) => schedule.days.includes(d);
  if (start === end) return listed(day);
  if (start < end) return listed(day) && minutes >= start && minutes < end;
  return (listed(day) && minutes >= start) || (listed((day + 6) % 7) && minutes < end);
}

/** Local calendar date (YYYY-MM-DD), weekday (0 = Sunday) and minutes since local midnight in the given timezone. */
export function localDateTime(date: Date, timezone: string): { date: string; day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, ...localParts(date, timezone) };
}

export const clockToMinutes = (hhmm: string): number | null => toMinutes(hhmm);
