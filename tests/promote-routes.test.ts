import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

/**
 * docs/IG-PAGE-ADS-SPEC.md 4.8 (routes and rate limits), 6.1 rule 7 and PRM-09 acceptance 4 (promote-routes): agents get 403 on
 * every write and may read drafts and the catalog; cross-origin requests are refused; a stale PATCH gives 409 with the latest
 * draft; the 11th start in an hour gets 429; PUT settings refuses an http privacy link; the catalog makes no Meta call; every
 * route answers 404 while PROMOTE_ENABLED=off. The routes run for real through promote/route-guard and promote/service, over the
 * same in-memory fakes as tests/promote-service.test.ts.
 */
type Row = Record<string, any>;
const h = vi.hoisted(() => {
  const store = {
    campaigns: [] as Row[],
    adSets: [] as Row[],
    ads: [] as Row[],
    media: [] as Row[],
    forms: [] as Row[],
    assets: [] as Row[],
    settings: {} as Record<string, unknown>,
    approvers: [] as string[],
    seq: 0,
    clock: 1_700_000_000_000,
  };
  const state = {
    leftToday: 10_000_000n as bigint | null,
    leftMonth: 100_000_000n as bigint | null,
    daily: 10_000_000n as bigint | null,
    freeze: "none" as string,
    demo: false,
    approvals: [] as unknown[],
    approved: false,
    launchError: null as unknown,
    activateError: null as unknown,
    ambiguous: false,
    calls: [] as string[],
  };
  const tick = () => new Date((store.clock += 1000));

  function matches(row: Row, where: Row | undefined): boolean {
    return Object.entries(where ?? {}).every(([k, cond]) => {
      if (k === "OR") return (cond as Row[]).some((c) => matches(row, c));
      if (k === "adSet") {
        const set = store.adSets.find((s) => s.id === row.adSetId);
        return !!set && matches(set, cond as Row);
      }
      const v = row[k];
      if (cond === null) return v === null || v === undefined;
      if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
      if (cond && typeof cond === "object") {
        const c = cond as Row;
        if ("in" in c) return c.in.includes(v);
        if ("not" in c) return v !== c.not;
        if ("endsWith" in c) return typeof v === "string" && v.endsWith(c.endsWith);
        return true;
      }
      return v === cond;
    });
  }
  const full = (c: Row) => ({
    ...c,
    adSets: store.adSets
      .filter((s) => s.campaignId === c.id)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((s) => ({ ...s, ads: store.ads.filter((a) => a.adSetId === s.id) })),
    adTest: null,
  });

  const db = {
    adCampaign: {
      findFirst: vi.fn(async ({ where }: Row) => {
        const c = store.campaigns.find((r) => matches(r, where));
        return c ? full(c) : null;
      }),
      findMany: vi.fn(async ({ where }: Row) => store.campaigns.filter((r) => matches(r, where))),
      // Like Prisma's @updatedAt: set on every write unless the write gives updatedAt itself.
      updateMany: vi.fn(async ({ where, data }: Row) => {
        const rows = store.campaigns.filter((r) => matches(r, where));
        for (const r of rows) Object.assign(r, data, "updatedAt" in data ? {} : { updatedAt: tick() });
        return { count: rows.length };
      }),
    },
    adSet: {
      findMany: vi.fn(async ({ where }: Row) => store.adSets.filter((s) => matches(s, where))),
    },
    ad: {
      findMany: vi.fn(async ({ where }: Row) => store.ads.filter((a) => matches(a, where))),
      updateMany: vi.fn(async ({ where, data }: Row) => {
        const rows = store.ads.filter((a) => matches(a, where));
        for (const r of rows) Object.assign(r, data);
        return { count: rows.length };
      }),
    },
    adMedia: {
      findMany: vi.fn(async ({ where }: Row) => store.media.filter((m) => matches(m, where))),
      findFirst: vi.fn(async ({ where }: Row) => store.media.find((m) => matches(m, where)) ?? null),
    },
    metaAsset: {
      findFirst: vi.fn(async ({ where }: Row) => store.assets.find((a) => matches(a, where)) ?? null),
      findMany: vi.fn(async ({ where }: Row) => store.assets.filter((a) => matches(a, { tenantId: where.tenantId, type: where.type }))),
    },
    spendControl: { findUnique: vi.fn(async () => ({ spendingAdAccountAssetId: "acc", timezone: "Asia/Kolkata", approverUserIds: store.approvers })) },
    membership: { findFirst: vi.fn(async () => ({ user: { name: "Asha" } })) },
    phoneNumber: { findFirst: vi.fn(async () => ({ id: "ph1", displayPhone: "+91 98765 43210" })) },
    leadForm: {
      count: vi.fn(async () => store.forms.length),
      findFirst: vi.fn(async ({ where }: Row) => store.forms.find((f) => matches(f, where)) ?? null),
    },
    brand: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    platformSetting: { findUnique: vi.fn(async ({ where }: Row) => (where.key in store.settings ? { value: store.settings[where.key] } : null)) },
  };

  /** The rows ads/service writes for a parsed draft: one ad set, or one per version at an equal share (3.8). */
  function writeRows(campaign: Row, input: Row) {
    const split = input.compareMode === "fair_split" && input.ads.length > 1;
    const share = split ? Math.floor(input.dailyBudgetMinor / input.ads.length / 100) * 100 : input.dailyBudgetMinor;
    campaign.dailyBudgetMinor = split ? share * input.ads.length : input.dailyBudgetMinor;
    const groups: Row[][] = split ? input.ads.map((a: Row) => [a]) : [input.ads];
    for (const group of groups) {
      const set = { id: `s${++store.seq}`, tenantId: campaign.tenantId, campaignId: campaign.id, name: "set", targeting: input.targeting, dailyBudgetMinor: share, lifetimeBudgetMinor: null, variantKey: split ? group[0].variantKey : null, metaAdSetId: null, status: "draft", createdAt: tick() };
      store.adSets.push(set);
      for (const ad of group) {
        store.ads.push({ id: `a${++store.seq}`, tenantId: campaign.tenantId, adSetId: set.id, name: ad.name, creative: { ...ad.creative }, format: ad.creative.format ?? "single_image", variantLabel: ad.variantKey, metaAdId: null, status: "draft", creativeAssetId: null, createdAt: tick() });
      }
    }
  }

  const sum = (c: Row) => store.adSets.filter((s) => s.campaignId === c.id).reduce((n, s) => n + (s.dailyBudgetMinor ?? c.dailyBudgetMinor), 0);

  class AdsMediaNotReadyError extends Error {
    status = 409;
    code = "media_not_ready";
    constructor(readonly mediaIds: string[]) {
      super("Meta is still preparing your video. This usually takes 5 to 30 minutes.");
    }
    toJSON() {
      return { error: this.message, code: this.code, mediaIds: this.mediaIds };
    }
  }

  const ads = {
    DRAFT_DISCARDED: "This draft was discarded. Restore it first.",
    AdsMediaNotReadyError,
    userSpendActor: (a: Row) => ({ type: "user", userId: a.userId, role: a.role }),
    creativeMediaIds: (creative: Row) => {
      const media = creative?.media ?? {};
      return [...new Set([...["feed", "vertical", "square", "video"].map((k) => media[k]).filter(Boolean), ...(creative?.cards ?? []).map((k: Row) => k.mediaId)])];
    },
    isEditableDraft: (c: Row) => (c.status === "draft" || c.status === "error") && !c.metaCampaignId && c.adSets.every((s: Row) => !s.metaAdSetId && s.ads.every((a: Row) => !a.metaAdId)),
    createCampaignDraft: vi.fn(async (actor: Row, input: Row) => {
      const c: Row = {
        id: `c${++store.seq}`,
        tenantId: actor.tenantId,
        adAccountAssetId: input.adAccountAssetId,
        name: input.name,
        template: input.template,
        objective: "OUTCOME",
        status: "draft",
        currency: "INR",
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        specialAdCategory: input.specialAdCategory,
        origin: input.origin,
        surface: input.surface,
        goal: input.goal,
        sourceKind: input.sourceKind,
        sourceRef: input.sourceRef,
        sourcePostTargetId: input.sourcePostTargetId,
        placementMode: input.placementMode,
        runDays: input.runDays,
        startMode: input.startMode,
        metaCampaignId: null,
        discardedAt: null,
        launchedAt: null,
        lastError: null,
        lifetimeBudgetMinor: null,
        createdAt: tick(),
        updatedAt: tick(),
      };
      store.campaigns.push(c);
      writeRows(c, input);
      return { campaignId: c.id, adjustments: [] };
    }),
    updateCampaignDraft: vi.fn(async (actor: Row, id: string, body: Row) => {
      const { parseDraftInput } = await import("@/lib/ads/draft-input");
      const c = store.campaigns.find((r) => r.id === id && r.tenantId === actor.tenantId)!;
      const input = parseDraftInput(body, { origin: "human", surface: c.surface, timeZone: "Asia/Kolkata" }) as unknown as Row;
      const sets = store.adSets.filter((s) => s.campaignId === id).map((s) => s.id);
      store.ads = store.ads.filter((a) => !sets.includes(a.adSetId));
      store.adSets = store.adSets.filter((s) => s.campaignId !== id);
      Object.assign(c, { name: input.name, endsAt: input.endsAt, startsAt: input.startsAt, runDays: input.runDays, startMode: input.startMode, placementMode: input.placementMode, specialAdCategory: input.specialAdCategory, goal: input.goal, updatedAt: tick() });
      writeRows(c, input);
      return { campaignId: id, adjustments: [] };
    }),
    discardDraft: vi.fn(async (_a: Row, id: string, now = new Date()) => {
      const c = store.campaigns.find((r) => r.id === id)!;
      c.discardedAt = now;
      return { campaignId: id, discardedAt: now, restorableUntil: new Date(now.getTime() + 900_000) };
    }),
    restoreDraft: vi.fn(async (_a: Row, id: string) => {
      store.campaigns.find((r) => r.id === id)!.discardedAt = null;
      return { campaignId: id, restored: true };
    }),
    validateCampaign: vi.fn(async () => [] as string[]),
    launchCampaign: vi.fn(async (_a: Row, id: string) => {
      state.calls.push("launch");
      const c = store.campaigns.find((r) => r.id === id)!;
      if (state.launchError) {
        const e = state.launchError;
        state.launchError = null;
        c.status = "error";
        throw e;
      }
      c.status = "paused";
      c.metaCampaignId = `dryrun_campaign_${id}`;
      for (const s of store.adSets.filter((x) => x.campaignId === id)) {
        s.metaAdSetId = `dryrun_adset_${s.id}`;
        for (const a of store.ads.filter((x) => x.adSetId === s.id)) a.metaAdId = `dryrun_ad_${a.id}`;
      }
      return full(c);
    }),
    activateCampaign: vi.fn(async (_a: Row, id: string, input: Row) => {
      state.calls.push("activate");
      const { HttpError } = await import("@/lib/tenancy");
      const c = store.campaigns.find((r) => r.id === id)!;
      if (input.confirm !== true || input.confirmedTotalMinor !== sum(c)) throw new HttpError(409, "confirm the exact amount");
      if (state.activateError) {
        if (state.ambiguous) c.status = "active";
        throw state.activateError;
      }
      c.status = "active";
      return full(c);
    }),
    pauseCampaign: vi.fn(async (_a: Row, id: string) => {
      state.calls.push(`pauseCampaign:${id}`);
      return full(store.campaigns.find((r) => r.id === id)!);
    }),
  };

  return {
    store,
    state,
    db,
    ads,
    headroom: vi.fn(async () => ({
      headroom: { currency: "INR", today: { left: state.leftToday }, month: { left: state.leftMonth }, freeze: { workspace: state.freeze, platform: "none", effective: state.freeze }, metaLimit: null },
      limits: { currency: "INR", daily: state.daily, monthly: null },
      state: { spendingAccount: { assetId: "acc" }, control: { timezone: "Asia/Kolkata" } },
      figures: {},
    })),
    prereqs: vi.fn(async (_a: unknown, i: Row) => ({ goal: i.goal, rows: [], ready: true, identity: { pageAssetId: "page1", igAssetId: "ig1" } })),
    ensureDraftForm: vi.fn(async (_a: unknown, draftId: string, _page?: unknown, _spec?: unknown, _opts?: unknown) => {
      let form = store.forms.find((f) => f.draftId === draftId);
      const reused = !!form;
      if (!form) {
        form = { id: `lf${++store.seq}`, tenantId: "t1", metaFormId: `meta_form_${draftId}`, draftId, name: `Form [${draftId}]` };
        store.forms.push(form);
      }
      return { form, reused, specMatches: true };
    }),
    copyForm: vi.fn(),
    sendAdMedia: vi.fn(async (row: Row) => {
      state.calls.push(`sendAdMedia:${row.id}`);
      row.status = "ready";
      row.metaImageHash = "dryrunhash";
      return row;
    }),
    pauseAd: vi.fn(async (_t: string, metaAdId: string, _actor?: unknown, _opts?: unknown) => {
      state.calls.push(`pauseAd:${metaAdId}`);
      const ad = store.ads.find((a) => a.metaAdId === metaAdId);
      if (ad) ad.status = "paused";
      return { revertPayload: {} };
    }),
    pauseAdSet: vi.fn(async (_t: string, metaAdSetId: string, _actor?: unknown, _opts?: unknown) => {
      state.calls.push(`pauseAdSet:${metaAdSetId}`);
      return { revertPayload: {} };
    }),
  };
});

vi.mock("@/lib/db", () => ({ prisma: h.db }));
vi.mock("@/lib/auth", () => ({ getActor: vi.fn() }));
vi.mock("@/lib/ads/service", () => h.ads);
vi.mock("@/lib/ads/actions", () => ({ pauseAd: (...a: unknown[]) => h.pauseAd(...(a as [string, string])), pauseAdSet: (...a: unknown[]) => h.pauseAdSet(...(a as [string, string])) }));
vi.mock("@/lib/spend/book", () => ({ adsHeadroomDetail: (...a: unknown[]) => h.headroom(...(a as [])) }));
vi.mock("@/lib/spend/demo", () => ({ isDemoWorkspace: async () => h.state.demo }));
vi.mock("@/lib/approvals", () => ({ listApprovals: async () => h.state.approvals, isCampaignClientApproved: async () => h.state.approved }));
vi.mock("@/lib/promote/prereqs", () => ({ checkPromotionSetup: (...a: unknown[]) => h.prereqs(...(a as [unknown, Row])) }));
vi.mock("@/lib/promote/lead-forms", () => ({ ensureDraftForm: (...a: unknown[]) => h.ensureDraftForm(...(a as [unknown, string])), copyForm: (...a: unknown[]) => h.copyForm(...a) }));
vi.mock("@/lib/promote/media", () => ({ sendAdMedia: (...a: unknown[]) => h.sendAdMedia(...(a as [Row])) }));

import { GET as catalogGET } from "@/app/api/promote/catalog/route";
import { DELETE as draftDELETE, GET as draftGET, PATCH as draftPATCH } from "@/app/api/promote/drafts/[id]/route";
import { POST as reviewPOST } from "@/app/api/promote/drafts/[id]/review/route";
import { POST as savePausedPOST } from "@/app/api/promote/drafts/[id]/save-paused/route";
import { POST as startPOST } from "@/app/api/promote/drafts/[id]/start/route";
import { POST as draftsPOST } from "@/app/api/promote/drafts/route";
import { GET as settingsGET, PUT as settingsPUT } from "@/app/api/promote/settings/route";
import { getActor } from "@/lib/auth";
import { PROMOTE_NOT_FOUND, PROMOTE_START_CLOSED, PROMOTE_WRITERS_ONLY } from "@/lib/promote/route-guard";

const ORIGIN = "https://wa.edwyz.com";
const EVIL = "https://evil.example";
const actorMock = vi.mocked(getActor);

type Body = Record<string, any>;
const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, { method, headers: { origin: ORIGIN, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const json = async (r: Response) => (await r.json()) as Body;

const as = (role: "owner" | "admin" | "agent", tenantId = "t1") => actorMock.mockResolvedValue({ userId: "u1", tenantId, role } as never);

/** Every write route, called with the same request shape. */
const WRITES: [string, (r: Request) => Promise<Response>][] = [
  ["POST /api/promote/drafts", (r) => draftsPOST(r, undefined)],
  ["PATCH /api/promote/drafts/[id]", (r) => draftPATCH(r, ctx("c1"))],
  ["DELETE /api/promote/drafts/[id]", (r) => draftDELETE(r, ctx("c1"))],
  ["POST /api/promote/drafts/[id]/review", (r) => reviewPOST(r, ctx("c1"))],
  ["POST /api/promote/drafts/[id]/start", (r) => startPOST(r, ctx("c1"))],
  ["POST /api/promote/drafts/[id]/save-paused", (r) => savePausedPOST(r, ctx("c1"))],
  ["PUT /api/promote/settings", (r) => settingsPUT(r, undefined)],
];
const METHOD = (name: string) => name.split(" ")[0];
const PATH = (name: string) => name.split(" ")[1].replace("[id]", "c1");

/** Creates a draft through the route as an admin and answers its body. */
async function newDraft(set: Record<string, unknown> = { "text.primary": "Fresh flowers every day", "text.link": "https://shop.example/flowers", "media.feed": "m1" }) {
  as("admin");
  const res = await draftsPOST(req("POST", "/api/promote/drafts", { goal: "website_visits", days: 5, set }), undefined);
  expect(res.status).toBe(201);
  return json(res);
}

let fetchSpy: MockInstance<typeof fetch>;

beforeEach(() => {
  process.env.SITE_URL = ORIGIN;
  process.env.PROMOTE_ENABLED = "on";
  process.env.SPEND_ENFORCE = "enforce";
  process.env.SPEND_TRIPWIRE = "enforce";
  // Every catalog row is still at verify state `docs` (D22): goals are offered only with PROMOTE_EXPERIMENTAL on the workspace's
  // sandbox ad account ("acc" below), so the draft routes run there.
  process.env.PROMOTE_EXPERIMENTAL = "1";
  delete process.env.PROMOTE_GOALS;
  delete process.env.SPEND_DRY_RUN;
  Object.assign(h.store, { campaigns: [], adSets: [], ads: [], media: [], forms: [], settings: {}, approvers: [], seq: 0 });
  h.store.assets = [
    { id: "acc", tenantId: "t1", type: "ad_account", externalId: "act_1", name: "Ads", sandbox: true, meta: { currency: "INR", timezone: "Asia/Kolkata" } },
    { id: "page1", tenantId: "t1", type: "page", externalId: "p1", name: "Asha Flowers", meta: {} },
    { id: "ig1", tenantId: "t1", type: "instagram", externalId: "i1", name: "ashaflowers", meta: { pageId: "p1", username: "ashaflowers" } },
  ];
  h.store.media.push({ id: "m1", tenantId: "t1", adAccountAssetId: "acc", kind: "image", status: "ready", sha256: "a".repeat(64) });
  Object.assign(h.state, { leftToday: 10_000_000n, leftMonth: 100_000_000n, daily: 10_000_000n, freeze: "none", demo: false, approvals: [], approved: false, launchError: null, activateError: null, ambiguous: false, calls: [] });
  (h.db.platformSetting as Body).upsert = vi.fn(async ({ where, create }: Body) => void (h.store.settings[where.key] = create.value));
  h.ads.createCampaignDraft.mockClear();
  as("admin");
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in unit tests"));
});

afterEach(() => fetchSpy.mockRestore());

describe("roles (6.1 rule 7)", () => {
  it.each(WRITES)("agents get 403 on %s", async (name, call) => {
    as("agent");
    const res = await call(req(METHOD(name), PATH(name), {}));
    expect(res.status).toBe(403);
    expect((await json(res)).error).toBe(PROMOTE_WRITERS_ONLY);
    expect(h.ads.createCampaignDraft).not.toHaveBeenCalled();
  });

  it("agents read drafts and the catalog, but not the settings", async () => {
    const d = await newDraft();
    as("agent");
    const res = await draftGET(req("GET", `/api/promote/drafts/${d.campaignId}`), ctx(d.campaignId));
    expect(res.status).toBe(200);
    expect((await json(res)).draft.text.primary).toBe("Fresh flowers every day");
    expect((await catalogGET(req("GET", "/api/promote/catalog"), undefined)).status).toBe(200);
    expect((await settingsGET(req("GET", "/api/promote/settings"), undefined)).status).toBe(403);
  });
});

describe("same origin", () => {
  it.each(WRITES)("%s refuses another site's request", async (name, call) => {
    const res = await call(req(METHOD(name), PATH(name), {}, { origin: EVIL }));
    expect(res.status).toBe(403);
    expect((await json(res)).error).toBe("This request could not be verified. Reload the page and try again.");
  });

  it("reads of a draft and of the settings refuse another site's page", async () => {
    const d = await newDraft();
    expect((await draftGET(req("GET", `/api/promote/drafts/${d.campaignId}`, undefined, { origin: EVIL }), ctx(d.campaignId))).status).toBe(403);
    expect((await settingsGET(req("GET", "/api/promote/settings", undefined, { "sec-fetch-site": "cross-site" }), undefined)).status).toBe(403);
  });
});

describe("drafts", () => {
  it("POST makes a draft with the defaults; PATCH with an old version gives 409 and the latest draft", async () => {
    const d = await newDraft();
    expect(d).toMatchObject({ surface: "promote", editable: true, draft: { goal: "website_visits", budget: { dailyMinor: "30000" } } });
    const first = await draftPATCH(req("PATCH", `/api/promote/drafts/${d.campaignId}`, { expectedUpdatedAt: d.updatedAt, set: { "text.headline": "Same-day delivery" } }), ctx(d.campaignId));
    expect(first.status).toBe(200);
    expect((await json(first)).before).toEqual({ "text.headline": "" });
    const stale = await draftPATCH(req("PATCH", `/api/promote/drafts/${d.campaignId}`, { expectedUpdatedAt: d.updatedAt, set: { "text.headline": "Old" } }), ctx(d.campaignId));
    expect(stale.status).toBe(409);
    const body = await json(stale);
    expect(body).toMatchObject({ code: "stale", error: "Someone else changed this draft. Showing the latest.", latest: { draft: { text: { headline: "Same-day delivery" } } } });
  });

  it("PATCH refuses a path that isn't a draft setting", async () => {
    const d = await newDraft();
    const res = await draftPATCH(req("PATCH", `/api/promote/drafts/${d.campaignId}`, { expectedUpdatedAt: d.updatedAt, set: { status: "active" } }), ctx(d.campaignId));
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: "That setting can't be changed here.", code: "unknown_path", path: "status" });
  });

  it("POST without a spending ad account answers the chip for the member's role", async () => {
    // No spending account for the guard's sandbox lookup nor for the defaults: the chip comes before anything about goals.
    h.db.spendControl.findUnique.mockResolvedValueOnce(null as never).mockResolvedValueOnce(null as never);
    as("owner");
    const res = await draftsPOST(req("POST", "/api/promote/drafts", { goal: "website_visits" }), undefined);
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: "no_spending_account", error: "Choose a spending ad account", chips: [{ key: "choose_spending_account", href: "/app/settings/spending" }] });
  });

  it("DELETE discards softly, and PATCH {restore: true} brings it back", async () => {
    const d = await newDraft();
    const del = await draftDELETE(req("DELETE", `/api/promote/drafts/${d.campaignId}`), ctx(d.campaignId));
    expect(del.status).toBe(200);
    expect(Object.keys(await json(del))).toEqual(["campaignId", "discardedAt", "restorableUntil"]);
    const back = await draftPATCH(req("PATCH", `/api/promote/drafts/${d.campaignId}`, { restore: true }), ctx(d.campaignId));
    expect(back.status).toBe(200);
    expect((await json(back)).discardedAt).toBeNull();
  });

  it("review, then start, end to end with fake ids under SPEND_DRY_RUN and no network call", async () => {
    process.env.SPEND_DRY_RUN = "1";
    const d = await newDraft();
    const review = await reviewPOST(req("POST", `/api/promote/drafts/${d.campaignId}/review`, {}), ctx(d.campaignId));
    expect(review.status).toBe(200);
    const { card } = await json(review);
    expect(card).toMatchObject({ state: "ready", canStart: true, dailyTotalMinor: "30000", worstCaseMinor: "262500" });
    const start = await startPOST(req("POST", `/api/promote/drafts/${d.campaignId}/start`, { confirmedTotalMinor: card.dailyTotalMinor, confirmedWorstCaseMinor: card.worstCaseMinor, materialHash: card.materialHash }), ctx(d.campaignId));
    expect(start.status).toBe(200);
    expect(await json(start)).toMatchObject({ state: "started" });
    expect(h.store.campaigns[0].metaCampaignId).toMatch(/^dryrun_/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the draft routes offer only the catalog's goals: PROMOTE_GOALS and the D22 verify states", async () => {
    const d = await newDraft();
    process.env.PROMOTE_GOALS = "website_visits,engagement";
    const lead = await draftsPOST(req("POST", "/api/promote/drafts", { goal: "lead_form" }), undefined);
    expect(lead.status).toBe(400);
    expect(await json(lead)).toMatchObject({ code: "goal_not_offered", error: "This goal isn't open yet. Choose another goal.", goals: ["website_visits", "engagement"] });
    const patch = await draftPATCH(req("PATCH", `/api/promote/drafts/${d.campaignId}`, { expectedUpdatedAt: d.updatedAt, set: { goal: "lead_form" } }), ctx(d.campaignId));
    expect(patch.status).toBe(400);
    expect((await json(patch)).code).toBe("goal_not_offered");
    // Off a sandbox account, rows only the documentation backs are not offered at all.
    delete process.env.PROMOTE_EXPERIMENTAL;
    const dark = await draftsPOST(req("POST", "/api/promote/drafts", { goal: "website_visits" }), undefined);
    expect(dark.status).toBe(409);
    expect(await json(dark)).toMatchObject({ code: "no_goals", error: "No goal is open for ads from here yet. Try again later." });
  });

  it("PATCH { categoryAnswer } is the member's answer to the special-category question", async () => {
    const d = await newDraft();
    const asked = await draftPATCH(req("PATCH", `/api/promote/drafts/${d.campaignId}`, { expectedUpdatedAt: d.updatedAt, set: { "text.primary": "Bouquets on no-cost EMI" } }), ctx(d.campaignId));
    expect(asked.status).toBe(400);
    expect(await json(asked)).toMatchObject({ code: "category_question", categories: ["credit"] });
    // The refused save left the version as it was.
    const answered = await draftPATCH(req("PATCH", `/api/promote/drafts/${d.campaignId}`, { expectedUpdatedAt: d.updatedAt, set: { "text.primary": "Bouquets on no-cost EMI" }, categoryAnswer: "none" }), ctx(d.campaignId));
    expect(answered.status).toBe(200);
    expect((await json(answered)).draft).toMatchObject({ specialAdCategory: "none", text: { primary: "Bouquets on no-cost EMI" } });
  });

  it("start is closed (403) until Start is open, before any check of the body", async () => {
    process.env.SPEND_ENFORCE = "observe";
    const res = await startPOST(req("POST", "/api/promote/drafts/c1/start", {}), ctx("c1"));
    expect(res.status).toBe(403);
    expect((await json(res)).error).toBe(PROMOTE_START_CLOSED);
  });
});

describe("rate limits (4.8)", () => {
  it("the 11th start in an hour gets 429", async () => {
    as("admin", "t-rate");
    h.state.demo = true;
    for (let i = 0; i < 10; i++) {
      const res = await startPOST(req("POST", "/api/promote/drafts/c1/start", {}), ctx("c1"));
      expect(res.status, `start ${i + 1}`).toBe(409);
      expect((await json(res)).state).toBe("demo");
    }
    const eleventh = await startPOST(req("POST", "/api/promote/drafts/c1/start", {}), ctx("c1"));
    expect(eleventh.status).toBe(429);
    expect((await json(eleventh)).error).toBe("That's a lot of starts in an hour. Wait a while, then try again.");
    // Another workspace has its own hour.
    as("admin", "t-other");
    expect((await startPOST(req("POST", "/api/promote/drafts/c1/start", {}), ctx("c1"))).status).toBe(409);
  });
});

describe("settings", () => {
  it("PUT refuses an http privacy link and saves an https one", async () => {
    const http = await settingsPUT(req("PUT", "/api/promote/settings", { privacyUrl: "http://shop.example/privacy" }), undefined);
    expect(http.status).toBe(400);
    expect((await json(http)).error).toBe("The link must start with https://");
    const ok = await settingsPUT(req("PUT", "/api/promote/settings", { privacyUrl: "https://shop.example/privacy", shop: { pincode: "400053", label: "Andheri" } }), undefined);
    expect(ok.status).toBe(200);
    expect((await json(ok)).settings).toMatchObject({ privacyUrl: "https://shop.example/privacy", shop: { pincode: "400053" } });
    const read = await settingsGET(req("GET", "/api/promote/settings"), undefined);
    expect((await json(read)).settings.privacyUrl).toBe("https://shop.example/privacy");
  });
});

describe("catalog", () => {
  it("allows agents and makes no Meta call; rows only the documentation backs show only for a sandbox account (D22)", async () => {
    as("agent");
    delete process.env.PROMOTE_EXPERIMENTAL;
    const dark = await json(await catalogGET(req("GET", "/api/promote/catalog?specs=1"), undefined));
    expect(dark.goals).toEqual([]);
    expect(dark.specs.limits).toMatchObject({ instagramCaption: 2200, instagramHashtags: 30 });
    process.env.PROMOTE_EXPERIMENTAL = "1";
    const res = await catalogGET(req("GET", "/api/promote/catalog?goal=lead_form&specs=1"), undefined);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.goals.map((g: Body) => g.key)).toContain("whatsapp_chats");
    expect(body.goals[0]).toMatchObject({ key: "whatsapp_chats", title: "Get WhatsApp chats" });
    expect(body.specs.goals.map((g: Body) => g.key)).toEqual(["lead_form"]);
    expect((await catalogGET(req("GET", "/api/promote/catalog?goal=nope"), undefined)).status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("PROMOTE_ENABLED=off", () => {
  const READS: [string, (r: Request) => Promise<Response>][] = [
    ["GET /api/promote/drafts/[id]", (r) => draftGET(r, ctx("c1"))],
    ["GET /api/promote/settings", (r) => settingsGET(r, undefined)],
    ["GET /api/promote/catalog", (r) => catalogGET(r, undefined)],
  ];
  it.each([...WRITES, ...READS])("%s answers 404", async (name, call) => {
    process.env.PROMOTE_ENABLED = "off";
    const res = await call(req(METHOD(name), PATH(name), METHOD(name) === "GET" ? undefined : {}));
    expect(res.status).toBe(404);
    expect((await json(res)).error).toBe(PROMOTE_NOT_FOUND);
  });
});
