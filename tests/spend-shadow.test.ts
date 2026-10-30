import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSpendDb, Row } from "./helpers/fake-spend-db";

/**
 * Mandates, autonomy levels and shadow mode (docs/SPEND-CONTROLS-SPEC.md 2.2, 2.3.9, 2.3.10, 7.2, 7.5, 10.5; 12.1a decision 5)
 * on the in-memory spend database, through the real book, mandates, shadow, approvals and optimizer modules. The ads actions
 * are recorded stand-ins; Meta is never called.
 */

const h = vi.hoisted(() => ({ db: null as unknown as FakeSpendDb, calls: [] as { fn: string; args: unknown[] }[] }));

vi.mock("@/lib/db", async () => {
  const { createFakeSpendDb } = await import("./helpers/fake-spend-db");
  h.db = createFakeSpendDb();
  return { prisma: h.db.prisma };
});
vi.mock("@/lib/queue", () => ({ enqueue: vi.fn(async () => ({ id: "job" })) }));
vi.mock("@/lib/approvals", () => ({ createApproval: vi.fn(), getOptimizerClientDecisions: vi.fn(async () => new Map()) }));
vi.mock("@/lib/ads/actions", () => ({
  pauseAd: vi.fn(async (...args: unknown[]) => {
    h.calls.push({ fn: "pauseAd", args });
    return { revertPayload: { action: "resume_ad", metaAdId: args[1], previousStatus: "active" } };
  }),
  setAdSetBudget: vi.fn(async (...args: unknown[]) => {
    h.calls.push({ fn: "setAdSetBudget", args });
    return { revertPayload: {}, appliedDailyBudgetMinor: args[2], clamped: false };
  }),
  pauseAdSet: vi.fn(async () => ({ revertPayload: {} })),
  resumeAd: vi.fn(async () => ({ revertPayload: {} })),
}));

import { routeProposal } from "@/lib/optimizer/engine";
import { approveProposal } from "@/lib/optimizer/service";
import { listApprovals } from "@/lib/spend/approvals";
import { reserveAds, resetBookForTests } from "@/lib/spend/book";
import { ShadowOnlyError, NeedsApprovalError } from "@/lib/spend/errors";
import { resetSpendStateCache } from "@/lib/spend/kill";
import {
  assistantContext,
  assistantDTOs,
  classifyMandateChange,
  defaultMandate,
  effectiveLevel,
  effectiveMandateCeilings,
  getMandate,
  lowerMandate,
  MANDATE_OWNER_ONLY,
  SHADOW_DAYS,
  toMandateDTO,
  updateMandate,
} from "@/lib/spend/mandates";
import { END_LEARNING_ASSISTANTS_OFF, END_LEARNING_NOT_ELIGIBLE, endShadowEarly, evaluateShadow, recordShadow, shadowSummary, shadowVerdict } from "@/lib/spend/shadow";
import { periodic } from "@/lib/spend/tasks/approvals";
import type { AdsRaiseIntent, SpendActor } from "@/lib/spend/types";

// Wednesday 28 Oct 2026, 12:00 in Asia/Kolkata.
const NOW = new Date("2026-10-28T06:30:00Z");
const DAY = 86_400_000;
const HOUR = 3_600_000;
const T = "t1";
const INR = (rupees: number) => BigInt(rupees * 100);
const ON = { ASSISTANT_SPEND_ENABLED: "true", SPEND_ENFORCE: "enforce", SPEND_CAP_MODE: "enforce" } as Record<string, string>;
const OFF = { ASSISTANT_SPEND_ENABLED: "false", SPEND_ENFORCE: "enforce", SPEND_CAP_MODE: "enforce" } as Record<string, string>;
const owner: SpendActor = { type: "user", userId: "u_owner", role: "owner" };
const admin: SpendActor = { type: "user", userId: "u_admin", role: "admin" };
const support: SpendActor = { type: "platform_admin", userId: "pa1" };
const assistant: SpendActor = { type: "assistant", assistantKey: "ads_optimizer" };

const rows = (name: string) => h.db.rows(name);
const ledger = (phase?: string) => rows("spendLedger").filter((r) => !phase || r.phase === phase);

function seed(opts: { managed?: boolean; verified?: boolean; sandbox?: boolean } = {}) {
  h.db.seed("tenant", [{ id: T, name: "Shop", slug: "shop", status: "active", billingExempt: false }]);
  h.db.seed("user", [{ id: "u_owner", name: "Priya Shah" }, { id: "u_admin", name: "Arjun Rao" }]);
  h.db.seed("membership", [{ id: "m1", tenantId: T, userId: "u_owner", role: "owner" }, { id: "m2", tenantId: T, userId: "u_admin", role: "admin" }]);
  h.db.seed("metaAsset", [{ id: "acc1", tenantId: T, connectionId: "mc1", type: "ad_account", externalId: "act_111", name: "Shop ads", status: "active", meta: { currency: "INR", timezone: "Asia/Kolkata" }, sandbox: opts.sandbox === true, createdAt: new Date("2026-01-01") }]);
  h.db.seed("spendControl", [{ tenantId: T, probation: "lifted", spendingAdAccountAssetId: "acc1", timezone: "Asia/Kolkata", approverUserIds: [], targetCostPerLeadMinor: INR(100), verifiedAt: opts.verified ? new Date("2026-10-01") : null }]);
  h.db.seed("spendAllowance", [{ id: "sa1", tenantId: T, pot: "ads", currency: "INR", dailyLimitMinor: INR(10_000), monthlyLimitMinor: INR(100_000) }]);
  h.db.seed("adCampaign", [{ id: "c1", tenantId: T, adAccountAssetId: "acc1", metaCampaignId: "m_c1", name: "Diwali leads", template: "lead_generation", objective: "OUTCOME_LEADS", status: "active", dailyBudgetMinor: 100_000, currency: "INR", endsAt: new Date("2026-11-15T00:00:00Z"), origin: "human", assistantKey: null, lifetimeBudgetMinor: null, sandbox: false }]);
  h.db.seed("adSet", [{ id: "c1s", tenantId: T, campaignId: "c1", metaAdSetId: "m_c1s", name: "Delhi", status: "active", targeting: {}, dailyBudgetMinor: 100_000, lifetimeBudgetMinor: null }]);
  h.db.seed("ad", [{ id: "c1a", tenantId: T, adSetId: "c1s", metaAdId: "m_c1a", name: "Ad", status: "active", creative: {} }]);
  h.db.seed("spendCommitment", [
    { id: "cm_c1", tenantId: T, adAccountAssetId: "acc1", campaignId: "c1", adSetId: "c1s", metaObjectId: "m_c1s", objectLevel: "adset", origin: "human", currency: "INR", timezone: "Asia/Kolkata", dailyBudgetMinor: INR(1_000), dayKey: new Date(Date.UTC(2026, 9, 28)), dayStartBudgetMinor: INR(1_000), peakDailyBudgetMinor: INR(1_000), weekStart: new Date(Date.UTC(2026, 9, 25)), weekPeakDailyBudgetMinor: INR(1_000), status: "live", endsAt: new Date("2026-11-15T00:00:00Z") },
  ]);
  if (opts.managed) {
    h.db.seed("metaSpendLimit", [{ adAccountAssetId: "acc1", tenantId: T, accountExternalId: "act_111", mode: "managed", unitMode: "major_write", semantics: "cumulative", managedCapMinor: INR(200_000), lastReadCapMinor: INR(200_000), lastReadAmountSpentMinor: INR(10_000), lastReadAt: new Date(NOW.getTime() - 10 * 60_000), lastWriteAt: new Date(NOW.getTime() - HOUR), lastError: null }]);
  }
}

function mandate(level: 0 | 1 | 2, over: Row = {}) {
  h.db.seed("assistantMandate", [{ id: "am1", tenantId: T, assistantKey: "ads_optimizer", enabled: true, level, allowedOps: ["pause", "raise_budget", "resume_ad", "resume_adset", "activate"], raiseStepPct: 20, approvalSharePct: 25, shadowUntil: null, shadowStartedAt: new Date(NOW.getTime() - 20 * DAY), version: 1, ...over }]);
}

const raise = (rupees: number): AdsRaiseIntent => ({ kind: "raise_budget", adSetId: "c1s", metaAdSetId: "m_c1s", toMinor: BigInt(Math.round(rupees * 100)) });
let n = 0;
const reserve = (intent: AdsRaiseIntent, env: Record<string, string>) => reserveAds(T, intent, assistant, { idempotencyKey: `k${++n}`, reason: "Cost per lead is low", env });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  h.db.reset();
  h.calls = [];
  resetSpendStateCache();
  resetBookForTests();
});
afterEach(() => vi.useRealTimers());

// =====================================================================================================================

describe("shadow mode never mints a permit (7.5, 10.5)", () => {
  it.each([0, 1, 2] as const)("level %s while shadowUntil is in the future: shadow, recorded, no permit, nothing reserved", async (level) => {
    seed({ managed: true });
    mandate(level, { shadowUntil: new Date(NOW.getTime() + 3 * DAY) });
    await expect(reserve(raise(1_050), ON)).rejects.toBeInstanceOf(ShadowOnlyError);
    expect(ledger("requested")).toHaveLength(0);
    expect(rows("spendCommitment").every((c) => c.status === "live")).toBe(true);
    expect(rows("assistantShadowRecord")).toHaveLength(1);
    expect(ledger("shadow")).toHaveLength(1);
    expect(rows("spendApproval")).toHaveLength(0);
  });

  it("after the learning period the same raise runs at the configured level", async () => {
    seed({ managed: true });
    mandate(1, { shadowUntil: new Date(NOW.getTime() - 1) });
    const permit = await reserve(raise(1_100), ON);
    expect(permit.kind).toBe("raise_budget");
  });
});

describe("mandates (7.2, 8.1)", () => {
  it("a missing row means off and Level 0: suggestions only", async () => {
    seed();
    const m = await getMandate(T, "ads_optimizer");
    expect(m).toMatchObject({ exists: false, enabled: false, level: 0, allowedOps: [] });
    expect(effectiveLevel(m, { env: ON })).toBe(0);
    await expect(getMandate(T, "eddy")).rejects.toMatchObject({ status: 404 });
  });

  it("the first enable starts 14 days of learning; re-enabling does not restart them; every change is ledgered", async () => {
    seed();
    const first = await updateMandate(T, "ads_optimizer", { enabled: true, level: 1 }, owner);
    expect(first.mandate.shadowStartedAt?.getTime()).toBe(NOW.getTime());
    expect(first.mandate.shadowUntil?.getTime()).toBe(NOW.getTime() + SHADOW_DAYS * DAY);
    expect(first.mandate.allowedOps).toEqual(["pause", "archive", "cut_budget", "end_earlier", "raise_budget", "resume_ad", "resume_adset"]);
    // An admin may lower (switch it off), not raise (switch it on again).
    await updateMandate(T, "ads_optimizer", { enabled: false }, admin);
    await expect(updateMandate(T, "ads_optimizer", { enabled: true }, admin)).rejects.toMatchObject({ status: 403, message: MANDATE_OWNER_ONLY });
    vi.setSystemTime(new Date(NOW.getTime() + 3 * DAY));
    const again = await updateMandate(T, "ads_optimizer", { enabled: true }, owner);
    expect(again.mandate.shadowUntil?.getTime()).toBe(NOW.getTime() + SHADOW_DAYS * DAY);
    const changes = ledger().filter((r) => r.action === "mandate.change");
    expect(changes.filter((r) => r.phase === "requested")).toHaveLength(3);
    expect(changes.filter((r) => r.phase === "applied")).toHaveLength(3);
    expect(changes[0]).toMatchObject({ actorType: "user", targetType: "assistant", targetId: "ads_optimizer", reason: "Ad assistant: switched it on, set its level to Guarded." });
    expect(changes.find((r) => r.phase === "requested")?.undo).toMatchObject({ action: "set_mandate", assistantKey: "ads_optimizer", enabled: false });
  });

  it("the owner raises levels and ceilings; an admin and a platform admin only lower; a stale version is a 409", async () => {
    seed();
    await updateMandate(T, "ads_optimizer", { enabled: true, level: 2, maxDailyMinor: INR(2_000) }, owner);
    await expect(updateMandate(T, "ads_optimizer", { maxDailyMinor: INR(3_000) }, admin)).rejects.toMatchObject({ status: 403 });
    await expect(updateMandate(T, "ads_optimizer", { maxDailyMinor: null }, admin)).rejects.toMatchObject({ status: 403 });
    await expect(updateMandate(T, "ads_optimizer", { targetCostPerLeadMinor: INR(90) }, admin)).rejects.toMatchObject({ status: 403 });
    const low = await updateMandate(T, "ads_optimizer", { level: 1, maxDailyMinor: INR(1_500), raiseStepPct: 10 }, admin);
    expect(low.mandate).toMatchObject({ level: 1, maxDailyMinor: INR(1_500), raiseStepPct: 10, currency: "INR" });
    await expect(lowerMandate(T, "ads_optimizer", { level: 2 }, support, "Checking a bug")).rejects.toMatchObject({ status: 403 });
    const pa = await lowerMandate(T, "ads_optimizer", { level: 0 }, support, "Checking a bug");
    expect(pa.mandate.level).toBe(0);
    expect(ledger("requested").filter((r) => r.action === "mandate.change").pop()).toMatchObject({ actorType: "platform_admin", reason: "Checking a bug" });
    await expect(updateMandate(T, "ads_optimizer", { level: 0 }, owner, { expectedVersion: 1 })).rejects.toMatchObject({ status: 409 });
    await expect(updateMandate(T, "ads_optimizer", { raiseStepPct: 30 }, owner)).rejects.toMatchObject({ status: 400 });
  });

  it("classifies each field: null ceilings mean more room, ops added are a raise", () => {
    const m = { ...defaultMandate(T, "ads_optimizer"), exists: true, enabled: true, level: 1 as const, allowedOps: ["pause"], maxDailyMinor: INR(1_000) };
    expect(classifyMandateChange(m, { maxDailyMinor: null })).toMatchObject({ raises: true });
    expect(classifyMandateChange(m, { maxDailyMinor: INR(900), allowedOps: [] })).toMatchObject({ raises: false, lowers: true });
    expect(classifyMandateChange(m, { allowedOps: ["pause", "raise_budget"] })).toMatchObject({ raises: true });
    expect(classifyMandateChange(m, { sandboxOnly: true })).toMatchObject({ lowers: true, raises: false });
    expect(classifyMandateChange(m, { level: 1 })).toMatchObject({ changed: false });
  });

  it("the effective ceilings are min(mandate, allowance), and the level stays 0 while ASSISTANT_SPEND_ENABLED is false", () => {
    expect(effectiveMandateCeilings({ maxDailyMinor: INR(3_000), maxMonthlyMinor: null }, { daily: INR(2_000), monthly: INR(20_000) })).toEqual({ daily: INR(2_000), monthly: INR(20_000) });
    expect(effectiveMandateCeilings({ maxDailyMinor: INR(1_000), maxMonthlyMinor: INR(5_000) }, { daily: INR(2_000), monthly: null })).toEqual({ daily: INR(1_000), monthly: INR(5_000) });
    const m = { ...defaultMandate(T, "ads_optimizer"), exists: true, enabled: true, level: 2 as const };
    expect(effectiveLevel(m, { env: OFF })).toBe(0);
    expect(effectiveLevel(m, { env: ON })).toBe(2);
    expect(effectiveLevel({ ...m, shadowUntil: new Date(Date.now() + DAY) }, { env: ON })).toBe(0);
    expect(toMandateDTO(m, { env: OFF })).toMatchObject({ level: 2, effectiveLevel: 0 });
  });

  it("the Assistants card lists every assistant with its learning line and the viewer's rights", async () => {
    seed();
    await updateMandate(T, "ads_optimizer", { enabled: true }, owner);
    const list = await assistantDTOs(T, "admin");
    expect(list.map((a) => a.assistantKey)).toEqual(["ads_optimizer", "ads_launcher", "broadcast_planner", "lead_followup"]);
    expect(list[0]).toMatchObject({ label: "Ad assistant", canRaise: false, canLower: true, shadow: { learning: true, text: "Learning: suggests only until 11 Nov. It hasn't suggested any changes yet." } });
    expect(list[1].mandate).toBeNull();
  });
});

describe("autonomy levels (7.2 matrix, 2.3.9)", () => {
  const ctx = async (env = ON) => assistantContext(T, "ads_optimizer", { env, now: NOW });
  const raiseIntent = (toRupees: number, dayStart = 1_000) => ({ op: "raise_budget", kind: "raise" as const, toMinor: INR(toRupees), dayStartBudgetMinor: INR(dayStart) });

  it("Level 1: +20% of the budget at the start of the account day is automatic, +20.01% needs approval, and it is cumulative", async () => {
    seed({ managed: true });
    mandate(1);
    const c = await ctx();
    const small = { todayMinor: INR(100), monthMinor: INR(400) };
    expect(c.decide(raiseIntent(1_200), small).verdict).toBe("auto");
    expect(c.decide({ ...raiseIntent(1_200), toMinor: 120_001n }, small).verdict).toBe("needs_approval");
    // Raised 10% earlier today (day start stays ₹1,000): another 11% of the new budget is 21.1% of the day start.
    expect(c.decide({ ...raiseIntent(1_221), dayStartBudgetMinor: c.dayStartBudget("m_c1s") }, small).verdict).toBe("needs_approval");
    // The same through the book: +20% gets a permit, +25% becomes a request for an approver.
    const permit = await reserve(raise(1_200), ON);
    expect(permit.kind).toBe("raise_budget");
    await expect(reserve(raise(1_250), ON)).rejects.toBeInstanceOf(NeedsApprovalError);
  });

  it("Level 2: more than 25% of the monthly limit needs approval, for one action or the rolling 24 h sum", async () => {
    seed({ managed: true });
    mandate(2);
    const c = await ctx();
    expect(c.decide(raiseIntent(1_100), { todayMinor: INR(175), monthMinor: INR(25_000) }).verdict).toBe("auto");
    expect(c.decide(raiseIntent(1_100), { todayMinor: INR(175), monthMinor: INR(25_001) }).verdict).toBe("needs_approval");
    // Earlier automatic raises in the last 24 hours add up: 20% already, so 10% more is 30%.
    h.db.seed("spendLedger", [{ id: "l1", tenantId: T, pot: "ads", action: "ads.adset.budget_raise", phase: "requested", actorType: "assistant", assistantKey: "ads_optimizer", approvalId: null, forecastMonthMinor: INR(20_000), reason: "auto", correlationId: "c1", createdAt: new Date(NOW.getTime() - 2 * HOUR) }]);
    const c2 = await ctx();
    expect(c2.headroom.autoRaisesLast24hMinor).toBe(INR(20_000));
    expect(c2.decide(raiseIntent(1_100), { todayMinor: INR(175), monthMinor: INR(10_000) }).verdict).toBe("needs_approval");
    expect(c2.decide(raiseIntent(1_100), { todayMinor: INR(175), monthMinor: INR(5_000) }).verdict).toBe("auto");
  });

  it("lowering at Level 1 or 2 applies automatically; at Level 0 it is a suggestion", async () => {
    seed({ managed: true });
    mandate(1);
    expect((await ctx()).decide({ op: "pause", kind: "lowering" }, { todayMinor: 0n, monthMinor: 0n }).verdict).toBe("auto");
    h.db.reset();
    seed({ managed: true });
    mandate(2);
    expect((await ctx()).decide({ op: "pause", kind: "lowering" }, { todayMinor: 0n, monthMinor: 0n }).verdict).toBe("auto");
    h.db.reset();
    seed({ managed: true });
    mandate(0);
    expect((await ctx()).decide({ op: "pause", kind: "lowering" }, { todayMinor: 0n, monthMinor: 0n })).toMatchObject({ verdict: "needs_approval", reason: "level_0" });
  });

  it("all of it is inert while ASSISTANT_SPEND_ENABLED=false: every action is a suggestion", async () => {
    seed({ managed: true });
    mandate(2);
    const c = await ctx(OFF);
    expect(c.decide(raiseIntent(1_050), { todayMinor: INR(50), monthMinor: INR(100) })).toMatchObject({ verdict: "needs_approval", level: 0 });
    expect(c.decide({ op: "pause", kind: "lowering" }, { todayMinor: 0n, monthMinor: 0n })).toMatchObject({ verdict: "needs_approval", level: 0 });
    await expect(reserve(raise(1_050), OFF)).rejects.toBeInstanceOf(NeedsApprovalError);
  });

  it("the optimizer's daily run applies an automatic pause as the assistant, and turns the rest into requests", async () => {
    seed({ managed: true });
    mandate(1);
    h.db.seed("optimizerProposal", [{ id: "p1", tenantId: T, kind: "pause_ad", targetType: "ad", targetMetaId: "m_c1a", rationale: "Spent ₹1,200 in 7 days with no results.", payload: { adName: "Carousel B" }, status: "proposed", createdAt: NOW, appliedAt: null, revertPayload: null, decidedByUserId: null }]);
    const c = await assistantContext(T, "ads_optimizer", { env: ON, now: NOW });
    const out = await routeProposal(T, { id: "p1", kind: "pause_ad", targetMetaId: "m_c1a", rationale: "Spent ₹1,200 in 7 days with no results.", payload: { adName: "Carousel B" } }, c, "INR");
    expect(out).toEqual({ id: "p1", verdict: "auto", applied: true });
    expect(h.calls[0].args.slice(0, 3)).toEqual([T, "m_c1a", { type: "assistant", assistantKey: "ads_optimizer" }]);
    expect(rows("optimizerProposal")[0].status).toBe("applied");
    expect(rows("spendApproval")).toHaveLength(0);
  });
});

describe("a suggestion during the learning period (2.3.10, 7.5)", () => {
  it("is recorded with the would-have verdict, still reaches approvers, and runs as the person who approves it (actor user with assistantKey)", async () => {
    seed({ managed: true });
    mandate(1, { shadowUntil: new Date(NOW.getTime() + 5 * DAY) });
    const row = { id: "p1", kind: "pause_ad", targetMetaId: "m_c1a", rationale: "Spent ₹1,200 in 7 days with no results.", payload: { adName: "Carousel B", cprMinor: 40_000 } };
    h.db.seed("optimizerProposal", [{ ...row, tenantId: T, targetType: "ad", status: "proposed", createdAt: NOW, appliedAt: null, revertPayload: null, decidedByUserId: null }]);
    const c = await assistantContext(T, "ads_optimizer", { env: ON, now: NOW });
    expect(await routeProposal(T, row, c, "INR")).toEqual({ id: "p1", verdict: "shadow" });
    expect(h.calls).toHaveLength(0);
    const [record] = rows("assistantShadowRecord");
    expect(record).toMatchObject({ assistantKey: "ads_optimizer", actionKind: "pause_ad", wouldDecision: "auto" });
    expect(ledger("shadow")[0]).toMatchObject({ actorType: "assistant", reasonCodes: expect.arrayContaining(["learning", "would_auto"]) });
    const [request] = await listApprovals(T, { userId: "u_owner", role: "owner" });
    expect(request).toMatchObject({ summary: "Pause the ad 'Carousel B'", direction: "lower", status: "pending" });

    await approveProposal({ userId: "u_owner", tenantId: T, role: "owner" }, "p1", true);
    expect(h.calls[0].args.slice(0, 3)).toEqual([T, "m_c1a", { type: "user", userId: "u_owner", role: "owner", assistantKey: "ads_optimizer", approvalId: request.id }]);
    const after = rows("assistantShadowRecord")[0];
    expect(after.wouldDecision).toBe("auto");
    expect((after.outcome as Row).human).toMatchObject({ decision: "approved", byUserId: "u_owner" });
  });

  it("the learning line counts what it would have done", async () => {
    seed();
    const until = new Date("2026-11-11T06:30:00Z");
    for (const [kind, would, forecast] of [["pause_ad", "auto", null], ["pause_ad", "needs_approval", null], ["raise_budget", "auto", INR(4_200)]] as const) {
      await recordShadow({ tenantId: T, assistantKey: "ads_optimizer", actionKind: kind, intent: {}, would, forecastMonthMinor: forecast, currency: "INR", reason: "x" });
    }
    await recordShadow({ tenantId: T, assistantKey: "ads_optimizer", actionKind: "raise_budget", intent: {}, would: "refuse", wouldReason: "over_monthly_limit", reason: "x" });
    const s = await shadowSummary(T, { assistantKey: "ads_optimizer", shadowUntil: until, shadowStartedAt: new Date(NOW.getTime() - DAY), currency: "INR" });
    expect(s).toMatchObject({ learning: true, wouldHaveMade: 3, cuts: 2, raises: 1, wouldExceedAllowance: 1, agreedPct: null });
    expect(s.text).toBe("Learning: suggests only until 11 Nov. So far it would have made 3 changes (2 cuts, 1 raise worth up to ₹4,200).");
    expect(s.raisesWorthUpTo?.formatted).toBe("₹4,200");
    expect((await shadowSummary(T, { assistantKey: "ads_optimizer", shadowUntil: new Date(NOW.getTime() - 1), shadowStartedAt: null, currency: "INR" })).text).toBeNull();
  });
});

describe("evaluation (spend.shadow.evaluate)", () => {
  it("runs hourly and fills the 24 h and 72 h outcomes once", async () => {
    expect(periodic.find((p) => p.name === "spend.shadow.evaluate")?.everyMs).toBe(HOUR);
    seed();
    const day = (d: string, spend: number, results: number, scopeId = "m_c1s") =>
      h.db.seed("spendDaily", [{ tenantId: T, pot: "ads", scopeType: "adset", scopeId, day: new Date(`${d}T00:00:00Z`), currency: "INR", amountMinor: INR(spend), origin: "platform", results, source: "insights", syncedAt: NOW }]);
    // Created 80 h ago (25 Oct, 04:30 IST): the target kept spending ₹300 a lead against a ₹100 target, so a pause would have helped.
    h.db.seed("assistantShadowRecord", [
      { id: "s_old", tenantId: T, assistantKey: "ads_optimizer", actionKind: "pause_ad", intent: { metaObjectIds: ["m_c1s"] }, wouldDecision: "auto", reason: "x", createdAt: new Date(NOW.getTime() - 80 * HOUR) },
      { id: "s_mid", tenantId: T, assistantKey: "ads_optimizer", actionKind: "raise_budget", intent: { metaObjectIds: ["m_good"] }, wouldDecision: "needs_approval", reason: "x", createdAt: new Date(NOW.getTime() - 30 * HOUR) },
      { id: "s_new", tenantId: T, assistantKey: "ads_optimizer", actionKind: "pause_ad", intent: { metaObjectIds: ["m_c1s"] }, wouldDecision: "auto", reason: "x", createdAt: new Date(NOW.getTime() - 2 * HOUR) },
    ]);
    day("2026-10-25", 900, 3);
    day("2026-10-26", 900, 3);
    day("2026-10-27", 900, 3);
    day("2026-10-27", 500, 10, "m_good");
    expect((await evaluateShadow({ now: NOW })).evaluated).toBe(2);
    const get = (id: string) => rows("assistantShadowRecord").find((r) => r.id === id)!;
    expect(get("s_old").outcome).toMatchObject({ h24: { verdict: "would_have_helped", cplMinor: "30000", results: 6 }, h72: { verdict: "would_have_helped", results: 9 }, verdict: "would_have_helped" });
    expect(get("s_old").evaluatedAt).toEqual(NOW);
    // A raise on an ad set cheaper than the workspace average would have helped; only its 24 h window has passed.
    expect(get("s_mid").outcome).toMatchObject({ h24: { verdict: "would_have_helped" }, verdict: "would_have_helped" });
    expect((get("s_mid").outcome as Row).h72).toBeUndefined();
    expect(get("s_new").outcome ?? null).toBeNull();
    expect((await evaluateShadow({ now: NOW })).evaluated).toBe(0);
  });

  it("judges each window plainly, and says unknown without data", () => {
    const target = (spend: number, results: number) => ({ spend: INR(spend), results });
    expect(shadowVerdict("pause_ad", target(900, 3), { targetCplMinor: INR(100), workspace: target(0, 0) }).verdict).toBe("would_have_helped");
    expect(shadowVerdict("pause_ad", target(300, 3), { targetCplMinor: INR(100), workspace: target(0, 0) }).verdict).toBe("would_have_hurt");
    expect(shadowVerdict("pause_ad", target(300, 0), { targetCplMinor: INR(100), workspace: target(0, 0) }).verdict).toBe("would_have_helped");
    expect(shadowVerdict("pause_ad", target(0, 0), { targetCplMinor: INR(100), workspace: target(0, 0) }).verdict).toBe("unknown");
    expect(shadowVerdict("raise_budget", target(500, 10), { targetCplMinor: null, workspace: target(2_000, 10) }).verdict).toBe("would_have_helped");
    expect(shadowVerdict("raise_budget", target(500, 1), { targetCplMinor: null, workspace: target(2_000, 10) }).verdict).toBe("would_have_hurt");
    expect(shadowVerdict("raise_budget", target(500, 10), { targetCplMinor: null, workspace: target(0, 0) }).verdict).toBe("unknown");
  });
});

describe("ending the learning period early (7.5, 8.3)", () => {
  it("only a platform admin, only for a sandbox ad account or a verified workspace, never while assistants are held at Level 0", async () => {
    seed({ verified: false });
    mandate(1, { shadowUntil: new Date(NOW.getTime() + 5 * DAY) });
    await expect(endShadowEarly(T, "ads_optimizer", owner, "Testing", { env: ON })).rejects.toMatchObject({ status: 403 });
    await expect(endShadowEarly(T, "ads_optimizer", support, "Testing", { env: OFF })).rejects.toMatchObject({ status: 409, message: END_LEARNING_ASSISTANTS_OFF });
    await expect(endShadowEarly(T, "ads_optimizer", support, "Testing", { env: ON })).rejects.toMatchObject({ status: 409, message: END_LEARNING_NOT_ELIGIBLE });
    rows("spendControl")[0].verifiedAt = new Date("2026-10-01");
    const out = await endShadowEarly(T, "ads_optimizer", support, "Verified internal workspace", { env: ON });
    expect(out.shadowUntil).toEqual(NOW);
    expect(rows("assistantMandate")[0].shadowUntil).toEqual(NOW);
    expect(ledger("requested").find((r) => r.action === "mandate.change")).toMatchObject({ actorType: "platform_admin", reasonCodes: ["end_learning", "verified"] });
    await expect(endShadowEarly(T, "ads_optimizer", support, "Again", { env: ON })).rejects.toMatchObject({ status: 409 });
  });

  it("works for a sandbox ad account", async () => {
    seed({ sandbox: true });
    mandate(2, { shadowUntil: new Date(NOW.getTime() + 5 * DAY) });
    await endShadowEarly(T, "ads_optimizer", support, "Sandbox run", { env: ON });
    expect(ledger("requested").find((r) => r.action === "mandate.change")).toMatchObject({ reasonCodes: ["end_learning", "sandbox"], sandbox: true });
  });
});
