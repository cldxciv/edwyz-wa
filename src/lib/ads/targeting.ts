import { placementProblems, placementProblemText, placementRow, type PlacementProblemCode } from "@/lib/promote/catalog/placements";
import { promoteText } from "@/lib/promote/copy";
import type { AdFormat, FormType, GoalKey } from "@/lib/promote/types";
import { PLACEMENTS, type CustomLocation, type GeoCity, type GeoZip, type Gender, type Interest, type Placement, type SpecialAdCategory, type Targeting } from "./types";

export const AGE_MIN = 13;
export const AGE_MAX = 65;
export const MAX_INTERESTS = 25;
export const MAX_COUNTRIES = 25;
export const MAX_CITIES = 25;
export const MAX_CUSTOM_LOCATIONS = 25;
export const MAX_ZIPS = 50;
/** Audiences to include, and audiences to leave out, per ad set (the same bound as promote/draft-paths.ts). */
export const MAX_AUDIENCES = 20;
/** Meta takes a pin radius of 1 to 80 km (0.63 to 50 miles). VERIFY V-P1. */
export const PIN_RADIUS_KM = { min: 1, max: 80 } as const;

/** The copy for an old row that still holds messenger_inbox (4.5, promote copy placement.rule.messenger_changed). */
export const MESSENGER_CHANGED = "Pick where your ad shows again: Meta changed Messenger placements";

/**
 * Audiences (5.4, D17): every id in an ad set is an AdAudience id that the caller resolves to a Meta id at launch. The caller
 * builds that map (audienceMetaIds) from a tenant-scoped query of the workspace's own AdAudience rows that are ready,
 * consented and allowed by PROMOTE_AUDIENCES and LEGAL_DPDP_AUDIENCES_OK. No id is ever sent as typed, so one workspace
 * can't use another's list on a shared ad account.
 */
export const AUDIENCES_NOT_HERE = "Saved audiences can't be used in this campaign. Remove them, then try again.";
export const AUDIENCE_NOT_READY = "An audience isn't ready to use. Wait until it shows Ready, or remove it.";

/** The country Meta is told a special-category ad runs in when the targeting names none (4.3, VERIFY V-P1). */
export const DEFAULT_SPECIAL_CATEGORY_COUNTRY = "IN";

export type CategoryRule = {
  /** Meta's special_ad_categories enum value. */
  metaValue: string;
  fixedAge: { min: number; max: number } | null;
  allGendersOnly: boolean;
  noDetailedInterests: boolean;
  noLookalikes: boolean;
  /** No customer lists or other custom audiences, to include or to leave out, and no audience expansion. */
  noCustomAudiences: boolean;
  /** No postal codes. */
  noZips: boolean;
  /** Minimum radius for city or point targeting, in kilometres. */
  minRadiusKm: number;
};

/*
 * VERIFY against Meta's current "Special Ad Categories" policy before launch and per country.
 * Meta's published rule for housing, employment and credit ads in the US and Canada: no targeting by age, gender or
 * ZIP code, no detailed targeting that describes or implies protected traits, no lookalike audiences (replaced by
 * Special Ad Audiences), minimum 15-mile radius for location targeting (24.1 km, so 25 km in whole kilometres). Other countries and the social
 * issues category differ. These values are deliberately conservative and applied to every country: custom audiences and
 * Advantage+ audience expansion are removed as well (D9, D17).
 */
const STRICT = { fixedAge: { min: 18, max: AGE_MAX }, allGendersOnly: true, noDetailedInterests: true, noLookalikes: true, noCustomAudiences: true, noZips: true, minRadiusKm: 25 } as const;
export const SPECIAL_CATEGORY_RULES: Record<Exclude<SpecialAdCategory, "none">, CategoryRule> = {
  housing: { metaValue: "HOUSING", ...STRICT },
  employment: { metaValue: "EMPLOYMENT", ...STRICT },
  credit: { metaValue: "CREDIT", ...STRICT },
  // VERIFY: ISSUES_ELECTIONS_POLITICS also needs advertiser authorization (identity verification) that this product does not handle.
  social_issues: { metaValue: "ISSUES_ELECTIONS_POLITICS", ...STRICT },
};

export function metaSpecialCategories(category: SpecialAdCategory): string[] {
  return category === "none" ? [] : [SPECIAL_CATEGORY_RULES[category].metaValue];
}

export const emptyTargeting = (): Targeting => ({ geo: { countries: [], cities: [] }, ageMin: AGE_MIN, ageMax: AGE_MAX, genders: [], interests: [], placements: [], lookalikeAudienceIds: [] });

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean).slice(0, max) : []);
const unique = (v: string[]) => [...new Set(v)];

/**
 * Coerces untrusted JSON into the Targeting shape. Does not judge it; call validateTargeting for that. The optional fields
 * (pins, postal codes, audiences, "Let Meta find people") are added only when present, so old rows keep their exact shape.
 * Lists of the new fields keep one item over their limit, so validation can say so instead of dropping a choice silently.
 */
export function parseTargeting(raw: unknown): Targeting {
  const o = isObj(raw) ? raw : {};
  const geo = isObj(o.geo) ? o.geo : {};
  const cities: GeoCity[] = Array.isArray(geo.cities)
    ? geo.cities.filter(isObj).map((c) => ({ key: String(c.key ?? "").trim(), name: typeof c.name === "string" ? c.name.slice(0, 100) : undefined, radiusKm: Number(c.radiusKm) })).slice(0, MAX_CITIES)
    : [];
  const interests: Interest[] = Array.isArray(o.interests)
    ? o.interests.filter(isObj).map((i) => ({ id: String(i.id ?? "").trim(), name: String(i.name ?? "").slice(0, 100) })).slice(0, MAX_INTERESTS + 1)
    : [];
  const pins: CustomLocation[] = Array.isArray(geo.customLocations)
    ? geo.customLocations
        .filter(isObj)
        .map((c) => ({ lat: Number(c.lat), lng: Number(c.lng), radiusKm: Number(c.radiusKm), ...(typeof c.label === "string" ? { label: c.label.slice(0, 120) } : {}) }))
        .slice(0, MAX_CUSTOM_LOCATIONS + 1)
    : [];
  const zips: GeoZip[] = Array.isArray(geo.zips)
    ? geo.zips
        .filter(isObj)
        .map((z) => ({ key: String(z.key ?? "").trim(), ...(typeof z.name === "string" ? { name: z.name.slice(0, 100) } : {}) }))
        .slice(0, MAX_ZIPS + 1)
    : [];
  const included = unique(strings(o.customAudienceIds, MAX_AUDIENCES + 1));
  const excluded = unique(strings(o.excludedAudienceIds, MAX_AUDIENCES + 1));
  const out: Targeting = {
    geo: { countries: strings(geo.countries, MAX_COUNTRIES).map((c) => c.toUpperCase()), cities },
    ageMin: Number(o.ageMin ?? AGE_MIN),
    ageMax: Number(o.ageMax ?? AGE_MAX),
    genders: strings(o.genders, 2) as Gender[],
    interests,
    placements: strings(o.placements, PLACEMENTS.length) as Placement[],
    lookalikeAudienceIds: strings(o.lookalikeAudienceIds, 10),
  };
  if (pins.length) out.geo.customLocations = pins;
  if (zips.length) out.geo.zips = zips;
  if (included.length) out.customAudienceIds = included;
  if (excluded.length) out.excludedAudienceIds = excluded;
  if (o.advantageAudience === true) out.advantageAudience = true;
  return out;
}

export type TargetingResult = { ok: boolean; errors: string[] };

/**
 * What the caller knows about the ad set. Without a goal, only the 4.5 rules that hold for every goal run, the format counts
 * as a picture (the old wizard has no video), and the Instagram account rule is skipped (the old wizard never had it).
 * Without audienceMetaIds no audience can be used (the old wizard's route resolves none).
 */
export type TargetingCheck = {
  goal?: GoalKey;
  format?: AdFormat;
  /** For an existing post: whether it is a video (in-stream video takes videos only). */
  mediaKind?: "image" | "video";
  hasInstagramIdentity?: boolean;
  formType?: FormType;
  /** Placements still marked VERIFY in 4.5 (Threads, WhatsApp Status, Instagram profile reels) are refused until V-P14 passes. */
  allowUnverifiedPlacements?: boolean;
  /** AdAudience id to Meta audience id, built by the caller from the workspace's usable audiences. */
  audienceMetaIds?: Readonly<Record<string, string>>;
};

/** Rules of placementProblems() that depend on the goal: skipped when the caller names none. */
const GOAL_RULES: ReadonlySet<PlacementProblemCode> = new Set(["instagram_only", "app_only", "no_right_column_messenger", "not_for_goal", "whatsapp_status_goal", "higher_intent_feeds_only"]);

/**
 * The 4.5 cross rules over a placement selection, as plain copy (promote/catalog/placements.ts placementProblems, blocking
 * ones only): a companion that is missing (Threads without Instagram Feed, Facebook Stories alone), Apps and sites outside
 * Meta alone, in-stream video without a video, and, with a goal, the goal's apps. messenger_inbox and unknown keys are
 * reported by validateTargeting itself.
 */
export function placementErrors(placements: readonly string[], check: TargetingCheck = {}): string[] {
  const known = placements.filter((p): p is Placement => (PLACEMENTS as readonly string[]).includes(p) && p !== "messenger_inbox");
  const out: string[] = [];
  if (!check.allowUnverifiedPlacements) {
    for (const key of known) {
      const row = placementRow(key);
      if (row.state === "verify") out.push(`${promoteText(row.nameKey)} isn't available yet. Pick another place for your ad.`);
    }
  }
  const problems = placementProblems(known, {
    goal: check.goal ?? "website_visits",
    format: check.format ?? "single_image",
    mediaKind: check.mediaKind,
    formType: check.formType,
    hasInstagramIdentity: check.hasInstagramIdentity ?? true,
    hasVerticalAsset: true,
  });
  for (const p of problems) {
    if (p.severity !== "block" || p.code === "messenger_changed") continue;
    if (!check.goal && GOAL_RULES.has(p.code)) continue;
    out.push(placementProblemText(p));
  }
  return [...new Set(out)];
}

/** Every audience id of an ad set: lookalikes, people to include and people to leave out. */
export const audienceIdsOf = (t: Targeting): string[] => unique([...t.lookalikeAudienceIds, ...(t.customAudienceIds ?? []), ...(t.excludedAudienceIds ?? [])]);

const resolvable = (id: string, map: Readonly<Record<string, string>>) => Object.prototype.hasOwnProperty.call(map, id) && /^\d+$/.test(map[id] ?? "");

/**
 * What stops the ad set's audiences, in plain copy: every id must be a key of audienceMetaIds that maps to a Meta id. The
 * same check toMetaTargeting throws on, so validation says it before anything is created on Meta. A special category
 * sends no audiences (categoryViolations reports them instead).
 */
export function audienceProblems(t: Targeting, category: SpecialAdCategory, audienceMetaIds?: Readonly<Record<string, string>>): string[] {
  if (category !== "none") return [];
  const ids = audienceIdsOf(t);
  if (ids.length === 0) return [];
  if (!audienceMetaIds) return [AUDIENCES_NOT_HERE];
  return ids.every((id) => resolvable(id, audienceMetaIds)) ? [] : [AUDIENCE_NOT_READY];
}

/** The countries a special-category ad runs in (special_ad_category_country): the targeted countries and the postal codes' countries. */
export function targetedCountries(t: Targeting): string[] {
  const fromZips = (t.geo.zips ?? []).map((z) => /^([A-Za-z]{2}):/.exec(z.key)?.[1]?.toUpperCase()).filter((c): c is string => !!c);
  return unique([...t.geo.countries.map((c) => c.trim().toUpperCase()), ...fromZips].filter((c) => /^[A-Z]{2}$/.test(c)));
}

const validPin = (p: CustomLocation) => Number.isFinite(p.lat) && p.lat >= -90 && p.lat <= 90 && Number.isFinite(p.lng) && p.lng >= -180 && p.lng <= 180;

export function validateTargeting(t: Targeting, category: SpecialAdCategory, check: TargetingCheck = {}): TargetingResult {
  const errors: string[] = [];
  const { countries, cities } = t.geo;
  const pins = t.geo.customLocations ?? [];
  const zips = t.geo.zips ?? [];
  if (countries.length === 0 && cities.length === 0 && pins.length === 0 && zips.length === 0) errors.push("Choose at least one country or city.");
  if (countries.some((c) => !/^[A-Z]{2}$/.test(c))) errors.push("Countries must be two-letter ISO codes.");
  for (const c of cities) {
    if (!c.key) errors.push("Every city needs a Meta location key.");
    // Meta accepts a city radius of 10 to 50 miles (17 to 80 km, the same range the wizard offers).
    if (!Number.isFinite(c.radiusKm) || c.radiusKm < 17 || c.radiusKm > 80) errors.push("City radius must be between 17 and 80 km.");
  }
  if (pins.length > MAX_CUSTOM_LOCATIONS) errors.push(`Choose at most ${MAX_CUSTOM_LOCATIONS} places on the map.`);
  if (pins.some((p) => !validPin(p))) errors.push("A place on the map has no valid position. Pick it on the map again.");
  if (pins.some((p) => !Number.isFinite(p.radiusKm) || p.radiusKm < PIN_RADIUS_KM.min || p.radiusKm > PIN_RADIUS_KM.max)) {
    errors.push(`The distance around a place must be between ${PIN_RADIUS_KM.min} and ${PIN_RADIUS_KM.max} km.`);
  }
  if (zips.length > MAX_ZIPS) errors.push(`Choose at most ${MAX_ZIPS} postal codes.`);
  if (zips.some((z) => !z.key)) errors.push("Every postal code needs a Meta location key. Pick it from the search again.");
  if (!Number.isInteger(t.ageMin) || !Number.isInteger(t.ageMax) || t.ageMin < AGE_MIN || t.ageMax > AGE_MAX || t.ageMin > t.ageMax) {
    errors.push(`Age must be a whole range between ${AGE_MIN} and ${AGE_MAX}.`);
  }
  if (t.genders.some((g) => g !== "male" && g !== "female")) errors.push("Genders must be male or female.");
  if (t.interests.length > MAX_INTERESTS) errors.push(`Choose at most ${MAX_INTERESTS} interests.`);
  if (t.interests.some((i) => !/^\d+$/.test(i.id))) errors.push("Every interest needs a numeric Meta interest id.");
  const included = t.customAudienceIds ?? [];
  const excluded = t.excludedAudienceIds ?? [];
  if (included.length > MAX_AUDIENCES || excluded.length > MAX_AUDIENCES) errors.push(`Choose at most ${MAX_AUDIENCES} audiences to include and ${MAX_AUDIENCES} to leave out.`);
  if (included.some((id) => excluded.includes(id))) errors.push("An audience can't be both included and left out. Remove it from one list.");
  // Old rows keep parsing with messenger_inbox, but Meta changed Messenger placements, so it is never sent (4.5, D10).
  if (t.placements.includes("messenger_inbox")) errors.push(MESSENGER_CHANGED);
  if (t.placements.some((p) => !(PLACEMENTS as readonly string[]).includes(p))) errors.push("Unknown placement.");
  errors.push(...placementErrors(t.placements, check));
  errors.push(...audienceProblems(t, category, check.audienceMetaIds));
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
  if (rule.noCustomAudiences && ((t.customAudienceIds ?? []).length > 0 || (t.excludedAudienceIds ?? []).length > 0)) out.push(`${label} does not allow custom audiences.`);
  if (rule.noZips && (t.geo.zips ?? []).length > 0) out.push(`${label} does not allow targeting by postal code.`);
  const small = (r: number) => r < rule.minRadiusKm;
  if (t.geo.cities.some((c) => small(c.radiusKm)) || (t.geo.customLocations ?? []).some((p) => small(p.radiusKm))) out.push(`${label} needs a location radius of at least ${rule.minRadiusKm} km.`);
  return out;
}

/** Returns targeting adjusted to what the category allows, plus a note for each change, so the UI can show it. */
export function restrictForCategory(t: Targeting, category: SpecialAdCategory): { targeting: Targeting; adjustments: string[] } {
  if (category === "none") return { targeting: t, adjustments: [] };
  const rule = SPECIAL_CATEGORY_RULES[category];
  const next: Targeting = { ...t, geo: { ...t.geo, cities: t.geo.cities.map((c) => ({ ...c })) } };
  if (t.geo.customLocations) next.geo.customLocations = t.geo.customLocations.map((p) => ({ ...p }));
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
  if (rule.noCustomAudiences) {
    if ((t.customAudienceIds ?? []).length || (t.excludedAudienceIds ?? []).length) adjustments.push("Custom audiences removed.");
    delete next.customAudienceIds;
    delete next.excludedAudienceIds;
    // Advantage+ audience would reach past the limits above, so it is off too (D9).
    if (t.advantageAudience) adjustments.push("'Let Meta find people' turned off.");
    delete next.advantageAudience;
  }
  if (rule.noZips && (t.geo.zips ?? []).length) {
    delete next.geo.zips;
    adjustments.push("Postal codes removed. Use a city or a place on the map instead.");
  }
  for (const c of [...next.geo.cities, ...(next.geo.customLocations ?? [])]) {
    if (c.radiusKm < rule.minRadiusKm) {
      c.radiusKm = rule.minRadiusKm;
      adjustments.push(`Radius raised to ${rule.minRadiusKm} km.`);
    }
  }
  return { targeting: next, adjustments: [...new Set(adjustments)] };
}

/**
 * Meta's app and position for each placement key of 4.5 (promote/catalog/placements.ts holds the same table; a test checks
 * they agree). null: the key parses but is never sent. Explore, video_feeds and Messenger story have no key at all (D10).
 */
export const PLACEMENT_FIELDS: Readonly<Record<Placement, readonly [string, string] | null>> = {
  facebook_feed: ["facebook", "feed"],
  facebook_stories: ["facebook", "story"],
  facebook_reels: ["facebook", "facebook_reels"],
  instagram_feed: ["instagram", "stream"],
  instagram_stories: ["instagram", "story"],
  instagram_reels: ["instagram", "reels"],
  // Not in Meta's current docs (V-P14): old rows parse, validation refuses them, and messenger_home is never sent.
  messenger_inbox: null,
  audience_network: ["audience_network", "classic"],
  instagram_profile_feed: ["instagram", "profile_feed"],
  instagram_profile_reels: ["instagram", "profile_reels"],
  instagram_explore_home: ["instagram", "explore_home"],
  instagram_search: ["instagram", "ig_search"],
  facebook_profile_feed: ["facebook", "profile_feed"],
  facebook_marketplace: ["facebook", "marketplace"],
  facebook_search: ["facebook", "search"],
  facebook_instream_video: ["facebook", "instream_video"],
  facebook_right_column: ["facebook", "right_hand_column"],
  threads_stream: ["threads", "threads_stream"],
  // VERIFY V-P14: the field name for WhatsApp Status positions.
  whatsapp_status: ["whatsapp", "status"],
};

/** Positions that are never sent, whatever the input (D10): Explore errors on v26, video_feeds is gone, Messenger story is dropped. */
export const NEVER_SENT_POSITIONS: ReadonlySet<string> = new Set(["instagram/explore", "facebook/video_feeds", "messenger/story", "messenger/messenger_home"]);

export type MetaTargetingOptions = {
  /**
   * AdAudience id to Meta audience id, for lookalikeAudienceIds, customAudienceIds and excludedAudienceIds. Every id must be
   * a key here; nothing passes through as typed, even an all-digit one (5.4). audienceProblems reports the same first.
   */
  audienceMetaIds?: Readonly<Record<string, string>>;
};

/** Meta ids for the audiences of an ad set. An id the caller did not resolve is refused, so no id reaches Meta unchecked. */
function metaAudienceIds(ids: readonly string[] | undefined, opts: MetaTargetingOptions): string[] {
  const out: string[] = [];
  const map = opts.audienceMetaIds;
  for (const id of ids ?? []) {
    if (!map) throw new RangeError(AUDIENCES_NOT_HERE);
    if (!resolvable(id, map)) throw new RangeError(AUDIENCE_NOT_READY);
    if (!out.includes(map[id])) out.push(map[id]);
  }
  return out;
}

/**
 * Meta targeting spec (4.3). VERIFY field names (flexible_spec, *_positions values, custom_locations, zips, targeting_automation)
 * against the current docs.
 * - A special category sends no interests, lookalikes, custom audiences or postal codes, and advantage_audience 0 (D9).
 * - "Let Meta find people" sends advantage_audience 1 and no age_max; otherwise 0, so the age and gender limits hold.
 * - Facebook Stories without Facebook Feed runs on phones only (device_platforms).
 */
export function toMetaTargeting(t: Targeting, category: SpecialAdCategory, opts: MetaTargetingOptions = {}): Record<string, unknown> {
  const special = category !== "none";
  const geo: Record<string, unknown> = {};
  if (t.geo.countries.length) geo.countries = t.geo.countries;
  if (t.geo.cities.length) geo.cities = t.geo.cities.map((c) => ({ key: c.key, radius: c.radiusKm, distance_unit: "kilometer" }));
  const pins = t.geo.customLocations ?? [];
  if (pins.length) geo.custom_locations = pins.map((p) => ({ latitude: p.lat, longitude: p.lng, radius: p.radiusKm, distance_unit: "kilometer" }));
  const zips = special ? [] : (t.geo.zips ?? []);
  if (zips.length) geo.zips = zips.map((z) => ({ key: z.key }));
  const advantage = t.advantageAudience === true && !special;
  const spec: Record<string, unknown> = { geo_locations: geo, age_min: t.ageMin };
  // Under Advantage+ audience Meta treats the upper age as a suggestion, so it is left out (4.3).
  if (!advantage) spec.age_max = t.ageMax;
  if (t.genders.length) spec.genders = t.genders.map((g) => (g === "male" ? 1 : 2));
  if (t.interests.length && !special) spec.flexible_spec = [{ interests: t.interests.map((i) => ({ id: i.id, name: i.name })) }];
  if (!special) {
    const lookalikes = metaAudienceIds(t.lookalikeAudienceIds, opts);
    const custom = metaAudienceIds(t.customAudienceIds, opts).filter((id) => !lookalikes.includes(id));
    const included = [...lookalikes, ...custom];
    if (included.length) spec.custom_audiences = included.map((id) => ({ id }));
    const excluded = metaAudienceIds(t.excludedAudienceIds, opts);
    if (excluded.length) spec.excluded_custom_audiences = excluded.map((id) => ({ id }));
  }
  if (t.placements.length) {
    const platforms: string[] = [];
    for (const p of t.placements) {
      const field = PLACEMENT_FIELDS[p];
      // A hidden or unknown key is never sent; validateTargeting refuses it before launch.
      if (!field) continue;
      const [platform, position] = field;
      if (NEVER_SENT_POSITIONS.has(`${platform}/${position}`)) continue;
      if (!platforms.includes(platform)) platforms.push(platform);
      const key = `${platform}_positions`;
      const list = (spec[key] as string[] | undefined) ?? [];
      if (!list.includes(position)) spec[key] = [...list, position];
    }
    if (platforms.length) spec.publisher_platforms = platforms;
    if (t.placements.includes("facebook_stories") && !t.placements.includes("facebook_feed")) spec.device_platforms = ["mobile"];
  }
  // Always explicit (D9): 1 only for "Let Meta find people" without a special category.
  spec.targeting_automation = { advantage_audience: advantage ? 1 : 0 };
  return spec;
}
