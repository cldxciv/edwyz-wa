import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/tenancy";
import { isValidTimezone, LIMITS } from "./model";
import { localDateTime } from "../match";

export type RunMode = "first_match" | "all_matching";
export type HolidaySettings = { enabled: boolean; message: string; /** Last day of the holiday, YYYY-MM-DD in the timezone. Null means until switched off. */ endsOn: string | null; timezone: string };
export type AutomationSettings = { mode: RunMode; holiday: HolidaySettings };

export const DEFAULT_SETTINGS: AutomationSettings = {
  mode: "first_match",
  holiday: { enabled: false, message: "", endsOn: null, timezone: "UTC" },
};

/** The holiday message goes out at most once per chat in this time, however many messages the customer sends. */
export const HOLIDAY_REPEAT_MS = 12 * 3_600_000;

const key = (tenantId: string) => `automation:${tenantId}`;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function read(value: unknown): AutomationSettings {
  const v = isRecord(value) ? value : {};
  const h = isRecord(v.holiday) ? v.holiday : {};
  return {
    mode: v.mode === "all_matching" ? "all_matching" : "first_match",
    holiday: {
      enabled: h.enabled === true,
      message: typeof h.message === "string" ? h.message.slice(0, LIMITS.text) : "",
      endsOn: typeof h.endsOn === "string" && DATE.test(h.endsOn) ? h.endsOn : null,
      timezone: typeof h.timezone === "string" && isValidTimezone(h.timezone) ? h.timezone : "UTC",
    },
  };
}

export async function getAutomationSettings(tenantId: string): Promise<AutomationSettings> {
  const row = await prisma.platformSetting.findUnique({ where: { key: key(tenantId) } });
  return read(row?.value);
}

/** True while holiday mode should answer: switched on, with a message, and not past its last day. */
export function isHolidayActive(holiday: HolidaySettings, now = new Date()): boolean {
  if (!holiday.enabled || !holiday.message.trim()) return false;
  if (!holiday.endsOn) return true;
  return localDateTime(now, holiday.timezone).date <= holiday.endsOn;
}

export function validateSettingsPatch(raw: unknown): Partial<{ mode: RunMode; holiday: Partial<HolidaySettings> }> {
  if (!isRecord(raw)) throw new HttpError(400, "Invalid settings.");
  const out: Partial<{ mode: RunMode; holiday: Partial<HolidaySettings> }> = {};
  if (raw.mode !== undefined) {
    if (raw.mode !== "first_match" && raw.mode !== "all_matching") throw new HttpError(400, "mode must be first_match or all_matching.");
    out.mode = raw.mode;
  }
  if (raw.holiday !== undefined) {
    if (!isRecord(raw.holiday)) throw new HttpError(400, "Invalid holiday settings.");
    const h = raw.holiday;
    const holiday: Partial<HolidaySettings> = {};
    if (h.enabled !== undefined) {
      if (typeof h.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false.");
      holiday.enabled = h.enabled;
    }
    if (h.message !== undefined) {
      if (typeof h.message !== "string" || h.message.length > LIMITS.text) throw new HttpError(400, `The holiday message can be up to ${LIMITS.text} characters.`);
      holiday.message = h.message.trim();
    }
    if (h.endsOn !== undefined) {
      if (h.endsOn !== null && (typeof h.endsOn !== "string" || !DATE.test(h.endsOn))) throw new HttpError(400, "Pick a valid last day.");
      holiday.endsOn = h.endsOn as string | null;
    }
    if (h.timezone !== undefined) {
      if (typeof h.timezone !== "string" || !isValidTimezone(h.timezone)) throw new HttpError(400, "Pick a valid timezone.");
      holiday.timezone = h.timezone;
    }
    out.holiday = holiday;
  }
  return out;
}

export async function updateAutomationSettings(tenantId: string, raw: unknown): Promise<AutomationSettings> {
  const patch = validateSettingsPatch(raw);
  const current = await getAutomationSettings(tenantId);
  const next: AutomationSettings = { mode: patch.mode ?? current.mode, holiday: { ...current.holiday, ...patch.holiday } };
  if (next.holiday.enabled && !next.holiday.message.trim()) throw new HttpError(400, "Write the holiday message before switching holiday mode on.");
  await prisma.platformSetting.upsert({ where: { key: key(tenantId) }, create: { key: key(tenantId), value: next }, update: { value: next } });
  return next;
}
