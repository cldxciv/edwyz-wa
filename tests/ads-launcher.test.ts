import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;
const store = vi.hoisted(() => ({ campaigns: [] as Row[], adSets: [] as Row[], ads: [] as Row[], settings: {} as Record<string, unknown>, seq: 0, audits: [] as Row[], auditFails: false, brandIndustry: null as string | null, creativeAssets: [] as Row[], allowance: null as Row | null }));
const graph = vi.hoisted(() => ({ graphFetchAs: vi.fn() }));
const connect = vi.hoisted(() => ({ getAssetAccess: vi.fn(), listAssets: vi.fn() }));
const auditMock = vi.hoisted(() => ({ audit: vi.fn(async () => undefined) }));

/**
 * The Spend Book, faked: these tests check how the ads call sites use it (which intent, which permit, in which order, and what
 * happens on a refusal or an unclear answer). The book's own decisions run for real in tests/ads-actions.test.ts and
 * tests/spend-book.test.ts.
 */
const book = vi.hoisted(() => {
  const state = { refuse: null as Error | null, createRefuse: null as Error | null, today: null as bigint | null, month: null as bigint | null, daily: 10_000_000n as bigint | null, monthly: null as bigint | null, dailyBinding: "owner", monthlyBinding: "owner", calls: [] as string[] };
  // An ads permit that covers every object: the fake book does not model which objects an intent touches.
  const everything = new Proxy({} as Record<string, unknown>, { get: (_t, k) => (typeof k === "string" ? { status: "ACTIVE", maxDailyMinor: 10n ** 15n } : undefined) });
  let seq = 0;
  const later = () => new Date(Date.now() + 600_000);
  return {
    state,
    permitForPausedCreate: vi.fn(async (_t: string, account: string, objectCount: number) => {
      state.calls.push("permitForPausedCreate");
      if (state.createRefuse) throw state.createRefuse;
      return { type: "create", adAccountExternalId: `act_${account.replace(/^act_/, "")}`, objectCount, correlationId: `create_${++seq}`, expiresAt: later() };
    }),
    reserveAds: vi.fn(async (_t: string, intent: { kind: string }, _actor?: unknown, _opts?: { idempotencyKey?: string; reason?: string }) => {
      state.calls.push(`reserveAds:${intent.kind}`);
      if (state.refuse) throw state.refuse;
      return { type: "ads", kind: intent.kind, correlationId: `ads_${++seq}`, objects: everything, expiresAt: later() };
    }),
    assertPermitValid: vi.fn(async (_p: unknown, id: string) => void state.calls.push(`assertPermitValid:${id}`)),
    runUnderPermit: vi.fn((_p: unknown, fn: () => Promise<unknown>) => fn()),
    settleAds: vi.fn(async (_p: unknown, outcome: string) => {
      state.calls.push(`settleAds:${outcome}`);
      return { updated: 1 };
    }),
    recordLowering: vi.fn(async (_t: string, intent: { kind: string; metaObjectId: string; toMinor?: bigint }, _a: unknown, _r: string, run: (p: unknown) => Promise<void>, _o?: unknown) => {
      state.calls.push(`recordLowering:${intent.kind}:${intent.metaObjectId}`);
      // Like the real book, a cut's permit carries the value it was minted for.
      await run({ type: "lowering", kind: intent.kind, metaObjectIds: [intent.metaObjectId], ...(intent.toMinor !== undefined ? { maxBudgetMinor: intent.toMinor } : {}) });
      return { correlationId: `low_${++seq}`, bookkeeping: "done" };
    }),
    noteBudgetWriteError: vi.fn(async () => false),
    adsHeadroomDetail: vi.fn(async () => ({
      headroom: { today: { left: state.today }, month: { left: state.month } },
      limits: { currency: "INR", daily: state.daily, monthly: state.monthly, dailyBinding: state.dailyBinding, monthlyBinding: state.monthlyBinding, ceilingDetail: { daily: 200_000n, monthly: 2_000_000n } },
      state: { accounts: [], control: { timezone: "Asia/Kolkata" } },
      figures: { perCommitment: [] },
    })),
  };
});
vi.mock("@/lib/spend/book", () => book);

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as Row[]).some((c) => matches(row, c));
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as Row;
      if ("in" in c) return c.in.includes(row[key]);
      if ("lt" in c) return row[key] < c.lt;
      if ("not" in c) return row[key] !== c.not;
    }
    return row[key] === cond;
  });
}

const adMatches = (ad: Row, where: Row) => {
  const { adSet, ...rest } = where;
  if (adSet) {
    const set = store.adSets.find((s) => s.id === ad.adSetId);
    if (!set || set.campaignId !== adSet.campaignId) return false;
  }
  return matches(ad, rest);
};

const db = vi.hoisted(() => ({}) as Row);
Object.assign(db, {
  $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  platformSetting: {
    findUnique: async ({ where }: Row) => (store.settings[where.key] === undefined ? null : { value: store.settings[where.key] }),
    upsert: async ({ where, create }: Row) => void (store.settings[where.key] = create.value),
  },
  brand: { findMany: async () => (store.brandIndustry ? [{ industry: store.brandIndustry }] : []) },
  metaAsset: { findFirst: async () => ({ sandbox: false }) },
  spendAllowance: { findUnique: async () => store.allowance },
  // No open commitments: the fake book does not keep any, so raise or cut is decided against the AdSet row.
  spendCommitment: { findFirst: async () => null },
  auditLog: {
    create: async ({ data }: Row) => {
      if (store.auditFails) throw new Error("db down");
      store.audits.push(data);
      return data;
    },
  },
  phoneNumber: { findFirst: async ({ where }: Row) => (where.tenantId === "t1" && where.id === "ph1" ? { id: "ph1", displayPhone: "+911234567890" } : null), findMany: async () => [] },
  creativeAsset: {
    findFirst: async ({ where }: Row) => store.creativeAssets.find((a) => a.id === where.id && a.tenantId === where.tenantId) ?? null,
    findMany: async ({ where }: Row) => store.creativeAssets.filter((a) => a.tenantId === where.tenantId && (!where.id?.in || where.id.in.includes(a.id))).map((a) => ({ ...a, brief: { brand: { industry: a.brandIndustry ?? null } } })),
  },
  adCampaign: {
    create: async ({ data }: Row) => {
      const row = { id: `c${++store.seq}`, createdAt: new Date(), updatedAt: new Date(), launchedAt: null, lastError: null, metaCampaignId: null, ...data };
      store.campaigns.push(row);
      return row;
    },
    findMany: async ({ where }: Row) =>
      store.campaigns.filter((r) => matches(r, where)).map((c) => ({ ...c, adSets: store.adSets.filter((s) => s.campaignId === c.id).map((s) => ({ dailyBudgetMinor: s.dailyBudgetMinor })) })),
    findFirst: async ({ where }: Row) => {
      const c = store.campaigns.find((r) => matches(r, where));
      if (!c) return null;
      return { ...c, adSets: store.adSets.filter((s) => s.campaignId === c.id).map((s) => ({ ...s, ads: store.ads.filter((a) => a.adSetId === s.id) })) };
    },
    updateMany: async ({ where, data }: Row) => {
      const rows = store.campaigns.filter((r) => matches(r, where));
      rows.forEach((r) => Object.assign(r, data, { updatedAt: new Date() }));
      return { count: rows.length };
    },
  },
  adSet: {
    create: async ({ data }: Row) => {
      const row = { id: `s${++store.seq}`, metaAdSetId: null, status: "draft", ...data };
      store.adSets.push(row);
      return row;
    },
    findMany: async ({ where }: Row) => store.adSets.filter((r) => matches(r, where)),
    findFirst: async ({ where }: Row) => {
      const s = store.adSets.find((r) => matches(r, where));
      if (!s) return null;
      const campaign = store.campaigns.find((c) => c.id === s.campaignId)!;
      return { ...s, campaign: { ...campaign, adSets: store.adSets.filter((x) => x.campaignId === campaign.id) } };
    },
    updateMany: async ({ where, data }: Row) => {
      const rows = store.adSets.filter((r) => matches(r, where));
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    },
  },
  ad: {
    create: async ({ data }: Row) => {
      const row = { id: `a${++store.seq}`, metaAdId: null, status: "draft", ...data };
      store.ads.push(row);
      return row;
    },
    findFirst: async ({ where }: Row) => {
      const a = store.ads.find((r) => matches(r, where));
      if (!a) return null;
      const set = store.adSets.find((s) => s.id === a.adSetId)!;
      return { ...a, adSet: { ...set, campaign: store.campaigns.find((c) => c.id === set.campaignId) } };
    },
    updateMany: async ({ where, data }: Row) => {
      const rows = store.ads.filter((r) => adMatches(r, where));
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    },
  },
});

vi.mock("@/lib/billing/limits", () => ({ assertAdAccountAllowed: async () => undefined }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/graph", () => graph);
vi.mock("@/lib/meta-connect", () => connect);
vi.mock("@/lib/auth/audit", () => auditMock);
const approvals = vi.hoisted(() => ({ listApprovals: vi.fn(async () => [] as unknown[]), isCampaignClientApproved: vi.fn(async () => false) }));
vi.mock("@/lib/approvals", () => approvals);
const authMock = vi.hoisted(() => ({ getActor: vi.fn() }));
vi.mock("@/lib/auth", () => authMock);

import { pauseAd, pauseAdSet, resumeAd, setAdSetBudget } from "@/lib/ads/actions";
import { buildAdSet, buildCampaign, buildCreative } from "@/lib/ads/builders";
import { adsClient } from "@/lib/ads/client";
import { assertWithinCap, assertWithinWorkspaceCap, setCaps, workspaceActiveBudget } from "@/lib/ads/caps";
import { detectSpecialCategoryTerms, urlWords } from "@/lib/ads/category-terms";
import { activateCampaign, archiveCampaign, ASSISTANT_MAX_END_DAYS, createCampaignDraft, LAUNCH_LEASE_MS, launchCampaign, parseDraftInput, pauseCampaign, previewCampaign } from "@/lib/ads/service";
import { SpendBlockedError } from "@/lib/spend/errors";
import type { SpendActor } from "@/lib/spend/types";
import { emptyTargeting, restrictForCategory, SPECIAL_CATEGORY_RULES, validateTargeting } from "@/lib/ads/targeting";
import type { Targeting } from "@/lib/ads/types";

const admin = { userId: "u1", tenantId: "t1", role: "admin" as const };
const owner = { userId: "u2", tenantId: "t1", role: "owner" as const };
const agent = { userId: "u3", tenantId: "t1", role: "agent" as const };
const otherTenant = { userId: "u9", tenantId: "t2", role: "owner" as const };
/** The person who decided an optimizer action, as the Spend Book records them. */
const decider: SpendActor = { type: "user", userId: "u1", role: "admin" };
const ownerSpend: SpendActor = { type: "user", userId: "u2", role: "owner" };
const guard = { tenantId: "t1", adAccountAssetId: "acc1", actor: decider, sandbox: false };

const baseTargeting = (): Targeting => ({ ...emptyTargeting(), geo: { countries: ["IN"], cities: [] }, ageMin: 25, ageMax: 45 });

const draftBody = (over: Row = {}) => ({
  name: "Spring",
  template: "traffic",
  adAccountAssetId: "acc1",
  dailyBudgetMinor: 50000,
  specialAdCategory: "none",
  targeting: baseTargeting(),
  ads: [
    { name: "A", creative: { pageId: "page1", message: "Hello", link: "https://example.com", imageUrl: "https://example.com/a.png" } },
    { name: "B", creative: { pageId: "page1", message: "Hi", link: "https://example.com", imageUrl: "https://example.com/b.png" } },
  ],
  ...over,
});

let metaSeq = 0;
function mockGraph(failOn?: { path: RegExp; times: number }) {
  const calls: { path: string; body: Row }[] = [];
  let failures = failOn?.times ?? 0;
  graph.graphFetchAs.mockImplementation(async (_token: string, req: Row) => {
    calls.push({ path: req.path, body: req.body });
    if (failOn && failures > 0 && failOn.path.test(req.path)) {
      failures--;
      throw new Error("Meta said no");
    }
    return { id: `meta_${req.path.replace(/\W+/g, "_")}_${++metaSeq}` };
  });
  return calls;
}

async function draft(over: Row = {}, actor = admin) {
  return (await createCampaignDraft(actor, parseDraftInput(draftBody(over)))).campaignId;
}

beforeEach(() => {
  store.campaigns = [];
  store.adSets = [];
  store.ads = [];
  store.settings = { "ads:caps:t1": { maxDailyBudgetMinor: 100000, currency: "INR" } };
  store.seq = 0;
  store.audits = [];
  store.auditFails = false;
  store.brandIndustry = null;
  store.creativeAssets = [];
  store.allowance = null;
  Object.assign(book.state, { refuse: null, createRefuse: null, today: null, month: null, daily: 10_000_000n, monthly: null, dailyBinding: "owner", monthlyBinding: "owner", calls: [] });
  delete process.env.MAX_DAILY_BUDGET_MINOR;
  delete process.env.SPEND_ENFORCE;
  delete process.env.SPEND_DRY_RUN;
  vi.clearAllMocks();
  connect.listAssets.mockImplementation(async (tenantId: string, type: string) => {
    if (tenantId !== "t1") return [];
    if (type === "ad_account") return [{ id: "acc1", type, externalId: "123", name: "Main", status: "active", meta: { currency: "INR" } }];
    if (type === "page") return [{ id: "pg", type, externalId: "page1", name: "Page", status: "active", meta: {} }];
    return [];
  });
  connect.getAssetAccess.mockImplementation(async (tenantId: string, assetId: string) => {
    if (tenantId !== "t1" || assetId !== "acc1") throw Object.assign(new Error("Asset not found."), { status: 404 });
    return { assetId, type: "ad_account", externalId: "123", name: "Main", token: "SECRET_TOKEN" };
  });
});

describe("special category targeting", () => {
  it("accepts plain targeting when no category applies", () => {
    expect(validateTargeting({ ...baseTargeting(), genders: ["female"], interests: [{ id: "6003", name: "Yoga" }] }, "none").ok).toBe(true);
  });

  it.each(["housing", "employment", "credit", "social_issues"] as const)("rejects age, gender, interest, lookalike and small radius for %s", (category) => {
    const t: Targeting = { ...baseTargeting(), genders: ["male"], interests: [{ id: "1", name: "x" }], lookalikeAudienceIds: ["9"], geo: { countries: [], cities: [{ key: "k", radiusKm: 5 }] } };
    const result = validateTargeting(t, category);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/age/);
    expect(result.errors.join(" ")).toMatch(/gender/);
    expect(result.errors.join(" ")).toMatch(/interest/);
    expect(result.errors.join(" ")).toMatch(/lookalike/);
    expect(result.errors.join(" ")).toMatch(/radius/);
  });

  it("restrictForCategory produces targeting that validates and reports what changed", () => {
    const t: Targeting = { ...baseTargeting(), genders: ["male"], interests: [{ id: "1", name: "x" }], geo: { countries: [], cities: [{ key: "k", radiusKm: 5 }] } };
    const { targeting, adjustments } = restrictForCategory(t, "housing");
    expect(adjustments.length).toBeGreaterThanOrEqual(4);
    expect(validateTargeting(targeting, "housing").ok).toBe(true);
    expect(targeting.geo.cities[0].radiusKm).toBe(SPECIAL_CATEGORY_RULES.housing.minRadiusKm);
    expect(t.genders).toEqual(["male"]);
  });

  it("enforces age bounds 13 to 65 and the interest cap", () => {
    expect(validateTargeting({ ...baseTargeting(), ageMin: 12 }, "none").ok).toBe(false);
    expect(validateTargeting({ ...baseTargeting(), ageMax: 66 }, "none").ok).toBe(false);
    const many = Array.from({ length: 26 }, (_, i) => ({ id: String(i + 1), name: "i" }));
    expect(validateTargeting({ ...baseTargeting(), interests: many }, "none").ok).toBe(false);
  });

  it("stores restricted targeting when a draft declares a category and always sends special_ad_categories", async () => {
    const calls = mockGraph();
    const id = await draft({ specialAdCategory: "housing", targeting: { ...baseTargeting(), genders: ["male"], interests: [{ id: "1", name: "x" }] } });
    expect(store.adSets[0].targeting.genders).toEqual([]);
    expect(store.adSets[0].targeting.interests).toEqual([]);
    expect(store.adSets[0].targeting.ageMin).toBe(18);
    await launchCampaign(admin, id);
    expect(calls[0].body.special_ad_categories).toEqual(["HOUSING"]);
    const adset = calls.find((c) => c.path.endsWith("/adsets"))!;
    expect(adset.body.targeting).not.toHaveProperty("flexible_spec");
    expect(adset.body.targeting).not.toHaveProperty("genders");
  });

  it("sends an empty special_ad_categories array when none applies", async () => {
    const calls = mockGraph();
    await launchCampaign(admin, await draft());
    expect(calls[0].body.special_ad_categories).toEqual([]);
  });
});

describe("budget caps", () => {
  it("refuses to launch when no cap is set", async () => {
    store.settings = {};
    const calls = mockGraph();
    const id = await draft();
    await expect(launchCampaign(admin, id)).rejects.toThrow(/No daily budget cap/);
    expect(calls).toHaveLength(0);
  });

  it("refuses when the budget exceeds the cap", async () => {
    const calls = mockGraph();
    const id = await draft({ dailyBudgetMinor: 100001 });
    await expect(launchCampaign(admin, id)).rejects.toThrow(/exceeds the cap/);
    expect(calls).toHaveLength(0);
    expect((await previewCampaign(admin, id)).errors.join(" ")).toMatch(/exceeds the cap/);
  });

  it("allows a budget equal to the cap and lets the platform ceiling lower the workspace cap", async () => {
    await expect(assertWithinCap("t1", 100000, "INR")).resolves.toBeDefined();
    process.env.MAX_DAILY_BUDGET_MINOR = "60000";
    await expect(assertWithinCap("t1", 100000, "INR")).rejects.toThrow(/exceeds/);
  });

  it("reads the ads daily limit first and answers in the old meaning (the most the daily budgets may add up to)", async () => {
    store.allowance = { id: "sa1", tenantId: "t1", pot: "ads", currency: "INR", dailyLimitMinor: 175000n, monthlyLimitMinor: null, version: 1 };
    await expect(assertWithinCap("t1", 100000, "INR")).resolves.toMatchObject({ maxDailyBudgetMinor: 100000, currency: "INR" });
    await expect(assertWithinCap("t1", 100001, "INR")).rejects.toThrow(/exceeds the cap/);
    // A Not set daily limit means nothing can launch, even if the old key still holds a number.
    store.allowance = { ...store.allowance, dailyLimitMinor: null };
    await expect(assertWithinCap("t1", 1, "INR")).rejects.toThrow(/No daily budget cap/);
  });

  it("refuses a currency mismatch and invalid cap values", async () => {
    await expect(assertWithinCap("t1", 100, "USD")).rejects.toThrow(/INR/);
    await expect(setCaps("t1", { maxDailyBudgetMinor: 1.5, currency: "INR" }, ownerSpend)).rejects.toThrow();
    await expect(setCaps("t1", { maxDailyBudgetMinor: 100, currency: "rupees" }, ownerSpend)).rejects.toThrow();
  });
});

describe("spend controls at launch", () => {
  it("creates every object under one create permit from the Spend Book, asked for before the first create", async () => {
    const calls = mockGraph();
    const id = await draft();
    await launchCampaign(admin, id);
    // 1 campaign, 1 ad set, 2 creatives and 2 ads.
    expect(book.permitForPausedCreate).toHaveBeenCalledTimes(1);
    expect(book.permitForPausedCreate).toHaveBeenCalledWith("t1", "123", 6, { type: "user", userId: "u1", role: "admin" });
    expect(book.runUnderPermit).toHaveBeenCalledTimes(calls.length);
    expect(book.runUnderPermit.mock.calls.every((c: any[]) => c[0].type === "create")).toBe(true);
  });

  it("creates nothing while all spending is stopped, and gives the campaign back", async () => {
    book.state.createRefuse = new SpendBlockedError("spend.frozen");
    const calls = mockGraph();
    const id = await draft();
    await expect(launchCampaign(admin, id)).rejects.toThrow(/Spending is stopped/);
    expect(calls).toHaveLength(0);
    expect(store.campaigns[0].status).toBe("draft");
  });

  it("asks only for the objects still missing on a retry", async () => {
    mockGraph({ path: /\/ads$/, times: 1 });
    const id = await draft();
    await expect(launchCampaign(admin, id)).rejects.toThrow(/Could not create/);
    book.permitForPausedCreate.mockClear();
    mockGraph();
    await launchCampaign(admin, id);
    // The campaign, the ad set and the first creative exist: 1 creative and 2 ads are left.
    expect(book.permitForPausedCreate).toHaveBeenCalledWith("t1", "123", 3, expect.anything());
  });

  it("with SPEND_ENFORCE=enforce, refuses early when the campaign alone could never fit today's limit at Meta's worst case", async () => {
    process.env.SPEND_ENFORCE = "enforce";
    // ₹1,000 a day may become ₹1,750 on a busy day: over a ₹1,500 daily limit.
    book.state.daily = 150_000n;
    book.state.today = 150_000n;
    const calls = mockGraph();
    const id = await draft({ dailyBudgetMinor: 100000 });
    store.settings["ads:caps:t1"] = { maxDailyBudgetMinor: 200000, currency: "INR" };
    const error = await launchCampaign(admin, id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SpendBlockedError);
    expect((error as SpendBlockedError).code).toBe("spend.daily_limit");
    expect((error as Error).message).toContain("This could spend up to ₹1,750 today");
    expect(calls).toHaveLength(0);
    expect(book.permitForPausedCreate).not.toHaveBeenCalled();
  });

  it("gives the new-workspace copy when the new-workspace limit is the one that binds", async () => {
    process.env.SPEND_ENFORCE = "enforce";
    Object.assign(book.state, { daily: 200_000n, today: 200_000n, dailyBinding: "probation" });
    store.settings["ads:caps:t1"] = { maxDailyBudgetMinor: 200000, currency: "INR" };
    const id = await draft({ dailyBudgetMinor: 150000 });
    await expect(launchCampaign(admin, id)).rejects.toThrow(/New workspaces can spend up to ₹2,000 a day/);
  });

  it("in observe mode (train 1) the new checks do not block a launch", async () => {
    Object.assign(book.state, { daily: 1n, today: 0n });
    mockGraph();
    const id = await draft();
    await expect(launchCampaign(admin, id)).resolves.toMatchObject({ status: "paused" });
    expect(book.adsHeadroomDetail).not.toHaveBeenCalled();
  });
});

describe("drafts record who the campaign is for", () => {
  const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

  it("a person's draft is human, with or without an end date, and a body cannot claim to be an assistant", async () => {
    await draft({ origin: "assistant", assistantKey: "ads_launcher" });
    expect(store.campaigns[0]).toMatchObject({ origin: "human", assistantKey: null, endsAt: null });
  });

  it("an assistant's draft needs an end date within 90 days, or a lifetime budget with an end date", () => {
    const as = { origin: "assistant" as const, assistantKey: "ads_launcher" };
    expect(() => parseDraftInput(draftBody(), as)).toThrow(/assistant need an end date/);
    expect(() => parseDraftInput(draftBody({ endsAt: inDays(ASSISTANT_MAX_END_DAYS + 2) }), as)).toThrow(/within 90 days/);
    expect(parseDraftInput(draftBody({ endsAt: inDays(30) }), as)).toMatchObject({ origin: "assistant", assistantKey: "ads_launcher" });
    expect(parseDraftInput(draftBody({ dailyBudgetMinor: undefined, lifetimeBudgetMinor: 900000, endsAt: inDays(120) }), as)).toMatchObject({ dailyBudgetMinor: null, lifetimeBudgetMinor: 900000 });
    expect(() => parseDraftInput(draftBody({ endsAt: inDays(5) }), { origin: "assistant" })).toThrow(/name the assistant/);
  });

  it("a lifetime budget needs an end date, and replaces the daily budget", () => {
    expect(() => parseDraftInput(draftBody({ dailyBudgetMinor: undefined, lifetimeBudgetMinor: 900000 }))).toThrow(/lifetime budget needs an end date/);
    expect(() => parseDraftInput(draftBody({ lifetimeBudgetMinor: 900000, endsAt: inDays(10) }))).toThrow(/not both/);
    expect(() => parseDraftInput(draftBody({ dailyBudgetMinor: undefined }))).toThrow(/dailyBudgetMinor must be a positive whole number/);
  });

  it("stores origin, assistant and a lifetime budget, and creates a lifetime-only ad set with lifetime_budget and end_time", async () => {
    const endsAt = inDays(20);
    const input = parseDraftInput(draftBody({ dailyBudgetMinor: undefined, lifetimeBudgetMinor: 900000, endsAt }), { origin: "assistant", assistantKey: "ads_launcher" });
    await createCampaignDraft(admin, input);
    expect(store.campaigns[0]).toMatchObject({ origin: "assistant", assistantKey: "ads_launcher", lifetimeBudgetMinor: 900000n, dailyBudgetMinor: 0 });
    expect(store.adSets[0]).toMatchObject({ dailyBudgetMinor: null, lifetimeBudgetMinor: 900000n });
    const calls = mockGraph();
    await launchCampaign(admin, store.campaigns[0].id);
    const adset = calls.find((c) => c.path.endsWith("/adsets"))!.body;
    expect(adset).toMatchObject({ status: "PAUSED", lifetime_budget: 900000, end_time: new Date(endsAt).toISOString() });
    expect(adset).not.toHaveProperty("daily_budget");
  });
});

describe("request builders", () => {
  const targeting = baseTargeting();
  const base = { name: "S", metaCampaignId: "c1", template: "traffic" as const, targeting, specialAdCategory: "none" as const, dailyBudgetMinor: 50000, pageId: "page1" };

  it("always turns ad set budget sharing off on the campaign, and sends special categories", () => {
    expect(buildCampaign({ name: "S", template: "traffic", specialAdCategory: "none" })).toMatchObject({ status: "PAUSED", is_adset_budget_sharing_enabled: false, special_ad_categories: [] });
  });

  it("sends end_time whenever there is an end date, and lifetime_budget instead of daily_budget", () => {
    const end = new Date("2026-11-14T18:29:00Z");
    expect(buildAdSet({ ...base, endsAt: end })).toMatchObject({ status: "PAUSED", daily_budget: 50000, end_time: end.toISOString() });
    const lifetime = buildAdSet({ ...base, lifetimeBudgetMinor: 900000, endsAt: end });
    expect(lifetime).toMatchObject({ lifetime_budget: 900000, end_time: end.toISOString() });
    expect(lifetime).not.toHaveProperty("daily_budget");
    expect(() => buildAdSet({ ...base, lifetimeBudgetMinor: 900000 })).toThrow(/end date/);
    expect(buildAdSet(base)).not.toHaveProperty("end_time");
  });

  it("never gives a creative a status (it has no delivery status)", () => {
    expect(buildCreative({ name: "A", template: "traffic", creative: { pageId: "page1", message: "Hi", link: "https://e.com", imageUrl: "https://e.com/a.png" } })).not.toHaveProperty("status");
  });
});

describe("launch is paused first", () => {
  it("creates every object PAUSED, records ids and never activates", async () => {
    const calls = mockGraph();
    const id = await draft();
    const result = await launchCampaign(admin, id);
    const creates = calls.filter((c) => /\/(campaigns|adsets|adcreatives|ads)$/.test(c.path));
    expect(creates.map((c) => c.path.split("/")[1])).toEqual(["campaigns", "adsets", "adcreatives", "ads", "adcreatives", "ads"]);
    for (const c of creates.filter((c) => !c.path.endsWith("adcreatives"))) expect(c.body.status).toBe("PAUSED");
    expect(JSON.stringify(calls)).not.toContain("ACTIVE");
    expect(result.status).toBe("paused");
    expect(result.metaCampaignId).toBeTruthy();
    expect(result.adSets[0].metaAdSetId).toBeTruthy();
    expect(result.adSets[0].ads.every((a: Row) => a.metaAdId)).toBe(true);
    expect(auditMock.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "ads.campaign.launched_paused" }));
  });

  it("previews the payload without secrets and does not call Meta", async () => {
    mockGraph();
    const id = await draft();
    const preview = await previewCampaign(admin, id);
    expect(graph.graphFetchAs).not.toHaveBeenCalled();
    expect(JSON.stringify(preview)).not.toContain("SECRET_TOKEN");
    expect(preview.payload.campaign.status).toBe("PAUSED");
    expect(preview.totalDailyBudgetMinor).toBe(50000);
  });

  it("only admins and owners can launch", async () => {
    mockGraph();
    const id = await draft();
    await expect(launchCampaign(agent, id)).rejects.toThrow(/permission/);
  });

  it("builds click-to-WhatsApp objects with the WhatsApp destination and welcome message", async () => {
    const calls = mockGraph();
    const id = await draft({
      template: "click_to_whatsapp",
      ads: [{ name: "W", creative: { pageId: "page1", message: "Chat", whatsappNumberId: "ph1", welcomeMessage: "Hi there", imageUrl: "https://example.com/a.png" } }],
    });
    await launchCampaign(admin, id);
    const adset = calls.find((c) => c.path.endsWith("/adsets"))!.body;
    expect(adset.destination_type).toBe("WHATSAPP");
    expect(adset.promoted_object).toMatchObject({ page_id: "page1", whatsapp_phone_number: "+911234567890" });
    const creative = calls.find((c) => c.path.endsWith("/adcreatives"))!.body as Row;
    expect(creative.object_story_spec.link_data.call_to_action.type).toBe("WHATSAPP_MESSAGE");
    expect(creative.object_story_spec.link_data.page_welcome_message).toContain("Hi there");
  });

  it("rejects a lead generation draft without a form at launch", async () => {
    mockGraph();
    const id = await draft({ template: "lead_generation" });
    await expect(launchCampaign(admin, id)).rejects.toThrow(/leadFormId/);
  });
});

describe("idempotent retry", () => {
  it("keeps created ids after a failure and creates only the missing objects on retry", async () => {
    let calls = mockGraph({ path: /\/ads$/, times: 1 });
    const id = await draft();
    await expect(launchCampaign(admin, id)).rejects.toThrow(/Could not create/);
    expect(store.campaigns[0].status).toBe("error");
    expect(store.campaigns[0].lastError).toMatch(/Meta said no/);
    expect(store.campaigns[0].metaCampaignId).toBeTruthy();
    expect(store.adSets[0].metaAdSetId).toBeTruthy();
    const firstCampaignId = store.campaigns[0].metaCampaignId;
    const firstCreativeId = store.ads[0].creative.metaCreativeId;
    expect(firstCreativeId).toBeTruthy();

    calls = mockGraph();
    const result = await launchCampaign(admin, id);
    expect(result.status).toBe("paused");
    expect(result.metaCampaignId).toBe(firstCampaignId);
    expect(calls.filter((c) => c.path.endsWith("/campaigns"))).toHaveLength(0);
    expect(calls.filter((c) => c.path.endsWith("/adsets"))).toHaveLength(0);
    expect(calls.filter((c) => c.path.endsWith("/adcreatives"))).toHaveLength(1);
    expect(calls.filter((c) => c.path.endsWith("/ads"))).toHaveLength(2);
    expect(store.ads[0].creative.metaCreativeId).toBe(firstCreativeId);
  });

  it("refuses to launch twice and blocks a concurrent launch in progress", async () => {
    mockGraph();
    const id = await draft();
    await launchCampaign(admin, id);
    await expect(launchCampaign(admin, id)).rejects.toThrow(/already been launched/);
    store.campaigns[0].status = "launching";
    store.campaigns[0].updatedAt = new Date();
    await expect(launchCampaign(admin, id)).rejects.toThrow(/already being launched/);
  });
});

describe("activate", () => {
  async function launched() {
    mockGraph();
    const id = await draft();
    await launchCampaign(admin, id);
    graph.graphFetchAs.mockClear();
    book.state.calls = [];
    return id;
  }

  it("needs confirm and the exact total daily budget", async () => {
    const id = await launched();
    await expect(activateCampaign(admin, id, { confirm: false, confirmedTotalMinor: 50000 })).rejects.toThrow(/confirm/);
    await expect(activateCampaign(admin, id, { confirm: true, confirmedTotalMinor: 49999 })).rejects.toThrow(/total daily budget/);
    expect(graph.graphFetchAs).not.toHaveBeenCalled();
    expect(book.reserveAds).not.toHaveBeenCalled();
    expect(store.campaigns[0].status).toBe("paused");
  });

  it("reserves through the Spend Book, then turns on ads, ad sets and the campaign last, each checked first, then settles applied", async () => {
    const id = await launched();
    const result = await activateCampaign(owner, id, { confirm: true, confirmedTotalMinor: 50000 });
    expect(result.status).toBe("active");
    const order = graph.graphFetchAs.mock.calls.map((c: any[]) => c[1].path);
    expect(order[order.length - 1]).toBe(store.campaigns[0].metaCampaignId);
    expect(graph.graphFetchAs.mock.calls.every((c: any[]) => c[1].body.status === "ACTIVE")).toBe(true);
    expect(book.reserveAds).toHaveBeenCalledWith("t1", { kind: "activate", campaignId: id, sets: [{ adSetId: store.adSets[0].id, metaAdSetId: store.adSets[0].metaAdSetId }] }, { type: "user", userId: "u2", role: "owner" }, expect.objectContaining({ reason: "Turn on 'Spring'" }));
    // Every ACTIVE call is checked against the book right before it; the outcome is settled once, after the last call.
    expect(book.state.calls).toEqual(["reserveAds:activate", ...order.map((p: string) => `assertPermitValid:${p}`), "settleAds:applied"]);
    expect(store.audits).toContainEqual(expect.objectContaining({ action: "ads.campaign.activated", target: id, meta: expect.objectContaining({ totalDailyBudgetMinor: 50000 }) }));
  });

  it("a refusal from the Spend Book stops before any Meta call, keeps the campaign paused and records a failed outcome", async () => {
    const id = await launched();
    book.state.refuse = new SpendBlockedError("spend.daily_limit", { left: { minor: 40000n, currency: "INR" }, needs: { minor: 87500n, currency: "INR" } });
    const error = await activateCampaign(admin, id, { confirm: true, confirmedTotalMinor: 50000 }).catch((e: unknown) => e);
    expect((error as Error).message).toBe("This would go over your ads limit for today. Left today: ₹400. This could spend up to ₹875 today, because Meta can spend up to 75% over a daily budget. Lower the daily budget or raise your limit.");
    expect(graph.graphFetchAs).not.toHaveBeenCalled();
    expect(store.campaigns[0].status).toBe("paused");
    expect(store.audits.map((a) => a.action)).toEqual(expect.arrayContaining(["ads.campaign.activation_requested", "ads.campaign.activation_failed"]));
    expect(book.settleAds).not.toHaveBeenCalled();
  });

  it("pauses what went ACTIVE when Meta fails mid-activation, then settles failed and keeps the campaign paused", async () => {
    const id = await launched();
    const firstAd = store.ads[0].metaAdId;
    graph.graphFetchAs.mockImplementation(async (_t: string, req: Row) => {
      if (req.path === store.ads[1].metaAdId && req.body.status === "ACTIVE") throw new Error("boom");
      return { success: true };
    });
    await expect(activateCampaign(admin, id, { confirm: true, confirmedTotalMinor: 50000 })).rejects.toThrow(/still paused/);
    expect(store.campaigns[0].status).toBe("paused");
    expect(book.state.calls.filter((c) => c.startsWith("recordLowering"))).toEqual([`recordLowering:pause:${firstAd}`]);
    expect(graph.graphFetchAs).toHaveBeenLastCalledWith("SECRET_TOKEN", expect.objectContaining({ path: firstAd, body: { status: "PAUSED" } }));
    expect(book.state.calls[book.state.calls.length - 1]).toBe("settleAds:failed");
  });

  it("blocks activation only when an approval request exists and is not approved", async () => {
    const id = await launched();
    approvals.listApprovals.mockResolvedValueOnce([{ id: "r1" }]);
    await expect(activateCampaign(admin, id, { confirm: true, confirmedTotalMinor: 50000 })).rejects.toThrow(/approved/);
    expect(graph.graphFetchAs).not.toHaveBeenCalled();
    expect(book.reserveAds).not.toHaveBeenCalled();
    approvals.listApprovals.mockResolvedValueOnce([{ id: "r1" }]);
    approvals.isCampaignClientApproved.mockResolvedValueOnce(true);
    expect((await activateCampaign(admin, id, { confirm: true, confirmedTotalMinor: 50000 })).status).toBe("active");
  });

  it("cannot be done by an agent", async () => {
    const id = await launched();
    await expect(activateCampaign(agent, id, { confirm: true, confirmedTotalMinor: 50000 })).rejects.toThrow(/permission/);
  });
});

describe("pause and archive are lowering", () => {
  async function active() {
    mockGraph();
    const id = await draft();
    await launchCampaign(admin, id);
    await activateCampaign(admin, id, { confirm: true, confirmedTotalMinor: 50000 });
    graph.graphFetchAs.mockClear();
    book.state.calls = [];
    return id;
  }

  it("pauses the campaign at campaign level through recordLowering, with the lowering permit on the call", async () => {
    const id = await active();
    const metaCampaignId = store.campaigns[0].metaCampaignId;
    await pauseCampaign(admin, id);
    expect(book.recordLowering).toHaveBeenCalledWith("t1", { kind: "pause", metaObjectId: metaCampaignId }, { type: "user", userId: "u1", role: "admin" }, "Paused 'Spring'.", expect.any(Function), { objectLevel: "campaign" });
    expect(graph.graphFetchAs).toHaveBeenCalledWith("SECRET_TOKEN", expect.objectContaining({ path: metaCampaignId, body: { status: "PAUSED" } }));
    expect(book.runUnderPermit.mock.calls.at(-1)?.[0]).toMatchObject({ type: "lowering", kind: "pause" });
    expect(store.campaigns[0].status).toBe("paused");
    expect(book.reserveAds).toHaveBeenCalledTimes(1);
  });

  it("archives through recordLowering too, and a Meta failure leaves the campaign as it was", async () => {
    const id = await active();
    graph.graphFetchAs.mockRejectedValueOnce(new Error("Meta said no"));
    await expect(archiveCampaign(admin, id)).rejects.toThrow(/Could not archive on Meta/);
    expect(store.campaigns[0].status).toBe("active");
    mockGraph();
    await archiveCampaign(admin, id);
    expect(book.state.calls.filter((c) => c.startsWith("recordLowering"))).toEqual([`recordLowering:archive:${store.campaigns[0].metaCampaignId}`, `recordLowering:archive:${store.campaigns[0].metaCampaignId}`]);
    expect(store.campaigns[0].status).toBe("archived");
  });
});

describe("tenant isolation", () => {
  it("does not find or launch another tenant's campaign", async () => {
    mockGraph();
    const id = await draft();
    await expect(launchCampaign(otherTenant, id)).rejects.toThrow(/not found/i);
    await expect(previewCampaign(otherTenant, id)).rejects.toThrow(/not found/i);
    await expect(activateCampaign(otherTenant, id, { confirm: true, confirmedTotalMinor: 50000 })).rejects.toThrow(/not found/i);
    expect(graph.graphFetchAs).not.toHaveBeenCalled();
  });

  it("refuses an ad account or page that is not the tenant's", async () => {
    await expect(createCampaignDraft(otherTenant, parseDraftInput(draftBody()))).rejects.toThrow(/not found/i);
    await expect(createCampaignDraft(admin, parseDraftInput(draftBody({ ads: [{ name: "x", creative: { pageId: "foreign", message: "m", link: "https://e.com", imageUrl: "https://e.com/i.png" } }] })))).rejects.toThrow(/not connected/);
  });

  it("scopes pauseAd, pauseAdSet and setAdSetBudget by tenant", async () => {
    mockGraph();
    const id = await draft();
    await launchCampaign(admin, id);
    const metaAdId = store.ads[0].metaAdId;
    const metaAdSetId = store.adSets[0].metaAdSetId;
    await expect(pauseAd("t2", metaAdId, decider)).rejects.toThrow(/not found/i);
    await expect(pauseAdSet("t2", metaAdSetId, decider)).rejects.toThrow(/not found/i);
    await expect(setAdSetBudget("t2", metaAdSetId, 1000, decider)).rejects.toThrow(/not found/i);
  });
});

describe("optimizer actions", () => {
  async function launchedActive() {
    mockGraph();
    const id = await draft();
    await launchCampaign(admin, id);
    await activateCampaign(admin, id, { confirm: true, confirmedTotalMinor: 50000 });
    graph.graphFetchAs.mockClear();
    book.state.calls = [];
    mockGraph();
  }

  it("pauseAd pauses through recordLowering, updates the row, audits and returns a revert payload", async () => {
    await launchedActive();
    const metaAdId = store.ads[0].metaAdId;
    const { revertPayload } = await pauseAd("t1", metaAdId, decider);
    expect(book.state.calls).toEqual([`recordLowering:pause:${metaAdId}`]);
    expect(book.recordLowering.mock.calls[0][5]).toEqual({ objectLevel: "ad" });
    expect(graph.graphFetchAs).toHaveBeenCalledWith("SECRET_TOKEN", expect.objectContaining({ path: metaAdId, body: { status: "PAUSED" } }));
    expect(store.ads[0].status).toBe("paused");
    expect(revertPayload).toMatchObject({ action: "resume_ad", metaAdId, previousStatus: "active" });
    expect(auditMock.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "ads.ad.paused", tenantId: "t1", userId: "u1" }));
  });

  it("pauseAdSet pauses one ad set the same way, for the breakers", async () => {
    await launchedActive();
    const metaAdSetId = store.adSets[0].metaAdSetId;
    const breaker: SpendActor = { type: "breaker", kind: "efficiency" };
    const { revertPayload } = await pauseAdSet("t1", metaAdSetId, breaker);
    expect(book.recordLowering).toHaveBeenCalledWith("t1", { kind: "pause", metaObjectId: metaAdSetId }, breaker, "Paused an ad set.", expect.any(Function), { objectLevel: "adset" });
    expect(store.adSets[0].status).toBe("paused");
    expect(revertPayload).toMatchObject({ action: "resume_adset", metaAdSetId, previousStatus: "active" });
  });

  it("resumeAd turns the ad back on only with a resume_ad reservation, and settles it", async () => {
    await launchedActive();
    const metaAdId = store.ads[0].metaAdId;
    const { revertPayload } = await pauseAd("t1", metaAdId, decider);
    graph.graphFetchAs.mockClear();
    book.state.calls = [];
    await resumeAd("t1", metaAdId, revertPayload, decider);
    expect(book.state.calls).toEqual(["reserveAds:resume_ad", `assertPermitValid:${metaAdId}`, "settleAds:applied"]);
    expect(book.reserveAds.mock.calls.at(-1)?.[1]).toEqual({ kind: "resume_ad", adId: store.ads[0].id, metaAdId });
    expect(graph.graphFetchAs).toHaveBeenCalledWith("SECRET_TOKEN", expect.objectContaining({ body: { status: "ACTIVE" } }));
    expect(store.ads[0].status).toBe("active");
    await expect(resumeAd("t2", metaAdId, revertPayload, decider)).rejects.toThrow(/not found/i);
    await expect(resumeAd("t1", metaAdId, { action: "other" }, decider)).rejects.toThrow();
  });

  it("resumeAd refused by the Spend Book sends nothing (the old gap: it used to skip every limit)", async () => {
    await launchedActive();
    const metaAdId = store.ads[0].metaAdId;
    const { revertPayload } = await pauseAd("t1", metaAdId, decider);
    graph.graphFetchAs.mockClear();
    book.state.refuse = new SpendBlockedError("spend.daily_limit", {});
    await expect(resumeAd("t1", metaAdId, revertPayload, decider)).rejects.toThrow(/over your ads limit for today/);
    expect(graph.graphFetchAs).not.toHaveBeenCalled();
    expect(store.ads[0].status).toBe("paused");
    expect(store.audits.map((a) => a.action)).toContain("ads.ad.resume_failed");
  });

  it("setAdSetBudget raises through reserveAds raise_budget (no clamping) and returns the previous budget to revert", async () => {
    await launchedActive();
    const metaAdSetId = store.adSets[0].metaAdSetId;
    const result = await setAdSetBudget("t1", metaAdSetId, 999999, decider);
    expect(result).toEqual({ revertPayload: { action: "set_adset_budget", metaAdSetId, dailyBudgetMinor: 50000 }, appliedDailyBudgetMinor: 999999, clamped: false });
    expect(book.reserveAds.mock.calls.at(-1)?.[1]).toEqual({ kind: "raise_budget", adSetId: store.adSets[0].id, metaAdSetId, toMinor: 999999n, shiftFromAdSetId: undefined });
    expect(book.state.calls).toEqual(["reserveAds:raise_budget", `assertPermitValid:${metaAdSetId}`, "settleAds:applied"]);
    expect(graph.graphFetchAs).toHaveBeenCalledWith("SECRET_TOKEN", expect.objectContaining({ body: { daily_budget: 999999 } }));
    expect(store.adSets[0].dailyBudgetMinor).toBe(999999);
    expect(store.audits).toContainEqual(expect.objectContaining({ action: "ads.adset.budget_changed", meta: expect.objectContaining({ from: 50000, to: 999999 }) }));
  });

  it("a refused raise carries the room left and changes nothing", async () => {
    await launchedActive();
    const metaAdSetId = store.adSets[0].metaAdSetId;
    book.state.refuse = new SpendBlockedError("spend.daily_limit", { left: { minor: 12_000n, currency: "INR" }, needs: { minor: 35_000n, currency: "INR" } });
    const error = (await setAdSetBudget("t1", metaAdSetId, 70000, decider).catch((e: unknown) => e)) as SpendBlockedError;
    expect(error.code).toBe("spend.daily_limit");
    expect(error.params.left).toEqual({ minor: 12_000n, currency: "INR" });
    expect(error.message).toContain("Left today: ₹120.");
    expect(graph.graphFetchAs).not.toHaveBeenCalled();
    expect(store.adSets[0].dailyBudgetMinor).toBe(50000);
    expect(store.audits.map((a) => a.action)).toEqual(expect.arrayContaining(["ads.adset.budget_change_requested", "ads.adset.budget_change_failed"]));
  });

  it("a cut is a lowering: recordLowering cut_budget, never a reservation", async () => {
    await launchedActive();
    const metaAdSetId = store.adSets[0].metaAdSetId;
    book.state.refuse = new SpendBlockedError("spend.frozen");
    const result = await setAdSetBudget("t1", metaAdSetId, 20000, decider);
    expect(result.appliedDailyBudgetMinor).toBe(20000);
    expect(book.reserveAds.mock.calls.filter((c: any[]) => c[1].kind === "raise_budget")).toHaveLength(0);
    expect(book.recordLowering).toHaveBeenCalledWith("t1", { kind: "cut_budget", metaObjectId: metaAdSetId, toMinor: 20000n }, decider, "Lowered a daily budget.", expect.any(Function), { objectLevel: "adset" });
    expect(graph.graphFetchAs).toHaveBeenCalledWith("SECRET_TOKEN", expect.objectContaining({ body: { daily_budget: 20000 } }));
    expect(store.adSets[0].dailyBudgetMinor).toBe(20000);
    expect(store.campaigns[0].dailyBudgetMinor).toBe(20000);
  });

  it("names the cut half of a shift by its row id, so the book counts the freed budget", async () => {
    await launchedActive();
    const metaAdSetId = store.adSets[0].metaAdSetId;
    store.adSets.push({ id: "sB", tenantId: "t1", campaignId: store.campaigns[0].id, metaAdSetId: "metaB", name: "B", status: "active", dailyBudgetMinor: 40000 });
    await setAdSetBudget("t1", metaAdSetId, 60000, decider, { shiftFromAdSetId: "metaB" });
    expect(book.reserveAds.mock.calls.at(-1)?.[1]).toMatchObject({ kind: "raise_budget", shiftFromAdSetId: "sB" });
    await expect(setAdSetBudget("t1", metaAdSetId, 70000, decider, { shiftFromAdSetId: "nope" })).rejects.toThrow(/cut first was not found/);
  });

  it("an unchanged budget sends nothing and uses no budget change", async () => {
    await launchedActive();
    const result = await setAdSetBudget("t1", store.adSets[0].metaAdSetId, 50000, decider);
    expect(result.appliedDailyBudgetMinor).toBe(50000);
    expect(graph.graphFetchAs).not.toHaveBeenCalled();
    expect(book.reserveAds.mock.calls.filter((c: any[]) => c[1].kind === "raise_budget")).toHaveLength(0);
  });

  it("rejects non-integers and needs the actor who decided", async () => {
    await launchedActive();
    const metaAdSetId = store.adSets[0].metaAdSetId;
    await expect(setAdSetBudget("t1", metaAdSetId, 10.5, decider)).rejects.toThrow(/positive whole number/);
    await expect(setAdSetBudget("t1", metaAdSetId, 1000, undefined as unknown as SpendActor)).rejects.toThrow(/needs the person or job/);
  });
});

async function launchedCampaign(over: Row = {}) {
  mockGraph();
  const id = await draft(over);
  await launchCampaign(admin, id);
  graph.graphFetchAs.mockClear();
  return id;
}
const activateArgs = (total = 50000) => ({ confirm: true, confirmedTotalMinor: total });
const statusOf = (id: string) => store.campaigns.find((c) => c.id === id)!.status;

describe("P3-01 the Spend Book decides whether a campaign can be turned on", () => {
  it("applies the same reservation when a paused campaign is resumed, and a refusal leaves it paused", async () => {
    const a = await launchedCampaign();
    book.state.refuse = new SpendBlockedError("spend.monthly_limit", {});
    await expect(activateCampaign(admin, a, activateArgs(), "resume")).rejects.toThrow(/over your ads limit for this month/);
    expect(statusOf(a)).toBe("paused");
    expect(graph.graphFetchAs).not.toHaveBeenCalled();
    expect(book.reserveAds.mock.calls.at(-1)?.[3]).toMatchObject({ reason: "Turn 'Spring' back on" });
    expect(store.audits.map((x) => x.action)).toContain("ads.campaign.resume_failed");
  });

  it("does not let two simultaneous activations of one campaign both run: they share one reservation and the second loses the claim", async () => {
    const b = await launchedCampaign();
    const results = await Promise.allSettled([activateCampaign(admin, b, activateArgs()), activateCampaign(admin, b, activateArgs())]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    // Same version of the campaign, same idempotency key: the book hands both the same reservation.
    const keys = book.reserveAds.mock.calls.map((c: any[]) => c[3].idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    // Only the winner settles; the loser sent nothing.
    expect(book.state.calls.filter((c) => c.startsWith("settleAds"))).toEqual(["settleAds:applied"]);
  });

  it("reserves while the campaign still reads paused, then claims it", async () => {
    const id = await launchedCampaign();
    let statusAtReservation = "";
    book.reserveAds.mockImplementationOnce(async (_t: string, intent: { kind: string }) => {
      statusAtReservation = statusOf(id);
      return { type: "ads", kind: intent.kind, correlationId: "x", objects: new Proxy({}, { get: () => ({ status: "ACTIVE" }) }), expiresAt: new Date(Date.now() + 600_000) };
    });
    await activateCampaign(admin, id, activateArgs());
    expect(statusAtReservation).toBe("paused");
    expect(statusOf(id)).toBe("active");
  });
});

describe("P3-19 currency is never assumed", () => {
  const accountWith = (meta: Row) =>
    connect.listAssets.mockImplementation(async (_tenantId: string, type: string) => {
      if (type === "ad_account") return [{ id: "acc1", type, externalId: "123", name: "Main", status: "active", meta }];
      if (type === "page") return [{ id: "pg", type, externalId: "page1", name: "Page", status: "active", meta: {} }];
      return [];
    });

  it("refuses to draft when the ad account currency is unknown", async () => {
    accountWith({});
    await expect(createCampaignDraft(admin, parseDraftInput(draftBody()))).rejects.toThrow(/currency of this ad account is unknown/);
    expect(store.campaigns).toHaveLength(0);
  });

  it("stores the account currency on the campaign instead of defaulting to INR", async () => {
    accountWith({ currency: "usd" });
    await draft();
    expect(store.campaigns[0].currency).toBe("USD");
  });

  it("refuses a stored cap that has no currency", async () => {
    store.settings["ads:caps:t1"] = { maxDailyBudgetMinor: 100000 };
    await expect(assertWithinCap("t1", 100, "INR")).rejects.toThrow(/no currency/);
  });

  it("rescales a legacy cap saved with a different exponent", async () => {
    store.settings["ads:caps:t1"] = { maxDailyBudgetMinor: 5000, currency: "JPY", exponent: 0 };
    await expect(assertWithinCap("t1", 5000, "JPY")).resolves.toBeDefined();
    await expect(assertWithinCap("t1", 5001, "JPY")).rejects.toThrow(/exceeds the cap/);
    store.settings["ads:caps:t1"] = { maxDailyBudgetMinor: 500000, currency: "JPY", exponent: 2 };
    await expect(assertWithinCap("t1", 5000, "JPY")).resolves.toBeDefined();
    await expect(assertWithinCap("t1", 5001, "JPY")).rejects.toThrow(/exceeds the cap/);
  });

  it("a budget raise in a currency the limits are not set up for is refused by the book with its copy", async () => {
    const id = await launchedCampaign();
    await activateCampaign(admin, id, activateArgs());
    graph.graphFetchAs.mockClear();
    book.state.refuse = new SpendBlockedError("spend.currency", { accountCurrency: "INR", limitCurrency: "USD" });
    await expect(setAdSetBudget("t1", store.adSets[0].metaAdSetId, 60000, decider)).rejects.toThrow(/This ad account uses INR, but your limits are in USD/);
    expect(graph.graphFetchAs).not.toHaveBeenCalled();
  });
});

describe("P3-20 an ambiguous failure does not create a second campaign", () => {
  const freshIso = () => new Date().toISOString();
  function graphWithExistingCampaigns(found: Row[], failFirstCampaignPost = false) {
    const calls: { path: string; method?: string; body: Row; query?: Row }[] = [];
    let failed = false;
    graph.graphFetchAs.mockImplementation(async (_t: string, req: Row) => {
      calls.push({ path: req.path, method: req.method, body: req.body, query: req.query });
      if (req.method === "GET" && /\/campaigns$/.test(req.path)) return { data: found };
      if (failFirstCampaignPost && !failed && /\/campaigns$/.test(req.path)) {
        failed = true;
        throw new Error("timeout");
      }
      return { id: `meta_${req.path.replace(/\W+/g, "_")}_${calls.length}` };
    });
    return calls;
  }

  it("looks the campaign up by name after a failed attempt and reuses it", async () => {
    const calls = graphWithExistingCampaigns([], true);
    const id = await draft();
    await expect(launchCampaign(admin, id)).rejects.toThrow(/Could not create/);
    expect(store.campaigns[0].metaCampaignId).toBeNull();
    expect(calls.some((c) => c.method === "GET")).toBe(false);

    const retry = graphWithExistingCampaigns([{ id: "orphan1", name: "Spring", status: "PAUSED", created_time: freshIso() }]);
    const result = await launchCampaign(admin, id);
    expect(result.metaCampaignId).toBe("orphan1");
    expect(retry.filter((c) => c.method === "POST" && c.path.endsWith("/campaigns"))).toHaveLength(0);
    const lookup = retry.find((c) => c.method === "GET")!;
    expect(lookup.path).toBe("act_123/campaigns");
    expect(String(lookup.query?.filtering)).toContain("Spring");
    expect(result.adSets[0].ads.every((a: Row) => a.metaAdId)).toBe(true);
  });

  it("does not adopt a campaign with another name, an active one or one older than the draft", async () => {
    graphWithExistingCampaigns([], true);
    const id = await draft();
    await expect(launchCampaign(admin, id)).rejects.toThrow();
    const old = new Date(Date.now() - 3600_000 * 24).toISOString();
    const retry = graphWithExistingCampaigns([
      { id: "x1", name: "Spring 2", status: "PAUSED", created_time: freshIso() },
      { id: "x2", name: "Spring", status: "ACTIVE", created_time: freshIso() },
      { id: "x3", name: "Spring", status: "PAUSED", created_time: old },
    ]);
    const result = await launchCampaign(admin, id);
    expect(retry.filter((c) => c.method === "POST" && c.path.endsWith("/campaigns"))).toHaveLength(1);
    expect(["x1", "x2", "x3"]).not.toContain(result.metaCampaignId);
  });

  it("does not look anything up on the first launch of a draft", async () => {
    const calls = graphWithExistingCampaigns([]);
    await launchCampaign(admin, await draft());
    expect(calls.some((c) => c.method === "GET")).toBe(false);
  });

  it("honours a launching claim for a fixed lease measured from the last sign of life, not from the number of ads", async () => {
    expect(LAUNCH_LEASE_MS).toBeGreaterThanOrEqual(5 * 60_000);
    expect(LAUNCH_LEASE_MS).toBeLessThanOrEqual(10 * 60_000);
    mockGraph();
    const id = await draft();
    store.campaigns[0].status = "launching";
    store.campaigns[0].updatedAt = new Date(Date.now() - 2 * 60_000);
    await expect(launchCampaign(admin, id)).rejects.toThrow(/already being launched/);
    expect(graph.graphFetchAs).not.toHaveBeenCalled();
    store.campaigns[0].updatedAt = new Date(Date.now() - LAUNCH_LEASE_MS - 60_000);
    await expect(launchCampaign(admin, id)).resolves.toBeDefined();
  });

  it("refreshes the claim after every Meta call so a long launch is never taken over", async () => {
    const id = await draft({ ads: Array.from({ length: 10 }, (_, i) => ({ name: `Ad ${i}`, creative: { pageId: "page1", message: "Hi", link: "https://example.com", imageUrl: "https://example.com/a.png" } })) });
    let calls = 0;
    graph.graphFetchAs.mockImplementation(async (_t: string, req: Row) => {
      calls++;
      if (calls > 1) expect(Date.now() - store.campaigns[0].updatedAt.getTime()).toBeLessThan(60_000);
      store.campaigns[0].updatedAt = new Date(Date.now() - LAUNCH_LEASE_MS * 5);
      return { id: `m_${req.path.replace(/\W+/g, "_")}_${calls}` };
    });
    await launchCampaign(admin, id);
    expect(calls).toBe(1 + 1 + 20);
  });

  it("releases the launching claim when the connection cannot be used", async () => {
    const id = await draft();
    connect.getAssetAccess.mockRejectedValueOnce(new Error("expired"));
    await expect(launchCampaign(admin, id)).rejects.toThrow(/expired/);
    expect(statusOf(id)).toBe("draft");
  });

  it("never adopts a Meta campaign that is already stored on another campaign, even with the same name", async () => {
    graphWithExistingCampaigns([]);
    const a = await draft();
    await launchCampaign(admin, a);
    const m1 = store.campaigns[0].metaCampaignId;
    graphWithExistingCampaigns([], true);
    const b = await draft();
    await expect(launchCampaign(admin, b)).rejects.toThrow(/Could not create/);
    const earlier = new Date(Date.now() - 60_000).toISOString();
    const retry = graphWithExistingCampaigns([
      { id: m1, name: "Spring", status: "PAUSED", created_time: freshIso() },
      { id: "orphanB", name: "Spring", status: "PAUSED", created_time: earlier },
    ]);
    const result = await launchCampaign(admin, b);
    expect(result.metaCampaignId).toBe("orphanB");
    expect(store.campaigns[0].metaCampaignId).toBe(m1);
    expect(retry.filter((c) => c.method === "POST" && c.path.endsWith("/campaigns"))).toHaveLength(0);
  });

  it("creates a new campaign when the only same-name match belongs to a sibling", async () => {
    graphWithExistingCampaigns([]);
    const a = await draft();
    await launchCampaign(admin, a);
    const m1 = store.campaigns[0].metaCampaignId;
    graphWithExistingCampaigns([], true);
    const b = await draft();
    await expect(launchCampaign(admin, b)).rejects.toThrow();
    const retry = graphWithExistingCampaigns([{ id: m1, name: "Spring", status: "PAUSED", created_time: freshIso() }]);
    const result = await launchCampaign(admin, b);
    expect(result.metaCampaignId).not.toBe(m1);
    expect(retry.filter((c) => c.method === "POST" && c.path.endsWith("/campaigns"))).toHaveLength(1);
  });

  it("prefers the newest unlinked match and ignores a match without a created time", async () => {
    graphWithExistingCampaigns([], true);
    const id = await draft();
    await expect(launchCampaign(admin, id)).rejects.toThrow();
    const older = new Date(Date.now() - 30_000).toISOString();
    graphWithExistingCampaigns([
      { id: "noTime", name: "Spring", status: "PAUSED" },
      { id: "older", name: "Spring", status: "PAUSED", created_time: older },
      { id: "newest", name: "Spring", status: "PAUSED", created_time: freshIso() },
    ]);
    expect((await launchCampaign(admin, id)).metaCampaignId).toBe("newest");

    store.campaigns = [];
    store.adSets = [];
    store.ads = [];
    graphWithExistingCampaigns([], true);
    const id2 = await draft();
    await expect(launchCampaign(admin, id2)).rejects.toThrow();
    const retry = graphWithExistingCampaigns([{ id: "noTime", name: "Spring", status: "PAUSED" }]);
    expect((await launchCampaign(admin, id2)).metaCampaignId).not.toBe("noTime");
    expect(retry.filter((c) => c.method === "POST" && c.path.endsWith("/campaigns"))).toHaveLength(1);
  });

  describe("name lookup paging", () => {
    const page = (names: string[], next?: string) => ({ data: names.map((n, i) => ({ id: `${n}${i}`, name: n, status: "PAUSED", created_time: new Date().toISOString() })), paging: next ? { next: "https://graph/next", cursors: { after: next } } : {} });

    it("follows every page so an exact match beyond the first page is found", async () => {
      const queries: Row[] = [];
      graph.graphFetchAs.mockImplementation(async (_t: string, req: Row) => {
        queries.push(req.query);
        return req.query.after === "p2" ? page(["Spring"]) : page(Array.from({ length: 100 }, () => "Spring sale"), "p2");
      });
      const found = await adsClient("T", "123", guard).findCampaignsByName("Spring");
      expect(found.map((f) => f.name)).toEqual(["Spring"]);
      expect(queries).toHaveLength(2);
      expect(queries[1].after).toBe("p2");
    });

    it("fails closed instead of guessing when the matches cannot be listed completely", async () => {
      graph.graphFetchAs.mockImplementation(async () => page(["Spring"], "again"));
      await expect(adsClient("T", "123", guard).findCampaignsByName("Spring")).rejects.toThrow(/Too many campaigns/);
      graph.graphFetchAs.mockImplementation(async () => ({ data: [], paging: { next: "https://graph/next" } }));
      await expect(adsClient("T", "123", guard).findCampaignsByName("Spring")).rejects.toThrow(/Too many campaigns/);
    });

    it("reports the newest match first", async () => {
      graph.graphFetchAs.mockResolvedValue({ data: [{ id: "a", name: "S", status: "PAUSED", created_time: "2026-01-01T00:00:00Z" }, { id: "b", name: "S", status: "PAUSED", created_time: "2026-02-01T00:00:00Z" }] });
      expect((await adsClient("T", "123", guard).findCampaignsByName("S")).map((f) => f.id)).toEqual(["b", "a"]);
    });
  });
});

describe("P3-23 special category terms", () => {
  const loanAds = [{ name: "A", creative: { pageId: "page1", message: "Get a home loan with low EMI today", link: "https://example.com", imageUrl: "https://example.com/a.png" } }];

  it("detects housing, employment and credit terms without flagging ordinary copy", () => {
    expect(detectSpecialCategoryTerms(["Apartments for sale in Pune"]).map((h) => h.category)).toContain("housing");
    expect(detectSpecialCategoryTerms(["We are hiring a designer"]).map((h) => h.category)).toContain("employment");
    expect(detectSpecialCategoryTerms(["Instant personal loan"]).map((h) => h.category)).toContain("credit");
    expect(detectSpecialCategoryTerms(["Spring sale on running shoes"], "Footwear")).toEqual([]);
    expect(detectSpecialCategoryTerms(["Hello"], "Real estate").map((h) => h.source)).toEqual(["industry"]);
  });

  it("blocks a draft declared as none when the copy has credit terms", async () => {
    await expect(createCampaignDraft(admin, parseDraftInput(draftBody({ ads: loanAds })))).rejects.toThrow(/acknowledgeSpecialCategoryTerms/);
    expect(store.campaigns).toHaveLength(0);
  });

  it("blocks when only the brand industry matches, and accepts the second acknowledgement", async () => {
    store.brandIndustry = "Real estate";
    await expect(createCampaignDraft(admin, parseDraftInput(draftBody()))).rejects.toThrow(/housing/);
    const result = await createCampaignDraft(admin, parseDraftInput(draftBody({ acknowledgeSpecialCategoryTerms: true })));
    expect(result.campaignId).toBeTruthy();
    expect(store.ads.every((a) => a.creative.categoryTermsAck === true)).toBe(true);
  });

  it("launches an acknowledged campaign but never sends the acknowledgement to Meta", async () => {
    const calls = mockGraph();
    const id = await draft({ ads: loanAds, acknowledgeSpecialCategoryTerms: true });
    await launchCampaign(admin, id);
    expect(JSON.stringify(calls)).not.toContain("categoryTermsAck");
  });

  it("blocks launch of an existing none campaign with these terms and no acknowledgement", async () => {
    const calls = mockGraph();
    const id = await draft();
    store.ads[0].creative = { ...store.ads[0].creative, message: "We are hiring cashiers" };
    await expect(launchCampaign(admin, id)).rejects.toThrow(/employment special ad category/);
    expect(calls).toHaveLength(0);
    expect(statusOf(id)).toBe("draft");
  });

  it("does not interfere when the category is declared", async () => {
    mockGraph();
    const id = await draft({ ads: loanAds, specialAdCategory: "credit" });
    await expect(launchCampaign(admin, id)).resolves.toBeDefined();
  });

  it("parseDraftInput carries only an explicit true", () => {
    expect(parseDraftInput(draftBody({ acknowledgeSpecialCategoryTerms: "yes" })).acknowledgeSpecialCategoryTerms).toBe(false);
    expect(parseDraftInput(draftBody({ acknowledgeSpecialCategoryTerms: true })).acknowledgeSpecialCategoryTerms).toBe(true);
  });
});

describe("P3-26 money actions write the audit row first", () => {
  it("launch records the audit row before any Meta call and stops when it cannot", async () => {
    const id = await draft();
    store.auditFails = true;
    await expect(launchCampaign(admin, id)).rejects.toThrow(/audit log could not be written/);
    expect(graph.graphFetchAs).not.toHaveBeenCalled();
    expect(statusOf(id)).toBe("draft");
    store.auditFails = false;
    let auditedBeforeFirstCall = false;
    graph.graphFetchAs.mockImplementation(async (_t: string, req: Row) => {
      auditedBeforeFirstCall ||= store.audits.some((a) => a.action === "ads.campaign.launch_started");
      return { id: `m_${req.path.replace(/\W+/g, "_")}` };
    });
    await launchCampaign(admin, id);
    expect(auditedBeforeFirstCall).toBe(true);
  });

  it("activate and resume do not touch Meta, the book or the campaign when the audit write fails", async () => {
    const id = await launchedCampaign();
    store.auditFails = true;
    await expect(activateCampaign(admin, id, activateArgs())).rejects.toThrow(/audit log could not be written/);
    await expect(activateCampaign(admin, id, activateArgs(), "resume")).rejects.toThrow(/audit log could not be written/);
    expect(graph.graphFetchAs).not.toHaveBeenCalled();
    expect(book.reserveAds).not.toHaveBeenCalled();
    expect(statusOf(id)).toBe("paused");
    store.auditFails = false;
    await activateCampaign(admin, id, activateArgs(), "resume");
    expect(store.audits.map((a) => a.action)).toContain("ads.campaign.resumed");
  });

  it("activation writes the audit row before the first status call", async () => {
    const id = await launchedCampaign();
    let audited = false;
    graph.graphFetchAs.mockImplementation(async () => {
      audited ||= store.audits.some((a) => a.action === "ads.campaign.activation_requested");
      return { id: "x" };
    });
    await activateCampaign(admin, id, activateArgs());
    expect(audited).toBe(true);
  });

  it("a Meta failure after activation was audited puts the campaign back to paused", async () => {
    const id = await launchedCampaign();
    graph.graphFetchAs.mockRejectedValueOnce(new Error("boom"));
    await expect(activateCampaign(admin, id, activateArgs())).rejects.toThrow(/still paused/);
    expect(statusOf(id)).toBe("paused");
  });

  it("setAdSetBudget and resumeAd stop without calling Meta or the book when the audit write fails", async () => {
    const id = await launchedCampaign();
    mockGraph();
    await activateCampaign(admin, id, activateArgs());
    const { revertPayload } = await pauseAd("t1", store.ads[0].metaAdId, decider);
    graph.graphFetchAs.mockClear();
    book.reserveAds.mockClear();
    store.auditFails = true;
    await expect(setAdSetBudget("t1", store.adSets[0].metaAdSetId, 60000, decider)).rejects.toThrow(/audit log could not be written/);
    await expect(resumeAd("t1", store.ads[0].metaAdId, revertPayload, decider)).rejects.toThrow(/audit log could not be written/);
    expect(graph.graphFetchAs).not.toHaveBeenCalled();
    expect(book.reserveAds).not.toHaveBeenCalled();
    expect(store.adSets[0].dailyBudgetMinor).toBe(50000);
    expect(store.ads[0].status).toBe("paused");
  });

  it("changing the cap is audited first and fails closed", async () => {
    const { PUT } = await import("@/app/api/ads/caps/route");
    authMock.getActor.mockResolvedValue(owner);
    const put = () => PUT(new Request("https://wa.edwyz.com/api/ads/caps", { method: "PUT", headers: { origin: "https://wa.edwyz.com", "content-type": "application/json" }, body: JSON.stringify({ maxDailyBudgetMinor: 777000, currency: "INR" }) }));
    store.auditFails = true;
    expect((await put()).status).toBe(500);
    expect(store.settings["ads:caps:t1"]).toMatchObject({ maxDailyBudgetMinor: 100000 });
    // The successful write through the spending limits is covered in tests/spend-caps-shim.test.ts.
  });
});

const ambiguousError = () => Object.assign(new Error("timeout"), { ambiguous: true });

describe("P3-01 ambiguous activation keeps the spend counted", () => {
  it("keeps the campaign active and the reservation counted (unconfirmed) when Meta's answer to the final ACTIVE call is unclear", async () => {
    const id = await launchedCampaign();
    const metaCampaignId = store.campaigns[0].metaCampaignId;
    graph.graphFetchAs.mockImplementation(async (_t: string, req: Row) => {
      if (req.path === metaCampaignId) throw ambiguousError();
      return { id: "x" };
    });
    await expect(activateCampaign(admin, id, activateArgs())).rejects.toThrow(/did not confirm/);
    expect(statusOf(id)).toBe("active");
    expect(store.campaigns[0].lastError).toMatch(/not confirmed/);
    expect(book.state.calls.filter((c) => c.startsWith("settleAds"))).toEqual(["settleAds:unconfirmed"]);
    expect(book.recordLowering).not.toHaveBeenCalled();
    expect(store.audits.map((a) => a.action)).toEqual(expect.arrayContaining(["ads.campaign.activation_requested", "ads.campaign.activation_unconfirmed"]));
    expect(store.audits.map((a) => a.action)).not.toContain("ads.campaign.activated");
  });

  it("puts the campaign back to paused on a definite failure of the campaign call, after pausing the ads and ad sets it turned on", async () => {
    const id = await launchedCampaign();
    const metaCampaignId = store.campaigns[0].metaCampaignId;
    graph.graphFetchAs.mockImplementation(async (_t: string, req: Row) => {
      if (req.path === metaCampaignId) throw new Error("rejected");
      return { id: "x" };
    });
    await expect(activateCampaign(admin, id, activateArgs())).rejects.toThrow(/still paused/);
    expect(statusOf(id)).toBe("paused");
    // Newest first: the ad set, then the two ads.
    expect(book.state.calls.filter((c) => c.startsWith("recordLowering"))).toEqual([store.adSets[0].metaAdSetId, store.ads[1].metaAdId, store.ads[0].metaAdId].map((m) => `recordLowering:pause:${m}`));
    expect(book.state.calls.at(-1)).toBe("settleAds:failed");
    expect(store.audits.map((a) => a.action)).toContain("ads.campaign.activation_failed");
  });

  it("releases the campaign when an unclear failure hit an earlier call (the campaign itself was never switched on), pausing that object too", async () => {
    const id = await launchedCampaign();
    graph.graphFetchAs.mockRejectedValueOnce(ambiguousError());
    await expect(activateCampaign(admin, id, activateArgs())).rejects.toThrow(/still paused/);
    expect(statusOf(id)).toBe("paused");
    expect(book.state.calls.filter((c) => c.startsWith("recordLowering"))).toEqual([`recordLowering:pause:${store.ads[0].metaAdId}`]);
    expect(book.state.calls.at(-1)).toBe("settleAds:failed");
  });

  it("settles unconfirmed (still counted) when pausing back also fails", async () => {
    const id = await launchedCampaign();
    const metaCampaignId = store.campaigns[0].metaCampaignId;
    graph.graphFetchAs.mockImplementation(async (_t: string, req: Row) => {
      if (req.path === metaCampaignId || req.body.status === "PAUSED") throw new Error("Meta is down");
      return { id: "x" };
    });
    await expect(activateCampaign(admin, id, activateArgs())).rejects.toThrow(/still paused/);
    expect(book.state.calls.at(-1)).toBe("settleAds:unconfirmed");
  });
});

describe("P3-01 budget raises are reserved before Meta is called", () => {
  async function oneActive() {
    const a = await launchedCampaign();
    await activateCampaign(admin, a, activateArgs());
    const setOf = (campaignId: string) => store.adSets.find((s) => s.campaignId === campaignId)!;
    mockGraph();
    book.state.calls = [];
    return { a, setOf };
  }

  it("reserves before the Meta call", async () => {
    const { a, setOf } = await oneActive();
    let reservedFirst = false;
    graph.graphFetchAs.mockImplementation(async () => {
      reservedFirst = book.state.calls.includes("reserveAds:raise_budget");
      return { success: true };
    });
    await setAdSetBudget("t1", setOf(a).metaAdSetId, 70000, decider);
    expect(reservedFirst).toBe(true);
  });

  it("keeps the raised budget recorded and counted when Meta's answer is unclear, and leaves the budget on a definite failure", async () => {
    const { a, setOf } = await oneActive();
    graph.graphFetchAs.mockRejectedValueOnce(ambiguousError());
    await expect(setAdSetBudget("t1", setOf(a).metaAdSetId, 70000, decider)).rejects.toThrow(/did not confirm/);
    expect(setOf(a).dailyBudgetMinor).toBe(70000);
    expect(book.state.calls.at(-1)).toBe("settleAds:unconfirmed");
    expect(store.audits.map((x) => x.action)).toContain("ads.adset.budget_change_unconfirmed");
    graph.graphFetchAs.mockRejectedValueOnce(new Error("rejected"));
    await expect(setAdSetBudget("t1", setOf(a).metaAdSetId, 80000, decider)).rejects.toThrow(/Could not change/);
    expect(book.state.calls.at(-1)).toBe("settleAds:failed");
    expect(setOf(a).dailyBudgetMinor).toBe(70000);
    expect(store.campaigns.find((c) => c.id === a)!.dailyBudgetMinor).toBe(70000);
  });

  it("tells the book about Meta's 'too many budget changes' answer", async () => {
    const { a, setOf } = await oneActive();
    const quota = Object.assign(new Error("too many changes"), { code: 613, subcode: 1487632 });
    graph.graphFetchAs.mockRejectedValueOnce(quota);
    await expect(setAdSetBudget("t1", setOf(a).metaAdSetId, 70000, decider)).rejects.toThrow(/Could not change/);
    expect(book.noteBudgetWriteError).toHaveBeenCalledWith("t1", setOf(a).metaAdSetId, quota);
  });
});

describe("P3-01 campaigns past their schedule stop counting", () => {
  it("does not count an active campaign whose end date has passed, but counts one that is still running", async () => {
    const day = 86_400_000;
    store.campaigns.push({ id: "ended", tenantId: "t1", status: "active", currency: "INR", dailyBudgetMinor: 70000, endsAt: new Date(Date.now() - day) });
    store.campaigns.push({ id: "running", tenantId: "t1", status: "active", currency: "INR", dailyBudgetMinor: 20000, endsAt: new Date(Date.now() + day) });
    store.campaigns.push({ id: "open", tenantId: "t1", status: "active", currency: "INR", dailyBudgetMinor: 5000, endsAt: null });
    expect(await workspaceActiveBudget("t1", "INR")).toBe(25000);
  });

  it("assertWithinWorkspaceCap asks the book: the campaign's busy-day worst case must fit what is left today", async () => {
    // ₹750 a day may become ₹1,312.50 on a busy day.
    book.state.today = 131_250n;
    await expect(assertWithinWorkspaceCap("t1", 75000, "INR")).resolves.toBeDefined();
    await expect(assertWithinWorkspaceCap("t1", 75001, "INR")).rejects.toThrow(/over your ads limit for today/);
    book.state.today = null;
    await expect(assertWithinWorkspaceCap("t1", 100000, "INR")).resolves.toBeDefined();
  });
});

describe("P3-19 currency is checked against the live ad account and cannot be switched under active spend", () => {
  const accountCurrency = (currency?: string) =>
    connect.listAssets.mockImplementation(async (_tenantId: string, type: string) => {
      if (type === "ad_account") return [{ id: "acc1", type, externalId: "123", name: "Main", status: "active", meta: currency ? { currency } : {} }];
      if (type === "page") return [{ id: "pg", type, externalId: "page1", name: "Page", status: "active", meta: {} }];
      return [];
    });

  it("refuses to launch or activate a campaign saved in INR when its account reports USD", async () => {
    const id = await launchedCampaign();
    store.campaigns[0].status = "draft";
    accountCurrency("USD");
    await expect(launchCampaign(admin, id)).rejects.toThrow(/reports USD/);
    store.campaigns[0].status = "paused";
    await expect(activateCampaign(admin, id, activateArgs())).rejects.toThrow(/reports USD/);
    expect(statusOf(id)).toBe("paused");
    expect(graph.graphFetchAs).not.toHaveBeenCalled();
  });

  it("refuses to launch or activate when the account no longer reports a currency", async () => {
    const id = await launchedCampaign();
    accountCurrency(undefined);
    await expect(activateCampaign(admin, id, activateArgs())).rejects.toThrow(/currency of this ad account is unknown/);
    store.campaigns[0].status = "draft";
    await expect(launchCampaign(admin, id)).rejects.toThrow(/currency of this ad account is unknown/);
  });

  it("shows the currency problem in the preview of an old draft", async () => {
    const id = await draft();
    accountCurrency("USD");
    expect((await previewCampaign(admin, id)).errors.join(" ")).toMatch(/reports USD/);
  });

  it("refuses to change the cap currency while campaigns in another currency are active", async () => {
    store.campaigns.push({ id: "live", tenantId: "t1", status: "active", currency: "INR", dailyBudgetMinor: 1000 });
    await expect(setCaps("t1", { maxDailyBudgetMinor: 5000, currency: "USD" }, ownerSpend)).rejects.toThrow(/different currency/);
    expect(store.settings["ads:caps:t1"]).toMatchObject({ currency: "INR" });
    // The writes that follow are covered in tests/spend-caps-shim.test.ts.
  });

  it("the caps route reports that refusal before it writes any audit row", async () => {
    const { PUT } = await import("@/app/api/ads/caps/route");
    authMock.getActor.mockResolvedValue(owner);
    store.campaigns.push({ id: "live", tenantId: "t1", status: "active", currency: "INR", dailyBudgetMinor: 1000 });
    const res = await PUT(new Request("https://wa.edwyz.com/api/ads/caps", { method: "PUT", headers: { origin: "https://wa.edwyz.com", "content-type": "application/json" }, body: JSON.stringify({ maxDailyBudgetMinor: 5000, currency: "USD" }) }));
    expect(res.status).toBe(409);
    expect(store.audits).toHaveLength(0);
  });
});

describe("P3-23 wider detection, scoped industry and acknowledgement at launch", () => {
  const categories = (text: string, industry?: string) => detectSpecialCategoryTerms([text], industry).map((h) => h.category);

  it("catches common Indian real-estate and credit phrasing", () => {
    for (const text of ["Book a 2 BHK flat today", "Residential plots near the airport", "Luxury villa with garden", "Rent a flat in Pune", "2BHK ready to move"]) expect(categories(text)).toContain("housing");
    for (const text of ["Loans even with bad credit", "Payday cash in minutes", "Pre-approved limit for you", "Check your CIBIL score free"]) expect(categories(text)).toContain("credit");
    for (const text of ["Walk-in interview this Sunday", "Freshers welcome", "Work from home, apply now"]) expect(categories(text)).toContain("employment");
    expect(categories("Summer sneakers on sale")).toEqual([]);
  });

  it("reads link and image words as copy", () => {
    expect(urlWords("https://example.com/home-loan-offer.html?utm=x")).toContain("home loan offer");
    expect(categories(urlWords("https://example.com/apply/home-loan"))).toEqual(expect.arrayContaining(["housing", "credit"]));
  });

  it("scans the link, the image URL and the button label when a draft is created", async () => {
    const link = [{ name: "A", creative: { pageId: "page1", message: "Great offer", link: "https://example.com/personal-loan", imageUrl: "https://example.com/a.png" } }];
    await expect(createCampaignDraft(admin, parseDraftInput(draftBody({ ads: link })))).rejects.toThrow(/credit/);
    const image = [{ name: "A", creative: { pageId: "page1", message: "Great offer", link: "https://example.com", imageUrl: "https://example.com/villa-plots.png" } }];
    await expect(createCampaignDraft(admin, parseDraftInput(draftBody({ ads: image })))).rejects.toThrow(/housing/);
  });

  it("tells a UI user to declare the category and does not demand a field the UI cannot send", async () => {
    const loan = [{ name: "A", creative: { pageId: "page1", message: "Get a home loan", link: "https://example.com", imageUrl: "https://example.com/a.png" } }];
    await expect(createCampaignDraft(admin, parseDraftInput(draftBody({ ads: loan })))).rejects.toThrow(/Choose the matching special ad category/);
  });

  it("only uses the industry of the brands behind the chosen creatives, falling back to all brands for hand-typed copy", async () => {
    store.brandIndustry = "Real estate";
    store.creativeAssets = [{ id: "ca1", tenantId: "t1", status: "ready", policyCheck: null, body: "Fresh shoes", headline: "Sale", brandIndustry: "Footwear" }];
    const withAsset = { ...draftBody(), ads: [{ name: "A", creativeAssetId: "ca1", creative: { pageId: "page1", message: "Fresh shoes", link: "https://example.com", imageUrl: "https://example.com/a.png" } }] };
    await expect(createCampaignDraft(admin, parseDraftInput(withAsset))).resolves.toBeDefined();
    await expect(createCampaignDraft(admin, parseDraftInput(draftBody()))).rejects.toThrow(/housing/);
  });

  it("lets an existing draft be launched with the explicit acknowledgement, records it and keeps it off Meta", async () => {
    const calls = mockGraph();
    const id = await draft();
    store.ads[0].creative = { ...store.ads[0].creative, message: "Instant payday loans" };
    await expect(launchCampaign(admin, id)).rejects.toThrow(/credit special ad category/);
    expect(statusOf(id)).toBe("draft");
    await launchCampaign(admin, id, { acknowledgeSpecialCategoryTerms: true });
    expect(store.ads.every((a) => a.creative.categoryTermsAck === true)).toBe(true);
    expect(store.audits.find((a) => a.action === "ads.campaign.launch_started")?.meta).toMatchObject({ termsAcknowledged: true });
    expect(JSON.stringify(calls)).not.toContain("categoryTermsAck");
    expect(statusOf(id)).toBe("paused");
  });

  it("the launch route passes the acknowledgement only when it is exactly true", async () => {
    const { POST } = await import("@/app/api/ads/campaigns/[id]/launch/route");
    authMock.getActor.mockResolvedValue(admin);
    mockGraph();
    const id = await draft();
    store.ads[0].creative = { ...store.ads[0].creative, message: "We are hiring cashiers" };
    const call = (body?: string) => POST(new Request("https://wa.edwyz.com/x", { method: "POST", headers: { origin: "https://wa.edwyz.com", "content-type": "application/json" }, body }), { params: Promise.resolve({ id }) });
    expect((await call()).status).toBe(400);
    expect((await call(JSON.stringify({ acknowledgeSpecialCategoryTerms: "yes" }))).status).toBe(400);
    expect((await call("not json")).status).toBe(400);
    expect((await call(JSON.stringify({ acknowledgeSpecialCategoryTerms: true }))).status).toBe(200);
  });
});

describe("P3-26 the audit trail only claims what happened", () => {
  it("a launch that loses the claim writes no launch_started row", async () => {
    mockGraph();
    const id = await draft();
    store.campaigns[0].status = "launching";
    store.campaigns[0].updatedAt = new Date();
    await expect(launchCampaign(admin, id)).rejects.toThrow(/already being launched/);
    expect(store.audits.map((a) => a.action)).not.toContain("ads.campaign.launch_started");
  });

  it("a failed launch_started write releases the claim instead of leaving the campaign launching", async () => {
    const id = await draft();
    store.auditFails = true;
    await expect(launchCampaign(admin, id)).rejects.toThrow(/audit log could not be written/);
    expect(statusOf(id)).toBe("draft");
    store.auditFails = false;
    mockGraph();
    await expect(launchCampaign(admin, id)).resolves.toBeDefined();
  });

  it("activation writes a request row, then exactly one outcome row", async () => {
    const id = await launchedCampaign();
    await activateCampaign(admin, id, activateArgs());
    expect(store.audits.map((a) => a.action)).toEqual(["ads.campaign.launch_started", "ads.campaign.activation_requested", "ads.campaign.activated"]);
  });

  it("a refused activation leaves a failed outcome next to its request, never an activated row", async () => {
    const id = await launchedCampaign();
    graph.graphFetchAs.mockRejectedValueOnce(new Error("boom"));
    await expect(activateCampaign(admin, id, activateArgs())).rejects.toThrow();
    const actions = store.audits.map((a) => a.action);
    expect(actions).toContain("ads.campaign.activation_requested");
    expect(actions).toContain("ads.campaign.activation_failed");
    expect(actions).not.toContain("ads.campaign.activated");
  });

  it("the outcome row is retried once if the first write fails", async () => {
    const id = await launchedCampaign();
    const original = db.auditLog.create;
    let failedOnce = false;
    db.auditLog.create = async (args: Row) => {
      if (args.data.action === "ads.campaign.activated" && !failedOnce) {
        failedOnce = true;
        throw new Error("blip");
      }
      return original(args);
    };
    try {
      await activateCampaign(admin, id, activateArgs());
    } finally {
      db.auditLog.create = original;
    }
    expect(store.audits.map((a) => a.action)).toContain("ads.campaign.activated");
  });

  it("budget changes write a request row, then the outcome row", async () => {
    const id = await launchedCampaign();
    await activateCampaign(admin, id, activateArgs());
    store.audits = [];
    mockGraph();
    await setAdSetBudget("t1", store.adSets[0].metaAdSetId, 60000, decider);
    expect(store.audits.map((a) => a.action)).toEqual(["ads.adset.budget_change_requested", "ads.adset.budget_changed"]);
  });
});
