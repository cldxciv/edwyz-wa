import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSpendDb, Row } from "./helpers/fake-spend-db";

/**
 * Edits for people (docs/IG-PAGE-ADS-SPEC.md 3.9, 4.8, D25, D28, D29; PRM-05 acceptance 3, 4, 5, 6 and 8): discard and restore,
 * Make a copy (a local draft, never Meta's copy edge), Fix the ad (replacesAdIds), and the end date and budget changes, which
 * keep their Phase 0 contracts. The real Spend Book and Graph transport run over the in-memory spend database; only fetch
 * (Meta), the Meta connection, client approvals and the plan check are stand-ins. Nothing reaches the network.
 */

const h = vi.hoisted(() => ({ db: null as unknown as FakeSpendDb, ids: 0 }));
vi.mock("@/lib/db", async () => {
  const { createFakeSpendDb } = await import("./helpers/fake-spend-db");
  h.db = createFakeSpendDb();
  return { prisma: h.db.prisma };
});
/** `second` connects a second ad account (acc2); `race` runs once inside the next listAssets call, as a request landing mid-check would. */
const account = vi.hoisted(() => ({ zone: "Asia/Kolkata" as string | null, second: false, race: null as null | (() => Promise<unknown>) }));
vi.mock("@/lib/meta-connect", () => ({
  getAssetAccess: async (_tenantId: string, assetId: string) => ({ assetId, type: "ad_account", externalId: "act_111", name: "Shop ads", token: "TOKEN" }),
  listAssets: async (_tenantId: string, type?: string) => {
    const race = account.race;
    account.race = null;
    if (race) await race();
    const zone = account.zone ? { timezone: account.zone } : {};
    if (type === "ad_account")
      return [
        { id: "acc1", type: "ad_account", externalId: "act_111", name: "Shop ads", status: "active", meta: { currency: "INR", ...zone } },
        ...(account.second ? [{ id: "acc2", type: "ad_account", externalId: "act_222", name: "Second ads", status: "active", meta: { currency: "INR", ...zone } }] : []),
      ];
    if (type === "page") return [{ id: "pg1", type: "page", externalId: "page1", name: "Shop", status: "active", meta: {} }];
    return [];
  },
}));
vi.mock("@/lib/approvals", () => ({ listApprovals: async () => [], isCampaignClientApproved: async () => false, expireDecidedApprovals: async () => 0 }));
/**
 * The plan check: off unless `limit` is set. Then it is the rule of billing/limits assertAdAccountAllowed (an account that
 * already carries a campaign is never counted again; only a new one is checked) over the REAL usedAdAccountIds, which reads
 * the in-memory database. (The real plan lookup goes through billing status and is covered by tests/billing-limits.test.ts.)
 */
const plan = vi.hoisted(() => ({ limit: null as number | null }));
vi.mock("@/lib/billing/limits", async () => {
  const actual = await vi.importActual<typeof import("@/lib/billing/limits")>("@/lib/billing/limits");
  const { HttpError } = await import("@/lib/tenancy");
  return {
    usedAdAccountIds: actual.usedAdAccountIds,
    assertAdAccountAllowed: async (tenantId: string, assetId: string) => {
      if (plan.limit === null) return;
      const used = await actual.usedAdAccountIds(tenantId);
      if (used.has(assetId) || used.size < plan.limit) return;
      throw new HttpError(402, `Your plan allows up to ${plan.limit} ad accounts (${used.size} in use). Upgrade your plan at /app/billing.`);
    },
    adAccountsBlockedByPlan: async () => new Set(),
  };
});
const auth = vi.hoisted(() => ({ getActor: vi.fn() }));
vi.mock("@/lib/auth", () => auth);

import { readReplacesAdIds } from "@/lib/ads/draft-input";
import {
  changeCampaignBudget,
  changeCampaignEnd,
  createCampaignDraft,
  discardDraft,
  DRAFT_DISCARDED,
  DRAFT_RESTORE_MS,
  duplicateCampaign,
  getCampaignView,
  launchCampaign,
  listCampaigns,
  parseDraftInput,
  restoreDraft,
  SOURCE_POST_UNKNOWN,
  updateCampaignDraft,
} from "@/lib/ads/service";
import { usedAdAccountIds } from "@/lib/billing/limits";
import { resetBookForTests } from "@/lib/spend/book";
import { SpendBlockedError } from "@/lib/spend/errors";
import { resetSpendStateCache } from "@/lib/spend/kill";
import { setTripwireAuditSink } from "@/lib/spend/tripwire";

// Wednesday 28 Oct 2026, 12:00 in Asia/Kolkata.
const NOW = new Date("2026-10-28T06:30:00Z");
const T = "t1";
const INR = (rupees: number) => BigInt(rupees * 100);
const admin = { userId: "u_admin", tenantId: T, role: "admin" as const };
const agent = { userId: "u_agent", tenantId: T, role: "agent" as const };
const minutes = (m: number) => new Date(NOW.getTime() + m * 60_000);
const days = (d: number) => new Date(NOW.getTime() + d * 86_400_000);

// ===== Fake Meta behind the real transport =====

type Call = { method: string; path: string; body: Row | undefined };
const meta = { calls: [] as Call[] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
  const u = new URL(String(url));
  const call: Call = { method: init?.method ?? "GET", path: u.pathname.split("/").slice(2).join("/"), body: init?.body ? (JSON.parse(String(init.body)) as Row) : undefined };
  meta.calls.push(call);
  if (call.method === "POST" && /\/(campaigns|adsets|adcreatives|ads)$/.test(call.path)) return json({ id: `new_${meta.calls.length}` });
  return json(call.method === "GET" ? { id: call.path } : { success: true });
});
const posts = () => meta.calls.filter((c) => c.method === "POST");

// ===== Database =====

const rows = (name: string) => h.db.rows(name);
const ledger = (filter: (r: Row) => boolean = () => true) => rows("spendLedger").filter(filter);
const campaignRow = (id: string) => rows("adCampaign").find((r) => r.id === id)!;
const control = () => rows("spendControl").find((r) => r.tenantId === T)!;
const audits = () => rows("auditLog").map((r) => r.action);

function seedWorkspace(o: { daily?: number } = {}) {
  h.db.seed("tenant", [{ id: T, name: "Shop", slug: "shop", status: "active", billingExempt: false }]);
  h.db.seed("metaAsset", [{ id: "acc1", tenantId: T, connectionId: "mc1", type: "ad_account", externalId: "act_111", name: "Shop ads", status: "active", meta: { currency: "INR", timezone: "Asia/Kolkata" }, sandbox: false, createdAt: new Date("2026-01-01") }]);
  h.db.seed("spendControl", [{ tenantId: T, probation: "lifted", spendingAdAccountAssetId: "acc1", timezone: "Asia/Kolkata" }]);
  h.db.seed("spendAllowance", [{ id: "sa1", tenantId: T, pot: "ads", currency: "INR", dailyLimitMinor: INR(o.daily ?? 5_000), monthlyLimitMinor: INR(50_000) }]);
}

const baseCampaign = (id: string, o: Row = {}): Row => ({
  id,
  tenantId: T,
  adAccountAssetId: "acc1",
  metaCampaignId: null,
  name: `Campaign ${id}`,
  template: "traffic",
  objective: "OUTCOME_TRAFFIC",
  status: "draft",
  dailyBudgetMinor: 100_000,
  currency: "INR",
  startsAt: null,
  endsAt: null,
  specialAdCategory: "none",
  origin: "human",
  assistantKey: null,
  lifetimeBudgetMinor: null,
  targetCostPerResultMinor: null,
  sandbox: false,
  lastError: null,
  surface: "wizard",
  goal: null,
  sourceKind: null,
  sourceRef: null,
  sourcePostTargetId: null,
  placementMode: "auto",
  runDays: null,
  startMode: null,
  reviewState: null,
  discardedAt: null,
  launchedAt: null,
  createdAt: new Date("2026-10-01"),
  updatedAt: new Date("2026-10-01"),
  ...o,
});
const creative = (over: Row = {}): Row => ({ pageId: "page1", message: "Hello", link: "https://example.com", imageUrl: "https://example.com/a.png", ...over });

/** A draft that is not on Meta: one ad set, one ad. */
function seedDraft(id: string, o: { campaign?: Row; creative?: Row } = {}) {
  h.db.seed("adCampaign", [baseCampaign(id, o.campaign)]);
  h.db.seed("adSet", [{ id: `${id}s`, tenantId: T, campaignId: id, metaAdSetId: null, name: `Set ${id}`, status: "draft", targeting: { geo: { countries: ["IN"], cities: [] } }, dailyBudgetMinor: 100_000, lifetimeBudgetMinor: null, variantKey: null, createdAt: new Date("2026-10-01") }]);
  h.db.seed("ad", [{ id: `${id}a`, tenantId: T, adSetId: `${id}s`, metaAdId: null, name: `Ad ${id}`, status: "draft", creativeAssetId: null, creative: creative(o.creative), format: "single_image", mediaIds: [], createdAt: new Date("2026-10-01") }]);
}

/** A launched campaign with Meta ids m_<id> (campaign), m_<id>s (ad set) and m_<id>a (ad), and its live commitment when active. */
function seedLaunched(id: string, o: { status?: string; rupees?: number; campaign?: Row; extraAd?: boolean } = {}) {
  const status = o.status ?? "active";
  const rupees = o.rupees ?? 1_000;
  h.db.seed("adCampaign", [baseCampaign(id, { metaCampaignId: `m_${id}`, status, dailyBudgetMinor: rupees * 100, launchedAt: new Date("2026-10-02"), ...o.campaign })]);
  h.db.seed("adSet", [{ id: `${id}s`, tenantId: T, campaignId: id, metaAdSetId: `m_${id}s`, name: `Set ${id}`, status, targeting: { geo: { countries: ["IN"], cities: [] } }, dailyBudgetMinor: rupees * 100, lifetimeBudgetMinor: null, variantKey: null, createdAt: new Date("2026-10-01") }]);
  const ad = (adId: string, msg: string) => ({
    id: adId,
    tenantId: T,
    adSetId: `${id}s`,
    metaAdId: `m_${adId}`,
    name: `Ad ${adId}`,
    status,
    creativeAssetId: null,
    creative: creative({ message: msg, metaCreativeId: `cr_${adId}`, categoryTermsAck: true, metaReview: { state: "rejected", metaStatus: "DISAPPROVED", reasons: ["No"], checkedAt: "2026-10-27T00:00:00Z" } }),
    format: "single_image",
    mediaIds: [],
    createdAt: new Date("2026-10-01"),
  });
  h.db.seed("ad", [ad(`${id}a`, "Hello"), ...(o.extraAd ? [ad(`${id}x`, "Second")] : [])]);
  if (status === "active") {
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
      },
    ]);
  }
}

function freeze(level: "all" | "none") {
  Object.assign(control(), level === "all" ? { freeze: "all", frozenByKind: "owner", frozenAt: NOW, frozenReason: "Testing" } : { freeze: "none", frozenByKind: null, frozenAt: null, frozenReason: null });
  resetSpendStateCache();
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
  const findMany = campaigns.findMany as (a: Row) => Promise<Row[]>;
  campaigns.findMany = async (args: Row) => {
    const list = await findMany(args);
    if (!(args?.include as Row | undefined)?.adSets) return list;
    return list.map((c) => ({ ...c, adSets: rows("adSet").filter((s) => s.campaignId === c.id).map((s) => ({ dailyBudgetMinor: s.dailyBudgetMinor, _count: { ads: rows("ad").filter((a) => a.adSetId === s.id).length } })) }));
  };
  const ads = p.ad;
  const updateMany = ads.updateMany as (a: Row) => Promise<{ count: number }>;
  ads.updateMany = async (args: Row) => {
    const { adSet, ...where } = (args.where ?? {}) as Row;
    if (!adSet) return updateMany(args);
    const setIds = rows("adSet").filter((s) => s.campaignId === (adSet as Row).campaignId).map((s) => s.id);
    return updateMany({ ...args, where: { ...where, adSetId: { in: setIds } } });
  };
  for (const [model, prefix] of [["adCampaign", "copy"], ["adSet", "set"], ["ad", "ad"], ["adTest", "test"]] as const) {
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
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
  setTripwireAuditSink(() => undefined);
  account.zone = "Asia/Kolkata";
  account.second = false;
  account.race = null;
  plan.limit = null;
  auth.getActor.mockReset();
  process.env.SPEND_ENFORCE = "enforce";
  delete process.env.SPEND_TRIPWIRE;
  delete process.env.SPEND_DRY_RUN;
  seedWorkspace();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setTripwireAuditSink(null);
  delete process.env.SPEND_ENFORCE;
});

const draftBody = (over: Row = {}): Row => ({
  name: "Spring",
  template: "traffic",
  adAccountAssetId: "acc1",
  dailyBudgetMinor: 50_000,
  specialAdCategory: "none",
  targeting: { geo: { countries: ["IN"], cities: [] } },
  ads: [{ name: "Only", creative: creative({ message: "New words" }) }],
  ...over,
});

describe("discard and restore (4.8 discard_promotion_draft)", () => {
  it("discard sets discardedAt and hides the draft; it can't be started, edited or copied; restore within 15 minutes brings it back", async () => {
    seedDraft("d1");
    seedDraft("d2", { campaign: { surface: "promote", endsAt: days(7) } });
    const out = await discardDraft(admin, "d1");
    expect(out).toEqual({ campaignId: "d1", discardedAt: NOW, restorableUntil: minutes(15) });
    expect(campaignRow("d1").discardedAt).toEqual(NOW);
    expect((await listCampaigns(T)).map((c) => c.id)).toEqual(["d2"]);
    // The list says where each campaign was made, what it is for (the old wizard's from its template) and Meta's review.
    expect((await listCampaigns(T))[0]).toMatchObject({ id: "d2", surface: "promote", goal: "website_visits", reviewState: null, adCount: 1, totalDailyBudgetMinor: 100_000 });
    // Twice changes nothing.
    vi.setSystemTime(minutes(1));
    expect(await discardDraft(admin, "d1")).toEqual(out);
    expect(audits().filter((a) => a === "ads.campaign.draft_discarded")).toHaveLength(1);
    // While discarded: no launch, no edit, no copy, and nothing reaches Meta.
    await expect(launchCampaign(admin, "d1")).rejects.toMatchObject({ status: 409, message: DRAFT_DISCARDED });
    await expect(updateCampaignDraft(admin, "d1", draftBody())).rejects.toMatchObject({ status: 409, message: DRAFT_DISCARDED });
    await expect(duplicateCampaign(admin, "d1")).rejects.toMatchObject({ status: 409 });
    expect((await getCampaignView(T, "d1")).editable).toBe(false);
    // Restored 14 minutes later.
    vi.setSystemTime(minutes(14));
    expect(await restoreDraft(admin, "d1")).toEqual({ campaignId: "d1", restored: true });
    expect(campaignRow("d1").discardedAt).toBeNull();
    expect((await listCampaigns(T)).map((c) => c.id).sort()).toEqual(["d1", "d2"]);
    expect(await restoreDraft(admin, "d1")).toEqual({ campaignId: "d1", restored: false });
    expect(audits()).toEqual(expect.arrayContaining(["ads.campaign.draft_discarded", "ads.campaign.draft_restored"]));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("restore works up to 15 minutes, not after: the draft then stays discarded", async () => {
    seedDraft("d1");
    seedDraft("d2");
    await discardDraft(admin, "d1");
    await discardDraft(admin, "d2");
    expect(DRAFT_RESTORE_MS).toBe(15 * 60_000);
    await expect(restoreDraft(admin, "d1", minutes(15))).resolves.toMatchObject({ restored: true });
    await expect(restoreDraft(admin, "d2", new Date(minutes(15).getTime() + 1_000))).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/more than 15 minutes ago/) });
    expect(campaignRow("d2").discardedAt).toEqual(NOW);
  });

  it("a discard that lands while a launch is being checked wins: the launch claims nothing and sends nothing to Meta", async () => {
    seedDraft("d1");
    // The launch loads the draft, then reads the ad account's zone: the discard lands right there, before the claim.
    account.race = () => discardDraft(admin, "d1");
    await expect(launchCampaign(admin, "d1")).rejects.toMatchObject({ status: 409, message: DRAFT_DISCARDED });
    expect(campaignRow("d1")).toMatchObject({ status: "draft", discardedAt: NOW, metaCampaignId: null });
    expect(audits()).not.toContain("ads.campaign.launch_started");
    expect(fetchSpy).not.toHaveBeenCalled();
    // Restored, it launches as usual.
    await restoreDraft(admin, "d1");
    await expect(launchCampaign(admin, "d1")).resolves.toMatchObject({ status: "paused", metaCampaignId: expect.any(String) });
  });

  it("a discard that lands while an edit is being checked wins too: the edit is refused and the draft is left as it was", async () => {
    seedDraft("d1");
    account.race = () => discardDraft(admin, "d1");
    await expect(updateCampaignDraft(admin, "d1", draftBody({ name: "Renamed" }))).rejects.toMatchObject({ status: 409, message: DRAFT_DISCARDED });
    expect(campaignRow("d1")).toMatchObject({ name: "Campaign d1", discardedAt: NOW });
    expect(rows("ad").filter((a) => a.adSetId === "d1s").map((a) => (a.creative as Row).message)).toEqual(["Hello"]);
  });

  it("a discarded draft stops holding its ad account against the plan, and restoring it asks the plan again", async () => {
    plan.limit = 1;
    account.second = true;
    seedDraft("d1");
    const onSecond = () => createCampaignDraft(admin, parseDraftInput(draftBody({ adAccountAssetId: "acc2" })));
    // d1 holds the plan's only ad account (acc1), so a first draft on acc2 is refused.
    await expect(onSecond()).rejects.toMatchObject({ status: 402 });
    await discardDraft(admin, "d1");
    expect([...(await usedAdAccountIds(T))]).toEqual([]);
    const { campaignId } = await onSecond();
    expect(campaignRow(campaignId)).toMatchObject({ adAccountAssetId: "acc2", status: "draft" });
    expect([...(await usedAdAccountIds(T))]).toEqual(["acc2"]);
    // acc2 now holds the only place: d1 can't come back on acc1, and stays discarded.
    await expect(restoreDraft(admin, "d1", minutes(5))).rejects.toMatchObject({ status: 402, message: expect.stringMatching(/Upgrade your plan/) });
    expect(campaignRow("d1").discardedAt).toEqual(NOW);
    // Once acc2's draft is discarded too, the place is free again and d1 comes back.
    await discardDraft(admin, campaignId);
    await expect(restoreDraft(admin, "d1", minutes(6))).resolves.toEqual({ campaignId: "d1", restored: true });
    expect([...(await usedAdAccountIds(T))]).toEqual(["acc1"]);
  });

  it("discard refuses a campaign already on Meta (pause or archive it instead), works on any surface, and not for agents", async () => {
    seedLaunched("c1", { status: "paused" });
    await expect(discardDraft(admin, "c1")).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/isn't on Meta yet/) });
    // A failed launch that already made a creative on Meta is on Meta too.
    seedDraft("e1", { campaign: { status: "error" }, creative: { metaCreativeId: "cr_1" } });
    await expect(discardDraft(admin, "e1")).rejects.toMatchObject({ status: 409 });
    // A failed launch that made nothing, and drafts of the new flows and Eddy, can go.
    seedDraft("e2", { campaign: { status: "error" } });
    seedDraft("p1", { campaign: { surface: "promote", endsAt: days(7) } });
    seedDraft("y1", { campaign: { surface: "eddy", endsAt: days(7) } });
    for (const id of ["e2", "p1", "y1"]) await expect(discardDraft(admin, id)).resolves.toMatchObject({ campaignId: id });
    seedDraft("d1");
    await expect(discardDraft(agent, "d1")).rejects.toMatchObject({ status: 403 });
    await expect(restoreDraft(agent, "e2")).rejects.toMatchObject({ status: 403 });
    expect(campaignRow("d1").discardedAt).toBeNull();
    expect(campaignRow("c1").discardedAt).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("Make a copy (3.9, D25): a local draft, never a copy on Meta", () => {
  it("duplicate creates a local draft of a running campaign and makes zero Meta calls", async () => {
    seedLaunched("c1", { campaign: { endsAt: days(10) } });
    const before = ledger().length;
    const out = await duplicateCampaign(admin, "c1");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(meta.calls).toEqual([]);
    expect(ledger()).toHaveLength(before);
    expect(out).toEqual({ campaignId: expect.any(String), replacesAdIds: [] });
    const copy = campaignRow(out.campaignId);
    expect(copy).toMatchObject({ name: "Copy of Campaign c1", status: "draft", template: "traffic", dailyBudgetMinor: 100_000, currency: "INR", origin: "human", createdByUserId: "u_admin", surface: "wizard", endsAt: days(10), startsAt: null });
    expect(copy.metaCampaignId ?? null).toBeNull();
    expect(copy.launchedAt ?? null).toBeNull();
    const sets = rows("adSet").filter((s) => s.campaignId === out.campaignId);
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ name: "Set c1", dailyBudgetMinor: 100_000, targeting: { geo: { countries: ["IN"], cities: [] } } });
    expect(sets[0].metaAdSetId ?? null).toBeNull();
    const ads = rows("ad").filter((a) => a.adSetId === sets[0].id);
    expect(ads).toHaveLength(1);
    expect(ads[0].metaAdId ?? null).toBeNull();
    // What belonged to the original on Meta stays behind: its creative id, Meta's review and the acknowledgement.
    expect(ads[0].creative).toEqual(creative({ message: "Hello" }));
    // The original is untouched, and the copy is an editable draft.
    expect(campaignRow("c1")).toMatchObject({ status: "active", metaCampaignId: "m_c1" });
    expect((await getCampaignView(T, out.campaignId)).editable).toBe(true);
    expect(rows("auditLog").find((r) => r.action === "ads.campaign.duplicated")).toMatchObject({ target: out.campaignId, meta: { from: "c1", fix: false } });
  });

  it("a copy keeps the run length from today, so it never loses its end date", async () => {
    // A promotion that ran 7 days and ended: the copy runs 7 days from today, ending Tue 3 Nov at 23:59 in Kolkata.
    seedLaunched("p1", { status: "paused", campaign: { surface: "promote", goal: "website_visits", runDays: 7, startMode: "now", endsAt: days(-1) } });
    const p = campaignRow((await duplicateCampaign(admin, "p1")).campaignId);
    expect(p).toMatchObject({ surface: "promote", goal: "website_visits", runDays: 7, startMode: "now", startsAt: null, endsAt: new Date("2026-11-03T18:29:00Z") });
    // An old-wizard campaign that ran 5 days and ended: 5 days from today.
    seedLaunched("w1", { status: "paused", campaign: { startsAt: days(-6), endsAt: days(-1) } });
    expect(campaignRow((await duplicateCampaign(admin, "w1")).campaignId)).toMatchObject({ startsAt: null, endsAt: new Date("2026-11-01T18:29:00Z"), runDays: null });
    // A start still ahead is kept.
    seedDraft("d1", { campaign: { startsAt: days(3), endsAt: days(9) } });
    expect(campaignRow((await duplicateCampaign(admin, "d1")).campaignId)).toMatchObject({ startsAt: days(3), endsAt: days(9) });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the copy of a fair test is a fair test again", async () => {
    seedDraft("v1", { campaign: { surface: "promote", endsAt: days(7) } });
    rows("adSet")[0].variantKey = "A";
    h.db.seed("adSet", [{ id: "v1s2", tenantId: T, campaignId: "v1", metaAdSetId: null, name: "Version B", status: "draft", targeting: {}, dailyBudgetMinor: 100_000, variantKey: "B", createdAt: new Date("2026-10-01") }]);
    h.db.seed("ad", [{ id: "v1b", tenantId: T, adSetId: "v1s2", metaAdId: null, name: "B", status: "draft", creative: creative(), variantLabel: "B", createdAt: new Date("2026-10-01") }]);
    h.db.seed("adTest", [{ id: "t_v1", tenantId: T, campaignId: "v1", kind: "creative", mode: "fair_split", status: "draft", winnerAdSetId: null }]);
    const out = await duplicateCampaign(admin, "v1");
    expect(rows("adSet").filter((s) => s.campaignId === out.campaignId).map((s) => s.variantKey)).toEqual(["A", "B"]);
    expect(rows("ad").find((a) => a.name === "B" && a.id !== "v1b")).toMatchObject({ variantLabel: "B" });
    expect(rows("adTest").filter((t) => t.campaignId === out.campaignId)).toEqual([expect.objectContaining({ mode: "fair_split", status: "draft" })]);
  });
});

describe("Fix the ad (D29): the copy records which ads it replaces", () => {
  it("fixOf records replacesAdIds on each copied ad, so starting the copy can pause the original first", async () => {
    seedLaunched("c1", { extraAd: true });
    const all = await duplicateCampaign(admin, "c1", { fixOf: true });
    expect(all.replacesAdIds).toEqual(["c1a", "c1x"]);
    const copied = rows("ad").filter((a) => rows("adSet").find((s) => s.id === a.adSetId)?.campaignId === all.campaignId);
    expect(copied.map((a) => [a.name, readReplacesAdIds(a.creative)])).toEqual([
      ["Ad c1a", ["c1a"]],
      ["Ad c1x", ["c1x"]],
    ]);
    // One ad named: only that ad is copied. The healthy ad keeps running in the original alone, so it never holds room in
    // the limits twice or bids against itself.
    const one = await duplicateCampaign(admin, "c1", { fixOf: "c1x" });
    expect(one.replacesAdIds).toEqual(["c1x"]);
    const oneAds = rows("ad").filter((a) => rows("adSet").find((s) => s.id === a.adSetId)?.campaignId === one.campaignId);
    expect(oneAds.map((a) => [a.name, readReplacesAdIds(a.creative)])).toEqual([["Ad c1x", ["c1x"]]]);
    expect(rows("auditLog").filter((r) => r.action === "ads.campaign.duplicated").map((r) => (r.meta as Row).fix)).toEqual([true, true]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fixing one version of a fair test copies that version alone: its ad set and budget, and no test", async () => {
    seedLaunched("v1", { status: "paused", rupees: 100, campaign: { surface: "promote", goal: "website_visits", endsAt: days(7), dailyBudgetMinor: 20_000 } });
    Object.assign(rows("adSet")[0], { name: "Version A", variantKey: "A" });
    h.db.seed("adSet", [{ id: "v1s2", tenantId: T, campaignId: "v1", metaAdSetId: "m_v1s2", name: "Version B", status: "paused", targeting: { geo: { countries: ["IN"], cities: [] } }, dailyBudgetMinor: 10_000, lifetimeBudgetMinor: null, variantKey: "B", createdAt: new Date("2026-10-01") }]);
    h.db.seed("ad", [{ id: "v1b", tenantId: T, adSetId: "v1s2", metaAdId: "m_v1b", name: "Ad v1b", status: "paused", creativeAssetId: null, creative: creative({ message: "Offer B", metaCreativeId: "cr_v1b" }), format: "single_image", mediaIds: [], variantLabel: "B", createdAt: new Date("2026-10-01") }]);
    h.db.seed("adTest", [{ id: "t_v1", tenantId: T, campaignId: "v1", kind: "creative", mode: "fair_split", status: "running", winnerAdSetId: null }]);
    const out = await duplicateCampaign(admin, "v1", { fixOf: ["v1b"] });
    expect(out.replacesAdIds).toEqual(["v1b"]);
    const sets = rows("adSet").filter((s) => s.campaignId === out.campaignId);
    expect(sets.map((s) => [s.name, s.variantKey, s.dailyBudgetMinor])).toEqual([["Version B", "B", 10_000]]);
    expect(rows("ad").filter((a) => a.adSetId === sets[0].id).map((a) => [(a.creative as Row).message, readReplacesAdIds(a.creative)])).toEqual([["Offer B", ["v1b"]]]);
    // One version left is no comparison; the copy's daily total is the budget of what it keeps.
    expect(rows("adTest").filter((t) => t.campaignId === out.campaignId)).toEqual([]);
    expect(campaignRow(out.campaignId).dailyBudgetMinor).toBe(10_000);
    // [Make a copy] still copies both versions and the test.
    const whole = await duplicateCampaign(admin, "v1");
    expect(rows("adSet").filter((s) => s.campaignId === whole.campaignId).map((s) => s.variantKey)).toEqual(["A", "B"]);
    expect(rows("adTest").filter((t) => t.campaignId === whole.campaignId)).toHaveLength(1);
    expect(campaignRow(whole.campaignId).dailyBudgetMinor).toBe(20_000);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an archived ad is neither copied nor named as replaced, and can't be fixed on its own", async () => {
    seedLaunched("c1", { extraAd: true });
    rows("ad").find((a) => a.id === "c1x")!.status = "archived";
    const out = await duplicateCampaign(admin, "c1", { fixOf: true });
    expect(out.replacesAdIds).toEqual(["c1a"]);
    const copied = rows("ad").filter((a) => rows("adSet").find((s) => s.id === a.adSetId)?.campaignId === out.campaignId);
    expect(copied.map((a) => [a.name, readReplacesAdIds(a.creative)])).toEqual([["Ad c1a", ["c1a"]]]);
    await expect(duplicateCampaign(admin, "c1", { fixOf: "c1x" })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/archived/) });
    await expect(duplicateCampaign(admin, "c1", { fixOf: ["c1a", "c1x"] })).rejects.toMatchObject({ status: 409 });
    expect(rows("adCampaign")).toHaveLength(2);
  });

  it("refuses an ad of another campaign, a malformed id, and fixing a draft that is not on Meta", async () => {
    seedLaunched("c1");
    seedLaunched("c2");
    seedDraft("d1");
    await expect(duplicateCampaign(admin, "c1", { fixOf: ["c2a"] })).rejects.toMatchObject({ status: 400, message: "That ad isn't part of this campaign." });
    await expect(duplicateCampaign(admin, "c1", { fixOf: "not an id" })).rejects.toMatchObject({ status: 400 });
    await expect(duplicateCampaign(admin, "d1", { fixOf: true })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Only an ad that is on Meta/) });
    await expect(duplicateCampaign(admin, "d1", { fixOf: "d1a" })).rejects.toMatchObject({ status: 409 });
    await expect(duplicateCampaign(agent, "c1")).rejects.toMatchObject({ status: 403 });
    await expect(duplicateCampaign(admin, "nope")).rejects.toMatchObject({ status: 404 });
    expect(rows("adCampaign")).toHaveLength(3);
  });

  it("editing the fixed copy keeps the ads it replaces", async () => {
    seedLaunched("c1");
    const out = await duplicateCampaign(admin, "c1", { fixOf: true });
    await updateCampaignDraft(admin, out.campaignId, draftBody({ name: "Spring fixed" }));
    const ads = rows("ad").filter((a) => rows("adSet").find((s) => s.id === a.adSetId)?.campaignId === out.campaignId);
    expect(ads.map((a) => [(a.creative as Row).message, readReplacesAdIds(a.creative)])).toEqual([["New words", ["c1a"]]]);
    expect(campaignRow(out.campaignId)).toMatchObject({ name: "Spring fixed", dailyBudgetMinor: 50_000 });
  });
});

describe("the post a draft promotes (sourcePostTargetId) is this workspace's own", () => {
  it("refuses another workspace's post, or one that doesn't exist, when a draft is made or edited", async () => {
    h.db.seed("postTarget", [
      { id: "pt_mine", tenantId: T, postId: "post1", assetId: "pg1", channel: "facebook", status: "published", externalId: "page1_1" },
      { id: "pt_theirs", tenantId: "t2", postId: "post9", assetId: "pg9", channel: "facebook", status: "published", externalId: "page9_9" },
    ]);
    const make = (sourcePostTargetId: string) => createCampaignDraft(admin, parseDraftInput(draftBody({ sourcePostTargetId })));
    await expect(make("pt_theirs")).rejects.toMatchObject({ status: 400, message: SOURCE_POST_UNKNOWN });
    await expect(make("pt_gone")).rejects.toMatchObject({ status: 400, message: SOURCE_POST_UNKNOWN });
    expect(rows("adCampaign")).toEqual([]);
    const { campaignId } = await make("pt_mine");
    expect(campaignRow(campaignId).sourcePostTargetId).toBe("pt_mine");
    await expect(updateCampaignDraft(admin, campaignId, draftBody({ sourcePostTargetId: "pt_theirs" }))).rejects.toMatchObject({ status: 400, message: SOURCE_POST_UNKNOWN });
    expect(campaignRow(campaignId).sourcePostTargetId).toBe("pt_mine");
    // No post at all is fine.
    await updateCampaignDraft(admin, campaignId, draftBody());
    expect(campaignRow(campaignId).sourcePostTargetId).toBeNull();
  });
});

describe("POST /api/ads/campaigns/[id]/duplicate (duplicate_campaign)", () => {
  const url = "https://wa.edwyz.com/api/ads/campaigns/c1/duplicate";
  const req = (body?: unknown, origin = "https://wa.edwyz.com") =>
    new Request(url, { method: "POST", headers: { origin, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const params = { params: Promise.resolve({ id: "c1" }) };

  it("answers 201 with the copy for an admin, 403 for an agent and for another origin, and sends nothing to Meta", async () => {
    const { POST } = await import("@/app/api/ads/campaigns/[id]/duplicate/route");
    seedLaunched("c1");
    auth.getActor.mockResolvedValue(agent);
    expect((await POST(req({}), params)).status).toBe(403);
    auth.getActor.mockResolvedValue(admin);
    expect((await POST(req({}, "https://evil.example"), params)).status).toBe(403);
    expect(rows("adCampaign")).toHaveLength(1);
    const res = await POST(req({ fixOf: true }), params);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Row;
    expect(body).toEqual({ campaignId: expect.any(String), replacesAdIds: ["c1a"] });
    // An empty body is a plain copy.
    expect((await POST(req(), params)).status).toBe(201);
    expect(rows("adCampaign").filter((c) => c.name === "Copy of Campaign c1")).toHaveLength(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no PATCH or DELETE was added to /api/ads/campaigns/[id] (draft edits and discards go through /api/promote/drafts/[id])", async () => {
    const route = await import("@/app/api/ads/campaigns/[id]/route");
    expect(Object.keys(route).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k)).sort()).toEqual(["GET", "PATCH"]);
    const duplicate = await import("@/app/api/ads/campaigns/[id]/duplicate/route");
    expect(Object.keys(duplicate).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k))).toEqual(["POST"]);
  });
});

describe("the end date and the budget for people behave as before (S3, S4; 6.1 rules 8 and 9)", () => {
  it("an earlier end is a lowering that works while all spending is stopped; a later end is reserved first", async () => {
    seedLaunched("c1");
    freeze("all");
    const earlier = days(5);
    await changeCampaignEnd(admin, "c1", { endsAt: earlier.toISOString() });
    expect(posts()).toEqual([{ method: "POST", path: "m_c1s", body: { end_time: earlier.toISOString() } }]);
    expect(campaignRow("c1").endsAt).toEqual(earlier);
    expect(ledger((r) => r.phase === "applied").length).toBeGreaterThan(0);
    // A later end spends more: refused while stopped, with nothing sent.
    meta.calls = [];
    await expect(changeCampaignEnd(admin, "c1", { endsAt: days(9).toISOString() })).rejects.toThrow(/Spending is stopped/);
    expect(posts()).toEqual([]);
    expect(campaignRow("c1").endsAt).toEqual(earlier);
    // Turned back on, the later end is reserved, sent and settled.
    freeze("none");
    const later = days(9);
    await changeCampaignEnd(admin, "c1", { endsAt: later.toISOString() });
    expect(posts()).toEqual([{ method: "POST", path: "m_c1s", body: { end_time: later.toISOString() } }]);
    expect(campaignRow("c1").endsAt).toEqual(later);
    expect(audits()).toEqual(expect.arrayContaining(["ads.campaign.end_changed", "ads.campaign.end_change_requested", "ads.campaign.end_extended"]));
  });

  it("a budget cut is a lowering that works while stopped; a raise is reserved first and refused with the room that is left", async () => {
    seedLaunched("c1");
    seedLaunched("c2");
    freeze("all");
    await expect(changeCampaignBudget(admin, "c1", { dailyBudgetMinor: 50_000 })).resolves.toMatchObject({ appliedDailyBudgetMinor: 50_000 });
    expect(posts()).toEqual([{ method: "POST", path: "m_c1s", body: { daily_budget: 50000 } }]);
    expect(ledger((r) => r.action === "ads.adset.budget_cut").map((r) => r.phase)).toEqual(["requested", "applied"]);
    meta.calls = [];
    await expect(changeCampaignBudget(admin, "c1", { dailyBudgetMinor: 60_000 })).rejects.toThrow(/Spending is stopped/);
    expect(posts()).toEqual([]);
    freeze("none");
    // ₹5,000 a day, with c2 at ₹1,000 and c1's peak today (₹1,000; the cut does not lower today's peak) at 1.75x each:
    // ₹1,500 is left, and ₹2,000 a day needs ₹3,500 - ₹1,750 = ₹1,750 more.
    const refused = (await changeCampaignBudget(admin, "c1", { dailyBudgetMinor: 200_000 }).catch((e: unknown) => e)) as SpendBlockedError;
    expect(refused).toBeInstanceOf(SpendBlockedError);
    expect(refused.code).toBe("spend.daily_limit");
    expect(refused.params.left).toEqual({ minor: INR(1_500), currency: "INR" });
    expect(refused.params.needs).toEqual({ minor: INR(1_750), currency: "INR" });
    expect(posts()).toEqual([]);
    await expect(changeCampaignBudget(admin, "c1", { dailyBudgetMinor: 180_000 })).resolves.toMatchObject({ appliedDailyBudgetMinor: 180_000 });
    expect(posts()).toEqual([{ method: "POST", path: "m_c1s", body: { daily_budget: 180000 } }]);
    // Refused while stopped, refused over the limit, then requested and applied.
    expect(ledger((r) => r.action === "ads.adset.budget_raise").map((r) => r.phase)).toEqual(["refused", "refused", "requested", "applied"]);
    expect(rows("adSet").find((s) => s.id === "c1s")!.dailyBudgetMinor).toBe(180_000);
  });
});
