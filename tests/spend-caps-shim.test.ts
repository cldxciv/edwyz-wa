import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSpendDb } from "./helpers/fake-spend-db";

/**
 * docs/SPEND-CONTROLS-SPEC.md 4.8 (critic) and WP-06: the caps.ts shims and /api/ads/caps keep their OLD meaning, "the most
 * your daily budgets may add up to" (C), while the Spend Book stores the worst case, the ads daily limit L = ceil175(C).
 * PUT C stores ceil175(C); GET answers floor(4L/7); a value round-trips exactly. The real allowances, ledger and book run on
 * the in-memory spend database; only the signed-in member is a stand-in.
 */

const h = vi.hoisted(() => ({ db: null as unknown as FakeSpendDb }));
vi.mock("@/lib/db", async () => {
  const { createFakeSpendDb } = await import("./helpers/fake-spend-db");
  h.db = createFakeSpendDb();
  return { prisma: h.db.prisma };
});
const auth = vi.hoisted(() => ({ getActor: vi.fn() }));
vi.mock("@/lib/auth", () => auth);

import { GET, PUT } from "@/app/api/ads/caps/route";
import { assertCapCurrencyChangeable, assertWithinCap, assertWithinWorkspaceCap, formatMinor, getCaps, parseCapsInput, setCaps, withCapLock, workspaceActiveBudget, type AdCaps } from "@/lib/ads/caps";
import { getBudgetCap } from "@/lib/optimizer/config";
import { resetBookForTests } from "@/lib/spend/book";
import { resetSpendStateCache } from "@/lib/spend/kill";
import type { SpendActor } from "@/lib/spend/types";
import { ceil175, maxDailyBudgetWithin } from "@/lib/spend/worstcase";

const T = "t1";
const NOW = new Date("2026-10-28T06:30:00Z");
const ORIGIN = "https://wa.edwyz.com";
const member = (role: "owner" | "admin" | "agent") => ({ userId: `u_${role}`, tenantId: T, role });
const ownerSpend: SpendActor = { type: "user", userId: "u_owner", role: "owner" };
const rows = (name: string) => h.db.rows(name);
const allowance = () => rows("spendAllowance").find((r) => r.tenantId === T && r.pot === "ads");
const legacy = () => rows("platformSetting").find((r) => r.key === `ads:caps:${T}`)?.value as Record<string, unknown> | undefined;

function request(method: "GET" | "PUT", body?: unknown, origin: string | null = ORIGIN) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin) headers.origin = origin;
  return new Request(`${ORIGIN}/api/ads/caps`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function put(role: "owner" | "admin" | "agent", body: unknown, origin?: string | null) {
  auth.getActor.mockResolvedValue(member(role));
  const res = await PUT(request("PUT", body, origin === undefined ? ORIGIN : origin));
  return { status: res.status, json: (await res.json()) as { caps?: AdCaps; error?: string } };
}
async function get(role: "owner" | "admin" | "agent") {
  auth.getActor.mockResolvedValue(member(role));
  const res = await GET(request("GET"));
  return { status: res.status, json: (await res.json()) as { caps?: AdCaps; error?: string } };
}

function seedWorkspace() {
  h.db.seed("tenant", [{ id: T, name: "Shop", slug: "shop", status: "active", billingExempt: false }]);
  h.db.seed("metaAsset", [{ id: "acc1", tenantId: T, connectionId: "mc1", type: "ad_account", externalId: "act_111", name: "Shop ads", status: "active", meta: { currency: "INR", timezone: "Asia/Kolkata" }, sandbox: false, createdAt: new Date("2026-01-01") }]);
  h.db.seed("spendControl", [{ tenantId: T, probation: "lifted", spendingAdAccountAssetId: "acc1", timezone: "Asia/Kolkata" }]);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  h.db.reset();
  resetSpendStateCache();
  resetBookForTests();
  vi.clearAllMocks();
  delete process.env.MAX_DAILY_BUDGET_MINOR;
  seedWorkspace();
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.MAX_DAILY_BUDGET_MINOR;
});

// =====================================================================================================================
describe("the old meaning round-trips exactly", () => {
  it.each([1, 571, 1_000, 1_142, 10 ** 9])("PUT %i then GET returns it", async (c) => {
    const saved = await put("owner", { maxDailyBudgetMinor: c, currency: "INR" });
    expect(saved.status).toBe(200);
    expect(saved.json.caps).toEqual({ maxDailyBudgetMinor: c, currency: "INR", exponent: 2 });
    // Stored as the worst case: Meta may spend 75% more than a daily budget on a busy day.
    expect(allowance()?.dailyLimitMinor).toBe(ceil175(BigInt(c)));
    expect((await get("admin")).json.caps).toEqual({ maxDailyBudgetMinor: c, currency: "INR", exponent: 2 });
    // The legacy key is kept in step, so the previous build reads the same number after a rollback.
    expect(legacy()).toEqual({ maxDailyBudgetMinor: c, currency: "INR", exponent: 2 });
  });

  it("is the largest C whose worst case fits: floor(4L/7), for any stored limit", () => {
    for (const l of [1n, 2n, 3n, 999n, 1_000n, 1_750n, 1_999n, 2_000n, 200_000n, 1_750_000_000n]) {
      const c = maxDailyBudgetWithin(l);
      expect(ceil175(c)).toBeLessThanOrEqual(l);
      expect(ceil175(c + 1n)).toBeGreaterThan(l);
    }
  });

  it("a ₹2,000 daily limit set in Settings reads as up to ₹1,142 a day of ad budgets", async () => {
    h.db.seed("spendAllowance", [{ id: "sa1", tenantId: T, pot: "ads", currency: "INR", dailyLimitMinor: 200_000n, monthlyLimitMinor: null }]);
    expect(await getCaps(T)).toEqual({ maxDailyBudgetMinor: 114_285, currency: "INR", exponent: 2 });
  });

  it("each save is the owner's allowance change, ledgered with plain words", async () => {
    await put("owner", { maxDailyBudgetMinor: 100_000, currency: "INR" });
    await put("owner", { maxDailyBudgetMinor: 60_000, currency: "INR" });
    const changes = rows("spendLedger").filter((r) => r.action === "allowance.change");
    expect(changes.map((r) => r.phase)).toEqual(["requested", "applied", "requested", "applied"]);
    expect(changes.filter((r) => r.phase === "requested").map((r) => r.reasonCodes)).toEqual([["allowance_raise"], ["allowance_lower"]]);
    expect(changes[0]).toMatchObject({ actorType: "user", actorId: "u_owner", reason: "Up to ₹1,000 a day in ad budgets. Meta can spend 75% more on a busy day, so the daily ads limit is ₹1,750." });
    expect(allowance()).toMatchObject({ dailyLimitMinor: 105_000n, version: 2, updatedByUserId: "u_owner" });
    expect(rows("auditLog").map((r) => r.action)).toEqual(["ads.caps.updated", "ads.caps.updated"]);
  });
});

// =====================================================================================================================
describe("the role contract is unchanged", () => {
  it("GET for admins and owners, not team members", async () => {
    expect((await get("agent")).status).toBe(403);
    expect((await get("admin")).status).toBe(200);
    expect((await get("owner")).json.caps).toEqual({ maxDailyBudgetMinor: null, currency: null, exponent: null });
  });

  it("PUT for the owner only, same origin, and nothing is written when refused", async () => {
    expect((await put("admin", { maxDailyBudgetMinor: 1_000, currency: "INR" })).status).toBe(403);
    expect((await put("agent", { maxDailyBudgetMinor: 1_000, currency: "INR" })).status).toBe(403);
    expect((await put("owner", { maxDailyBudgetMinor: 1_000, currency: "INR" }, null)).status).toBe(403);
    expect((await put("owner", { maxDailyBudgetMinor: 1.5, currency: "INR" })).status).toBe(400);
    expect((await put("owner", { maxDailyBudgetMinor: 1_000, currency: "rupees" })).status).toBe(400);
    expect(allowance()).toBeUndefined();
    expect(rows("auditLog")).toEqual([]);
  });

  it("the shim still refuses anyone but the owner when called directly (the per-field rule)", async () => {
    await setCaps(T, { maxDailyBudgetMinor: 1_000, currency: "INR" }, ownerSpend);
    await expect(setCaps(T, { maxDailyBudgetMinor: 2_000, currency: "INR" }, { type: "user", userId: "u_admin", role: "admin" })).rejects.toThrow("Only the owner can raise a limit. You can lower it.");
    // An admin may lower a number that exists.
    await expect(setCaps(T, { maxDailyBudgetMinor: 500, currency: "INR" }, { type: "user", userId: "u_admin", role: "admin" })).resolves.toMatchObject({ maxDailyBudgetMinor: 500 });
  });
});

// =====================================================================================================================
describe("reads, currencies and the legacy key", () => {
  it("falls back to the legacy key until an allowance row exists, rescaling an old exponent", async () => {
    rows("platformSetting").push({ key: `ads:caps:${T}`, value: { maxDailyBudgetMinor: 5_000, currency: "JPY", exponent: 2 } });
    expect(await getCaps(T)).toEqual({ maxDailyBudgetMinor: 50, currency: "JPY", exponent: 0 });
    // Once the allowance exists it wins, even when its daily limit is Not set (nothing can launch).
    h.db.seed("spendAllowance", [{ id: "sa1", tenantId: T, pot: "ads", currency: "INR", dailyLimitMinor: null, monthlyLimitMinor: null }]);
    expect(await getCaps(T)).toEqual({ maxDailyBudgetMinor: null, currency: "INR", exponent: 2 });
    await expect(assertWithinCap(T, 100, "INR")).rejects.toThrow(/No daily budget cap is set/);
  });

  it("MAX_DAILY_BUDGET_MINOR lowers the number as before, matching the book's ceil175 platform ceiling", async () => {
    await put("owner", { maxDailyBudgetMinor: 100_000, currency: "INR" });
    process.env.MAX_DAILY_BUDGET_MINOR = "60000";
    expect((await getCaps(T)).maxDailyBudgetMinor).toBe(60_000);
    expect(Number(maxDailyBudgetWithin(ceil175(60_000n)))).toBe(60_000);
    await expect(assertWithinCap(T, 60_001, "INR")).rejects.toThrow(/exceeds the cap/);
  });

  it("a currency change clears the monthly limit (nothing is converted) and is refused while campaigns in the old currency run", async () => {
    h.db.seed("spendAllowance", [{ id: "sa1", tenantId: T, pot: "ads", currency: "INR", dailyLimitMinor: 175_000n, monthlyLimitMinor: 2_000_000n }]);
    rows("adCampaign").push({ id: "live", tenantId: T, status: "active", currency: "INR", dailyBudgetMinor: 1_000 });
    const refused = await put("owner", { maxDailyBudgetMinor: 5_000, currency: "USD" });
    expect(refused.status).toBe(409);
    expect(rows("auditLog")).toEqual([]);
    await expect(assertCapCurrencyChangeable(T, "INR")).resolves.toBeUndefined();
    rows("adCampaign")[0].status = "paused";
    expect((await put("owner", { maxDailyBudgetMinor: 5_000, currency: "USD" })).json.caps).toEqual({ maxDailyBudgetMinor: 5_000, currency: "USD", exponent: 2 });
    expect(allowance()).toMatchObject({ currency: "USD", dailyLimitMinor: 8_750n, monthlyLimitMinor: null });
  });

  it("a daily limit above the owner's monthly limit is a plain 400, and nothing changes", async () => {
    h.db.seed("spendAllowance", [{ id: "sa1", tenantId: T, pot: "ads", currency: "INR", dailyLimitMinor: 100_000n, monthlyLimitMinor: 150_000n }]);
    const res = await put("owner", { maxDailyBudgetMinor: 100_000, currency: "INR" });
    expect(res).toMatchObject({ status: 400, json: { error: "The daily limit can't be more than the monthly limit." } });
    expect(allowance()?.dailyLimitMinor).toBe(100_000n);
  });
});

// =====================================================================================================================
describe("existing callers keep compiling and working", () => {
  it("assertWithinCap keeps its single-campaign check and wording", async () => {
    await setCaps(T, { maxDailyBudgetMinor: 100_000, currency: "INR" }, ownerSpend);
    await expect(assertWithinCap(T, 100_000, "INR")).resolves.toMatchObject({ maxDailyBudgetMinor: 100_000 });
    await expect(assertWithinCap(T, 100_001, "INR")).rejects.toThrow("The daily budget 1000.01 INR exceeds the cap of 1000.00 INR.");
    await expect(assertWithinCap(T, 100, "USD")).rejects.toThrow("The budget cap is set in INR but this campaign uses USD.");
    expect(parseCapsInput({ maxDailyBudgetMinor: 5, currency: "INR" })).toEqual({ max: 5, currency: "INR" });
    expect(formatMinor(12_345, "INR")).toBe("123.45 INR");
  });

  it("assertWithinWorkspaceCap asks the book: what is left today, at Meta's worst case", async () => {
    await setCaps(T, { maxDailyBudgetMinor: 200_000, currency: "INR" }, ownerSpend);
    // A running ₹1,000 ad set may spend ₹1,750 today: ₹3,500 - ₹1,750 is left.
    h.db.seed("adCampaign", [{ id: "c1", tenantId: T, adAccountAssetId: "acc1", metaCampaignId: "m_c1", name: "One", status: "active", dailyBudgetMinor: 100_000, currency: "INR", endsAt: null, origin: "human", sandbox: false, updatedAt: NOW }]);
    h.db.seed("adSet", [{ id: "c1s", tenantId: T, campaignId: "c1", metaAdSetId: "m_c1s", status: "active", dailyBudgetMinor: 100_000, lifetimeBudgetMinor: null }]);
    await expect(assertWithinWorkspaceCap(T, 100_000, "INR")).resolves.toBeDefined();
    await expect(assertWithinWorkspaceCap(T, 100_001, "INR")).rejects.toThrow(/Left today: ₹1,750/);
    // The campaign's own running worst case is not counted twice.
    await expect(assertWithinWorkspaceCap(T, 200_000, "INR", "c1")).resolves.toBeDefined();
    // The nominal sum is still there for display (its own test is in tests/ads-launcher.test.ts).
    expect(typeof workspaceActiveBudget).toBe("function");
  });

  it("withCapLock runs the callback under the book's ads lock", async () => {
    expect(await withCapLock(T, async () => 42)).toBe(42);
    expect(h.db.raw.some((r) => /pg_advisory_xact_lock|lock_timeout/i.test(r.sql))).toBe(true);
  });

  it("the optimizer's budget cap reads the same number", async () => {
    await setCaps(T, { maxDailyBudgetMinor: 1_142, currency: "INR" }, ownerSpend);
    expect(await getBudgetCap(T)).toBe(1_142);
  });
});
