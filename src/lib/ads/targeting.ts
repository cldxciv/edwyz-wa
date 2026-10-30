import { PLACEMENTS, type GeoCity, type Gender, type Interest, type Placement, type SpecialAdCategory, type Targeting } from "./types";

export const AGE_MIN = 13;
export const AGE_MAX = 65;
export const MAX_INTERESTS = 25;
export const MAX_COUNTRIES = 25;
export const MAX_CITIES = 25;

export type CategoryRule = {
  /** Meta's special_ad_categories enum value. */
  metaValue: string;
  fixedAge: { min: number; max: number } | null;
  allGendersOnly: boolean;
  noDetailedInterests: boolean;
  noLookalikes: boolean;
  /** Minimum radius for city or point targeting, in kilometres. */
  minRadiusKm: number;
};

/*
 * VERIFY against Meta's current "Special Ad Categories" policy before launch and per country.
 * Meta's published rule for housing, employment and credit ads in the US and Canada: no targeting by age, gender or
 * ZIP code, no detailed targeting that describes or implies protected traits, no lookalike audiences (replaced by
 * Special Ad Audiences), minimum 15-mile (about 24 km) radius for location targeting. Other countries and the social
 * issues category differ. These values are deliberately conservative and applied to every country.
 */
export const SPECIAL_CATEGORY_RULES: Record<Exclude<SpecialAdCategory, "none">, CategoryRule> = {
  housing: { metaValue: "HOUSING", fixedAge: { min: 18, max: AGE_MAX }, allGendersOnly: true, noDetailedInterests: true, noLookalikes: true, minRadiusKm: 24 },
  employment: { metaValue: "EMPLOYMENT", fixedAge: { min: 18, max: AGE_MAX }, allGendersOnly: true, noDetailedInterests: true, noLookalikes: true, minRadiusKm: 24 },
  credit: { metaValue: "CREDIT", fixedAge: { min: 18, max: AGE_MAX }, allGendersOnly: true, noDetailedInterests: true, noLookalikes: true, minRadiusKm: 24 },
  // VERIFY: ISSUES_ELECTIONS_POLITICS also needs advertiser authorization (identity verification) that this product does not handle.
  social_issues: { metaValue: "ISSUES_ELECTIONS_POLITICS", fixedAge: { min: 18, max: AGE_MAX }, allGendersOnly: true, noDetailedInterests: true, noLookalikes: true, minRadiusKm: 24 },
};

export function metaSpecialCategories(category: SpecialAdCategory): string[] {
  return category === "none" ? [] : [SPECIAL_CATEGORY_RULES[category].metaValue];
}

export const emptyTargeting = (): Targeting => ({ geo: { countries: [], cities: [] }, ageMin: AGE_MIN, ageMax: AGE_MAX, genders: [], interests: [], placements: [], lookalikeAudienceIds: [] });

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean).slice(0, max) : []);

/** Coerces untrusted JSON into the Targeting shape. Does not judge it; call validateTargeting for that. */
export function parseTargeting(raw: unknown): Targeting {
  const o = isObj(raw) ? raw : {};
  const geo = isObj(o.geo) ? o.geo : {};
  const cities: GeoCity[] = Array.isArray(geo.cities)
    ? geo.cities.filter(isObj).map((c) => ({ key: String(c.key ?? "").trim(), name: typeof c.name === "string" ? c.name.slice(0, 100) : undefined, radiusKm: Number(c.radiusKm) })).slice(0, MAX_CITIES)
    : [];
  const interests: Interest[] = Array.isArray(o.interests)
    ? o.interests.filter(isObj).map((i) => ({ id: String(i.id ?? "").trim(), name: String(i.name ?? "").slice(0, 100) })).slice(0, MAX_INTERESTS + 1)
    : [];
  return {
    geo: { countries: strings(geo.countries, MAX_COUNTRIES).map((c) => c.toUpperCase()), cities },
    ageMin: Number(o.ageMin ?? AGE_MIN),
    ageMax: Number(o.ageMax ?? AGE_MAX),
    genders: strings(o.genders, 2) as Gender[],
    interests,
    placements: strings(o.placements, PLACEMENTS.length) as Placement[],
    lookalikeAudienceIds: strings(o.lookalikeAudienceIds, 10),
  };
}

export type TargetingResult = { ok: boolean; errors: string[] };

export function validateTargeting(t: Targeting, category: SpecialAdCategory): TargetingResult {
  const errors: string[] = [];
  const { countries, cities } = t.geo;
  if (countries.length === 0 && cities.length === 0) errors.push("Choose at least one country or city.");
  if (countries.some((c) => !/^[A-Z]{2}$/.test(c))) errors.push("Countries must be two-letter ISO codes.");
  for (const c of cities) {
    if (!c.key) errors.push("Every city needs a Meta location key.");
    if (!Number.isFinite(c.radiusKm) || c.radiusKm < 1 || c.radiusKm > 80) errors.push("City radius must be between 1 and 80 km.");
  }
  if (!Number.isInteger(t.ageMin) || !Number.isInteger(t.ageMax) || t.ageMin < AGE_MIN || t.ageMax > AGE_MAX || t.ageMin > t.ageMax) {
    errors.push(`Age must be a whole range between ${AGE_MIN} and ${AGE_MAX}.`);
  }
  if (t.genders.some((g) => g !== "male" && g !== "female")) errors.push("Genders must be male or female.");
  if (t.interests.length > MAX_INTERESTS) errors.push(`Choose at most ${MAX_INTERESTS} interests.`);
  if (t.interests.some((i) => !/^\d+$/.test(i.id))) errors.push("Every interest needs a numeric Meta interest id.");
  if (t.placements.some((p) => !(PLACEMENTS as readonly string[]).includes(p))) errors.push("Unknown placement.");
  if (category !== "none") errors.push(...categoryViolations(t, category));
  return { ok: errors.length === 0, errors };
}

function categoryViolations(t: Targeting, category: Exclude<SpecialAdCategory, "none">): string[] {
  const rule = SPECIAL_CATEGORY_RULES[category];
  const out: string[] = [];
  const label = `Special ad category "${category}"`;
  if (rule.fixedAge && (t.ageMin !== rule.fixedAge.min || t.ageMax !== rule.fixedAge.max)) out.push(`${label} does not allow narrowing age; use ${rule.fixedAge.min} to ${rule.fixedAge.max}.`);
  if (rule.allGendersOnly && t.genders.length > 0) out.push(`${label} does not allow targeting by gender.`);
  if (rule.noDetailedInterests && t.interests.length > 0) out.push(`${label} does not allow detailed interest targeting.`);
  if (rule.noLookalikes && t.lookalikeAudienceIds.length > 0) out.push(`${label} does not allow lookalike audiences.`);
  if (t.geo.cities.some((c) => c.radiusKm < rule.minRadiusKm)) out.push(`${label} needs a location radius of at least ${rule.minRadiusKm} km.`);
  return out;
}

/** Returns targeting adjusted to what the category allows, plus a note for each change, so the UI can show it. */
export function restrictForCategory(t: Targeting, category: SpecialAdCategory): { targeting: Targeting; adjustments: string[] } {
  if (category === "none") return { targeting: t, adjustments: [] };
  const rule = SPECIAL_CATEGORY_RULES[category];
  const next: Targeting = { ...t, geo: { ...t.geo, cities: t.geo.cities.map((c) => ({ ...c })) } };
  const adjustments: string[] = [];
  if (rule.fixedAge && (t.ageMin !== rule.fixedAge.min || t.ageMax !== rule.fixedAge.max)) {
    next.ageMin = rule.fixedAge.min;
    next.ageMax = rule.fixedAge.max;
    adjustments.push(`Age reset to ${rule.fixedAge.min} to ${rule.fixedAge.max}.`);
  }
  if (rule.allGendersOnly && t.genders.length) {
    next.genders = [];
    adjustments.push("Gender targeting removed.");
  }
  if (rule.noDetailedInterests && t.interests.length) {
    next.interests = [];
    adjustments.push("Detailed interests removed.");
  }
  if (rule.noLookalikes && t.lookalikeAudienceIds.length) {
    next.lookalikeAudienceIds = [];
    adjustments.push("Lookalike audiences removed.");
  }
  for (const c of next.geo.cities) {
    if (c.radiusKm < rule.minRadiusKm) {
      c.radiusKm = rule.minRadiusKm;
      adjustments.push(`Radius raised to ${rule.minRadiusKm} km.`);
    }
  }
  return { targeting: next, adjustments: [...new Set(adjustments)] };
}

const PLACEMENT_FIELDS: Record<Placement, [string, string]> = {
  facebook_feed: ["facebook", "feed"],
  facebook_stories: ["facebook", "story"],
  facebook_reels: ["facebook", "facebook_reels"],
  instagram_feed: ["instagram", "stream"],
  instagram_stories: ["instagram", "story"],
  instagram_reels: ["instagram", "reels"],
  messenger_inbox: ["messenger", "messenger_home"],
  audience_network: ["audience_network", "classic"],
};

/** Meta targeting spec. VERIFY field names (flexible_spec, *_positions values, targeting_automation) against the current docs. */
export function toMetaTargeting(t: Targeting, category: SpecialAdCategory): Record<string, unknown> {
  const geo: Record<string, unknown> = {};
  if (t.geo.countries.length) geo.countries = t.geo.countries;
  if (t.geo.cities.length) geo.cities = t.geo.cities.map((c) => ({ key: c.key, radius: c.radiusKm, distance_unit: "kilometer" }));
  const spec: Record<string, unknown> = { geo_locations: geo, age_min: t.ageMin, age_max: t.ageMax };
  if (t.genders.length) spec.genders = t.genders.map((g) => (g === "male" ? 1 : 2));
  if (t.interests.length && category === "none") spec.flexible_spec = [{ interests: t.interests.map((i) => ({ id: i.id, name: i.name })) }];
  if (t.lookalikeAudienceIds.length && category === "none") spec.custom_audiences = t.lookalikeAudienceIds.map((id) => ({ id }));
  if (t.placements.length) {
    const platforms = new Set<string>();
    for (const p of t.placements) {
      const [platform, position] = PLACEMENT_FIELDS[p];
      platforms.add(platform);
      const key = `${platform}_positions`;
      spec[key] = [...((spec[key] as string[] | undefined) ?? []), position];
    }
    spec.publisher_platforms = [...platforms];
  }
  // VERIFY: Advantage audience flag; set to 0 so that our explicit age and gender limits are honoured.
  spec.targeting_automation = { advantage_audience: 0 };
  return spec;
}
