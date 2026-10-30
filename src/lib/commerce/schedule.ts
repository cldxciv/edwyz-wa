export type CartStage = "cart" | "checkout";

/** Gaps in minutes: the first reminder after the event, then each next one after the previous one was due. */
export const DEFAULT_GAPS_MIN: Record<CartStage, number[]> = {
  cart: [30, 360, 1440],
  checkout: [15, 60, 1440],
};

export const MAX_REMINDERS = 3;
export const MAX_GAP_MIN = 3 * 24 * 60;
export const CART_LIFETIME_MS = 3 * 24 * 60 * 60 * 1000;

const minutes = (n: number) => n * 60_000;

export function firstReminderAt(eventAt: Date, gaps: number[]): Date {
  return new Date(eventAt.getTime() + minutes(gaps[0]));
}

/** When the reminder after the current one is due, given how many reminders will have been sent (1 or 2). Null after the last. */
export function nextReminderAfter(dueAt: Date, remindersSent: number, gaps: number[]): Date | null {
  if (remindersSent >= MAX_REMINDERS || remindersSent >= gaps.length) return null;
  return new Date(dueAt.getTime() + minutes(gaps[remindersSent]));
}

export function isExpired(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() > CART_LIFETIME_MS;
}

export function validGaps(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== MAX_REMINDERS) return null;
  if (!value.every((n) => Number.isInteger(n) && n >= 1 && n <= MAX_GAP_MIN)) return null;
  return value as number[];
}
