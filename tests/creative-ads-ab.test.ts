import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  brand: { findMany: vi.fn() },
  creativeAsset: { findFirst: vi.fn(), findMany: vi.fn() },
  phoneNumber: { findFirst: vi.fn(), findMany: vi.fn() },
  adCampaign: { create: vi.fn() },
  adSet: { create: vi.fn() },
  ad: { create: vi.fn() },
  $transaction: vi.fn(),
}));
const connect = vi.hoisted(() => ({ listAssets: vi.fn(), getAssetAccess: vi.fn() }));
const limits = vi.hoisted(() => ({ assertAdAccountAllowed: vi.fn(), adAccountsBlockedByPlan: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/meta-connect", () => connect);
vi.mock("@/lib/auth/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/billing/limits", () => limits);
vi.mock("@/lib/approvals", () => ({ isCampaignClientApproved: vi.fn(), listApprovals: vi.fn(async () => []) }));
vi.mock("@/lib/ads/caps", async (orig) => ({ ...(await orig<typeof import("@/lib/ads/caps")>()), getCaps: async () => ({ maxDailyBudgetMinor: null, currency: null }) }));
vi.mock("@/lib/creative", async () => {
  const { siteUrl } = await import("@/lib/config");
  return { signedAssetUrl: (t: string, a: string, ttl: number) => `${siteUrl()}/api/creative/public/${t}/${a}?exp=${ttl}&sig=abc` };
});

import { adOptions, createCampaignDraft, parseDraftInput } from "@/lib/ads/service";
import { withFreshAssetImage } from "@/lib/ads/asset-image";
import { adTextReady, buildAdList, MAX_ADS } from "@/components/ads/helpers";
import { siteUrl } from "@/lib/config";
import type { Actor } from "@/lib/tenancy";

const actor = { userId: "u1", tenantId: "t1", role: "admin" } as Actor;
const targeting = { geo: { countries: ["IN"], cities: [] }, ageMin: 18, ageMax: 65, genders: [], interests: [], placements: [], lookalikeAudienceIds: [] };
const shared = { pageId: "page1", message: "", headline: "", link: "https://example.com", leadFormId: "", whatsappNumberId: "" };

const assets: Record<string, Record<string, unknown>> = {
  c1: { id: "c1", tenantId: "t1", kind: "image", status: "approved", headline: "Free check-up", body: null, storageKey: "c1.png", policyCheck: { result: "pass" } },
  c2: { id: "c2", tenantId: "t1", kind: "copy", status: "ready", headline: "Smile more", body: "Book a visit today", storageKey: null, policyCheck: { result: "warn" } },
  c3: { id: "c3", tenantId: "t1", kind: "image", status: "ready", headline: "Preview", body: null, storageKey: "c3.svg", policyCheck: { result: "pass" } },
};

beforeEach(() => {
  vi.resetAllMocks();
  db.creativeAsset.findFirst.mockImplementation(async ({ where }: { where: { id: string; tenantId: string } }) => (where.tenantId === "t1" ? assets[where.id] ?? null : null));
  db.creativeAsset.findMany.mockResolvedValue([]);
  db.brand.findMany.mockResolvedValue([]);
  db.adCampaign.create.mockResolvedValue({ id: "camp1" });
  db.adSet.create.mockResolvedValue({ id: "set1" });
  db.ad.create.mockResolvedValue({ id: "adx" });
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  limits.adAccountsBlockedByPlan.mockResolvedValue(new Set());
  connect.listAssets.mockImplementation(async (_t: string, type: string) => {
    if (type === "ad_account") return [{ id: "acc1", externalId: "1", name: "Main", meta: { currency: "INR" }, status: "active" }];
    if (type === "page") return [{ id: "pg", externalId: "page1", name: "Page", meta: {}, status: "active" }];
    return [];
  });
});

const body = (ads: unknown[]) => ({
  name: "Spring offer", template: "traffic", adAccountAssetId: "acc1", dailyBudgetMinor: 50000, specialAdCategory: "none", confirmNoSpecialCategory: true,
  targeting, ads,
});

describe("one ad per selected creative", () => {
  it("creates every ad in the same ad set, each linked to its creative", async () => {
    const input = parseDraftInput(body(["c1", "c2"].map((id, i) => ({ name: `Spring offer - ad ${"AB"[i]}`, creativeAssetId: id, creative: shared }))));
    const res = await createCampaignDraft(actor, input);
    expect(res.campaignId).toBe("camp1");
    expect(db.adSet.create).toHaveBeenCalledTimes(1);
    expect(db.ad.create).toHaveBeenCalledTimes(2);
    const ads = db.ad.create.mock.calls.map((c) => c[0].data);
    expect(ads.map((a) => a.adSetId)).toEqual(["set1", "set1"]);
    expect(ads.map((a) => a.creativeAssetId)).toEqual(["c1", "c2"]);
    expect(ads.map((a) => a.name)).toEqual(["Spring offer - ad A", "Spring offer - ad B"]);
    expect(ads.every((a) => a.tenantId === "t1")).toBe(true);
  });

  it("a saved picture becomes the ad image through a signed link; a text creative keeps the typed picture", async () => {
    const input = parseDraftInput(body([
      { name: "A", creativeAssetId: "c1", creative: { ...shared, message: "Visit us" } },
      { name: "B", creativeAssetId: "c2", creative: { ...shared, imageUrl: "https://example.com/pic.jpg" } },
    ]));
    await createCampaignDraft(actor, input);
    const [a, b] = db.ad.create.mock.calls.map((c) => c[0].data.creative);
    expect(a.imageUrl).toMatch(/\/api\/creative\/public\/t1\/c1\?/);
    expect(a.headline).toBe("Free check-up");
    expect(b).toMatchObject({ imageUrl: "https://example.com/pic.jpg", message: "Book a visit today", headline: "Smile more" });
  });

  it("never turns a placeholder (SVG) preview into an ad image", async () => {
    const input = parseDraftInput(body([{ name: "A", creativeAssetId: "c3", creative: { ...shared, message: "Hi" } }]));
    await createCampaignDraft(actor, input);
    expect(db.ad.create.mock.calls[0][0].data.creative.imageUrl).toBeUndefined();
  });

  it("will not use a creative from another workspace", async () => {
    const input = parseDraftInput(body([{ name: "A", creativeAssetId: "foreign", creative: { ...shared, message: "Hi" } }]));
    await expect(createCampaignDraft(actor, input)).rejects.toMatchObject({ status: 404 });
    expect(db.ad.create).not.toHaveBeenCalled();
    expect(db.creativeAsset.findFirst.mock.calls[0][0].where).toEqual({ id: "foreign", tenantId: "t1" });
  });

  it("checks the plan's ad account limit before anything is saved", async () => {
    limits.assertAdAccountAllowed.mockRejectedValue(Object.assign(new Error("Your plan allows up to 1 ad accounts"), { status: 402 }));
    const input = parseDraftInput(body([{ name: "A", creativeAssetId: "c2", creative: { ...shared, imageUrl: "https://example.com/p.jpg" } }]));
    await expect(createCampaignDraft(actor, input)).rejects.toMatchObject({ status: 402 });
    expect(limits.assertAdAccountAllowed).toHaveBeenCalledWith("t1", "acc1");
    expect(db.adCampaign.create).not.toHaveBeenCalled();
  });

  it("refuses the same creative twice in one ad set", () => {
    const dup = body([{ name: "A", creativeAssetId: "c1", creative: shared }, { name: "B", creativeAssetId: "c1", creative: shared }]);
    expect(() => parseDraftInput(dup)).toThrow(/different creative/);
  });

  it("saves the campaign, ad set and all ads in one transaction, so a failing ad leaves nothing behind", async () => {
    const store = { campaigns: [] as string[] };
    db.adCampaign.create.mockImplementation(async () => (store.campaigns.push("camp1"), { id: "camp1" }));
    db.ad.create.mockRejectedValueOnce(new Error("db down"));
    db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const before = [...store.campaigns];
      try {
        return await fn(db);
      } catch (e) {
        store.campaigns = before;
        throw e;
      }
    });
    const input = parseDraftInput(body(["c1", "c2"].map((id) => ({ name: id, creativeAssetId: id, creative: shared }))));
    await expect(createCampaignDraft(actor, input)).rejects.toThrow("db down");
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(store.campaigns).toEqual([]);
  });

  it("accepts up to ten ads and refuses eleven", () => {
    const many = (n: number) => body(Array.from({ length: n }, (_, i) => ({ name: `ad ${i}`, creativeAssetId: `c${i}`, creative: shared })));
    expect(parseDraftInput(many(10)).ads).toHaveLength(10);
    expect(() => parseDraftInput(many(11))).toThrow(/1 to 10 ads/);
  });
});

describe("creative options for the wizard", () => {
  it("flags usable pictures and blocked items, and never exposes storage keys", async () => {
    db.creativeAsset.findMany.mockResolvedValue([
      { id: "c1", kind: "image", headline: "A", body: null, placement: "feed", status: "approved", storageKey: "c1.png", policyCheck: { result: "pass" } },
      { id: "c3", kind: "image", headline: "B", body: null, placement: "feed", status: "ready", storageKey: "c3.svg", policyCheck: { result: "pass" } },
      { id: "c4", kind: "copy", headline: "C", body: "x", placement: "feed", status: "ready", storageKey: null, policyCheck: { result: "block" } },
    ]);
    db.phoneNumber.findMany.mockResolvedValue([]);
    const out = await adOptions("t1");
    expect(out.creativeAssets.map((a) => [a.id, a.status, a.hasImage, a.blocked])).toEqual([
      ["c1", "approved", true, false],
      ["c3", "ready", false, false],
      ["c4", "ready", false, true],
    ]);
    expect(JSON.stringify(out.creativeAssets)).not.toContain("storageKey");
    expect(db.creativeAsset.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: "t1" });
  });
});

describe("ad accounts the plan does not cover", () => {
  it("flags them so the wizard can disable them before the 402", async () => {
    limits.adAccountsBlockedByPlan.mockResolvedValue(new Set(["acc1"]));
    db.phoneNumber.findMany.mockResolvedValue([]);
    const out = await adOptions("t1");
    expect(out.adAccounts).toEqual([{ id: "acc1", externalId: "1", name: "Main", currency: "INR", timezone: null, planBlocked: true }]);
    expect(limits.adAccountsBlockedByPlan).toHaveBeenCalledWith("t1", ["acc1"]);
  });
});

describe("fresh picture link at launch", () => {
  it("re-signs a link that came from a saved creative and leaves typed links alone", async () => {
    const stale = `${siteUrl()}/api/creative/public/t1/c1?exp=1&sig=old`;
    const fresh = await withFreshAssetImage("t1", "c1", { pageId: "p", message: "m", imageUrl: stale });
    expect(fresh.imageUrl).not.toBe(stale);
    expect(fresh.imageUrl).toMatch(/\/api\/creative\/public\/t1\/c1\?exp=86400/);
    const typed = { pageId: "p", message: "m", imageUrl: "https://example.com/pic.jpg" };
    expect(await withFreshAssetImage("t1", "c1", typed)).toBe(typed);
    expect((await withFreshAssetImage("t1", null, { pageId: "p", message: "m", imageUrl: stale })).imageUrl).toBe(stale);
  });
});

describe("wizard ad list", () => {
  const sharedFields = { pageId: "page1", instagramId: "", link: "https://example.com", imageUrl: "", leadFormId: "", whatsappNumberId: "", welcomeMessage: "", postId: "" };
  const picked = [
    { id: "c1", headline: "Free check-up", body: null },
    { id: "c2", headline: "Smile more", body: "Book a visit today" },
    { id: "c3", headline: null, body: null },
  ];

  it("no creative: one ad from the typed text", () => {
    const ads = buildAdList({ campaignName: "Spring", picked: [], shared: sharedFields, message: "Hello", headline: "H" });
    expect(ads).toHaveLength(1);
    expect(ads[0]).toMatchObject({ name: "Spring ad", creativeAssetId: null, creative: { message: "Hello", headline: "H", pageId: "page1" } });
  });

  it("one creative: one ad with the text as typed", () => {
    const ads = buildAdList({ campaignName: "Spring", picked: [picked[1]], shared: sharedFields, message: "Book a visit today", headline: "Smile more" });
    expect(ads).toHaveLength(1);
    expect(ads[0]).toMatchObject({ name: "Spring ad", creativeAssetId: "c2", creative: { message: "Book a visit today" } });
  });

  it("several creatives: one ad each, lettered, with the creative's own text winning over the shared text", () => {
    const ads = buildAdList({ campaignName: "Spring", picked, shared: sharedFields, message: "Shared text", headline: "Shared headline" });
    expect(ads.map((a) => a.name)).toEqual(["Spring - ad A", "Spring - ad B", "Spring - ad C"]);
    expect(ads.map((a) => a.creativeAssetId)).toEqual(["c1", "c2", "c3"]);
    expect(ads.map((a) => [a.creative.message, a.creative.headline])).toEqual([
      ["Shared text", ""],
      ["", ""],
      ["Shared text", "Shared headline"],
    ]);
  });

  it("never sends more than ten ads", () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ id: `c${i}`, headline: null, body: "b" }));
    expect(buildAdList({ campaignName: "S", picked: many, shared: sharedFields, message: "", headline: "" })).toHaveLength(MAX_ADS);
  });

  it("is ready with typed text, or when every creative brings its own", () => {
    expect(adTextReady("", [])).toBe(false);
    expect(adTextReady("  x ", [])).toBe(true);
    expect(adTextReady("", [picked[1], { id: "c9", headline: null, body: "b" }])).toBe(true);
    expect(adTextReady("", picked)).toBe(false);
    expect(adTextReady("", [picked[1]])).toBe(false);
  });
});
