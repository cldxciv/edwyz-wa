import { HttpError } from "@/lib/tenancy";

export const MAX_SCHEDULE_DAYS = 90;
export const MAX_RETRY_DAYS = 7;
export const MAX_CALENDAR_SPAN_DAYS = 62;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Parses an ISO string into a Date or throws a 400. */
export function parseIsoDate(value: unknown, field: string): Date {
  const date = typeof value === "string" ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, `${field} must be an ISO date string.`);
  return date;
}

/** A schedule must lie in the future and at most 90 days ahead. */
export function assertValidSchedule(at: Date, now = new Date()): void {
  if (at.getTime() <= now.getTime()) throw new HttpError(400, "scheduledAt must be in the future.");
  if (at.getTime() > now.getTime() + MAX_SCHEDULE_DAYS * DAY_MS) {
    throw new HttpError(400, `scheduledAt can be at most ${MAX_SCHEDULE_DAYS} days ahead.`);
  }
}

export function parseRetryDays(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_RETRY_DAYS) {
    throw new HttpError(400, `retryDays must be a whole number from 0 to ${MAX_RETRY_DAYS}.`);
  }
  return value;
}

export function assertValidRange(from: Date, to: Date): void {
  if (to.getTime() <= from.getTime()) throw new HttpError(400, "to must be after from.");
  if (to.getTime() - from.getTime() > MAX_CALENDAR_SPAN_DAYS * DAY_MS) {
    throw new HttpError(400, `The range can span at most ${MAX_CALENDAR_SPAN_DAYS} days.`);
  }
}
