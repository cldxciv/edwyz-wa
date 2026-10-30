import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSpendDb, Row } from "./helpers/fake-spend-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeSpendDb }));

vi.mock("@/lib/db", async () => {
  const { createFakeSpendDb } = await import("./helpers/fake-spend-db");
  h.db = createFakeSpendDb();
  return { prisma: h.db.prisma };
});

import { approvalFingerprint, canonicalJson, hashApprovalToken, isApprovalTokenShape, newApprovalToken, tokenMatchesHash } from "@/lib/spend/approval-token";
import {
  AdsNeedsApprovalError,
  adsHeadroomDetail,
  assertPermitValid,
  budgetQuotaOpen,
  currentAdsFingerprint,
  defaultAdsPolicy,
  headroom,
  intentSubject,
  noteBudgetWriteError,
  permitForPausedCreate,
  recordLowering,
  reserveAds,
  resetBookForTests,
  setAdsPolicy,
  setMetaCapPreRead,
  settleAds,
  SpendBreakerError,
  SpendPermitExpiredError,
  type AdsPolicyInput,
} from "@/lib/spend/book";
import { ceil175, ceil210, dayRisk, externalRisk, hasEnded, remainingMonth, weekCap } from "@/lib/spend/commitments";
import { NeedsApprovalError, ShadowOnlyError, SpendBlockedError, SpendGuardBypassError } from "@/lib/spend/errors";
import { resetSpendStateCache } from "@/lib/spend/kill";
import { heldSpendLocks } from "@/lib/spend/lock";
import { deliverInApp } from "@/lib/spend/notify";
import { mintPermit } from "@/lib/spend/permit";
import { flagSandbox, isSandboxAccount } from "@/lib/spend/sandbox";
import { observe, parseObjectRead, reconcileCommitments, resetReconcileCursor } from "@/lib/spend/reconcile";
import { crosscheckMonth, crosscheckOrphans, driftPercent, ORPHANS_KEY, verifyCounters, VERIFY_RESERVED_SQL } from "@/lib/spend/tasks/ledger";
import type { AdsPermit, AdsRaiseIntent, SpendActor } from "@/lib/spend/types";
import { mergeSpendAreas, worker as spendWorker } from "@/lib/spend/worker";
import { createFakeMeta, type FakeMeta } from "./helpers/fake-meta";

// Wednesday 28 Oct 2026, 12:00 in Asia/Kolkata.
const NOW = new Date("2026-10-28T06:30:00Z");
const T = "t1";
const INR = (rupees: number) => BigInt(rupees * 100);
const owner: SpendActor = { type: "user", userId: "u_owner", role: "owner" };
const assistant: SpendActor = { type: "assistant", assistantKey: "ads_optimizer" };
const ENFORCE = { SPEND_ENFORCE: "enforce" } as Record<string, string>;
const OBSERVE = { SPEND_ENFORCE: "observe" } as Record<string, string>;
const MANAGED_ENV = { SPEND_ENFORCE: "enforce", SPEND_CAP_MODE: "enforce" } as Record<string, string>;

const rows = (name: string) => h.db.rows(name);
const ledger = (phase?: string) => rows("spendLedger").filter((r) => !phase || r.phase === phase);
const commitment = (metaObjectId: string) => rows("spendCommitment").find((r) => r.metaObjectId === metaObjectId && r.status !== "stopped");

function seedWorkspace(opts: { daily?: bigint | null; monthly?: bigint | null; currency?: string; accountCurrency?: string; spendingAccount?: string; demo?: boolean; sandbox?: boolean } = {}) {
  h.db.seed("tenant", [{ id: T, name: "Shop", slug: "shop", status: "active", billingExempt: false }]);
  h.db.seed("metaAsset", [
    { id: "acc1", tenantId: T, connectionId: "mc1", type: "ad_account", externalId: "act_111", name: "Shop ads", status: "active", meta: { currency: opts.accountCurrency ?? "INR", timezone: "Asia/Kolkata", ...(opts.demo ? { demo: true } : {}) }, sandbox: opts.sandbox ?? false, createdAt: new Date("2026-01-01") },
    { id: "acc2", tenantId: T, connectionId: "mc1", type: "ad_account", externalId: "act_222", name: "Second", status: "active", meta: { currency: "INR", timezone: "Asia/Kolkata" }, sandbox: false, createdAt: new Date("2026-02-01") },
  ]);
  h.db.seed("spendControl", [{ tenantId: T, probation: "lifted", spendingAdAccountAssetId: opts.spendingAccount ?? "acc1", timezone: "Asia/Kolkata" }]);
  h.db.seed("spendAllowance", [{ id: "sa1", tenantId: T, pot: "ads", currency: opts.currency ?? "INR", dailyLimitMinor: opts.daily === undefined ? INR(5_000) : opts.daily, monthlyLimitMinor: opts.monthly === undefined ? INR(50_000) : opts.monthly }]);
}

/** A campaign with one ad set (Meta id m_<id>s) and one ad (m_<id>a). Budgets in rupees. */
function seedCampaign(id: string, o: { status?: string; daily?: number; account?: string; endsAt?: Date | null; origin?: string; lifetime?: number } = {}) {
  h.db.seed("adCampaign", [
    { id, tenantId: T, adAccountAssetId: o.account ?? "acc1", metaCampaignId: `m_${id}`, name: `Campaign ${id}`, template: "lead_generation", objective: "OUTCOME_LEADS", status: o.status ?? "paused", dailyBudgetMinor: (o.daily ?? 1_000) * 100, currency: "INR", endsAt: o.endsAt ?? null, origin: o.origin ?? "human", assistantKey: null, lifetimeBudgetMinor: o.lifetime ? BigInt(o.lifetime * 100) : null, sandbox: false },
  ]);
  h.db.seed("adSet", [{ id: `${id}s`, tenantId: T, campaignId: id, metaAdSetId: `m_${id}s`, name: `Set ${id}`, status: o.status ?? "paused", targeting: {}, dailyBudgetMinor: (o.daily ?? 1_000) * 100, lifetimeBudgetMinor: null }]);
  h.db.seed("ad", [{ id: `${id}a`, tenantId: T, adSetId: `${id}s`, metaAdId: `m_${id}a`, name: `Ad ${id}`, status: "paused", creative: {} }]);
}

/** A stored live commitment for a campaign's ad set, today's peak at the budget. */
function seedLive(id: string, rupees: number, extra: Row = {}) {
  h.db.seed("spendCommitment", [
    {
      id: `cm_${id}`,
      tenantId: T,
      adAccountAssetId: "acc1",
      campaignId: id,
      adSetId: `${id}s`,
      metaObjectId: `m_${id}s`,
      objectLevel: "adset",
      origin: "human",
      currency: "INR",
      timezone: "Asia/Kolkata",
      dailyBudgetMinor: INR(rupees),
      dayKey: new Date(Date.UTC(2026, 9, 28)),
      dayStartBudgetMinor: INR(rupees),
      peakDailyBudgetMinor: INR(rupees),
      weekStart: new Date(Date.UTC(2026, 9, 25)),
      weekPeakDailyBudgetMinor: INR(rupees),
      status: "live",
      ...extra,
    },
  ]);
}

const daily = (scopeType: string, scopeId: string, day: string, rupees: number, origin = "platform", syncedAt = new Date(NOW.getTime() - 5 * 60_000)) =>
  h.db.seed("spendDaily", [{ tenantId: T, pot: "ads", scopeType, scopeId, day: new Date(`${day}T00:00:00Z`), currency: "INR", amountMinor: INR(rupees), origin, source: "fast_sync", syncedAt }]);

function managedLimit(over: Row = {}) {
  h.db.seed("metaSpendLimit", [
    { adAccountAssetId: "acc1", tenantId: T, accountExternalId: "act_111", mode: "managed", unitMode: "major_write", semantics: "cumulative", managedCapMinor: INR(60_000), lastReadCapMinor: INR(60_000), lastReadAmountSpentMinor: INR(10_000), lastReadAt: new Date(NOW.getTime() - 10 * 60_000), lastWriteAt: new Date(NOW.getTime() - 60 * 60_000), lastError: null, ...over },
  ]);
}

const activate = (id: string): AdsRaiseIntent => ({ kind: "activate", campaignId: id, sets: [{ adSetId: `${id}s`, metaAdSetId: `m_${id}s` }] });
const raise = (id: string, rupees: number): AdsRaiseIntent => ({ kind: "raise_budget", adSetId: `${id}s`, metaAdSetId: `m_${id}s`, toMinor: INR(rupees) });
let keyN = 0;
const key = () => `k${++keyN}`;
const reserve = (intent: AdsRaiseIntent, actor: SpendActor = owner, opts: Record<string, unknown> = {}) => reserveAds(T, intent, actor, { idempotencyKey: key(), reason: "Testing", env: ENFORCE, ...opts });

async function refusal(p: Promise<unknown>): Promise<SpendBlockedError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(SpendBlockedError);
  return e as SpendBlockedError;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  h.db.reset();
  resetSpendStateCache();
  resetBookForTests();
});
afterEach(() => vi.useRealTimers());

// =====================================================================================================================
describe("worst-case maths", () => {
  const oct = (d: number, h = 0) => new Date(Date.UTC(2026, 9, d, h) - 5.5 * 3_600_000);
  const plain = (D: bigint, endsAt: Date | null = null) => ({ dailyBudgetMinor: D, lifetimeBudgetMinor: null, peakToday: D, weekPeak: D, endsAt });
  const none = { byDay: new Map<string, bigint>(), lifetime: 0n, today: 0n };

  it("gives the October 2026 table: 33,250 / 19,250 / 7,000", () => {
    expect(remainingMonth(plain(INR(1_000)), oct(1), "Asia/Kolkata", none)).toBe(INR(33_250));
    expect(remainingMonth(plain(INR(1_000), oct(14, 23)), oct(1), "Asia/Kolkata", none)).toBe(INR(19_250));
    expect(remainingMonth(plain(INR(1_000)), oct(28, 10), "Asia/Kolkata", none)).toBe(INR(7_000));
  });

  it("rounds 1.75x and 2.1x up, gives 0 (never negative) past the day cap, and caps by the lifetime budget", () => {
    expect(ceil175(1n)).toBe(2n);
    expect(ceil175(100n)).toBe(175n);
    expect(ceil210(10n)).toBe(21n);
    expect(weekCap(10n, true)).toBe(84n);
    expect(dayRisk(plain(INR(1_000)), { ...none, today: INR(2_000) }, NOW)).toBe(0n);
    expect(dayRisk({ ...plain(INR(1_000)), lifetimeBudgetMinor: INR(1_200) }, { ...none, lifetime: INR(500) }, NOW)).toBe(INR(700));
  });

  it("a lifetime-only commitment can spend all of its remainder today", () => {
    const c = { dailyBudgetMinor: null, lifetimeBudgetMinor: INR(9_000), peakToday: 0n, weekPeak: 0n, endsAt: null };
    expect(dayRisk(c, { ...none, lifetime: INR(1_000) }, NOW)).toBe(INR(8_000));
    expect(remainingMonth(c, NOW, "Asia/Kolkata", { ...none, lifetime: INR(1_000) })).toBe(INR(8_000));
  });

  it("an ended campaign risks nothing", () => {
    expect(hasEnded(plain(INR(1_000), new Date(NOW.getTime() - 3_600_000)), NOW)).toBe(true);
    expect(dayRisk(plain(INR(1_000), new Date(NOW.getTime() - 3_600_000)), none, NOW)).toBe(0n);
  });

  it("outside spend: E is the highest day of the last 7, the day risk is E minus today", () => {
    const byDay = new Map([
      ["2026-10-27", INR(300)],
      ["2026-10-28", INR(100)],
    ]);
    const r = externalRisk(byDay, NOW, "Asia/Kolkata");
    expect(r.e).toBe(INR(300));
    expect(r.day).toBe(INR(200));
    // Today: 525 - 100 = 425; the week room 2,100 - (300 + 100) = 1,700 limits the rest: 425 + 525 + 525 + 225.
    expect(r.month).toBe(INR(1_700));
  });
});

// =====================================================================================================================
describe("headroom", () => {
  it("counts a live commitment at its worst case, never the nominal budget", async () => {
    seedWorkspace();
    seedCampaign("c1", { status: "active" });
    seedLive("c1", 1_000);
    daily("adset", "m_c1s", "2026-10-26", 1_000);
    daily("adset", "m_c1s", "2026-10-27", 1_000);
    daily("adset", "m_c1s", "2026-10-28", 400);
    const room = await headroom(T, "ads", { env: ENFORCE });
    expect(room.stale).toBe(false);
    expect(room.today.spent).toBe(INR(400));
    // dayRisk = 1,750 - 400.
    expect(room.today.committed).toBe(INR(1_350));
    expect(room.today.left).toBe(INR(5_000) - INR(400) - INR(1_350));
    // Week room 7,000 - (1,000 + 1,000 + 400) = 4,600 caps the rest of October.
    expect(room.month.spent).toBe(INR(2_400));
    expect(room.month.committed).toBe(INR(4_600));
    expect(room.month.left).toBe(INR(50_000) - INR(7_000));
    expect(room.external.counted).toBe(false);
  });

  it("treats today's spend as unknown after 60 minutes without a fast sync (the full worst case)", async () => {
    seedWorkspace();
    seedCampaign("c1", { status: "active" });
    seedLive("c1", 1_000);
    daily("adset", "m_c1s", "2026-10-28", 400, "platform", new Date(NOW.getTime() - 2 * 3_600_000));
    const room = await headroom(T, "ads", { env: ENFORCE });
    expect(room.stale).toBe(true);
    expect(room.today.committed).toBe(INR(1_750));
  });

  it("counts a DB-active campaign that has no commitment (orphan) as a live one", async () => {
    seedWorkspace();
    seedCampaign("c9", { status: "active", daily: 2_000 });
    const detail = await adsHeadroomDetail(T, { env: ENFORCE });
    expect(detail.state.orphans).toHaveLength(1);
    expect(detail.headroom.today.committed).toBe(INR(3_500));
    expect(detail.figures.perCommitment[0]).toMatchObject({ metaObjectId: "m_c9s", synthetic: true });
  });

  it("counts outside spend only when Meta's limit is managed (5.1), and then from the account row", async () => {
    seedWorkspace();
    seedCampaign("c1", { status: "active" });
    seedLive("c1", 1_000);
    daily("adset", "m_c1s", "2026-10-28", 400);
    daily("account", "acc1", "2026-10-27", 300, "external");
    daily("account", "acc1", "2026-10-28", 100, "external");
    daily("account", "acc1", "2026-10-28", 500, "all");
    const off = await headroom(T, "ads", { env: ENFORCE });
    expect(off.external).toMatchObject({ counted: false, spentMonth: INR(400) });
    expect(off.today.spent).toBe(INR(400));

    managedLimit();
    // Observe mode of wall (a) is not "managed".
    expect((await headroom(T, "ads", { env: { SPEND_CAP_MODE: "observe" } })).external.counted).toBe(false);
    const on = await headroom(T, "ads", { env: MANAGED_ENV });
    expect(on.external.counted).toBe(true);
    expect(on.today.spent).toBe(INR(500));
    const ext = externalRisk(new Map([["2026-10-27", INR(300)], ["2026-10-28", INR(100)]]), NOW, "Asia/Kolkata");
    expect(on.today.committed).toBe(INR(1_350) + ext.day);
    expect(on.month.committed - off.month.committed).toBe(ext.month);
    expect(on.metaLimit).toMatchObject({ managed: true, mode: "managed", roomMinor: INR(50_000) });
  });

  it("reads WhatsApp and AI from the counters", async () => {
    seedWorkspace();
    h.db.seed("spendAllowance", [{ id: "sa2", tenantId: T, pot: "messaging", currency: "INR", dailyLimitMinor: INR(500), monthlyLimitMinor: INR(5_000) }]);
    h.db.seed("spendCounter", [
      { tenantId: T, pot: "messaging", periodKind: "day", periodKey: "2026-10-28", currency: "INR", reservedMinor: INR(20), spentMinor: INR(100) },
      { tenantId: T, pot: "messaging", periodKind: "month", periodKey: "2026-10", currency: "INR", reservedMinor: INR(20), spentMinor: INR(1_000) },
    ]);
    const room = await headroom(T, "messaging");
    expect(room.today).toEqual({ spent: INR(100), committed: 0n, held: INR(20), left: INR(380) });
    expect(room.month.left).toBe(INR(3_980));
  });
});

// =====================================================================================================================
describe("reserveAds", () => {
  it("reserves at the worst case, writes the request and mints the permit", async () => {
    seedWorkspace();
    seedCampaign("c1");
    const permit = await reserve(activate("c1"));
    expect(permit).toMatchObject({ type: "ads", kind: "activate", tenantId: T, adAccountAssetId: "acc1", accountExternalId: "act_111" });
    expect(Object.keys(permit.objects).sort()).toEqual(["m_c1", "m_c1a", "m_c1s"]);
    expect(permit.objects.m_c1s).toMatchObject({ status: "ACTIVE", maxDailyMinor: INR(1_000) });
    expect(permit.maxUses).toBe(5);
    expect(permit.expiresAt.getTime() - NOW.getTime()).toBe(10 * 60_000);
    const c = commitment("m_c1s")!;
    expect(c).toMatchObject({ status: "reserved", correlationId: permit.correlationId, peakDailyBudgetMinor: INR(1_000), weekPeakDailyBudgetMinor: INR(1_000) });
    expect((c.reservedUntil as Date).getTime()).toBe(NOW.getTime() + 10 * 60_000);
    const [req] = ledger("requested");
    expect(req).toMatchObject({ action: "ads.campaign.activate", correlationId: permit.correlationId, forecastTodayMinor: INR(1_750), forecastMonthMinor: INR(7_000), undo: { action: "pause_campaign", campaignId: "c1" } });
    // The lock was taken (I5).
    expect(h.db.raw.some((r) => r.sql.includes("pg_advisory_xact_lock"))).toBe(true);
  });

  it("returns the same permit for the same idempotency key", async () => {
    seedWorkspace();
    seedCampaign("c1");
    const opts = { idempotencyKey: "activate:c1:v1", reason: "Testing", env: ENFORCE };
    const a = await reserveAds(T, activate("c1"), owner, opts);
    const b = await reserveAds(T, activate("c1"), owner, opts);
    expect(b).toBe(a);
    expect(ledger("requested")).toHaveLength(1);
    // Another process (no cache) re-mints the same permit from the request.
    resetBookForTests();
    const c = await reserveAds(T, activate("c1"), owner, opts);
    expect(c.correlationId).toBe(a.correlationId);
    expect(c.objects).toEqual(a.objects);
    expect(c.expiresAt.getTime()).toBe(a.expiresAt.getTime());
    // Settled: the key is used up.
    await settleAds(a, "applied");
    await expect(reserveAds(T, activate("c1"), owner, opts)).rejects.toThrow(/already handled/);
  });

  it("refuses over the daily limit with what is left and what it needs, as a standalone refused row", async () => {
    seedWorkspace({ daily: INR(2_000) });
    seedCampaign("c0", { status: "active" });
    seedLive("c0", 1_000);
    seedCampaign("c1");
    const e = await refusal(reserve(activate("c1"), owner, { env: OBSERVE }));
    expect(e.code).toBe("spend.daily_limit");
    expect(e.params).toMatchObject({ left: { minor: INR(250), currency: "INR" }, needs: { minor: INR(1_750), currency: "INR" } });
    expect(e.message).toContain("Left today: ₹250.");
    expect(e.message).toContain("could spend up to ₹1,750 today");
    expect(ledger("requested")).toHaveLength(0);
    expect(ledger("refused")).toHaveLength(1);
    expect(ledger("refused")[0]).toMatchObject({ observe: false, reasonCodes: ["daily_limit"] });
    expect(commitment("m_c1s")).toBeUndefined();
  });

  it("refuses over the monthly limit when enforced, and only records it in observe mode for a person", async () => {
    seedWorkspace({ daily: INR(100_000), monthly: INR(8_000) });
    seedCampaign("c0", { status: "active" });
    seedLive("c0", 1_000);
    seedCampaign("c1");
    const e = await refusal(reserve(activate("c1")));
    expect(e.code).toBe("spend.monthly_limit");
    expect(e.params).toMatchObject({ left: { minor: INR(1_000) }, needs: { minor: INR(7_000) } });
    expect(e.message).toContain("Left this month: ₹1,000.");

    const permit = await reserve(activate("c1"), owner, { env: OBSERVE });
    const would = ledger("refused").find((r) => r.observe === true)!;
    expect(would).toMatchObject({ reasonCodes: ["monthly_limit"], snapshot: { continuedAs: permit.correlationId } });
    expect(ledger("requested")).toHaveLength(1);
    // An assistant is always enforced.
    await expect(reserve(activate("c1"), assistant, { env: OBSERVE })).rejects.toBeInstanceOf(SpendBlockedError);
  });

  it("observe mode still refuses the checks enforced today (I12)", async () => {
    seedWorkspace({ daily: null });
    seedCampaign("c1");
    expect((await refusal(reserve(activate("c1"), owner, { env: OBSERVE }))).code).toBe("spend.no_limit");

    h.db.reset();
    resetSpendStateCache();
    seedWorkspace({ daily: INR(1_000) });
    seedCampaign("c1");
    expect((await refusal(reserve(activate("c1"), owner, { env: OBSERVE }))).code).toBe("spend.daily_limit");

    h.db.reset();
    resetSpendStateCache();
    seedWorkspace({ accountCurrency: "USD" });
    seedCampaign("c1");
    const cur = await refusal(reserve(activate("c1"), owner, { env: OBSERVE }));
    expect(cur.code).toBe("spend.currency");
    expect(cur.message).toBe("This ad account uses USD, but your limits are in INR. Limits for USD aren't set up yet.");

    await expect(reserve({ kind: "create_live" }, owner, { env: OBSERVE })).rejects.toThrow(/created paused/);
    expect(ledger("refused").at(-1)).toMatchObject({ reasonCodes: ["create_live"] });
  });

  it("refuses an ad account that is not the spending account (observe records it for people)", async () => {
    seedWorkspace({ spendingAccount: "acc2" });
    seedCampaign("c1");
    expect((await refusal(reserve(activate("c1")))).code).toBe("spend.not_spending_account");
    await expect(reserve(activate("c1"), owner, { env: OBSERVE })).resolves.toBeTruthy();
    expect(ledger("refused").some((r) => r.observe === true && (r.reasonCodes as string[]).includes("not_spending_account"))).toBe(true);
  });

  it("keeps one of Meta's 4 budget changes an hour: the fourth raise in 60 minutes is refused", async () => {
    seedWorkspace();
    seedCampaign("c1", { status: "active" });
    seedLive("c1", 1_000);
    const at = (minAgo: number) => new Date(NOW.getTime() - minAgo * 60_000);
    h.db.seed(
      "spendLedger",
      [50, 30, 10].map((m, i) => ({ id: `q${i}`, tenantId: T, pot: "ads", action: "ads.adset.budget_raise", phase: "requested", actorType: "user", metaObjectId: "m_c1s", reason: "r", correlationId: `cq${i}`, createdAt: at(m) })),
    );
    const e = await refusal(reserve(raise("c1", 1_100)));
    expect(e.code).toBe("spend.meta_rate");
    expect((e.params.retryAt as Date).getTime()).toBe(at(50).getTime() + 3_600_000);
    expect(e.message).toBe("Meta allows only 4 budget changes an hour for each ad set. Try again after 12:10 pm.");
    // A breaker is exempt from the quota.
    await expect(reserve(raise("c1", 1_100), { type: "breaker", kind: "daily_limit" })).resolves.toBeTruthy();
  });

  it("Meta's 613/1487632 answer opens budget_change_quota, and raises are refused with spend.meta_rate for 60 minutes", async () => {
    seedWorkspace();
    seedCampaign("c1", { status: "active" });
    seedLive("c1", 1_000);
    expect(await noteBudgetWriteError(T, "m_c1s", { code: 100 })).toBe(false);
    expect(await noteBudgetWriteError(T, "m_c1s", { code: 613, subcode: 1487632 })).toBe(true);
    const b = rows("spendBreaker")[0];
    expect(b).toMatchObject({ kind: "budget_change_quota", scopeType: "adset", scopeId: "m_c1s", effect: "block_raises" });
    expect((b.autoClearAt as Date).getTime()).toBe(NOW.getTime() + 3_600_000);
    expect(await budgetQuotaOpen(T, "m_c1s")).toBe(true);
    // Enforced even in observe mode: Meta would refuse it anyway.
    const e = await refusal(reserve(raise("c1", 1_100), owner, { env: OBSERVE }));
    expect(e.code).toBe("spend.meta_rate");
  });

  it("refuses with META_CAP_TOO_LOW from the stored Meta read and asks for a re-plan", async () => {
    seedWorkspace({ daily: INR(100_000), monthly: INR(1_000_000) });
    seedCampaign("c1");
    managedLimit({ lastReadCapMinor: INR(11_000), lastReadAmountSpentMinor: INR(10_000) });
    const enqueue = vi.fn(async () => undefined);
    const e = await refusal(reserve(activate("c1"), owner, { env: MANAGED_ENV, enqueue }));
    expect(e.code).toBe("spend.meta_cap_too_low");
    expect(enqueue).toHaveBeenCalledWith("spend.metacap.replan", { tenantId: T, adAccountAssetId: "acc1", reason: "meta_cap_too_low" });

    // Enough room passes.
    h.db.rows("metaSpendLimit")[0].lastReadCapMinor = INR(20_000);
    await expect(reserve(activate("c1"), owner, { env: MANAGED_ENV, enqueue })).resolves.toBeTruthy();
  });

  it("in observe mode a person's launch with too little room on Meta goes ahead, is recorded, and still asks for a re-plan", async () => {
    seedWorkspace({ daily: INR(100_000), monthly: INR(1_000_000) });
    seedCampaign("c1");
    managedLimit({ lastReadCapMinor: INR(11_000), lastReadAmountSpentMinor: INR(10_000) });
    const enqueue = vi.fn(async () => undefined);
    const permit = await reserve(activate("c1"), owner, { env: { ...MANAGED_ENV, SPEND_ENFORCE: "observe" }, enqueue });
    expect(ledger("refused")[0]).toMatchObject({ observe: true, reasonCodes: ["meta_cap_too_low"], snapshot: { continuedAs: permit.correlationId } });
    expect(enqueue).toHaveBeenCalledWith("spend.metacap.replan", { tenantId: T, adAccountAssetId: "acc1", reason: "meta_cap_too_low" });
  });

  it("refuses when the stored Meta read is older than 6 hours (no Meta call inside the lock)", async () => {
    seedWorkspace({ daily: INR(100_000), monthly: INR(1_000_000) });
    seedCampaign("c1");
    managedLimit({ lastReadAt: new Date(NOW.getTime() - 7 * 3_600_000), lastWriteAt: new Date(NOW.getTime() - 8 * 3_600_000) });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const e = await refusal(reserve(activate("c1"), owner, { env: MANAGED_ENV, enqueue: async () => undefined }));
    expect(e.code).toBe("spend.meta_cap_too_low");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("refuses under a freeze and under an open breaker", async () => {
    seedWorkspace();
    seedCampaign("c1");
    rows("spendControl")[0].freeze = "all";
    expect((await refusal(reserve(activate("c1")))).code).toBe("spend.frozen");
    rows("spendControl")[0].freeze = "assistants";
    resetSpendStateCache();
    expect((await refusal(reserve(activate("c1"), assistant))).code).toBe("spend.frozen");
    rows("spendControl")[0].freeze = "none";
    h.db.seed("spendBreaker", [{ id: "b1", tenantId: T, kind: "efficiency", scopeType: "campaign", scopeId: "c1", effect: "pause_scope", reason: "No leads", state: "tripped" }]);
    await expect(reserve(activate("c1"))).rejects.toBeInstanceOf(SpendBreakerError);
    // A breaker resuming after its own clear passes only its own breaker.
    await expect(reserve(activate("c1"), { type: "breaker", kind: "efficiency" }, { exemptBreakerId: "b1" })).resolves.toBeTruthy();
  });

  it("breakers that stop assistants only (sync_stale, pacing, ...) never refuse a person's raise", async () => {
    seedWorkspace();
    seedCampaign("c1", { endsAt: new Date("2026-11-15T00:00:00Z") });
    seedCampaign("c2", { endsAt: new Date("2026-11-15T00:00:00Z") });
    h.db.seed("spendBreaker", [
      { id: "b_sync", tenantId: T, kind: "sync_stale", scopeType: "workspace", scopeId: T, effect: "block_raises", reason: "No sync", state: "tripped" },
      { id: "b_units", tenantId: T, kind: "meta_cap_units", scopeType: "ad_account", scopeId: "acc1", effect: "block_raises", reason: "Units", state: "tripped" },
    ]);
    const permit = await reserve(activate("c1"));
    await expect(assertPermitValid(permit, "m_c1s")).resolves.toBeUndefined();
    const e = await reserve(activate("c2"), { type: "assistant", assistantKey: "ads_optimizer", approvalId: "sp_1" }, { approvalId: "sp_1" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SpendBreakerError);
    expect((e as SpendBreakerError).breakers.map((b) => b.kind).sort()).toEqual(["meta_cap_units", "sync_stale"]);
    expect(ledger("refused").at(-1)!.reasonCodes).toContain("breaker");
  });

  it("refuses the demo workspace with spend.demo", async () => {
    seedWorkspace({ demo: true });
    seedCampaign("c1");
    const e = await refusal(reserve(activate("c1")));
    expect(e.code).toBe("spend.demo");
    expect(e.message).toBe("This is a demo workspace, so nothing can be spent.");
    expect(ledger("refused")[0]).toMatchObject({ reasonCodes: ["demo"] });
  });

  it("an assistant that needs approval gets a SpendApproval written in the same transaction, and no reservation", async () => {
    seedWorkspace();
    seedCampaign("c1", { endsAt: new Date("2026-11-15T00:00:00Z") });
    const err = await reserve(activate("c1"), assistant, { proposalId: "op1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeedsApprovalError);
    expect(err).toBeInstanceOf(AdsNeedsApprovalError);
    const e = err as AdsNeedsApprovalError;
    const [approval] = rows("spendApproval");
    expect(approval).toMatchObject({ id: e.approvalId, tenantId: T, assistantKey: "ads_optimizer", pot: "ads", actionKind: "activate", direction: "raise", status: "pending", proposalId: "op1", summary: "Turn on 'Campaign c1'", forecastTodayMinor: INR(1_750) });
    expect(approval.tokenHash).toBe(createHash("sha256").update(e.token).digest("hex"));
    expect(approval.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect((approval.expiresAt as Date).getTime()).toBe(NOW.getTime() + 12 * 3_600_000);
    // The token never leaves in JSON.
    expect(JSON.stringify(e)).not.toContain(e.token);
    expect(ledger("requested")).toHaveLength(0);
    expect(rows("spendCommitment")).toHaveLength(0);
    expect(ledger("info").map((r) => r.action)).toContain("approval.create");
    expect(rows("notice")[0]).toMatchObject({ source: "spend", kind: "approval_waiting", audienceMinRole: "admin" });
  });

  it("an assistant in its learning period gets a shadow record, and nothing runs", async () => {
    seedWorkspace();
    seedCampaign("c1", { endsAt: new Date("2026-11-15T00:00:00Z") });
    h.db.seed("assistantMandate", [{ id: "am1", tenantId: T, assistantKey: "ads_optimizer", enabled: true, level: 2, allowedOps: ["activate"], shadowUntil: new Date(NOW.getTime() + 14 * 86_400_000) }]);
    await expect(reserve(activate("c1"), assistant)).rejects.toBeInstanceOf(ShadowOnlyError);
    expect(rows("assistantShadowRecord")[0]).toMatchObject({ tenantId: T, assistantKey: "ads_optimizer", actionKind: "activate", forecastMonthMinor: INR(7_000) });
    expect(ledger("shadow")).toHaveLength(1);
    expect(rows("spendCommitment")).toHaveLength(0);
    expect(rows("spendApproval")).toHaveLength(0);
  });

  it("applying an approval skips only the autonomy step", async () => {
    seedWorkspace();
    seedCampaign("c1", { endsAt: new Date("2026-11-15T00:00:00Z") });
    const permit = await reserve(activate("c1"), { type: "assistant", assistantKey: "ads_optimizer", approvalId: "sp_9" }, { approvalId: "sp_9" });
    expect(permit.kind).toBe("activate");
    expect(ledger("requested")[0]).toMatchObject({ approvalId: "sp_9", actorType: "assistant" });
    // Every other check still runs.
    rows("spendAllowance")[0].dailyLimitMinor = INR(1_000);
    seedCampaign("c2", { endsAt: new Date("2026-11-15T00:00:00Z") });
    await expect(reserve(activate("c2"), assistant, { approvalId: "sp_10" })).rejects.toBeInstanceOf(SpendBlockedError);
  });

  it("an assistant activation without an end date is refused", async () => {
    seedWorkspace();
    seedCampaign("c1");
    expect((await refusal(reserve(activate("c1"), assistant, { approvalId: "sp_1" }))).code).toBe("spend.end_date_required");
  });

  it("a raise reserves with the old budget kept for a failed call, and the peak rises", async () => {
    seedWorkspace();
    seedCampaign("c1", { status: "active" });
    seedLive("c1", 1_000);
    const permit = await reserve(raise("c1", 1_500));
    expect(permit.objects.m_c1s).toEqual({ maxDailyMinor: INR(1_500) });
    expect(commitment("m_c1s")).toMatchObject({ status: "reserved", dailyBudgetMinor: INR(1_500), pendingFromMinor: INR(1_000), peakDailyBudgetMinor: INR(1_500), dayStartBudgetMinor: INR(1_000) });
    expect(ledger("requested")[0]).toMatchObject({ action: "ads.adset.budget_raise", forecastTodayMinor: INR(875), undo: { action: "set_adset_budget", dailyBudgetMinor: "100000" } });
    await settleAds(permit, "failed", { error: "meta_error" });
    expect(commitment("m_c1s")).toMatchObject({ status: "live", dailyBudgetMinor: INR(1_000), pendingFromMinor: null });
    // The peak stays: Meta's rule uses the day's highest budget.
    expect(commitment("m_c1s")!.peakDailyBudgetMinor).toBe(INR(1_500));
  });

  it("a new budget on an ad set that is not running is counted while reserved, and not once applied", async () => {
    seedWorkspace();
    seedCampaign("c1");
    const permit = await reserve(raise("c1", 1_500));
    expect(commitment("m_c1s")).toMatchObject({ status: "reserved", dailyBudgetMinor: INR(1_500) });
    expect((await headroom(T, "ads", { env: ENFORCE })).today.committed).toBe(ceil175(INR(1_500)));
    await settleAds(permit, "applied");
    expect(rows("spendCommitment")[0].status).toBe("stopped");
    expect((await headroom(T, "ads", { env: ENFORCE })).today.committed).toBe(0n);
  });

  it("the approval fingerprint can be recomputed at decision time, and changes when the ad set changes", async () => {
    seedWorkspace();
    seedCampaign("c1", { status: "active", endsAt: new Date("2026-11-15T00:00:00Z") });
    seedLive("c1", 1_000);
    const e = (await reserve(raise("c1", 1_100), assistant).catch((x: unknown) => x)) as AdsNeedsApprovalError;
    expect(e).toBeInstanceOf(AdsNeedsApprovalError);
    const stored = rows("spendApproval")[0];
    // The stored intent, read back as JSON (amounts as strings), gives the same fingerprint.
    expect(await currentAdsFingerprint(T, stored.intent as never)).toBe(stored.fingerprint);
    rows("spendCommitment")[0].dailyBudgetMinor = INR(900);
    expect(await currentAdsFingerprint(T, raise("c1", 1_100))).not.toBe(stored.fingerprint);
  });

  it("asks policy.decide for assistants, with the figures the book computed", async () => {
    seedWorkspace();
    seedCampaign("c1", { status: "active", endsAt: new Date("2026-11-15T00:00:00Z") });
    seedLive("c1", 1_000);
    const seen: AdsPolicyInput[] = [];
    const previous = setAdsPolicy((input) => {
      seen.push(input);
      return defaultAdsPolicy(input);
    });
    try {
      await reserve(raise("c1", 1_100), assistant).catch(() => undefined);
    } finally {
      setAdsPolicy(previous);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0].intent).toMatchObject({ op: "raise_budget", dayStartBudgetMinor: INR(1_000), toMinor: INR(1_100), hasEndDate: true });
    // Raising 1,000 to 1,100 lifts today's peak: 1,925 - 1,750.
    expect(seen[0].delta.todayMinor).toBe(INR(175));
    expect(seen[0].headroom).toMatchObject({ freeze: { workspace: "none", platform: "none" }, blockingBreaker: false, metaLimitManaged: false, dailyLimitMinor: INR(5_000), monthlyLimitMinor: INR(50_000) });
    expect(seen[0].headroom.dayLeftMinor).toBe(INR(5_000) - INR(1_750));
    // A person never goes through the autonomy policy.
    seen.length = 0;
    setAdsPolicy((input) => {
      seen.push(input);
      return defaultAdsPolicy(input);
    });
    try {
      await reserve(raise("c1", 1_200));
    } finally {
      setAdsPolicy(previous);
    }
    expect(seen).toHaveLength(0);
  });

  it("a Level 1 assistant raises on its own within 20% of the day's starting budget, and needs approval above it", async () => {
    seedWorkspace();
    seedCampaign("c1", { status: "active", endsAt: new Date("2026-11-15T00:00:00Z") });
    seedLive("c1", 1_000);
    managedLimit({ lastReadCapMinor: INR(200_000) });
    h.db.seed("assistantMandate", [{ id: "am1", tenantId: T, assistantKey: "ads_optimizer", enabled: true, level: 1, allowedOps: ["raise_budget"], raiseStepPct: 20, approvalSharePct: 25, shadowUntil: null }]);
    const env = { ...MANAGED_ENV, ASSISTANT_SPEND_ENABLED: "true" };
    const permit = await reserve(raise("c1", 1_200), assistant, { env });
    expect(permit.objects.m_c1s).toEqual({ maxDailyMinor: INR(1_200) });
    expect(ledger("requested")[0]).toMatchObject({ actorType: "assistant", assistantKey: "ads_optimizer", autonomyLevel: 1 });
    await settleAds(permit, "applied");
    // The day started at 1,000, so 1,250 is 25% up: approval.
    const e = await reserve(raise("c1", 1_250), assistant, { env }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AdsNeedsApprovalError);
    expect(ledger("info").find((r) => r.action === "approval.create")!.reasonCodes).toContain("level_1_over_step");
    // With ASSISTANT_SPEND_ENABLED off, every assistant acts at Level 0: even +5% waits for an approver.
    const off = await reserve(raise("c1", 1_210), assistant, { env: MANAGED_ENV }).catch((x: unknown) => x);
    expect(off).toBeInstanceOf(AdsNeedsApprovalError);
  });

  it("an account without a managed Meta limit makes every assistant raise wait for approval, whatever the level", async () => {
    seedWorkspace();
    seedCampaign("c1", { status: "active", endsAt: new Date("2026-11-15T00:00:00Z") });
    seedLive("c1", 1_000);
    h.db.seed("assistantMandate", [{ id: "am1", tenantId: T, assistantKey: "ads_optimizer", enabled: true, level: 2, allowedOps: ["raise_budget"], raiseStepPct: 20, approvalSharePct: 25, shadowUntil: null }]);
    const e = await reserve(raise("c1", 1_050), assistant, { env: { ...ENFORCE, ASSISTANT_SPEND_ENABLED: "true" } }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AdsNeedsApprovalError);
    expect(ledger("info").find((r) => r.action === "approval.create")!.reasonCodes).toContain("meta_limit_not_managed");
  });

  it("the mandate's own ceilings refuse, with what is left and what it needs", async () => {
    seedWorkspace();
    seedCampaign("c1", { status: "active", endsAt: new Date("2026-11-15T00:00:00Z") });
    seedLive("c1", 1_000);
    h.db.seed("assistantMandate", [{ id: "am1", tenantId: T, assistantKey: "ads_optimizer", enabled: true, level: 1, allowedOps: ["raise_budget"], maxDailyMinor: INR(100), raiseStepPct: 20, approvalSharePct: 25, shadowUntil: null }]);
    const e = await refusal(reserve(raise("c1", 1_100), assistant));
    expect(e.code).toBe("spend.daily_limit");
    expect(e.params).toMatchObject({ left: { minor: INR(100) }, needs: { minor: INR(175) } });
    expect(ledger("refused")[0].reasonCodes).toContain("policy_mandate_daily");
    expect(rows("spendApproval")).toHaveLength(0);
  });

  it("an assistant that is not in the registry is refused", async () => {
    seedWorkspace();
    seedCampaign("c1", { endsAt: new Date("2026-11-15T00:00:00Z") });
    const e = await reserve(activate("c1"), { type: "assistant", assistantKey: "made_up" }).catch((x: unknown) => x);
    expect(e).toMatchObject({ status: 409, message: "This assistant is not known to Edwyz." });
    expect(ledger("refused")[0].reasonCodes).toContain("policy_unknown_assistant");
    expect(rows("spendApproval")).toHaveLength(0);
    expect(rows("spendCommitment")).toHaveLength(0);
  });

  it("a newer request about the same ad set supersedes the one still waiting, and leaves other ad sets alone", async () => {
    seedWorkspace();
    seedCampaign("c1", { status: "active", endsAt: new Date("2026-11-15T00:00:00Z") });
    seedLive("c1", 1_000);
    seedCampaign("c2", { status: "active", endsAt: new Date("2026-11-15T00:00:00Z") });
    seedLive("c2", 1_000);
    const first = (await reserve(raise("c1", 1_100), assistant).catch((x: unknown) => x)) as AdsNeedsApprovalError;
    const other = (await reserve(raise("c2", 1_100), assistant).catch((x: unknown) => x)) as AdsNeedsApprovalError;
    const second = (await reserve(raise("c1", 1_200), assistant).catch((x: unknown) => x)) as AdsNeedsApprovalError;
    const status = (id: string) => rows("spendApproval").find((r) => r.id === id)!.status;
    expect(status(first.approvalId)).toBe("superseded");
    expect(rows("spendApproval").find((r) => r.id === first.approvalId)).toMatchObject({ decidedVia: "system" });
    expect(status(second.approvalId)).toBe("pending");
    expect(status(other.approvalId)).toBe("pending");
    expect(ledger("info").filter((r) => r.action === "approval.supersede").map((r) => r.approvalId)).toEqual([first.approvalId]);
    expect(intentSubject(raise("c1", 1))).toBe("adset:c1s");
    expect(intentSubject({ kind: "create_live" })).toBeNull();
  });

  it("a shadow record keeps what the configured level would have done, and why", async () => {
    seedWorkspace();
    seedCampaign("c1", { status: "active", endsAt: new Date("2026-11-15T00:00:00Z") });
    seedLive("c1", 1_000);
    managedLimit({ lastReadCapMinor: INR(200_000) });
    h.db.seed("assistantMandate", [{ id: "am1", tenantId: T, assistantKey: "ads_optimizer", enabled: true, level: 1, allowedOps: ["raise_budget"], raiseStepPct: 20, approvalSharePct: 25, shadowUntil: new Date(NOW.getTime() + 86_400_000) }]);
    await expect(reserve(raise("c1", 1_100), assistant, { env: MANAGED_ENV })).rejects.toBeInstanceOf(ShadowOnlyError);
    expect(rows("assistantShadowRecord")[0]).toMatchObject({ wouldDecision: "auto", baseline: { wouldReason: "level_1_step", level: 1 } });
    expect(ledger("shadow")[0].reasonCodes).toEqual(["learning", "would_auto", "level_1_step"]);
    expect(ledger("requested")).toHaveLength(0);
  });

  it("flags rows of a sandbox ad account", async () => {
    seedWorkspace({ sandbox: true });
    seedCampaign("c1");
    await reserve(activate("c1"));
    expect(commitment("m_c1s")!.sandbox).toBe(true);
    expect(ledger("requested")[0]).toMatchObject({ sandbox: true });
    expect(ledger("requested")[0].reasonCodes).toContain("sandbox");
  });
});

// =====================================================================================================================
describe("assertPermitValid and settleAds", () => {
  it("passes a fresh permit and refuses everything else before any HTTP call", async () => {
    seedWorkspace();
    seedCampaign("c1");
    const permit = await reserve(activate("c1"));
    await expect(assertPermitValid(permit, "m_c1s")).resolves.toBeUndefined();
    await expect(assertPermitValid(permit, "m_other")).rejects.toBeInstanceOf(SpendGuardBypassError);
    await expect(assertPermitValid({ ...permit } as AdsPermit, "m_c1s")).rejects.toBeInstanceOf(SpendGuardBypassError);
    await expect(assertPermitValid(permit, "m_c1s", { now: new Date(NOW.getTime() + 11 * 60_000) })).rejects.toBeInstanceOf(SpendPermitExpiredError);
    rows("spendControl")[0].freeze = "all";
    await expect(assertPermitValid(permit, "m_c1s")).rejects.toMatchObject({ code: "spend.frozen" });
    rows("spendControl")[0].freeze = "none";
    h.db.seed("spendBreaker", [{ id: "b2", tenantId: T, kind: "daily_limit", scopeType: "workspace", scopeId: T, effect: "pause_scope", reason: "Limit", state: "tripped" }]);
    await expect(assertPermitValid(permit, "m_c1s")).rejects.toBeInstanceOf(SpendBreakerError);
  });

  it("settles to live, unconfirmed or stopped, always with exactly one outcome row", async () => {
    seedWorkspace({ daily: INR(100_000), monthly: INR(1_000_000) });
    seedCampaign("c1");
    seedCampaign("c2");
    seedCampaign("c3");
    const a = await reserve(activate("c1"));
    await settleAds(a, "applied");
    await settleAds(a, "applied");
    expect(commitment("m_c1s")).toMatchObject({ status: "live", reservedUntil: null });
    expect(ledger().filter((r) => r.correlationId === a.correlationId && r.phase !== "requested")).toHaveLength(1);

    const b = await reserve(activate("c2"));
    await settleAds(b, "unconfirmed");
    expect(commitment("m_c2s")).toMatchObject({ status: "unconfirmed" });
    // Still counted.
    expect((await headroom(T, "ads", { env: ENFORCE })).today.committed).toBe(INR(3_500));

    const c = await reserve(activate("c3"));
    await settleAds(c, "failed");
    expect(rows("spendCommitment").find((r) => r.metaObjectId === "m_c3s")!.status).toBe("stopped");
    expect(ledger("failed")).toHaveLength(1);
  });

  it("a crash between reserve and settle leaves the reservation counted", async () => {
    seedWorkspace();
    seedCampaign("c1");
    await reserve(activate("c1"));
    const later = await headroom(T, "ads", { env: ENFORCE, now: new Date(NOW.getTime() + 30 * 60_000) });
    expect(later.today.committed).toBe(INR(1_750));
  });
});

// =====================================================================================================================
describe("recordLowering", () => {
  it("never takes the lock for the call, and stops the commitment afterwards", async () => {
    seedWorkspace();
    seedCampaign("c1", { status: "active" });
    seedLive("c1", 1_000);
    const seen: { locks: number; raw: number }[] = [];
    const out = await recordLowering(T, { kind: "pause", metaObjectId: "m_c1" }, owner, "Pausing", async (permit) => {
      expect(permit).toMatchObject({ type: "lowering", kind: "pause", metaObjectIds: ["m_c1"] });
      seen.push({ locks: heldSpendLocks().length, raw: h.db.raw.filter((r) => r.sql.includes("pg_advisory_xact_lock")).length });
    });
    expect(seen).toEqual([{ locks: 0, raw: 0 }]);
    expect(out.bookkeeping).toBe("done");
    expect(rows("spendCommitment")[0].status).toBe("stopped");
    expect(ledger().map((r) => [r.action, r.phase])).toEqual([
      ["ads.campaign.pause", "requested"],
      ["ads.campaign.pause", "applied"],
    ]);
  });

  it("works while frozen and while another transaction holds the lock (the reconciler fixes the bookkeeping)", async () => {
    seedWorkspace();
    seedCampaign("c1", { status: "active" });
    seedLive("c1", 1_000);
    rows("spendControl")[0].freeze = "all";
    h.db.onRaw((call) => {
      if (call.sql.includes("pg_advisory_xact_lock")) throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
      return undefined;
    });
    const run = vi.fn(async () => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = await recordLowering(T, { kind: "pause", metaObjectId: "m_c1s" }, owner, "Stop it", run);
    errors.mockRestore();
    expect(run).toHaveBeenCalledOnce();
    expect(out.bookkeeping).toBe("deferred");
    // Over-counted (safe) until the reconciler runs.
    expect(rows("spendCommitment")[0].status).toBe("live");
    expect(ledger("applied")[0].reasonCodes).toContain("bookkeeping_deferred");
  });

  it("a budget cut lowers the budget and keeps the day's peak", async () => {
    seedWorkspace();
    seedCampaign("c1", { status: "active" });
    seedLive("c1", 1_000);
    await recordLowering(T, { kind: "cut_budget", metaObjectId: "m_c1s", toMinor: INR(400) }, owner, "Cut", async () => undefined);
    expect(rows("spendCommitment")[0]).toMatchObject({ dailyBudgetMinor: INR(400), peakDailyBudgetMinor: INR(1_000), status: "live" });
    expect(ledger("requested")[0]).toMatchObject({ action: "ads.adset.budget_cut" });
  });

  it("a failed call is ledgered as failed and the error goes back to the caller", async () => {
    seedWorkspace();
    seedLive("c1", 1_000);
    await expect(recordLowering(T, { kind: "pause", metaObjectId: "m_c1s" }, owner, "Stop", async () => Promise.reject(new Error("meta down")))).rejects.toThrow("meta down");
    expect(ledger("failed")).toHaveLength(1);
    expect(rows("spendCommitment")[0].status).toBe("live");
  });
});

// =====================================================================================================================
describe("ad sets paused under a running campaign (orphan rule)", () => {
  it("a paused ad set stops counting at once, an orphan one gets a stopped mark, and both count again after the campaign changes", async () => {
    seedWorkspace();
    seedCampaign("c1", { status: "active" });
    h.db.seed("adSet", [{ id: "c1t", tenantId: T, campaignId: "c1", metaAdSetId: "m_c1t", name: "Set t", status: "active", targeting: {}, dailyBudgetMinor: 50_000, lifetimeBudgetMinor: null }]);
    rows("adCampaign")[0].updatedAt = new Date(NOW.getTime() - 86_400_000);
    seedLive("c1", 1_000);
    const committed = async (at = NOW) => (await headroom(T, "ads", { env: ENFORCE, now: at })).today.committed;
    // c1s is live; c1t has no commitment, so it is an orphan at 1.75 x ₹500.
    expect(await committed()).toBe(INR(1_750) + INR(875));

    await recordLowering(T, { kind: "pause", metaObjectId: "m_c1s" }, owner, "Pause one ad set", async () => undefined);
    expect(await committed()).toBe(INR(875));

    await recordLowering(T, { kind: "pause", metaObjectId: "m_c1t" }, owner, "Pause the other", async () => undefined);
    expect(rows("spendCommitment").filter((r) => r.metaObjectId === "m_c1t")).toEqual([expect.objectContaining({ status: "stopped", campaignId: "c1", adSetId: "c1t", dailyBudgetMinor: 50_000n })]);
    expect(await committed()).toBe(0n);

    // The campaign changes afterwards (for example it is turned on again by a path that wrote no commitment): the marks are
    // older than that change, so both ad sets count again until a commitment or a read says otherwise. The safe side.
    rows("adCampaign")[0].updatedAt = new Date(NOW.getTime() + 60_000);
    expect(await committed(new Date(NOW.getTime() + 120_000))).toBe(INR(1_750) + INR(875));
  });

  it("a stopped campaign-level mark covers every ad set of the campaign", async () => {
    seedWorkspace();
    seedCampaign("c1", { status: "active" });
    rows("adCampaign")[0].updatedAt = new Date(NOW.getTime() - 86_400_000);
    h.db.seed("spendCommitment", [
      { id: "cm_old", tenantId: T, adAccountAssetId: "acc1", campaignId: "c1", adSetId: null, metaObjectId: "m_c1", objectLevel: "campaign", origin: "human", currency: "INR", timezone: "Asia/Kolkata", dailyBudgetMinor: INR(1_000), status: "stopped", updatedAt: new Date(NOW.getTime() - 3_600_000) },
    ]);
    expect((await headroom(T, "ads", { env: ENFORCE })).today.committed).toBe(0n);
  });
});

// =====================================================================================================================
describe("the Meta limit pre-read before the lock (4.6 step 8, I10)", () => {
  afterEach(() => setMetaCapPreRead(null));
  const stale = { lastReadCapMinor: INR(11_000), lastReadAmountSpentMinor: INR(10_000), lastReadAt: new Date(NOW.getTime() - 30 * 60_000), lastWriteAt: new Date(NOW.getTime() - 60 * 60_000) };
  const big = { daily: INR(100_000), monthly: INR(1_000_000) };

  it("reads a managed account again when the stored read is older than 15 minutes, with no lock held, and uses the new values", async () => {
    seedWorkspace(big);
    seedCampaign("c1");
    managedLimit(stale);
    const calls: { locks: number; lockSql: number; args: unknown[] }[] = [];
    setMetaCapPreRead(async (tenantId, assetId, maxAgeMs) => {
      calls.push({ locks: heldSpendLocks().length, lockSql: h.db.raw.filter((r) => r.sql.includes("pg_advisory_xact_lock")).length, args: [tenantId, assetId, maxAgeMs] });
      Object.assign(rows("metaSpendLimit")[0], { lastReadCapMinor: INR(30_000), lastReadAt: NOW });
    });
    // The stored room (₹1,000) is below today's worst case (₹1,750); the fresh read (₹20,000) is not.
    await expect(reserve(activate("c1"), owner, { env: MANAGED_ENV, enqueue: async () => undefined })).resolves.toBeTruthy();
    expect(calls).toEqual([{ locks: 0, lockSql: 0, args: [T, "acc1", 900_000] }]);
  });

  it("is not called for a fresh read or an account Edwyz does not manage", async () => {
    seedWorkspace(big);
    seedCampaign("c1");
    managedLimit();
    const preRead = vi.fn(async () => undefined);
    setMetaCapPreRead(preRead);
    await reserve(activate("c1"), owner, { env: MANAGED_ENV });
    seedCampaign("c2");
    rows("metaSpendLimit")[0].lastReadAt = new Date(NOW.getTime() - 3_600_000);
    await reserve(activate("c2"), owner, { env: ENFORCE });
    expect(preRead).not.toHaveBeenCalled();
  });

  it("a failed read falls back to the stored one (under 6 hours), and never blocks on its own", async () => {
    seedWorkspace(big);
    seedCampaign("c1");
    managedLimit({ ...stale, lastReadCapMinor: INR(60_000) });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(reserve(activate("c1"), owner, { env: MANAGED_ENV, metaPreRead: async () => Promise.reject(new Error("Meta is down")) })).resolves.toBeTruthy();
    expect(errors.mock.calls.some((c) => String(c[0]).includes("pre-read failed"))).toBe(true);
    errors.mockRestore();
  });
});

// =====================================================================================================================
describe("permitForPausedCreate", () => {
  it("is neutral: paths for paused creates, objectCount + 2 uses, 10 minutes; refused only under a freeze `all`", async () => {
    seedWorkspace();
    const p = await permitForPausedCreate(T, "111", 4, owner);
    expect(p.paths).toEqual(["act_111/campaigns", "act_111/adsets", "act_111/adcreatives", "act_111/ads"]);
    expect(p.maxUses).toBe(6);
    expect(p.expiresAt.getTime() - NOW.getTime()).toBe(600_000);
    rows("spendControl")[0].freeze = "assistants";
    await expect(permitForPausedCreate(T, "act_111", 1, owner)).resolves.toBeTruthy();
    rows("spendControl")[0].freeze = "all";
    await expect(permitForPausedCreate(T, "act_111", 1, owner)).rejects.toMatchObject({ code: "spend.frozen" });
  });
});

// =====================================================================================================================
describe("approval tokens and fingerprints", () => {
  it("issues 32 random bytes as base64url and stores only the SHA-256", () => {
    const { token, tokenHash } = newApprovalToken();
    expect(isApprovalTokenShape(token)).toBe(true);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(tokenHash).toBe(hashApprovalToken(token));
    expect(tokenMatchesHash(token, tokenHash)).toBe(true);
    expect(tokenMatchesHash(newApprovalToken().token, tokenHash)).toBe(false);
    expect(tokenMatchesHash("short", tokenHash)).toBe(false);
  });

  it("the fingerprint is canonical and changes when the object or the allowance changes", () => {
    const intent = { kind: "raise_budget", adSetId: "s1", metaAdSetId: "m1", toMinor: 120_000n };
    const obj = { metaObjectId: "m1", status: "live", dailyBudgetMinor: 100_000n };
    const a = approvalFingerprint({ intent, objects: [obj], allowanceVersion: 3 });
    expect(approvalFingerprint({ intent: { toMinor: 120_000n, metaAdSetId: "m1", adSetId: "s1", kind: "raise_budget" }, objects: [obj], allowanceVersion: 3 })).toBe(a);
    expect(approvalFingerprint({ intent, objects: [{ ...obj, dailyBudgetMinor: 90_000n }], allowanceVersion: 3 })).not.toBe(a);
    expect(approvalFingerprint({ intent, objects: [obj], allowanceVersion: 4 })).not.toBe(a);
    expect(canonicalJson({ b: 1n, a: [new Date(0), undefined] })).toBe('{"a":["1970-01-01T00:00:00.000Z",null],"b":"1"}');
    expect(() => canonicalJson({ x: Number.NaN })).toThrow();
  });
});

// =====================================================================================================================
describe("sandbox and notices", () => {
  it("knows a sandbox account and flags rows", () => {
    expect(isSandboxAccount({ sandbox: true })).toBe(true);
    expect(isSandboxAccount({ sandbox: "yes" })).toBe(false);
    expect(isSandboxAccount(null)).toBe(false);
    expect(flagSandbox({ a: 1 }, true)).toEqual({ a: 1, sandbox: true });
  });

  it("stores one in-app notice per dedupe key", async () => {
    const notice = { tenantId: T, kind: "breaker_tripped" as const, severity: "heads_up" as const, audience: "owner" as const, dedupeKey: "d1", title: "Paused", body: "Paused because of the limit." };
    expect(await deliverInApp(notice)).toEqual({ delivered: true, deduplicated: false });
    expect(await deliverInApp(notice)).toEqual({ delivered: true, deduplicated: true });
    expect(await deliverInApp({ ...notice, audience: "platform_admins", dedupeKey: "d2" })).toMatchObject({ delivered: false });
    expect(rows("notice")).toHaveLength(1);
    expect(rows("notice")[0]).toMatchObject({ source: "spend", audienceMinRole: "owner", payload: { title: "Paused" } });
  });
});

// A permit-shaped object that was never minted is refused (B8).
it("mintPermit is the only way to a permit", async () => {
  seedWorkspace();
  const fake = { type: "ads", correlationId: "c", tenantId: T, kind: "activate", adAccountAssetId: "acc1", accountExternalId: "act_111", objects: { m: {} }, paths: ["m"], maxUses: 1, issuedAt: NOW, expiresAt: new Date(NOW.getTime() + 1) };
  await expect(assertPermitValid(fake as unknown as AdsPermit, "m")).rejects.toBeInstanceOf(SpendGuardBypassError);
  expect(mintPermit(fake as never)).toBeTruthy();
});

// =====================================================================================================================
describe("reconcileCommitments", () => {
  let meta: FakeMeta;
  const deps = (over: Record<string, unknown> = {}) => ({
    access: async () => ({ token: "tok" }),
    read: async (_t: string, id: string) => meta.request("GET", id).body as Record<string, unknown>,
    ...over,
  });

  beforeEach(() => {
    resetReconcileCursor();
    meta = createFakeMeta({ now: NOW, accountId: "act_111" });
    meta.addCampaign({ id: "m_c1", status: "ACTIVE" });
    meta.addAdSet({ id: "m_c1s", campaignId: "m_c1", status: "ACTIVE", dailyBudgetMinor: INR(1_200) });
  });

  it("settles a crashed reservation from Meta: ACTIVE becomes live at Meta's budget, with one reconciled outcome", async () => {
    seedWorkspace();
    seedCampaign("c1");
    const permit = await reserve(activate("c1"));
    // Nothing reads it before reservedUntil.
    expect((await reconcileCommitments({ ...deps(), now: new Date(NOW.getTime() + 5 * 60_000), orphanTenants: 0 })).checked).toBe(0);
    const later = new Date(NOW.getTime() + 11 * 60_000);
    vi.setSystemTime(later);
    const out = await reconcileCommitments({ ...deps(), now: later });
    expect(out).toMatchObject({ checked: 1, live: 1, stopped: 0 });
    expect(commitment("m_c1s")).toMatchObject({ status: "live", dailyBudgetMinor: INR(1_200), peakDailyBudgetMinor: INR(1_200), reservedUntil: null });
    const outcome = ledger().filter((r) => r.correlationId === permit.correlationId && r.phase !== "requested");
    expect(outcome).toHaveLength(1);
    expect(outcome[0]).toMatchObject({ phase: "reconciled", action: "ads.campaign.activate", actorType: "system" });
    // Reads only.
    expect(meta.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("stops a reservation that Meta shows paused, and corrects the DB campaign when its campaign is paused", async () => {
    seedWorkspace();
    seedCampaign("c1");
    await reserve(activate("c1"));
    rows("adCampaign")[0].status = "active";
    meta.object("m_c1").status = "PAUSED";
    const later = new Date(NOW.getTime() + 11 * 60_000);
    vi.setSystemTime(later);
    const out = await reconcileCommitments({ ...deps(), now: later });
    expect(out).toMatchObject({ stopped: 1, campaignsCorrected: 1 });
    expect(rows("spendCommitment")[0].status).toBe("stopped");
    expect(rows("adCampaign")[0].status).toBe("paused");
    expect(ledger("reconciled").map((r) => r.action)).toEqual(expect.arrayContaining(["ads.campaign.activate", "ads.external_change"]));
  });

  it("an unconfirmed change is read after 5 minutes and gets its third, reconciled row", async () => {
    seedWorkspace();
    seedCampaign("c1");
    const permit = await reserve(activate("c1"));
    await settleAds(permit, "unconfirmed");
    rows("spendCommitment")[0].updatedAt = new Date(NOW.getTime() - 6 * 60_000);
    const out = await reconcileCommitments({ ...deps(), now: NOW });
    expect(out.live).toBe(1);
    expect(ledger().filter((r) => r.correlationId === permit.correlationId).map((r) => r.phase)).toEqual(["requested", "unconfirmed", "reconciled"]);
  });

  it("leaves a commitment counted when Meta cannot be reached", async () => {
    seedWorkspace();
    seedCampaign("c1");
    await reserve(activate("c1"));
    const later = new Date(NOW.getTime() + 11 * 60_000);
    const out = await reconcileCommitments({ ...deps({ access: async () => Promise.reject(new Error("token expired")) }), now: later, orphanTenants: 0 });
    expect(out).toMatchObject({ unreachable: 1, live: 0, stopped: 0 });
    expect(commitment("m_c1s")!.status).toBe("reserved");
  });

  it("turns an orphan active campaign into a real row at Meta's budget", async () => {
    seedWorkspace();
    seedCampaign("c1", { status: "active" });
    const out = await reconcileCommitments({ ...deps(), now: NOW });
    expect(out.orphansAdopted).toBe(1);
    expect(commitment("m_c1s")).toMatchObject({ status: "live", dailyBudgetMinor: INR(1_200), timezone: "Asia/Kolkata", origin: "human" });
    expect(ledger("reconciled")[0]).toMatchObject({ action: "ads.commitment.reconciled", reasonCodes: ["orphan", "meta"] });
    // A second run finds nothing to adopt.
    expect((await reconcileCommitments({ ...deps(), now: NOW })).orphansAdopted).toBe(0);
  });

  it("an orphan ad set that Meta shows paused under a running campaign is stored as stopped, so it stops counting", async () => {
    seedWorkspace();
    seedCampaign("c1", { status: "active" });
    rows("adCampaign")[0].updatedAt = new Date(NOW.getTime() - 86_400_000);
    meta.object("m_c1s").status = "PAUSED";
    const out = await reconcileCommitments({ ...deps(), now: NOW });
    expect(out).toMatchObject({ orphansAdopted: 0, orphansStopped: 1, campaignsCorrected: 0 });
    expect(rows("spendCommitment")).toEqual([expect.objectContaining({ metaObjectId: "m_c1s", status: "stopped" })]);
    expect(ledger("reconciled")[0]).toMatchObject({ action: "ads.commitment.reconciled", reasonCodes: ["orphan", "stopped"] });
    expect((await headroom(T, "ads", { env: ENFORCE })).today.committed).toBe(0n);
    expect(rows("adCampaign")[0].status).toBe("active");
    // Nothing left to do on the next run.
    expect(await reconcileCommitments({ ...deps(), now: NOW })).toMatchObject({ orphansAdopted: 0, orphansStopped: 0 });
  });

  it("never adds a second open row when a reservation covers the orphan while Meta is being read", async () => {
    seedWorkspace();
    seedCampaign("c1", { status: "active" });
    const read = async (_t: string, id: string) => {
      if (rows("spendCommitment").length === 0) {
        h.db.seed("spendCommitment", [{ id: "cm_new", tenantId: T, adAccountAssetId: "acc1", campaignId: "c1", adSetId: "c1s", metaObjectId: "m_c1s", objectLevel: "adset", origin: "human", currency: "INR", timezone: "Asia/Kolkata", dailyBudgetMinor: INR(1_000), status: "reserved", reservedUntil: new Date(NOW.getTime() + 600_000) }]);
      }
      return meta.request("GET", id).body as Record<string, unknown>;
    };
    const out = await reconcileCommitments({ ...deps({ read }), now: NOW });
    expect(out.orphansAdopted).toBe(0);
    expect(rows("spendCommitment").map((r) => [r.id, r.status])).toEqual([["cm_new", "reserved"]]);
  });

  it("an orphan whose campaign is paused on Meta corrects the DB instead", async () => {
    seedWorkspace();
    seedCampaign("c1", { status: "active" });
    meta.object("m_c1").status = "PAUSED";
    const out = await reconcileCommitments({ ...deps(), now: NOW });
    expect(out).toMatchObject({ orphansAdopted: 0, campaignsCorrected: 1 });
    expect(rows("adCampaign")[0].status).toBe("paused");
  });

  it("looks at workspaces with active campaigns in turn, a window per run", async () => {
    // Each campaign has a Meta id: a DB-only campaign gets a synthetic `db:` id that the reader skips without asking for
    // a token, so `access` (the probe for "this workspace was looked at") would never be called for it.
    for (const t of ["ta", "tb", "tc"]) h.db.seed("adCampaign", [{ id: `c_${t}`, tenantId: t, adAccountAssetId: "x", metaCampaignId: `m_${t}`, name: "c", status: "active", dailyBudgetMinor: 100, currency: "INR" }]);
    const seen: string[] = [];
    const access = async (tenantId: string): Promise<{ token: string }> => {
      seen.push(tenantId);
      throw new Error("no token");
    };
    for (let i = 0; i < 3; i++) await reconcileCommitments({ ...deps({ access }), now: NOW, orphanTenants: 2 });
    expect(new Set(seen)).toEqual(new Set(["ta", "tb", "tc"]));
  });

  it("reads Meta's object as minor units and maps statuses", () => {
    const r = parseObjectRead({ status: "ACTIVE", effective_status: "CAMPAIGN_PAUSED", daily_budget: "150000", end_time: "2026-11-01T00:00:00+0000" });
    expect(r).toMatchObject({ dailyBudgetMinor: 150_000n, lifetimeBudgetMinor: null });
    expect(observe(r)).toMatchObject({ state: "stopped", parentPaused: true });
    expect(observe(parseObjectRead({ status: "ACTIVE", effective_status: "ACTIVE" })).state).toBe("live");
    expect(observe(parseObjectRead({ status: "ARCHIVED" })).state).toBe("stopped");
  });
});

// =====================================================================================================================
describe("ledger and counter tasks", () => {
  it("verify rebuilds reserved totals as a delta in one statement", async () => {
    h.db.onRaw((call) => (call.sql.includes("spend.counters.verify") ? [{ tenantId: T, pot: "messaging", periodKind: "day", periodKey: "2026-10-28", drift: "-115" }] : undefined));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const out = await verifyCounters();
    warn.mockRestore();
    expect(out).toEqual({ corrected: 1, rows: [{ tenantId: T, pot: "messaging", periodKind: "day", periodKey: "2026-10-28", drift: -115n }] });
    expect(VERIFY_RESERVED_SQL).toContain('GREATEST(0, c."reservedMinor" - d.drift)');
    expect(VERIFY_RESERVED_SQL).toContain('"amountMinor" - "consumedMinor"');
    expect(VERIFY_RESERVED_SQL).toContain(`"spendState" = 'reserved'`);
  });

  it("the crosscheck flags requests with no outcome after an hour, and skips standalone rows", async () => {
    const at = (minAgo: number) => new Date(NOW.getTime() - minAgo * 60_000);
    const row = (id: string, phase: string, correlationId: string, minAgo: number) => ({ id, tenantId: T, pot: "ads", action: "ads.campaign.activate", phase, actorType: "user", reason: "r", correlationId, createdAt: at(minAgo) });
    h.db.seed("spendLedger", [row("a", "requested", "c_open", 90), row("b", "requested", "c_done", 90), row("c", "applied", "c_done", 89), row("d", "requested", "c_young", 30), row("e", "refused", "c_alone", 300)]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const orphans = await crosscheckOrphans({ now: NOW });
    warn.mockRestore();
    expect(orphans.map((o) => o.correlationId)).toEqual(["c_open"]);
    expect(rows("platformSetting").find((r) => r.key === ORPHANS_KEY)!.value).toMatchObject({ count: 1 });
  });

  it("the month rebuild alerts on drift over 1% and writes nothing to the counters", async () => {
    h.db.seed("spendCounter", [
      { tenantId: T, pot: "messaging", periodKind: "month", periodKey: "2026-10", currency: "INR", spentMinor: 10_000n },
      { tenantId: T, pot: "ai", periodKind: "month", periodKey: "2026-10", currency: "CRD", spentMinor: 100n },
    ]);
    h.db.seed("message", [
      { id: "m1", tenantId: T, spendState: "settled", spendDay: new Date("2026-10-05T00:00:00Z"), estCostMinor: 9_000n },
      { id: "m2", tenantId: T, spendState: "settled", spendDay: new Date("2026-09-30T00:00:00Z"), estCostMinor: 5_000n },
    ]);
    h.db.seed("spendReservation", [{ id: "r1", tenantId: T, pot: "ai", currency: "CRD", subjectType: "ai_call", subjectId: "x", amountMinor: 5n, consumedMinor: 100n, status: "settled", dayKey: "2026-10-05", monthKey: "2026-10", expiresAt: NOW, correlationId: "c" }]);
    // Settlement deltas: one for October counts; one written in August is never read.
    h.db.seed("spendLedger", [
      { id: "st1", tenantId: T, pot: "messaging", action: "messaging.settlement", phase: "reconciled", actorType: "system", reason: "r", correlationId: "s1", amountMinor: -500n, snapshot: { month: "2026-10" }, createdAt: new Date("2026-10-20T00:00:00Z") },
      { id: "st2", tenantId: T, pot: "messaging", action: "messaging.settlement", phase: "reconciled", actorType: "system", reason: "r", correlationId: "s2", amountMinor: 99_999n, snapshot: { month: "2026-10" }, createdAt: new Date("2026-08-01T00:00:00Z") },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const drift = await crosscheckMonth("2026-10", { now: NOW });
    warn.mockRestore();
    expect(drift).toEqual([{ tenantId: T, pot: "messaging", month: "2026-10", counter: 10_000n, rebuilt: 8_500n, driftPct: 17.64 }]);
    expect(rows("spendCounter").map((r) => r.spentMinor)).toEqual([10_000n, 100n]);
    expect(driftPercent(100n, 101n)).toBe(0.99);
    expect(driftPercent(5n, 0n)).toBe(100);
  });

  it("the spend worker module merges every area and refuses a name used twice", () => {
    // Every area's tasks, each once (other areas add theirs: the quality poll and settlement, the kill sweep).
    const names = spendWorker.periodic.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["spend.commitments.reconcile", "spend.counters.verify", "spend.ledger.crosscheck", "spend.reservations.expire", "spend.messaging.settle", "spend.quality.poll"]));
    expect(new Set(names).size).toBe(names.length);
    expect(spendWorker.periodic.find((t) => t.name === "spend.commitments.reconcile")!.everyMs).toBe(120_000);
    const task = { name: "x", everyMs: 1, run: async () => undefined };
    expect(() => mergeSpendAreas({ a: { queues: {}, periodic: [task] }, b: { queues: {}, periodic: [task] } })).toThrow(/registered by both a and b/);
    expect(() => mergeSpendAreas({ a: { queues: { q: async () => undefined }, periodic: [] }, b: { queues: { q: async () => undefined }, periodic: [] } })).toThrow(/queue q/);
  });
});
