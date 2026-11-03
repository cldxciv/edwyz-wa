/**
 * Places, interests and audience size for "Who sees it" (docs/IG-PAGE-ADS-SPEC.md 3.7, 4.2 A7 to A9, 4.8, 4.9, PRM-11).
 *
 * - A7 place search: India only. A 6-digit PIN code searches postal codes (`zip`, VERIFY V-P10); any other text searches
 *   cities, postal codes and states (`city`, `zip`, `region`).
 * - "People near my shop": the shop's map pin from the promote settings becomes one custom location, 5 km around it in a city
 *   and 15 km elsewhere (the smart default of 3.1). A shop known only by its PIN code is targeted by that postal code instead.
 * - A8 interest search: Meta's `adinterest` (names, not typed ids).
 * - A9 size: only `users_lower_bound` and `users_upper_bound` are read, kept for 10 minutes per workspace, ad account and
 *   targeting, and shown as "About 1.2–1.8 lakh people" (Western digits, Indian grouping), or "Size not available right now"
 *   when Meta can't say. A failed read is never kept, so the next look asks again.
 * - Rate limits (4.8): place and interest search together 60 a minute per member, size 20 a minute per member.
 *
 * Every Meta call goes through promote/meta.ts (classified not_spend, user token, paced by throttle.ts at priority 3). No
 * personal data passes through here.
 */
import { createHash } from "node:crypto";
import { siteUrl } from "@/lib/config";
import { HttpError } from "@/lib/tenancy";
import { createLimiter } from "@/lib/ratelimit";
import { formatPeopleRange, promoteText } from "./copy";
import type { AdCtx, Interest, Place, PromoteMeta } from "./meta";
import type { PromoteLang, ShopLocation } from "./types";

// ===== Limits =====

/** How long a size answer is kept (4.9). */
export const SIZE_CACHE_MS = 10 * 60_000;
/** Size answers kept per process at most (one web instance, Phase 0 risk 13). */
export const SIZE_CACHE_MAX = 500;
/** "People near my shop" radius: 5 km in a city, 15 km elsewhere (3.1 smart defaults). */
export const SHOP_RADIUS_KM = Object.freeze({ city: 5, elsewhere: 15 });
/** A 6-digit Indian PIN code (the first digit is never 0). */
export const PINCODE = /^[1-9]\d{5}$/;
export const SEARCHES_PER_MINUTE = 60;
export const SIZES_PER_MINUTE = 20;

export const GEO_COPY = {
  tooManySearches: "That's a lot of searching in a minute. Wait a moment and try again.",
  tooManySizes: "That's a lot of size checks in a minute. Wait a moment and try again.",
  noAccount: "Choose a spending ad account in Settings > Spending limits first. Searches use that account.",
} as const;

// ===== Rate limits (4.8) =====

// The names are literals: tests/ratelimit-migration.test.ts reads every createLimiter() call for a stable, unique name.
export const searchLimiter = createLimiter(SEARCHES_PER_MINUTE, 60_000, "promote-geo-search");
export const sizeLimiter = createLimiter(SIZES_PER_MINUTE, 60_000, "promote-audience-size");

const memberKey = (actor: { tenantId: string; userId: string }) => `${actor.tenantId}:${actor.userId}`;

/**
 * Reads change nothing, but their answers are the workspace's own: another site's page may not ask for them (the same check
 * as the sources and pixel routes). Throws 403.
 */
export function refuseCrossSite(request: Request): void {
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  let foreign = site === "cross-site" || site === "same-site";
  if (!foreign && origin) {
    try {
      foreign = new URL(origin).host !== new URL(siteUrl()).host;
    } catch {
      foreign = true;
    }
  }
  if (foreign) throw new HttpError(403, "This request could not be verified. Reload the page and try again.");
}

/** Place and interest search: 60 a minute per member, shared. Throws 429. */
export function assertSearchRate(actor: { tenantId: string; userId: string }, now?: number): void {
  if (!searchLimiter.consume(memberKey(actor), now)) throw new HttpError(429, GEO_COPY.tooManySearches);
}

/** Size checks: 20 a minute per member. Throws 429. */
export function assertSizeRate(actor: { tenantId: string; userId: string }, now?: number): void {
  if (!sizeLimiter.consume(memberKey(actor), now)) throw new HttpError(429, GEO_COPY.tooManySizes);
}

// ===== Places (A7) and interests (A8) =====

export type PlaceType = "city" | "zip" | "region";
export type GeoMeta = Pick<PromoteMeta, "searchPlaces" | "searchInterests" | "estimateReach">;

/** What a search for this text asks Meta for: a PIN code looks up postal codes only. */
export function placeTypesFor(q: string): PlaceType[] {
  return PINCODE.test(q.trim()) ? ["zip"] : ["city", "zip", "region"];
}

/** A7: India's cities, PIN codes and states matching the text. */
export async function searchPlaces(meta: Pick<GeoMeta, "searchPlaces">, ctx: AdCtx, q: unknown): Promise<Place[]> {
  const text = typeof q === "string" ? q.trim() : "";
  return meta.searchPlaces(ctx, text, { types: placeTypesFor(text), countryCode: "IN" });
}

/** A8: interests matching the text. */
export async function searchInterests(meta: Pick<GeoMeta, "searchInterests">, ctx: AdCtx, q: unknown): Promise<Interest[]> {
  return meta.searchInterests(ctx, typeof q === "string" ? q.trim() : "");
}

// ===== "People near my shop" =====

/**
 * Cities with a million people or more (Census 2011 urban agglomerations), plus their other names, lowercase. A shop label
 * that names one is "in a city" for the radius default; the member can still move the slider (1 to 50 km).
 */
export const INDIAN_CITIES: readonly string[] = [
  "mumbai", "bombay", "navi mumbai", "thane", "delhi", "new delhi", "noida", "greater noida", "gurugram", "gurgaon", "ghaziabad", "faridabad",
  "kolkata", "calcutta", "howrah", "chennai", "madras", "bengaluru", "bangalore", "hyderabad", "secunderabad", "ahmedabad", "pune",
  "pimpri", "chinchwad", "surat", "jaipur", "kanpur", "lucknow", "nagpur", "indore", "coimbatore", "kochi", "cochin", "ernakulam",
  "patna", "kozhikode", "calicut", "bhopal", "thrissur", "vadodara", "baroda", "agra", "visakhapatnam", "vizag", "malappuram",
  "thiruvananthapuram", "trivandrum", "kannur", "ludhiana", "nashik", "vijayawada", "madurai", "varanasi", "meerut", "rajkot",
  "jamshedpur", "srinagar", "jabalpur", "asansol", "vasai", "virar", "prayagraj", "allahabad", "dhanbad", "aurangabad",
  "amritsar", "jodhpur", "ranchi", "raipur", "kollam", "gwalior", "bhilai", "durg", "chandigarh", "mohali", "tiruchirappalli",
  "trichy", "kota", "bhubaneswar", "guwahati", "mysuru", "mysore", "dehradun",
];

/** Whether a place's name or label names a city of INDIAN_CITIES (whole words, any case). */
export function namesCity(label: unknown): boolean {
  if (typeof label !== "string" || !label.trim()) return false;
  const words = ` ${label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
  return INDIAN_CITIES.some((city) => words.includes(` ${city} `));
}

/** The default radius around the shop: 5 km in a city, 15 km elsewhere. */
export function shopRadiusKm(inCity: boolean): number {
  return inCity ? SHOP_RADIUS_KM.city : SHOP_RADIUS_KM.elsewhere;
}

export type ShopSetting = { lat: number | null; lng: number | null; label: string | null; pincode: string | null };

/**
 * The "People near my shop" pin from the stored shop (promote settings): a custom location with the default radius. `inCity`,
 * when the caller knows (a city picked in search), wins over the label. Null without a map pin: the caller then targets the
 * shop's PIN code (`zips`, found through searchPlaces).
 */
export function shopLocation(shop: ShopSetting | null | undefined, options: { inCity?: boolean } = {}): ShopLocation | null {
  if (!shop || typeof shop.lat !== "number" || typeof shop.lng !== "number" || !Number.isFinite(shop.lat) || !Number.isFinite(shop.lng)) return null;
  if (shop.lat < -90 || shop.lat > 90 || shop.lng < -180 || shop.lng > 180) return null;
  const inCity = options.inCity ?? namesCity(shop.label);
  const label = (shop.label ?? "").trim().slice(0, 120) || (shop.pincode ? `PIN ${shop.pincode}` : "My shop");
  return { lat: shop.lat, lng: shop.lng, radiusKm: shopRadiusKm(inCity), label };
}

// ===== Size (A9) =====

export type AudienceSize = {
  lower: number | null;
  upper: number | null;
  /** "About 1.2–1.8 lakh people", or "Size not available right now". */
  line: string;
  /** The answer came from the 10-minute cache. */
  cached: boolean;
};

/** The size line of 3.7. Both bounds are needed; anything else reads "Size not available right now". */
export function sizeLine(lower: number | null | undefined, upper: number | null | undefined, lang: PromoteLang = "en"): string {
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
  if (!ok(lower) || !ok(upper) || upper < lower) return promoteText("audience.size_unknown", {}, lang);
  return promoteText("audience.size", { range: formatPeopleRange(lower, upper, lang) }, lang);
}

/** JSON with sorted keys, so the same targeting written in another order shares a cache entry. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

type SizeEntry = { at: number; lower: number; upper: number };

/** The 10-minute size cache: an LRU of at most SIZE_CACHE_MAX answers. */
export class SizeCache {
  private readonly entries = new Map<string, SizeEntry>();
  constructor(
    private readonly ttlMs = SIZE_CACHE_MS,
    private readonly max = SIZE_CACHE_MAX,
  ) {}

  static key(ctx: AdCtx, targeting: Record<string, unknown>): string {
    return `${ctx.tenantId}:${ctx.adAccountAssetId}:${createHash("sha256").update(canonical(targeting)).digest("hex")}`;
  }

  get(key: string, now: number): SizeEntry | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (now - entry.at >= this.ttlMs || now < entry.at) {
      this.entries.delete(key);
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key: string, entry: SizeEntry): void {
    this.entries.delete(key);
    while (this.entries.size >= this.max) this.entries.delete(this.entries.keys().next().value as string);
    this.entries.set(key, entry);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export const sizeCache = new SizeCache();

export type SizeDeps = { meta: Pick<GeoMeta, "estimateReach">; now: () => number; cache: SizeCache; lang?: PromoteLang };

/**
 * A9: how many people a Meta targeting spec reaches, from the cache when it was asked in the last 10 minutes. A refusal of
 * the targeting itself (400) is passed on; anything else Meta can't answer reads "Size not available right now".
 */
export async function audienceSize(ctx: AdCtx, targeting: Record<string, unknown>, deps: SizeDeps): Promise<AudienceSize> {
  const key = SizeCache.key(ctx, targeting);
  const hit = deps.cache.get(key, deps.now());
  if (hit) return { lower: hit.lower, upper: hit.upper, line: sizeLine(hit.lower, hit.upper, deps.lang), cached: true };
  let lower: number | null = null;
  let upper: number | null = null;
  try {
    const r = await deps.meta.estimateReach(ctx, targeting);
    lower = r.lower;
    upper = r.upper;
  } catch (error) {
    if (error instanceof HttpError && error.status === 400) throw error;
    return { lower: null, upper: null, line: sizeLine(null, null, deps.lang), cached: false };
  }
  const known = typeof lower === "number" && typeof upper === "number" && lower > 0 && upper >= lower;
  if (known) deps.cache.set(key, { at: deps.now(), lower: lower as number, upper: upper as number });
  return known ? { lower, upper, line: sizeLine(lower, upper, deps.lang), cached: false } : { lower: null, upper: null, line: sizeLine(null, null, deps.lang), cached: false };
}
