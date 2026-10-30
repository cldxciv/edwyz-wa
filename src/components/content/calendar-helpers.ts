import { dayKey } from "@/lib/broadcasts/calendar";
import { CHANNEL_LIMITS, type Channel } from "@/lib/content/limits";
import { MAX_DAYS_AHEAD } from "@/lib/content/schedule";
import { fromLocalInput, toLocalInput, type CalendarEntry } from "./helpers";

const DAY = 86_400_000;

export type CalendarView = "month" | "week" | "list";

export const addDays = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** Sunday of the week containing the date, at local midnight. Matches the month grid, which starts on Sunday. */
export const startOfWeek = (d: Date): Date => addDays(d, -d.getDay());

export function weekDays(anchor: Date): Date[] {
  const start = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function weekRange(anchor: Date): { from: Date; to: Date } {
  const start = startOfWeek(anchor);
  return { from: start, to: addDays(start, 7) };
}

/** Move the anchor one month or one week. Months keep the day clamped to the target month's length. */
export function shiftAnchor(anchor: Date, view: "month" | "week", delta: number): Date {
  if (view === "week") return addDays(anchor, delta * 7);
  const target = new Date(anchor.getFullYear(), anchor.getMonth() + delta, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(anchor.getDate(), last));
}

export function periodTitle(view: "month" | "week", anchor: Date, locale?: string): string {
  if (view === "month") return anchor.toLocaleString(locale, { month: "long", year: "numeric" });
  const days = weekDays(anchor);
  const first = days[0];
  const last = days[6];
  const short = (d: Date, withYear: boolean) => d.toLocaleDateString(locale, { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) });
  return `${short(first, first.getFullYear() !== last.getFullYear())} to ${short(last, true)}`;
}

export function groupByDay<T extends { at: string }>(items: readonly T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of [...items].sort((a, b) => a.at.localeCompare(b.at))) {
    const key = dayKey(new Date(item.at));
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  return map;
}

/** Counts per tone-free status group for the compact phone month view. */
export function dayCount(items: readonly CalendarEntry[] | undefined): number {
  return items?.length ?? 0;
}

export type QuickSlot = { id: string; label: string; value: string };

const atHour = (d: Date, hour: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0, 0);

const SLOT_FORMAT: Intl.DateTimeFormatOptions = { weekday: "short", hour: "numeric", minute: "2-digit" };

/** Ready-made times so scheduling never needs a date picker: later today, tomorrow morning and evening, next Monday. */
export function quickSlots(now: Date = new Date(), locale?: string): QuickSlot[] {
  const slots: { id: string; at: Date }[] = [];
  const evening = atHour(now, 18);
  if (evening.getTime() - now.getTime() > 30 * 60_000) slots.push({ id: "today-evening", at: evening });
  const tomorrow = addDays(now, 1);
  slots.push({ id: "tomorrow-morning", at: atHour(tomorrow, 9) }, { id: "tomorrow-evening", at: atHour(tomorrow, 18) });
  const untilMonday = ((8 - now.getDay()) % 7) || 7;
  slots.push({ id: "next-monday", at: atHour(addDays(now, untilMonday), 9) });
  return slots.map((s) => ({
    id: s.id,
    label: describeSlot(s.id, s.at, now, locale),
    value: toLocalInput(s.at.toISOString()),
  }));
}

function describeSlot(id: string, at: Date, now: Date, locale?: string): string {
  const time = at.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  if (id === "today-evening") return `This evening, ${time}`;
  if (id === "tomorrow-morning" || id === "tomorrow-evening") return `Tomorrow, ${time}`;
  return at.toLocaleString(locale, SLOT_FORMAT);
}

/** The value to put in the date and time box when the composer opens. Always in the future. */
export function defaultSchedule(dayKeyValue: string | undefined, now: Date = new Date()): string {
  if (dayKeyValue && /^\d{4}-\d{2}-\d{2}$/.test(dayKeyValue)) {
    const [y, m, d] = dayKeyValue.split("-").map(Number);
    const nine = new Date(y, m - 1, d, 9, 0, 0, 0);
    if (nine.getTime() > now.getTime()) return toLocalInput(nine.toISOString());
    const soon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 2, 0, 0, 0);
    return dayKey(soon) === dayKeyValue ? toLocalInput(soon.toISOString()) : toLocalInput(nine.toISOString());
  }
  return toLocalInput(atHour(addDays(now, 1), 9).toISOString());
}

/** Plain-language problem with a chosen time, or null when it can be scheduled. */
export function scheduleProblem(local: string, now: Date = new Date()): string | null {
  if (!local) return "Choose a date and time.";
  const at = new Date(local);
  if (Number.isNaN(at.getTime())) return "Choose a date and time.";
  if (at.getTime() <= now.getTime()) return "That time has already passed. Choose a time in the future.";
  if (at.getTime() > now.getTime() + MAX_DAYS_AHEAD * DAY) return `Posts can be scheduled up to ${MAX_DAYS_AHEAD} days ahead.`;
  return null;
}

/**
 * The scheduledAt part of a save request. A draft with no usable time is saved without one (the server allows it), so an empty or
 * invalid date box can never throw. A post that is not a draft always sends its time; its button is disabled until the time is valid.
 */
export function scheduledAtField(local: string, draft: boolean, problem: string | null): { scheduledAt?: string } {
  if (draft && problem !== null) return {};
  return { scheduledAt: fromLocalInput(local) };
}

export type Counter = { used: number; max: number; over: boolean; remaining: number; text: string };

export function charCounter(channel: Channel, body: string): Counter {
  const max = CHANNEL_LIMITS[channel].maxChars;
  const used = body.length;
  const over = used > max;
  const text = over ? `${used - max} over the limit` : `${used.toLocaleString("en-US")} of ${max.toLocaleString("en-US")} characters`;
  return { used, max, over, remaining: max - used, text };
}

/** What a channel will actually show: text beyond the limit is dropped. */
export function visibleText(channel: Channel, body: string): string {
  const max = CHANNEL_LIMITS[channel].maxChars;
  return body.length > max ? body.slice(0, max) : body;
}

export function firstLink(body: string): string | null {
  return body.match(/https?:\/\/[^\s]+/)?.[0] ?? null;
}

export const MEDIA_LIMIT_TEXT = "Pictures up to 8 MB (JPEG or PNG), videos up to 100 MB (MP4 or MOV).";
