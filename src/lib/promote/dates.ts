/**
 * Run dates in the spending ad account's time zone (docs/IG-PAGE-ADS-SPEC.md 3.1a, D6, D30 to D32, 4.3). Pure.
 *
 * - A draft keeps a run length (runDays) and a start mode, not a stale date. With startMode 'now' the run starts now and
 *   ends on the start day plus runDays minus 1, at 23:59 in the account zone, whenever the draft is started.
 * - Offsets come from the IANA zone at that instant through Intl, never a fixed +0530, so a run across a daylight-saving
 *   change ends at 23:59 local with that day's offset.
 * - validateRun refuses, before any Meta call: runs of 24 hours or less (D31), a past 'at' start, an 'at' start more than
 *   14 days ahead (D32, until Phase 0 accepts P0-10), and runs longer than 90 days (D6).
 * - A later start is counted from today (D32): setAsideFromToday tells the card to say so.
 */
import { addDays, compareDays, dayKey, localParts, resolveTimeZone } from "@/lib/spend/periods";
import { formatDay, promoteText, type PromoteCopyKey } from "./copy";
import type { PromoteLang, StartMode } from "./types";

export const DEFAULT_RUN_DAYS = 7;
/** D31: Meta needs more than 24 hours for a daily budget, so the Days stepper starts at 2. */
export const MIN_RUN_DAYS = 2;
/** Simple offers up to 30 days; More up to 90 (D6). */
export const SIMPLE_MAX_RUN_DAYS = 30;
export const MAX_RUN_DAYS = 90;
/** D32: "Start on a date" offers at most 14 days ahead until P0-10. */
export const MAX_START_AHEAD_DAYS = 14;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The zone's offset from UTC at that instant, in minutes (+330 for Asia/Kolkata, -240 or -300 for New York). */
export function zoneOffsetMinutes(at: Date, tz: string): number {
  const p = localParts(at, resolveTimeZone(tz));
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const whole = Math.floor(at.getTime() / 1000) * 1000;
  return Math.round((asUtc - whole) / MINUTE);
}

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, "0");

/**
 * An instant as the zone's wall clock with that instant's offset: "2026-11-01T23:59:00-0500". Meta reads start_time and
 * end_time in this form (4.3); the builder never reuses one offset for both ends.
 */
export function toZonedIso(at: Date, tz: string): string {
  const zone = resolveTimeZone(tz);
  const p = localParts(at, zone);
  const off = zoneOffsetMinutes(at, zone);
  const sign = off < 0 ? "-" : "+";
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(Math.abs(off) / 60))}${pad(Math.abs(off) % 60)}`;
}

/**
 * The instant at a wall-clock time on a local day in the zone. The offset is looked up at the guess and once more at the
 * answer, so a day with a daylight-saving change still lands on the asked wall time. A time that does not exist (inside a
 * spring-forward gap) moves forward by the gap.
 */
export function localTimeToInstant(day: string, hour: number, minute: number, tz: string): Date {
  const zone = resolveTimeZone(tz);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new RangeError(`Not a day key: ${day}`);
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, minute, 0);
  const first = wall - zoneOffsetMinutes(new Date(wall), zone) * MINUTE;
  const second = wall - zoneOffsetMinutes(new Date(first), zone) * MINUTE;
  const matches = (t: number) => {
    const p = localParts(new Date(t), zone);
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` === `${Number(m[1])}-${Number(m[2])}-${Number(m[3])} ${hour}:${minute}`;
  };
  if (matches(second)) return new Date(second);
  if (matches(first)) return new Date(first);
  // The wall time falls in a spring-forward gap: the later candidate is the same wall time moved forward by the gap.
  return new Date(Math.max(first, second));
}

/** 23:59 on a local day in the zone: the end of a run (3.1a). */
export function endOfRunDay(day: string, tz: string): Date {
  return localTimeToInstant(day, 23, 59, tz);
}

export type RunDatesInput = {
  runDays: number;
  startMode: StartMode;
  /** The chosen start for startMode 'at'; ignored for 'now'. */
  startsAt?: Date | null;
  /** The ad account's IANA zone (MetaAsset.meta.timezone). */
  tz: string;
  now: Date;
};

export type RunDates = {
  startsAt: Date;
  endsAt: Date;
  /** Local day keys in the account zone. */
  startDay: string;
  endDay: string;
  runDays: number;
  /** The ads start on a later day, but Phase 0 sets money aside from today (D32). */
  setAsideFromToday: boolean;
  /** Both ends as Meta wants them, each with its own offset. */
  startIso: string;
  endIso: string;
};

/**
 * Start and end of a run (3.1a): the start is now (or the chosen time), and the end is the start day plus runDays minus 1,
 * at 23:59 in the account zone. A draft saved on Monday and started on Thursday therefore still runs its full length.
 */
export function runDates(i: RunDatesInput): RunDates {
  const tz = resolveTimeZone(i.tz);
  if (!Number.isInteger(i.runDays) || i.runDays < 1) throw new RangeError("A run needs a whole number of days.");
  const start = i.startMode === "now" ? i.now : i.startsAt;
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) throw new RangeError("A run that starts on a date needs a start time.");
  const startDay = dayKey(start, tz);
  const endDay = addDays(startDay, i.runDays - 1);
  const endsAt = endOfRunDay(endDay, tz);
  const today = dayKey(i.now, tz);
  return {
    startsAt: start,
    endsAt,
    startDay,
    endDay,
    runDays: i.runDays,
    setAsideFromToday: compareDays(startDay, today) > 0,
    startIso: toZonedIso(start, tz),
    endIso: toZonedIso(endsAt, tz),
  };
}

/** The account days a run covers, start and end day included. */
export function runDayCount(startsAt: Date, endsAt: Date, tz: string): number {
  const zone = resolveTimeZone(tz);
  const end = dayKey(endsAt, zone);
  let n = 0;
  for (let d = dayKey(startsAt, zone); compareDays(d, end) <= 0 && n <= MAX_RUN_DAYS + 400; d = addDays(d, 1)) n++;
  return n;
}

/** True when a later start sets money aside from today (D32): the start falls on a later account day than today. */
export function setAsideFromToday(startsAt: Date, now: Date, tz: string): boolean {
  const zone = resolveTimeZone(tz);
  return compareDays(dayKey(startsAt, zone), dayKey(now, zone)) > 0;
}

export type RunIssueCode = "run.too_short" | "run.start_passed" | "run.start_too_far" | "run.too_long";
export type RunIssue = { code: RunIssueCode; key: PromoteCopyKey; text: string };

export type ValidateRunInput = {
  startMode: StartMode;
  startsAt: Date;
  endsAt: Date;
  now: Date;
  tz: string;
  /** The stored run length, when there is one; checked against 2 and 90 as well as the dates. */
  runDays?: number | null;
};

/**
 * What stops a run before any Meta call, each with its copy (3.1a, D6, D31, D32). Empty when the run is fine.
 * - A daily-budget run must last more than 24 hours from when it really starts (now, for 'now').
 * - An 'at' start must not have passed, and may be at most 14 days ahead.
 * - A run may cover at most 90 account days.
 */
export function validateRun(i: ValidateRunInput, lang: PromoteLang = "en"): RunIssue[] {
  const out: RunIssue[] = [];
  const add = (code: RunIssueCode) => out.push({ code, key: code, text: promoteText(code, {}, lang) });
  const start = i.startMode === "now" ? i.now : i.startsAt;
  if (i.startMode === "at") {
    if (i.startsAt.getTime() < i.now.getTime()) add("run.start_passed");
    else if (i.startsAt.getTime() > i.now.getTime() + MAX_START_AHEAD_DAYS * DAY) add("run.start_too_far");
  }
  const tooShortDays = typeof i.runDays === "number" && i.runDays < MIN_RUN_DAYS;
  if (tooShortDays || i.endsAt.getTime() - Math.max(start.getTime(), i.now.getTime()) <= DAY) add("run.too_short");
  const tooLongDays = typeof i.runDays === "number" && i.runDays > MAX_RUN_DAYS;
  if (tooLongDays || runDayCount(start, i.endsAt, i.tz) > MAX_RUN_DAYS) add("run.too_long");
  return out;
}

/** The days stepper's bounds by tier (D6, D31): 2 to 30 in Simple, 2 to 90 with More options. */
export function runDaysBounds(more: boolean): { min: number; max: number } {
  return { min: MIN_RUN_DAYS, max: more ? MAX_RUN_DAYS : SIMPLE_MAX_RUN_DAYS };
}

/** "Today → Sun 1 Nov" or "Thu 5 Nov → Sun 15 Nov" in the account zone (3.3 facts). */
export function whenLine(dates: Pick<RunDates, "startsAt" | "endsAt">, now: Date, tz: string, lang: PromoteLang = "en"): string {
  const zone = resolveTimeZone(tz);
  const fmt = (at: Date) => formatDay(at, zone, lang, { weekday: true });
  const end = fmt(dates.endsAt);
  if (dayKey(dates.startsAt, zone) === dayKey(now, zone)) return promoteText("when.today_to", { end }, lang);
  return promoteText("when.range", { start: fmt(dates.startsAt), end }, lang);
}

/** "Times are in America/New_York, your ad account's time zone." when the account zone differs from the workspace's (D30). */
export function zoneNote(accountTz: string, workspaceTz: string, lang: PromoteLang = "en"): string | null {
  const a = resolveTimeZone(accountTz);
  return a === resolveTimeZone(workspaceTz) ? null : promoteText("when.zone_note", { zone: a }, lang);
}
