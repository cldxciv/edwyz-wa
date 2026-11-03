/**
 * Time zone names. Browsers list time zones by CLDR's names, which keep some zones under their old IANA names (Asia/Calcutta,
 * Europe/Kiev, Asia/Saigon), while Edwyz stores the current ones (Asia/Kolkata). Mixing the two listed India twice. Each old
 * name is an IANA link to the same zone, so Intl accepts either spelling; the lists show only the current one.
 */

/**
 * Old zone names the IANA database keeps only as links, mapped to their current names. Browsers still hand them out (Chrome
 * on Windows in India reports "Asia/Calcutta"), and Node's Intl resolves even "Asia/Kolkata" back to "Asia/Calcutta". A Postgres
 * built with a trimmed tzdata (Debian's tzdata without tzdata-legacy) does not know these names, so SQL's AT TIME ZONE fails
 * on them (reports map every zone before it reaches SQL), and listed beside their current names they repeat a zone.
 */
export const LEGACY_ZONES: Readonly<Record<string, string>> = Object.freeze({
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
});

/** Used when the browser cannot list its time zones. */
export const FALLBACK_ZONES: readonly string[] = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "Australia/Sydney", "UTC"];

/** The current name of a zone ("Asia/Calcutta" -> "Asia/Kolkata"); any other name unchanged. Pure. */
export function currentZoneName(zone: string): string {
  return LEGACY_ZONES[zone] ?? zone;
}

function supportedZones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

/**
 * One entry per zone under its current name, sorted. `current` (the stored value) is always an option, in its own spelling:
 * a stored "Asia/Calcutta" takes the place of "Asia/Kolkata", so it stays selected and India is still listed once.
 */
export function timeZoneList(current?: string | null, supported: readonly string[] = supportedZones()): string[] {
  const list = [...new Set((supported.length > 0 ? supported : FALLBACK_ZONES).map(currentZoneName))].sort();
  if (!current || list.includes(current)) return list;
  const twin = list.indexOf(currentZoneName(current));
  if (twin >= 0) list[twin] = current;
  else list.unshift(current);
  return list;
}
