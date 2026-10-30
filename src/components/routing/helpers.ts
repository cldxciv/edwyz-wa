import type { RoutingSettings } from "@/lib/routing/config";

export const MAX_OPEN = 500;

export const MODE_INFO: Record<RoutingSettings["mode"], { label: string; description: string }> = {
  round_robin: { label: "Take turns", description: "Each new chat goes to the person who was given a chat longest ago, so everyone gets a fair share." },
  least_busy: { label: "Least busy first", description: "Each new chat goes to the person with the fewest open chats right now." },
};

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export type DayRow = { enabled: boolean; start: string; end: string };
export type FormState = {
  autoAssign: boolean;
  mode: RoutingSettings["mode"];
  timezone: string;
  alwaysOn: boolean;
  days: DayRow[];
  maxOpenPerAgent: string;
  fallbackUserId: string;
};

export function toForm(c: RoutingSettings): FormState {
  const days: DayRow[] = DAY_NAMES.map((_, d) => {
    const w = c.workingHours?.windows.find((x) => x.day === d);
    return w ? { enabled: true, start: w.start, end: w.end } : { enabled: false, start: "09:00", end: "18:00" };
  });
  return {
    autoAssign: c.autoAssign,
    mode: c.mode,
    timezone: c.timezone,
    alwaysOn: c.workingHours === null,
    days,
    maxOpenPerAgent: c.maxOpenPerAgent === null ? "" : String(c.maxOpenPerAgent),
    fallbackUserId: c.fallbackUserId ?? "",
  };
}

/**
 * Returns the request body or an error message. When automatic sharing is off the other fields are hidden, so they are
 * never checked: unusable hidden values are sent as "always on" and "no limit" instead of blocking the save.
 */
export function toBody(f: FormState): { body: RoutingSettings } | { error: string } {
  const windows = f.days.flatMap((d, day) => (d.enabled ? [{ day, start: d.start, end: d.end }] : []));
  const hidden = !f.autoAssign;
  if (!hidden && !f.alwaysOn && windows.length === 0) return { error: "Turn on at least one working day, or choose always on." };
  let maxOpenPerAgent: number | null = null;
  if (f.maxOpenPerAgent.trim() !== "") {
    const n = Number(f.maxOpenPerAgent);
    if (Number.isInteger(n) && n >= 1 && n <= MAX_OPEN) maxOpenPerAgent = n;
    else if (!hidden) return { error: `Maximum open chats must be a whole number from 1 to ${MAX_OPEN}.` };
  }
  const alwaysOn = f.alwaysOn || (hidden && windows.length === 0);
  return {
    body: {
      autoAssign: f.autoAssign,
      mode: f.mode,
      timezone: f.timezone,
      workingHours: alwaysOn ? null : { windows },
      maxOpenPerAgent,
      fallbackUserId: f.fallbackUserId || null,
    },
  };
}

export type FormErrors = Partial<Record<"timezone" | "maxOpenPerAgent" | "hours", string>>;

export function isValidTimezoneName(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz.trim().length > 0;
  } catch {
    return false;
  }
}

/** Field-level problems, written for the person filling in the form. Empty object means the form can be saved. */
export function validateForm(f: FormState): FormErrors {
  const errors: FormErrors = {};
  if (!f.autoAssign) return errors;
  if (!f.alwaysOn && !isValidTimezoneName(f.timezone)) errors.timezone = "Choose a time zone from the list, like Asia/Kolkata or Europe/London.";
  const max = f.maxOpenPerAgent.trim();
  if (max !== "") {
    const n = Number(max);
    if (!Number.isInteger(n) || n < 1 || n > MAX_OPEN) errors.maxOpenPerAgent = `Enter a whole number from 1 to ${MAX_OPEN}, or leave it empty for no limit.`;
  }
  if (!f.alwaysOn) {
    if (!f.days.some((d) => d.enabled)) errors.hours = "Turn on at least one working day, or choose always on.";
    else if (f.days.some((d) => d.enabled && (!d.start || !d.end))) errors.hours = "Set a start and end time for each working day.";
  }
  return errors;
}

export type LimitResult = { ok: true; value: number | null } | { ok: false };

/** Parses the per-person chat limit box: empty means no limit. */
export function parseLimit(raw: string): LimitResult {
  const v = raw.trim();
  if (v === "") return { ok: true, value: null };
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= MAX_OPEN ? { ok: true, value: n } : { ok: false };
}

/**
 * What actually gets saved. With automatic sharing off the other settings are hidden, so edits made before switching it off
 * are dropped and the last saved values stay. Otherwise a hidden, invalid value would block saving with no visible message.
 */
export function effectiveForm(form: FormState, saved: FormState): FormState {
  return form.autoAssign ? form : { ...saved, autoAssign: false };
}

export function isDirty(a: FormState, b: FormState): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

/** One line summary of the saved rules, for the top of the page. */
export function routingSummary(f: FormState, fallbackName?: string | null): string {
  if (!f.autoAssign) return "Automatic assignment is off. New chats wait in the inbox until someone picks them up.";
  const parts = [`New chats are shared out automatically (${MODE_INFO[f.mode].label.toLowerCase()})`];
  parts.push(f.alwaysOn ? "at any time" : "during your working hours");
  if (fallbackName) parts.push(`and go to ${fallbackName} when nobody is free`);
  return `${parts.join(" ")}.`;
}
