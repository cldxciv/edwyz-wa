import { HttpError } from "@/lib/tenancy";
import { LEGACY_ZONES } from "@/lib/timezones";

export const MAX_RANGE_DAYS = 366;
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The current IANA name for any zone the browser can report, or null when it is not a time zone at all.
 * Intl fixes case and resolves many links, but it also hands back old ICU names (Asia/Calcutta, Europe/Kiev), so the table runs last.
 */
export function canonicalTimeZone(tz: string | null | undefined): string | null {
  const raw = (tz ?? "").trim();
  if (!raw || raw.length > 64) return null;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: raw }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  return LEGACY_ZONES[resolved] ?? LEGACY_ZONES[raw] ?? resolved;
}

export function isValidTimeZone(tz: string): boolean {
  return canonicalTimeZone(tz) !== null;
}

function zonedParts(instantMs: number, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(instantMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), mi: get("minute"), s: get("second") };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local calendar day (YYYY-MM-DD) of an instant in the given time zone. */
export function dayKey(instant: Date, tz: string): string {
  const p = zonedParts(instant.getTime(), tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

function offsetMs(instantMs: number, tz: string): number {
  const p = zonedParts(instantMs, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(instantMs / 1000) * 1000;
}

export function addDays(ymd: string, n: number): string {
  const m = YMD.exec(ymd)!;
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** The instant a local calendar day starts in tz. Days are 23 or 25 hours long on DST changes. */
export function startOfDay(ymd: string, tz: string): Date {
  const m = YMD.exec(ymd)!;
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const first = guess - offsetMs(guess, tz);
  return new Date(guess - offsetMs(first, tz));
}

export function listDays(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return days;
}

export type ReportRange = { from: string; to: string; tz: string; days: string[]; start: Date; end: Date };

function validDate(s: string | null | undefined): string {
  const m = s ? YMD.exec(s) : null;
  if (!m) throw new HttpError(400, "Dates must look like 2026-03-31.");
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (t.getUTCMonth() !== Number(m[2]) - 1) throw new HttpError(400, "That date does not exist.");
  return s as string;
}

/** Validates from/to (inclusive local days) and tz. The zone comes back under its current IANA name. Max 366 days. */
export function parseRange(input: { from?: string | null; to?: string | null; tz?: string | null }): ReportRange {
  const tz = canonicalTimeZone(input.tz || "UTC");
  if (!tz) throw new HttpError(400, "Unknown time zone.");
  const from = validDate(input.from);
  const to = validDate(input.to);
  if (from > to) throw new HttpError(400, "The start date must not be after the end date.");
  const days = listDays(from, to);
  if (days.length > MAX_RANGE_DAYS) throw new HttpError(400, `Date ranges are limited to ${MAX_RANGE_DAYS} days.`);
  return { from, to, tz, days, start: startOfDay(from, tz), end: startOfDay(addDays(to, 1), tz) };
}
