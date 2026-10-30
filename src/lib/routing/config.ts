import { isValidTimezone, isWithinOpenHours, type Schedule } from "@/lib/automation/match";

export type RoutingMode = "round_robin" | "least_busy";
export const ROUTING_MODES: RoutingMode[] = ["round_robin", "least_busy"];

export type HoursWindow = { day: number; start: string; end: string };
/** Windows may overlap days; a window with start after end runs overnight and belongs to its start day. Legacy shape { days, start, end } is also read. */
export type WorkingHours = { windows: HoursWindow[] };

export type RoutingSettings = {
  autoAssign: boolean;
  mode: RoutingMode;
  timezone: string;
  workingHours: WorkingHours | null;
  maxOpenPerAgent: number | null;
  fallbackUserId: string | null;
};

export const DEFAULT_SETTINGS: RoutingSettings = {
  autoAssign: false,
  mode: "round_robin",
  timezone: "Asia/Kolkata",
  workingHours: null,
  maxOpenPerAgent: null,
  fallbackUserId: null,
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export const MAX_OPEN_LIMIT = 500;

function toWindows(value: unknown): HoursWindow[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const raw: unknown[] = Array.isArray(v.windows)
    ? v.windows
    : Array.isArray(v.days)
      ? (v.days as unknown[]).map((day) => ({ day, start: v.start, end: v.end }))
      : [];
  const out: HoursWindow[] = [];
  for (const w of raw) {
    if (!w || typeof w !== "object") return null;
    const { day, start, end } = w as Record<string, unknown>;
    if (!Number.isInteger(day) || (day as number) < 0 || (day as number) > 6) return null;
    if (typeof start !== "string" || typeof end !== "string" || !TIME.test(start) || !TIME.test(end)) return null;
    out.push({ day: day as number, start, end });
  }
  return out;
}

/** Returns null when the stored value is unusable, which callers treat as "always on". */
export function parseWorkingHours(value: unknown): WorkingHours | null {
  const windows = toWindows(value);
  return windows && windows.length > 0 ? { windows: windows.slice(0, 28) } : null;
}

export function isWithinWorkingHours(config: { timezone: string; workingHours: unknown }, at: Date): boolean {
  if (config.workingHours === null || config.workingHours === undefined) return true;
  const parsed = parseWorkingHours(config.workingHours);
  if (!parsed) return true;
  const timezone = isValidTimezone(config.timezone) ? config.timezone : DEFAULT_SETTINGS.timezone;
  return parsed.windows.some((w) => isWithinOpenHours({ timezone, days: [w.day], start: w.start, end: w.end } satisfies Schedule, at));
}

export type ConfigInput = Partial<Record<keyof RoutingSettings, unknown>>;

/** Validates a full replacement of the settings. Returns the clean settings or an error message. */
export function validateSettings(body: ConfigInput): { ok: true; value: RoutingSettings } | { ok: false; error: string } {
  if (typeof body.autoAssign !== "boolean") return { ok: false, error: "autoAssign must be true or false." };
  if (typeof body.mode !== "string" || !ROUTING_MODES.includes(body.mode as RoutingMode)) return { ok: false, error: "mode must be round_robin or least_busy." };
  if (typeof body.timezone !== "string" || !isValidTimezone(body.timezone)) return { ok: false, error: "timezone is not a valid timezone." };
  let workingHours: WorkingHours | null = null;
  if (body.workingHours !== null && body.workingHours !== undefined) {
    workingHours = parseWorkingHours(body.workingHours);
    if (!workingHours) return { ok: false, error: "workingHours needs at least one window with a day (0-6) and HH:MM times." };
  }
  let maxOpenPerAgent: number | null = null;
  if (body.maxOpenPerAgent !== null && body.maxOpenPerAgent !== undefined) {
    const n = body.maxOpenPerAgent;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_OPEN_LIMIT) return { ok: false, error: `maxOpenPerAgent must be a whole number from 1 to ${MAX_OPEN_LIMIT}.` };
    maxOpenPerAgent = n;
  }
  let fallbackUserId: string | null = null;
  if (body.fallbackUserId !== null && body.fallbackUserId !== undefined && body.fallbackUserId !== "") {
    if (typeof body.fallbackUserId !== "string" || body.fallbackUserId.length > 64) return { ok: false, error: "fallbackUserId is invalid." };
    fallbackUserId = body.fallbackUserId;
  }
  return { ok: true, value: { autoAssign: body.autoAssign, mode: body.mode as RoutingMode, timezone: body.timezone, workingHours, maxOpenPerAgent, fallbackUserId } };
}

export type Candidate = {
  userId: string;
  eligibleMember: boolean;
  disabled: boolean;
  available: boolean;
  maxOpen: number | null;
  lastAssignedAt: Date | null;
  openCount: number;
};

/** Pure. Skips unavailable, disabled and non-member agents and anyone at their own or the tenant cap, then orders by mode. */
export function pickAgent(candidates: Candidate[], mode: RoutingMode, tenantMaxOpen: number | null): string | null {
  const eligible = candidates.filter((c) => {
    if (!c.eligibleMember || c.disabled || !c.available) return false;
    if (c.maxOpen !== null && c.openCount >= c.maxOpen) return false;
    if (tenantMaxOpen !== null && c.openCount >= tenantMaxOpen) return false;
    return true;
  });
  if (eligible.length === 0) return null;
  const last = (c: Candidate) => c.lastAssignedAt?.getTime() ?? 0;
  const byAge = (a: Candidate, b: Candidate) => last(a) - last(b) || a.userId.localeCompare(b.userId);
  const sorted = [...eligible].sort(mode === "least_busy" ? (a, b) => a.openCount - b.openCount || byAge(a, b) : byAge);
  return sorted[0].userId;
}
