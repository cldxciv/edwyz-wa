import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSpendDb, Row } from "./helpers/fake-spend-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeSpendDb }));

vi.mock("@/lib/db", async () => {
  const { createFakeSpendDb } = await import("./helpers/fake-spend-db");
  h.db = createFakeSpendDb();
  return { prisma: h.db.prisma };
});

import {
  assertMayChangeAllowance,
  classifyAllowanceChange,
  combineLimits,
  effectiveLimits,
  limitRules,
  previewAllowanceChange,
  setAllowances,
} from "@/lib/spend/allowances";
import { clearCeiling, legacyPlatformDailyCeiling, listCeilings, resolveSpendPlan, setCeiling } from "@/lib/spend/ceilings";
import { SpendBlockedError } from "@/lib/spend/errors";
import { convertFromInr, FX_KEY, isRateFresh, parseFxTable, parseRate, readFx, setFxRates } from "@/lib/spend/fx";
import { computeProbation, probationState, setProbation, setWorkspaceVerified } from "@/lib/spend/probation";
import { resetFlagWarningsForTests } from "@/lib/spend/flags";
import { DEFAULT_MONTHLY_CREDITS } from "@/lib/ai-agent/credits";
import type { SpendActor } from "@/lib/spend/types";

const T = "t1";
const NOW = new Date("2026-10-28T08:00:00Z");
const DAY = 86_400_000;
const owner: SpendActor = { type: "user", userId: "u_owner", role: "owner" };
const admin: SpendActor = { type: "user", userId: "u_admin", role: "admin" };
const member: SpendActor = { type: "user", userId: "u_agent", role: "agent" };
const support: SpendActor = { type: "platform_admin", userId: "u_support" };

let seq = 0;
const ceiling = (scope: string, scopeId: string, pot: string, currency: string, dailyMinor: bigint | null, monthlyMinor: bigint | null, extra: Row = {}) =>
  h.db.seed("spendCeiling", [{ id: `sc_${++seq}`, scope, scopeId, pot, currency, dailyMinor, monthlyMinor, reason: "test", createdAt: NOW, updatedAt: NOW, ...extra }]);

/** The three rows 0009 seeds (12.1a decision 3). */
function seedNewWorkspaceCeilings() {
  ceiling("probation", "*", "ads", "INR", 200_000n, 2_000_000n);
  ceiling("probation", "*", "messaging", "INR", 50_000n, 500_000n);
  ceiling("probation", "*", "ai", "CRD", null, 500n);
}

function seedTenant(extra: Row = {}) {
  h.db.seed("tenant", [{ id: T, name: "Shop", slug: "shop", status: "active", billingExempt: false, trialEndsAt: null, ...extra }]);
}

function seedAllowance(pot: string, currency: string, daily: bigint | null, monthly: bigint | null, version = 1) {
  h.db.seed("spendAllowance", [{ id: `sa_${pot}`, tenantId: T, pot, currency, dailyLimitMinor: daily, monthlyLimitMinor: monthly, version, createdAt: NOW, updatedAt: NOW }]);
}

function seedControl(extra: Row = {}) {
  h.db.seed("spendControl", [{ tenantId: T, updatedAt: NOW, ...extra }]);
}

function paidInvoice(n: number, extra: Row = {}) {
  h.db.seed("invoice", [{ id: `inv_${n}`, tenantId: T, number: `EDW-${n}`, status: "paid", paidAt: NOW, totalPaise: 118_000, ...extra }]);
}

const fx = (rates: Record<string, string>, updatedAt: Date) => h.db.seed("platformSetting", [{ key: FX_KEY, value: { base: "INR", rates, updatedAt: updatedAt.toISOString() }, updatedAt }]);
const ledger = () => h.db.rows("spendLedger");

beforeEach(() => {
  h.db.reset();
  seq = 0;
  delete process.env.AI_DEFAULT_MONTHLY_CREDITS;
  resetFlagWarningsForTests();
  seedTenant();
  seedNewWorkspaceCeilings();
});

// =====================================================================================================================
describe("effectiveLimits: min over sources", () => {
  it("takes the smallest of owner, platform, plan and new-workspace limits, period by period", async () => {
    h.db.seed("subscription", [{ id: "sub1", tenantId: T, planId: "plan_pro", status: "active" }]);
    h.db.seed("plan", [{ id: "plan_pro", code: "pro", name: "Pro", aiCreditsMonthly: 1000 }]);
    ceiling("platform", "*", "ads", "INR", 1_000_000n, 4_000_000n);
    ceiling("plan", "plan_pro", "ads", "INR", 150_000n, 3_000_000n);
    seedAllowance("ads", "INR", 500_000n, 5_000_000n);
    const on = await effectiveLimits(T, "ads", "INR", undefined, { now: NOW });
    expect(on.probation.on).toBe(true);
    expect(on.daily).toBe(150_000n); // plan, below the new-workspace ₹2,000
    expect(on.monthly).toBe(2_000_000n); // new-workspace ₹20,000
    expect(on.dailyBinding).toBe("plan");
    expect(on.monthlyBinding).toBe("probation");
    expect(on.binding).toBe("probation");
    expect(on.ceiling).toMatchObject({ daily: 150_000n, monthly: 2_000_000n, source: "probation" });
    expect(on.owner).toEqual({ daily: 500_000n, monthly: 5_000_000n });

    h.db.rows("spendControl")[0].probation = "lifted";
    const lifted = await effectiveLimits(T, "ads", "INR", undefined, { now: NOW });
    expect(lifted.daily).toBe(150_000n);
    expect(lifted.monthly).toBe(3_000_000n);
    expect(lifted.binding).toBe("plan");
  });

  it("is the owner's limit when that is the smallest", async () => {
    seedControl({ probation: "lifted" });
    ceiling("platform", "*", "ads", "INR", 1_000_000n, 9_000_000n);
    seedAllowance("ads", "INR", 100_000n, 1_000_000n);
    const l = await effectiveLimits(T, "ads", "INR", undefined, { now: NOW });
    expect([l.daily, l.monthly, l.binding]).toEqual([100_000n, 1_000_000n, "owner"]);
  });

  it("uses the trial plan's ceilings while trialing", async () => {
    h.db.rows("tenant")[0].trialEndsAt = new Date(NOW.getTime() + 3 * DAY);
    h.db.seed("plan", [{ id: "plan_trial", code: "trial", name: "Trial", aiCreditsMonthly: 50 }]);
    ceiling("plan", "plan_trial", "ads", "INR", 80_000n, 400_000n);
    seedAllowance("ads", "INR", 500_000n, 5_000_000n);
    const plan = await resolveSpendPlan(T, undefined, NOW);
    expect(plan).toMatchObject({ planId: "plan_trial", code: "trial", trialing: true });
    const l = await effectiveLimits(T, "ads", "INR", undefined, { now: NOW });
    expect([l.daily, l.monthly, l.binding]).toEqual([80_000n, 400_000n, "plan"]);
    // After the trial, no plan applies (and no trial ceiling).
    const later = await effectiveLimits(T, "ads", "INR", undefined, { now: new Date(NOW.getTime() + 4 * DAY) });
    expect(later.plan.planId).toBeNull();
    expect(later.daily).toBe(200_000n);
  });
});

describe("effectiveLimits: tenant override", () => {
  it("replaces plan and new-workspace limits, then expires", async () => {
    seedAllowance("ads", "INR", 400_000n, 5_000_000n);
    ceiling("platform", "*", "ads", "INR", 300_000n, null);
    ceiling("tenant", T, "ads", "INR", 1_000_000n, 10_000_000n, { expiresAt: new Date(NOW.getTime() + DAY) });
    const l = await effectiveLimits(T, "ads", "INR", undefined, { now: NOW });
    expect(l.ceilingDetail.override).toBe(true);
    expect(l.ceiling).toMatchObject({ daily: 1_000_000n, monthly: 10_000_000n, source: "tenant" });
    expect(l.ceiling.expiresAt?.getTime()).toBe(NOW.getTime() + DAY);
    // The override even lifts the platform ceiling; the owner's own limits still apply.
    expect([l.daily, l.monthly, l.binding]).toEqual([400_000n, 5_000_000n, "owner"]);

    const after = await effectiveLimits(T, "ads", "INR", undefined, { now: new Date(NOW.getTime() + DAY + 1) });
    expect(after.ceilingDetail.override).toBe(false);
    expect([after.daily, after.monthly]).toEqual([200_000n, 2_000_000n]);
  });

  it("can cut below the owner's limit", async () => {
    seedAllowance("messaging", "INR", 100_000n, 900_000n);
    ceiling("tenant", T, "messaging", "INR", 10_000n, 50_000n);
    const l = await effectiveLimits(T, "messaging", "INR", undefined, { now: NOW });
    expect([l.daily, l.monthly, l.binding]).toEqual([10_000n, 50_000n, "tenant"]);
  });
});

describe("effectiveLimits: currencies and FX", () => {
  it("converts the INR row at a fresh rate, rounded down", async () => {
    fx({ USD: "84.10", JPY: "0.56" }, new Date(NOW.getTime() - 10 * DAY));
    seedAllowance("ads", "USD", 500_000n, 5_000_000n);
    const l = await effectiveLimits(T, "ads", "USD", undefined, { now: NOW });
    expect(l.unknownCeiling).toBe(false);
    // ₹2,000 / 84.10 = $23.7812 -> 2378 cents; ₹20,000 -> $237.8121 -> 23781 cents.
    expect([l.ceiling.daily, l.ceiling.monthly]).toEqual([2378n, 23_781n]);
    expect(l.ceilingDetail.sources.find((s) => s.source === "probation")?.via).toBe("fx");
    expect([l.daily, l.monthly]).toEqual([2378n, 23_781n]);
    expect(convertFromInr(200_000n, "JPY", parseFxTable({ rates: { JPY: "0.56" }, updatedAt: NOW.toISOString() }), NOW)).toBe(3571n);
  });

  it("prefers a ceiling row in the pot's own currency", async () => {
    fx({ USD: "84.10" }, NOW);
    ceiling("probation", "*", "ads", "USD", 2_500n, 25_000n);
    seedAllowance("ads", "USD", 500_000n, 5_000_000n);
    const l = await effectiveLimits(T, "ads", "USD", undefined, { now: NOW });
    expect([l.ceiling.daily, l.ceiling.monthly]).toEqual([2_500n, 25_000n]);
    expect(l.ceilingDetail.sources[1].via).toBe("row");
  });

  it("treats a 36-day-old rate as missing: the ceiling is unknown and refuses assistants and people on new-workspace limits", async () => {
    fx({ USD: "84.10" }, new Date(NOW.getTime() - 36 * DAY));
    seedAllowance("ads", "USD", 500_000n, 5_000_000n);
    const l = await effectiveLimits(T, "ads", "USD", undefined, { now: NOW });
    expect(l.unknownCeiling).toBe(true);
    expect(l.ceiling.daily).toBeNull();
    expect(l.rules.assistantRefusal).toEqual({ reason: "unknown_ceiling", code: "spend.currency" });
    expect(l.rules.humanRefusal).toEqual({ reason: "unknown_ceiling", code: "spend.currency" });
    // Once the new-workspace limits are lifted, people are not refused for it.
    h.db.rows("spendControl")[0].verifiedAt = NOW;
    const lifted = await effectiveLimits(T, "ads", "USD", undefined, { now: NOW });
    expect(lifted.unknownCeiling).toBe(false); // the probation source no longer applies at all
    ceiling("platform", "*", "ads", "INR", 1_000_000n, null);
    const platformUnknown = await effectiveLimits(T, "ads", "USD", undefined, { now: NOW });
    expect(platformUnknown.unknownCeiling).toBe(true);
    expect(platformUnknown.rules.humanRefusal).toBeNull();
    expect(platformUnknown.rules.assistantRefusal?.reason).toBe("unknown_ceiling");
  });

  it("keeps a rate exactly 35 days old", () => {
    expect(isRateFresh(new Date(NOW.getTime() - 35 * DAY), NOW)).toBe(true);
    expect(isRateFresh(new Date(NOW.getTime() - 35 * DAY - 1), NOW)).toBe(false);
    expect(isRateFresh(null, NOW)).toBe(false);
    expect(parseRate("84.10")).toEqual({ num: 8410n, scale: 2 });
    expect(parseRate("0")).toBeNull();
    expect(parseRate("1e5")).toBeNull();
    expect(convertFromInr(200_000n, "CRD", parseFxTable({}), NOW)).toBeNull();
  });

  it("does not apply owner limits in another currency (they read as Not set)", async () => {
    seedAllowance("ads", "INR", 500_000n, 5_000_000n);
    fx({ USD: "84.10" }, NOW);
    const l = await effectiveLimits(T, "ads", "USD", undefined, { now: NOW });
    expect(l.currencyMatches).toBe(false);
    expect(l.owner).toEqual({ daily: null, monthly: null });
    expect(l.daily).toBeNull();
    expect(l.rules.adsCanStart).toBe(false);
  });

  it("defaults the ads currency to the spending ad account's and WhatsApp to the rate card's", async () => {
    h.db.seed("metaAsset", [{ id: "as_us", tenantId: T, type: "ad_account", status: "active", meta: { currency: "USD", timezone: "America/New_York" }, createdAt: NOW }]);
    h.db.seed("platformSetting", [{ key: "ratecard", value: { currency: "INR", rates: {} } }]);
    const ads = await effectiveLimits(T, "ads", undefined, undefined, { now: NOW });
    expect(ads.currency).toBe("USD");
    const msg = await effectiveLimits(T, "messaging", null, undefined, { now: NOW });
    expect(msg.currency).toBe("INR");
    const ai = await effectiveLimits(T, "ai", undefined, undefined, { now: NOW });
    expect(ai.currency).toBe("CRD");
  });
});

describe("new-workspace limits (probation)", () => {
  it("lift after 2 paid invoices with a total above 0, and return after a void", async () => {
    paidInvoice(1);
    expect((await probationState(T)).on).toBe(true);
    paidInvoice(2, { totalPaise: 0 }); // a zero invoice never counts
    paidInvoice(3, { paidAt: null }); // nor one without a payment date
    expect((await probationState(T)).on).toBe(true);
    paidInvoice(4);
    const lifted = await probationState(T);
    expect(lifted).toMatchObject({ on: false, reason: "paid_invoices", paidInvoices: 2 });
    expect(lifted.why).not.toMatch(/probation/i);
    h.db.rows("invoice").find((i) => i.id === "inv_4")!.status = "void";
    expect((await probationState(T)).on).toBe(true);
  });

  it("lift when a platform admin verifies the workspace, or it is billing-exempt; forced and lifted override", async () => {
    seedControl({ verifiedAt: NOW });
    expect(await probationState(T)).toMatchObject({ on: false, reason: "verified" });
    h.db.rows("spendControl")[0].verifiedAt = null;
    h.db.rows("tenant")[0].billingExempt = true;
    expect(await probationState(T)).toMatchObject({ on: false, reason: "billing_exempt" });
    h.db.rows("tenant")[0].billingExempt = false; // a revoked exemption brings it back
    expect((await probationState(T)).on).toBe(true);
    h.db.rows("spendControl")[0].probation = "forced";
    paidInvoice(1);
    paidInvoice(2);
    expect(await probationState(T)).toMatchObject({ on: true, reason: "forced" });
    expect(computeProbation({ setting: "lifted", verifiedAt: null, billingExempt: false, paidInvoices: 0 })).toMatchObject({ on: false, reason: "lifted" });
  });

  it("apply to all three pots through the seeded rows", async () => {
    const [ads, msg, ai] = await Promise.all([
      effectiveLimits(T, "ads", "INR", undefined, { now: NOW }),
      effectiveLimits(T, "messaging", "INR", undefined, { now: NOW }),
      effectiveLimits(T, "ai", "CRD", undefined, { now: NOW }),
    ]);
    expect([ads.ceiling.daily, ads.ceiling.monthly, ads.ceiling.source]).toEqual([200_000n, 2_000_000n, "probation"]);
    expect([msg.ceiling.daily, msg.ceiling.monthly, msg.ceiling.source]).toEqual([50_000n, 500_000n, "probation"]);
    expect([ai.ceiling.daily, ai.ceiling.monthly, ai.ceiling.source]).toEqual([null, 500n, "probation"]);
    // Owner Not set: WhatsApp and AI fall back to the ceiling; ads still cannot start without a daily limit.
    expect([msg.daily, msg.monthly]).toEqual([50_000n, 500_000n]);
    expect(ads.daily).toBeNull();
    expect(ads.monthly).toBe(2_000_000n);
    expect(ads.rules.adsCanStart).toBe(false);
  });
});

describe("the AI pot", () => {
  it("is capped by the plan's monthly credits, else AI_DEFAULT_MONTHLY_CREDITS, and is never unlimited", async () => {
    seedControl({ probation: "lifted" });
    h.db.seed("subscription", [{ id: "sub1", tenantId: T, planId: "plan_pro", status: "active" }]);
    h.db.seed("plan", [{ id: "plan_pro", code: "pro", name: "Pro", aiCreditsMonthly: 300 }]);
    seedAllowance("ai", "CRD", 50n, 1_000n);
    const capped = await effectiveLimits(T, "ai", "CRD", undefined, { now: NOW });
    expect([capped.daily, capped.monthly, capped.monthlyBinding, capped.planCapMonthly]).toEqual([50n, 300n, "plan", 300n]);

    h.db.rows("plan")[0].aiCreditsMonthly = null;
    const fallback = await effectiveLimits(T, "ai", "CRD", undefined, { now: NOW });
    // The owner's 1,000 is above the platform default (1,500 since Eddy 12.1a decision 2), so the owner's limit applies...
    expect(fallback.monthly).toBe(1_000n);
    expect(fallback.planCapMonthly).toBe(BigInt(DEFAULT_MONTHLY_CREDITS));
    // ...and a lower AI_DEFAULT_MONTHLY_CREDITS caps it.
    process.env.AI_DEFAULT_MONTHLY_CREDITS = "120";
    expect((await effectiveLimits(T, "ai", "CRD", undefined, { now: NOW })).monthly).toBe(120n);

    h.db.rows("spendAllowance").length = 0;
    const notSet = await effectiveLimits(T, "ai", "CRD", undefined, { now: NOW });
    expect(notSet.owner.monthly).toBeNull();
    expect(notSet.monthly).toBe(120n);
  });

  it("is also capped by the new-workspace 500 credits", async () => {
    h.db.seed("subscription", [{ id: "sub1", tenantId: T, planId: "plan_big", status: "active" }]);
    h.db.seed("plan", [{ id: "plan_big", code: "big", name: "Big", aiCreditsMonthly: 5000 }]);
    const l = await effectiveLimits(T, "ai", "CRD", undefined, { now: NOW });
    expect([l.monthly, l.binding]).toEqual([500n, "probation"]);
  });
});

describe("MAX_DAILY_BUDGET_MINOR", () => {
  it("reads as an INR platform daily ads ceiling of ceil175(value)", async () => {
    expect(legacyPlatformDailyCeiling({ MAX_DAILY_BUDGET_MINOR: "571" })).toBe(1000n);
    expect(legacyPlatformDailyCeiling({ MAX_DAILY_BUDGET_MINOR: "100000" })).toBe(175_000n);
    expect(legacyPlatformDailyCeiling({})).toBeNull();
    seedControl({ probation: "lifted" });
    seedAllowance("ads", "INR", 500_000n, 5_000_000n);
    const env = { MAX_DAILY_BUDGET_MINOR: "100000" };
    const l = await effectiveLimits(T, "ads", "INR", undefined, { now: NOW, env });
    expect([l.daily, l.dailyBinding, l.monthly]).toEqual([175_000n, "platform", 5_000_000n]);
    // It merges with a platform INR row (the smaller wins) and never touches the other pots.
    ceiling("platform", "*", "ads", "INR", 150_000n, 4_000_000n);
    expect((await effectiveLimits(T, "ads", "INR", undefined, { now: NOW, env })).daily).toBe(150_000n);
    seedAllowance("messaging", "INR", 900_000n, 9_000_000n);
    expect((await effectiveLimits(T, "messaging", "INR", undefined, { now: NOW, env })).daily).toBe(900_000n);
  });
});

describe("Not set rules (4.4)", () => {
  it("ads: no daily limit means no ads; no monthly limit means people are checked daily only and assistants refused", () => {
    const none = combineLimits("ads", { daily: null, monthly: 1_000n }, { daily: 500n, monthly: 900n, dailySource: "platform", monthlySource: "platform" });
    expect(none.daily).toBeNull();
    expect(limitRules("ads", { daily: null, monthly: 900n, unknownCeiling: false }, false)).toMatchObject({ adsCanStart: false, humanRefusal: { code: "spend.no_limit" } });
    const r = limitRules("ads", { daily: 500n, monthly: null, unknownCeiling: false }, false);
    expect(r).toMatchObject({ adsCanStart: true, humansChecked: { daily: true, monthly: false }, humanRefusal: null, assistantRefusal: { reason: "no_monthly_limit" } });
  });

  it("WhatsApp and AI: Not set with no ceiling means counted, not limited, and assistants refused", async () => {
    seedControl({ probation: "lifted" });
    const l = await effectiveLimits(T, "messaging", "INR", undefined, { now: NOW });
    expect([l.daily, l.monthly]).toEqual([null, null]);
    expect(l.rules).toMatchObject({ humansChecked: { daily: false, monthly: false }, humanRefusal: null, assistantRefusal: { reason: "no_limit" } });
  });

  it("decision 2.3.8: the owner's Not set refuses assistants in every pot even when a ceiling gives a number; people use the ceiling", async () => {
    // On new-workspace limits every pot has a ceiling (12.1a decision 3), but the owner set nothing.
    const [ads, msg, ai] = await Promise.all([
      effectiveLimits(T, "ads", "INR", undefined, { now: NOW }),
      effectiveLimits(T, "messaging", "INR", undefined, { now: NOW }),
      effectiveLimits(T, "ai", "CRD", undefined, { now: NOW }),
    ]);
    expect(msg.monthly).toBe(500_000n);
    expect(msg.rules).toMatchObject({ humansChecked: { monthly: true }, humanRefusal: null, assistantRefusal: { reason: "no_limit" } });
    expect(ai.monthly).toBe(500n);
    expect(ai.rules.assistantRefusal).toEqual({ reason: "no_limit", code: null });
    expect(ads.rules.assistantRefusal).toEqual({ reason: "no_daily_limit", code: "spend.no_limit" });

    // Owner daily set, monthly Not set: people are checked against the new-workspace month; assistants are refused.
    seedAllowance("ads", "INR", 100_000n, null);
    const adsDaily = await effectiveLimits(T, "ads", "INR", undefined, { now: NOW });
    expect([adsDaily.daily, adsDaily.monthly]).toEqual([100_000n, 2_000_000n]);
    expect(adsDaily.rules).toMatchObject({ adsCanStart: true, humanRefusal: null, assistantRefusal: { reason: "no_monthly_limit" } });

    // Once the owner sets the month, assistants are no longer refused for it.
    seedAllowance("messaging", "INR", null, 300_000n);
    const set = await effectiveLimits(T, "messaging", "INR", undefined, { now: NOW });
    expect([set.monthly, set.rules.assistantRefusal]).toEqual([300_000n, null]);
    // Without the owner's limits the pure rule only looks at the effective ones.
    expect(limitRules("messaging", { daily: null, monthly: 9n, unknownCeiling: false }, false).assistantRefusal).toBeNull();
    expect(limitRules("messaging", { daily: null, monthly: 9n, unknownCeiling: false }, false, { daily: null, monthly: null }).assistantRefusal).toEqual({ reason: "no_limit", code: null });
  });
});

// =====================================================================================================================
describe("setAllowances: the per-field rule (8.1, 2.3.8)", () => {
  beforeEach(() => seedAllowance("ads", "INR", 200_000n, 2_000_000n, 3));

  const refused = () => ledger().filter((r) => r.phase === "refused");

  it("lets an admin lower a number, with a requested and an applied ledger row and an undo recipe", async () => {
    const out = await setAllowances(T, { pot: "ads", dailyLimitMinor: 150_000n }, admin, 3);
    expect(out.change.direction).toBe("lower");
    expect(out.allowance).toMatchObject({ dailyLimitMinor: 150_000n, monthlyLimitMinor: 2_000_000n, version: 4, updatedByUserId: "u_admin" });
    const rows = ledger().filter((r) => r.correlationId === out.correlationId);
    expect(rows.map((r) => r.phase)).toEqual(["requested", "applied"]);
    expect(rows[0]).toMatchObject({ action: "allowance.change", actorType: "user", actorId: "u_admin", pot: "ads", currency: "INR" });
    expect(rows[0].reason).toBe("Lowered the ads daily limit from ₹2,000 to ₹1,500.");
    expect(rows[0].undo).toEqual({ action: "set_allowance", pot: "ads", currency: "INR", dailyLimitMinor: "200000", monthlyLimitMinor: "2000000" });
  });

  it("refuses an admin raise with 403 spend.only_owner_raise and ledgers the refusal", async () => {
    const e = await setAllowances(T, { pot: "ads", dailyLimitMinor: 250_000n }, admin, 3).catch((x) => x);
    expect(e).toBeInstanceOf(SpendBlockedError);
    expect(e).toMatchObject({ status: 403, code: "spend.only_owner_raise", message: "Only the owner can raise a limit. You can lower it." });
    expect(h.db.rows("spendAllowance")[0].dailyLimitMinor).toBe(200_000n);
    expect(refused()).toHaveLength(1);
    expect(refused()[0]).toMatchObject({ action: "allowance.change", reasonCodes: ["spend.only_owner_raise"], actorId: "u_admin" });
  });

  it("refuses an admin turning Not set into a number, or a number into Not set, or changing the currency", async () => {
    h.db.rows("spendAllowance")[0].monthlyLimitMinor = null;
    for (const patch of [
      { pot: "ads" as const, monthlyLimitMinor: 1_000_000n },
      { pot: "ads" as const, dailyLimitMinor: null },
      { pot: "ads" as const, currency: "USD", dailyLimitMinor: 100n, monthlyLimitMinor: 1_000n },
    ]) {
      await expect(setAllowances(T, patch, admin, 3)).rejects.toMatchObject({ status: 403, code: "spend.only_owner_raise" });
    }
    expect(refused()).toHaveLength(3);
    expect(h.db.rows("spendAllowance")[0]).toMatchObject({ dailyLimitMinor: 200_000n, monthlyLimitMinor: null, currency: "INR", version: 3 });
  });

  it("lets the owner raise, set, clear and change the currency (re-entering both limits)", async () => {
    const raised = await setAllowances(T, { pot: "ads", dailyLimitMinor: 300_000n, monthlyLimitMinor: 3_000_000n }, owner, 3);
    expect(raised.change.direction).toBe("raise");
    expect(raised.change.raises).toBe(true);
    expect(raised.allowance?.version).toBe(4);
    const cleared = await setAllowances(T, { pot: "ads", monthlyLimitMinor: null }, owner, 4);
    expect(cleared.allowance?.monthlyLimitMinor).toBeNull();
    await expect(setAllowances(T, { pot: "ads", currency: "USD" }, owner, 5)).rejects.toMatchObject({ status: 400, message: "Enter your limits again in USD." });
    const usd = await setAllowances(T, { pot: "ads", currency: "USD", dailyLimitMinor: 2_000n, monthlyLimitMinor: 20_000n }, owner, 5);
    expect(usd.allowance).toMatchObject({ currency: "USD", dailyLimitMinor: 2_000n, monthlyLimitMinor: 20_000n, version: 6 });
    expect(ledger().filter((r) => r.phase === "applied")).toHaveLength(3);
  });

  it("answers a stale version with 409 spend.version and a refused row", async () => {
    const e = await setAllowances(T, { pot: "ads", dailyLimitMinor: 100_000n }, owner, 2).catch((x) => x);
    expect(e).toMatchObject({ status: 409, code: "spend.version", message: "Someone else changed these limits. Reload to see the latest." });
    expect(refused()[0]).toMatchObject({ reasonCodes: ["spend.version"] });
    expect(h.db.rows("spendAllowance")[0].dailyLimitMinor).toBe(200_000n);
  });

  it("refuses team members, other actors and impossible values", async () => {
    await expect(setAllowances(T, { pot: "ads", dailyLimitMinor: 100_000n }, member, 3)).rejects.toMatchObject({
      status: 403,
      message: "Only the owner can change spending limits. Ask them if you need more.",
    });
    await expect(setAllowances(T, { pot: "ads", dailyLimitMinor: 100_000n }, { type: "assistant", assistantKey: "ads_optimizer" }, 3)).rejects.toMatchObject({ status: 403 });
    await expect(setAllowances(T, { pot: "ads", dailyLimitMinor: 3_000_000n }, owner, 3)).rejects.toMatchObject({ status: 400, message: "The daily limit can't be more than the monthly limit." });
    await expect(setAllowances(T, { pot: "ads", dailyLimitMinor: 0n }, owner, 3)).rejects.toMatchObject({ status: 400 });
    await expect(setAllowances(T, { pot: "ai", currency: "INR", monthlyLimitMinor: 5n, dailyLimitMinor: 1n }, owner, 0)).rejects.toMatchObject({ status: 400 });
  });

  it("lets a platform admin lower (lower_spend_limits) but not raise", async () => {
    const out = await setAllowances(T, { pot: "ads", monthlyLimitMinor: 1_000_000n }, support, 3, { reason: "Abuse report" });
    expect(out.allowance?.monthlyLimitMinor).toBe(1_000_000n);
    expect(ledger().find((r) => r.phase === "requested")).toMatchObject({ actorType: "platform_admin", reason: "Abuse report" });
    await expect(setAllowances(T, { pot: "ads", monthlyLimitMinor: 9_000_000n }, support, 4)).rejects.toMatchObject({ status: 403 });
  });

  it("creates the first row for the owner (version 0) and refuses it for an admin", async () => {
    await expect(setAllowances(T, { pot: "messaging", monthlyLimitMinor: 400_000n }, admin, 0)).rejects.toMatchObject({ code: "spend.only_owner_raise" });
    const out = await setAllowances(T, { pot: "messaging", monthlyLimitMinor: 400_000n }, owner, 0);
    expect(out.allowance).toMatchObject({ pot: "messaging", currency: "INR", monthlyLimitMinor: 400_000n, dailyLimitMinor: null, version: 1 });
    await expect(setAllowances(T, { pot: "messaging", monthlyLimitMinor: 300_000n }, owner, 0)).rejects.toMatchObject({ code: "spend.version" });
  });

  it("WhatsApp limits are only in the rate card's currency, so a limit the send gate could not check is never saved", async () => {
    h.db.seed("platformSetting", [{ key: "ratecard", value: { currency: "INR", rates: {} } }]);
    await expect(setAllowances(T, { pot: "messaging", currency: "USD", dailyLimitMinor: 5_000n, monthlyLimitMinor: 50_000n }, owner, 0)).rejects.toMatchObject({
      status: 400,
      message: "WhatsApp limits are in INR, the currency WhatsApp prices your messages in. Enter them in INR.",
    });
    expect(h.db.rows("spendAllowance").find((r) => r.pot === "messaging")).toBeUndefined();
    expect(h.db.rows("spendLedger").find((r) => r.phase === "refused" && (r.reasonCodes as string[]).includes("spend.currency"))).toBeTruthy();
    await expect(setAllowances(T, { pot: "messaging", currency: "INR", dailyLimitMinor: 5_000n, monthlyLimitMinor: 50_000n }, owner, 0)).resolves.toMatchObject({ allowance: { currency: "INR" } });
    // Ads still follow the ad account's currency, whatever the rate card says.
    await expect(setAllowances(T, { pot: "ads", currency: "USD", dailyLimitMinor: 2_000n, monthlyLimitMinor: 20_000n }, owner, 3)).resolves.toMatchObject({ allowance: { currency: "USD" } });
  });

  it("lowering the month below today's daily limit lowers the daily limit with it (never blocked)", async () => {
    const out = await setAllowances(T, { pot: "ads", monthlyLimitMinor: 150_000n }, admin, 3);
    expect(out.allowance).toMatchObject({ dailyLimitMinor: 150_000n, monthlyLimitMinor: 150_000n, version: 4 });
    expect(out.change.direction).toBe("lower");
    expect(out.change.fields.map((f) => [f.field, f.kind])).toEqual([
      ["monthly", "lower"],
      ["daily", "lower"],
    ]);
    const requested = ledger().find((r) => r.correlationId === out.correlationId && r.phase === "requested")!;
    expect(requested.reason).toBe("Lowered the ads monthly limit from ₹20,000 to ₹1,500. Lowered the ads daily limit from ₹2,000 to ₹1,500.");
    expect(requested.undo).toMatchObject({ dailyLimitMinor: "200000", monthlyLimitMinor: "2000000" });
    // A daily limit typed above the monthly one is still a mistake to fix, not something to guess.
    await expect(setAllowances(T, { pot: "ads", dailyLimitMinor: 140_000n, monthlyLimitMinor: 100_000n }, owner, 4)).rejects.toMatchObject({ status: 400 });
  });

  it("does nothing for a no-op patch", async () => {
    const out = await setAllowances(T, { pot: "ads", dailyLimitMinor: 200_000n }, admin, 3);
    expect(out.change.changed).toBe(false);
    expect(out.correlationId).toBeNull();
    expect(ledger()).toHaveLength(0);
  });

  it("classifies per field for the paywall rule (previewAllowanceChange)", async () => {
    const lower = await previewAllowanceChange(T, { pot: "ads", dailyLimitMinor: 1n });
    expect([lower.raises, lower.direction]).toEqual([false, "lower"]);
    const mixed = await previewAllowanceChange(T, { pot: "ads", dailyLimitMinor: 1n, monthlyLimitMinor: 9_000_000n });
    expect([mixed.raises, mixed.direction]).toEqual([true, "mixed"]);
    const c = classifyAllowanceChange({ currency: "INR", daily: null, monthly: 5n }, { pot: "ads", dailyLimitMinor: 5n, monthlyLimitMinor: null });
    expect(c.fields.map((f) => f.kind)).toEqual(["set", "clear"]);
    expect(() => assertMayChangeAllowance(admin, c)).toThrow(SpendBlockedError);
    expect(() => assertMayChangeAllowance(owner, c)).not.toThrow();
  });
});

// =====================================================================================================================
describe("admin panel writers", () => {
  it("setCeiling and clearCeiling are platform admin only and ledgered as ceiling.change", async () => {
    await expect(setCeiling({ scope: "tenant", scopeId: T, pot: "ads", currency: "INR", dailyMinor: 1n, monthlyMinor: 2n }, owner, "x")).rejects.toMatchObject({ status: 403 });
    const row = await setCeiling(
      { scope: "tenant", scopeId: T, pot: "ads", currency: "INR", dailyMinor: 900_000n, monthlyMinor: 9_000_000n, expiresAt: new Date(Date.now() + DAY) },
      support,
      "Verified agency, raised for the festival",
      {},
    );
    expect(row).toMatchObject({ scope: "tenant", scopeId: T, dailyMinor: 900_000n, setByUserId: "u_support" });
    const l = ledger().filter((r) => r.action === "ceiling.change");
    expect(l.map((r) => [r.tenantId, r.phase])).toEqual([
      [T, "requested"],
      [T, "applied"],
    ]);
    expect(l[0].undo).toMatchObject({ action: "clear_ceiling", scope: "tenant", scopeId: T, pot: "ads", currency: "INR" });
    // Platform and new-workspace rows go on the platform ledger ('*').
    await setCeiling({ scope: "probation", pot: "messaging", currency: "INR", dailyMinor: 40_000n, monthlyMinor: 400_000n }, support, "Tighter WhatsApp for new workspaces");
    expect(ledger().filter((r) => r.tenantId === "*" && r.action === "ceiling.change")).toHaveLength(2);
    expect((await listCeilings({ scope: "probation", pot: "messaging" }))[0]).toMatchObject({ dailyMinor: 40_000n, monthlyMinor: 400_000n });
    // AI is in credits; only overrides expire.
    await expect(setCeiling({ scope: "platform", pot: "ai", currency: "INR", dailyMinor: null, monthlyMinor: 1n }, support, "x")).rejects.toMatchObject({ status: 400 });
    await expect(setCeiling({ scope: "platform", pot: "ads", currency: "INR", dailyMinor: 1n, monthlyMinor: 1n, expiresAt: new Date(Date.now() + DAY) }, support, "x")).rejects.toMatchObject({ status: 400 });
    expect(await clearCeiling({ scope: "tenant", scopeId: T, pot: "ads" }, support, "Festival over")).toEqual({ deleted: 1 });
    expect(await clearCeiling({ scope: "tenant", scopeId: T, pot: "ads" }, support, "again")).toEqual({ deleted: 0 });
  });

  it("setProbation and setWorkspaceVerified write probation.change and change what applies", async () => {
    await expect(setProbation(T, "lifted", admin, "x")).rejects.toMatchObject({ status: 403 });
    await setProbation(T, "lifted", support, "Known customer");
    expect((await probationState(T)).on).toBe(false);
    await setProbation(T, "forced", support, "Chargeback");
    expect((await probationState(T)).reason).toBe("forced");
    await setProbation(T, "auto", support, "Back to normal");
    await setWorkspaceVerified(T, true, support, "KYC done", { now: NOW });
    expect(await probationState(T)).toMatchObject({ on: false, reason: "verified" });
    const rows = ledger().filter((r) => r.action === "probation.change" && r.phase === "requested");
    expect(rows.map((r) => r.reasonCodes)).toEqual([["probation_lifted"], ["probation_forced"], ["probation_auto"], ["verified"]]);
    expect(rows[0].undo).toEqual({ action: "set_probation", setting: "auto" });
  });

  it("setFxRates validates, dates each rate and ledgers fx.change on the platform ledger", async () => {
    await expect(setFxRates({ USD: "84.10" }, admin, "x")).rejects.toMatchObject({ status: 403 });
    await expect(setFxRates({ USD: "abc" }, support, "x")).rejects.toMatchObject({ status: 400 });
    await expect(setFxRates({ INR: "1" }, support, "x")).rejects.toMatchObject({ status: 400 });
    const old = new Date(NOW.getTime() - 40 * DAY);
    await setFxRates({ USD: "84.10", AED: "22.90" }, support, "Monthly update", { now: old });
    const table = await setFxRates({ USD: "84.50", AED: null }, support, "Monthly update", { now: NOW });
    expect(Object.keys(table.rates)).toEqual(["USD"]);
    expect(table.rates.USD).toMatchObject({ rate: "84.50" });
    const stored = await readFx();
    expect(stored.rates.USD.updatedAt?.toISOString()).toBe(NOW.toISOString());
    const rows = ledger().filter((r) => r.action === "fx.change" && r.phase === "requested");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ tenantId: "*", actorType: "platform_admin" });
    expect(rows[1].undo).toEqual({ action: "set_fx_rates", rates: { USD: "84.10", AED: "22.90" } });
  });
});
