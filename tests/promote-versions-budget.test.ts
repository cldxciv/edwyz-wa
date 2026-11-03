import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSpendDb, Row } from "./helpers/fake-spend-db";

/**
 * Compare versions and the fair split (docs/IG-PAGE-ADS-SPEC.md 3.8, 6.1 rule 10, D12; PRM-05 acceptance 11): a daily total
 * split equally between versions, rounded down to a whole unit, and budget edits on a running test that keep the split: cuts
 * lower every version, raises go one by one through the Spend Book and are cut back when one is refused. The real Spend Book
 * and Graph transport run over the in-memory spend database; only fetch (Meta) and the Meta connection are stand-ins.
 */

const h = vi.hoisted(() => ({ db: null as unknown as FakeSpendDb, ids: 0 }));
vi.mock("@/lib/db", async () => {
  const { createFakeSpendDb } = await import("./helpers/fake-spend-db");
  h.db = createFakeSpendDb();
  return { prisma: h.db.prisma };
});
vi.mock("@/lib/meta-connect", () => ({
  getAssetAccess: async (_tenantId: string, assetId: string) => ({ assetId, type: "ad_account", externalId: "act_111", name: "Shop ads", token: "TOKEN" }),
  listAssets: async (_tenantId: string, type?: string) => {
    if (type === "ad_account") return [{ id: "acc1", type: "ad_account", externalId: "act_111", name: "Shop ads", status: "active", meta: { currency: "INR", timezone: "Asia/Kolkata" } }];
    if (type === "page") return [{ id: "pg1", type: "page", externalId: "page1", name: "Shop", status: "active", meta: {} }];
    return [];
  },
}));
vi.mock("@/lib/approvals", () => ({ listApprovals: async () => [], isCampaignClientApproved: async () => false, expireDecidedApprovals: async () => 0 }));
vi.mock("@/lib/billing/limits", () => ({ assertAdAccountAllowed: async () => undefined, adAccountsBlockedByPlan: async () => new Set() }));

import { setSplitBudget } from "@/lib/ads/actions";
import { activateCampaign, changeCampaignBudget, confirmAmount, createCampaignDraft, getCampaign, parseDraftInput, updateCampaignDraft } from "@/lib/ads/service";
import { splitDaily } from "@/lib/promote/cost";
import { resetBookForTests } from "@/lib/spend/book";
import { SpendBlockedError } from "@/lib/spend/errors";
import { resetSpendStateCache } from "@/lib/spend/kill";
import { setTripwireAuditSink } from "@/lib/spend/tripwire";
import type { SpendActor } from "@/lib/spend/types";

// Wednesday 28 Oct 2026, 12:00 in Asia/Kolkata.
const NOW = new Date("2026-10-28T06:30:00Z");
const T = "t1";
const INR = (rupees: number) => BigInt(rupees * 100);
const admin = { userId: "u_admin", tenantId: T, role: "admin" as const };
const owner = { userId: "u_owner", tenantId: T, role: "owner" as const };
const adminSpend: SpendActor = { type: "user", userId: "u_admin", role: "admin" };
const KEYS = ["A", "B", "C"] as const;

// ===== Fake Meta behind the real transport =====

type Call = { method: string; path: string; body: Row | undefined };
const meta = { calls: [] as Call[], answer: null as null | ((c: Call) => Response | null) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
  const u = new URL(String(url));
  const call: Call = { method: init?.method ?? "GET", path: u.pathname.split("/").slice(2).join("/"), body: init?.body ? (JSON.parse(String(init.body)) as Row) : undefined };
  meta.calls.push(call);
  const injected = meta.answer?.(call);
  if (injected) return injected;
  return json(call.method === "GET" ? { id: call.path } : { success: true });
});
/** The daily budgets sent to Meta, in order: [ad set, amount]. */
const budgetPosts = () => meta.calls.filter((c) => c.method === "POST" && c.body?.daily_budget !== undefined).map((c) => [c.path, c.body!.daily_budget]);

// ===== Database =====

const rows = (name: string) => h.db.rows(name);
const ledger = (filter: (r: Row) => boolean = () => true) => rows("spendLedger").filter(filter);
const setRow = (id: string) => rows("adSet").find((s) => s.id === id)!;
const control = () => rows("spendControl").find((r) => r.tenantId === T)!;

function seedWorkspace(dailyRupees = 5_000) {
  h.db.seed("tenant", [{ id: T, name: "Shop", slug: "shop", status: "active", billingExempt: false }]);
  h.db.seed("metaAsset", [{ id: "acc1", tenantId: T, connectionId: "mc1", type: "ad_account", externalId: "act_111", name: "Shop ads", status: "active", meta: { currency: "INR", timezone: "Asia/Kolkata" }, sandbox: false, createdAt: new Date("2026-01-01") }]);
  h.db.seed("spendControl", [{ tenantId: T, probation: "lifted", spendingAdAccountAssetId: "acc1", timezone: "Asia/Kolkata" }]);
  h.db.seed("spendAllowance", [{ id: "sa1", tenantId: T, pot: "ads", currency: "INR", dailyLimitMinor: INR(dailyRupees), monthlyLimitMinor: INR(50_000) }]);
}

function seedCommitment(campaignId: string, setId: string, rupees: number) {
  h.db.seed("spendCommitment", [
    {
      id: `cm_${setId}`,
      tenantId: T,
      adAccountAssetId: "acc1",
      campaignId,
      adSetId: setId,
      metaObjectId: `m_${setId}`,
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
    },
  ]);
}

const campaign = (id: string, o: Row = {}): Row => ({
  id,
  tenantId: T,
  adAccountAssetId: "acc1",
  metaCampaignId: `m_${id}`,
  name: `Campaign ${id}`,
  template: "traffic",
  objective: "OUTCOME_TRAFFIC",
  status: "active",
  dailyBudgetMinor: 30_000,
  currency: "INR",
  startsAt: null,
  endsAt: null,
  specialAdCategory: "none",
  origin: "human",
  assistantKey: null,
  lifetimeBudgetMinor: null,
  sandbox: false,
  lastError: null,
  surface: "wizard",
  goal: "website_visits",
  discardedAt: null,
  createdAt: new Date("2026-10-01"),
  updatedAt: new Date("2026-10-01"),
  ...o,
});

/** A launched fair test: ad sets <id>_A, _B, _C (Meta ids m_<set>), each at `rupees` a day, with live commitments when active. */
function seedFairTest(id: string, rupees: number, o: { status?: string; test?: Row; versions?: number } = {}) {
  const status = o.status ?? "active";
  const keys = KEYS.slice(0, o.versions ?? 3);
  h.db.seed("adCampaign", [campaign(id, { status, dailyBudgetMinor: rupees * 100 * keys.length })]);
  for (const k of keys) {
    const setId = `${id}_${k}`;
    h.db.seed("adSet", [{ id: setId, tenantId: T, campaignId: id, metaAdSetId: `m_${setId}`, name: `Version ${k}`, status, targeting: {}, dailyBudgetMinor: rupees * 100, lifetimeBudgetMinor: null, variantKey: k, createdAt: new Date("2026-10-01") }]);
    h.db.seed("ad", [{ id: `${setId}_ad`, tenantId: T, adSetId: setId, metaAdId: `m_${setId}_ad`, name: `Ad ${k}`, status, creative: { pageId: "page1", message: `Offer ${k}` }, variantLabel: k, createdAt: new Date("2026-10-01") }]);
    if (status === "active") seedCommitment(id, setId, rupees);
  }
  h.db.seed("adTest", [{ id: `${id}_test`, tenantId: T, campaignId: id, kind: "creative", mode: "fair_split", status: status === "active" ? "running" : "draft", winnerAdSetId: null, ...o.test }]);
}

/** Another running campaign with one ad set (<id>s) at `rupees` a day. */
function seedRunning(id: string, rupees: number) {
  h.db.seed("adCampaign", [campaign(id, { dailyBudgetMinor: rupees * 100, goal: null })]);
  h.db.seed("adSet", [{ id: `${id}s`, tenantId: T, campaignId: id, metaAdSetId: `m_${id}s`, name: "Set", status: "active", targeting: {}, dailyBudgetMinor: rupees * 100, lifetimeBudgetMinor: null, createdAt: new Date("2026-10-01") }]);
  seedCommitment(id, `${id}s`, rupees);
}

beforeAll(() => {
  // The base fake has no relations or generated ids: give the ads service what Prisma would.
  const p = h.db.prisma as unknown as Record<string, Row>;
  const campaigns = p.adCampaign;
  const findFirst = campaigns.findFirst as (a: Row) => Promise<Row | null>;
  campaigns.findFirst = async (args: Row) => {
    const row = await findFirst(args);
    if (!row || !(args?.include as Row | undefined)?.adSets) return row;
    const sets = rows("adSet").filter((s) => s.campaignId === row.id);
    return { ...row, adSets: sets.map((s) => ({ ...s, ads: rows("ad").filter((a) => a.adSetId === s.id) })), adTest: rows("adTest").find((t) => t.campaignId === row.id) ?? null };
  };
  const ads = p.ad;
  const updateMany = ads.updateMany as (a: Row) => Promise<{ count: number }>;
  ads.updateMany = async (args: Row) => {
    const { adSet, ...where } = (args.where ?? {}) as Row;
    if (!adSet) return updateMany(args);
    const setIds = rows("adSet").filter((s) => s.campaignId === (adSet as Row).campaignId).map((s) => s.id);
    return updateMany({ ...args, where: { ...where, adSetId: { in: setIds } } });
  };
  for (const [model, prefix] of [["adCampaign", "cmp"], ["adSet", "set"], ["ad", "ad"], ["adTest", "test"]] as const) {
    const create = p[model].create as (a: Row) => Promise<Row>;
    p[model].create = async (args: Row) => {
      const data = { id: `${prefix}_${++h.ids}`, createdAt: new Date(), updatedAt: new Date(), ...(args.data as Row) };
      await create({ ...args, data });
      return data;
    };
  }
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  h.db.reset();
  h.ids = 0;
  resetSpendStateCache();
  resetBookForTests();
  meta.calls = [];
  meta.answer = null;
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
  setTripwireAuditSink(() => undefined);
  process.env.SPEND_ENFORCE = "enforce";
  delete process.env.SPEND_TRIPWIRE;
  delete process.env.SPEND_DRY_RUN;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setTripwireAuditSink(null);
  for (const k of ["SPEND_ENFORCE", "SPEND_TRIPWIRE", "PROMOTE_ENABLED"]) delete process.env[k];
});

describe("splitting the daily total between versions (3.8)", () => {
  const version = (key: string) => ({ key, creative: { pageId: "page1", message: `Offer ${key}`, link: "https://example.com/diwali", imageUrl: "https://example.com/a.png" } });
  const body = (over: Row = {}): Row => ({
    name: "Diwali",
    goal: "website_visits",
    adAccountAssetId: "acc1",
    dailyBudgetMinor: 29_000,
    specialAdCategory: "none",
    endsAt: "2026-11-03T18:29:00Z",
    targeting: { geo: { countries: ["IN"], cities: [] } },
    versions: KEYS.map(version),
    ...over,
  });

  it("a ₹290 total with 3 versions gives ₹96 each, and the amount to confirm is ₹288", async () => {
    seedWorkspace();
    expect(splitDaily(29_000n, 3, "INR")).toEqual({ shares: [9_600n, 9_600n, 9_600n], shareMinor: 9_600n, confirmedTotalMinor: 28_800n });
    const { campaignId } = await createCampaignDraft(admin, parseDraftInput(body(), { surface: "promote" }));
    const sets = rows("adSet").filter((s) => s.campaignId === campaignId);
    expect(sets.map((s) => [s.variantKey, s.dailyBudgetMinor, s.name])).toEqual([
      ["A", 9_600, "Version A"],
      ["B", 9_600, "Version B"],
      ["C", 9_600, "Version C"],
    ]);
    const c = await getCampaign(T, campaignId);
    expect(c.totalDailyBudgetMinor).toBe(28_800);
    expect(c.confirmTotalMinor).toBe(28_800);
    expect(confirmAmount(c)).toBe(28_800);
    expect(rows("adCampaign")[0]).toMatchObject({ dailyBudgetMinor: 28_800, surface: "promote", goal: "website_visits" });
    expect(rows("adTest")).toEqual([expect.objectContaining({ campaignId, kind: "creative", mode: "fair_split", status: "draft" })]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("editing the draft re-splits it, and keeping one version drops the test", async () => {
    seedWorkspace();
    const { campaignId } = await createCampaignDraft(admin, parseDraftInput(body(), { surface: "promote" }));
    const first = rows("adSet").find((s) => s.campaignId === campaignId)!.id;
    await updateCampaignDraft(admin, campaignId, body({ versions: KEYS.slice(0, 2).map(version) }));
    let sets = rows("adSet").filter((s) => s.campaignId === campaignId);
    expect(sets.map((s) => [s.variantKey, s.dailyBudgetMinor])).toEqual([
      ["A", 14_500],
      ["B", 14_500],
    ]);
    expect(sets[0].id).toBe(first);
    expect(rows("adTest")).toHaveLength(1);
    await updateCampaignDraft(admin, campaignId, body({ versions: [version("A")] }));
    sets = rows("adSet").filter((s) => s.campaignId === campaignId);
    expect(sets.map((s) => [s.variantKey, s.dailyBudgetMinor, s.name])).toEqual([[null, 29_000, "Diwali ad set"]]);
    expect(rows("adTest")).toHaveLength(0);
    expect(rows("adCampaign")[0].dailyBudgetMinor).toBe(29_000);
  });

  it("a fair test turns running when it is first started", async () => {
    seedWorkspace();
    seedFairTest("ct", 100, { status: "paused" });
    expect(rows("adTest")[0].status).toBe("draft");
    await activateCampaign(owner, "ct", { confirm: true, confirmedTotalMinor: 30_000 });
    expect(rows("adTest")[0].status).toBe("running");
    expect(rows("adCampaign")[0].status).toBe("active");
  });
});

describe("budget edits while a fair test runs keep the split (3.8)", () => {
  it("a cut lowers all 3 versions to the new share, as lowerings that work while spending is stopped", async () => {
    seedWorkspace();
    seedFairTest("ct", 100);
    Object.assign(control(), { freeze: "all", frozenByKind: "owner", frozenAt: NOW, frozenReason: "Testing" });
    resetSpendStateCache();
    const out = await changeCampaignBudget(admin, "ct", { dailyBudgetMinor: 15_000 });
    expect(out).toMatchObject({ appliedDailyBudgetMinor: 15_000, shareMinor: 5_000 });
    expect(budgetPosts()).toEqual([
      ["m_ct_A", 5_000],
      ["m_ct_B", 5_000],
      ["m_ct_C", 5_000],
    ]);
    expect(ledger((r) => r.action === "ads.adset.budget_cut").map((r) => r.phase)).toEqual(["requested", "applied", "requested", "applied", "requested", "applied"]);
    expect(ledger((r) => r.action === "ads.adset.budget_raise")).toEqual([]);
    expect(KEYS.map((k) => setRow(`ct_${k}`).dailyBudgetMinor)).toEqual([5_000, 5_000, 5_000]);
    expect(rows("adCampaign")[0].dailyBudgetMinor).toBe(15_000);
    expect(out.campaign.totalDailyBudgetMinor).toBe(15_000);
  });

  it("each share is rounded down to a whole rupee, so ₹160 for 3 versions is ₹53 each", async () => {
    seedWorkspace();
    seedFairTest("ct", 100);
    await expect(changeCampaignBudget(admin, "ct", { dailyBudgetMinor: 16_000 })).resolves.toMatchObject({ appliedDailyBudgetMinor: 15_900, shareMinor: 5_300 });
    expect(budgetPosts().map(([, v]) => v)).toEqual([5_300, 5_300, 5_300]);
  });

  it("a raise that fits raises each version in turn through the Spend Book", async () => {
    seedWorkspace();
    seedFairTest("ct", 100);
    await expect(changeCampaignBudget(admin, "ct", { dailyBudgetMinor: 54_000 })).resolves.toMatchObject({ appliedDailyBudgetMinor: 54_000, shareMinor: 18_000 });
    expect(budgetPosts()).toEqual([
      ["m_ct_A", 18_000],
      ["m_ct_B", 18_000],
      ["m_ct_C", 18_000],
    ]);
    expect(ledger((r) => r.action === "ads.adset.budget_raise").map((r) => r.phase)).toEqual(["requested", "applied", "requested", "applied", "requested", "applied"]);
    expect(KEYS.map((k) => setRow(`ct_${k}`).dailyBudgetMinor)).toEqual([18_000, 18_000, 18_000]);
  });

  it("a raise refused on version C cuts A and B back to their old shares and returns the refusal with left and needs", async () => {
    // ₹1,000 a day. Another campaign at ₹100 and the test at ₹100 x 3, each counted at 1.75x: ₹700 is used.
    seedWorkspace(1_000);
    seedRunning("other", 100);
    seedFairTest("ct", 100);
    // ₹540 a day is ₹180 per version: each raise needs ₹315 - ₹175 = ₹140 more. A and B fit; then ₹20 is left for C.
    const error = (await changeCampaignBudget(admin, "ct", { dailyBudgetMinor: 54_000 }).catch((e: unknown) => e)) as SpendBlockedError;
    expect(error).toBeInstanceOf(SpendBlockedError);
    expect(error.code).toBe("spend.daily_limit");
    expect(error.params.left).toEqual({ minor: INR(20), currency: "INR" });
    expect(error.params.needs).toEqual({ minor: INR(140), currency: "INR" });
    // A and B went up, C was refused before any Meta call, then B and A were put back, newest first.
    expect(budgetPosts()).toEqual([
      ["m_ct_A", 18_000],
      ["m_ct_B", 18_000],
      ["m_ct_B", 10_000],
      ["m_ct_A", 10_000],
    ]);
    // (A refusal row names no Meta object: nothing was sent.)
    expect(ledger((r) => r.action === "ads.adset.budget_raise").map((r) => [r.metaObjectId ?? null, r.phase])).toEqual([
      ["m_ct_A", "requested"],
      ["m_ct_A", "applied"],
      ["m_ct_B", "requested"],
      ["m_ct_B", "applied"],
      [null, "refused"],
    ]);
    expect(ledger((r) => r.action === "ads.adset.budget_cut").map((r) => [r.metaObjectId, r.phase])).toEqual([
      ["m_ct_B", "requested"],
      ["m_ct_B", "applied"],
      ["m_ct_A", "requested"],
      ["m_ct_A", "applied"],
    ]);
    // Every version is back at its old share, and the campaign total with it.
    expect(KEYS.map((k) => setRow(`ct_${k}`).dailyBudgetMinor)).toEqual([10_000, 10_000, 10_000]);
    expect(rows("spendCommitment").filter((c) => c.campaignId === "ct").map((c) => c.dailyBudgetMinor)).toEqual([INR(100), INR(100), INR(100)]);
    expect(rows("adCampaign").find((c) => c.id === "ct")!.dailyBudgetMinor).toBe(30_000);
  });

  it("a raise Meta does not confirm on a version is put back too, with the ones already raised", async () => {
    seedWorkspace();
    seedFairTest("ct", 100);
    meta.answer = (c) => (c.method === "POST" && c.path === "m_ct_B" && c.body?.daily_budget === 18_000 ? json({ error: { message: "Service temporarily unavailable", code: 2 } }, 500) : null);
    await expect(changeCampaignBudget(admin, "ct", { dailyBudgetMinor: 54_000 })).rejects.toMatchObject({ status: 502 });
    const sent = budgetPosts();
    expect(sent[0]).toEqual(["m_ct_A", 18_000]);
    expect(sent.filter(([, v]) => v === 10_000).map(([id]) => id)).toEqual(["m_ct_B", "m_ct_A"]);
    expect(sent.some(([id]) => id === "m_ct_C")).toBe(false);
    expect(KEYS.map((k) => setRow(`ct_${k}`).dailyBudgetMinor)).toEqual([10_000, 10_000, 10_000]);
  });

  it("refuses a share under ₹1 and an ad set that is not one of the versions", async () => {
    seedWorkspace();
    seedFairTest("ct", 100);
    seedRunning("other", 100);
    await expect(changeCampaignBudget(admin, "ct", { dailyBudgetMinor: 250 })).rejects.toMatchObject({ status: 400, message: "Each version needs at least ₹1 a day. Raise the total or remove a version." });
    await expect(changeCampaignBudget(admin, "ct", { dailyBudgetMinor: 60_000, adSetId: "others" })).rejects.toMatchObject({ status: 400 });
    // A version's own amount under ₹1 is refused the same way.
    await expect(changeCampaignBudget(admin, "ct", { dailyBudgetMinor: 50, adSetId: "ct_A" })).rejects.toMatchObject({ status: 400, message: "Each version needs at least ₹1 a day. Raise the amount." });
    expect(budgetPosts()).toEqual([]);
  });

  it("the budget dialog's request {adSetId, dailyBudgetMinor} is that version's own budget: every version gets it, never a split", async () => {
    // Version A shows "Now ₹96 a day"; the person types ₹200. Every version goes to ₹200 (₹600 a day in all), not ₹66.
    seedWorkspace();
    seedFairTest("ct", 96);
    const out = await changeCampaignBudget(admin, "ct", { adSetId: "ct_A", dailyBudgetMinor: 20_000 });
    expect(out).toMatchObject({ appliedDailyBudgetMinor: 20_000, shareMinor: 20_000, dailyTotalMinor: 60_000, versions: 3 });
    expect(budgetPosts()).toEqual([
      ["m_ct_A", 20_000],
      ["m_ct_B", 20_000],
      ["m_ct_C", 20_000],
    ]);
    expect(ledger((r) => r.action === "ads.adset.budget_raise").map((r) => r.phase)).toEqual(["requested", "applied", "requested", "applied", "requested", "applied"]);
    expect(KEYS.map((k) => setRow(`ct_${k}`).dailyBudgetMinor)).toEqual([20_000, 20_000, 20_000]);
    expect(out.campaign.totalDailyBudgetMinor).toBe(60_000);
    // A cut named on version B: every version to exactly that amount (no rounding: it is not divided), as lowerings.
    meta.calls = [];
    await expect(changeCampaignBudget(admin, "ct", { adSetId: "ct_B", dailyBudgetMinor: 6_650 })).resolves.toMatchObject({ appliedDailyBudgetMinor: 6_650, shareMinor: 6_650, dailyTotalMinor: 19_950 });
    expect(budgetPosts().map(([, v]) => v)).toEqual([6_650, 6_650, 6_650]);
    expect(KEYS.map((k) => setRow(`ct_${k}`).dailyBudgetMinor)).toEqual([6_650, 6_650, 6_650]);
  });

  it("a version's raise that is refused part-way puts every version back, as a total's does", async () => {
    // ₹1,000 a day: another campaign at ₹100 and the test at ₹100 x 3 use ₹700 at 1.75x. ₹180 per version: A and B fit, C does not.
    seedWorkspace(1_000);
    seedRunning("other", 100);
    seedFairTest("ct", 100);
    const error = (await changeCampaignBudget(admin, "ct", { adSetId: "ct_C", dailyBudgetMinor: 18_000 }).catch((e: unknown) => e)) as SpendBlockedError;
    expect(error).toBeInstanceOf(SpendBlockedError);
    expect(error.code).toBe("spend.daily_limit");
    expect(KEYS.map((k) => setRow(`ct_${k}`).dailyBudgetMinor)).toEqual([10_000, 10_000, 10_000]);
  });

  it("once a winner is picked the test is over: edits go to one ad set, as before", async () => {
    seedWorkspace();
    seedFairTest("ct", 100, { test: { status: "decided", winnerAdSetId: "ct_B" } });
    await expect(changeCampaignBudget(admin, "ct", { dailyBudgetMinor: 20_000 })).rejects.toMatchObject({ status: 400, message: "Choose which ad set's budget to change." });
    await expect(changeCampaignBudget(admin, "ct", { dailyBudgetMinor: 20_000, adSetId: "ct_B" })).resolves.toMatchObject({ appliedDailyBudgetMinor: 20_000 });
    expect(budgetPosts()).toEqual([["m_ct_B", 20_000]]);
  });

  it("'Let Meta pick' is no test: one ad set, one budget", async () => {
    seedWorkspace();
    seedFairTest("ct", 100, { versions: 1, test: { mode: "fair_split" } });
    await expect(changeCampaignBudget(admin, "ct", { dailyBudgetMinor: 12_000 })).resolves.toMatchObject({ appliedDailyBudgetMinor: 12_000 });
    expect(budgetPosts()).toEqual([["m_ct_A", 12_000]]);
  });
});

describe("setSplitBudget (ads/actions)", () => {
  it("does nothing for a version already at the share, and needs a positive whole amount and the person who decided", async () => {
    seedWorkspace();
    seedFairTest("ct", 100);
    await expect(setSplitBudget(T, ["m_ct_A", "m_ct_B"], 10_000, adminSpend)).resolves.toEqual({ versions: [], shareMinor: 10_000 });
    expect(budgetPosts()).toEqual([]);
    await expect(setSplitBudget(T, ["m_ct_A"], 0, adminSpend)).rejects.toMatchObject({ status: 400 });
    await expect(setSplitBudget(T, [], 5_000, adminSpend)).rejects.toMatchObject({ status: 400 });
    await expect(setSplitBudget(T, ["m_ct_A"], 5_000, undefined as unknown as SpendActor)).rejects.toThrow(/needs the person or job/);
    const out = await setSplitBudget(T, ["m_ct_A", "m_ct_B", "m_ct_C"], 8_000, adminSpend);
    expect(out.versions).toEqual(KEYS.map((k) => ({ metaAdSetId: `m_ct_${k}`, fromMinor: 10_000, toMinor: 8_000 })));
  });
});
