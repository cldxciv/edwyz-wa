import { HttpError } from "@/lib/tenancy";

export const MAX_RANGE_DAYS = 366;
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Old zone names the IANA database keeps only as links. Browsers still hand them out (Chrome on Windows in India reports
 * "Asia/Calcutta"), and Node's Intl resolves even "Asia/Kolkata" back to "Asia/Calcutta". A Postgres built with a trimmed
 * tzdata (Debian's tzdata without tzdata-legacy) does not know these names, so SQL's AT TIME ZONE fails on them.
 * Every zone is mapped to its current name before it reaches SQL.
 */
const LEGACY_ZONES: Record<string, string> = {
  "Africa/Asmera": "Africa/Asmara",
  "Africa/Timbuktu": "Africa/Abidjan",
  "America/Argentina/ComodRivadavia": "America/Argentina/Catamarca",
  "America/Atka": "America/Adak",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Catamarca": "America/Argentina/Catamarca",
  "America/Coral_Harbour": "America/Atikokan",
  "America/Cordoba": "America/Argentina/Cordoba",
  "America/Ensenada": "America/Tijuana",
  "America/Fort_Wayne": "America/Indiana/Indianapolis",
  "America/Godthab": "America/Nuuk",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Jujuy": "America/Argentina/Jujuy",
  "America/Knox_IN": "America/Indiana/Knox",
  "America/Louisville": "America/Kentucky/Louisville",
  "America/Mendoza": "America/Argentina/Mendoza",
  "America/Montreal": "America/Toronto",
  "America/Porto_Acre": "America/Rio_Branco",
  "America/Rosario": "America/Argentina/Cordoba",
  "America/Santa_Isabel": "America/Tijuana",
  "America/Shiprock": "America/Denver",
  "America/Virgin": "America/Puerto_Rico",
  "Antarctica/South_Pole": "Pacific/Auckland",
  "Asia/Ashkhabad": "Asia/Ashgabat",
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Chongqing": "Asia/Shanghai",
  "Asia/Chungking": "Asia/Shanghai",
  "Asia/Dacca": "Asia/Dhaka",
  "Asia/Harbin": "Asia/Shanghai",
  "Asia/Istanbul": "Europe/Istanbul",
  "Asia/Kashgar": "Asia/Urumqi",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Macao": "Asia/Macau",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Asia/Tel_Aviv": "Asia/Jerusalem",
  "Asia/Thimbu": "Asia/Thimphu",
  "Asia/Ujung_Pandang": "Asia/Makassar",
  "Asia/Ulan_Bator": "Asia/Ulaanbaatar",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Atlantic/Jan_Mayen": "Europe/Berlin",
  "Australia/ACT": "Australia/Sydney",
  "Australia/Canberra": "Australia/Sydney",
  "Australia/LHI": "Australia/Lord_Howe",
  "Australia/NSW": "Australia/Sydney",
  "Australia/North": "Australia/Darwin",
  "Australia/Queensland": "Australia/Brisbane",
  "Australia/South": "Australia/Adelaide",
  "Australia/Tasmania": "Australia/Hobart",
  "Australia/Victoria": "Australia/Melbourne",
  "Australia/West": "Australia/Perth",
  "Australia/Yancowinna": "Australia/Broken_Hill",
  "Brazil/Acre": "America/Rio_Branco",
  "Brazil/DeNoronha": "America/Noronha",
  "Brazil/East": "America/Sao_Paulo",
  "Brazil/West": "America/Manaus",
  "Canada/Atlantic": "America/Halifax",
  "Canada/Central": "America/Winnipeg",
  "Canada/Eastern": "America/Toronto",
  "Canada/Mountain": "America/Edmonton",
  "Canada/Newfoundland": "America/St_Johns",
  "Canada/Pacific": "America/Vancouver",
  "Canada/Saskatchewan": "America/Regina",
  "Canada/Yukon": "America/Whitehorse",
  "Chile/Continental": "America/Santiago",
  "Chile/EasterIsland": "Pacific/Easter",
  Cuba: "America/Havana",
  Egypt: "Africa/Cairo",
  Eire: "Europe/Dublin",
  "Etc/GMT+0": "UTC",
  "Etc/GMT-0": "UTC",
  "Etc/GMT0": "UTC",
  "Etc/Greenwich": "UTC",
  "Etc/UCT": "UTC",
  "Etc/UTC": "UTC",
  "Etc/Universal": "UTC",
  "Etc/Zulu": "UTC",
  "Europe/Belfast": "Europe/London",
  "Europe/Kiev": "Europe/Kyiv",
  "Europe/Nicosia": "Asia/Nicosia",
  "Europe/Tiraspol": "Europe/Chisinau",
  "Europe/Uzhgorod": "Europe/Kyiv",
  "Europe/Zaporozhye": "Europe/Kyiv",
  GB: "Europe/London",
  "GB-Eire": "Europe/London",
  GMT: "UTC",
  "GMT+0": "UTC",
  "GMT-0": "UTC",
  GMT0: "UTC",
  Greenwich: "UTC",
  Hongkong: "Asia/Hong_Kong",
  Iran: "Asia/Tehran",
  Israel: "Asia/Jerusalem",
  Jamaica: "America/Jamaica",
  Japan: "Asia/Tokyo",
  Kwajalein: "Pacific/Kwajalein",
  Libya: "Africa/Tripoli",
  "Mexico/BajaNorte": "America/Tijuana",
  "Mexico/BajaSur": "America/Mazatlan",
  "Mexico/General": "America/Mexico_City",
  NZ: "Pacific/Auckland",
  "NZ-CHAT": "Pacific/Chatham",
  Navajo: "America/Denver",
  PRC: "Asia/Shanghai",
  "Pacific/Enderbury": "Pacific/Kanton",
  "Pacific/Johnston": "Pacific/Honolulu",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Samoa": "Pacific/Pago_Pago",
  "Pacific/Truk": "Pacific/Chuuk",
  "Pacific/Yap": "Pacific/Chuuk",
  Poland: "Europe/Warsaw",
  Portugal: "Europe/Lisbon",
  ROC: "Asia/Taipei",
  ROK: "Asia/Seoul",
  Singapore: "Asia/Singapore",
  Turkey: "Europe/Istanbul",
  UCT: "UTC",
  "US/Alaska": "America/Anchorage",
  "US/Aleutian": "America/Adak",
  "US/Arizona": "America/Phoenix",
  "US/Central": "America/Chicago",
  "US/East-Indiana": "America/Indiana/Indianapolis",
  "US/Eastern": "America/New_York",
  "US/Hawaii": "Pacific/Honolulu",
  "US/Indiana-Starke": "America/Indiana/Knox",
  "US/Michigan": "America/Detroit",
  "US/Mountain": "America/Denver",
  "US/Pacific": "America/Los_Angeles",
  "US/Samoa": "Pacific/Pago_Pago",
  Universal: "UTC",
  "W-SU": "Europe/Moscow",
  Zulu: "UTC",
};

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
