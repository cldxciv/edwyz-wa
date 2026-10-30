import { LIMITS } from "./types";

export type DurationUnit = "minutes" | "hours" | "days";

export const UNIT_MINUTES: Record<DurationUnit, number> = { minutes: 1, hours: 60, days: 1440 };

/** Picks the largest unit that divides the minutes evenly, so 120 shows as "2 hours" and 90 as "90 minutes". */
export function toDuration(minutes: number): { amount: number; unit: DurationUnit } {
  const m = Number.isFinite(minutes) && minutes > 0 ? Math.trunc(minutes) : 0;
  if (m > 0 && m % 1440 === 0) return { amount: m / 1440, unit: "days" };
  if (m > 0 && m % 60 === 0) return { amount: m / 60, unit: "hours" };
  return { amount: m, unit: "minutes" };
}

export function fromDuration(amount: number, unit: DurationUnit): number {
  const n = Number.isFinite(amount) ? Math.trunc(amount) : 0;
  return Math.max(0, n) * UNIT_MINUTES[unit];
}

/** A human message when the wait is outside what the bot supports, or null when it is fine. */
export function durationProblem(minutes: number): string | null {
  if (!Number.isInteger(minutes) || minutes < LIMITS.delayMin) return "Enter a wait of at least 1 minute.";
  if (minutes > LIMITS.delayMax) return "The longest wait is 7 days.";
  return null;
}
