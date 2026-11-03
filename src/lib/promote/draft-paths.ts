/**
 * Every editable path of a promotion draft, with its tier (docs/IG-PAGE-ADS-SPEC.md 3.12, 7.5, 6.6). Pure.
 *
 * - The same map is the allowlist of Eddy's update_promotion_draft and of PATCH /api/promote/drafts/[id]: a path that is
 *   not here is refused (draft.unknown_path), and each value is parsed and bounded before it is applied.
 * - Tiers only decide what a screen shows. Switching tiers never drops a value: hidden values stay in the draft, and
 *   hiddenNonDefaults() lists the ones that differ from the defaults for the chip "2 extra settings changed · Reset".
 *   Only an explicit Reset (resetHidden) puts them back.
 * - Some values belong to a higher tier than their path (an All-settings goal, a run longer than 30 days, a manual
 *   position from All settings); valueTier() names it, so the chip also lists them.
 */
import type { Gender, SpecialAdCategory } from "@/lib/ads/types";
import { SPECIAL_CATEGORIES } from "@/lib/ads/types";
import { ALL_CTA_TYPES } from "./catalog/cta";
import { goalRow } from "./catalog/goals";
import { placementRow } from "./catalog/placements";
import type { PromoteCopyKey } from "./copy";
import { OPTED_OUT_FEATURES } from "./creative-shapes";
import { MAX_RUN_DAYS, MIN_RUN_DAYS, SIMPLE_MAX_RUN_DAYS } from "./dates";
import {
  AD_FORMATS,
  FORM_TYPES,
  isGoalKey,
  isPlacementKey,
  PLACEMENT_MODES,
  SOURCE_KINDS,
  START_MODES,
  tierRank,
  type DraftVersion,
  type GoalKey,
  type PromotionDraft,
  type Tier,
} from "./types";

export class DraftPathError extends Error {
  constructor(
    readonly code: "unknown_path" | "bad_value",
    readonly path: string,
    readonly key: PromoteCopyKey = code === "unknown_path" ? "draft.unknown_path" : "draft.bad_value",
  ) {
    super(`${code}: ${path}`);
    this.name = "DraftPathError";
  }
}

type Parse = (v: unknown, path: string) => unknown;
export type DraftPathEntry = {
  tier: Tier;
  parse: Parse;
  /** A value that only a higher tier offers (shown as a hidden chip below it). */
  valueTier?: (v: unknown) => Tier;
};

// ===== Value parsers =====

const bad = (path: string): never => {
  throw new DraftPathError("bad_value", path);
};
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const str = (max: number): Parse => (v, p) => (typeof v === "string" && v.length <= max ? v : bad(p));
const strOrNull = (max: number): Parse => (v, p) => (v === null ? null : typeof v === "string" && v.trim() && v.length <= max ? v.trim() : bad(p));
const httpsOrNull: Parse = (v, p) => (v === null || v === "" ? null : typeof v === "string" && /^https:\/\/[^\s]{3,2000}$/.test(v.trim()) ? v.trim() : bad(p));
const bool: Parse = (v, p) => (typeof v === "boolean" ? v : bad(p));
const oneOf = (values: readonly string[]): Parse => (v, p) => (typeof v === "string" && values.includes(v) ? v : bad(p));
const oneOfOrNull = (values: readonly string[]): Parse => (v, p) => (v === null ? null : oneOf(values)(v, p));
const int = (min: number, max: number): Parse => (v, p) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : bad(p));
const intOrNull = (min: number, max: number): Parse => (v, p) => (v === null ? null : int(min, max)(v, p));
const idOrNull: Parse = (v, p) => (v === null ? null : typeof v === "string" && /^[A-Za-z0-9_:.-]{1,128}$/.test(v) ? v : bad(p));
const idList = (max: number): Parse => (v, p) => (Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string" && /^[A-Za-z0-9_:.-]{1,128}$/.test(x)) ? [...new Set(v as string[])] : bad(p));

/** Money in minor units: a bigint, a safe whole number, or a string of digits (JSON has no bigint). Never negative. */
const minor: Parse = (v, p) => {
  if (typeof v === "bigint" && v >= 0n) return v;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^\d{1,18}$/.test(v)) return BigInt(v);
  return bad(p);
};
const minorOrNull: Parse = (v, p) => (v === null ? null : minor(v, p));

const isoOrNull: Parse = (v, p) => {
  if (v === null) return null;
  if (typeof v !== "string" || v.length > 40) return bad(p);
  const t = Date.parse(v);
  return Number.isNaN(t) ? bad(p) : new Date(t).toISOString();
};

const countries: Parse = (v, p) => (Array.isArray(v) && v.length >= 1 && v.length <= 25 && v.every((c) => typeof c === "string" && /^[A-Z]{2}$/.test(c)) ? [...new Set(v as string[])] : bad(p));
const genders: Parse = (v, p) => (Array.isArray(v) && v.length <= 2 && v.every((g) => g === "male" || g === "female") ? ([...new Set(v)] as Gender[]) : bad(p));
const interests: Parse = (v, p) =>
  Array.isArray(v) && v.length <= 25 && v.every((i) => isObj(i) && typeof i.id === "string" && /^\d{1,30}$/.test(i.id) && typeof i.name === "string" && i.name.length <= 100)
    ? (v as { id: string; name: string }[]).map((i) => ({ id: i.id, name: i.name }))
    : bad(p);
const shop: Parse = (v, p) => {
  if (v === null) return null;
  if (!isObj(v)) return bad(p);
  const { lat, lng, radiusKm, label } = v;
  const ok =
    typeof lat === "number" && lat >= -90 && lat <= 90 && typeof lng === "number" && lng >= -180 && lng <= 180 && typeof radiusKm === "number" && radiusKm >= 1 && radiusKm <= 50 && typeof label === "string" && label.length <= 120;
  return ok ? { lat, lng, radiusKm, label } : bad(p);
};
const iceBreakers: Parse = (v, p) =>
  Array.isArray(v) && v.length <= 3 && v.every((q) => isObj(q) && typeof q.title === "string" && q.title.trim() && q.title.length <= 80 && typeof q.response === "string" && q.response.trim() && q.response.length <= 300)
    ? (v as { title: string; response: string }[]).map((q) => ({ title: q.title, response: q.response }))
    : bad(p);
const cards: Parse = (v, p) =>
  Array.isArray(v) &&
  v.length <= 10 &&
  v.every((c) => isObj(c) && typeof c.mediaId === "string" && c.mediaId.length <= 128 && typeof c.headline === "string" && c.headline.length <= 255 && typeof c.description === "string" && c.description.length <= 255 && (c.link === null || (typeof c.link === "string" && /^https:\/\/\S+$/.test(c.link))))
    ? (v as PromotionDraft["cards"]).map((c) => ({ mediaId: c.mediaId, headline: c.headline, description: c.description, link: c.link }))
    : bad(p);
const positions: Parse = (v, p) => (Array.isArray(v) && v.length <= 20 && v.every(isPlacementKey) ? [...new Set(v)] : bad(p));
const devices: Parse = (v, p) => (Array.isArray(v) && v.length <= 2 && v.every((d) => d === "mobile" || d === "desktop") ? [...new Set(v)] : bad(p));
const destinations: Parse = (v, p) => (Array.isArray(v) && v.length <= 3 && v.every((d) => d === "whatsapp" || d === "instagram" || d === "messenger") ? [...new Set(v)] : bad(p));
const schedule: Parse = (v, p) =>
  Array.isArray(v) &&
  v.length <= 21 &&
  v.every(
    (w) =>
      isObj(w) &&
      Array.isArray(w.days) &&
      w.days.length >= 1 &&
      w.days.every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6) &&
      // Whole hours (5.4 AdSet.schedule).
      Number.isInteger(w.startMinute) &&
      Number.isInteger(w.endMinute) &&
      (w.startMinute as number) % 60 === 0 &&
      (w.endMinute as number) % 60 === 0 &&
      (w.startMinute as number) >= 0 &&
      (w.endMinute as number) <= 1440 &&
      (w.startMinute as number) < (w.endMinute as number),
  )
    ? (v as PromotionDraft["schedule"]).map((w) => ({ days: [...new Set(w.days)].sort(), startMinute: w.startMinute, endMinute: w.endMinute }))
    : bad(p);
const features: Parse = (v, p) =>
  isObj(v) && Object.entries(v).every(([k, b]) => (OPTED_OUT_FEATURES as readonly string[]).includes(k) && typeof b === "boolean") ? { ...(v as Record<string, boolean>) } : bad(p);
const goal: Parse = (v, p) => (isGoalKey(v) ? v : bad(p));

/** The youngest age a promotion may target (3.1 default 18+): no ads aimed at children (DPDP Act s.9(3), Meta's teen rules). */
export const MIN_AUDIENCE_AGE = 18;
export const MAX_AUDIENCE_AGE = 65;

/** The fields of a compared version, each with the parser of its own path. */
const VERSION_FIELDS: Readonly<Record<"text" | "media", Readonly<Record<string, Parse>>>> = {
  text: { primary: str(10_000), headline: str(255), description: str(255), link: httpsOrNull },
  media: { feed: idOrNull, vertical: idOrNull, square: idOrNull, video: idOrNull },
};
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

const emptyVersion = (): DraftVersion => ({ text: { primary: "", headline: "", description: "", link: null }, media: { feed: null, vertical: null, square: null, video: null } });

/**
 * A whole compared version: null removes it (3.8 "remove a version"); an object adds or replaces it, with missing fields
 * empty and every given field parsed as on its own path. Undo of a version's first edit replays null through here.
 */
const versionOrNull: Parse = (v, p) => {
  if (v === null) return null;
  if (!isObj(v)) return bad(p);
  const out = emptyVersion() as unknown as Record<"text" | "media", Record<string, unknown>>;
  for (const [group, values] of Object.entries(v)) {
    if (!has(VERSION_FIELDS, group) || !isObj(values)) return bad(p);
    const fields = VERSION_FIELDS[group as "text" | "media"];
    for (const [k, x] of Object.entries(values)) {
      if (!has(fields, k)) return bad(p);
      out[group as "text" | "media"][k] = fields[k](x, p);
    }
  }
  return out;
};

// ===== The map =====

const goalTier = (v: unknown): Tier => (isGoalKey(v) ? goalRow(v).tier : "simple");
const runDaysTier = (v: unknown): Tier => (typeof v === "number" && v > SIMPLE_MAX_RUN_DAYS ? "more" : "simple");
const positionsTier = (v: unknown): Tier =>
  Array.isArray(v) && v.length > 0 ? (v.filter(isPlacementKey).some((k) => placementRow(k).tier === "all") ? "all" : "more") : "simple";
const modeTier = (v: unknown): Tier => (v === "custom" ? "more" : "simple");

/** A compared version as a whole (add, replace or remove it with null) and each of its fields. */
const versionPaths = (letter: "B" | "C"): Record<string, DraftPathEntry> => ({
  [`versions.${letter}`]: { tier: "more", parse: versionOrNull },
  ...Object.fromEntries(
    (Object.entries(VERSION_FIELDS) as [string, Readonly<Record<string, Parse>>][]).flatMap(([group, fields]) =>
      Object.entries(fields).map(([k, parse]): [string, DraftPathEntry] => [`versions.${letter}.${group}.${k}`, { tier: "more", parse }]),
    ),
  ),
});

export const DRAFT_PATHS: Readonly<Record<string, DraftPathEntry>> = Object.freeze({
  // Simple: at most 5 decisions per flow (7.5), each pre-filled.
  name: { tier: "simple", parse: str(120) },
  goal: { tier: "simple", parse: goal, valueTier: goalTier },
  "source.kind": { tier: "simple", parse: oneOf(SOURCE_KINDS) },
  "source.ref": { tier: "simple", parse: idOrNull },
  alsoOtherApp: { tier: "simple", parse: bool },
  format: { tier: "simple", parse: oneOf(AD_FORMATS) },
  "text.primary": { tier: "simple", parse: str(10_000) },
  "text.headline": { tier: "simple", parse: str(255) },
  "text.link": { tier: "simple", parse: httpsOrNull },
  "media.feed": { tier: "simple", parse: idOrNull },
  "media.vertical": { tier: "simple", parse: idOrNull },
  "media.square": { tier: "simple", parse: idOrNull },
  "media.video": { tier: "simple", parse: idOrNull },
  cards: { tier: "simple", parse: cards },
  leadFormId: { tier: "simple", parse: idOrNull },
  formType: { tier: "simple", parse: oneOf(FORM_TYPES) },
  "welcome.message": { tier: "simple", parse: str(1_000) },
  "audience.mode": { tier: "simple", parse: oneOf(["meta_finds", "near_shop", "i_choose"]) },
  "audience.nearShop": { tier: "simple", parse: shop },
  "budget.dailyMinor": { tier: "simple", parse: minor },
  "run.runDays": { tier: "simple", parse: int(MIN_RUN_DAYS, MAX_RUN_DAYS), valueTier: runDaysTier },
  "placements.mode": { tier: "simple", parse: oneOf(PLACEMENT_MODES), valueTier: modeTier },
  specialAdCategory: { tier: "simple", parse: oneOf(SPECIAL_CATEGORIES) },

  // More options (3.12).
  "text.description": { tier: "more", parse: str(255) },
  ctaType: { tier: "more", parse: oneOfOrNull(ALL_CTA_TYPES) },
  "welcome.iceBreakers": { tier: "more", parse: iceBreakers },
  "audience.countries": { tier: "more", parse: countries },
  "audience.ageMin": { tier: "more", parse: int(MIN_AUDIENCE_AGE, MAX_AUDIENCE_AGE) },
  "audience.ageMax": { tier: "more", parse: intOrNull(MIN_AUDIENCE_AGE, MAX_AUDIENCE_AGE) },
  "audience.genders": { tier: "more", parse: genders },
  "audience.interests": { tier: "more", parse: interests },
  "audience.savedAudienceId": { tier: "more", parse: idOrNull },
  "audience.customAudienceIds": { tier: "more", parse: idList(20) },
  "audience.excludedAudienceIds": { tier: "more", parse: idList(20) },
  "placements.positions": { tier: "more", parse: positions, valueTier: positionsTier },
  "run.startMode": { tier: "more", parse: oneOf(START_MODES) },
  "run.startsAt": { tier: "more", parse: isoOrNull },
  urlTags: { tier: "more", parse: strOrNull(500) },
  enhancementsOptIn: { tier: "more", parse: bool },
  "compare.mode": { tier: "more", parse: oneOf(["single", "fair_split", "meta_picks"]) },
  "compare.variable": { tier: "more", parse: oneOf(["creative", "audience", "placement"]) },
  ...versionPaths("B"),
  ...versionPaths("C"),

  // All settings (PRM-18).
  optimizationGoal: { tier: "all", parse: strOrNull(64) },
  attribution: { tier: "all", parse: strOrNull(64) },
  "bid.strategy": { tier: "all", parse: oneOf(["LOWEST_COST_WITHOUT_CAP", "COST_CAP", "LOWEST_COST_WITH_BID_CAP"]) },
  "bid.amountMinor": { tier: "all", parse: minorOrNull },
  "budget.lifetimeMinor": { tier: "all", parse: minorOrNull },
  schedule: { tier: "all", parse: schedule },
  "placements.devicePlatforms": { tier: "all", parse: devices },
  "placements.softOptOut": { tier: "all", parse: bool },
  destinations: { tier: "all", parse: destinations },
  enhancementFeatures: { tier: "all", parse: features },
});

export const DRAFT_PATH_LIST: readonly string[] = Object.keys(DRAFT_PATHS);

/** True for a path on the allowlist (update_promotion_draft and the PATCH route accept nothing else). */
export const isDraftPath = (p: unknown): p is string => typeof p === "string" && Object.prototype.hasOwnProperty.call(DRAFT_PATHS, p);

/** The paths a tier shows (its own and every lower tier's). */
export function pathsForTier(tier: Tier): string[] {
  return DRAFT_PATH_LIST.filter((p) => tierRank(DRAFT_PATHS[p].tier) <= tierRank(tier));
}

// ===== Defaults =====

/** A new draft with every default of 3.1 (the service fills Page, budget and goal from the smart defaults, PRM-09). */
export function defaultDraft(goalKey: GoalKey, opts: { country?: string; dailyMinor?: bigint; name?: string } = {}): PromotionDraft {
  return {
    name: opts.name ?? "",
    goal: goalKey,
    source: { kind: "new", ref: null },
    alsoOtherApp: true,
    format: "single_image",
    text: { primary: "", headline: "", description: "", link: null },
    ctaType: null,
    welcome: { message: "", iceBreakers: [] },
    media: { feed: null, vertical: null, square: null, video: null },
    cards: [],
    leadFormId: null,
    audience: {
      mode: "meta_finds",
      countries: [opts.country ?? "IN"],
      ageMin: 18,
      ageMax: null,
      genders: [],
      interests: [],
      savedAudienceId: null,
      customAudienceIds: [],
      excludedAudienceIds: [],
      nearShop: null,
    },
    placements: { mode: "auto", positions: [], devicePlatforms: [], softOptOut: false },
    budget: { dailyMinor: opts.dailyMinor ?? 30_000n, lifetimeMinor: null },
    run: { runDays: 7, startMode: "now", startsAt: null },
    compare: { mode: "single", variable: "creative" },
    versions: { B: null, C: null },
    specialAdCategory: "none" as SpecialAdCategory,
    enhancementsOptIn: false,
    enhancementFeatures: {},
    urlTags: null,
    formType: "more_volume",
    optimizationGoal: null,
    attribution: null,
    bid: { strategy: "LOWEST_COST_WITHOUT_CAP", amountMinor: null },
    schedule: [],
    destinations: [],
  };
}

// ===== Read and apply =====

const segments = (path: string) => path.split(".");

/** The value at a path; undefined under an unset version (B or C). */
export function readPath(draft: PromotionDraft, path: string): unknown {
  if (!isDraftPath(path)) throw new DraftPathError("unknown_path", path);
  let cur: unknown = draft;
  for (const s of segments(path)) {
    if (!isObj(cur)) return undefined;
    cur = cur[s];
  }
  return cur;
}

function setIn(obj: Record<string, unknown>, segs: string[], value: unknown, path: string): Record<string, unknown> {
  const [head, ...rest] = segs;
  if (rest.length === 0) return { ...obj, [head]: value };
  let child = obj[head];
  // A compared version starts empty the first time one of its fields is set.
  if (child === null || child === undefined) child = path.startsWith("versions.") && (head === "B" || head === "C") ? emptyVersion() : {};
  if (!isObj(child)) throw new DraftPathError("bad_value", path);
  return { ...obj, [head]: setIn(child, rest, value, path) };
}

/** A new draft with one path set; refuses unknown paths and bad values (DraftPathError). The input is not changed. */
export function applyPath(draft: PromotionDraft, path: string, value: unknown): PromotionDraft {
  if (!isDraftPath(path)) throw new DraftPathError("unknown_path", path);
  const parsed = DRAFT_PATHS[path].parse(value, path);
  return setIn(draft as unknown as Record<string, unknown>, segments(path), parsed, path) as unknown as PromotionDraft;
}

/**
 * The path a value's chip and Undo use: a compared version's fields belong to the version (`versions.B`), so a version
 * counts once in the chip. Every other path is its own.
 */
export function chipPathOf(path: string): string {
  const m = /^versions\.([BC])\./.exec(path);
  return m ? `versions.${m[1]}` : path;
}

/**
 * Applies a PATCH body's `set` ({path: value}); all or nothing. Returns the new draft and the before values for Undo:
 * replaying `before` through applyPaths restores the draft. A field of a version that did not exist records the whole
 * version as null, so Undo removes the version again.
 */
export function applyPaths(draft: PromotionDraft, set: Readonly<Record<string, unknown>>): { draft: PromotionDraft; before: Record<string, unknown> } {
  let next = draft;
  const before: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(set)) {
    const version = chipPathOf(path);
    const key = version !== path && readPath(draft, version) == null ? version : path;
    const was = readPath(draft, key);
    if (!Object.prototype.hasOwnProperty.call(before, key)) before[key] = was;
    next = applyPath(next, path, value);
  }
  return { draft: next, before };
}

// ===== Hidden values (3.12, 7.5) =====

/** Structural equality over draft values (bigint, arrays, plain objects). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "bigint" || typeof b === "bigint") return typeof a === typeof b && a === b;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => sameValue(a[k], b[k]));
  }
  return (a ?? null) === (b ?? null);
}

/** The tier a path's current value needs: the path's own tier, or higher for a value only a higher tier offers. */
export function valueTier(path: string, value: unknown): Tier {
  const e = DRAFT_PATHS[path];
  if (!e) throw new DraftPathError("unknown_path", path);
  const v = e.valueTier ? e.valueTier(value) : e.tier;
  return tierRank(v) > tierRank(e.tier) ? v : e.tier;
}

export type HiddenValue = { path: string; tier: Tier };

/**
 * The values a tier does not show that differ from the defaults: the chip "{count} extra settings changed · Reset".
 * Nothing is dropped; the draft keeps them. A compared version is one entry (`versions.B`), however many of its fields
 * changed (chipPathOf).
 */
export function hiddenNonDefaults(draft: PromotionDraft, tier: Tier, defaults: PromotionDraft = defaultDraft(draft.goal)): HiddenValue[] {
  const out: HiddenValue[] = [];
  for (const path of DRAFT_PATH_LIST) {
    if (chipPathOf(path) !== path) continue;
    const value = readPath(draft, path);
    const need = valueTier(path, value);
    if (tierRank(need) <= tierRank(tier)) continue;
    if (sameValue(value, readPath(defaults, path))) continue;
    out.push({ path, tier: need });
  }
  return out;
}

/** The explicit [Reset] on the chip: hidden non-default values go back to their defaults. */
export function resetHidden(draft: PromotionDraft, tier: Tier, defaults: PromotionDraft = defaultDraft(draft.goal)): PromotionDraft {
  let next = draft;
  for (const { path } of hiddenNonDefaults(draft, tier, defaults)) {
    const d = readPath(defaults, path);
    if (path.startsWith("versions.")) {
      const letter = path.split(".")[1] as "B" | "C";
      next = { ...next, versions: { ...next.versions, [letter]: defaults.versions[letter] } };
    } else next = setIn(next as unknown as Record<string, unknown>, segments(path), d, path) as unknown as PromotionDraft;
  }
  return next;
}
