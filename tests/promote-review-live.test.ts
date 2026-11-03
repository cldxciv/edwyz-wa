import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeNoticesDb, Row } from "./helpers/fake-notices-db";

/**
 * docs/IG-PAGE-ADS-SPEC.md 3.9 (critic: review and policy rejections in full), 4.10 and PRM-08 acceptance 4, 5 and 6
 * (promote-review-live): an ACTIVE ad that becomes DISAPPROVED is caught by the 2-hour sweep, a fully rejected ad set returns
 * pauseAndFree with the amount its commitment holds, account_status 2 or 3 returns account_quality with "Pausing still works.",
 * the per-placement and special-category lines, appeal_ad as an Opens Meta fix, and GET /api/ads/campaigns/[id]/review-status
 * (admins only, 404 while PROMOTE_ENABLED=off, English on the page and the member's Eddy language on cards).
 */

const clock = vi.hoisted(() => ({ now: new Date("2026-10-29T06:00:00.000Z") }));
const fake = vi.hoisted(() => ({ db: null as unknown as FakeNoticesDb }));
const h = vi.hoisted(() => ({ getActor: vi.fn(), userPref: vi.fn() }));

vi.mock("@/lib/db", async () => {
  const { createFakeNoticesDb } = await import("./helpers/fake-notices-db");
  fake.db = createFakeNoticesDb(() => clock.now);
  return { prisma: fake.db.client };
});
vi.mock("@/lib/auth", () => ({ getActor: h.getActor }));
vi.mock("@/lib/eddy/settings", () => ({ userPref: h.userPref }));

import { GET as reviewStatusRoute } from "@/app/api/ads/campaigns/[id]/review-status/route";
import type { AssetAccess } from "@/lib/meta-connect";
import { publishNotice, resolveNotices } from "@/lib/notices/publish";
import { formatMoney } from "@/lib/promote/copy";
import { createPromoteMeta, type AdAccountHealth } from "@/lib/promote/meta";
import { explainCampaignReview, syncAdReviews, type CampaignReviewView, type ReviewDb, type ReviewDeps } from "@/lib/promote/review";
import { createThrottle, type SettingStore } from "@/lib/promote/throttle";
import { HttpError } from "@/lib/tenancy";
import { createFakeMetaPromote, FAKE_USER_TOKEN, type FakeMetaPromote } from "./helpers/fake-meta-promote";

const T = "t_shop";
const ORIGIN = "https://wa.edwyz.com";

function memoryStore(): SettingStore {
  const rows = new Map<string, unknown>();
  return { get: async (k) => (rows.has(k) ? structuredClone(rows.get(k)) : null), set: async (k, v) => void rows.set(k, structuredClone(v)) };
}

let f: FakeMetaPromote;
let deps: Partial<ReviewDeps>;

function setup() {
  f = createFakeMetaPromote();
  vi.stubGlobal("fetch", vi.fn(f.fetch));
  const assets: Record<string, AssetAccess> = { ad_asset: { assetId: "ad_asset", type: "ad_account", externalId: "act_1", name: "Shop ads", token: FAKE_USER_TOKEN } };
  const meta = createPromoteMeta({
    access: async (_t, id) => {
      const a = assets[id];
      if (!a) throw new HttpError(404, "Asset not found.");
      return a;
    },
    sandbox: async () => false,
    store: memoryStore(),
    throttle: createThrottle({ store: memoryStore(), now: () => clock.now.getTime() }),
    env: {},
    sleep: async () => undefined,
    now: () => clock.now.getTime(),
    readTimeoutMs: 2_000,
    writeTimeoutMs: 2_000,
  });
  deps = {
    db: fake.db.client as unknown as ReviewDb,
    meta,
    publish: (input) => publishNotice(input, { db: fake.db.client as never, now: clock.now }),
    resolve: (tenantId, filter) => resolveNotices(tenantId, filter, { db: fake.db.client as never, now: clock.now }),
    now: () => clock.now,
    env: { PROMOTE_ENABLED: "on" },
  };
}

const codes = (...list: [string, string | null][]) => ({ v: 1, items: list.map(([code, placement]) => ({ code, placement })), issues: [] });

/** A launched campaign c_1 on act_1, with ad sets s_1 and s_2 and the given ads. */
function seed(opts: { assetMeta?: Row; ads?: Row[]; sets?: Row[] } = {}) {
  fake.db.seed("metaAsset", { id: "ad_asset", tenantId: T, type: "ad_account", externalId: "act_1", name: "Shop ads", meta: opts.assetMeta ?? { accountStatus: 1 } });
  fake.db.seed("adCampaign", { id: "c_1", tenantId: T, adAccountAssetId: "ad_asset", metaCampaignId: "23850000000000301", status: "active", launchedAt: new Date(clock.now.getTime() - 86_400_000), reviewState: null, reviewCheckedAt: null, advantageState: "DISABLED" });
  for (const s of opts.sets ?? [{ id: "s_1", metaAdSetId: "23850000000000201" }]) {
    fake.db.seed("adSet", { tenantId: T, campaignId: "c_1", status: "active", targeting: { placements: [] }, effectivePlacements: {}, effectiveStatus: null, createdAt: clock.now, ...s });
  }
  for (const a of opts.ads ?? []) {
    fake.db.seed("ad", { tenantId: T, adSetId: "s_1", status: "active", reviewFeedback: null, reviewCheckedAt: null, effectiveStatus: null, creative: { message: "Diwali sale" }, createdAt: clock.now, ...a, name: a.name ?? `Ad ${String(a.id)}` });
  }
}

/** An open commitment holding ₹300 a day for the ad set, ending 5 Nov (Asia/Kolkata). */
const commitment = (adSetId: string | null, extra: Row = {}) => ({
  id: `sc_${adSetId ?? "campaign"}`,
  tenantId: T,
  adAccountAssetId: "ad_asset",
  campaignId: "c_1",
  adSetId,
  metaObjectId: adSetId ? `meta_${adSetId}` : "23850000000000301",
  objectLevel: adSetId ? "adset" : "campaign",
  origin: "human",
  assistantKey: null,
  currency: "INR",
  timezone: "Asia/Kolkata",
  dailyBudgetMinor: 30_000n,
  lifetimeBudgetMinor: null,
  pendingFromMinor: null,
  dayKey: new Date("2026-10-29T00:00:00Z"),
  dayStartBudgetMinor: 30_000n,
  peakDailyBudgetMinor: 30_000n,
  weekStart: new Date("2026-10-25T00:00:00Z"),
  weekPeakDailyBudgetMinor: 30_000n,
  startsAt: new Date("2026-10-28T06:00:00Z"),
  endsAt: new Date("2026-11-05T18:29:00Z"),
  status: "live",
  reservedUntil: null,
  correlationId: null,
  sandbox: false,
  version: 1,
  ...extra,
});

const adRow = (id: string) => fake.db.rows("ad").find((a) => a.id === id) as Row;
const explain = (lang: "en" | "hi" | "hinglish" = "en", over: Partial<ReviewDeps> = {}, readAccount = true) => explainCampaignReview(T, "c_1", { lang, now: clock.now, readAccount }, { ...deps, ...over });

beforeEach(() => {
  clock.now = new Date("2026-10-29T06:00:00.000Z");
  fake.db.reset();
  h.getActor.mockReset();
  h.userPref.mockReset();
  delete process.env.PROMOTE_ENABLED;
  setup();
});
afterEach(() => {
  f.assertClean();
  vi.unstubAllGlobals();
});

// =====================================================================================================================
// The 2-hour sweep
// =====================================================================================================================

describe("rejected after approval (3.9): the 2-hour sweep", () => {
  it("catches an ACTIVE ad that becomes DISAPPROVED, which the 15-minute run never reads", async () => {
    seed({ ads: [{ id: "a_1", metaAdId: "23850000000002001", effectiveStatus: "ACTIVE", reviewFeedback: codes() }] });
    f.addReview({ id: "23850000000002001", effective_status: "DISAPPROVED", configured_status: "ACTIVE", ad_review_feedback: { global: { TEXT_OVERLAY: "Too much text." } }, adset: { id: "23850000000000201" }, creative: {} });
    expect(await syncAdReviews("review", deps)).toEqual({ checked: 0, changed: 0, failed: 0 });
    expect(adRow("a_1").effectiveStatus).toBe("ACTIVE");
    expect(await syncAdReviews("sweep", deps)).toEqual({ checked: 1, changed: 1, failed: 0 });
    expect(adRow("a_1").effectiveStatus).toBe("DISAPPROVED");
    expect(adRow("a_1").reviewFeedback).toEqual(codes(["TEXT_OVERLAY", null]));
    expect((fake.db.rows("adCampaign")[0] as Row).reviewState).toBe("rejected");
    // The same notice and timeline state as a first rejection.
    expect(fake.db.rows("notice").map((n) => [n.kind, n.dedupeKey])).toEqual([["ad_rejected", "ad-review:a_1:rejected"]]);
    const view = await explain();
    expect(view.ads[0]).toMatchObject({ state: "rejected", line: "Not approved: the picture has too much text on it" });
  });
});

// =====================================================================================================================
// [Pause and free ₹X]
// =====================================================================================================================

describe("[Pause and free ₹X] when every ad of an ad set is not approved (3.9)", () => {
  it("returns pauseAndFree with what the ad set's commitment holds, and nothing for an ad set that still runs", async () => {
    seed({
      sets: [
        { id: "s_1", metaAdSetId: "23850000000000201" },
        { id: "s_2", metaAdSetId: "23850000000000202" },
      ],
      ads: [
        { id: "a_1", adSetId: "s_1", metaAdId: "23850000000002101", effectiveStatus: "DISAPPROVED", reviewFeedback: codes(["TEXT_OVERLAY", null]) },
        { id: "a_2", adSetId: "s_1", metaAdId: "23850000000002102", effectiveStatus: "DISAPPROVED", reviewFeedback: codes(["BRAND_USAGE", null]) },
        { id: "a_3", adSetId: "s_2", metaAdId: "23850000000002103", effectiveStatus: "DISAPPROVED", reviewFeedback: codes(["TEXT_OVERLAY", null]) },
        { id: "a_4", adSetId: "s_2", metaAdId: "23850000000002104", effectiveStatus: "ACTIVE", reviewFeedback: codes() },
        { id: "a_draft", adSetId: "s_1", metaAdId: null, status: "draft" },
      ],
    });
    fake.db.seed("spendCommitment", commitment("s_1"), commitment("s_2"), commitment("s_9", { status: "stopped" }));
    const view = await explain();
    // Thu 29 Oct to the month end (Sat 31 Oct): 3 days at 1.75 x ₹300, inside the week's 7 x ₹300.
    expect(view.pauseAndFree).toEqual([
      {
        kind: "pause_and_free",
        adSetId: "s_1",
        amountMinor: 157_500,
        currency: "INR",
        label: `Pause and free ${formatMoney(157_500n, "INR")}`,
        line: `${formatMoney(157_500n, "INR")} is set aside for this ad while it's not approved.`,
      },
    ]);
    expect(view.reviewState).toBe("partly_rejected");
    expect(view.ads.map((a) => a.id)).toEqual(["a_1", "a_2", "a_3", "a_4"]);
  });

  it("a whole campaign not approved frees a campaign-level commitment too; a stopped or ended one frees nothing", async () => {
    seed({ ads: [{ id: "a_1", metaAdId: "23850000000002201", effectiveStatus: "DISAPPROVED", reviewFeedback: codes(["TEXT_OVERLAY", null]) }] });
    fake.db.seed("spendCommitment", commitment(null), commitment("s_1", { endsAt: new Date("2026-10-20T00:00:00Z") }));
    const view = await explain();
    expect(view.pauseAndFree.map((p) => [p.adSetId, p.amountMinor])).toEqual([[null, 157_500]]);
    fake.db.reset();
    seed({ ads: [{ id: "a_1", metaAdId: "23850000000002201", effectiveStatus: "DISAPPROVED", reviewFeedback: codes(["TEXT_OVERLAY", null]) }] });
    fake.db.seed("spendCommitment", commitment("s_1", { status: "stopped" }));
    expect((await explain()).pauseAndFree).toEqual([]);
  });
});

// =====================================================================================================================
// Account restrictions, the per-placement line, the special category, appeal_ad
// =====================================================================================================================

describe("account restrictions (account_status 2 or 3)", () => {
  it("account_status 2 returns account_quality and says pausing still works; Start is blocked", async () => {
    seed({ assetMeta: { accountStatus: 2, disableReason: 1 } });
    const view = await explain();
    expect(view.account).toEqual({
      restricted: true,
      accountStatus: 2,
      disableReason: 1,
      line: "Meta has limited ads on Shop ads. Pausing still works.",
      blocksStart: true,
      fix: { kind: "opens_meta", key: "account_quality", label: null },
    });
    expect((await explain("hi")).account?.line).toMatch(/\p{Script=Devanagari}/u);
  });

  it("account_status 3 is restricted too, read from Meta when it is not stored; 1 and a failed read are not", async () => {
    seed({ assetMeta: {} });
    const health = (accountStatus: number): AdAccountHealth => ({ accountStatus, disableReason: 0, currency: "INR", timezone: "Asia/Kolkata", businessId: null, tosAccepted: {}, userTosAccepted: {}, fundingPresent: true });
    const read = vi.fn(async () => health(3));
    const view = await explain("en", { meta: { ...(deps.meta as ReviewDeps["meta"]), getAdAccountHealth: read } });
    expect(read).toHaveBeenCalledWith({ tenantId: T, adAccountAssetId: "ad_asset" });
    expect(view.account).toMatchObject({ accountStatus: 3, fix: { kind: "opens_meta", key: "account_quality" } });
    expect((await explain("en", { meta: { ...(deps.meta as ReviewDeps["meta"]), getAdAccountHealth: async () => health(1) } })).account).toBeNull();
    const failing = async (): Promise<AdAccountHealth> => {
      throw new HttpError(504, "Meta took too long to answer.");
    };
    expect((await explain("en", { meta: { ...(deps.meta as ReviewDeps["meta"]), getAdAccountHealth: failing } })).account).toBeNull();
    // Without the read (an Eddy lookup that must not call Meta), an unknown status is simply not shown.
    expect((await explain("en", { meta: { ...(deps.meta as ReviewDeps["meta"]), getAdAccountHealth: read } }, false)).account).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("reasons, lines and fixes", () => {
  it("a per-placement rejection says where it is not approved and where it still runs, with [Fix the ad] and appeal_ad", async () => {
    seed({ ads: [{ id: "a_1", metaAdId: "23850000000002301", effectiveStatus: "ACTIVE", reviewFeedback: codes(["TEXT_OVERLAY", "instagram"]) }] });
    const view = await explain();
    expect(view.ads[0].state).toBe("partly_rejected");
    expect(view.ads[0].line).toBe("Not approved on Instagram: the picture has too much text on it. It still runs on Facebook.");
    expect(view.ads[0].reasons[0]).toMatchObject({ code: "TEXT_OVERLAY", placement: "instagram", fix: "edit_media" });
    expect(view.ads[0].fixes).toEqual([
      { kind: "fix_ad", label: "Fix the ad" },
      { kind: "opens_meta", key: "appeal_ad", label: "Ask Meta to review again" },
    ]);
    const hinglish = await explain("hinglish");
    expect(hinglish.ads[0].line).not.toMatch(/\p{Script=Devanagari}/u);
    expect(hinglish.lang).toBe("hinglish");
  });

  it("a special-category rejection says what the ad is about, and [Fix the ad] carries the category", async () => {
    seed({ ads: [{ id: "a_1", metaAdId: "23850000000002401", effectiveStatus: "DISAPPROVED", reviewFeedback: codes(["FINANCIAL_PRODUCTS", null]) }] });
    const view = await explain();
    expect(view.ads[0].reasons[0]).toMatchObject({ fix: "set_category", category: "credit", line: "Meta says this ad is about loans or credit. Mark it as that and run it again." });
    expect(view.ads[0].fixes[0]).toEqual({ kind: "fix_ad", label: "Fix the ad", category: "credit" });
    expect(view.ads[0].fixes[1]).toMatchObject({ kind: "opens_meta", key: "appeal_ad" });
  });

  it("dropped positions, in review, running, and an ad the sync has not read yet (Meta's own words from the structure sync)", async () => {
    seed({
      sets: [{ id: "s_1", metaAdSetId: "23850000000000201", effectivePlacements: { automatic: false, platforms: ["facebook"], positions: { facebook: ["feed"] }, dropped: ["facebook_stories"], checkedAt: "x" } }],
      ads: [
        { id: "a_review", metaAdId: "23850000000002501", effectiveStatus: "PENDING_REVIEW", reviewFeedback: codes() },
        { id: "a_live", metaAdId: "23850000000002502", effectiveStatus: "ACTIVE", reviewFeedback: codes() },
        { id: "a_legacy", metaAdId: "23850000000002503", creative: { message: "Diwali sale", metaReview: { state: "rejected", metaStatus: "DISAPPROVED", reasons: ["Ads can't promise guaranteed results."], checkedAt: "2026-10-28T00:00:00Z" } } },
      ],
    });
    const view = await explain();
    expect(view.dropped).toEqual([{ adSetId: "s_1", placement: "facebook_stories", line: "Meta isn't showing this on Facebook Stories any more" }]);
    expect(view.ads.map((a) => [a.id, a.state, a.line])).toEqual([
      ["a_review", "in_review", "Meta is reviewing"],
      ["a_live", "approved", "Running"],
      ["a_legacy", "rejected", "Not approved: Meta gave this reason: Ads can't promise guaranteed results."],
    ]);
    // The view never carries the ad's text.
    expect(JSON.stringify(view)).not.toContain("Diwali");
  });

  it("another workspace's campaign is not found", async () => {
    seed();
    await expect(explainCampaignReview("t_other", "c_1", { readAccount: false }, deps)).rejects.toMatchObject({ status: 404 });
    await expect(explainCampaignReview(T, "../c_1", { readAccount: false }, deps)).rejects.toMatchObject({ status: 404 });
  });
});

// =====================================================================================================================
// GET /api/ads/campaigns/[id]/review-status
// =====================================================================================================================

describe("GET /api/ads/campaigns/[id]/review-status (explain_ad_rejection)", () => {
  const get = (id = "c_1", query = "") => reviewStatusRoute(new Request(`${ORIGIN}/api/ads/campaigns/${id}/review-status${query}`), { params: Promise.resolve({ id }) });

  beforeEach(() => {
    seed({ ads: [{ id: "a_1", metaAdId: "23850000000002601", effectiveStatus: "DISAPPROVED", reviewFeedback: codes(["TEXT_OVERLAY", null]) }] });
    h.getActor.mockResolvedValue({ userId: "u_admin", tenantId: T, role: "admin" });
    h.userPref.mockResolvedValue({ language: "hi" });
  });

  it("answers 404 while PROMOTE_ENABLED is off, before reading the member", async () => {
    expect((await get()).status).toBe(404);
    expect(h.getActor).not.toHaveBeenCalled();
  });

  it("is for admins and owners only", async () => {
    process.env.PROMOTE_ENABLED = "on";
    h.getActor.mockResolvedValue({ userId: "u_agent", tenantId: T, role: "agent" });
    expect((await get()).status).toBe(403);
    h.getActor.mockResolvedValue({ userId: "u_owner", tenantId: T, role: "owner" });
    expect((await get()).status).toBe(200);
  });

  it("pages are in English; cards are in the member's Eddy language; Auto is English", async () => {
    process.env.PROMOTE_ENABLED = "on";
    const page = await get();
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    const pageBody = (await page.json()) as { review: CampaignReviewView };
    expect(pageBody.review.lang).toBe("en");
    expect(pageBody.review.ads[0].line).toBe("Not approved: the picture has too much text on it");
    expect(pageBody.review.ads[0].fixes).toContainEqual({ kind: "opens_meta", key: "appeal_ad", label: "Ask Meta to review again" });
    const card = (await (await get("c_1", "?for=card")).json()) as { review: CampaignReviewView };
    expect(card.review.lang).toBe("hi");
    expect(card.review.ads[0].line).toMatch(/\p{Script=Devanagari}/u);
    h.userPref.mockResolvedValue({ language: "auto" });
    expect(((await (await get("c_1", "?for=card")).json()) as { review: CampaignReviewView }).review.lang).toBe("en");
  });

  it("never shows another workspace's campaign", async () => {
    process.env.PROMOTE_ENABLED = "on";
    h.getActor.mockResolvedValue({ userId: "u_x", tenantId: "t_other", role: "owner" });
    expect((await get()).status).toBe(404);
    expect((await get("nope")).status).toBe(404);
  });
});
