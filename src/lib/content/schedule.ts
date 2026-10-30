import { HttpError } from "@/lib/tenancy";

export const MAX_DAYS_AHEAD = 90;
export const MAX_CALENDAR_DAYS = 62;
const DAY = 86_400_000;

export function parseDate(value: unknown, field: string): Date {
  const d = typeof value === "string" ? new Date(value) : new Date(NaN);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(String(value)) || Number.isNaN(d.getTime())) throw new HttpError(400, `${field} must be an ISO date-time.`);
  return d;
}

/** Times are stored in UTC; the UI converts to the viewer's zone. */
export function assertSchedulable(at: Date, now = new Date()): void {
  if (at.getTime() <= now.getTime()) throw new HttpError(400, "Choose a time in the future.");
  if (at.getTime() > now.getTime() + MAX_DAYS_AHEAD * DAY) throw new HttpError(400, `Posts can be scheduled at most ${MAX_DAYS_AHEAD} days ahead.`);
}

export function parseRange(from: unknown, to: unknown): { from: Date; to: Date } {
  const a = parseDate(from, "from");
  const b = parseDate(to, "to");
  if (b <= a) throw new HttpError(400, "to must be after from.");
  if (b.getTime() - a.getTime() > MAX_CALENDAR_DAYS * DAY) throw new HttpError(400, `The range can be at most ${MAX_CALENDAR_DAYS} days.`);
  return { from: a, to: b };
}
