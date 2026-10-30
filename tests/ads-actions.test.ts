import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSpendDb, Row } from "./helpers/fake-spend-db";

/**
 * docs/SPEND-CONTROLS-SPEC.md 4.8, 4.11, 4.17, WP-06: the ads call sites through the real Spend Book (book, commitments,
 * ledger, kill switch) over the in-memory spend database, and the real Graph transport with its tripwire. Only fetch (Meta),
 * the Meta connection (token) and client approvals are stand-ins. Nothing reaches the network.
 */

const h = vi.hoisted(() => ({ db: null as unknown as FakeSpendDb }));
vi.mock("@/lib/db", async () => {
  const { createFakeSpendDb } = await import("./helpers/fake-spend-db");
  h.db = createFakeSpendDb();
  return { prisma: h.db.prisma };
});
const connect = vi.hoisted(() => ({ usable: true }));
vi.mock("@/lib/meta-connect", () => ({
  getAssetAccess: async (_tenantId: string, assetId: string) => {
    if (!connect.usable) throw Object.assign(new Error("The Meta connection for this asset has expired or been disconnected. Reconnect it in Settings."), { status: 409 });
    return { assetId, type: "ad_account", externalId: "act_111", name: "Shop ads", token: "TOKEN" };
  },
  listAssets: async (_tenantId: string, type?: string) => (type === "ad_account" || !type ? [{ id: "acc1", type: "ad_account", externalId: "act_111", name: "Shop ads", status: "active", meta: { currency: "INR", timezone: "Asia/Kolkata" } }] : []),
}));
vi.mock("@/lib/approvals", () => ({ listApprovals: async () => [], isCampaignClientApproved: async () => false }));

import { pauseAd, pauseAdSet, resumeAd, setAdSetBudget } from "@/lib/ads/actions";
import { adsClient } from "@/lib/ads/client";
import { activateCampaign, pauseCampaign } from "@/lib/ads/service";
import { stopCommitments } from "@/lib/ads/stop";
import { graphFetchAs } from "@/lib/graph";
import { headroom, permitForPausedCreate, recordLowering, reserveAds, resetBookForTests } from "@/lib/spend/book";
import { SpendBlockedError, SpendGuardBypassError } from "@/lib/spend/errors";
import { resetSpendStateCache } from "@/lib/spend/kill";
import { handleStopJob, KILL_SWEEP_EVERY_MS, KILL_SWEEP_TASK, killSweep, markUnpaused, parseStopJob, periodic, queues, runStop, stopInline } from "@/lib/spend/tasks/adsguard";
import { setTripwireAuditSink, type TripwireAuditEvent } from "@/lib/spend/tripwire";
import { SPEND_QUEUES, type AdsGuard, type LoweringPermit, type SpendActor } from "@/lib/spend/types";
import { worker as spendWorker } from "@/lib/spend/worker";

// Wednesday 28 Oct 2026, 12:00 in Asia/Kolkata.
const NOW = new Date("2026-10-28T06:30:00Z");
const T = "t1";
const INR = (rupees: number) => BigInt(rupees * 100);
const admin = { userId: "u_admin", tenantId: T, role: "admin" as const };
const owner = { userId: "u_owner", tenantId: T, role: "owner" as const };
const adminSpend: SpendActor = { type: "user", userId: "u_admin", role: "admin" };
const assistant: SpendActor = { type: "assistant", assistantKey: "ads_launcher" };
const guard: AdsGuard = { tenantId: T, adAccountAssetId: "acc1", actor: adminSpend, sandbox: false };

// ===== Fake Meta behind the real transport =====

type Call = { method: string; path: string; body: Row | undefined };
const meta = { calls: [] as Call[], answer: null as null | ((c: Call) => Response | Error | null | undefined) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
  const u = new URL(String(url));
  const call: Call = { method: init?.method ?? "GET", path: u.pathname.split("/").slice(2).join("/"), body: init?.body ? (JSON.parse(String(init.body)) as Row) : undefined };
  meta.calls.push(call);
  const injected = meta.answer?.(call);
  if (injected instanceof Error) throw injected;
  if (injected) return injected;
  if (call.method === "POST" && /\/(campaigns|adsets|adcreatives|ads)$/.test(call.path)) return json({ id: `new_${meta.calls.length}` });
  return json(call.method === "GET" ? { id: call.path } : { success: true });
});
const posts = () => meta.calls.filter((c) => c.method === "POST");
/** Meta answers this object's write with a server error: the request may have gone through. */
const unclear = (path: string) => (c: Call) => (c.method === "POST" && c.path === path ? json({ error: { message: "Service temporarily unavailable", code: 2 } }, 500) : null);
/** Meta refuses this object's write: nothing changed. */
const refused = (path: string, status?: string) => (c: Call) => (c.method === "POST" && c.path === path && (!status || c.body?.status === status) ? json({ error: { message: "Invalid parameter", code: 100 } }, 400) : null);

const tripwire: TripwireAuditEvent[] = [];

// ===== Database =====

const rows = (name: string) => h.db.rows(name);
const ledger = (filter: (r: Row) => boolean = () => true) => rows("spendLedger").filter(filter);
const commitment = (metaObjectId: string) => rows("spendCommitment").find((r) => r.metaObjectId === metaObjectId && r.status !== "stopped");
const campaignRow = (id: string) => rows("adCampaign").find((r) => r.id === id)!;
const control = () => rows("spendControl").find((r) => r.tenantId === T)!;

function seedWorkspace(o: { daily?: number | null; monthly?: number | null } = {}) {
  h.db.seed("tenant", [{ id: T, name: "Shop", slug: "shop", status: "active", billingExempt: false }]);
  h.db.seed("metaAsset", [{ id: "acc1", tenantId: T, connectionId: "mc1", type: "ad_account", externalId: "act_111", name: "Shop ads", status: "active", meta: { currency: "INR", timezone: "Asia/Kolkata" }, sandbox: false, createdAt: new Date("2026-01-01") }]);
  h.db.seed("spendControl", [{ tenantId: T, probation: "lifted", spendingAdAccountAssetId: "acc1", timezone: "Asia/Kolkata" }]);
  const daily = o.daily === undefined ? 5_000 : o.daily;
  const monthly = o.monthly === undefined ? 50_000 : o.monthly;
  h.db.seed("spendAllowance", [{ id: "sa1", tenantId: T, pot: "ads", currency: "INR", dailyLimitMinor: daily === null ? null : INR(daily), monthlyLimitMinor: monthly === null ? null : INR(monthly) }]);
}

/** A launched campaign: Meta ids m_<id> (campaign), m_<id>s (ad set) and m_<id>a (ad). Budgets in rupees. */
function seedCampaign(id: string, o: { status?: string; daily?: number; origin?: string; endsAt?: Date | null; sets?: number } = {}) {
  const status = o.status ?? "paused";
  h.db.seed("adCampaign", [
    { id, tenantId: T, adAccountAssetId: "acc1", metaCampaignId: `m_${id}`, name: `Campaign ${id}`, template: "traffic", objective: "OUTCOME_TRAFFIC", status, dailyBudgetMinor: (o.daily ?? 1_000) * 100, currency: "INR", startsAt: null, endsAt: o.endsAt ?? null, specialAdCategory: "none", origin: o.origin ?? "human", assistantKey: o.origin === "assistant" ? "ads_launcher" : null, lifetimeBudgetMinor: null, sandbox: false, lastError: null, createdAt: new Date("2026-10-01"), updatedAt: new Date("2026-10-01") },
  ]);
  const sets = o.sets ?? 1;
  for (let i = 0; i < sets; i++) {
    const sid = i === 0 ? `${id}s` : `${id}s${i}`;
    h.db.seed("adSet", [{ id: sid, tenantId: T, campaignId: id, metaAdSetId: `m_${sid}`, name: `Set ${sid}`, status, targeting: {}, dailyBudgetMinor: (o.daily ?? 1_000) * 100, lifetimeBudgetMinor: null, createdAt: new Date("2026-10-01") }]);
  }
  h.db.seed("ad", [{ id: `${id}a`, tenantId: T, adSetId: `${id}s`, metaAdId: `m_${id}a`, name: `Ad ${id}`, status, creative: {}, createdAt: new Date("2026-10-01") }]);
}

/** A stored live commitment for an ad set, today's peak at its budget. */
function seedLive(id: string, rupees: number, extra: Row = {}) {
  const metaObjectId = extra.metaObjectId ?? `m_${id}s`;
  h.db.seed("spendCommitment", [
    {
      id: `cm_${metaObjectId}`,
      tenantId: T,
      adAccountAssetId: "acc1",
      campaignId: id,
      adSetId: `${id}s`,
      metaObjectId,
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

/** A running campaign with its live commitment. */
function seedRunning(id: string, rupees = 1_000, o: { origin?: string } = {}) {
  seedCampaign(id, { status: "active", daily: rupees, origin: o.origin });
  seedLive(id, rupees, o.origin ? { origin: o.origin } : {});
}

function freeze(level: "all" | "assistants") {
  Object.assign(control(), { freeze: level, frozenByKind: "owner", frozenAt: NOW, frozenReason: "Testing" });
  resetSpendStateCache();
}

beforeAll(() => {
  // The base fake has no relations: give the two queries the ads service makes with them what Prisma would return.
  const campaigns = h.db.prisma.adCampaign as unknown as Row;
  const findFirst = campaigns.findFirst as (a: Row) => Promise<Row | null>;
  campaigns.findFirst = async (args: Row) => {
    const row = await findFirst(args);
    const include = (args?.include as Row | undefined)?.adSets as Row | undefined;
    if (!row || !include) return row;
    const sets = rows("adSet").filter((s) => s.campaignId === row.id);
    return { ...row, adSets: sets.map((s) => ({ ...s, ads: rows("ad").filter((a) => a.adSetId === s.id) })) };
  };
  const ads = h.db.prisma.ad as unknown as Row;
  const updateMany = ads.updateMany as (a: Row) => Promise<{ count: number }>;
  ads.updateMany = async (args: Row) => {
    const { adSet, ...where } = (args.where ?? {}) as Row;
    if (!adSet) return updateMany(args);
    const setIds = rows("adSet").filter((s) => s.campaignId === (adSet as Row).campaignId).map((s) => s.id);
    return updateMany({ ...args, where: { ...where, adSetId: { in: setIds } } });
  };
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  h.db.reset();
  resetSpendStateCache();
  resetBookForTests();
  meta.calls = [];
  meta.answer = null;
  connect.usable = true;
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
  tripwire.length = 0;
  setTripwireAuditSink((e) => void tripwire.push(e));
  process.env.SPEND_ENFORCE = "enforce";
  delete process.env.SPEND_TRIPWIRE;
  delete process.env.SPEND_DRY_RUN;
  delete process.env.SPEND_SIM;
  delete process.env.SPEND_CAP_MODE;
  seedWorkspace();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setTripwireAuditSink(null);
  delete process.env.SPEND_ENFORCE;
  delete process.env.SPEND_TRIPWIRE;
  delete process.env.SPEND_DRY_RUN;
});

async function failure(p: Promise<unknown>): Promise<Error> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(Error);
  return e as Error;
}

// =====================================================================================================================
describe("the guarded ads client (4.8)", () => {
  it("cannot be made without a guard: it does not compile, and at run time it refuses", () => {
    // @ts-expect-error the guard (who acts, for which workspace and ad account) is required
    expect(() => adsClient("TOKEN", "act_111")).toThrow(SpendGuardBypassError);
    expect(() => adsClient("TOKEN", "act_111", { tenantId: T } as AdsGuard)).toThrow(SpendGuardBypassError);
  });

  it("with SPEND_TRIPWIRE=enforce, turning something ON without a valid permit throws before any fetch", async () => {
    process.env.SPEND_TRIPWIRE = "enforce";
    seedCampaign("c1");
    const client = adsClient("TOKEN", "act_111", guard);
    await failure(client.setStatus("m_c1a", "ACTIVE", undefined as never));
    // A permit-shaped object that the book never minted.
    await expect(client.setStatus("m_c1a", "ACTIVE", { type: "ads", objects: { m_c1a: { status: "ACTIVE" } } } as never)).rejects.toBeInstanceOf(SpendGuardBypassError);
    // Going around the client: the transport's tripwire refuses it too.
    await expect(graphFetchAs("TOKEN", { path: "m_c1a", method: "POST", body: { status: "ACTIVE" } })).rejects.toBeInstanceOf(SpendGuardBypassError);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it("with SPEND_TRIPWIRE=enforce, a budget raise without a valid permit throws before any fetch", async () => {
    process.env.SPEND_TRIPWIRE = "enforce";
    seedRunning("c1", 1_000);
    const client = adsClient("TOKEN", "act_111", guard);
    // A real reservation for ₹1,200 does not cover ₹1,500.
    const permit = await reserveAds(T, { kind: "raise_budget", adSetId: "c1s", metaAdSetId: "m_c1s", toMinor: INR(1_200) }, adminSpend, { idempotencyKey: "k1", reason: "Testing" });
    await expect(client.setDailyBudget("m_c1s", INR(1_500), permit)).rejects.toMatchObject({ reason: "budget_over_permit" });
    // A lowering permit for a pause covers no budget change.
    let pausePermit: LoweringPermit | undefined;
    await recordLowering(T, { kind: "pause", metaObjectId: "m_c2s" }, adminSpend, "Testing", async (p) => void (pausePermit = p));
    await expect(client.setDailyBudget("m_c1s", INR(900), pausePermit!)).rejects.toBeInstanceOf(SpendGuardBypassError);
    await expect(client.setDailyBudget("m_c1s", INR(1_500), undefined as never)).rejects.toBeInstanceOf(SpendGuardBypassError);
    // An expired reservation: the book says no before the call.
    vi.setSystemTime(new Date(NOW.getTime() + 11 * 60_000));
    await expect(client.setDailyBudget("m_c1s", INR(1_200), permit)).rejects.toThrow(/took too long/);
    await expect(graphFetchAs("TOKEN", { path: "m_c1s", method: "POST", body: { daily_budget: 150000 } })).rejects.toBeInstanceOf(SpendGuardBypassError);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it("creates only PAUSED objects under a create permit; a creative carries no status (erratum 12.1b)", async () => {
    process.env.SPEND_TRIPWIRE = "enforce";
    const client = adsClient("TOKEN", "act_111", guard);
    const permit = await permitForPausedCreate(T, "act_111", 4, adminSpend);
    await expect(client.createCampaign({ name: "S", status: "ACTIVE" }, permit)).rejects.toMatchObject({ reason: "create_not_paused" });
    await expect(client.createAd({ name: "A", status: "PAUSED" }, undefined as never)).rejects.toMatchObject({ reason: "create_without_permit" });
    await expect(client.createCreative({ name: "C", status: "PAUSED" }, permit)).rejects.toMatchObject({ reason: "creative_with_status" });
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(await client.createCampaign({ name: "S", status: "PAUSED" }, permit)).toMatch(/^new_/);
    expect(await client.createCreative({ name: "C", object_story_spec: {} }, permit)).toMatch(/^new_/);
    expect(posts().map((c) => [c.path, c.body?.status])).toEqual([
      ["act_111/campaigns", "PAUSED"],
      ["act_111/adcreatives", undefined],
    ]);
    // Without the client and without a permit, the transport refuses a create.
    await expect(graphFetchAs("TOKEN", { path: "act_111/ads", method: "POST", body: { name: "A", status: "PAUSED" } })).rejects.toBeInstanceOf(SpendGuardBypassError);
    // A create permit for another ad account is not this one's.
    await expect(adsClient("TOKEN", "act_999", { ...guard, adAccountAssetId: "acc9" }).createCampaign({ name: "S", status: "PAUSED" }, permit)).rejects.toMatchObject({ reason: "create_wrong_account" });
  });

  it("an assistant's ad set needs an end date (R2); a lifetime budget needs one too", async () => {
    const permit = await permitForPausedCreate(T, "act_111", 5, assistant);
    const client = adsClient("TOKEN", "act_111", { ...guard, actor: assistant });
    const body = { name: "S", campaign_id: "c", status: "PAUSED", daily_budget: 50000 };
    await expect(client.createAdSet(body, permit)).rejects.toThrow("Ads started by an assistant need an end date.");
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    await expect(client.createAdSet({ ...body, end_time: "2026-11-14T18:29:00.000Z" }, permit)).resolves.toMatch(/^new_/);
    const person = adsClient("TOKEN", "act_111", guard);
    await expect(person.createAdSet(body, permit)).resolves.toMatch(/^new_/);
    await expect(person.createAdSet({ name: "S", status: "PAUSED", lifetime_budget: 900000 }, permit)).rejects.toThrow(/lifetime budget needs an end date/);
  });

  it("a pause needs no permit and is never blocked, even in enforce mode; without one it is recorded as unledgered", async () => {
    process.env.SPEND_TRIPWIRE = "enforce";
    await adsClient("TOKEN", "act_111", guard).setStatus("m_c1", "PAUSED");
    expect(posts()).toEqual([{ method: "POST", path: "m_c1", body: { status: "PAUSED" } }]);
    expect(tripwire.map((e) => e.action)).toEqual(["spend.tripwire.unledgered_lowering"]);
    // Even handed a permit the book never minted, the pause still goes out (I2), once.
    await adsClient("TOKEN", "act_111", guard).setStatus("m_c2", "ARCHIVED", { type: "lowering", kind: "pause", metaObjectIds: ["m_c2"] } as never);
    expect(posts().map((c) => [c.path, c.body?.status])).toEqual([
      ["m_c1", "PAUSED"],
      ["m_c2", "ARCHIVED"],
    ]);
    // A Meta failure of the pause itself is not retried behind the caller's back.
    meta.answer = refused("m_c3");
    let lowering: LoweringPermit | undefined;
    await recordLowering(T, { kind: "pause", metaObjectId: "m_c3" }, adminSpend, "Testing", async (p) => void (lowering = p));
    await expect(adsClient("TOKEN", "act_111", guard).setStatus("m_c3", "PAUSED", lowering)).rejects.toThrow(/Invalid parameter/);
    expect(posts().filter((c) => c.path === "m_c3")).toHaveLength(1);
  });

  it("SPEND_DRY_RUN=1 answers with fake ids and success without calling Meta, and still checks permits", async () => {
    process.env.SPEND_DRY_RUN = "1";
    seedCampaign("c1");
    const client = adsClient("TOKEN", "act_111", guard);
    const permit = await permitForPausedCreate(T, "act_111", 2, adminSpend);
    expect(await client.createCampaign({ name: "S", status: "PAUSED" }, permit)).toMatch(/^dryrun_campaign_/);
    await expect(client.createCampaign({ name: "S", status: "ACTIVE" }, permit)).rejects.toMatchObject({ reason: "create_not_paused" });
    await failure(client.setStatus("m_c1a", "ACTIVE", undefined as never));
    const activation = await reserveAds(T, { kind: "activate", campaignId: "c1", sets: [{ adSetId: "c1s", metaAdSetId: "m_c1s" }] }, adminSpend, { idempotencyKey: "k_dry", reason: "Testing" });
    await client.setStatus("m_c1s", "ACTIVE", activation);
    await client.setStatus("m_c1", "PAUSED");
    expect(await client.findCampaignsByName("S")).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it("a sandbox ad account with SPEND_SIM=1 is faked too; a real account is not", async () => {
    process.env.SPEND_SIM = "1";
    const permit = await permitForPausedCreate(T, "act_111", 3, adminSpend);
    expect(await adsClient("TOKEN", "act_111", { ...guard, sandbox: true }).createCampaign({ name: "S", status: "PAUSED" }, permit)).toMatch(/^dryrun_/);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    await adsClient("TOKEN", "act_111", guard).createCampaign({ name: "S", status: "PAUSED" }, permit);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("reads objects and the ad account with GET only", async () => {
    const client = adsClient("TOKEN", "act_111", guard);
    await client.getObject("m_c1s", ["status", "daily_budget"]);
    await client.getAccount("currency,timezone_name");
    expect(meta.calls.map((c) => c.method)).toEqual(["GET", "GET"]);
    expect(fetchSpy.mock.calls.map((c) => new URL(String(c[0])).searchParams.get("fields"))).toEqual(["status,daily_budget", "currency,timezone_name"]);
  });
});

// =====================================================================================================================
describe("activateCampaign through the Spend Book", () => {
  const confirm = { confirm: true, confirmedTotalMinor: 100_000 };
  const activationRows = () => ledger((r) => r.action === "ads.campaign.activate");

  it("writes requested then applied, turns the objects on with the permit, and the commitment goes live", async () => {
    process.env.SPEND_TRIPWIRE = "enforce";
    seedCampaign("c1");
    const result = await activateCampaign(admin, "c1", confirm);
    expect(result.status).toBe("active");
    expect(activationRows().map((r) => r.phase)).toEqual(["requested", "applied"]);
    expect(new Set(activationRows().map((r) => r.correlationId)).size).toBe(1);
    expect(posts().map((c) => [c.path, c.body?.status])).toEqual([
      ["m_c1a", "ACTIVE"],
      ["m_c1s", "ACTIVE"],
      ["m_c1", "ACTIVE"],
    ]);
    expect(commitment("m_c1s")).toMatchObject({ status: "live", dailyBudgetMinor: INR(1_000) });
    expect(tripwire).toEqual([]);
    // Counted at the worst case: 1.75 x ₹1,000 today.
    expect((await headroom(T, "ads")).today.committed).toBe(INR(1_750));
  });

  it("an ambiguous 5xx on the final call gives unconfirmed, with the commitment still counted", async () => {
    seedCampaign("c1");
    meta.answer = unclear("m_c1");
    await expect(activateCampaign(admin, "c1", confirm)).rejects.toThrow(/did not confirm the activation/);
    expect(activationRows().map((r) => r.phase)).toEqual(["requested", "unconfirmed"]);
    expect(commitment("m_c1s")).toMatchObject({ status: "unconfirmed" });
    expect((await headroom(T, "ads")).today.committed).toBe(INR(1_750));
    expect(campaignRow("c1")).toMatchObject({ status: "active", lastError: expect.stringContaining("not confirmed") });
    // Nothing was paused back: it may be running.
    expect(posts().filter((c) => c.body?.status === "PAUSED")).toEqual([]);
  });

  it("a definite failure pauses what went ACTIVE (ledgered as a lowering), then settles failed and keeps the campaign paused", async () => {
    seedCampaign("c1");
    meta.answer = refused("m_c1s", "ACTIVE");
    await expect(activateCampaign(admin, "c1", confirm)).rejects.toThrow(/still paused/);
    expect(activationRows().map((r) => r.phase)).toEqual(["requested", "failed"]);
    expect(posts().map((c) => [c.path, c.body?.status])).toEqual([
      ["m_c1a", "ACTIVE"],
      ["m_c1s", "ACTIVE"],
      ["m_c1a", "PAUSED"],
    ]);
    expect(ledger((r) => r.action === "ads.ad.pause").map((r) => r.phase)).toEqual(["requested", "applied"]);
    expect(commitment("m_c1s")).toBeUndefined();
    expect(campaignRow("c1").status).toBe("paused");
    expect((await headroom(T, "ads")).today.committed).toBe(0n);
  });

  it("refuses over the limit with the room left, and sends nothing", async () => {
    h.db.reset();
    seedWorkspace({ daily: 1_500 });
    seedCampaign("c1");
    const error = (await failure(activateCampaign(admin, "c1", confirm))) as SpendBlockedError;
    expect(error.code).toBe("spend.daily_limit");
    expect(error.message).toBe("This would go over your ads limit for today. Left today: ₹1,500. This could spend up to ₹1,750 today, because Meta can spend up to 75% over a daily budget. Lower the daily budget or raise your limit.");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(campaignRow("c1").status).toBe("paused");
    expect(activationRows().map((r) => r.phase)).toEqual(["refused"]);
  });

  it("a stop that lands between two calls ends the activation before the next call, and pauses back what was turned on", async () => {
    seedCampaign("c1");
    meta.answer = (c) => {
      if (c.path === "m_c1a" && c.body?.status === "ACTIVE") freeze("all");
      return null;
    };
    await expect(activateCampaign(admin, "c1", confirm)).rejects.toThrow(/Spending is stopped/);
    expect(posts().map((c) => [c.path, c.body?.status])).toEqual([
      ["m_c1a", "ACTIVE"],
      ["m_c1a", "PAUSED"],
    ]);
    expect(activationRows().map((r) => r.phase)).toEqual(["requested", "failed"]);
    expect(campaignRow("c1").status).toBe("paused");
  });

  it("pausing works while all spending is stopped, and stops the commitment", async () => {
    seedRunning("c1");
    freeze("all");
    const result = await pauseCampaign(admin, "c1");
    expect(result.status).toBe("paused");
    expect(posts()).toEqual([{ method: "POST", path: "m_c1", body: { status: "PAUSED" } }]);
    expect(ledger((r) => r.action === "ads.campaign.pause").map((r) => r.phase)).toEqual(["requested", "applied"]);
    expect(commitment("m_c1s")).toBeUndefined();
    expect(tripwire).toEqual([]);
  });
});

// =====================================================================================================================
describe("single-object actions through the Spend Book", () => {
  it("resumeAd over the limit is refused, so the old gap is closed; within the limit it goes through", async () => {
    seedRunning("c1", 1_000);
    const { revertPayload } = await pauseAd(T, "m_c1a", adminSpend);
    // The owner lowers the daily limit below what the running ad set may spend today.
    rows("spendAllowance")[0].dailyLimitMinor = INR(1_500);
    meta.calls = [];
    const error = (await failure(resumeAd(T, "m_c1a", revertPayload, adminSpend))) as SpendBlockedError;
    expect(error.code).toBe("spend.daily_limit");
    expect(posts()).toEqual([]);
    expect(rows("ad").find((a) => a.id === "c1a")!.status).toBe("paused");
    expect(ledger((r) => r.action === "ads.ad.resume").map((r) => r.phase)).toEqual(["refused"]);
    rows("spendAllowance")[0].dailyLimitMinor = INR(5_000);
    await resumeAd(T, "m_c1a", revertPayload, adminSpend);
    expect(posts()).toEqual([{ method: "POST", path: "m_c1a", body: { status: "ACTIVE" } }]);
    expect(ledger((r) => r.action === "ads.ad.resume").map((r) => r.phase)).toEqual(["refused", "requested", "applied"]);
    expect(rows("ad").find((a) => a.id === "c1a")!.status).toBe("active");
  });

  it("a budget raise is reserved first and its refusal carries the exact room", async () => {
    h.db.reset();
    seedWorkspace({ daily: 3_000 });
    seedRunning("c1", 1_000);
    const error = (await failure(setAdSetBudget(T, "m_c1s", 200_000, adminSpend))) as SpendBlockedError;
    expect(error.code).toBe("spend.daily_limit");
    // Left today 3,000 - 1,750; the raise to ₹2,000 adds 3,500 - 1,750.
    expect(error.params.left).toEqual({ minor: INR(1_250), currency: "INR" });
    expect(error.params.needs).toEqual({ minor: INR(1_750), currency: "INR" });
    expect(fetchSpy).not.toHaveBeenCalled();
    // A raise that fits goes through: requested, the call, applied.
    await setAdSetBudget(T, "m_c1s", 120_000, adminSpend);
    expect(posts()).toEqual([{ method: "POST", path: "m_c1s", body: { daily_budget: 120000 } }]);
    expect(ledger((r) => r.action === "ads.adset.budget_raise").map((r) => r.phase)).toEqual(["refused", "requested", "applied"]);
    expect(commitment("m_c1s")).toMatchObject({ status: "live", dailyBudgetMinor: INR(1_200), peakDailyBudgetMinor: INR(1_200) });
    expect(rows("adSet").find((s) => s.id === "c1s")!.dailyBudgetMinor).toBe(120_000);
  });

  it("a cut is a lowering: it works while spending is stopped, and today's peak stays", async () => {
    seedRunning("c1", 1_000);
    freeze("all");
    const result = await setAdSetBudget(T, "m_c1s", 50_000, adminSpend);
    expect(result).toMatchObject({ appliedDailyBudgetMinor: 50_000, clamped: false, revertPayload: { dailyBudgetMinor: 100_000 } });
    expect(posts()).toEqual([{ method: "POST", path: "m_c1s", body: { daily_budget: 50000 } }]);
    expect(ledger((r) => r.action === "ads.adset.budget_cut").map((r) => r.phase)).toEqual(["requested", "applied"]);
    expect(commitment("m_c1s")).toMatchObject({ dailyBudgetMinor: INR(500), peakDailyBudgetMinor: INR(1_000) });
    expect(tripwire).toEqual([]);
    // A raise is refused while stopped.
    await expect(setAdSetBudget(T, "m_c1s", 60_000, adminSpend)).rejects.toThrow(/Spending is stopped/);
  });

  it("raise or cut is decided against the book, not a stale AdSet row: a 'cut' from a stale ₹5,000 to ₹4,000 over a ₹1,000 budget is a raise", async () => {
    seedRunning("c1", 1_000);
    // The owner lowered it to ₹1,000 in Ads Manager: the sync adopted that into the commitment, the row still says ₹5,000.
    rows("adSet").find((s) => s.id === "c1s")!.dailyBudgetMinor = 500_000;
    // ₹4,000 is a raise from ₹1,000: reserved against the ₹5,000 daily limit at 1.75x, so it does not fit.
    const error = (await failure(setAdSetBudget(T, "m_c1s", 400_000, adminSpend))) as SpendBlockedError;
    expect(error.code).toBe("spend.daily_limit");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ledger((r) => r.action === "ads.adset.budget_cut")).toEqual([]);
    expect(commitment("m_c1s")).toMatchObject({ dailyBudgetMinor: INR(1_000) });
    // Under a stop it is refused like any raise.
    freeze("all");
    await expect(setAdSetBudget(T, "m_c1s", 150_000, adminSpend)).rejects.toThrow(/Spending is stopped/);
    expect(fetchSpy).not.toHaveBeenCalled();
    // A real cut still goes ahead while stopped, and its undo restores what was really running.
    await expect(setAdSetBudget(T, "m_c1s", 80_000, adminSpend)).resolves.toMatchObject({ appliedDailyBudgetMinor: 80_000, revertPayload: { dailyBudgetMinor: 100_000 } });
  });

  it("the book refuses a 'cut' above the counted budget, and a cut permit never covers more than its cut", async () => {
    seedRunning("c1", 1_000);
    const run = vi.fn(async () => undefined);
    await expect(recordLowering(T, { kind: "cut_budget", metaObjectId: "m_c1s", toMinor: INR(4_000) }, adminSpend, "x", run)).rejects.toMatchObject({ status: 409 });
    await expect(recordLowering(T, { kind: "end_earlier", metaObjectId: "m_c1s", endsAt: new Date("2099-01-01") }, adminSpend, "x", run)).resolves.toMatchObject({ bookkeeping: "done" });
    commitment("m_c1s")!.endsAt = new Date("2026-11-05T00:00:00Z");
    await expect(recordLowering(T, { kind: "end_earlier", metaObjectId: "m_c1s", endsAt: new Date("2026-11-10T00:00:00Z") }, adminSpend, "x", run)).rejects.toMatchObject({ status: 409 });
    expect(run).toHaveBeenCalledTimes(1);
    // The permit recordLowering mints carries the cut: the client refuses a higher value before any fetch.
    const client = adsClient("TOKEN", "act_111", guard);
    await expect(
      recordLowering(T, { kind: "cut_budget", metaObjectId: "m_c1s", toMinor: INR(800) }, adminSpend, "x", (permit) => client.setDailyBudget("m_c1s", 90_000, permit)),
    ).rejects.toThrow(SpendGuardBypassError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the second half of a shift names the cut it follows, and the book counts the freed budget", async () => {
    h.db.reset();
    seedWorkspace({ daily: 3_500 });
    seedRunning("c1", 1_000);
    seedRunning("c2", 1_000);
    // 2 x 1,750 already fills ₹3,500: a raise of c2 alone does not fit.
    await expect(setAdSetBudget(T, "m_c2s", 120_000, adminSpend)).rejects.toThrow(/over your ads limit for today/);
    await setAdSetBudget(T, "m_c1s", 80_000, adminSpend);
    // c1's peak stays ₹1,000 today; counting it freed (back to ₹800) makes room: 1,400 + 2,100 = 3,500.
    await expect(setAdSetBudget(T, "m_c2s", 120_000, adminSpend)).rejects.toThrow(/over your ads limit for today/);
    await expect(setAdSetBudget(T, "m_c2s", 120_000, adminSpend, { shiftFromAdSetId: "m_c1s" })).resolves.toMatchObject({ appliedDailyBudgetMinor: 120_000 });
  });

  it("pausing an ad or an ad set works while stopped and is ledgered", async () => {
    seedRunning("c1", 1_000);
    freeze("all");
    await pauseAd(T, "m_c1a", adminSpend);
    await pauseAdSet(T, "m_c1s", { type: "breaker", kind: "efficiency" });
    expect(posts().map((c) => c.path)).toEqual(["m_c1a", "m_c1s"]);
    expect(ledger((r) => r.phase === "applied").map((r) => r.action)).toEqual(["ads.ad.pause", "ads.adset.pause"]);
    expect(commitment("m_c1s")).toBeUndefined();
    expect(ledger((r) => r.action === "ads.adset.pause")[0]).toMatchObject({ actorType: "breaker" });
  });
});

// =====================================================================================================================
describe("stopCommitments (4.8)", () => {
  const stopper: SpendActor = { type: "system", job: "tenant-state" };

  it("pauses whole campaigns at campaign level, one call each, and never touches the ad sets' budget quota", async () => {
    seedRunning("c1", 1_000);
    seedRunning("c2", 2_000);
    const r = await stopCommitments(T, { origin: "all" }, stopper, "Testing");
    expect(r).toMatchObject({ done: 2, failed: 0, unreachable: 0, skipped: 0, total: 2 });
    // Biggest first.
    expect(posts()).toEqual([
      { method: "POST", path: "m_c2", body: { status: "PAUSED" } },
      { method: "POST", path: "m_c1", body: { status: "PAUSED" } },
    ]);
    expect(rows("spendCommitment").every((c) => c.status === "stopped")).toBe(true);
    expect(["c1", "c2"].map((id) => campaignRow(id).status)).toEqual(["paused", "paused"]);
    expect(ledger((r) => r.action === "ads.campaign.pause" && r.phase === "applied")).toHaveLength(2);
    expect((await headroom(T, "ads")).today.committed).toBe(0n);
  });

  it("names: every ad set of a campaign pauses the campaign; some ad sets pause just those", async () => {
    seedCampaign("c1", { status: "active", sets: 2 });
    seedLive("c1", 1_000);
    seedLive("c1", 1_000, { metaObjectId: "m_c1s1", adSetId: "c1s1" });
    let r = await stopCommitments(T, { metaObjectIds: ["m_c1s1"] }, stopper, "Testing");
    expect(r.items.map((i) => [i.level, i.metaObjectId, i.result])).toEqual([["adset", "m_c1s1", "done"]]);
    expect(campaignRow("c1").status).toBe("active");
    expect(rows("adSet").find((s) => s.id === "c1s1")!.status).toBe("paused");
    r = await stopCommitments(T, { metaObjectIds: ["m_c1s", "m_c1s1"] }, stopper, "Testing");
    expect(r.items.map((i) => [i.level, i.metaObjectId])).toEqual([["campaign", "m_c1"]]);
    expect(posts().map((c) => c.path)).toEqual(["m_c1s1", "m_c1"]);
  });

  it("origin assistant pauses only what an assistant launched", async () => {
    seedRunning("c1", 1_000);
    seedRunning("c2", 1_000, { origin: "assistant" });
    const r = await stopCommitments(T, { origin: "assistant" }, stopper, "Testing");
    expect(r.items.map((i) => i.campaignId)).toEqual(["c2"]);
    expect(campaignRow("c1").status).toBe("active");
  });

  it("also pauses a campaign whose activation is still in flight (reserved, row still paused)", async () => {
    seedCampaign("c1");
    await reserveAds(T, { kind: "activate", campaignId: "c1", sets: [{ adSetId: "c1s", metaAdSetId: "m_c1s" }] }, adminSpend, { idempotencyKey: "k_fly", reason: "Testing" });
    const r = await stopCommitments(T, { origin: "all" }, stopper, "Testing");
    expect(r.items.map((i) => [i.level, i.metaObjectId, i.result])).toEqual([["campaign", "m_c1", "done"]]);
    expect(commitment("m_c1s")).toBeUndefined();
  });

  it("an unreachable ad account is not called; its objects stay counted as unconfirmed", async () => {
    seedRunning("c1", 1_000);
    connect.usable = false;
    const r = await stopCommitments(T, {}, stopper, "Testing");
    expect(r).toMatchObject({ done: 0, unreachable: 1, total: 1 });
    expect(r.items[0]).toMatchObject({ campaignName: "Campaign c1", result: "unreachable" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(commitment("m_c1s")).toMatchObject({ status: "unconfirmed" });
    expect((await headroom(T, "ads")).today.committed).toBe(INR(1_750));
    expect(campaignRow("c1").status).toBe("active");
  });

  it("a pause Meta refuses stays counted (unconfirmed), and the stop goes on to the next one", async () => {
    seedRunning("c1", 1_000);
    seedRunning("c2", 500);
    meta.answer = refused("m_c1");
    const r = await stopCommitments(T, {}, stopper, "Testing");
    expect(r).toMatchObject({ done: 1, failed: 1 });
    expect(commitment("m_c1s")).toMatchObject({ status: "unconfirmed" });
    expect(commitment("m_c2s")).toBeUndefined();
    expect(ledger((r) => r.action === "ads.campaign.pause").map((r) => r.phase).sort()).toEqual(["applied", "failed", "requested", "requested"]);
  });

  it("never throws: a database failure is one failure, and a missing filter means everything", async () => {
    seedRunning("c1", 1_000);
    h.db.failNext("spendCommitment", "findMany", new Error("db down"));
    await expect(stopCommitments(T, undefined as never, stopper, "")).resolves.toMatchObject({ done: 0, failed: 1 });
    await expect(stopCommitments(T, undefined as never, stopper, "")).resolves.toMatchObject({ done: 1 });
  });

  it("starts nothing after its deadline, and a recent failure waits for its retry", async () => {
    seedRunning("c1", 1_000);
    let r = await stopCommitments(T, {}, stopper, "Testing", { deadline: NOW.getTime() - 1 });
    expect(r).toMatchObject({ skipped: 1, total: 1, done: 0 });
    meta.answer = refused("m_c1");
    await stopCommitments(T, {}, stopper, "Testing");
    meta.answer = null;
    meta.calls = [];
    r = await stopCommitments(T, {}, stopper, "Testing", { retryFailedAfterMs: 15 * 60_000 });
    expect(r).toMatchObject({ skipped: 1, done: 0 });
    vi.setSystemTime(new Date(NOW.getTime() + 16 * 60_000));
    r = await stopCommitments(T, {}, stopper, "Testing", { retryFailedAfterMs: 15 * 60_000 });
    expect(r).toMatchObject({ done: 1 });
  });

  it("markUnpaused touches live commitments only (a reservation in flight settles itself) and never throws", async () => {
    seedLive("c1", 1_000);
    seedLive("c2", 1_000, { status: "reserved", reservedUntil: new Date(NOW.getTime() + 60_000) });
    expect(await markUnpaused(T, { metaObjectIds: ["m_c1s", "m_c2s"] })).toBe(1);
    expect(rows("spendCommitment").map((c) => c.status)).toEqual(["unconfirmed", "reserved"]);
    expect(await markUnpaused(T, {})).toBe(0);
    h.db.failNext("spendCommitment", "updateMany", new Error("db down"));
    await expect(markUnpaused(T, { campaignId: "c1" })).resolves.toBe(0);
  });
});

// =====================================================================================================================
describe("the kill switch's ads tasks (4.11, 4.16)", () => {
  const job = (o: Row = {}) => ({ tenantId: T, level: "all" as const, origin: "all" as const, reason: "Stopped all spending.", actor: { type: "user", userId: "u_owner", role: "owner" } as SpendActor, ...o });

  it("registers spend.stop and a 1-minute spend.kill.sweep in the spend worker module (also run by /api/internal/tick)", () => {
    expect(queues[SPEND_QUEUES.stop]).toBe(handleStopJob);
    expect(periodic).toEqual([expect.objectContaining({ name: KILL_SWEEP_TASK, everyMs: 60_000 })]);
    expect(KILL_SWEEP_EVERY_MS).toBe(60_000);
    expect(spendWorker.queues[SPEND_QUEUES.stop]).toBe(handleStopJob);
    expect(spendWorker.periodic.some((p) => p.name === "spend.kill.sweep" && p.everyMs === 60_000)).toBe(true);
  });

  it("the job pauses what the freeze in force covers: everything, assistant campaigns, or nothing once turned back on", async () => {
    seedRunning("c1", 1_000);
    seedRunning("c2", 1_000, { origin: "assistant" });
    expect(await runStop(job())).toMatchObject({ tenants: 0, done: 0 });
    freeze("assistants");
    expect(await runStop(job({ level: "assistants", origin: "assistant" }))).toMatchObject({ tenants: 1, done: 1, total: 1 });
    expect(campaignRow("c2").status).toBe("paused");
    expect(campaignRow("c1").status).toBe("active");
    freeze("all");
    expect(await runStop(job())).toMatchObject({ done: 1, total: 1 });
    expect(campaignRow("c1").status).toBe("paused");
    // The ledger says who stopped it.
    expect(ledger((r) => r.action === "ads.campaign.pause" && r.phase === "applied").map((r) => r.actorId)).toEqual(["u_owner", "u_owner"]);
  });

  it("the platform job ('*') visits every workspace with something running, most money at risk first", async () => {
    seedRunning("c1", 1_000);
    rows("platformSetting").push({ key: "spend:platform", value: { freeze: "all", reason: "Incident", byUserId: "u_support", at: NOW.toISOString(), version: 1 } });
    resetSpendStateCache();
    expect(await runStop(job({ tenantId: "*" }))).toMatchObject({ tenants: 1, done: 1 });
  });

  it("the inline stop reports 'Paused N of N' figures and leaves the rest when its budget runs out", async () => {
    seedRunning("c1", 1_000);
    seedRunning("c2", 1_000);
    freeze("all");
    expect(await stopInline(job(), 20_000)).toEqual({ paused: 2, total: 2, failed: 0 });
    seedRunning("c3", 1_000);
    expect(await stopInline(job(), 0)).toEqual({ paused: 0, total: 1, failed: 0 });
  });

  it("tells the owner which campaigns may still be running, and queues Meta's emergency limit only where it is managed", async () => {
    seedRunning("c1", 1_000);
    freeze("all");
    connect.usable = false;
    await runStop(job({ correlationId: "corr_1" }));
    expect(rows("notice")).toEqual([
      expect.objectContaining({
        tenantId: T,
        kind: "spending_stopped",
        audienceMinRole: "owner",
        payload: { title: "1 campaign could not be paused", body: "'Campaign c1' may still be running. Pause it in Meta Ads Manager, or reconnect Meta in Settings > Connections and we'll try again.", link: "/app/ads" },
      }),
    ]);
    expect(rows("job").filter((j) => j.queue === SPEND_QUEUES.metacapP0)).toEqual([]);
    // The same stuck campaign is not announced twice.
    await runStop(job({ correlationId: "corr_1" }));
    expect(rows("notice")).toHaveLength(1);
    process.env.SPEND_CAP_MODE = "enforce";
    h.db.seed("metaSpendLimit", [{ adAccountAssetId: "acc1", tenantId: T, accountExternalId: "act_111", mode: "managed", unitMode: "major_write", semantics: "cumulative", managedCapMinor: INR(60_000), lastReadCapMinor: INR(60_000), lastReadAmountSpentMinor: INR(10_000), lastReadAt: new Date(NOW.getTime() - 60_000), lastWriteAt: new Date(NOW.getTime() - 3_600_000), lastError: null }]);
    await runStop(job({ correlationId: "corr_2" }));
    expect(rows("job").filter((j) => j.queue === SPEND_QUEUES.metacapP0).map((j) => j.payload)).toEqual([{ tenantId: T, adAccountAssetId: "acc1", reason: "pause_failed", correlationId: "corr_2", failedObjectIds: ["m_c1"] }]);
  });

  it("the sweep pauses frozen workspaces' running campaigns and leaves the rest alone", async () => {
    seedRunning("c1", 1_000);
    expect(await killSweep()).toMatchObject({ candidates: 0, done: 0 });
    freeze("all");
    expect(await killSweep()).toMatchObject({ candidates: 1, tenants: 1, done: 1 });
    expect(campaignRow("c1").status).toBe("paused");
    // Nothing left: the next run costs reads only.
    meta.calls = [];
    expect(await killSweep()).toMatchObject({ candidates: 0 });
    expect(meta.calls).toEqual([]);
  });

  it("the sweep retries a failed pause after 15 minutes, not every minute", async () => {
    seedRunning("c1", 1_000);
    freeze("all");
    meta.answer = refused("m_c1");
    expect(await killSweep()).toMatchObject({ failed: 1 });
    meta.answer = null;
    expect(await killSweep()).toMatchObject({ skipped: 1, done: 0 });
    vi.setSystemTime(new Date(NOW.getTime() + 16 * 60_000));
    expect(await killSweep()).toMatchObject({ done: 1 });
  });

  it("drops a malformed job instead of retrying it, and accepts a well-formed one", async () => {
    expect(parseStopJob(null)).toBeNull();
    expect(parseStopJob({ tenantId: T, level: "none" })).toBeNull();
    expect(parseStopJob({ tenantId: "", level: "all" })).toBeNull();
    expect(parseStopJob({ tenantId: T, level: "all", actor: { type: "hacker" } })).toMatchObject({ actor: { type: "system", job: "spend.stop" }, origin: "all" });
    await expect(handleStopJob({ nonsense: true }, {} as never)).resolves.toBeUndefined();
    seedRunning("c1", 1_000);
    freeze("all");
    await handleStopJob(job(), {} as never);
    expect(campaignRow("c1").status).toBe("paused");
  });
});
