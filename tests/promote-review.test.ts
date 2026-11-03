import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeNoticesDb, Row } from "./helpers/fake-notices-db";

/**
 * docs/IG-PAGE-ADS-SPEC.md 3.9, 4.2 R1 and R2, 4.9, 4.10, 5.1 and PRM-08 acceptance 3 (promote-review): R1 in batches of 50 ids
 * with the filtering IN shape (never ?ids=) at priority 2, at least 25 feedback codes in plain words with fix kinds in three
 * languages, Ad.reviewFeedback with codes and placements only, partly_rejected for a per-placement rejection, the effective
 * placements and advantage_state_info read once after launch, one deduplicated notice on approval and one on rejection, and
 * notices that carry ids and codes only. Meta is the fake of 9.3; the database is the in-memory stand-in.
 */

const clock = vi.hoisted(() => ({ now: new Date("2026-10-29T06:00:00.000Z") }));
const fake = vi.hoisted(() => ({ db: null as unknown as FakeNoticesDb }));

vi.mock("@/lib/db", async () => {
  const { createFakeNoticesDb } = await import("./helpers/fake-notices-db");
  fake.db = createFakeNoticesDb(() => clock.now);
  return { prisma: fake.db.client };
});

import { readAdReview, reviewFromMeta } from "@/lib/ads/review";
import { hasKey } from "@/lib/eddy/i18n";
import "@/lib/eddy/copy/notices";
import type { AssetAccess } from "@/lib/meta-connect";
import { cleanPayload, KIND_SPECS, NOTICE_KINDS, PAYLOAD_KEYS, SAFE_VALUE, supersededSpendRow, textKeyFor } from "@/lib/notices/kinds";
import { publishNotice, resolveNotices } from "@/lib/notices/publish";
import { createPromoteMeta, PROMOTE_CALLS, REVIEW_BATCH, type PromoteMeta } from "@/lib/promote/meta";
import {
  adReviewState,
  adSetStatusFromAds,
  announcesFor,
  campaignReviewState,
  effectivePlacementsOf,
  explainCampaignReview,
  NEW_AD_NOTICE_WINDOW_MS,
  readStoredFeedback,
  REVIEW_SYNC_MAX_ADS,
  reviewNoticeFor,
  START_AUDIT_ACTIONS,
  storedFeedbackOf,
  syncAdReviews,
  type ReviewDb,
  type ReviewDeps,
  type StoredFeedback,
} from "@/lib/promote/review";
import { REVIEW_REASONS } from "@/lib/promote/review-reasons";
import { runReviewSweep, runReviewSync } from "@/lib/promote/tasks/review";
import { createThrottle, PRIORITY, type SettingStore } from "@/lib/promote/throttle";
import { REVIEW_FIX_KINDS } from "@/lib/promote/types";
import { HttpError } from "@/lib/tenancy";
import { createFakeMetaPromote, FAKE_USER_TOKEN, type FakeMetaPromote } from "./helpers/fake-meta-promote";

const T = "t_shop";
const META_CAMPAIGN = "23850000000000301";
const META_SET = "23850000000000201";
const AD_TEXT = "Diwali sale: 50% off all sarees this week only";
const META_TEXT = "Your ad's image has too much text.";

function memoryStore(): SettingStore {
  const rows = new Map<string, unknown>();
  return { get: async (k) => (rows.has(k) ? structuredClone(rows.get(k)) : null), set: async (k, v) => void rows.set(k, structuredClone(v)) };
}

type World = { meta: PromoteMeta; f: FakeMetaPromote; deps: Partial<ReviewDeps>; check: ReturnType<typeof vi.fn>; fetches: () => number };

function world(): World {
  const f = createFakeMetaPromote();
  f.base.addAccount({ id: "act_2" });
  const fetch = vi.fn(f.fetch);
  vi.stubGlobal("fetch", fetch);
  const assets: Record<string, AssetAccess> = {
    ad_asset: { assetId: "ad_asset", type: "ad_account", externalId: "act_1", name: "Shop ads", token: FAKE_USER_TOKEN },
    ad_asset_2: { assetId: "ad_asset_2", type: "ad_account", externalId: "act_2", name: "Second", token: FAKE_USER_TOKEN },
  };
  const throttle = createThrottle({ store: memoryStore(), now: () => clock.now.getTime() });
  const check = vi.fn(throttle.check);
  const meta = createPromoteMeta({
    access: async (_t, id) => {
      const a = assets[id];
      if (!a) throw new HttpError(404, "Asset not found.");
      return a;
    },
    sandbox: async () => false,
    store: memoryStore(),
    throttle: { ...throttle, check },
    env: {},
    sleep: async () => undefined,
    now: () => clock.now.getTime(),
    readTimeoutMs: 2_000,
    writeTimeoutMs: 2_000,
  });
  const db = fake.db.client as unknown as ReviewDb;
  return {
    meta,
    f,
    check,
    fetches: () => fetch.mock.calls.length,
    deps: {
      db,
      meta,
      publish: (input) => publishNotice(input, { db: fake.db.client as never, now: clock.now }),
      resolve: (tenantId, filter) => resolveNotices(tenantId, filter, { db: fake.db.client as never, now: clock.now }),
      now: () => clock.now,
      env: { PROMOTE_ENABLED: "on" },
    },
  };
}

type AdSeed = { id: string; metaAdId: string; effectiveStatus?: string | null; reviewFeedback?: unknown; creative?: Row; adSetId?: string; status?: string };

/** One workspace, one launched campaign on act_1 with one ad set, and the given ads. */
function seed(ads: AdSeed[], opts: { launchedAt?: Date; placements?: string[]; assetMeta?: Row; campaign?: Row } = {}) {
  fake.db.seed("metaAsset", { id: "ad_asset", tenantId: T, type: "ad_account", externalId: "act_1", name: "Shop ads", meta: opts.assetMeta ?? { accountStatus: 1 } });
  fake.db.seed("adCampaign", {
    id: "c_1",
    tenantId: T,
    adAccountAssetId: "ad_asset",
    metaCampaignId: META_CAMPAIGN,
    status: "active",
    launchedAt: opts.launchedAt ?? new Date(clock.now.getTime() - 3_600_000),
    reviewState: null,
    reviewCheckedAt: null,
    advantageState: null,
    ...opts.campaign,
  });
  fake.db.seed("adSet", { id: "s_1", tenantId: T, campaignId: "c_1", metaAdSetId: META_SET, status: "active", targeting: { placements: opts.placements ?? [] }, effectivePlacements: null, effectiveStatus: null });
  for (const a of ads) {
    fake.db.seed("ad", {
      id: a.id,
      tenantId: T,
      adSetId: a.adSetId ?? "s_1",
      metaAdId: a.metaAdId,
      name: `Ad ${a.id}`,
      status: a.status ?? "active",
      effectiveStatus: a.effectiveStatus ?? null,
      reviewFeedback: a.reviewFeedback ?? null,
      reviewCheckedAt: null,
      creative: a.creative ?? { pageId: "104857600123", message: AD_TEXT, headline: "Sarees" },
    });
  }
}

const review = (id: string, status: string, extra: Partial<{ ad_review_feedback: Row; issues_info: Row[]; targeting: Row }> = {}) => ({
  id,
  effective_status: status,
  configured_status: "ACTIVE",
  ...(extra.ad_review_feedback ? { ad_review_feedback: extra.ad_review_feedback } : {}),
  ...(extra.issues_info ? { issues_info: extra.issues_info } : {}),
  adset: { id: META_SET, ...(extra.targeting ? { targeting: extra.targeting } : {}) },
  creative: {},
});

const adRow = (id: string) => fake.db.rows("ad").find((a) => a.id === id) as Row;
const campaignRow = () => fake.db.rows("adCampaign").find((c) => c.id === "c_1") as Row;
const setRow = () => fake.db.rows("adSet").find((s) => s.id === "s_1") as Row;
const notices = () => fake.db.rows("notice");
const openNotices = () => notices().filter((n) => !n.resolvedAt);

/**
 * The stand-in database with the ad queue ordered as Postgres orders the sync's query (reviewCheckedAt NULLS FIRST, then id);
 * the stand-in itself always sorts nulls last.
 */
function postgresOrdered(): ReviewDb {
  const client = fake.db.client as unknown as ReviewDb;
  const at = (r: Row) => (r.reviewCheckedAt instanceof Date ? r.reviewCheckedAt.getTime() : null);
  return {
    ad: {
      findMany: async (a) => {
        const { orderBy: _orderBy, take, select, ...rest } = a as { orderBy?: unknown; take?: number; select?: Row };
        const rows = await client.ad.findMany({ ...rest, ...(select ? { select: { ...select, reviewCheckedAt: true } } : {}) });
        rows.sort((x, y) => {
          const [tx, ty] = [at(x), at(y)];
          if (tx !== ty) return tx === null ? -1 : ty === null ? 1 : tx - ty;
          return String(x.id) < String(y.id) ? -1 : 1;
        });
        return take === undefined ? rows : rows.slice(0, take);
      },
      updateMany: (a) => client.ad.updateMany(a),
    },
    adSet: client.adSet,
    adCampaign: client.adCampaign,
    metaAsset: client.metaAsset,
    spendCommitment: client.spendCommitment,
    auditLog: client.auditLog,
  };
}

let w: World;
beforeEach(() => {
  clock.now = new Date("2026-10-29T06:00:00.000Z");
  fake.db.reset();
  w = world();
});
afterEach(() => {
  w.f.assertClean();
  vi.unstubAllGlobals();
});

// =====================================================================================================================
// R1: batches of 50, the filtering IN shape, priority 2
// =====================================================================================================================

describe("R1: act_X/ads filtering on id IN batches of 50, never ?ids=", () => {
  it("reads 120 ads in three requests of at most 50 ids, through the ad account, at throttle priority 2", async () => {
    const ads = Array.from({ length: 120 }, (_, i) => ({ id: `a_${i}`, metaAdId: (23850000000100000n + BigInt(i)).toString() }));
    seed(ads);
    for (const a of ads) w.f.addReview(review(a.metaAdId, "PENDING_REVIEW"));
    const result = await syncAdReviews("review", w.deps);
    expect(result).toEqual({ checked: 120, changed: 120, failed: 0 });
    const reads = w.f.calls.filter((c) => c.path === "act_1/ads");
    expect(reads).toHaveLength(3);
    expect(REVIEW_BATCH).toBe(50);
    const seen: string[] = [];
    for (const c of reads) {
      expect(c.method).toBe("GET");
      expect(c.query).not.toHaveProperty("ids");
      const filtering = JSON.parse(c.query.filtering) as { field: string; operator: string; value: string[] }[];
      expect(filtering).toHaveLength(1);
      expect(filtering[0]).toMatchObject({ field: "id", operator: "IN" });
      expect(filtering[0].value.length).toBeLessThanOrEqual(50);
      expect(c.query.fields).toContain("ad_review_feedback");
      expect(c.tokenKind).toBe("user");
      seen.push(...filtering[0].value);
    }
    expect(new Set(seen)).toEqual(new Set(ads.map((a) => a.metaAdId)));
    expect(w.f.calls.some((c) => c.path === "" || "ids" in c.query)).toBe(false);
    expect(PROMOTE_CALLS.R1.priority).toBe(PRIORITY.review);
    expect(PRIORITY.review).toBe(2);
    const priorities = w.check.mock.calls.filter(([scope]) => scope === "act_1").map(([, p]) => p);
    expect(priorities.length).toBeGreaterThan(0);
    expect(new Set(priorities)).toEqual(new Set([2]));
  });

  it("the 15-minute run reads ads in review, with issues, not approved, not read yet, and started ads Meta last showed paused; the sweep reads every started ad", async () => {
    seed([
      { id: "a_pending", metaAdId: "23850000000000501", effectiveStatus: "PENDING_REVIEW" },
      { id: "a_issues", metaAdId: "23850000000000502", effectiveStatus: "WITH_ISSUES" },
      { id: "a_no", metaAdId: "23850000000000503", effectiveStatus: "DISAPPROVED" },
      { id: "a_new", metaAdId: "23850000000000504", effectiveStatus: null },
      { id: "a_live", metaAdId: "23850000000000505", effectiveStatus: "ACTIVE" },
      // Started (Ad.status active) after Meta last said PAUSED: what Meta says now must be read.
      { id: "a_paused", metaAdId: "23850000000000506", effectiveStatus: "PAUSED" },
      { id: "a_billing", metaAdId: "23850000000000508", effectiveStatus: "PENDING_BILLING_INFO" },
      { id: "a_archived", metaAdId: "23850000000000507", effectiveStatus: "PENDING_REVIEW", status: "archived" },
      // Launched paused and never started: nothing new to read while it stays off.
      { id: "a_waiting", metaAdId: "23850000000000509", effectiveStatus: "CAMPAIGN_PAUSED", status: "paused" },
    ]);
    for (const id of ["501", "502", "503", "504", "505", "506", "507", "508", "509"]) w.f.addReview(review(`23850000000000${id}`, "PENDING_REVIEW"));
    expect((await syncAdReviews("review", w.deps)).checked).toBe(6);
    const asked = (path: string) => w.f.calls.filter((c) => c.path === path).flatMap((c) => (JSON.parse(c.query.filtering) as { value: string[] }[])[0].value);
    expect(asked("act_1/ads").sort()).toEqual(["23850000000000501", "23850000000000502", "23850000000000503", "23850000000000504", "23850000000000506", "23850000000000508"]);
    w.f.calls.length = 0;
    // The sweep reads every started ad of a running campaign, whatever Meta said last time.
    expect((await syncAdReviews("sweep", w.deps)).checked).toBe(7);
    expect(asked("act_1/ads").sort()).toEqual(["23850000000000501", "23850000000000502", "23850000000000503", "23850000000000504", "23850000000000505", "23850000000000506", "23850000000000508"]);
  });

  it("a paused campaign: an ad Meta showed paused is not read again until the campaign runs, and the sweep skips it", async () => {
    // Started once, then paused in Edwyz (pauseCampaign leaves Ad.status active).
    seed(
      [
        { id: "a_off", metaAdId: "23850000000000521", effectiveStatus: "CAMPAIGN_PAUSED" },
        { id: "a_was_live", metaAdId: "23850000000000522", effectiveStatus: "ACTIVE" },
      ],
      { campaign: { status: "paused" } },
    );
    w.f.addReview(review("23850000000000521", "CAMPAIGN_PAUSED"));
    w.f.addReview(review("23850000000000522", "CAMPAIGN_PAUSED"));
    expect(await syncAdReviews("review", w.deps)).toEqual({ checked: 0, changed: 0, failed: 0 });
    expect(await syncAdReviews("sweep", w.deps)).toEqual({ checked: 0, changed: 0, failed: 0 });
    expect(w.fetches()).toBe(0);
    // They wait at the back of the queue; what was known stays.
    expect(adRow("a_off").reviewCheckedAt).toEqual(clock.now);
    expect(adRow("a_was_live").effectiveStatus).toBe("ACTIVE");
  });

  it("no ad to read: one query, no Meta call", async () => {
    expect(await syncAdReviews("review", w.deps)).toEqual({ checked: 0, changed: 0, failed: 0 });
    expect(w.fetches()).toBe(0);
  });

  it("one ad account failing never stops the other, and its ads count as failed", async () => {
    seed([{ id: "a_1", metaAdId: "23850000000000601" }]);
    fake.db.seed("metaAsset", { id: "ad_asset_2", tenantId: T, type: "ad_account", externalId: "act_2", meta: {} });
    fake.db.seed("adCampaign", { id: "c_2", tenantId: T, adAccountAssetId: "ad_asset_2", metaCampaignId: "23850000000000302", status: "active", launchedAt: clock.now, reviewState: null, advantageState: "DISABLED" });
    fake.db.seed("adSet", { id: "s_2", tenantId: T, campaignId: "c_2", metaAdSetId: "23850000000000202", targeting: {}, effectivePlacements: {} });
    fake.db.seed("ad", { id: "a_2", tenantId: T, adSetId: "s_2", metaAdId: "23850000000000602", status: "active", effectiveStatus: null, creative: {} });
    w.f.addReview(review("23850000000000601", "PENDING_REVIEW"));
    w.f.throttleNext({ code: 190, match: /^act_2\/ads$/ });
    const result = await syncAdReviews("review", w.deps);
    expect(result).toEqual({ checked: 1, changed: 1, failed: 1 });
    expect(adRow("a_1").effectiveStatus).toBe("PENDING_REVIEW");
    expect(adRow("a_2").effectiveStatus).toBeNull();
    // The failed ad moves to the back of the queue all the same.
    expect(adRow("a_2").reviewCheckedAt).toEqual(clock.now);
  });

  it("an account that keeps failing never crowds out a healthy one, even with more ads than a run takes", async () => {
    seed([{ id: "z_ok", metaAdId: "23850000000000699" }]);
    fake.db.seed("metaAsset", { id: "ad_asset_2", tenantId: T, type: "ad_account", externalId: "act_2", meta: {} });
    fake.db.seed("adCampaign", { id: "c_2", tenantId: T, adAccountAssetId: "ad_asset_2", metaCampaignId: "23850000000000302", status: "active", launchedAt: clock.now, reviewState: null, advantageState: "DISABLED" });
    fake.db.seed("adSet", { id: "s_2", tenantId: T, campaignId: "c_2", metaAdSetId: "23850000000000202", targeting: {}, effectivePlacements: {} });
    fake.db.seed(
      "ad",
      ...Array.from({ length: REVIEW_SYNC_MAX_ADS }, (_, i) => ({
        id: `a_f${String(i).padStart(4, "0")}`,
        tenantId: T,
        adSetId: "s_2",
        metaAdId: (23850000000200000n + BigInt(i)).toString(),
        status: "active",
        effectiveStatus: null,
        reviewCheckedAt: null,
        creative: {},
      })),
    );
    w.f.addReview(review("23850000000000699", "PENDING_REVIEW"));
    const accounts: string[] = [];
    const meta: ReviewDeps["meta"] = {
      ...(w.deps.meta as ReviewDeps["meta"]),
      getAdsReview: async (ctx, adIds) => {
        accounts.push(ctx.adAccountAssetId);
        // An expired or revoked token: every read of this account fails.
        if (ctx.adAccountAssetId === "ad_asset_2") throw new HttpError(401, "Reconnect Facebook.");
        return w.meta.getAdsReview(ctx, adIds);
      },
    };
    const deps = { ...w.deps, db: postgresOrdered(), meta };
    // Run 1: the failing account's ads fill the whole take.
    expect(await syncAdReviews("review", deps)).toEqual({ checked: 0, changed: 0, failed: REVIEW_SYNC_MAX_ADS });
    expect(adRow("z_ok").effectiveStatus).toBeNull();
    expect(adRow("a_f0000").reviewCheckedAt).toEqual(clock.now);
    // Run 2: they went to the back, so the healthy account is read.
    clock.now = new Date(clock.now.getTime() + 15 * 60_000);
    expect(await syncAdReviews("review", deps)).toEqual({ checked: 1, changed: 1, failed: REVIEW_SYNC_MAX_ADS - 1 });
    expect(adRow("z_ok").effectiveStatus).toBe("PENDING_REVIEW");
    expect(accounts).toEqual(["ad_asset_2", "ad_asset", "ad_asset_2"]);
  });

  it("never sends a dry-run id to Meta: it waits at the back, and the account's real ads are still read", async () => {
    seed([
      { id: "a_real", metaAdId: "23850000000000651" },
      { id: "a_dry", metaAdId: "dryrun_ad_kx2a1" },
    ]);
    w.f.addReview(review("23850000000000651", "PENDING_REVIEW"));
    expect(await syncAdReviews("review", w.deps)).toEqual({ checked: 1, changed: 1, failed: 0 });
    const asked = w.f.calls.filter((c) => c.path === "act_1/ads").flatMap((c) => (JSON.parse(c.query.filtering) as { value: string[] }[])[0].value);
    expect(asked).toEqual(["23850000000000651"]);
    expect(adRow("a_dry")).toMatchObject({ reviewCheckedAt: clock.now, effectiveStatus: null });
  });

  it("demo ad accounts and another workspace's rows are never read", async () => {
    seed([{ id: "a_1", metaAdId: "23850000000000701" }], { assetMeta: { demo: true } });
    fake.db.seed("ad", { id: "a_mixed", tenantId: "t_other", adSetId: "s_1", metaAdId: "23850000000000702", status: "active", effectiveStatus: null, creative: {} });
    expect(await syncAdReviews("review", w.deps)).toEqual({ checked: 0, changed: 0, failed: 0 });
    expect(w.fetches()).toBe(0);
    // They go to the back of the queue, so they never hold it for the ads that can be read; nothing else about them changes.
    expect(adRow("a_1")).toMatchObject({ reviewCheckedAt: clock.now, effectiveStatus: null, reviewFeedback: null });
    expect(adRow("a_mixed")).toMatchObject({ reviewCheckedAt: clock.now, effectiveStatus: null });
  });

  it("an ad of a campaign that is still launching waits behind readable ads in the next run", async () => {
    seed([{ id: "a_ready", metaAdId: "23850000000000801" }]);
    fake.db.seed("adCampaign", { id: "c_launching", tenantId: T, adAccountAssetId: "ad_asset", metaCampaignId: "23850000000000399", status: "launching", launchedAt: null });
    fake.db.seed("adSet", { id: "s_launching", tenantId: T, campaignId: "c_launching", metaAdSetId: "23850000000000299", targeting: {}, effectivePlacements: null });
    fake.db.seed("ad", { id: "a_launching", tenantId: T, adSetId: "s_launching", metaAdId: "23850000000000802", status: "paused", effectiveStatus: null, reviewCheckedAt: null, creative: {} });
    w.f.addReview(review("23850000000000801", "PENDING_REVIEW"));
    expect((await syncAdReviews("review", w.deps)).checked).toBe(1);
    expect(adRow("a_launching").reviewCheckedAt).toEqual(clock.now);
    expect(adRow("a_launching").effectiveStatus).toBeNull();
  });
});

// =====================================================================================================================
// Codes in plain words, and Ad.reviewFeedback without text
// =====================================================================================================================

describe("feedback codes: plain reasons and fix kinds in three languages; reviewFeedback holds codes only", () => {
  it("at least 25 codes map to a plain reason, what to do and a fix kind, in English, Hindi and Hinglish", async () => {
    const codes = Object.keys(REVIEW_REASONS);
    expect(codes.length).toBeGreaterThanOrEqual(25);
    const chunks = [codes.slice(0, 25), codes.slice(25)];
    seed(chunks.map((chunk, i) => ({ id: `a_${i}`, metaAdId: `2385000000000080${i}`, effectiveStatus: "DISAPPROVED", reviewFeedback: { v: 1, items: chunk.map((code) => ({ code, placement: null })), issues: [] } })));
    const explained = new Map<string, Record<string, { reason: string; whatToDo: string; fix: string }>>();
    for (const lang of ["en", "hi", "hinglish"] as const) {
      const view = await explainCampaignReview(T, "c_1", { lang, readAccount: false }, w.deps);
      for (const ad of view.ads) {
        for (const r of ad.reasons) {
          const row = explained.get(r.code) ?? {};
          row[lang] = { reason: r.reason, whatToDo: r.whatToDo, fix: r.fix };
          explained.set(r.code, row);
        }
      }
    }
    expect(explained.size).toBe(codes.length);
    for (const [code, byLang] of explained) {
      for (const lang of ["en", "hi", "hinglish"]) {
        const r = byLang[lang];
        expect(r, `${code} ${lang}`).toBeDefined();
        expect(r.reason.length, `${code} ${lang}`).toBeGreaterThan(5);
        expect(r.whatToDo.length, `${code} ${lang}`).toBeGreaterThan(5);
        expect(r.reason, `${code} ${lang}`).not.toMatch(/Meta gave this reason|Meta ne yeh wajah|Meta ने यह वजह/);
        expect(REVIEW_FIX_KINDS).toContain(r.fix);
        expect(r.fix).toBe(REVIEW_REASONS[code].fix);
      }
      expect(byLang.hi.reason).toMatch(/\p{Script=Devanagari}/u);
      expect(byLang.hinglish.reason).not.toMatch(/\p{Script=Devanagari}/u);
      expect(byLang.en.reason).not.toBe(byLang.hi.reason);
    }
    const kinds = new Set([...explained.values()].map((r) => r.en.fix));
    for (const k of ["edit_text", "edit_media", "edit_link", "appeal", "set_category"]) expect(kinds.has(k as never), k).toBe(true);
  });

  it("stores codes and placements only: neither Meta's words nor the ad's text reach Ad.reviewFeedback", async () => {
    seed([{ id: "a_1", metaAdId: "23850000000000901" }]);
    w.f.addReview(
      review("23850000000000901", "DISAPPROVED", {
        ad_review_feedback: { global: { TEXT_OVERLAY: META_TEXT, BRAND_USAGE: `Do not say "${AD_TEXT}" with Instagram's logo.` }, placement_specific: { instagram: { PERSONAL_ATTRIBUTES: "Ads can't imply you know the reader." } } },
        issues_info: [{ error_code: 1487302, error_summary: "Ad rejected", error_message: `The ad "${AD_TEXT}" was rejected.`, level: "AD" }],
      }),
    );
    await syncAdReviews("review", w.deps);
    const stored = adRow("a_1").reviewFeedback as StoredFeedback;
    expect(stored).toEqual({
      v: 1,
      items: [
        { code: "TEXT_OVERLAY", placement: null },
        { code: "BRAND_USAGE", placement: null },
        { code: "PERSONAL_ATTRIBUTES", placement: "instagram" },
      ],
      issues: [1487302],
    });
    const json = JSON.stringify(stored);
    for (const text of [META_TEXT, AD_TEXT, "Diwali", "logo", "rejected", "reader"]) expect(json).not.toContain(text);
    expect(adRow("a_1").effectiveStatus).toBe("DISAPPROVED");
    expect(adRow("a_1").reviewCheckedAt).toEqual(clock.now);
    // Read back, only codes and placements survive, whatever was planted in the column.
    expect(readStoredFeedback({ v: 1, items: [{ code: "TEXT_OVERLAY", placement: null, text: META_TEXT }, { code: "has spaces", placement: null }, { code: "X", placement: "Insta gram" }], issues: [1, "two"] })).toEqual({ v: 1, items: [{ code: "TEXT_OVERLAY", placement: null }], issues: [1] });
  });

  it("keeps creative.metaReview in step, so today's campaign page still says why", async () => {
    seed([{ id: "a_1", metaAdId: "23850000000000902" }]);
    w.f.addReview(review("23850000000000902", "DISAPPROVED", { ad_review_feedback: { global: { TEXT_OVERLAY: META_TEXT } } }));
    await syncAdReviews("review", w.deps);
    const metaReview = readAdReview(adRow("a_1").creative);
    expect(metaReview).toMatchObject({ state: "rejected", metaStatus: "DISAPPROVED", reasons: [META_TEXT] });
    // The draft's own fields are untouched.
    expect(adRow("a_1").creative).toMatchObject({ message: AD_TEXT, headline: "Sarees" });
  });

  it("reads Meta's policy titles as codes, globally and per placement, and keeps creative.metaReview exactly as the structure sync builds it", async () => {
    seed([
      { id: "a_1", metaAdId: "23850000000000911", effectiveStatus: "PENDING_REVIEW" },
      { id: "a_2", metaAdId: "23850000000000912", effectiveStatus: "PENDING_REVIEW" },
    ]);
    const rejected = {
      global: { "Personal Attributes": "Ads can't imply you know the reader.", "Adult Nudity & Sexual Activity": "Ads can't show nudity." },
      placement_specific: { instagram: { "Adult Nudity & Sexual Activity": "Not on Instagram." } },
    };
    const instagramOnly = { placement_specific: { instagram: { "Personal Attributes": "Not on Instagram either." } } };
    w.f.addReview(review("23850000000000911", "DISAPPROVED", { ad_review_feedback: rejected }));
    w.f.addReview(review("23850000000000912", "ACTIVE", { ad_review_feedback: instagramOnly }));
    await syncAdReviews("review", w.deps);

    expect(adRow("a_1").reviewFeedback).toEqual({
      v: 1,
      items: [
        { code: "PERSONAL_ATTRIBUTES", placement: null },
        { code: "ADULT_CONTENT", placement: null },
        { code: "ADULT_CONTENT", placement: "instagram" },
      ],
      issues: [],
    });
    // Running but not approved on Instagram: partly rejected, never "approved".
    expect(adReviewState("ACTIVE", readStoredFeedback(adRow("a_2").reviewFeedback))).toBe("partly_rejected");
    expect(notices().map((n) => [n.kind, n.dedupeKey, (n.payload as Row).codes])).toEqual([
      ["ad_rejected", "ad-review:a_1:rejected", "PERSONAL_ATTRIBUTES,ADULT_CONTENT"],
      ["ad_rejected", "ad-review:a_2:partly_rejected", "PERSONAL_ATTRIBUTES"],
    ]);
    // Meta's own words, from Meta's own object: the structure sync's reviewFromMeta gives the same, so neither rewrites the other.
    for (const [id, status, raw] of [["a_1", "DISAPPROVED", rejected], ["a_2", "ACTIVE", instagramOnly]] as const) {
      expect(readAdReview(adRow(id).creative)).toEqual(reviewFromMeta({ effective_status: status, ad_review_feedback: raw }, clock.now));
    }
    expect(readAdReview(adRow("a_1").creative)?.reasons[0]).toBe("Ads can't imply you know the reader.");
    // The explanation names the plain reasons, per placement.
    const view = await explainCampaignReview(T, "c_1", { readAccount: false }, w.deps);
    expect(view.ads[0].reasons.map((r) => [r.code, r.placement])).toEqual([
      ["PERSONAL_ATTRIBUTES", null],
      ["ADULT_CONTENT", null],
      ["ADULT_CONTENT", "instagram"],
    ]);
    expect(view.ads[1]).toMatchObject({ state: "partly_rejected" });
    expect(view.ads[1].line).toMatch(/^Not approved on Instagram: .*It still runs on Facebook\.$/);
    expect(storedFeedbackOf({ feedback: [{ scope: "global", code: "Adult Nudity & Sexual Activity", text: "x" }, { scope: "global", code: "नीति", text: "x" }], issues: [] }).items).toEqual([{ code: "ADULT_CONTENT", placement: null }]);
  });

  it("storedFeedbackOf normalises aliases and drops anything that is not a code or a placement", () => {
    const stored = storedFeedbackOf({
      feedback: [
        { scope: "global", code: "IMAGE_TEXT", text: META_TEXT },
        { scope: "global", code: "TEXT_OVERLAY", text: "again" },
        { scope: "Instagram", code: "BRAND_USAGE", text: "x" },
        { scope: "!!!", code: "BRAND_USAGE", text: "x" },
      ],
      issues: [{ code: 7, summary: "s", message: AD_TEXT, level: "AD" }, { code: null, summary: null, message: null, level: null }],
    });
    expect(stored).toEqual({ v: 1, items: [{ code: "TEXT_OVERLAY", placement: null }, { code: "BRAND_USAGE", placement: "instagram" }], issues: [7] });
  });
});

// =====================================================================================================================
// States: partly_rejected, the campaign, the ad set
// =====================================================================================================================

describe("review states", () => {
  it("a per-placement rejection is partly_rejected, for the ad and the campaign", async () => {
    seed([
      { id: "a_1", metaAdId: "23850000000001001", effectiveStatus: "PENDING_REVIEW" },
      { id: "a_2", metaAdId: "23850000000001002", effectiveStatus: "PENDING_REVIEW" },
    ]);
    w.f.addReview(review("23850000000001001", "ACTIVE", { ad_review_feedback: { placement_specific: { instagram: { BRAND_USAGE: "Ads can't use Instagram's brand this way." } } } }));
    w.f.addReview(review("23850000000001002", "ACTIVE"));
    await syncAdReviews("review", w.deps);
    expect(adReviewState(adRow("a_1").effectiveStatus as string, readStoredFeedback(adRow("a_1").reviewFeedback))).toBe("partly_rejected");
    expect(adReviewState(adRow("a_2").effectiveStatus as string, readStoredFeedback(adRow("a_2").reviewFeedback))).toBe("approved");
    expect(campaignRow().reviewState).toBe("partly_rejected");
    expect(campaignRow().reviewCheckedAt).toEqual(clock.now);
    expect(setRow().effectiveStatus).toBe("ACTIVE");
  });

  it("the campaign state follows its ads: all rejected, some, issues, in review, approved", () => {
    expect(campaignReviewState(["rejected", "rejected", null])).toBe("rejected");
    expect(campaignReviewState(["rejected", "approved"])).toBe("partly_rejected");
    expect(campaignReviewState(["partly_rejected", "approved"])).toBe("partly_rejected");
    expect(campaignReviewState(["with_issues", "in_review"])).toBe("with_issues");
    expect(campaignReviewState(["in_review", "approved"])).toBe("in_review");
    expect(campaignReviewState(["approved", "approved"])).toBe("approved");
    expect(campaignReviewState([null, null])).toBeNull();
    expect(adReviewState("DISAPPROVED", null)).toBe("rejected");
    expect(adReviewState("WITH_ISSUES", { v: 1, items: [{ code: "X", placement: null }], issues: [] })).toBe("with_issues");
    expect(adReviewState("IN_PROCESS", null)).toBe("in_review");
    expect(adReviewState("PREAPPROVED", null)).toBe("approved");
    expect(adReviewState("PAUSED", null)).toBeNull();
    expect(adReviewState("ARCHIVED", { v: 1, items: [{ code: "X", placement: "instagram" }], issues: [] })).toBeNull();
    expect(adSetStatusFromAds(["ACTIVE", "DISAPPROVED"])).toBe("ACTIVE");
    expect(adSetStatusFromAds(["ADSET_PAUSED"])).toBe("PAUSED");
    expect(adSetStatusFromAds(["CAMPAIGN_PAUSED", "ADSET_PAUSED"])).toBe("CAMPAIGN_PAUSED");
    expect(adSetStatusFromAds(["DISAPPROVED", null])).toBeNull();
  });
});

// =====================================================================================================================
// Once after launch: effective placements and advantage_state_info
// =====================================================================================================================

describe("read back once after launch (R2 and the ad set's targeting)", () => {
  const META_TARGETING = { publisher_platforms: ["facebook", "instagram"], facebook_positions: ["feed", "story"], instagram_positions: ["stream", "story"], geo_locations: { countries: ["IN"] } };

  it("stores the effective placements, with the chosen positions Meta dropped, and the advantage state, once", async () => {
    seed([{ id: "a_1", metaAdId: "23850000000001101" }], { placements: ["facebook_feed", "instagram_feed", "instagram_reels", "messenger_inbox"] });
    w.f.addReview(review("23850000000001101", "PENDING_REVIEW", { targeting: META_TARGETING }));
    await syncAdReviews("review", w.deps);
    expect(setRow().effectivePlacements).toEqual({
      automatic: false,
      platforms: ["facebook", "instagram"],
      positions: { facebook: ["feed", "story"], instagram: ["stream", "story"] },
      dropped: ["instagram_reels", "messenger_inbox"],
      checkedAt: clock.now.toISOString(),
    });
    expect(campaignRow().advantageState).toBe("DISABLED");
    const advantageReads = () => w.f.calls.filter((c) => c.path === "act_1/campaigns");
    expect(advantageReads()).toHaveLength(1);
    expect(JSON.parse(advantageReads()[0].query.filtering)).toEqual([{ field: "id", operator: "IN", value: [META_CAMPAIGN] }]);

    // Later runs leave both as they were, whatever Meta now says.
    const first = setRow().effectivePlacements;
    clock.now = new Date(clock.now.getTime() + 15 * 60_000);
    w.f.addReview(review("23850000000001101", "PENDING_REVIEW", { targeting: { publisher_platforms: ["facebook"] } }));
    await syncAdReviews("review", w.deps);
    expect(setRow().effectivePlacements).toEqual(first);
    expect(advantageReads()).toHaveLength(1);
  });

  it("Automatic placements are stored as automatic, with nothing dropped", () => {
    expect(effectivePlacementsOf({ geo_locations: {} }, [], clock.now)).toEqual({ automatic: true, platforms: [], positions: {}, dropped: [], checkedAt: clock.now.toISOString() });
    expect(effectivePlacementsOf({ publisher_platforms: ["facebook"] }, ["instagram_feed", "facebook_feed", "nonsense"], clock.now)?.dropped).toEqual(["instagram_feed"]);
    expect(effectivePlacementsOf(null, [], clock.now)).toBeNull();
  });
});

// =====================================================================================================================
// Notices: one on approval, one on rejection, codes only
// =====================================================================================================================

describe("ad_approved and ad_rejected notices", () => {
  it("publishes exactly one deduplicated notice on approval and one on rejection; the earlier one resolves", async () => {
    seed([{ id: "a_1", metaAdId: "23850000000001201", effectiveStatus: "PENDING_REVIEW" }]);
    w.f.addReview(review("23850000000001201", "ACTIVE"));
    await syncAdReviews("review", w.deps);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ kind: "ad_approved", severity: "fyi", dedupeKey: "ad-review:a_1:approved", subjectType: "ad", subjectId: "a_1", audienceMinRole: "admin", source: "eddy" });
    // The sweep sees the same approval again: nothing new.
    await syncAdReviews("sweep", w.deps);
    await syncAdReviews("sweep", w.deps);
    expect(notices()).toHaveLength(1);

    // Meta rejects it after approving it: one rejection notice, and the approval notice resolves.
    w.f.addReview(review("23850000000001201", "DISAPPROVED", { ad_review_feedback: { global: { TEXT_OVERLAY: META_TEXT } } }));
    clock.now = new Date(clock.now.getTime() + 2 * 3_600_000);
    await syncAdReviews("sweep", w.deps);
    await syncAdReviews("review", w.deps);
    await syncAdReviews("review", w.deps);
    const rejected = notices().filter((n) => n.kind === "ad_rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ severity: "action_needed", dedupeKey: "ad-review:a_1:rejected", subjectId: "a_1" });
    expect(openNotices().map((n) => n.kind)).toEqual(["ad_rejected"]);
    expect(campaignRow().reviewState).toBe("rejected");
  });

  it("a per-placement rejection is an ad_rejected notice with state partly_rejected and its own text", async () => {
    seed([{ id: "a_1", metaAdId: "23850000000001301", effectiveStatus: "PENDING_REVIEW" }]);
    w.f.addReview(review("23850000000001301", "ACTIVE", { ad_review_feedback: { placement_specific: { instagram: { BRAND_USAGE: "x" } } } }));
    await syncAdReviews("review", w.deps);
    expect(notices().map((n) => [n.kind, n.dedupeKey])).toEqual([["ad_rejected", "ad-review:a_1:partly_rejected"]]);
    expect(textKeyFor("ad_rejected", cleanPayload(notices()[0].payload))).toBe("notices.ad_rejected_partly");
  });

  it("notices carry ids and codes only: no ad text, no Meta words, no names", async () => {
    seed([{ id: "a_1", metaAdId: "23850000000001401", effectiveStatus: "IN_PROCESS" }]);
    w.f.addReview(
      review("23850000000001401", "DISAPPROVED", { ad_review_feedback: { global: { TEXT_OVERLAY: META_TEXT, PERSONAL_ATTRIBUTES: `"${AD_TEXT}" talks about the reader.` }, placement_specific: { instagram: { BRAND_USAGE: "logo" } } } }),
    );
    await syncAdReviews("review", w.deps);
    const n = notices()[0];
    expect(n.payload).toEqual({ adId: "a_1", campaignId: "c_1", state: "rejected", codes: "TEXT_OVERLAY,PERSONAL_ATTRIBUTES,BRAND_USAGE" });
    for (const [k, v] of Object.entries(n.payload as Row)) {
      expect(PAYLOAD_KEYS.has(k), k).toBe(true);
      expect(SAFE_VALUE.test(String(v)), k).toBe(true);
    }
    const json = JSON.stringify(n);
    for (const text of [META_TEXT, AD_TEXT, "Diwali", "Ad a_1", "logo", "reader"]) expect(json).not.toContain(text);
    expect(n.actions).toEqual([
      { kind: "open_eddy", ref: { kind: "notice", noticeId: "self" }, labelKey: "btn.fix_with_eddy" },
      { kind: "navigate", path: "/app/ads/c_1", labelKey: "btn.review" },
    ]);
  });

  it("an ad read for the first time long after launch only stores its state, with no notice", async () => {
    seed([{ id: "a_old", metaAdId: "23850000000001501" }], { launchedAt: new Date(clock.now.getTime() - NEW_AD_NOTICE_WINDOW_MS - 60_000) });
    w.f.addReview(review("23850000000001501", "DISAPPROVED", { ad_review_feedback: { global: { TEXT_OVERLAY: META_TEXT } } }));
    await syncAdReviews("review", w.deps);
    expect(adRow("a_old").effectiveStatus).toBe("DISAPPROVED");
    expect(notices()).toHaveLength(0);
    // A brand-new ad Meta already approved on its first read still gets its notice.
    fake.db.reset();
    seed([{ id: "a_new", metaAdId: "23850000000001502" }]);
    w.f.addReview(review("23850000000001502", "ACTIVE"));
    await syncAdReviews("review", w.deps);
    expect(notices().map((x) => x.kind)).toEqual(["ad_approved"]);
  });

  it("launched paused, read as paused, then started: Meta's answer after Start is read, with its notice and state", async () => {
    seed(
      [
        { id: "a_1", metaAdId: "23850000000001701", status: "paused" },
        { id: "a_2", metaAdId: "23850000000001702", status: "paused" },
      ],
      { campaign: { status: "paused" } },
    );
    const asked = () => w.f.calls.filter((c) => c.path === "act_1/ads").length;
    // Right after launch Meta is still reviewing.
    w.f.addReview(review("23850000000001701", "PENDING_REVIEW"));
    w.f.addReview(review("23850000000001702", "PENDING_REVIEW"));
    await syncAdReviews("review", w.deps);
    expect(campaignRow().reviewState).toBe("in_review");
    // Meta finishes while the campaign is paused, and says only CAMPAIGN_PAUSED: the campaign is no longer "in review".
    w.f.addReview(review("23850000000001701", "CAMPAIGN_PAUSED"));
    w.f.addReview(review("23850000000001702", "CAMPAIGN_PAUSED"));
    clock.now = new Date(clock.now.getTime() + 15 * 60_000);
    await syncAdReviews("review", w.deps);
    expect(adRow("a_1").effectiveStatus).toBe("CAMPAIGN_PAUSED");
    expect(campaignRow().reviewState).toBeNull();
    expect(notices()).toHaveLength(0);
    // While it stays paused there is nothing to read.
    const before = asked();
    await syncAdReviews("review", w.deps);
    await syncAdReviews("sweep", w.deps);
    expect(asked()).toBe(before);

    // Start (ads/service.ts activateCampaign): the campaign and its ads are active; Meta's stored status is still the paused one.
    Object.assign(campaignRow(), { status: "active" });
    for (const id of ["a_1", "a_2"]) Object.assign(adRow(id), { status: "active" });
    w.f.addReview(review("23850000000001701", "DISAPPROVED", { ad_review_feedback: { global: { "Personal Attributes": "Ads can't imply you know the reader." } } }));
    w.f.addReview(review("23850000000001702", "ACTIVE"));
    clock.now = new Date(clock.now.getTime() + 15 * 60_000);
    expect((await syncAdReviews("review", w.deps)).checked).toBe(2);
    expect(adRow("a_1").effectiveStatus).toBe("DISAPPROVED");
    expect(notices().map((n) => [n.kind, n.dedupeKey, (n.payload as Row).codes ?? null])).toEqual([
      ["ad_rejected", "ad-review:a_1:rejected", "PERSONAL_ATTRIBUTES"],
      ["ad_approved", "ad-review:a_2:approved", null],
    ]);
    expect(campaignRow().reviewState).toBe("partly_rejected");
    const view = await explainCampaignReview(T, "c_1", { readAccount: false }, w.deps);
    expect(view.ads.map((a) => [a.id, a.state, a.line])).toEqual([
      ["a_1", "rejected", expect.stringMatching(/^Not approved: /)],
      ["a_2", "approved", "Running"],
    ]);

    // Meta rejects the running ad later: the 2-hour sweep sees it.
    w.f.addReview(review("23850000000001702", "DISAPPROVED", { ad_review_feedback: { global: { TEXT_OVERLAY: META_TEXT } } }));
    clock.now = new Date(clock.now.getTime() + 2 * 3_600_000);
    await syncAdReviews("sweep", w.deps);
    expect(openNotices().map((n) => n.dedupeKey)).toEqual(["ad-review:a_1:rejected", "ad-review:a_2:rejected"]);
    expect(campaignRow().reviewState).toBe("rejected");
  });

  it("an ad started more than 3 days after launch still gets its notices: the window also runs from Start or resume", async () => {
    const longAgo = new Date(clock.now.getTime() - NEW_AD_NOTICE_WINDOW_MS - 86_400_000);
    seed([{ id: "a_1", metaAdId: "23850000000001801" }], { launchedAt: longAgo });
    fake.db.seed("auditLog", { id: "al_1", tenantId: T, action: START_AUDIT_ACTIONS[0], target: "c_1", createdAt: new Date(clock.now.getTime() - 60_000) });
    w.f.addReview(review("23850000000001801", "ACTIVE"));
    await syncAdReviews("review", w.deps);
    expect(notices().map((n) => [n.kind, n.dedupeKey])).toEqual([["ad_approved", "ad-review:a_1:approved"]]);

    // A Start in another workspace, or one older than the window, does not count: the old ad only stores its state.
    fake.db.reset();
    seed([{ id: "a_2", metaAdId: "23850000000001802" }], { launchedAt: longAgo });
    fake.db.seed(
      "auditLog",
      { id: "al_2", tenantId: "t_other", action: START_AUDIT_ACTIONS[0], target: "c_1", createdAt: clock.now },
      { id: "al_3", tenantId: T, action: START_AUDIT_ACTIONS[1], target: "c_1", createdAt: longAgo },
      { id: "al_4", tenantId: T, action: "ads.campaign.paused", target: "c_1", createdAt: clock.now },
    );
    w.f.addReview(review("23850000000001802", "DISAPPROVED", { ad_review_feedback: { global: { TEXT_OVERLAY: META_TEXT } } }));
    await syncAdReviews("review", w.deps);
    expect(adRow("a_2").effectiveStatus).toBe("DISAPPROVED");
    expect(notices()).toHaveLength(0);
    expect(START_AUDIT_ACTIONS).toEqual(["ads.campaign.activated", "ads.campaign.resumed"]);
  });

  it("in train P2 (admins) only campaigns made in the new flows are announced; the state is kept for every ad", async () => {
    seed([{ id: "a_wizard", metaAdId: "23850000000001601", effectiveStatus: "PENDING_REVIEW" }], { campaign: { surface: "wizard" } });
    w.f.addReview(review("23850000000001601", "DISAPPROVED", { ad_review_feedback: { global: { TEXT_OVERLAY: META_TEXT } } }));
    const admins = { ...w.deps, env: { PROMOTE_ENABLED: "admins" } };
    await syncAdReviews("review", admins);
    expect(adRow("a_wizard").effectiveStatus).toBe("DISAPPROVED");
    expect(campaignRow().reviewState).toBe("rejected");
    expect(notices()).toHaveLength(0);
    fake.db.reset();
    seed([{ id: "a_promote", metaAdId: "23850000000001602", effectiveStatus: "PENDING_REVIEW" }], { campaign: { surface: "promote" } });
    w.f.addReview(review("23850000000001602", "DISAPPROVED", { ad_review_feedback: { global: { TEXT_OVERLAY: META_TEXT } } }));
    await syncAdReviews("review", admins);
    expect(notices().map((n) => n.dedupeKey)).toEqual(["ad-review:a_promote:rejected"]);
    expect(announcesFor({ surface: "eddy" }, { PROMOTE_ENABLED: "admins" })).toBe(true);
    expect(announcesFor({ surface: "wizard" }, { PROMOTE_ENABLED: "on" })).toBe(true);
    expect(announcesFor({ surface: "promote" }, {})).toBe(false);
  });

  it("reviewNoticeFor: approval out of review or after a rejection; rejection and partial rejection on change only", () => {
    expect(reviewNoticeFor("in_review", "approved", true)).toBe("approved");
    expect(reviewNoticeFor("rejected", "approved", true)).toBe("approved");
    expect(reviewNoticeFor("with_issues", "approved", true)).toBeNull();
    expect(reviewNoticeFor("approved", "approved", true)).toBeNull();
    expect(reviewNoticeFor("approved", "rejected", true)).toBe("rejected");
    expect(reviewNoticeFor("rejected", "rejected", true)).toBeNull();
    expect(reviewNoticeFor("approved", "partly_rejected", true)).toBe("partly_rejected");
    expect(reviewNoticeFor(null, "rejected", false)).toBeNull();
    expect(reviewNoticeFor("in_review", null, true)).toBeNull();
  });

  it("the two kinds are registered with their severity, text keys and dedupe, and Phase 0's own rejection row gives way", () => {
    expect(NOTICE_KINDS).toEqual(expect.arrayContaining(["ad_approved", "ad_rejected"]));
    expect(KIND_SPECS.ad_approved).toEqual({ severity: "fyi", minRole: "admin", numberBased: false });
    expect(KIND_SPECS.ad_rejected).toEqual({ severity: "action_needed", minRole: "admin", numberBased: false });
    for (const key of ["notices.ad_approved", "notices.ad_rejected", "notices.ad_rejected_partly"]) expect(hasKey(key), key).toBe(true);
    const spendRow = { source: "spend", kind: "breaker_tripped", subjectType: "campaign", subjectId: "c_1", dedupeKey: "ads-review:a_1:rejected" };
    expect(supersededSpendRow(spendRow, [{ kind: "ad_rejected", subjectType: "ad", subjectId: "a_1" }])).toBe(true);
    expect(supersededSpendRow(spendRow, [{ kind: "ad_rejected", subjectType: "ad", subjectId: "a_2" }])).toBe(false);
    expect(supersededSpendRow({ ...spendRow, dedupeKey: "ads-external:c_1:budget" }, [{ kind: "ad_rejected", subjectType: "ad", subjectId: "a_1" }])).toBe(false);
  });
});

// =====================================================================================================================
// The worker tasks
// =====================================================================================================================

describe("promote.review and promote.review.sweep", () => {
  it("delegate to the sync: nothing to read is a no-op with no Meta call", async () => {
    expect(await runReviewSync()).toEqual({ checked: 0, changed: 0, failed: 0 });
    expect(await runReviewSweep()).toEqual({ checked: 0, changed: 0, failed: 0 });
    expect(w.fetches()).toBe(0);
  });
});
