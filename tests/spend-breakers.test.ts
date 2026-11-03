import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSpendDb, Row } from "./helpers/fake-spend-db";

/**
 * Ads breakers (docs/SPEND-CONTROLS-SPEC.md 6.1, 6.2, 4.6 step 9, 8.3) on synthetic series in the in-memory spend database.
 * The pure checks are tested at their thresholds and just below; the pass over a workspace runs the real book (headroom,
 * recordLowering, reserveAds) with the lowering paths swapped for recorded stand-ins that pause through recordLowering, so the
 * daily_limit resume rule reads real ledger rows.
 */

const h = vi.hoisted(() => ({ db: null as unknown as FakeSpendDb }));

vi.mock("@/lib/db", async () => {
  const { createFakeSpendDb } = await import("./helpers/fake-spend-db");
  h.db = createFakeSpendDb();
  return { prisma: h.db.prisma };
});
vi.mock("@/lib/queue", () => ({ enqueue: vi.fn(async () => ({ id: "job" })) }));

import { recordLowering, reserveAds, resetBookForTests, settleAds } from "@/lib/spend/book";
import { efficiencyCheck, inrEquivalentMinor, pacingCheck, spendJumpCheck, type BreakerDeps } from "@/lib/spend/breakers/ads";
import { accountSpikeCheck, cpmCtrCheck, lastHour, medianFraction } from "@/lib/spend/breakers/anomaly";
import { budgetQuotaCheck, dailyLimitCheck, lowerAdSetSpend, monthlyLimitCheck, syncStaleCheck } from "@/lib/spend/breakers/limits";
import { resetSpendStateCache } from "@/lib/spend/kill";
import { BREAKERS_TASK, periodic, queues, runAllBreakers, runBreakersForTenant, summaryKey, writeSummary } from "@/lib/spend/tasks/breakers";
import { SPEND_QUEUES, type SpendActor } from "@/lib/spend/types";

// Wednesday 28 Oct 2026, 12:00 in Asia/Kolkata (06:30 UTC).
const NOW = new Date("2026-10-28T06:30:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const T = "t1";
const INR = (rupees: number) => BigInt(Math.round(rupees * 100));
const ENFORCE = { SPEND_ENFORCE: "enforce" } as Record<string, string>;
const MANAGED = { SPEND_ENFORCE: "enforce", SPEND_CAP_MODE: "enforce" } as Record<string, string>;
const owner: SpendActor = { type: "user", userId: "u_owner", role: "owner" };

const rows = (name: string) => h.db.rows(name);
const breakers = (kind?: string) => rows("spendBreaker").filter((b) => !kind || b.kind === kind);

type Calls = { stop: { filter: Row; actor: SpendActor }[]; pauseAdSet: string[]; resume: { campaignId: string; actor: SpendActor; key: string }[]; enqueue: { queue: string; payload: Row }[]; notify: Row[] };
let calls: Calls;
let failStop: Set<string>;

/** Stand-ins for the lowering paths: they pause through the real recordLowering, so the ledger is real. */
const deps: BreakerDeps = {
  async stopCommitments(tenantId, filter, actor, reason) {
    calls.stop.push({ filter: filter as Row, actor });
    const camps = rows("adCampaign").filter((c) => c.tenantId === tenantId && c.status === "active" && (filter.origin !== "assistant" || c.origin === "assistant"));
    const items = [];
    for (const c of camps) {
      const base = { campaignId: String(c.id), campaignName: String(c.name), adAccountAssetId: String(c.adAccountAssetId), metaObjectId: String(c.metaCampaignId), level: "campaign" as const, lastError: null };
      if (failStop.has(String(c.id))) {
        items.push({ ...base, result: "failed" as const });
        continue;
      }
      await recordLowering(tenantId, { kind: "pause", metaObjectId: String(c.metaCampaignId) }, actor, reason, async () => undefined, { objectLevel: "campaign" });
      c.status = "paused";
      items.push({ ...base, result: "done" as const });
    }
    const done = items.filter((i) => i.result === "done").length;
    return { done, failed: items.length - done, unreachable: 0, skipped: 0, total: items.length, items };
  },
  async pauseAdSet(tenantId, metaAdSetId, actor, reason) {
    calls.pauseAdSet.push(metaAdSetId);
    await recordLowering(tenantId, { kind: "pause", metaObjectId: metaAdSetId }, actor, reason, async () => undefined, { objectLevel: "adset" });
  },
  async resumeCampaign(tenantId, campaignId, actor, key) {
    calls.resume.push({ campaignId, actor, key });
    const sets = rows("adSet").filter((s) => s.campaignId === campaignId).map((s) => ({ adSetId: String(s.id), metaAdSetId: String(s.metaAdSetId) }));
    // The real reserveAds: only what fits starts again.
    const permit = await reserveAds(tenantId, { kind: "activate", campaignId, sets }, actor, { idempotencyKey: key, reason: "Turned back on after the daily limit reset.", env: ENFORCE });
    await settleAds(permit, "applied");
    rows("adCampaign").find((c) => c.id === campaignId)!.status = "active";
  },
  async enqueue(queue, payload) {
    calls.enqueue.push({ queue, payload: payload as Row });
    return { id: "job" };
  },
  async notify(notice) {
    calls.notify.push(notice as unknown as Row);
    return { delivered: ["in_app"], skipped: [], deduplicated: false };
  },
};

function seed(opts: { daily?: number; monthly?: number; managed?: boolean; toggle?: boolean; target?: number | null } = {}) {
  h.db.seed("tenant", [{ id: T, name: "Shop", slug: "shop", status: "active", billingExempt: false }]);
  h.db.seed("metaAsset", [{ id: "acc1", tenantId: T, connectionId: "mc1", type: "ad_account", externalId: "act_111", name: "Shop ads", status: "active", meta: { currency: "INR", timezone: "Asia/Kolkata" }, sandbox: false, createdAt: new Date("2026-01-01") }]);
  h.db.seed("spendControl", [{ tenantId: T, probation: "lifted", spendingAdAccountAssetId: "acc1", timezone: "Asia/Kolkata", breakersMayPauseHumanCampaigns: opts.toggle === true, targetCostPerLeadMinor: opts.target === null ? null : INR(opts.target ?? 100) }]);
  h.db.seed("spendAllowance", [{ id: "sa1", tenantId: T, pot: "ads", currency: "INR", dailyLimitMinor: INR(opts.daily ?? 5_000), monthlyLimitMinor: INR(opts.monthly ?? 100_000) }]);
  if (opts.managed) {
    h.db.seed("metaSpendLimit", [{ adAccountAssetId: "acc1", tenantId: T, accountExternalId: "act_111", mode: "managed", unitMode: "major_write", semantics: "cumulative", managedCapMinor: INR(200_000), lastReadCapMinor: INR(200_000), lastReadAmountSpentMinor: INR(10_000), lastReadAt: new Date(NOW.getTime() - 10 * MIN), lastWriteAt: new Date(NOW.getTime() - HOUR), lastError: null }]);
  }
}

/** An active campaign with one ad set (m_<id>s) and a live commitment, today's peak at the budget. */
function campaign(id: string, rupees = 1_000, origin = "human") {
  h.db.seed("adCampaign", [{ id, tenantId: T, adAccountAssetId: "acc1", metaCampaignId: `m_${id}`, name: `Campaign ${id}`, template: "lead_generation", objective: "OUTCOME_LEADS", status: "active", dailyBudgetMinor: rupees * 100, currency: "INR", endsAt: new Date("2026-11-15T00:00:00Z"), origin, assistantKey: origin === "assistant" ? "ads_optimizer" : null, lifetimeBudgetMinor: null, sandbox: false, updatedAt: new Date("2026-10-01") }]);
  h.db.seed("adSet", [{ id: `${id}s`, tenantId: T, campaignId: id, metaAdSetId: `m_${id}s`, name: `Set ${id}`, status: "active", targeting: {}, dailyBudgetMinor: rupees * 100, lifetimeBudgetMinor: null }]);
  h.db.seed("spendCommitment", [
    { id: `cm_${id}`, tenantId: T, adAccountAssetId: "acc1", campaignId: id, adSetId: `${id}s`, metaObjectId: `m_${id}s`, objectLevel: "adset", origin, assistantKey: origin === "assistant" ? "ads_optimizer" : null, currency: "INR", timezone: "Asia/Kolkata", dailyBudgetMinor: INR(rupees), dayKey: new Date(Date.UTC(2026, 9, 28)), dayStartBudgetMinor: INR(rupees), peakDailyBudgetMinor: INR(rupees), weekStart: new Date(Date.UTC(2026, 9, 25)), weekPeakDailyBudgetMinor: INR(rupees), status: "live", endsAt: new Date("2026-11-15T00:00:00Z") },
  ]);
}

/** A SpendDaily row; a fresh fast sync by default (so sync_stale stays quiet unless a test wants it). */
function spend(scopeType: string, scopeId: string, day: string, rupees: number, o: { origin?: string; results?: number; impressions?: number; clicks?: number; syncedAt?: Date; source?: string } = {}) {
  h.db.seed("spendDaily", [{ tenantId: T, pot: "ads", scopeType, scopeId, day: new Date(`${day}T00:00:00Z`), currency: "INR", amountMinor: INR(rupees), origin: o.origin ?? (scopeType === "account" ? "all" : "platform"), results: o.results ?? null, impressions: o.impressions === undefined ? null : BigInt(o.impressions), clicks: o.clicks === undefined ? null : BigInt(o.clicks), source: o.source ?? "fast_sync", syncedAt: o.syncedAt ?? new Date(NOW.getTime() - 5 * MIN) }]);
}

function sample(entityMetaId: string, at: Date, rupees: number, impressions = 0, clicks = 0) {
  h.db.seed("intradaySpendSample", [{ id: `s_${entityMetaId}_${at.getTime()}`, tenantId: T, adAccountAssetId: "acc1", entityType: "adset", entityMetaId, accountDate: new Date("2026-10-28T00:00:00Z"), sampledAt: at, spendMinor: INR(rupees), impressions: BigInt(impressions), clicks: BigInt(clicks), results: 0 }]);
}

const run = (env = ENFORCE) => runBreakersForTenant(T, { deps, env });
const noticeFor = (kind: string) => calls.notify.filter((n) => breakers(kind).some((b) => n.subjectId === b.id));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  h.db.reset();
  resetSpendStateCache();
  resetBookForTests();
  calls = { stop: [], pauseAdSet: [], resume: [], enqueue: [], notify: [] };
  failStop = new Set();
});
afterEach(() => vi.useRealTimers());

// =====================================================================================================================
// Pure checks: at the threshold and just below
// =====================================================================================================================

describe("the 6.2 thresholds", () => {
  it("pacing trips above 1.20 x the day's highest budgets, and warns above 1.20 x the prorated plan after 2 hours", () => {
    expect(pacingCheck({ spendToday: INR(1_200), peakSum: INR(1_000), dailySum: INR(1_000), elapsedMs: 12 * HOUR }).trip).toBe(false);
    expect(pacingCheck({ spendToday: INR(1_200.01), peakSum: INR(1_000), dailySum: INR(1_000), elapsedMs: 12 * HOUR }).trip).toBe(true);
    expect(pacingCheck({ spendToday: INR(600.01), peakSum: INR(1_000), dailySum: INR(1_000), elapsedMs: 12 * HOUR })).toEqual({ trip: false, warn: true });
    expect(pacingCheck({ spendToday: INR(600), peakSum: INR(1_000), dailySum: INR(1_000), elapsedMs: 12 * HOUR }).warn).toBe(false);
    expect(pacingCheck({ spendToday: INR(500), peakSum: INR(1_000), dailySum: INR(1_000), elapsedMs: 2 * HOUR - 1 }).warn).toBe(false);
    expect(pacingCheck({ spendToday: INR(100), peakSum: INR(1_000), dailySum: INR(1_000), elapsedMs: 2 * HOUR }).warn).toBe(false);
  });

  it("efficiency needs max(3 x target, INR 500) spent and a cost per lead above 2 x target; no leads counts as infinite", () => {
    const t = INR(100);
    const floor = INR(500);
    expect(efficiencyCheck({ spendMinor: INR(500), leads: 2, targetMinor: t, floorMinor: floor }).trip).toBe(true);
    expect(efficiencyCheck({ spendMinor: INR(499.99), leads: 0, targetMinor: t, floorMinor: floor }).trip).toBe(false);
    expect(efficiencyCheck({ spendMinor: INR(600), leads: 3, targetMinor: t, floorMinor: floor }).trip).toBe(false);
    expect(efficiencyCheck({ spendMinor: INR(600.01), leads: 3, targetMinor: t, floorMinor: floor }).trip).toBe(true);
    expect(efficiencyCheck({ spendMinor: INR(900), leads: 0, targetMinor: t, floorMinor: floor }).trip).toBe(true);
    expect(efficiencyCheck({ spendMinor: INR(900), leads: 0, targetMinor: INR(300), floorMinor: floor }).minSpendMinor).toBe(INR(900));
    expect(efficiencyCheck({ spendMinor: INR(9_000), leads: 0, targetMinor: null, floorMinor: floor }).trip).toBe(false);
  });

  it("spend_jump trips when spend grows by more than max(0.25 x D, 4 x D x Δt / 24 h)", () => {
    const at = (m: number) => new Date(NOW.getTime() + m * MIN);
    const s = (m: number, rupees: number) => ({ sampledAt: at(m), spendMinor: INR(rupees), accountDate: "2026-10-28" });
    const D = INR(1_000);
    expect(spendJumpCheck(s(0, 100), s(15, 350), D).trip).toBe(false);
    expect(spendJumpCheck(s(0, 100), s(15, 350.01), D).trip).toBe(true);
    // Over 3 hours the pro-rata bound is larger: 4 x 1,000 x 3/24 = 500.
    expect(spendJumpCheck(s(0, 100), s(180, 600), D).trip).toBe(false);
    expect(spendJumpCheck(s(0, 100), s(180, 600.01), D).trip).toBe(true);
    expect(spendJumpCheck(s(0, 100), { ...s(15, 900), accountDate: "2026-10-29" }, D).trip).toBe(false);
  });

  it("cpm_ctr_anomaly: CPM at 2.5 x the 7-day median or CTR at 0.33 x it, with 1,000 impressions in the hour and 3 days of history", () => {
    const day = (rupees: number, impressions: number, clicks: number) => ({ amountMinor: INR(rupees), impressions: BigInt(impressions), clicks: BigInt(clicks) });
    const hist = [day(100, 1_000, 30), day(100, 1_000, 30), day(100, 1_000, 30)];
    expect(cpmCtrCheck({ spendMinor: INR(250), impressions: 1_000n, clicks: 30n }, hist)).toMatchObject({ trip: true, why: "cpm" });
    expect(cpmCtrCheck({ spendMinor: INR(249.99), impressions: 1_000n, clicks: 30n }, hist).trip).toBe(false);
    expect(cpmCtrCheck({ spendMinor: INR(500), impressions: 999n, clicks: 30n }, hist).trip).toBe(false);
    expect(cpmCtrCheck({ spendMinor: INR(1_000), impressions: 10_000n, clicks: 99n }, hist)).toMatchObject({ trip: true, why: "ctr" });
    expect(cpmCtrCheck({ spendMinor: INR(1_000), impressions: 10_000n, clicks: 100n }, hist).trip).toBe(false);
    expect(cpmCtrCheck({ spendMinor: INR(900), impressions: 1_000n, clicks: 0n }, hist.slice(0, 2)).trip).toBe(false);
    expect(medianFraction([{ num: 1n, den: 2n }, { num: 3n, den: 2n }])).toEqual({ num: 8n, den: 8n });
  });

  it("account_spike: above 1.5 x the busiest of the last 7 days and above INR 1,000", () => {
    expect(accountSpikeCheck(INR(6_000), [INR(4_000), INR(1_000)], INR(1_000)).trip).toBe(false);
    expect(accountSpikeCheck(INR(6_000.01), [INR(4_000), INR(1_000)], INR(1_000)).trip).toBe(true);
    expect(accountSpikeCheck(INR(900), [INR(100)], INR(1_000)).trip).toBe(false);
    expect(accountSpikeCheck(INR(9_000), [0n, 0n], INR(1_000)).trip).toBe(false);
  });

  it("daily_limit, monthly_limit, budget_change_quota and sync_stale at their edges", () => {
    expect(dailyLimitCheck(INR(5_000), INR(5_000))).toBe(true);
    expect(dailyLimitCheck(INR(4_999.99), INR(5_000))).toBe(false);
    expect(dailyLimitCheck(INR(9_999), null)).toBe(false);
    expect(monthlyLimitCheck(INR(18_000), INR(2_000), INR(20_000))).toBe(true);
    expect(monthlyLimitCheck(INR(18_000), INR(1_999.99), INR(20_000))).toBe(false);
    expect(monthlyLimitCheck(INR(19_000), 0n, INR(20_000))).toBe(true);
    expect(monthlyLimitCheck(INR(18_999.99), 0n, INR(20_000))).toBe(false);
    const ago = (m: number) => new Date(NOW.getTime() - m * MIN);
    expect(budgetQuotaCheck([ago(50), ago(20)], NOW).trip).toBe(false);
    expect(budgetQuotaCheck([ago(50), ago(20), ago(1)], NOW)).toEqual({ trip: true, autoClearAt: new Date(ago(50).getTime() + HOUR), count: 3 });
    expect(budgetQuotaCheck([ago(61), ago(20), ago(1)], NOW).trip).toBe(false);
    expect(syncStaleCheck(ago(45), 2, NOW)).toBe(false);
    expect(syncStaleCheck(new Date(ago(45).getTime() - 1), 2, NOW)).toBe(true);
    expect(syncStaleCheck(null, 0, NOW)).toBe(false);
  });

  it("INR floors follow the currency: a fresh FX rate, else the same whole amount at the currency's exponent", () => {
    expect(inrEquivalentMinor(INR(500), "INR", null)).toBe(INR(500));
    expect(inrEquivalentMinor(INR(500), "JPY", null)).toBe(500n);
    expect(inrEquivalentMinor(INR(500), "KWD", null)).toBe(500_000n);
  });
});

// =====================================================================================================================
// A pass over a workspace
// =====================================================================================================================

describe("daily_limit", () => {
  it("trips at the limit, pauses every platform campaign through stopCommitments, and notifies once; a re-run changes nothing", async () => {
    seed({ daily: 5_000 });
    campaign("c1");
    campaign("c2");
    spend("adset", "m_c1s", "2026-10-28", 5_000);
    await run();
    const [b] = breakers("daily_limit");
    expect(b).toMatchObject({ scopeType: "workspace", effect: "pause_scope", state: "tripped", autoClearAt: new Date("2026-10-28T18:30:00Z") });
    expect(calls.stop).toEqual([{ filter: { origin: "all" }, actor: { type: "breaker", kind: "daily_limit" } }]);
    expect(rows("adCampaign").map((c) => c.status)).toEqual(["paused", "paused"]);
    expect((b.details as { lowerings: unknown[] }).lowerings).toHaveLength(2);
    expect(noticeFor("daily_limit")).toHaveLength(1);
    expect(noticeFor("daily_limit")[0]).toMatchObject({ title: "Today's ads limit is used up", dedupeKey: `spend-breaker:${b.id}` });
    expect(b.notifiedAt).toEqual(NOW);
    await run();
    expect(breakers("daily_limit")).toHaveLength(1);
    expect(calls.stop).toHaveLength(1);
    expect(noticeFor("daily_limit")).toHaveLength(1);
  });

  it("does not trip just below the limit", async () => {
    seed({ daily: 5_000 });
    campaign("c1");
    spend("adset", "m_c1s", "2026-10-28", 4_999.99);
    await run();
    expect(breakers("daily_limit")).toHaveLength(0);
    expect(calls.stop).toHaveLength(0);
  });

  it("at the next account day resumes only its own pauses, only through reserveAds (actor breaker), then clears", async () => {
    seed({ daily: 5_000 });
    campaign("c1");
    campaign("c2");
    spend("adset", "m_c1s", "2026-10-28", 5_000);
    await run();
    // After the breaker paused both, a person paused c2 again: that newer lowering is theirs, so c2 stays paused.
    await recordLowering(T, { kind: "pause", metaObjectId: "m_c2" }, owner, "Keep this off", async () => undefined, { objectLevel: "campaign" });
    vi.setSystemTime(new Date("2026-10-29T03:00:00Z"));
    spend("adset", "m_c1s", "2026-10-29", 0, { syncedAt: new Date("2026-10-29T02:55:00Z") });
    await run();
    expect(calls.resume.map((r) => r.campaignId)).toEqual(["c1"]);
    expect(calls.resume[0].actor).toEqual({ type: "breaker", kind: "daily_limit" });
    const activation = rows("spendLedger").find((r) => r.action === "ads.campaign.activate" && r.phase === "requested")!;
    expect(activation).toMatchObject({ actorType: "breaker", actorId: "daily_limit", targetId: "c1" });
    expect(rows("adCampaign").map((c) => [c.id, c.status])).toEqual([["c1", "active"], ["c2", "paused"]]);
    expect(breakers("daily_limit")[0].state).toBe("cleared");
    expect(calls.notify.find((n) => String(n.dedupeKey).endsWith(":cleared"))).toMatchObject({ title: "Today's ads limit was reset" });
  });

  it("resumes nothing while spending is stopped", async () => {
    seed({ daily: 5_000 });
    campaign("c1");
    spend("adset", "m_c1s", "2026-10-28", 5_000);
    await run();
    rows("spendControl")[0].freeze = "all";
    vi.setSystemTime(new Date("2026-10-29T03:00:00Z"));
    spend("adset", "m_c1s", "2026-10-29", 0, { syncedAt: new Date("2026-10-29T02:55:00Z") });
    await run();
    expect(calls.resume).toHaveLength(0);
    expect(breakers("daily_limit")[0].state).toBe("cleared");
    expect(rows("adCampaign")[0].status).toBe("paused");
  });
});

describe("monthly_limit", () => {
  it("pauses every platform campaign and queues the emergency Meta limit write when a pause failed", async () => {
    seed({ daily: 5_000, monthly: 20_000, managed: true });
    campaign("c1");
    campaign("c2");
    spend("account", "acc1", "2026-10-27", 19_000);
    spend("account", "acc1", "2026-10-28", 0);
    failStop.add("c2");
    await run(MANAGED);
    expect(breakers("monthly_limit")).toHaveLength(1);
    expect(calls.stop[0]).toEqual({ filter: { origin: "all" }, actor: { type: "breaker", kind: "monthly_limit" } });
    expect(calls.enqueue).toEqual([{ queue: SPEND_QUEUES.metacapP0, payload: expect.objectContaining({ tenantId: T, adAccountAssetId: "acc1", failedObjectIds: ["m_c2"] }) }]);
  });

  it("queues nothing when every pause worked, and clears when the limit is raised (objects stay paused)", async () => {
    seed({ daily: 5_000, monthly: 20_000, managed: true });
    campaign("c1");
    spend("account", "acc1", "2026-10-27", 19_000);
    spend("account", "acc1", "2026-10-28", 0);
    await run(MANAGED);
    expect(calls.enqueue).toHaveLength(0);
    rows("spendAllowance")[0].monthlyLimitMinor = INR(50_000);
    await run(MANAGED);
    expect(breakers("monthly_limit")[0].state).toBe("cleared");
    expect(rows("adCampaign")[0].status).toBe("paused");
    expect(calls.notify.find((n) => n.title === "Your ads can run again")).toBeTruthy();
  });
});

describe("performance breakers pause only assistant campaigns unless the toggle is on", () => {
  const lastThreeDays = (id: string, rupeesEach: number, leadsEach: number) => {
    for (const d of ["2026-10-26", "2026-10-27", "2026-10-28"]) spend("adset", `m_${id}s`, d, rupeesEach, { results: leadsEach });
  };

  it("efficiency on a campaign your team made: a notice only", async () => {
    seed({ target: 100 });
    campaign("c1");
    lastThreeDays("c1", 200, 0);
    await run();
    expect(breakers("efficiency")[0]).toMatchObject({ scopeType: "adset", scopeId: "m_c1s", effect: "notify_only" });
    expect(calls.pauseAdSet).toHaveLength(0);
    expect(noticeFor("efficiency")[0]).toMatchObject({ title: "'Set c1' costs too much per lead", severity: "heads_up" });
  });

  it("efficiency pauses the ad set when the owner lets safety stops pause their team's campaigns, or when an assistant launched it", async () => {
    seed({ target: 100, toggle: true });
    campaign("c1");
    lastThreeDays("c1", 200, 0);
    await run();
    expect(breakers("efficiency")[0].effect).toBe("pause_scope");
    expect(calls.pauseAdSet).toEqual(["m_c1s"]);
    h.db.reset();
    calls.pauseAdSet = [];
    seed({ target: 100 });
    campaign("c3", 1_000, "assistant");
    lastThreeDays("c3", 200, 0);
    await run();
    expect(calls.pauseAdSet).toEqual(["m_c3s"]);
  });

  it("efficiency stays off without a target, and below the minimum spend", async () => {
    seed({ target: null });
    campaign("c1");
    lastThreeDays("c1", 200, 0);
    await run();
    expect(breakers("efficiency")).toHaveLength(0);
    h.db.reset();
    seed({ target: 100 });
    campaign("c1");
    lastThreeDays("c1", 166, 0);
    await run();
    expect(breakers("efficiency")).toHaveLength(0);
  });

  it("spend_jump trips on a sudden rise between two samples, not on a normal one", async () => {
    seed();
    campaign("c3", 1_000, "assistant");
    spend("adset", "m_c3s", "2026-10-28", 100);
    sample("m_c3s", new Date(NOW.getTime() - 15 * MIN), 100);
    sample("m_c3s", NOW, 350);
    await run();
    expect(breakers("spend_jump")).toHaveLength(0);
    sample("m_c3s", new Date(NOW.getTime() + 15 * MIN), 700);
    vi.setSystemTime(new Date(NOW.getTime() + 15 * MIN));
    await run();
    expect(breakers("spend_jump")[0]).toMatchObject({ scopeId: "m_c3s", effect: "pause_scope" });
    expect(calls.pauseAdSet).toEqual(["m_c3s"]);
  });

  it("cpm_ctr_anomaly blocks raises for 24 hours and a repeat restarts the clock", async () => {
    seed();
    campaign("c1");
    for (const d of ["2026-10-21", "2026-10-22", "2026-10-23", "2026-10-27"]) spend("adset", "m_c1s", d, 100, { impressions: 1_000, clicks: 30 });
    spend("adset", "m_c1s", "2026-10-28", 0);
    sample("m_c1s", new Date(NOW.getTime() - 60 * MIN), 10, 2_000, 60);
    sample("m_c1s", NOW, 260, 3_000, 90);
    await run();
    const [b] = breakers("cpm_ctr_anomaly");
    expect(b).toMatchObject({ effect: "block_raises", scopeId: "m_c1s", autoClearAt: new Date(NOW.getTime() + 24 * HOUR) });
    expect(calls.pauseAdSet).toHaveLength(0);
    vi.setSystemTime(new Date(NOW.getTime() + 30 * MIN));
    sample("m_c1s", new Date(NOW.getTime() + 30 * MIN), 500, 3_600, 108);
    await run();
    expect(breakers("cpm_ctr_anomaly")).toHaveLength(1);
    expect(breakers("cpm_ctr_anomaly")[0].autoClearAt).toEqual(new Date(NOW.getTime() + 30 * MIN + 24 * HOUR));
    expect(lastHour([])).toBeNull();
  });

  it("account_spike blocks raises for the rest of the account day", async () => {
    seed({ daily: 50_000 });
    campaign("c1");
    spend("account", "acc1", "2026-10-25", 4_000);
    spend("account", "acc1", "2026-10-28", 6_000);
    await run();
    expect(breakers("account_spike")).toHaveLength(0);
    rows("spendDaily").find((r) => (r.day as Date).getTime() === new Date("2026-10-28T00:00:00Z").getTime() && r.scopeType === "account")!.amountMinor = INR(6_000.01);
    await run();
    expect(breakers("account_spike")[0]).toMatchObject({ scopeType: "workspace", effect: "block_raises", autoClearAt: new Date("2026-10-28T18:30:00Z") });
  });

  it("pacing pauses assistant-launched campaigns only, and warns first", async () => {
    seed({ daily: 50_000, target: null });
    campaign("c1", 1_000, "human");
    campaign("c3", 1_000, "assistant");
    spend("adset", "m_c3s", "2026-10-28", 650);
    await run();
    expect(breakers("pacing")).toHaveLength(0);
    expect(calls.notify.find((n) => String(n.dedupeKey).startsWith("spend-pacing-warning:"))).toMatchObject({ title: "Your ad assistant is spending faster than planned" });
    rows("spendDaily").find((r) => r.scopeId === "m_c3s")!.amountMinor = INR(1_200.01);
    await run();
    expect(breakers("pacing")[0]).toMatchObject({ effect: "pause_scope", scopeType: "workspace" });
    expect(calls.stop).toEqual([{ filter: { origin: "assistant" }, actor: { type: "breaker", kind: "pacing" } }]);
    expect(rows("adCampaign").map((c) => [c.id, c.status])).toEqual([["c1", "active"], ["c3", "paused"]]);
  });
});

describe("budget_change_quota and sync_stale", () => {
  const budgetRow = (minutesAgo: number) =>
    h.db.seed("spendLedger", [{ id: `b${minutesAgo}`, tenantId: T, pot: "ads", action: "ads.adset.budget_cut", phase: "requested", actorType: "user", actorId: "u_owner", metaObjectId: "m_c1s", reason: "x", correlationId: `cb${minutesAgo}`, createdAt: new Date(NOW.getTime() - minutesAgo * MIN) }]);

  it("3 budget changes in 60 minutes trip it (2 do not), and lowering then pauses instead of editing the budget", async () => {
    seed();
    campaign("c1");
    spend("adset", "m_c1s", "2026-10-28", 0);
    budgetRow(50);
    budgetRow(20);
    await run();
    expect(breakers("budget_change_quota")).toHaveLength(0);
    const ports = { pauseAdSet: vi.fn(async () => undefined), cutBudget: vi.fn(async () => undefined) };
    expect(await lowerAdSetSpend({ db: h.db.prisma as never, tenantId: T, now: NOW }, "m_c1s", 50_000, owner, "Lowered.", ports)).toBe("cut");
    budgetRow(5);
    await run();
    expect(breakers("budget_change_quota")[0]).toMatchObject({ scopeId: "m_c1s", effect: "block_raises", autoClearAt: new Date(NOW.getTime() + 10 * MIN) });
    expect(await lowerAdSetSpend({ db: h.db.prisma as never, tenantId: T, now: NOW }, "m_c1s", 50_000, owner, "Lowered.", ports)).toBe("paused");
    expect(ports.pauseAdSet).toHaveBeenCalledTimes(1);
    expect(ports.cutBudget).toHaveBeenCalledTimes(1);
  });

  it("sync_stale opens after 45 minutes without a good sync while campaigns are live, and clears on the next one", async () => {
    seed();
    campaign("c1");
    spend("adset", "m_c1s", "2026-10-28", 0, { syncedAt: new Date(NOW.getTime() - 44 * MIN) });
    await run();
    expect(breakers("sync_stale")).toHaveLength(0);
    vi.setSystemTime(new Date(NOW.getTime() + 2 * MIN));
    await run();
    expect(breakers("sync_stale")[0]).toMatchObject({ effect: "block_raises", scopeType: "workspace" });
    rows("spendDaily")[0].syncedAt = new Date(NOW.getTime() + MIN);
    await run();
    expect(breakers("sync_stale")[0].state).toBe("cleared");
  });

  it("the demo workspace runs no ads breakers", async () => {
    seed({ daily: 5_000 });
    rows("metaAsset")[0].meta = { currency: "INR", timezone: "Asia/Kolkata", demo: true };
    campaign("c1");
    spend("adset", "m_c1s", "2026-10-28", 9_000);
    expect(await run()).toMatchObject({ skipped: "demo" });
    expect(breakers()).toHaveLength(0);
  });
});

describe("the task and the admin list's cache", () => {
  it("runs every 5 minutes and on spend.breakers.run", () => {
    expect(periodic.find((p) => p.name === BREAKERS_TASK)?.everyMs).toBe(5 * MIN);
    expect(typeof queues[SPEND_QUEUES.breakersRun]).toBe("function");
  });

  it("writes spend:summary:<tenantId> for every workspace it visits and for the rest in batches", async () => {
    seed({ daily: 5_000, monthly: 20_000, target: null });
    h.db.seed("tenant", [{ id: "t2", name: "Quiet", slug: "quiet", status: "active", billingExempt: false, deletedAt: null }]);
    rows("tenant")[0].deletedAt = null;
    campaign("c1");
    spend("adset", "m_c1s", "2026-10-28", 1_000);
    const out = await runAllBreakers({ deps, env: ENFORCE });
    expect(out.tenants).toBe(1);
    const row = rows("platformSetting").find((r) => r.key === summaryKey(T))!.value as Row;
    expect(row).toMatchObject({ tenantId: T, name: "Shop", demo: false, newWorkspaceLimits: "lifted", state: "on", noAdAccount: false, breakersOpen: 0, requestsWaiting: 0, metaLimit: { state: "off", label: "Off" }, asOf: NOW.toISOString() });
    expect((row.adsToday as Row).limit).toMatchObject({ minor: "500000", formatted: "₹5,000" });
    expect((row.adsToday as Row).spent).toMatchObject({ formatted: "₹1,000" });
    expect(typeof row.riskPct).toBe("number");
    const quiet = rows("platformSetting").find((r) => r.key === summaryKey("t2"))!.value as Row;
    expect(quiet).toMatchObject({ tenantId: "t2", noAdAccount: true, adsToday: null, metaLimit: { state: "no_ad_account", label: "No ad account" } });
  });

  it("builds the other workspaces' rows a few at a time within the cache's own budget; the next run carries on after the last row it reached", async () => {
    const quiet = ["q1", "q2", "q3", "q4", "q5", "q6"];
    h.db.seed("tenant", quiet.map((id) => ({ id, name: id, slug: id, status: "active", billingExempt: false, deletedAt: null })));
    // every row takes 3 s: the first four, built side by side, take the batch past its 10 s budget
    const phones = h.db.model("phoneNumber") as unknown as { count: (...a: unknown[]) => Promise<number> };
    const count = phones.count;
    const slow = vi.spyOn(phones, "count").mockImplementation(async (...a: unknown[]) => {
      vi.setSystemTime(new Date(Date.now() + 3_000));
      return count.apply(phones, a);
    });
    const written = () => rows("platformSetting").filter((r) => String(r.key).startsWith("spend:summary:q")).map((r) => String(r.key).slice("spend:summary:".length));
    try {
      expect(await runAllBreakers({ deps, env: ENFORCE })).toMatchObject({ summaries: 4 });
      expect(written()).toEqual(["q1", "q2", "q3", "q4"]);
      expect(rows("platformSetting").find((r) => r.key === "spend:summary:cursor")?.value).toEqual({ after: "q4" });
      await runAllBreakers({ deps, env: ENFORCE });
      expect(written()).toEqual(quiet);
    } finally {
      slow.mockRestore();
    }
  });

  it("labels the demo workspace and leaves it out of the risk sort", async () => {
    seed();
    rows("metaAsset")[0].meta = { currency: "INR", timezone: "Asia/Kolkata", demo: true };
    const row = await writeSummary(T);
    expect(row).toMatchObject({ demo: true, riskPct: null, metaLimit: { state: "demo", label: "Demo" } });
  });
});
