import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * docs/IG-PAGE-ADS-SPEC.md 3.7, 4.2 A7 to A9, 4.8 and PRM-11 acceptance 4 and 5 (promote-geo): a PIN code search asks Meta for
 * postal codes (zip), the shop radius is 5 km in a city and 15 km elsewhere, the size line reads "About 1.2–1.8 lakh people"
 * (or "Size not available right now"), and the 10-minute cache makes one fetch for two looks. The routes are admin only,
 * hidden while PROMOTE_ENABLED is off, and rate limited (60 searches and 20 sizes a minute per member). Meta is a fake.
 */
const h = vi.hoisted(() => ({
  getActor: vi.fn(),
  db: {
    spendControl: { findUnique: vi.fn() },
    metaAsset: { findFirst: vi.fn() },
    adAudience: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
    auditLog: { create: vi.fn() },
    user: { findUnique: vi.fn() },
  },
  meta: { searchPlaces: vi.fn(), searchInterests: vi.fn(), estimateReach: vi.fn() },
}));
vi.mock("@/lib/auth", () => ({ getActor: (...a: unknown[]) => h.getActor(...a) }));
vi.mock("@/lib/db", () => ({ prisma: h.db }));
vi.mock("@/lib/promote/meta", () => ({ promoteMeta: h.meta }));

import { HttpError } from "@/lib/tenancy";
import {
  assertSearchRate,
  assertSizeRate,
  audienceSize,
  GEO_COPY,
  namesCity,
  placeTypesFor,
  SEARCHES_PER_MINUTE,
  searchInterests,
  searchPlaces,
  SHOP_RADIUS_KM,
  shopLocation,
  shopRadiusKm,
  SIZE_CACHE_MS,
  SizeCache,
  sizeLine,
  SIZES_PER_MINUTE,
} from "@/lib/promote/geo";

const NOW = Date.parse("2026-10-31T10:00:00Z");
const CTX = { tenantId: "t1", adAccountAssetId: "acc" };
const SPEC = { geo_locations: { countries: ["IN"] }, age_min: 18, age_max: 65, targeting_automation: { advantage_audience: 0 } };

describe("place search (A7)", () => {
  it("a 6-digit PIN code searches postal codes (zip) only; other text searches cities, PIN codes and states, in India", async () => {
    const meta = { searchPlaces: vi.fn(async () => [{ key: "IN:110001", name: "110001", type: "zip", region: "Delhi", countryCode: "IN" }]) };
    expect(placeTypesFor("110001")).toEqual(["zip"]);
    expect(placeTypesFor(" 400053 ")).toEqual(["zip"]);
    expect(placeTypesFor("Pune")).toEqual(["city", "zip", "region"]);
    // Not a PIN code: too short, or starting with 0.
    expect(placeTypesFor("11000")).toEqual(["city", "zip", "region"]);
    expect(placeTypesFor("011000")).toEqual(["city", "zip", "region"]);

    const places = await searchPlaces(meta, CTX, "110001");
    expect(places[0]).toMatchObject({ key: "IN:110001", type: "zip" });
    expect(meta.searchPlaces).toHaveBeenLastCalledWith(CTX, "110001", { types: ["zip"], countryCode: "IN" });
    await searchPlaces(meta, CTX, "  Pune ");
    expect(meta.searchPlaces).toHaveBeenLastCalledWith(CTX, "Pune", { types: ["city", "zip", "region"], countryCode: "IN" });
  });

  it("interest search (A8) passes the text to adinterest", async () => {
    const meta = { searchInterests: vi.fn(async () => [{ id: "6003139266461", name: "Yoga", audienceLow: 1, audienceHigh: 2, path: [] }]) };
    expect(await searchInterests(meta, CTX, " yoga ")).toHaveLength(1);
    expect(meta.searchInterests).toHaveBeenCalledWith(CTX, "yoga");
  });
});

describe("People near my shop", () => {
  it("5 km around the pin in a city, 15 km elsewhere", () => {
    expect(SHOP_RADIUS_KM).toEqual({ city: 5, elsewhere: 15 });
    expect(shopRadiusKm(true)).toBe(5);
    expect(shopRadiusKm(false)).toBe(15);
    const city = shopLocation({ lat: 19.1197, lng: 72.8468, label: "Sharma Sweets, Andheri West, Mumbai", pincode: "400053" });
    expect(city).toEqual({ lat: 19.1197, lng: 72.8468, radiusKm: 5, label: "Sharma Sweets, Andheri West, Mumbai" });
    const town = shopLocation({ lat: 28.81, lng: 79.03, label: "Main Road, Rampur", pincode: "244901" });
    expect(town?.radiusKm).toBe(15);
    // What the caller knows wins over the label: a city picked in search, or a member saying it isn't one.
    expect(shopLocation({ lat: 28.81, lng: 79.03, label: "Main Road, Rampur", pincode: null }, { inCity: true })?.radiusKm).toBe(5);
    expect(shopLocation({ lat: 19.1, lng: 72.8, label: "Mumbai", pincode: null }, { inCity: false })?.radiusKm).toBe(15);
  });

  it("names a city by whole words only, and needs a valid pin", () => {
    expect(namesCity("New Delhi 110001")).toBe(true);
    expect(namesCity("BENGALURU")).toBe(true);
    expect(namesCity("Delhiwala Store")).toBe(false);
    expect(namesCity(null)).toBe(false);
    expect(shopLocation({ lat: null, lng: null, label: "Mumbai", pincode: "400053" })).toBeNull();
    expect(shopLocation({ lat: 95, lng: 72, label: "x", pincode: null })).toBeNull();
    expect(shopLocation(null)).toBeNull();
    expect(shopLocation({ lat: 12.97, lng: 77.59, label: null, pincode: "560001" })?.label).toBe("PIN 560001");
  });
});

describe("the size line (3.7)", () => {
  it("reads About 1.2–1.8 lakh people, with Indian grouping, or Size not available right now", () => {
    expect(sizeLine(120_000, 180_000)).toBe("About 1.2–1.8 lakh people");
    expect(sizeLine(90_000, 120_000)).toBe("About 90 thousand–1.2 lakh people");
    expect(sizeLine(1_200_000, 1_800_000)).toBe("About 12–18 lakh people");
    expect(sizeLine(800, 950)).toBe("About 800–950 people");
    expect(sizeLine(null, 180_000)).toBe("Size not available right now");
    expect(sizeLine(0, 0)).toBe("Size not available right now");
    expect(sizeLine(200, 100)).toBe("Size not available right now");
  });
});

describe("the size cache (A9, 10 minutes)", () => {
  it("two looks within 10 minutes make one fetch; after 10 minutes Meta is asked again", async () => {
    const cache = new SizeCache();
    let now = NOW;
    const meta = { estimateReach: vi.fn(async () => ({ lower: 120_000, upper: 180_000 })) };
    const deps = { meta, now: () => now, cache };
    const first = await audienceSize(CTX, SPEC, deps);
    now += 9 * 60_000;
    const second = await audienceSize(CTX, { ...SPEC }, deps);
    expect(meta.estimateReach).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ lower: 120_000, upper: 180_000, line: "About 1.2–1.8 lakh people", cached: false });
    expect(second).toMatchObject({ line: "About 1.2–1.8 lakh people", cached: true });
    now = NOW + SIZE_CACHE_MS;
    await audienceSize(CTX, SPEC, deps);
    expect(meta.estimateReach).toHaveBeenCalledTimes(2);
  });

  it("the same targeting in another key order shares the entry; another workspace or account does not", async () => {
    const cache = new SizeCache();
    const meta = { estimateReach: vi.fn(async () => ({ lower: 1000, upper: 2000 })) };
    const deps = { meta, now: () => NOW, cache };
    await audienceSize(CTX, { age_min: 18, geo_locations: { countries: ["IN"] } }, deps);
    await audienceSize(CTX, { geo_locations: { countries: ["IN"] }, age_min: 18 }, deps);
    expect(meta.estimateReach).toHaveBeenCalledTimes(1);
    await audienceSize({ ...CTX, tenantId: "t2" }, { age_min: 18, geo_locations: { countries: ["IN"] } }, deps);
    await audienceSize({ ...CTX, adAccountAssetId: "acc2" }, { age_min: 18, geo_locations: { countries: ["IN"] } }, deps);
    expect(meta.estimateReach).toHaveBeenCalledTimes(3);
  });

  it("a failed or empty answer reads Size not available right now and is not kept; Meta refusing the targeting is passed on", async () => {
    const cache = new SizeCache();
    const meta = { estimateReach: vi.fn() };
    const deps = { meta, now: () => NOW, cache };
    meta.estimateReach.mockRejectedValueOnce(new Error("network"));
    expect(await audienceSize(CTX, SPEC, deps)).toEqual({ lower: null, upper: null, line: "Size not available right now", cached: false });
    meta.estimateReach.mockResolvedValueOnce({ lower: null, upper: null });
    expect((await audienceSize(CTX, SPEC, deps)).line).toBe("Size not available right now");
    expect(cache.size).toBe(0);
    meta.estimateReach.mockRejectedValueOnce(new HttpError(400, "This audience is too detailed to size."));
    await expect(audienceSize(CTX, SPEC, deps)).rejects.toMatchObject({ status: 400 });
    meta.estimateReach.mockResolvedValueOnce({ lower: 5000, upper: 9000 });
    await audienceSize(CTX, SPEC, deps);
    expect(meta.estimateReach).toHaveBeenCalledTimes(4);
  });

  it("keeps at most its maximum, dropping the least recently used", () => {
    const cache = new SizeCache(SIZE_CACHE_MS, 2);
    cache.set("a", { at: NOW, lower: 1, upper: 2 });
    cache.set("b", { at: NOW, lower: 1, upper: 2 });
    cache.get("a", NOW);
    cache.set("c", { at: NOW, lower: 1, upper: 2 });
    expect(cache.get("b", NOW)).toBeNull();
    expect(cache.get("a", NOW)).not.toBeNull();
  });
});

describe("rate limits (4.8)", () => {
  it("60 searches a minute per member, then 429; another member is not held", () => {
    const actor = { tenantId: "rate-t", userId: "rate-u1" };
    for (let i = 0; i < SEARCHES_PER_MINUTE; i++) assertSearchRate(actor, NOW);
    expect(() => assertSearchRate(actor, NOW)).toThrow(GEO_COPY.tooManySearches);
    try {
      assertSearchRate(actor, NOW);
    } catch (e) {
      expect((e as HttpError).status).toBe(429);
    }
    expect(() => assertSearchRate({ tenantId: "rate-t", userId: "rate-u2" }, NOW)).not.toThrow();
  });

  it("20 size checks a minute per member, then 429", () => {
    const actor = { tenantId: "rate-t", userId: "rate-size" };
    for (let i = 0; i < SIZES_PER_MINUTE; i++) assertSizeRate(actor, NOW);
    expect(() => assertSizeRate(actor, NOW)).toThrow(GEO_COPY.tooManySizes);
  });
});

// =====================================================================================================================
// GET /api/promote/geo, GET /api/promote/interests and POST /api/promote/audiences/size
// =====================================================================================================================

const ORIGIN = "https://wa.edwyz.com";
let member = 0;

beforeEach(() => {
  process.env.SITE_URL = ORIGIN;
  process.env.PROMOTE_ENABLED = "on";
  delete process.env.PROMOTE_AUDIENCES;
  member++;
  h.getActor.mockReset().mockResolvedValue({ userId: `u${member}`, tenantId: `geo-t${member}`, role: "admin" });
  h.db.spendControl.findUnique.mockReset().mockResolvedValue({ spendingAdAccountAssetId: "acc" });
  h.db.metaAsset.findFirst.mockReset().mockResolvedValue({ id: "acc", externalId: "act_123" });
  h.db.adAudience.findMany.mockReset().mockResolvedValue([]);
  h.meta.searchPlaces.mockReset().mockResolvedValue([{ key: "IN:110001", name: "110001", type: "zip", region: "Delhi", countryCode: "IN" }]);
  h.meta.searchInterests.mockReset().mockResolvedValue([{ id: "6003139266461", name: "Yoga", audienceLow: 1000, audienceHigh: 2000, path: ["Fitness"] }]);
  h.meta.estimateReach.mockReset().mockResolvedValue({ lower: 120_000, upper: 180_000 });
});

const get = (url: string, headers: Record<string, string> = {}) => new Request(`${ORIGIN}${url}`, { headers });
const post = (url: string, body: unknown, origin = ORIGIN) => new Request(`${ORIGIN}${url}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("GET /api/promote/geo and /api/promote/interests", () => {
  it("answer from the spending ad account: a PIN code asks for zip", async () => {
    const { GET: geo } = await import("@/app/api/promote/geo/route");
    const { GET: interests } = await import("@/app/api/promote/interests/route");
    const res = await geo(get("/api/promote/geo?q=110001"), undefined);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { places: unknown[] }).places).toHaveLength(1);
    expect(h.meta.searchPlaces).toHaveBeenCalledWith({ tenantId: `geo-t${member}`, adAccountAssetId: "acc" }, "110001", { types: ["zip"], countryCode: "IN" });
    const r2 = await interests(get("/api/promote/interests?q=yoga"), undefined);
    expect(((await r2.json()) as { interests: { name: string }[] }).interests[0].name).toBe("Yoga");
  });

  it("are hidden while PROMOTE_ENABLED is off, admin only, same site, and need a spending ad account", async () => {
    const { GET: geo } = await import("@/app/api/promote/geo/route");
    const { GET: interests } = await import("@/app/api/promote/interests/route");
    process.env.PROMOTE_ENABLED = "off";
    expect((await geo(get("/api/promote/geo?q=Pune"), undefined)).status).toBe(404);
    expect((await interests(get("/api/promote/interests?q=yoga"), undefined)).status).toBe(404);
    process.env.PROMOTE_ENABLED = "on";
    h.getActor.mockResolvedValueOnce({ userId: "ag", tenantId: `geo-t${member}`, role: "agent" });
    expect((await geo(get("/api/promote/geo?q=Pune"), undefined)).status).toBe(403);
    expect((await geo(get("/api/promote/geo?q=Pune", { origin: "https://evil.example" }), undefined)).status).toBe(403);
    h.db.spendControl.findUnique.mockResolvedValueOnce(null);
    const none = await interests(get("/api/promote/interests?q=yoga"), undefined);
    expect(none.status).toBe(409);
    expect(((await none.json()) as { error: string }).error).toBe(GEO_COPY.noAccount);
    expect(h.meta.searchPlaces).not.toHaveBeenCalled();
  });

  it("share 60 searches a minute per member, then 429", async () => {
    const { GET: geo } = await import("@/app/api/promote/geo/route");
    const { GET: interests } = await import("@/app/api/promote/interests/route");
    for (let i = 0; i < SEARCHES_PER_MINUTE / 2; i++) {
      expect((await geo(get("/api/promote/geo?q=Pune"), undefined)).status).toBe(200);
      expect((await interests(get("/api/promote/interests?q=yoga"), undefined)).status).toBe(200);
    }
    const limited = await geo(get("/api/promote/geo?q=Pune"), undefined);
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: string }).error).toBe(GEO_COPY.tooManySearches);
  });
});

describe("POST /api/promote/audiences/size", () => {
  const TARGETING = { geo: { countries: ["IN"] }, ageMin: 18, ageMax: 65 };

  it("answers the size line from reachestimate, kept 10 minutes", async () => {
    const { POST } = await import("@/app/api/promote/audiences/size/route");
    const res = await POST(post("/api/promote/audiences/size", { targeting: TARGETING }), undefined);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { size: { line: string } }).size.line).toBe("About 1.2–1.8 lakh people");
    const spec = h.meta.estimateReach.mock.calls[0][1] as Record<string, unknown>;
    expect(spec).toMatchObject({ geo_locations: { countries: ["IN"] }, age_min: 18, age_max: 65 });
    await POST(post("/api/promote/audiences/size", { targeting: TARGETING }), undefined);
    expect(h.meta.estimateReach).toHaveBeenCalledTimes(1);
  });

  it("refuses a targeting that can't run, and says when there is no spending account", async () => {
    const { POST } = await import("@/app/api/promote/audiences/size/route");
    const bad = await POST(post("/api/promote/audiences/size", { targeting: { geo: { countries: [] } } }), undefined);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("Choose at least one country or city.");
    expect((await POST(post("/api/promote/audiences/size", {}), undefined)).status).toBe(400);
    // An audience id that is not a ready audience of the workspace is never sent.
    const foreign = await POST(post("/api/promote/audiences/size", { targeting: { ...TARGETING, customAudienceIds: ["aud_other"] } }), undefined);
    expect(foreign.status).toBe(400);
    h.db.spendControl.findUnique.mockResolvedValueOnce(null);
    const none = (await (await POST(post("/api/promote/audiences/size", { targeting: TARGETING }), undefined)).json()) as { size: { line: string; reason: string } };
    expect(none.size).toMatchObject({ line: "Size not available right now" });
    expect(none.size.reason).toMatch(/spending ad account/);
    expect(h.meta.estimateReach).not.toHaveBeenCalled();
  });

  it("is admin only, same origin, hidden while off, and 20 a minute per member", async () => {
    const { POST } = await import("@/app/api/promote/audiences/size/route");
    expect((await POST(post("/api/promote/audiences/size", { targeting: TARGETING }, "https://evil.example"), undefined)).status).toBe(403);
    h.getActor.mockResolvedValueOnce({ userId: "ag", tenantId: `geo-t${member}`, role: "agent" });
    expect((await POST(post("/api/promote/audiences/size", { targeting: TARGETING }), undefined)).status).toBe(403);
    process.env.PROMOTE_ENABLED = "off";
    expect((await POST(post("/api/promote/audiences/size", { targeting: TARGETING }), undefined)).status).toBe(404);
    process.env.PROMOTE_ENABLED = "on";
    for (let i = 0; i < SIZES_PER_MINUTE; i++) expect((await POST(post("/api/promote/audiences/size", { targeting: TARGETING }), undefined)).status).toBe(200);
    const limited = await POST(post("/api/promote/audiences/size", { targeting: TARGETING }), undefined);
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: string }).error).toBe(GEO_COPY.tooManySizes);
  });
});
