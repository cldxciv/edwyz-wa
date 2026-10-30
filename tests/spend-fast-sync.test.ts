import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSpendDb, Row } from "./helpers/fake-spend-db";
import { createFakeMeta, type FakeMeta } from "./helpers/fake-meta";

/*
 * spend.sync.fast (docs/SPEND-CONTROLS-SPEC.md 6.1) against fake Meta: account rows (origin all) per account day for this
 * month, ad set rows (origin platform) for the open commitments today plus yesterday until 03:00 account time,
 * IntradaySpendSample rows, external = account - platform, the 30-minute rate-limit backoff, the skips (sandbox, demo, 409),
 * the structure sync in the same pass, and spend.breakers.run afterwards. Reads only: no write is ever sent.
 */

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSpendDb,
  fetchImpl: null as null | ((input: string | URL | Request, init?: RequestInit) => Promise<Response>),
  jobs: [] as unknown[][],
  access: vi.fn(),
}));

vi.mock("@/lib/db", async () => {
  const { createFakeSpendDb } = await import("./helpers/fake-spend-db");
  h.db = createFakeSpendDb();
  return { prisma: h.db.prisma };
});
vi.mock("@/lib/queue", () => ({
  enqueue: async (...args: unknown[]) => {
    h.jobs.push(args);
    return {};
  },
}));
vi.mock("@/lib/meta-connect", () => ({ getAssetAccess: (...a: unknown[]) => h.access(...a) }));

import { setTripwireAuditSink } from "@/lib/spend/tripwire";
import { FAST_SYNC_EVERY_MS, fastSyncTenants, runFastSync, setSpendDaily, spendMinorOf, SYNC_BACKOFF_MS, syncTenantFast } from "@/lib/spend/sync/fast-insights";
import { periodic as syncPeriodic, queues as syncQueues } from "@/lib/spend/tasks/sync";
import type { SpendNotice } from "@/lib/spend/types";

// Wednesday 28 Oct 2026, 12:00 in Asia/Kolkata.
const NOW = new Date("2026-10-28T06:30:00Z");
const T = "t1";
const INR = (rupees: number) => BigInt(Math.round(rupees * 100));

let meta: FakeMeta;
let notices: SpendNotice[];
const rows = (name: string) => h.db.rows(name);
const daily = (origin?: string, scopeType?: string) => rows("spendDaily").filter((r) => (!origin || r.origin === origin) && (!scopeType || r.scopeType === scopeType));
const dayOf = (r: Row) => (r.day as Date).toISOString().slice(0, 10);
const io = (over: Record<string, unknown> = {}) => ({ notify: async (n: SpendNotice) => void notices.push(n), ...over });

function at(d: Date) {
  vi.setSystemTime(d);
  meta.setNow(d);
}

function seed(o: { sandbox?: boolean; demo?: boolean; commitment?: boolean; campaignLevel?: boolean } = {}) {
  h.db.seed("tenant", [{ id: T, name: "Shop", slug: "shop", status: "active", deletedAt: null }]);
  h.db.seed("metaAsset", [{ id: "acc1", tenantId: T, connectionId: "mc1", type: "ad_account", externalId: "act_111", name: "Shop ads", status: "active", meta: { currency: "INR", timezone: "Asia/Kolkata", ...(o.demo ? { demo: true } : {}) }, sandbox: o.sandbox ?? false }]);
  h.db.seed("spendControl", [{ tenantId: T, probation: "lifted", spendingAdAccountAssetId: "acc1", timezone: "Asia/Kolkata" }]);
  h.db.seed("adCampaign", [{ id: "c1", tenantId: T, adAccountAssetId: "acc1", metaCampaignId: "m_c1", name: "Diwali", status: "active", dailyBudgetMinor: 100_000, currency: "INR", origin: "human", endsAt: null, lifetimeBudgetMinor: null, sandbox: false, updatedAt: NOW }]);
  h.db.seed("adSet", [{ id: "c1s", tenantId: T, campaignId: "c1", metaAdSetId: "m_s1", name: "Set", status: "active", targeting: {}, dailyBudgetMinor: 100_000 }]);
  if (o.commitment !== false) {
    h.db.seed("spendCommitment", [
      {
        id: "cm1",
        tenantId: T,
        adAccountAssetId: "acc1",
        campaignId: "c1",
        adSetId: o.campaignLevel ? null : "c1s",
        metaObjectId: o.campaignLevel ? "m_c1" : "m_s1",
        objectLevel: o.campaignLevel ? "campaign" : "adset",
        origin: "human",
        currency: "INR",
        timezone: "Asia/Kolkata",
        dailyBudgetMinor: INR(1_000),
        peakDailyBudgetMinor: INR(1_000),
        weekPeakDailyBudgetMinor: INR(1_000),
        status: "live",
        updatedAt: NOW,
      },
    ]);
  }
}

/** Fake Meta: the Edwyz campaign and ad set, and an outside campaign on the same account. */
function seedMeta() {
  meta.addCampaign({ id: "m_c1", status: "ACTIVE" });
  meta.addAdSet({ id: "m_s1", campaignId: "m_c1", status: "ACTIVE", dailyBudgetMinor: INR(1_000) });
  meta.addCampaign({ id: "m_x", status: "ACTIVE" });
  meta.addAdSet({ id: "m_xs", campaignId: "m_x", status: "ACTIVE", dailyBudgetMinor: INR(1_000) });
  meta.addAdSet({ id: "m_quiet", campaignId: "m_c1", status: "PAUSED", dailyBudgetMinor: INR(500) });
}

beforeEach(() => {
  h.db.reset();
  h.jobs = [];
  notices = [];
  h.access.mockReset();
  h.access.mockImplementation(async (_t: string, assetId: string) => ({ assetId, type: "ad_account", externalId: "act_111", name: "Shop ads", token: "tok-ads" }));
  vi.useFakeTimers({ toFake: ["Date"] });
  meta = createFakeMeta({ now: new Date("2026-10-27T06:30:00Z"), accountId: "act_111" });
  vi.setSystemTime(NOW);
  h.fetchImpl = meta.fetch;
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => h.fetchImpl!(input, init));
  process.env.SPEND_TRIPWIRE = "enforce";
  setTripwireAuditSink(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.SPEND_TRIPWIRE;
  setTripwireAuditSink(null);
});

describe("spend.sync.fast (6.1)", () => {
  it("writes account rows (origin all) per account day, ad set rows (origin platform) for today, samples, and external = account - platform", async () => {
    seed();
    seedMeta();
    // Yesterday: ₹400 on the outside campaign only. Today: ₹300 on Edwyz's ad set, ₹200 outside.
    meta.spend("m_xs", INR(400), new Date("2026-10-27T06:30:00Z"));
    at(NOW);
    meta.spend("m_s1", INR(300));
    meta.spend("m_xs", INR(200));
    const r = await syncTenantFast(T, io());
    expect(r.status).toBe("synced");
    const all = daily("all", "account");
    expect(all.map((x) => [dayOf(x), x.amountMinor, x.scopeId, x.source])).toEqual(
      expect.arrayContaining([
        ["2026-10-27", INR(400), "acc1", "fast_sync"],
        ["2026-10-28", INR(500), "acc1", "fast_sync"],
      ]),
    );
    const platform = daily("platform", "adset");
    expect(platform.find((x) => x.scopeId === "m_s1")).toMatchObject({ amountMinor: INR(300), currency: "INR", source: "fast_sync" });
    expect(dayOf(platform.find((x) => x.scopeId === "m_s1")!)).toBe("2026-10-28");
    const external = daily("external", "account");
    expect(external.map((x) => [dayOf(x), x.amountMinor])).toEqual(expect.arrayContaining([["2026-10-28", INR(200)], ["2026-10-27", INR(400)]]));
    const samples = rows("intradaySpendSample");
    expect(samples.map((s) => [s.entityType, s.entityMetaId, s.spendMinor])).toEqual(expect.arrayContaining([["account", "acc1", INR(500)], ["adset", "m_s1", INR(300)]]));
    // The breakers run right after the sync.
    expect(h.jobs).toContainEqual(["spend.breakers.run", { tenantId: T, reason: "fast_sync" }]);
    // Reads only.
    expect(meta.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("asks for exactly the open commitments' ad sets, today only after 03:00 account time", async () => {
    seed();
    seedMeta();
    await syncTenantFast(T, io());
    const adsetReads = meta.calls.filter((c) => c.path === "act_111/insights" && c.params.level === "adset");
    expect(adsetReads).toHaveLength(1);
    expect(JSON.parse(String(adsetReads[0].params.filtering))).toEqual([{ field: "adset.id", operator: "IN", value: ["m_s1"] }]);
    expect(adsetReads[0].params).toMatchObject({ date_preset: "today" });
    expect(String(adsetReads[0].params.fields)).toBe("adset_id,campaign_id,spend,impressions,clicks,cpm,ctr,actions");
    const accountRead = meta.calls.find((c) => c.path === "act_111/insights" && c.params.level === "account")!;
    expect(accountRead.params).toMatchObject({ time_increment: "1", date_preset: "this_month", fields: "spend" });
  });

  it("also reads yesterday until 03:00 account time, so late spend lands on the right day", async () => {
    seed();
    seedMeta();
    // 02:30 on 29 Oct in Asia/Kolkata.
    const late = new Date("2026-10-28T21:00:00Z");
    at(new Date("2026-10-28T12:00:00Z"));
    meta.spend("m_s1", INR(700));
    at(late);
    await syncTenantFast(T, io({ now: late }));
    const presets = meta.calls.filter((c) => c.params.level === "adset").map((c) => c.params.date_preset);
    expect(presets).toEqual(["today", "yesterday"]);
    const s1 = daily("platform", "adset").filter((x) => x.scopeId === "m_s1");
    expect(s1.map((x) => [dayOf(x), x.amountMinor])).toEqual(expect.arrayContaining([["2026-10-28", INR(700)], ["2026-10-29", 0n]]));
  });

  it("records 0 for an ad set with no spend today, so the book knows the data is fresh; SpendDaily is SET, never added", async () => {
    seed();
    seedMeta();
    await syncTenantFast(T, io());
    expect(daily("platform", "adset").find((x) => x.scopeId === "m_s1")).toMatchObject({ amountMinor: 0n });
    meta.spend("m_s1", INR(250));
    await syncTenantFast(T, io());
    await syncTenantFast(T, io());
    expect(daily("platform", "adset").filter((x) => x.scopeId === "m_s1")).toHaveLength(1);
    expect(daily("platform", "adset").find((x) => x.scopeId === "m_s1")!.amountMinor).toBe(INR(250));
  });

  it("reads a campaign-budget commitment at campaign level", async () => {
    seed({ campaignLevel: true });
    seedMeta();
    meta.addCampaign({ id: "m_c2", status: "ACTIVE", dailyBudgetMinor: INR(2_000) });
    meta.object("m_c1").dailyBudgetMinor = INR(2_000);
    meta.spend("m_c1", INR(120));
    await syncTenantFast(T, io());
    const read = meta.calls.find((c) => c.params.level === "campaign")!;
    expect(JSON.parse(String(read.params.filtering))).toEqual([{ field: "campaign.id", operator: "IN", value: ["m_c1"] }]);
    expect(daily("platform", "campaign").find((x) => x.scopeId === "m_c1")!.amountMinor).toBe(INR(120));
  });

  it("a rate limit backs the workspace off for 30 minutes (spend:sync:<tenantId>)", async () => {
    seed();
    seedMeta();
    h.fetchImpl = async () => new Response(JSON.stringify({ error: { message: "(#613) Calls to this api have exceeded the rate limit.", code: 613 } }), { status: 400 });
    expect((await syncTenantFast(T, io())).status).toBe("rate_limited");
    const state = rows("platformSetting").find((s) => s.key === "spend:sync:t1")!.value as { backoffUntil: string };
    expect(Date.parse(state.backoffUntil)).toBe(NOW.getTime() + SYNC_BACKOFF_MS);
    h.fetchImpl = meta.fetch;
    expect((await syncTenantFast(T, io({ now: new Date(NOW.getTime() + 10 * 60_000) }))).status).toBe("backoff");
    expect(meta.calls).toHaveLength(0);
    expect((await syncTenantFast(T, io({ now: new Date(NOW.getTime() + 31 * 60_000) }))).status).toBe("synced");
  });

  it("skips sandbox accounts (SPEND_SIM writes their series) and demo assets: no Graph call", async () => {
    seed({ sandbox: true });
    expect((await syncTenantFast(T, io())).accounts[0].status).toBe("sandbox");
    h.db.reset();
    seed({ demo: true });
    expect((await syncTenantFast(T, io())).accounts[0].status).toBe("demo");
    expect(meta.calls).toHaveLength(0);
    expect(h.access).not.toHaveBeenCalled();
  });

  it("a 409 from getAssetAccess is not silent: meta_cap_unreachable opens while commitments are live, and nothing is written", async () => {
    seed();
    const { HttpError } = await import("@/lib/tenancy");
    h.access.mockRejectedValue(new HttpError(409, "expired"));
    const r = await syncTenantFast(T, io());
    expect(r.accounts[0].status).toBe("unreachable");
    expect(rows("spendBreaker").find((b) => b.kind === "meta_cap_unreachable")).toMatchObject({ state: "tripped", scopeType: "ad_account", scopeId: "acc1" });
    expect(notices.some((n) => n.title === "Connect Meta again")).toBe(true);
    expect(rows("spendDaily")).toHaveLength(0);
    // Connected again: the next sync reads, and the breaker clears.
    h.access.mockImplementation(async (_t: string, assetId: string) => ({ assetId, type: "ad_account", externalId: "act_111", name: "Shop ads", token: "tok-ads" }));
    seedMeta();
    expect((await syncTenantFast(T, io())).accounts[0].status).toBe("synced");
    expect(rows("spendBreaker").find((b) => b.kind === "meta_cap_unreachable")!.state).toBe("cleared");
  });

  it("covers workspaces with an open commitment or a managed Meta limit; runs the structure sync in the same pass", async () => {
    seed();
    seedMeta();
    h.db.seed("tenant", [{ id: "t2", name: "Other", slug: "t2", status: "active" }]);
    h.db.seed("metaSpendLimit", [{ adAccountAssetId: "acc_t3", tenantId: "t3", accountExternalId: "act_3", mode: "managed" }]);
    h.db.seed("metaSpendLimit", [{ adAccountAssetId: "acc_t4", tenantId: "t4", accountExternalId: "act_4", mode: "pending_owner" }]);
    expect((await fastSyncTenants()).sort()).toEqual(["t1", "t3"]);
    await runFastSync(io());
    const paths = meta.calls.map((c) => `${c.path}:${String(c.params.level ?? "")}`);
    expect(paths.indexOf("act_111/campaigns:")).toBeGreaterThan(paths.indexOf("act_111/insights:adset"));
    expect(paths).toContain("act_111/adsets:");
  });

  it("converts spend without a 32-bit clamp and refuses unreadable spend instead of counting it as zero", async () => {
    expect(spendMinorOf({ spend: "99999999999.99" }, "INR")).toBe(9_999_999_999_999n);
    expect(spendMinorOf({ spend: "12345" }, "JPY")).toBe(12_345n);
    expect(() => spendMinorOf({ spend: "1e5" }, "INR")).toThrow();
    await setSpendDaily([{ tenantId: T, scopeType: "adset", scopeId: "x", day: "not-a-day", currency: "INR", amountMinor: 1n, origin: "platform", source: "insights" }], NOW);
    expect(rows("spendDaily")).toHaveLength(0);
  });

  it("is a periodic worker task every 15 minutes, with the 2-hour structure sync next to it", () => {
    expect(syncQueues).toEqual({});
    expect(syncPeriodic.map((p) => [p.name, p.everyMs])).toEqual([
      ["spend.sync.fast", FAST_SYNC_EVERY_MS],
      ["spend.sync.structure", 2 * 3_600_000],
    ]);
    expect(FAST_SYNC_EVERY_MS).toBe(15 * 60_000);
  });
});
