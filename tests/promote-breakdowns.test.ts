import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * docs/IG-PAGE-ADS-SPEC.md 3.10, 4.2 R3 to R5 and R3a, 4.9, 5.3, 5.5 and PRM-12 acceptance (promote-breakdowns): InsightBreakdown
 * rows are upserted on their unique key (a repeat sync adds nothing), at most 20,000 a sync and 100,000 a workspace (oldest
 * dropped first), with exact spend (decimalToMinorBig and the account currency's exponent). Placement keys keep Meta's raw
 * pair and unknown Facebook positions read "Facebook: {raw}". The Leads tab joins Lead rows by adMetaId and platform, and falls
 * back to Meta's own lead counts, labelled. The dimensions route is admin only. Meta and the database are fakes.
 */
const h = vi.hoisted(() => {
  const eq = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);
  const num = (v: unknown) => (v instanceof Date ? v.getTime() : typeof v === "bigint" ? Number(v) : (v as number));
  const cmp = (a: unknown, b: unknown) => (typeof a === "string" && typeof b === "string" ? a.localeCompare(b) : num(a) - num(b));
  const matchValue = (v: unknown, c: unknown): boolean => {
    if (c && typeof c === "object" && !(c instanceof Date) && !Array.isArray(c)) {
      const o = c as Record<string, unknown>;
      if ("in" in o) return (o.in as unknown[]).some((x) => eq(v, x));
      if ("not" in o) return !eq(v, o.not);
      return (!("gte" in o) || cmp(v, o.gte) >= 0) && (!("lte" in o) || cmp(v, o.lte) <= 0) && (!("lt" in o) || cmp(v, o.lt) < 0);
    }
    return eq(v, c);
  };
  const matches = (row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean =>
    Object.entries(where).every(([k, c]) => (k === "NOT" ? !matches(row, c as Record<string, unknown>) : matchValue(row[k], c)));
  const sortBy = (orderBy: Record<string, "asc" | "desc">[] | Record<string, "asc" | "desc">) => {
    const list = Array.isArray(orderBy) ? orderBy : [orderBy];
    return (a: Record<string, unknown>, b: Record<string, unknown>) => {
      for (const o of list) {
        const [field, dir] = Object.entries(o)[0];
        const c = cmp(a[field], b[field]);
        if (c !== 0) return dir === "desc" ? -c : c;
      }
      return 0;
    };
  };
  const keyOf = (k: Record<string, unknown>) => [k.tenantId, k.entityType, k.entityMetaId, (k.date as Date).toISOString(), k.dimension, k.dimKey].join("|");
  const store = new Map<string, Record<string, unknown>>();
  let seq = 0;
  return {
    matches,
    sortBy,
    keyOf,
    store,
    all: () => [...store.values()],
    nextId: () => `ib${String(++seq).padStart(7, "0")}`,
    campaigns: [] as Record<string, unknown>[],
    snaps: [] as Record<string, unknown>[],
    settings: new Map<string, unknown>(),
    platformAds: [] as { tenantId: string }[],
    getActor: vi.fn(),
    fetchAs: vi.fn(),
    listAssets: vi.fn(),
    getAssetAccess: vi.fn(),
    groupBy: vi.fn(),
    upserts: { count: 0 },
  };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    insightBreakdown: {
      upsert: async ({ where, create, update }: { where: { tenantId_entityType_entityMetaId_date_dimension_dimKey: Record<string, unknown> }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        h.upserts.count++;
        const k = h.keyOf(where.tenantId_entityType_entityMetaId_date_dimension_dimKey);
        const hit = h.store.get(k);
        if (hit) Object.assign(hit, update);
        else h.store.set(k, { id: h.nextId(), ...create });
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        let count = 0;
        for (const [k, r] of h.store) {
          if (h.matches(r, where)) {
            h.store.delete(k);
            count++;
          }
        }
        return { count };
      },
      count: async ({ where }: { where: Record<string, unknown> }) => h.all().filter((r) => h.matches(r, where)).length,
      findMany: async ({ where, orderBy, take }: { where: Record<string, unknown>; orderBy?: Record<string, "asc" | "desc">[]; take?: number }) => {
        const rows = h.all().filter((r) => h.matches(r, where));
        if (orderBy) rows.sort(h.sortBy(orderBy));
        return take ? rows.slice(0, take) : rows;
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => h.all().find((r) => h.matches(r, where)) ?? null,
    },
    insightSnapshot: { findMany: async ({ where }: { where: Record<string, unknown> }) => h.snaps.filter((r) => h.matches(r, where)) },
    adCampaign: {
      findFirst: async ({ where }: { where: { id: string; tenantId: string } }) => h.campaigns.find((c) => c.id === where.id && c.tenantId === where.tenantId) ?? null,
      findMany: async ({ where }: { where: { tenantId: string } }) => h.campaigns.filter((c) => c.tenantId === where.tenantId && c.metaCampaignId),
    },
    ad: { findMany: async () => h.platformAds },
    lead: { groupBy: (...a: unknown[]) => h.groupBy(...a) },
    adTest: { findFirst: async () => null },
    platformSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => (h.settings.has(where.key) ? { value: h.settings.get(where.key) } : null),
      upsert: async ({ where, create }: { where: { key: string }; create: { value: unknown } }) => void h.settings.set(where.key, create.value),
    },
  },
}));
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async () => true }));
vi.mock("@/lib/auth", () => ({ getActor: (...a: unknown[]) => h.getActor(...a) }));
vi.mock("@/lib/meta-connect", () => ({ listAssets: (...a: unknown[]) => h.listAssets(...a), getAssetAccess: (...a: unknown[]) => h.getAssetAccess(...a) }));
vi.mock("@/lib/graph", async () => {
  const actual = await vi.importActual<typeof import("@/lib/graph")>("@/lib/graph");
  return { ...actual, graphFetchAs: (...a: unknown[]) => h.fetchAs(...a) };
});

import { decimalToMinor } from "@/lib/ads/insights-money";
import { BREAKDOWN_ROWS_PER_SYNC, BREAKDOWN_ROWS_PER_WORKSPACE, pruneBreakdowns, toBreakdown, upsertBreakdowns, type AccountState, type BreakdownData, type SyncState } from "@/lib/ads/insights-store";
import { BACKFILL_DIMENSIONS, backfilledDimensions, campaignResultActions, isPlacementAssetAd, platformCampaignWhere, runBreakdownSync, syncBreakdownsTenant } from "@/lib/ads/insights-sync";
import { setLogSink } from "@/lib/log";
import { currencyExponent } from "@/lib/spend/money";
import { ageGenderLabel, dimensionRows, leadSplit, leadsView, placementRows, RESULTS_COPY, snapshotResult } from "@/lib/promote/breakdowns";
import { createThrottle, PRIORITY, throttleKey } from "@/lib/promote/throttle";
import { runBreakdownSync as runBreakdownTask } from "@/lib/promote/tasks/breakdowns";

const NOW = new Date("2026-10-31T06:00:00.000Z");
const CID = "120200000000001";
const AD_ASSETS = "120200000000101";
const AD_PLAIN = "120200000000102";
const ORIGIN = "https://wa.edwyz.com";
const CHAT = "onsite_conversion.messaging_conversation_started_7d";
const chats = (n: number) => [{ action_type: CHAT, value: String(n) }];

const memoryThrottle = (seed: Record<string, Record<string, unknown>> = {}) => {
  const rows = new Map<string, Record<string, unknown>>(Object.entries(seed));
  return createThrottle({ store: { get: async (k) => rows.get(k) ?? null, set: async (k, v) => void rows.set(k, v) }, now: () => NOW.getTime() });
};

const campaign = (o: Record<string, unknown> = {}) => ({
  id: "k1",
  tenantId: "t1",
  name: "Diwali chats",
  metaCampaignId: CID,
  adAccountAssetId: "acc1",
  goal: "whatsapp_chats",
  template: "click_to_whatsapp",
  objective: "OUTCOME_ENGAGEMENT",
  currency: "INR",
  sourceKind: "new",
  status: "active",
  startsAt: new Date("2026-10-20T00:30:00.000Z"),
  launchedAt: new Date("2026-10-20T00:30:00.000Z"),
  adSets: [
    {
      id: "set-a",
      name: "Version A",
      metaAdSetId: "120200000000201",
      variantKey: "A",
      status: "active",
      ads: [{ id: "ad-a", name: "Diwali A", metaAdId: AD_ASSETS, variantLabel: null, format: "single_image", creative: { media: { feed: "m1", vertical: "m2" } } }],
    },
    {
      id: "set-b",
      name: "Version B",
      metaAdSetId: "120200000000202",
      variantKey: "B",
      status: "active",
      ads: [{ id: "ad-b", name: "Diwali B", metaAdId: AD_PLAIN, variantLabel: null, format: "single_image", creative: { media: { feed: "m3" } } }],
    },
  ],
  ...o,
});

const breakdown = (o: Omit<Partial<BreakdownData>, "date"> & { entityMetaId: string; dimension: BreakdownData["dimension"]; dimKey: string; date: string }) =>
  ({
    tenantId: "t1",
    entityType: o.dimension === "placement" || o.dimension.startsWith("asset_") ? "ad" : "campaign",
    spendMinor: 0n,
    impressions: 0,
    reach: null,
    clicks: 0,
    results: 0,
    thruplays: null,
    raw: {},
    ...o,
    date: new Date(`${o.date}T00:00:00.000Z`),
  }) as BreakdownData;

const put = (rows: BreakdownData[]) => upsertBreakdowns(rows, NOW);

beforeEach(() => {
  h.store.clear();
  h.campaigns.length = 0;
  h.snaps.length = 0;
  h.settings.clear();
  h.platformAds.length = 0;
  h.upserts.count = 0;
  h.fetchAs.mockReset();
  h.groupBy.mockReset().mockResolvedValue([]);
  h.listAssets.mockReset().mockResolvedValue([{ id: "acc1", type: "ad_account", externalId: "999", name: "Main", status: "active", meta: { currency: "INR", timezone: "Asia/Kolkata" } }]);
  h.getAssetAccess.mockReset().mockResolvedValue({ assetId: "acc1", type: "ad_account", externalId: "999", name: "Main", token: "user-token" });
  h.getActor.mockReset().mockResolvedValue({ userId: "u1", tenantId: "t1", role: "admin" });
  process.env.PROMOTE_ENABLED = "on";
  process.env.SITE_URL = ORIGIN;
});

// =====================================================================================================================
// Storage: idempotent upsert, money, keys and caps
// =====================================================================================================================

describe("InsightBreakdown rows (5.1, 5.3, 5.5)", () => {
  const ctx = { exponent: 2, resultKeyOf: () => "whatsapp_chats" };
  const placementRow = (o: Record<string, unknown> = {}) => ({
    ad_id: AD_PLAIN,
    adset_id: "120200000000202",
    campaign_id: CID,
    date_start: "2026-10-30",
    publisher_platform: "instagram",
    platform_position: "reels",
    spend: "120.50",
    impressions: "4000",
    reach: "2800",
    clicks: "80",
    actions: chats(4),
    ...o,
  });

  it("an upsert run twice gives the same row count, and the second run updates the values", async () => {
    const rows = [
      toBreakdown("t1", "placement", placementRow(), ctx)!,
      toBreakdown("t1", "placement", placementRow({ platform_position: "stream" }), ctx)!,
      toBreakdown("t1", "age_gender", { campaign_id: CID, date_start: "2026-10-30", age: "25-34", gender: "female", spend: "80.00" }, ctx)!,
      toBreakdown("t1", "region", { campaign_id: CID, date_start: "2026-10-30", region: "Maharashtra", spend: "40" }, ctx)!,
      toBreakdown("t1", "run_total", { campaign_id: CID, date_start: "2026-10-20", reach: "5321", spend: "500" }, { ...ctx, runStartOf: () => "2026-10-20" })!,
    ];
    expect(rows.every(Boolean)).toBe(true);
    await put(rows);
    expect(h.store.size).toBe(5);
    await put([toBreakdown("t1", "placement", placementRow({ spend: "130.00" }), ctx)!, ...rows.slice(1)]);
    expect(h.store.size).toBe(5);
    const reels = h.all().find((r) => r.dimKey === "instagram|reels")!;
    expect(reels).toMatchObject({ spendMinor: 13000n, results: 4, entityType: "ad", entityMetaId: AD_PLAIN, syncedAt: NOW });
    // Another workspace never shares a row.
    await put([{ ...rows[0], tenantId: "t2" }]);
    expect(h.store.size).toBe(6);
  });

  it("spend uses decimalToMinorBig with the account currency's exponent: a JPY account (exponent 0) and a large amount are never clamped", async () => {
    expect(currencyExponent("JPY")).toBe(0);
    const jpy = toBreakdown("t1", "placement", placementRow({ spend: "98765432109" }), { exponent: currencyExponent("JPY") })!;
    expect(jpy.spendMinor).toBe(98_765_432_109n);
    // The 32-bit snapshot conversion would have clamped it.
    expect(decimalToMinor("98765432109", 0)).toBe(2_147_483_647);
    expect(toBreakdown("t1", "placement", placementRow({ spend: "12.345" }), { exponent: 2 })!.spendMinor).toBe(1235n);
    expect(toBreakdown("t1", "placement", placementRow({ spend: "1.2345" }), { exponent: currencyExponent("KWD") })!.spendMinor).toBe(1235n);
    // Unreadable spend drops the row instead of storing a guess.
    expect(toBreakdown("t1", "placement", placementRow({ spend: "1e5" }), ctx)).toBeNull();
    await put([jpy]);
    expect(h.all()[0].spendMinor).toBe(98_765_432_109n);
  });

  it("keeps Meta's raw publisher_platform|platform_position pair, so an unknown Facebook position shows as 'Facebook: {raw}'", async () => {
    const odd = toBreakdown("t1", "placement", placementRow({ publisher_platform: "facebook", platform_position: "facebook_new_surface", spend: "3.10", actions: chats(1) }), ctx)!;
    expect(odd.dimKey).toBe("facebook|facebook_new_surface");
    expect(odd.raw).toMatchObject({ platform: "facebook", position: "facebook_new_surface" });
    const rows = placementRows([odd], { currency: "INR", resultKey: "whatsapp_chats" });
    expect(rows[0].label).toBe("Facebook: facebook_new_surface");
    expect(rows[0].text).toBe("Facebook: facebook_new_surface: 1 chat, ₹3 each");
    // A row missing its pair, its ad id or its day is not stored.
    expect(toBreakdown("t1", "placement", placementRow({ platform_position: undefined }), ctx)).toBeNull();
    expect(toBreakdown("t1", "placement", placementRow({ ad_id: undefined }), ctx)).toBeNull();
    expect(toBreakdown("t1", "placement", placementRow({ date_start: "30/10/2026" }), ctx)).toBeNull();
  });

  it("keys age and gender, region, assets and the run total, and keeps Meta's own lead count", () => {
    expect(toBreakdown("t1", "age_gender", { campaign_id: CID, date_start: "2026-10-30", age: "25-34", gender: "female", spend: "1" }, ctx)).toMatchObject({ entityType: "campaign", entityMetaId: CID, dimKey: "female|25-34" });
    expect(toBreakdown("t1", "region", { campaign_id: CID, date_start: "2026-10-30", region: " Maharashtra ", spend: "1" }, ctx)?.dimKey).toBe("Maharashtra");
    const body = toBreakdown("t1", "asset_body", { ad_id: AD_ASSETS, campaign_id: CID, date_start: "2026-10-30", body_asset: { id: "1001", text: "Chat with us on WhatsApp" }, spend: "60" }, ctx)!;
    expect(body).toMatchObject({ entityType: "ad", dimKey: "body:1001", raw: { label: "Chat with us on WhatsApp" } });
    const image = toBreakdown("t1", "asset_image", { ad_id: AD_ASSETS, campaign_id: CID, date_start: "2026-10-30", image_asset: { hash: "abc123" }, spend: "60" }, ctx)!;
    expect(image.dimKey).toMatch(/^image:[0-9a-f]{40}$/);
    const run = toBreakdown("t1", "run_total", { campaign_id: CID, date_start: "2026-10-25", date_stop: "2026-10-31", reach: "5321", frequency: "1.84", spend: "1" }, { ...ctx, runStartOf: () => "2026-10-20" })!;
    expect(run).toMatchObject({ entityType: "campaign", dimension: "run_total", dimKey: "all", reach: 5321, raw: { frequency: 1.84, until: "2026-10-31" } });
    expect(run.date.toISOString().slice(0, 10)).toBe("2026-10-20");
    const lead = toBreakdown("t1", "placement", placementRow({ actions: [{ action_type: "lead", value: "6" }] }), { exponent: 2, resultKeyOf: () => "lead_form" })!;
    expect(lead).toMatchObject({ results: 6, raw: { leads: 6, resultAction: "lead" } });
  });

  it("over 100,000 rows in a workspace, the oldest daily rows are dropped first and the run totals are kept", async () => {
    expect(BREAKDOWN_ROWS_PER_WORKSPACE).toBe(100_000);
    const add = (o: Record<string, unknown>) => {
      const row = { id: h.nextId(), tenantId: "t1", entityType: "ad", entityMetaId: AD_PLAIN, dimension: "placement", dimKey: "instagram|reels", syncedAt: NOW, spendMinor: 0n, ...o };
      h.store.set(h.keyOf(row), row);
    };
    // 3 old days, an old run total, and 100,000 recent rows.
    for (const d of ["2025-01-01", "2025-01-02", "2025-01-03"]) add({ date: new Date(`${d}T00:00:00.000Z`), dimKey: `old|${d}` });
    add({ entityType: "campaign", entityMetaId: CID, dimension: "run_total", dimKey: "all", date: new Date("2024-06-01T00:00:00.000Z") });
    for (let i = 0; i < 100_000; i++) add({ date: new Date(Date.UTC(2026, 9, 1 + (i % 30))), dimKey: `instagram|p${i}` });
    // Another workspace's rows never count against this one.
    add({ tenantId: "t2", date: new Date("2020-01-01T00:00:00.000Z"), dimKey: "x" });
    expect(h.all().filter((r) => r.tenantId === "t1")).toHaveLength(100_004);

    expect(await pruneBreakdowns("t1")).toBe(4);
    const left = h.all().filter((r) => r.tenantId === "t1");
    expect(left).toHaveLength(100_000);
    expect(left.some((r) => String(r.dimKey).startsWith("old|"))).toBe(false);
    expect(left.some((r) => r.dimension === "run_total")).toBe(true);
    expect(h.all().some((r) => r.tenantId === "t2")).toBe(true);
    // The fourth row dropped is one of the oldest recent day's (1 Oct).
    expect(left.filter((r) => (r.date as Date).getUTCDate() === 1 && (r.date as Date).getUTCMonth() === 9)).toHaveLength(3_333);
    expect(await pruneBreakdowns("t1")).toBe(0);
  });
});

// =====================================================================================================================
// The sync (R3, R3a, R4, R5): platform campaigns only, caps, throttle priority 5
// =====================================================================================================================

type Query = Record<string, string>;

describe("the breakdown sync (4.2, 4.9, 5.5)", () => {
  const fake = (handlers: Partial<Record<string, (q: Query) => unknown>> = {}) => {
    const sent: Query[] = [];
    h.fetchAs.mockImplementation(async (_token: string, req: { path: string; query: Query }) => {
      sent.push(req.query);
      const by = req.query.breakdowns ?? "run_total";
      const handler = handlers[by];
      if (handler) return handler(req.query);
      if (by === "run_total") return { data: [{ campaign_id: CID, date_start: "2026-10-20", date_stop: "2026-10-31", reach: "5321", frequency: "1.84", spend: "500.00", impressions: "9000" }] };
      if (by === "publisher_platform,platform_position")
        return {
          data: [
            { ad_id: AD_PLAIN, campaign_id: CID, date_start: "2026-10-30", publisher_platform: "instagram", platform_position: "reels", spend: "98.25", impressions: "3000", reach: "2100", clicks: "60", actions: chats(4) },
            { ad_id: AD_PLAIN, campaign_id: CID, date_start: "2026-10-30", publisher_platform: "facebook", platform_position: "facebook_new_surface", spend: "3.10", impressions: "90", actions: chats(1) },
          ],
        };
      if (by === "age,gender") return { data: [{ campaign_id: CID, date_start: "2026-10-30", age: "25-34", gender: "male", spend: "140.00", actions: chats(5) }] };
      if (by === "region") return { data: [{ campaign_id: CID, date_start: "2026-10-30", region: "Karnataka", spend: "31.25", actions: chats(2) }] };
      return { data: [{ ad_id: AD_ASSETS, campaign_id: CID, date_start: "2026-10-30", [by]: { id: "1001", text: "Chat with us on WhatsApp" }, spend: "60.00", impressions: "1500", actions: chats(3) }] };
    });
    return sent;
  };

  it("reads Edwyz's own campaigns only, R4 only for per-placement-asset ads, and backfills 30 days, then refreshes 3", async () => {
    h.campaigns.push(campaign());
    const sent = fake();
    const r = await syncBreakdownsTenant("t1", NOW, { throttle: memoryThrottle() });
    expect(r).toMatchObject({ accounts: 1, campaigns: 1, truncated: false, rateLimited: false, errors: [] });
    expect(r.rows).toBe(h.store.size);
    // Every read is filtered to the campaign's ids (or, for R4, the asset ad's).
    for (const q of sent) {
      const filter = JSON.parse(q.filtering)[0];
      if (q.breakdowns?.endsWith("_asset")) expect(filter).toEqual({ field: "ad.id", operator: "IN", value: [AD_ASSETS] });
      else expect(filter).toEqual({ field: "campaign.id", operator: "IN", value: [CID] });
    }
    expect(sent.map((q) => q.breakdowns ?? "run_total")).toEqual([
      "run_total",
      "publisher_platform,platform_position",
      "age,gender",
      "region",
      "body_asset",
      "title_asset",
      "image_asset",
      "video_asset",
      "call_to_action_asset",
    ]);
    expect(JSON.parse(sent[1].time_range)).toEqual({ since: "2026-10-02", until: "2026-10-31" });
    expect(new Set(h.all().map((r) => r.dimension))).toEqual(new Set(["run_total", "placement", "age_gender", "region", "asset_body", "asset_title", "asset_image", "asset_video", "asset_cta"]));
    expect(isPlacementAssetAd(campaign().adSets[0].ads[0])).toBe(true);
    expect(isPlacementAssetAd(campaign().adSets[1].ads[0])).toBe(false);
    expect(isPlacementAssetAd({ format: "existing_post", creative: { media: { feed: "a", vertical: "b" } } })).toBe(false);

    const second = fake();
    await syncBreakdownsTenant("t1", NOW, { throttle: memoryThrottle() });
    expect(JSON.parse(second[1].time_range)).toEqual({ since: "2026-10-29", until: "2026-10-31" });
    // Idempotent: the same rows again.
    expect(h.store.size).toBe(r.rows);
    expect(platformCampaignWhere(NOW)).toMatchObject({ metaCampaignId: { not: null } });
  });

  it("more than 20,000 rows in one sync are cut at 20,000 and the sync says it was cut", async () => {
    expect(BREAKDOWN_ROWS_PER_SYNC).toBe(20_000);
    h.campaigns.push(campaign({ adSets: [] }));
    const page = (prefix: string, pages: number, make: (i: number) => Record<string, unknown>) => (q: Query) => {
      const n = Number(q.after ?? 0);
      const data = Array.from({ length: 500 }, (_, i) => make(n * 500 + i));
      return { data, paging: n + 1 < pages ? { cursors: { after: String(n + 1) }, next: `https://next/${prefix}` } : undefined };
    };
    const sent = fake({
      "publisher_platform,platform_position": page("p", 30, (i) => ({ ad_id: String(9_000_000 + i), campaign_id: CID, date_start: "2026-10-30", publisher_platform: "facebook", platform_position: "feed", spend: "1.00" })),
      "age,gender": page("a", 30, (i) => ({ campaign_id: CID, date_start: "2026-10-30", age: `a${i}`, gender: "female", spend: "1.00" })),
    });
    const r = await syncBreakdownsTenant("t1", NOW, { throttle: memoryThrottle() });
    expect(r.truncated).toBe(true);
    expect(r.rows).toBe(20_000);
    expect(h.store.size).toBe(20_000);
    expect(h.upserts.count).toBe(20_000);
    // The run total went first; the region read never ran.
    expect(h.all().some((x) => x.dimension === "run_total")).toBe(true);
    expect(sent.filter((q) => q.breakdowns === "region")).toHaveLength(0);
    // A cut backfill is not a backfill: age and gender (cut) and region (never read) backfill again next time.
    const acc = accountState();
    expect(acc.backfilledAt).toBeUndefined();
    expect(acc.dims?.placement).toBe(NOW.toISOString());
    expect(acc.dims?.age_gender).toBeUndefined();
    expect(acc.dims?.region).toBeUndefined();
  }, 30_000);

  const accountState = (): AccountState => (h.settings.get("ads:insights:breakdowns:t1") as SyncState).accounts.acc1;
  const rangeOf = (sent: Query[], breakdowns: string) => JSON.parse(sent.find((q) => (q.breakdowns ?? "run_total") === breakdowns)!.time_range) as { since: string; until: string };
  const THIRTY = { since: "2026-10-02", until: "2026-10-31" };
  const THREE = { since: "2026-10-29", until: "2026-10-31" };

  it("a backfill cut by the row cap leaves the account unbackfilled; the next run reads what was cut over 30 days and the rest over 3", async () => {
    h.campaigns.push(campaign());
    const first = fake();
    // Room for the run total and the two placement rows only.
    const r = await syncBreakdownsTenant("t1", NOW, { throttle: memoryThrottle(), maxRows: 3 });
    expect(r).toMatchObject({ truncated: true, rows: 3, errors: [] });
    expect(first.map((q) => q.breakdowns ?? "run_total")).toEqual(["run_total", "publisher_platform,platform_position"]);
    expect(accountState().backfilledAt).toBeUndefined();
    expect(Object.keys(accountState().dims ?? {})).toEqual(["placement"]);
    expect(backfilledDimensions(accountState())).toEqual(new Set(["placement"]));

    const later = new Date(NOW.getTime() + 6 * 3_600_000);
    const second = fake();
    const r2 = await syncBreakdownsTenant("t1", later, { throttle: memoryThrottle() });
    expect(r2.truncated).toBe(false);
    // Placements finished last time: 3 days. Region, age and gender and the assets were cut: 30 days.
    expect(rangeOf(second, "publisher_platform,platform_position")).toEqual(THREE);
    expect(rangeOf(second, "region")).toEqual(THIRTY);
    expect(rangeOf(second, "age,gender")).toEqual(THIRTY);
    expect(rangeOf(second, "body_asset")).toEqual(THIRTY);
    // Every dimension is done now; placement keeps the time its own backfill finished.
    expect(accountState().backfilledAt).toBe(later.toISOString());
    expect(accountState().dims?.placement).toBe(NOW.toISOString());
    expect(BACKFILL_DIMENSIONS.every((d) => accountState().dims?.[d])).toBe(true);

    const third = fake();
    await syncBreakdownsTenant("t1", new Date(later.getTime() + 6 * 3_600_000), { throttle: memoryThrottle() });
    expect(rangeOf(third, "region")).toEqual(THREE);
  });

  it("an account backfilled before dimensions were kept one by one refreshes 3 days for every dimension", () => {
    expect(backfilledDimensions({ backfilledAt: NOW.toISOString() })).toEqual(new Set(BACKFILL_DIMENSIONS));
    expect(backfilledDimensions({})).toEqual(new Set());
    expect(backfilledDimensions({ backfilledAt: NOW.toISOString(), dims: { region: NOW.toISOString() } })).toEqual(new Set(["region"]));
  });

  it("a read Meta refuses is logged and skipped: the rest still sync, and only the refused dimension backfills again", async () => {
    h.campaigns.push(campaign());
    const { GraphError } = await import("@/lib/graph");
    const lines: string[] = [];
    setLogSink((_level, line) => void lines.push(line));
    let r: Awaited<ReturnType<typeof syncBreakdownsTenant>>;
    const sent = fake({
      region: () => {
        throw new GraphError("(#100) The region breakdown is not available for this request", 400, 100);
      },
    });
    try {
      r = await syncBreakdownsTenant("t1", NOW, { throttle: memoryThrottle() });
    } finally {
      setLogSink(null);
    }
    expect(r).toMatchObject({ accounts: 1, campaigns: 1, rateLimited: false });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^region: /);
    // Every read after the refused one still ran, and its rows are stored.
    expect(sent.map((q) => q.breakdowns ?? "run_total")).toEqual(["run_total", "publisher_platform,platform_position", "age,gender", "region", "body_asset", "title_asset", "image_asset", "video_asset", "call_to_action_asset"]);
    expect(h.all().some((x) => x.dimension === "asset_cta")).toBe(true);
    const logged = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((e) => e.msg === "insights.breakdowns.read_failed");
    expect(logged).toMatchObject({ tenantId: "t1", account: "acc1", dimension: "region" });
    // Only region is left to backfill; the sync's state records the refusal.
    expect(accountState().backfilledAt).toBeUndefined();
    expect(Object.keys(accountState().dims ?? {}).sort()).toEqual(BACKFILL_DIMENSIONS.filter((d) => d !== "region").sort());
    expect((h.settings.get("ads:insights:breakdowns:t1") as SyncState).lastError).toMatch(/^region: /);

    const next = fake();
    await syncBreakdownsTenant("t1", new Date(NOW.getTime() + 6 * 3_600_000), { throttle: memoryThrottle() });
    expect(rangeOf(next, "region")).toEqual(THIRTY);
    expect(rangeOf(next, "publisher_platform,platform_position")).toEqual(THREE);
    expect(rangeOf(next, "age,gender")).toEqual(THREE);
    expect(accountState().backfilledAt).toBeDefined();
  });

  it("a token Meta no longer accepts stops the account instead of failing every read", async () => {
    h.campaigns.push(campaign());
    const { GraphError } = await import("@/lib/graph");
    const sent = fake({
      "publisher_platform,platform_position": () => {
        throw new GraphError("Error validating access token", 400, 190);
      },
    });
    const r = await syncBreakdownsTenant("t1", NOW, { throttle: memoryThrottle() });
    expect(sent.map((q) => q.breakdowns ?? "run_total")).toEqual(["run_total", "publisher_platform,platform_position"]);
    expect(r.errors).toHaveLength(1);
    expect(r.accounts).toBe(0);
    expect(accountState().backfilledAt).toBeUndefined();
  });

  it("website visits count what the ad set optimises for: 0 landing page views and 5 link clicks is 0 visits for a landing-page-views ad set", async () => {
    const LPV_SET = "120200000000201";
    const CLICK_SET = "120200000000202";
    const base = campaign();
    const c = campaign({
      goal: "website_visits",
      template: "traffic",
      objective: "OUTCOME_TRAFFIC",
      adSets: [
        { ...base.adSets[0], optimizationGoal: "LANDING_PAGE_VIEWS" },
        { ...base.adSets[1], optimizationGoal: "LINK_CLICKS" },
      ],
    });
    h.campaigns.push(c);
    const row = (ad: string, set: string, position: string, actions: { action_type: string; value: string }[]) => ({ ad_id: ad, adset_id: set, campaign_id: CID, date_start: "2026-10-30", publisher_platform: "instagram", platform_position: position, spend: "50.00", actions });
    fake({
      "publisher_platform,platform_position": () => ({
        data: [
          row(AD_ASSETS, LPV_SET, "reels", [{ action_type: "link_click", value: "5" }]),
          row(AD_ASSETS, LPV_SET, "stream", [
            { action_type: "landing_page_view", value: "3" },
            { action_type: "link_click", value: "9" },
          ]),
          row(AD_PLAIN, CLICK_SET, "reels", [
            { action_type: "landing_page_view", value: "2" },
            { action_type: "link_click", value: "5" },
          ]),
        ],
      }),
    });
    await syncBreakdownsTenant("t1", NOW, { throttle: memoryThrottle() });
    const stored = (ad: string, key: string) => h.all().find((x) => x.dimension === "placement" && x.entityMetaId === ad && x.dimKey === key);
    expect(stored(AD_ASSETS, "instagram|reels")).toMatchObject({ results: 0, raw: { resultAction: null } });
    expect(stored(AD_ASSETS, "instagram|stream")).toMatchObject({ results: 3, raw: { resultAction: "landing_page_view" } });
    expect(stored(AD_PLAIN, "instagram|reels")).toMatchObject({ results: 5, raw: { resultAction: "link_click" } });

    // Campaign-level rows (age and gender, region) use the optimisation only when every ad set shares it.
    expect(campaignResultActions(c, null)).toBeNull();
    expect(campaignResultActions(c, LPV_SET)).toEqual(["landing_page_view"]);
    expect(campaignResultActions({ ...c, adSets: [c.adSets[0], { ...c.adSets[1], optimizationGoal: "LANDING_PAGE_VIEWS" }] }, null)).toEqual(["landing_page_view"]);
    // A row of an ad set whose optimisation is unknown keeps the goal's list.
    expect(toBreakdown("t1", "placement", row(AD_PLAIN, "999", "feed", [{ action_type: "link_click", value: "5" }]), { exponent: 2, resultKeyOf: () => "website_visits", resultActionsOf: () => null })?.results).toBe(5);
  });

  it("waits at priority 5 while Meta is busy: no read is sent and the account backs off until the hold ends", async () => {
    h.campaigns.push(campaign());
    const sent = fake();
    const until = new Date(NOW.getTime() + 20 * 60_000).toISOString();
    const busy = memoryThrottle({ [throttleKey("act_999")]: { busy: { pct: 90, until } } });
    // Priority 2 (review sync) would still run; breakdowns are priority 5.
    await expect(busy.check("act_999", PRIORITY.review)).resolves.toBeUndefined();
    await expect(busy.check("act_999", PRIORITY.breakdowns)).rejects.toMatchObject({ reason: "busy" });
    const r = await syncBreakdownsTenant("t1", NOW, { throttle: busy });
    expect(r).toMatchObject({ rateLimited: true, rows: 0 });
    expect(sent).toHaveLength(0);
    const state = h.settings.get("ads:insights:breakdowns:t1") as { accounts: Record<string, { backoffUntil?: string; backfilledAt?: string }> };
    expect(state.accounts.acc1.backoffUntil).toBe(until);
    expect(state.accounts.acc1.backfilledAt).toBeUndefined();
    // Still held on the next run: nothing is read.
    await syncBreakdownsTenant("t1", new Date(NOW.getTime() + 60_000), { throttle: memoryThrottle() });
    expect(sent).toHaveLength(0);
  });

  it("a Meta rate limit stops the account, keeps what was read, and notes the cooldown", async () => {
    h.campaigns.push(campaign());
    const { GraphError } = await import("@/lib/graph");
    const sent = fake({
      "age,gender": () => {
        throw new GraphError("limit", 400, 80004);
      },
    });
    const throttle = memoryThrottle();
    const r = await syncBreakdownsTenant("t1", NOW, { throttle });
    expect(r.rateLimited).toBe(true);
    expect(sent.map((q) => q.breakdowns ?? "run_total")).toEqual(["run_total", "publisher_platform,platform_position", "age,gender"]);
    expect(h.all().filter((x) => x.dimension === "placement")).toHaveLength(2);
    expect(await throttle.cooldown("act_999")).toMatchObject({ code: 80004 });
  });

  it("the promote.breakdowns task with no platform ad makes one read and returns zeros; with one it syncs that workspace", async () => {
    expect(await runBreakdownTask()).toEqual({ campaigns: 0, rows: 0, failed: 0 });
    expect(h.fetchAs).not.toHaveBeenCalled();
    h.platformAds.push({ tenantId: "t1" });
    h.campaigns.push(campaign());
    fake();
    const r = await runBreakdownSync(NOW, { throttle: memoryThrottle() });
    expect(r.campaigns).toBe(1);
    expect(r.rows).toBeGreaterThan(0);
    expect(r.failed).toBe(0);
  });

  it("skips demo ad accounts and accounts whose connection lapsed", async () => {
    h.campaigns.push(campaign());
    h.listAssets.mockResolvedValue([{ id: "acc1", type: "ad_account", externalId: "999", name: "Demo", status: "active", meta: { demo: true } }]);
    const sent = fake();
    expect(await syncBreakdownsTenant("t1", NOW, { throttle: memoryThrottle() })).toMatchObject({ accounts: 0, rows: 0 });
    expect(sent).toHaveLength(0);
  });
});

// =====================================================================================================================
// The rows the UI shows
// =====================================================================================================================

describe("the Results tabs (3.10)", () => {
  const range = { from: "2026-10-01", to: "2026-10-31" };
  const seedPlacements = async () =>
    put([
      breakdown({ entityMetaId: AD_PLAIN, dimension: "placement", dimKey: "instagram|reels", date: "2026-10-29", spendMinor: 100_000n, results: 30, impressions: 5000, clicks: 100, raw: { platform: "instagram", leads: 2 } }),
      breakdown({ entityMetaId: AD_PLAIN, dimension: "placement", dimKey: "instagram|reels", date: "2026-10-30", spendMinor: 42_600n, results: 16, impressions: 3000, clicks: 50, raw: { platform: "instagram", leads: 1 } }),
      breakdown({ entityMetaId: AD_PLAIN, dimension: "placement", dimKey: "facebook|feed", date: "2026-10-30", spendMinor: 90_000n, results: 20, impressions: 4000, clicks: 40, raw: { platform: "facebook", leads: 2 } }),
      breakdown({ entityMetaId: AD_PLAIN, dimension: "placement", dimKey: "facebook|right_hand_column", date: "2026-10-30", spendMinor: 12_000n, results: 0, impressions: 900 }),
      // Outside the range and another workspace: never counted.
      breakdown({ entityMetaId: AD_PLAIN, dimension: "placement", dimKey: "instagram|reels", date: "2026-09-01", spendMinor: 999_999n, results: 1 }),
      { ...breakdown({ entityMetaId: AD_PLAIN, dimension: "placement", dimKey: "instagram|reels", date: "2026-10-30", spendMinor: 1n, results: 999 }), tenantId: "t2" },
    ]);

  it("placement rows are sorted by cost per result: 'Instagram Reels: 46 chats, ₹31 each'", async () => {
    h.campaigns.push(campaign());
    await seedPlacements();
    const res = await dimensionRows("t1", "k1", "placement", range);
    expect(res.rows.map((r) => r.text)).toEqual(["Instagram Reels: 46 chats, ₹31 each", "Facebook Feed: 20 chats, ₹45 each", "Facebook right column: no chats yet, ₹120 spent"]);
    expect(res.rows[0]).toMatchObject({ key: "instagram|reels", results: 46, spendMinor: "142600", costPerResultMinor: "3100", costPerResult: "₹31" });
    expect(res).toMatchObject({ currency: "INR", goal: "whatsapp_chats", resultNoun: "chats", notes: [] });
    expect(JSON.parse(JSON.stringify(res))).toEqual(res);
  });

  it("which version worked: per ad, and per asset for per-placement-asset ads", async () => {
    h.campaigns.push(campaign());
    await seedPlacements();
    await put([
      breakdown({ entityMetaId: AD_ASSETS, dimension: "placement", dimKey: "instagram|story", date: "2026-10-30", spendMinor: 50_000n, results: 25 }),
      breakdown({ entityMetaId: AD_ASSETS, dimension: "asset_body", dimKey: "body:1001", date: "2026-10-30", spendMinor: 30_000n, results: 10, raw: { label: "Chat with us on WhatsApp" } }),
      breakdown({ entityMetaId: AD_ASSETS, dimension: "asset_image", dimKey: "image:aa", date: "2026-10-30", spendMinor: 20_000n, results: 15 }),
    ]);
    const res = await dimensionRows("t1", "k1", "creative", range);
    expect(res.rows.map((r) => r.text)).toEqual(["Version A: 25 chats, ₹20 each", "Version B: 66 chats, ₹37 each"]);
    expect(res.rows[0]).toMatchObject({ adSetId: "set-a", version: "A" });
    expect(res.assets?.map((a) => a.text)).toEqual(["Picture 1: 15 chats, ₹13 each", "Text: Chat with us on WhatsApp: 10 chats, ₹30 each"]);
  });

  it("who saw it: age and gender, and region", async () => {
    h.campaigns.push(campaign());
    await put([
      breakdown({ entityMetaId: CID, dimension: "age_gender", dimKey: "female|25-34", date: "2026-10-30", spendMinor: 8_000n, results: 4 }),
      breakdown({ entityMetaId: CID, dimension: "age_gender", dimKey: "male|18-24", date: "2026-10-30", spendMinor: 3_000n, results: 3 }),
      breakdown({ entityMetaId: CID, dimension: "age_gender", dimKey: "unknown|65+", date: "2026-10-30", spendMinor: 1_000n }),
      breakdown({ entityMetaId: CID, dimension: "region", dimKey: "Maharashtra", date: "2026-10-30", spendMinor: 20_000n, results: 5 }),
      breakdown({ entityMetaId: CID, dimension: "region", dimKey: "Unknown", date: "2026-10-30", spendMinor: 100n }),
    ]);
    expect((await dimensionRows("t1", "k1", "age_gender", range)).rows.map((r) => r.text)).toEqual(["Men 18-24: 3 chats, ₹10 each", "Women 25-34: 4 chats, ₹20 each", "Gender not known 65+: no chats yet, ₹10 spent"]);
    expect((await dimensionRows("t1", "k1", "region", range)).rows.map((r) => r.label)).toEqual(["Maharashtra", "Region not known"]);
    expect(ageGenderLabel("female|unknown")).toBe("Women age not known");
  });

  it("leads are joined per ad and platform; while Lead.platform is missing, Meta's lead counts give the split, labelled", async () => {
    h.campaigns.push(campaign());
    await put([
      breakdown({ entityMetaId: AD_ASSETS, dimension: "placement", dimKey: "instagram|stream", date: "2026-10-30", raw: { platform: "instagram", leads: 9 } }),
      breakdown({ entityMetaId: AD_PLAIN, dimension: "placement", dimKey: "instagram|reels", date: "2026-10-30", raw: { platform: "instagram", leads: 3 } }),
      breakdown({ entityMetaId: AD_PLAIN, dimension: "placement", dimKey: "facebook|feed", date: "2026-10-30", raw: { platform: "facebook", leads: 2 } }),
    ]);
    h.groupBy.mockResolvedValue([
      { adMetaId: AD_ASSETS, platform: "instagram", _count: { _all: 17 } },
      { adMetaId: AD_ASSETS, platform: "facebook", _count: { _all: 6 } },
      { adMetaId: AD_PLAIN, platform: null, _count: { _all: 5 } },
    ]);
    const res = await dimensionRows("t1", "k1", "leads", range);
    expect(h.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ by: ["adMetaId", "platform"], where: expect.objectContaining({ tenantId: "t1", adMetaId: { in: [AD_ASSETS, AD_PLAIN] }, isTest: false }) }),
    );
    const [a, b] = res.leads!.ads;
    // Every lead named its app: the Lead rows give the split, even though Meta's report says otherwise.
    expect(a).toMatchObject({ adMetaId: AD_ASSETS, name: "Version A", source: "leads", total: 23, instagram: 17, facebook: 6, note: null, platformNote: null });
    expect(a.text).toBe("Leads from this ad: 23 (Instagram 17, Facebook 6)");
    // Lead.platform missing: Meta's own counts from the placement rows, labelled.
    expect(b).toMatchObject({ adMetaId: AD_PLAIN, source: "meta_report", total: 5, instagram: 3, facebook: 2, inHub: 5, note: "From Meta's report", platformNote: "Instagram or Facebook: not reported by Meta" });
    expect(b.text).toBe("Leads from this ad: 5 (Instagram 3, Facebook 2)");
    expect(res.leads).toMatchObject({ total: 28, instagram: 20, facebook: 8, source: "meta_report", note: RESULTS_COPY.fromMetaReport });
  });

  it("without Meta's counts the unknown leads stay unknown, and a test lead never counts", () => {
    expect(leadSplit({ instagram: 1, facebook: 0, other: 0, missing: 2 }, null)).toMatchObject({ source: "leads", total: 3, instagram: 1, other: 2, platformNote: RESULTS_COPY.platformUnknown, note: null });
    expect(leadsView([{ metaAdId: "1", name: "Ad" }], [{ adMetaId: "1", platform: "whatsapp", count: 4 }], [])).toMatchObject({ total: 4, other: 4, source: "leads" });
  });

  it("a boosted post carries the paid-only note; a campaign not on Meta yet says so", async () => {
    h.campaigns.push(campaign({ id: "boost", sourceKind: "fb_post", goal: "engagement", template: "boost_post" }), campaign({ id: "draft", metaCampaignId: null }));
    const boost = await dimensionRows("t1", "boost", "placement", range);
    expect(boost.notes).toContain("Free (organic) numbers need an extra Meta permission that Edwyz hasn't asked for.");
    expect(boost.resultNoun).toBe("likes and comments");
    const draft = await dimensionRows("t1", "draft", "overview", range);
    expect(draft.notes).toContain(RESULTS_COPY.notLaunched);
    await expect(dimensionRows("t2", "k1", "placement", range)).rejects.toMatchObject({ status: 404 });
  });

  const day = (d: string) => new Date(`${d}T00:00:00.000Z`);
  const snap = (date: string, o: Record<string, unknown>) => ({ tenantId: "t1", entityType: "campaign", entityMetaId: CID, date: day(date), spendMinor: 0, impressions: 0, clicks: 0, results: 0, reach: null, ...o });

  it("before the breakdowns exist, the Overview counts the goal's results from the level sync, never another metric under the goal's name", async () => {
    // The level sync counted post engagements (OUTCOME_ENGAGEMENT's second action) on these rows.
    const engaged = { results: 1200, raw: { objective: "OUTCOME_ENGAGEMENT", resultAction: "post_engagement" } };
    h.snaps.push(snap("2026-10-30", { spendMinor: 50_000, impressions: 9000, clicks: 30, thruplays: 300, ...engaged }));

    h.campaigns.push(campaign({ goal: "video_views", template: "video_views" }));
    const video = await dimensionRows("t1", "k1", "overview", range);
    expect(video.overview).toMatchObject({ source: "snapshots", results: 300, resultsText: "300 video views", spendMinor: "50000" });

    h.campaigns[0] = campaign({ goal: "page_likes", template: "page_likes" });
    const likes = await dimensionRows("t1", "k1", "overview", range);
    expect(likes.overview).toMatchObject({ source: "snapshots", results: null, resultsText: RESULTS_COPY.notCounted, costPerResult: null, spendMinor: "50000" });

    // A chats campaign on a day without chats: post engagements were counted because chats were 0.
    h.campaigns[0] = campaign();
    const quiet = await dimensionRows("t1", "k1", "overview", range);
    expect(quiet.overview).toMatchObject({ results: 0, resultsText: "0 chats" });
  });

  it("the Overview uses the placement rows day by day, and the level sync's rows only on days without them", async () => {
    h.campaigns.push(campaign());
    await put([breakdown({ entityMetaId: AD_PLAIN, dimension: "placement", dimKey: "instagram|reels", date: "2026-10-30", spendMinor: 10_000n, impressions: 1000, clicks: 10, results: 4 })]);
    h.snaps.push(
      // 30 Oct has placement rows: its level-sync row is not added again.
      snap("2026-10-30", { spendMinor: 99_999, impressions: 1, clicks: 1, results: 99, messagingStarts: 99 }),
      // 29 Oct is before the breakdowns: it still counts.
      snap("2026-10-29", { spendMinor: 20_000, impressions: 2000, clicks: 20, results: 6, messagingStarts: 6 }),
    );
    const res = await dimensionRows("t1", "k1", "overview", range);
    expect(res.overview).toMatchObject({ source: "mixed", spendMinor: "30000", results: 10, impressions: 3000, clicks: 30, costPerResult: "₹30" });
  });

  it("snapshotResult: the level sync's count only when it is the goal's", () => {
    const CHAT_ROW = (resultAction: string | null, results: number, objective = "OUTCOME_ENGAGEMENT") => ({ results, raw: { objective, resultAction } });
    expect(snapshotResult("whatsapp_chats", { results: 50, messagingStarts: 7 })).toBe(7);
    expect(snapshotResult("whatsapp_chats", CHAT_ROW(CHAT, 9))).toBe(9);
    expect(snapshotResult("whatsapp_chats", CHAT_ROW("post_engagement", 50))).toBe(0);
    expect(snapshotResult("whatsapp_chats", CHAT_ROW(null, 0))).toBe(0);
    // A row with nothing to go by can't say.
    expect(snapshotResult("whatsapp_chats", { results: 50 })).toBeNull();
    expect(snapshotResult("video_views", { results: 50, thruplays: null, raw: {} })).toBeNull();
    expect(snapshotResult("awareness", { results: 50, raw: { resultAction: null } })).toBeNull();
    // Website visits follow the ad set's optimisation: a landing-page-views campaign never counts link clicks.
    const traffic = (resultAction: string, results: number) => ({ results, raw: { objective: "OUTCOME_TRAFFIC", resultAction } });
    expect(snapshotResult("website_visits", traffic("link_click", 5), ["landing_page_view"])).toBe(0);
    expect(snapshotResult("website_visits", traffic("landing_page_view", 3), ["landing_page_view"])).toBe(3);
    expect(snapshotResult("website_visits", traffic("link_click", 5), ["link_click"])).toBe(5);
    expect(snapshotResult("website_visits", traffic("landing_page_view", 3), ["link_click"])).toBeNull();
    // Leads: a row that counted chats had no leads.
    expect(snapshotResult("lead_form", CHAT_ROW(CHAT, 4, "OUTCOME_LEADS"))).toBe(0);
    expect(snapshotResult("profile_visits", { results: 4 })).toBe(0);
  });

  it("an awareness campaign's tabs show views, sorted by cost per 1,000 views, with the note", async () => {
    h.campaigns.push(campaign({ goal: "awareness", template: "awareness", objective: "OUTCOME_AWARENESS" }));
    // Each row's results are that day's reach: adding them up counts people twice.
    await put([
      breakdown({ entityMetaId: AD_PLAIN, dimension: "placement", dimKey: "instagram|reels", date: "2026-10-29", spendMinor: 30_000n, impressions: 12_000, results: 1200, reach: 1200 }),
      breakdown({ entityMetaId: AD_PLAIN, dimension: "placement", dimKey: "instagram|reels", date: "2026-10-30", spendMinor: 30_000n, impressions: 12_000, results: 1200, reach: 1200 }),
      breakdown({ entityMetaId: AD_PLAIN, dimension: "placement", dimKey: "facebook|feed", date: "2026-10-30", spendMinor: 40_000n, impressions: 10_000, results: 2000, reach: 2000 }),
      breakdown({ entityMetaId: CID, dimension: "region", dimKey: "Maharashtra", date: "2026-10-30", spendMinor: 20_000n, impressions: 8000, results: 900, reach: 900 }),
    ]);
    const where = await dimensionRows("t1", "k1", "placement", range);
    expect(where.measure).toBe("views");
    expect(where.rows.map((r) => r.text)).toEqual(["Instagram Reels: 24,000 views, ₹25 per 1,000 views", "Facebook Feed: 10,000 views, ₹40 per 1,000 views"]);
    expect(where.notes).toEqual([RESULTS_COPY.viewsNotReach]);
    expect((await dimensionRows("t1", "k1", "region", range)).rows[0].text).toBe("Maharashtra: 8,000 views, ₹25 per 1,000 views");
    // A chats campaign keeps its results.
    h.campaigns[0] = campaign();
    expect((await dimensionRows("t1", "k1", "placement", range)).measure).toBe("results");
  });
});

// =====================================================================================================================
// GET /api/ads/insights/dimensions
// =====================================================================================================================

describe("GET /api/ads/insights/dimensions (4.8)", () => {
  const get = (q: string, headers: Record<string, string> = {}) => new Request(`${ORIGIN}/api/ads/insights/dimensions?${q}`, { headers });
  const Q = "campaignId=k1&dimension=placement&from=2026-10-01&to=2026-10-31";

  it("answers admins with the plain rows; agents get 403, a hidden feature 404, a foreign site 403", async () => {
    const { GET } = await import("@/app/api/ads/insights/dimensions/route");
    h.campaigns.push(campaign());
    await put([breakdown({ entityMetaId: AD_PLAIN, dimension: "placement", dimKey: "instagram|reels", date: "2026-10-30", spendMinor: 142_600n, results: 46 })]);
    const ok = await GET(get(Q), undefined);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(((await ok.json()) as { rows: { text: string }[] }).rows[0].text).toBe("Instagram Reels: 46 chats, ₹31 each");

    h.getActor.mockResolvedValueOnce({ userId: "u2", tenantId: "t1", role: "agent" });
    const agent = await GET(get(Q), undefined);
    expect(agent.status).toBe(403);

    expect((await GET(get(Q, { origin: "https://evil.example" }), undefined)).status).toBe(403);
    process.env.PROMOTE_ENABLED = "off";
    expect((await GET(get(Q), undefined)).status).toBe(404);
    process.env.PROMOTE_ENABLED = "on";
  });

  it("checks its inputs and the campaign's workspace, and adds the compare verdict to the creative tab", async () => {
    const { GET } = await import("@/app/api/ads/insights/dimensions/route");
    h.campaigns.push(campaign());
    expect((await GET(get("dimension=placement&from=2026-10-01&to=2026-10-31"), undefined)).status).toBe(400);
    expect((await GET(get("campaignId=k1&dimension=funnel&from=2026-10-01&to=2026-10-31"), undefined)).status).toBe(400);
    expect((await GET(get("campaignId=k1&dimension=placement"), undefined)).status).toBe(400);
    h.getActor.mockResolvedValueOnce({ userId: "u3", tenantId: "t2", role: "owner" });
    expect((await GET(get(Q), undefined)).status).toBe(404);
    const creative = (await (await GET(get("campaignId=k1&dimension=creative&from=2026-10-01&to=2026-10-31"), undefined)).json()) as { compare: unknown; rows: unknown[] };
    expect(creative.compare).toBeNull();
    expect(creative.rows).toHaveLength(2);
  });
});
