/** Calling code (digits, no plus) to the ISO country code it is mostly used for. Shared codes list their main country. */
const CODE_TO_COUNTRY: Record<string, string> = {
  "1": "US", "7": "RU", "20": "EG", "27": "ZA", "30": "GR", "31": "NL", "32": "BE", "33": "FR", "34": "ES", "36": "HU", "39": "IT",
  "40": "RO", "41": "CH", "43": "AT", "44": "GB", "45": "DK", "46": "SE", "47": "NO", "48": "PL", "49": "DE", "51": "PE", "52": "MX",
  "53": "CU", "54": "AR", "55": "BR", "56": "CL", "57": "CO", "58": "VE", "60": "MY", "61": "AU", "62": "ID", "63": "PH", "64": "NZ",
  "65": "SG", "66": "TH", "81": "JP", "82": "KR", "84": "VN", "86": "CN", "90": "TR", "91": "IN", "92": "PK", "93": "AF", "94": "LK",
  "95": "MM", "98": "IR",
  "211": "SS", "212": "MA", "213": "DZ", "216": "TN", "218": "LY", "220": "GM", "221": "SN", "223": "ML", "225": "CI", "226": "BF",
  "227": "NE", "228": "TG", "229": "BJ", "230": "MU", "231": "LR", "232": "SL", "233": "GH", "234": "NG", "235": "TD", "237": "CM",
  "238": "CV", "241": "GA", "242": "CG", "243": "CD", "244": "AO", "249": "SD", "250": "RW", "251": "ET", "252": "SO", "253": "DJ",
  "254": "KE", "255": "TZ", "256": "UG", "257": "BI", "258": "MZ", "260": "ZM", "261": "MG", "263": "ZW", "264": "NA", "265": "MW",
  "266": "LS", "267": "BW", "268": "SZ", "269": "KM",
  "351": "PT", "352": "LU", "353": "IE", "354": "IS", "355": "AL", "356": "MT", "357": "CY", "358": "FI", "359": "BG", "370": "LT",
  "371": "LV", "372": "EE", "373": "MD", "374": "AM", "375": "BY", "376": "AD", "380": "UA", "381": "RS", "382": "ME", "385": "HR",
  "386": "SI", "387": "BA", "389": "MK", "420": "CZ", "421": "SK",
  "501": "BZ", "502": "GT", "503": "SV", "504": "HN", "505": "NI", "506": "CR", "507": "PA", "591": "BO", "592": "GY", "593": "EC",
  "595": "PY", "597": "SR", "598": "UY",
  "670": "TL", "673": "BN", "852": "HK", "853": "MO", "855": "KH", "856": "LA", "880": "BD", "886": "TW",
  "960": "MV", "961": "LB", "962": "JO", "963": "SY", "964": "IQ", "965": "KW", "966": "SA", "967": "YE", "968": "OM", "970": "PS",
  "971": "AE", "972": "IL", "973": "BH", "974": "QA", "975": "BT", "976": "MN", "977": "NP", "992": "TJ", "993": "TM", "994": "AZ",
  "995": "GE", "996": "KG", "998": "UZ",
};

/** Countries that share a calling code with the one in the table. */
const SHARED: Record<string, string> = { CA: "1", KZ: "7" };

export const KNOWN_COUNTRIES: string[] = [...new Set([...Object.values(CODE_TO_COUNTRY), ...Object.keys(SHARED)])].sort();

/** The country for a phone number like +919876543210, or null when the prefix is unknown. */
export function countryOfPhone(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  for (const length of [3, 2, 1]) {
    const country = CODE_TO_COUNTRY[digits.slice(0, length)];
    if (country) return country;
  }
  return null;
}

/** The ISO country in a BSUID prefix (`US.` or `IN.`), or null. */
export function countryOfBsuid(bsuid: string): string | null {
  const m = /^([A-Za-z]{2})\./.exec(bsuid.trim());
  return m ? m[1].toUpperCase() : null;
}

/**
 * A string countryOfPhone can read for any contact: the phone itself, or for a contact known only by BSUID a "+<calling code>" built from the
 * country in the BSUID prefix ("+0", which maps to an unknown country, when the prefix is not one we list).
 */
export function countryProbe(c: { phone?: string | null; bsuid?: string | null }): string {
  if (c.phone) return c.phone;
  const iso = c.bsuid ? countryOfBsuid(c.bsuid) : null;
  const code = iso ? callingCodesFor(iso)[0] : undefined;
  return `+${code ?? "0"}`;
}

/** Calling codes (no plus) used by a country, or an empty list for an unknown code. */
export function callingCodesFor(country: string): string[] {
  const iso = country.toUpperCase();
  if (SHARED[iso]) return [SHARED[iso]];
  return Object.entries(CODE_TO_COUNTRY)
    .filter(([, c]) => c === iso)
    .map(([code]) => code);
}
