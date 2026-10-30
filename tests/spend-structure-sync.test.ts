import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSpendDb, Row } from "./helpers/fake-spend-db";
import { createFakeMeta, type FakeMeta } from "./helpers/fake-meta";

/*
 * spend.sync.structure (docs/SPEND-CONTROLS-SPEC.md 4.6.1) against fake Meta: every row of the table, adopted into the book
 * and ledgered as ads.external_change (actor external, phase reconciled); two reads per account; no write calls; an
 * assistant campaign whose end date is removed keeps a month-end horizon that passes the CHECK constraints of 0009.
 */

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSpendDb,
  fetchImpl: null as null | ((input: string | URL | Request, init?: RequestInit) => Promise<Response>),
}));

vi.mock("@/lib/db", async () => {
  const { createFakeSpendDb } = await import("./helpers/fake-spend-db");
  h.db = createFakeSpendDb();
  return { prisma: h.db.prisma };
});
vi.mock("@/lib/meta-connect", () => ({ getAssetAccess: async (_t: string, assetId: string) => ({ assetId, type: "ad_account", externalId: "act_111", name: "Shop ads", token: "tok" }) }));

import { ceil175, ceil210 } from "@/lib/spend/commitments";
import { setTripwireAuditSink } from "@/lib/spend/tripwire";
import { ADSET_FIELDS, CAMPAIGN_FIELDS, monthEndHorizon, runStructureSync, sharedDaily, syncStructure } from "@/lib/spend/sync/structure";
import type { SpendNotice } from "@/lib/spend/types";

// Wednesday 28 Oct 2026, 12:00 in Asia/Kolkata.
const NOW = new Date("2026-10-28T06:30:00Z");
const T = "t1";
const TZ = "Asia/Kolkata";
const INR = (rupees: number) => BigInt(Math.round(rupees * 100));
const OCT_END = new Date("2026-10-31T18:29:59Z");
const NOV14 = new Date("2026-11-14T18:29:59Z");

let meta: FakeMeta;
let notices: SpendNotice[];
const rows = (name: string) => h.db.rows(name);
const commitments = () => rows("spendCommitment");
const open = () => commitments().filter((c) => c.status !== "stopped");
const changes = () => rows("spendLedger").filter((r) => r.action === "ads.external_change");
const campaign = () => rows("adCampaign").find((c) => c.id === "c1")!;
const io = () => ({ notify: async (n: SpendNotice) => void notices.push(n) });

/** The CHECK constraints of 0009 on SpendCommitment and AdCampaign. */
function assertChecks() {
  for (const c of commitments()) {
    expect(c.dailyBudgetMinor !== null && c.dailyBudgetMinor !== undefined ? true : c.lifetimeBudgetMinor !== null && c.lifetimeBudgetMinor !== undefined).toBe(true);
    if (c.origin === "assistant") expect(c.endsAt instanceof Date || (c.lifetimeBudgetMinor ?? null) !== null).toBe(true);
    expect(["human", "assistant", "api"]).toContain(c.origin);
    expect(["campaign", "adset"]).toContain(c.objectLevel);
    expect(["reserved", "live", "unconfirmed", "stopped"]).toContain(c.status);
  }
  for (const c of rows("adCampaign")) if (c.origin === "assistant") expect(c.endsAt instanceof Date || (c.lifetimeBudgetMinor ?? null) !== null).toBe(true);
}

function seed(o: { status?: string; origin?: string; endsAt?: Date | null; commitment?: Row | null; adSetBudget?: number } = {}) {
  h.db.seed("tenant", [{ id: T, name: "Shop", slug: "shop", status: "active" }]);
  h.db.seed("metaAsset", [{ id: "acc1", tenantId: T, connectionId: "mc1", type: "ad_account", externalId: "act_111", name: "Shop ads", status: "active", meta: { currency: "INR", timezone: TZ }, sandbox: false }]);
  h.db.seed("spendControl", [{ tenantId: T, probation: "lifted", spendingAdAccountAssetId: "acc1", timezone: TZ }]);
  h.db.seed("adCampaign", [
    { id: "c1", tenantId: T, adAccountAssetId: "acc1", metaCampaignId: "m_c1", name: "Diwali", status: o.status ?? "active", dailyBudgetMinor: (o.adSetBudget ?? 800) * 100, currency: "INR", origin: o.origin ?? "human", assistantKey: o.origin === "assistant" ? "ads_launcher" : null, endsAt: o.endsAt ?? null, lifetimeBudgetMinor: null, startsAt: null, sandbox: false, updatedAt: new Date("2026-10-20") },
  ]);
  h.db.seed("adSet", [{ id: "c1s", tenantId: T, campaignId: "c1", metaAdSetId: "m_s1", name: "Set", status: "active", targeting: {}, dailyBudgetMinor: (o.adSetBudget ?? 800) * 100 }]);
  if (o.commitment !== null) {
    h.db.seed("spendCommitment", [
      {
        id: "cm1",
        tenantId: T,
        adAccountAssetId: "acc1",
        campaignId: "c1",
        adSetId: "c1s",
        metaObjectId: "m_s1",
        objectLevel: "adset",
        origin: o.origin ?? "human",
        assistantKey: o.origin === "assistant" ? "ads_launcher" : null,
        currency: "INR",
        timezone: TZ,
        dailyBudgetMinor: INR(o.adSetBudget ?? 800),
        dayKey: new Date("2026-10-28T00:00:00Z"),
        dayStartBudgetMinor: INR(o.adSetBudget ?? 800),
        peakDailyBudgetMinor: INR(o.adSetBudget ?? 800),
        weekStart: new Date("2026-10-25T00:00:00Z"),
        weekPeakDailyBudgetMinor: INR(o.adSetBudget ?? 800),
        endsAt: o.endsAt ?? null,
        status: "live",
        ...(o.commitment ?? {}),
      },
    ]);
  }
}

function metaObjects(o: { campaign?: string; adset?: string; budget?: number; end?: Date | null } = {}) {
  meta.addCampaign({ id: "m_c1", status: (o.campaign ?? "ACTIVE") as "ACTIVE" });
  meta.addAdSet({ id: "m_s1", campaignId: "m_c1", status: (o.adset ?? "ACTIVE") as "ACTIVE", dailyBudgetMinor: INR(o.budget ?? 800), endTime: o.end ?? null });
}

beforeEach(() => {
  h.db.reset();
  notices = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  meta = createFakeMeta({ now: NOW, accountId: "act_111" });
  h.fetchImpl = meta.fetch;
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => h.fetchImpl!(input, init));
  process.env.SPEND_TRIPWIRE = "enforce";
  setTripwireAuditSink(() => undefined);
});

afterEach(() => {
  // Every case: reads only, and the 0009 CHECKs hold.
  expect(meta.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  assertChecks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.SPEND_TRIPWIRE;
  setTripwireAuditSink(null);
});

describe("structure sync (4.6.1)", () => {
  it("makes two reads per account with the 4.6.1 filters and field lists", async () => {
    seed();
    metaObjects();
    const r = await syncStructure(T, "acc1", io());
    expect(r.reads).toBe(2);
    const [c, s] = meta.calls;
    expect(c).toMatchObject({ method: "GET", path: "act_111/campaigns" });
    expect(JSON.parse(String(c.params.filtering))).toEqual([{ field: "id", operator: "IN", value: ["m_c1"] }]);
    expect(c.params.fields).toBe(CAMPAIGN_FIELDS);
    expect(s).toMatchObject({ method: "GET", path: "act_111/adsets" });
    expect(JSON.parse(String(s.params.filtering))).toEqual([{ field: "campaign.id", operator: "IN", value: ["m_c1"] }]);
    expect(s.params.fields).toBe(ADSET_FIELDS);
    expect(r.changes).toEqual([]);
  });

  it("ACTIVE on Meta with no open commitment: a live commitment at the observed budget, the campaign active, a notice", async () => {
    seed({ status: "paused", commitment: null });
    metaObjects({ budget: 1_200 });
    await syncStructure(T, "acc1", io());
    expect(open()).toEqual([expect.objectContaining({ metaObjectId: "m_s1", objectLevel: "adset", adSetId: "c1s", origin: "human", status: "live", dailyBudgetMinor: INR(1_200), peakDailyBudgetMinor: INR(1_200) })]);
    expect(campaign().status).toBe("active");
    expect(changes()[0]).toMatchObject({ phase: "reconciled", actorType: "external", actorId: "meta_ads_manager", reasonCodes: ["turned_on"] });
    expect(notices.map((n) => n.body)).toContain("Diwali was turned on in Meta Ads Manager. It now counts against your limits.");
  });

  it("a stopped commitment and an ACTIVE object: counted again", async () => {
    seed({ commitment: { status: "stopped" } });
    metaObjects();
    await syncStructure(T, "acc1", io());
    expect(open()).toHaveLength(1);
  });

  it("a higher budget raises D, today's peak and the week's peak, with the budget notice", async () => {
    seed();
    metaObjects({ budget: 1_500 });
    await syncStructure(T, "acc1", io());
    expect(open()[0]).toMatchObject({ dailyBudgetMinor: INR(1_500), peakDailyBudgetMinor: INR(1_500), weekPeakDailyBudgetMinor: INR(1_500) });
    expect(changes()[0]).toMatchObject({ reasonCodes: ["budget_up"], before: { dailyBudgetMinor: INR(800).toString(), lifetimeBudgetMinor: null }, after: { dailyBudgetMinor: INR(1_500).toString(), lifetimeBudgetMinor: null } });
    expect(notices.map((n) => n.body)).toContain("The daily budget of Diwali was changed in Meta Ads Manager from ₹800 to ₹1,500.");
  });

  it("a lower budget lowers D but keeps today's peak (Meta's 175% rule), with no notice", async () => {
    seed({ adSetBudget: 1_500 });
    metaObjects({ budget: 800 });
    await syncStructure(T, "acc1", io());
    expect(open()[0]).toMatchObject({ dailyBudgetMinor: INR(800), peakDailyBudgetMinor: INR(1_500) });
    expect(changes()[0].reasonCodes).toEqual(["budget_down"]);
    expect(notices).toHaveLength(0);
  });

  it.each([["PAUSED"], ["ARCHIVED"], ["DELETED"]])("an ad set %s on Meta stops its commitment, as recordLowering would", async (status) => {
    seed();
    metaObjects({ adset: status });
    await syncStructure(T, "acc1", io());
    expect(open()).toHaveLength(0);
    expect(commitments()[0].status).toBe("stopped");
    expect(changes()[0].reasonCodes).toEqual(["stopped"]);
    expect(notices).toHaveLength(0);
  });

  it("a paused campaign stops its ad sets and the DB campaign follows", async () => {
    seed();
    metaObjects({ campaign: "PAUSED" });
    await syncStructure(T, "acc1", io());
    expect(open()).toHaveLength(0);
    expect(campaign().status).toBe("paused");
  });

  it("an ad set Edwyz did not create, under a platform campaign: a live commitment with origin human, in the budget notice", async () => {
    seed({ origin: "assistant", endsAt: NOV14 });
    metaObjects({ end: NOV14 });
    meta.addAdSet({ id: "m_s2", campaignId: "m_c1", status: "ACTIVE", dailyBudgetMinor: INR(500) });
    await syncStructure(T, "acc1", io());
    expect(open().find((c) => c.metaObjectId === "m_s2")).toMatchObject({ origin: "human", adSetId: null, dailyBudgetMinor: INR(500), status: "live" });
    expect(notices.map((n) => n.body)).toContain("Diwali got a new ad set in Meta Ads Manager with a daily budget of ₹500. It now counts against your limits.");
  });

  it("budget moved to campaign level: the ad set commitments stop and one campaign-level commitment takes over", async () => {
    seed();
    meta.addCampaign({ id: "m_c1", status: "ACTIVE", dailyBudgetMinor: INR(2_000) });
    meta.addAdSet({ id: "m_s1", campaignId: "m_c1", status: "ACTIVE" });
    await syncStructure(T, "acc1", io());
    expect(commitments().find((c) => c.metaObjectId === "m_s1")!.status).toBe("stopped");
    expect(open()).toEqual([expect.objectContaining({ metaObjectId: "m_c1", objectLevel: "campaign", adSetId: null, dailyBudgetMinor: INR(2_000), status: "live" })]);
    expect(notices.map((n) => n.body)).toContain("Budget settings of Diwali were changed in Meta Ads Manager.");
  });

  it("budget sharing turned on: one campaign-level commitment counted at 2.1x (8.4x a week)", async () => {
    seed();
    metaObjects({ budget: 1_000 });
    meta.addAdSet({ id: "m_s2", campaignId: "m_c1", status: "ACTIVE", dailyBudgetMinor: INR(500) });
    h.fetchImpl = async (input, init) => {
      const res = await meta.fetch(input, init);
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (!url.pathname.endsWith("/act_111/campaigns")) return res;
      const body = (await res.json()) as { data: Record<string, unknown>[] };
      body.data = body.data.map((c) => ({ ...c, is_adset_budget_sharing_enabled: true }));
      return new Response(JSON.stringify(body), { status: 200 });
    };
    await syncStructure(T, "acc1", io());
    const cc = open().find((c) => c.objectLevel === "campaign")!;
    expect(cc.dailyBudgetMinor).toBe(sharedDaily(INR(1_500)));
    expect(ceil175(cc.dailyBudgetMinor as bigint)).toBe(ceil210(INR(1_500)));
    expect(7n * (cc.dailyBudgetMinor as bigint)).toBe((84n * INR(1_500)) / 10n);
    expect(open().filter((c) => c.objectLevel === "adset")).toHaveLength(0);
  });

  it("a person's campaign whose end date was removed takes no end (counted to month end); moved later takes the new end", async () => {
    seed({ endsAt: NOV14 });
    metaObjects({ end: null });
    await syncStructure(T, "acc1", io());
    expect(open()[0].endsAt).toBeNull();
    expect(campaign().endsAt).toBeNull();
    expect(changes()[0].reasonCodes).toEqual(["end_removed"]);
    expect(rows("spendBreaker")).toHaveLength(0);
    const later = new Date("2026-11-30T18:29:59Z");
    meta.object("m_s1").endTime = later;
    await syncStructure(T, "acc1", io());
    expect(open()[0].endsAt).toEqual(later);
  });

  it("an assistant campaign whose end date was removed keeps a month-end horizon (CHECKs hold) and gets external_edit", async () => {
    seed({ origin: "assistant", endsAt: NOV14 });
    metaObjects({ end: null });
    await syncStructure(T, "acc1", io());
    expect(monthEndHorizon(NOW, TZ)).toEqual(OCT_END);
    expect(open()[0]).toMatchObject({ origin: "assistant", endsAt: OCT_END });
    expect(campaign().endsAt).toEqual(OCT_END);
    expect(rows("spendBreaker").find((b) => b.kind === "external_edit")).toMatchObject({ state: "tripped", scopeType: "campaign", scopeId: "c1", effect: "block_raises" });
    expect(notices.map((n) => n.body)).toContain("Diwali no longer has an end date. Your ad assistant won't change it until you set one.");
    const recorded = changes().length;

    // The next month: the horizon rolls forward silently.
    const NOV2 = new Date("2026-11-02T06:30:00Z");
    vi.setSystemTime(NOV2);
    meta.setNow(NOV2);
    await syncStructure(T, "acc1", { ...io(), now: NOV2 });
    expect(open()[0].endsAt).toEqual(new Date("2026-11-30T18:29:59Z"));
    expect(changes()).toHaveLength(recorded);
    expect(rows("spendBreaker").filter((b) => b.kind === "external_edit" && b.state === "tripped")).toHaveLength(1);

    // The owner sets an end date again: the breaker clears.
    meta.object("m_s1").endTime = new Date("2026-11-20T18:29:59Z");
    await syncStructure(T, "acc1", { ...io(), now: NOV2 });
    expect(open()[0].endsAt).toEqual(new Date("2026-11-20T18:29:59Z"));
    expect(rows("spendBreaker").find((b) => b.kind === "external_edit")!.state).toBe("cleared");
  });

  it("an assistant campaign whose end date moved later gets external_edit too; archiving clears it", async () => {
    seed({ origin: "assistant", endsAt: NOV14 });
    metaObjects({ end: new Date("2026-12-31T18:29:59Z") });
    await syncStructure(T, "acc1", io());
    expect(open()[0].endsAt).toEqual(new Date("2026-12-31T18:29:59Z"));
    expect(rows("spendBreaker").find((b) => b.kind === "external_edit")).toMatchObject({ state: "tripped", details: { why: "later" } });
    meta.object("m_c1").status = "ARCHIVED";
    await syncStructure(T, "acc1", io());
    expect(rows("spendBreaker").find((b) => b.kind === "external_edit")!.state).toBe("cleared");
    expect(campaign().status).toBe("archived");
  });

  it("an end date moved earlier is adopted without a notice", async () => {
    seed({ endsAt: NOV14 });
    metaObjects({ end: new Date("2026-11-05T18:29:59Z") });
    await syncStructure(T, "acc1", io());
    expect(open()[0].endsAt).toEqual(new Date("2026-11-05T18:29:59Z"));
    expect(changes()[0].reasonCodes).toEqual(["end_earlier"]);
    expect(notices).toHaveLength(0);
  });

  it("a campaign missing from Meta's answer stays counted (the safe direction); campaigns made in Ads Manager are not synced", async () => {
    seed();
    meta.addCampaign({ id: "m_own", status: "ACTIVE", dailyBudgetMinor: INR(9_000) });
    await syncStructure(T, "acc1", io());
    expect(open()).toHaveLength(1);
    expect(open()[0].metaObjectId).toBe("m_s1");
  });

  it("a reserved commitment (an activation in flight) is never stopped because Meta still shows it paused", async () => {
    seed({ commitment: { status: "reserved", reservedUntil: new Date(NOW.getTime() + 5 * 60_000) } });
    metaObjects({ adset: "PAUSED" });
    await syncStructure(T, "acc1", io());
    expect(commitments()[0].status).toBe("reserved");
  });

  it("the 2-hour pass covers workspaces with platform campaigns but no open commitment; demo and sandbox accounts are skipped", async () => {
    seed({ commitment: null, status: "paused" });
    metaObjects();
    const out = await runStructureSync(io());
    expect(out).toHaveLength(1);
    expect(open()).toHaveLength(1);
    h.db.reset();
    meta.calls.length = 0;
    seed({ commitment: null });
    rows("metaAsset")[0].meta = { currency: "INR", timezone: TZ, demo: true };
    expect((await syncStructure(T, "acc1", io())).reason).toBe("demo");
    rows("metaAsset")[0].meta = { currency: "INR", timezone: TZ };
    rows("metaAsset")[0].sandbox = true;
    expect((await syncStructure(T, "acc1", io())).reason).toBe("sandbox");
    expect(meta.calls).toHaveLength(0);
  });
});
