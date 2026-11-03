import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

/**
 * docs/IG-PAGE-ADS-SPEC.md 3.1a, 3.3, 3.5, 3.9, 6.1 (rules 2, 4, 5, 6, 7, 15), 6.5, D4, D5, D34 and PRM-09 acceptance 2
 * (promote-service): Start runs launch, then the guarded activation with the sum of the versions' shares; a worst case 0.6%
 * higher gives 409 changed, 0.4% proceeds and lower proceeds with a note; typing is needed at 50% of this month's room and not
 * at 49%; a Phase 0 refusal comes back verbatim with its fixes; a refused activation leaves the campaign PAUSED; an unclear
 * answer is `unknown` and is never tried again; Start closed, the demo workspace and a pending client approval send nothing; a
 * fix copy pauses the original's ad set (or campaign) first so its commitment is stopped before the copy reserves, and the ad
 * alone (with a "frees no room" warning) only when its ad set keeps other ads; a card that isn't ready (frozen, no limit,
 * doesn't fit) is refused before anything is written; a lead goal makes one form across retries; a draft saved on Monday and
 * started on Thursday keeps its run length; an edit that lands between the checks and the launch gives 409 changed with the
 * campaign PAUSED and activation confirms exactly the confirmed total; a launch that failed part-way is finished by the next
 * Start or Save; the special-category answer is the member's own and covers only what was detected then; goals and places the
 * catalog doesn't offer (PROMOTE_GOALS, D22) can't be drafted or started; reviews and refused saves keep the draft's version;
 * SPEND_DRY_RUN makes no network call.
 *
 * ads/service (launch, activate, drafts), the Spend Book's headroom, readiness, lead forms, media and ads/actions are fakes that
 * record what they were asked; their own rules run in their own suites. The database is an in-memory fake.
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
    /** The launch fails after the campaign was created on Meta (status error with its Meta id stored). */
    launchPartial: false,
    /** The launch returns without launching (the campaign stays a draft). */
    launchNoop: false,
    activateError: null as unknown,
    ambiguous: false,
    updateError: null as unknown,
    calls: [] as string[],
    /** Phase 0 commitments by Meta object id: pausing an ad set or campaign stops them, pausing an ad does not (lowerCommitments). */
    commitments: {} as Record<string, string>,
    commitmentsAtActivate: null as Record<string, string> | null,
    /** Room each paused ad set gives back today (minor units). */
    freedToday: 0n,
    /** Runs inside the run, between the card's checks and the launch (a member's edit landing meanwhile). */
    onSend: null as null | (() => Promise<void>),
  };
  /** Catalog verify states (D22) the service sees: rows are proven ("sandbox") unless a test sets one back to "docs". */
  const verify: Record<string, string> = {};
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
      if (state.updateError) {
        // A refusal before ads/service's transaction: nothing is written.
        const e = state.updateError;
        state.updateError = null;
        throw e;
      }
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
      if (!["draft", "error", "launching"].includes(c.status)) throw new Error(`launch of a ${c.status} campaign`);
      if (state.launchError) {
        const e = state.launchError;
        state.launchError = null;
        c.status = "error";
        // Part-way: the campaign exists on Meta and its id is kept, so the next launch resumes it.
        if (state.launchPartial) c.metaCampaignId = `dryrun_campaign_${id}`;
        throw e;
      }
      if (state.launchNoop) return full(c);
      c.status = "paused";
      c.metaCampaignId = `dryrun_campaign_${id}`;
      for (const s of store.adSets.filter((x) => x.campaignId === id)) {
        s.metaAdSetId = `dryrun_adset_${s.id}`;
        for (const a of store.ads.filter((x) => x.adSetId === s.id)) a.metaAdId = `dryrun_ad_${a.id}`;
      }
      return full(c);
    }),
    pauseCampaign: vi.fn(async (_a: Row, id: string, _opts?: unknown) => {
      state.calls.push(`pauseCampaign:${id}`);
      const c = store.campaigns.find((r) => r.id === id)!;
      c.status = "paused";
      for (const s of store.adSets.filter((x) => x.campaignId === id)) if (s.metaAdSetId && s.metaAdSetId in state.commitments) state.commitments[s.metaAdSetId] = "stopped";
      return full(c);
    }),
    activateCampaign: vi.fn(async (_a: Row, id: string, input: Row) => {
      state.calls.push("activate");
      state.commitmentsAtActivate = { ...state.commitments };
      const { HttpError } = await import("@/lib/tenancy");
      const c = store.campaigns.find((r) => r.id === id)!;
      if (c.status !== "paused" || !c.metaCampaignId) throw new HttpError(409, "Only a launched, paused campaign can be activated.");
      if (input.confirm !== true || input.confirmedTotalMinor !== sum(c)) throw new HttpError(409, "confirm the exact amount");
      if (state.activateError) {
        if (state.ambiguous) c.status = "active";
        throw state.activateError;
      }
      c.status = "active";
      return full(c);
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
      if (state.onSend) {
        const hook = state.onSend;
        state.onSend = null;
        await hook();
      }
      return row;
    }),
    // Pausing an ad stops no commitment (lowerCommitments: level ad changes nothing).
    pauseAd: vi.fn(async (_t: string, metaAdId: string, _actor?: unknown, _opts?: unknown) => {
      state.calls.push(`pauseAd:${metaAdId}`);
      const ad = store.ads.find((a) => a.metaAdId === metaAdId);
      if (ad) ad.status = "paused";
      return { revertPayload: {} };
    }),
    pauseAdSet: vi.fn(async (_t: string, metaAdSetId: string, _actor?: unknown, _opts?: unknown) => {
      state.calls.push(`pauseAdSet:${metaAdSetId}`);
      const set = store.adSets.find((s) => s.metaAdSetId === metaAdSetId);
      if (set) set.status = "paused";
      if (metaAdSetId in state.commitments) state.commitments[metaAdSetId] = "stopped";
      if (state.leftToday !== null) state.leftToday += state.freedToday;
      return { revertPayload: {} };
    }),
    verify,
  };
});

vi.mock("@/lib/db", () => ({ prisma: h.db }));
vi.mock("@/lib/auth", () => ({ getActor: vi.fn() }));
vi.mock("@/lib/ads/service", () => h.ads);
vi.mock("@/lib/ads/actions", () => ({ pauseAd: (...a: unknown[]) => h.pauseAd(...(a as [string, string])), pauseAdSet: (...a: unknown[]) => h.pauseAdSet(...(a as [string, string])) }));
vi.mock("@/lib/promote/catalog/verified", async (original) => ({ ...(await original<Record<string, unknown>>()), verifyStateOf: (id: string) => h.verify[id] ?? "sandbox" }));
vi.mock("@/lib/spend/book", () => ({ adsHeadroomDetail: (...a: unknown[]) => h.headroom(...(a as [])) }));
vi.mock("@/lib/spend/demo", () => ({ isDemoWorkspace: async () => h.state.demo }));
vi.mock("@/lib/approvals", () => ({ listApprovals: async () => h.state.approvals, isCampaignClientApproved: async () => h.state.approved }));
vi.mock("@/lib/promote/prereqs", () => ({ checkPromotionSetup: (...a: unknown[]) => h.prereqs(...(a as [unknown, Row])) }));
vi.mock("@/lib/promote/lead-forms", () => ({ ensureDraftForm: (...a: unknown[]) => h.ensureDraftForm(...(a as [unknown, string])), copyForm: (...a: unknown[]) => h.copyForm(...a) }));
vi.mock("@/lib/promote/media", () => ({ sendAdMedia: (...a: unknown[]) => h.sendAdMedia(...(a as [Row])) }));

import { formatMoney } from "@/lib/promote/copy";
import { PROMOTE_START_CLOSED } from "@/lib/promote/route-guard";
import {
  createPromotionDraft,
  getPromotionDraft,
  reviewPromotion,
  roseMoreThanHalfPercent,
  savePromotionPaused,
  SERVICE_COPY,
  startPromotion,
  startStatus,
  typedMatches,
  updatePromotionDraft,
  type ReviewCard,
} from "@/lib/promote/service";
import { spendCopy } from "@/lib/spend/copy";
import { SpendBlockedError } from "@/lib/spend/errors";
import { HttpError } from "@/lib/tenancy";

const actor = { tenantId: "t1", userId: "u1", role: "admin" as const };
// Monday 26, Wednesday 28 and Thursday 29 Oct 2026, mid-morning in India.
const MON = new Date("2026-10-26T05:00:00Z");
const WED = new Date("2026-10-28T06:00:00Z");
const THU = new Date("2026-10-29T06:00:00Z");

const confirmOf = (card: ReviewCard, over: Record<string, unknown> = {}) => ({ confirmedTotalMinor: String(card.dailyTotalMinor), confirmedWorstCaseMinor: String(card.worstCaseMinor), materialHash: card.materialHash, ...over });

/** A website-visits draft: ₹300 a day for 5 days, one library picture. */
async function websiteDraft(over: Record<string, unknown> = {}, now = WED) {
  const set = { "text.primary": "Fresh flowers every day", "text.link": "https://shop.example/flowers", "media.feed": "m1", ...((over.set as Record<string, unknown>) ?? {}) };
  return createPromotionDraft(actor, { goal: "website_visits", days: 5, ...over, set }, { now });
}

let fetchSpy: MockInstance<typeof fetch>;

beforeEach(() => {
  process.env.PROMOTE_ENABLED = "on";
  process.env.SPEND_ENFORCE = "enforce";
  process.env.SPEND_TRIPWIRE = "enforce";
  delete process.env.SPEND_DRY_RUN;
  delete process.env.PROMOTE_GOALS;
  delete process.env.PROMOTE_EXPERIMENTAL;
  for (const k of Object.keys(h.verify)) delete h.verify[k];
  Object.assign(h.store, { campaigns: [], adSets: [], ads: [], media: [], forms: [], settings: {}, approvers: [], seq: 0 });
  h.store.assets = [
    { id: "acc", tenantId: "t1", type: "ad_account", externalId: "act_1", name: "Ads", meta: { currency: "INR", timezone: "Asia/Kolkata" } },
    { id: "page1", tenantId: "t1", type: "page", externalId: "p1", name: "Asha Flowers", meta: {} },
    { id: "ig1", tenantId: "t1", type: "instagram", externalId: "i1", name: "ashaflowers", meta: { pageId: "p1", username: "ashaflowers" } },
  ];
  h.store.media.push({ id: "m1", tenantId: "t1", adAccountAssetId: "acc", kind: "image", status: "ready", sha256: "a".repeat(64) });
  h.store.settings["promote:settings:t1"] = { privacyUrl: "https://shop.example/privacy" };
  Object.assign(h.state, {
    leftToday: 10_000_000n,
    leftMonth: 100_000_000n,
    daily: 10_000_000n,
    freeze: "none",
    demo: false,
    approvals: [],
    approved: false,
    launchError: null,
    launchPartial: false,
    launchNoop: false,
    activateError: null,
    ambiguous: false,
    updateError: null,
    calls: [],
    commitments: {},
    commitmentsAtActivate: null,
    freedToday: 0n,
    onSend: null,
  });
  h.db.brand.findFirst.mockReset().mockResolvedValue(null as never);
  h.db.brand.findMany.mockReset().mockResolvedValue([] as never);
  for (const fn of [h.ads.createCampaignDraft, h.ads.updateCampaignDraft, h.ads.launchCampaign, h.ads.activateCampaign, h.ads.pauseCampaign, h.ads.validateCampaign, h.ensureDraftForm, h.copyForm, h.sendAdMedia, h.pauseAd, h.pauseAdSet, h.prereqs, h.headroom]) fn.mockClear();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in unit tests"));
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe("createPromotionDraft", () => {
  it("saves through ads/service with origin human, surface promote and the smart defaults", async () => {
    const d = await websiteDraft();
    const input = h.ads.createCampaignDraft.mock.calls[0][1] as Row;
    expect(input).toMatchObject({ origin: "human", surface: "promote", adAccountAssetId: "acc", goal: "website_visits", runDays: 5, startMode: "now", dailyBudgetMinor: 30_000, placementMode: "auto", specialAdCategory: "none" });
    expect(input.targeting).toMatchObject({ geo: { countries: ["IN"] }, ageMin: 18, advantageAudience: true });
    expect(input.ads[0].creative).toMatchObject({ pageId: "p1", instagramId: "i1", message: "Fresh flowers every day", link: "https://shop.example/flowers", media: { feed: "m1" }, format: "single_image" });
    expect(d.draft).toMatchObject({ goal: "website_visits", budget: { dailyMinor: "30000" }, run: { runDays: 5, startMode: "now" } });
    // The whole draft is kept on the ads, so values the rows can't hold survive a reload.
    expect(h.store.ads[0].creative.promote).toMatchObject({ v: 1, pageAssetId: "page1", igAssetId: "ig1", provenance: { "text.primary": "member", "text.link": "member" } });
  });

  it("Eddy's drafts carry surface eddy and mark the texts as written by Eddy", async () => {
    await createPromotionDraft(actor, { goal: "website_visits", set: { "text.primary": "Hi", "text.link": "https://x.example" } }, { surface: "eddy", now: WED });
    expect((h.ads.createCampaignDraft.mock.calls[0][1] as Row).surface).toBe("eddy");
    expect(h.store.ads[0].creative.promote.provenance["text.primary"]).toBe("eddy");
  });

  it("refuses agents, unknown paths, and asks the special-category question instead of failing the save", async () => {
    await expect(createPromotionDraft({ ...actor, role: "agent" }, {}, { now: WED })).rejects.toMatchObject({ status: 403 });
    await expect(websiteDraft({ set: { "budget.lifetime": 5 } })).rejects.toMatchObject({ code: "unknown_path" });
    await expect(websiteDraft({ set: { "text.primary": "Home loans at low interest rates" } })).rejects.toMatchObject({ status: 400, code: "category_question", message: "Is this ad about jobs, housing, loans or credit? Meta has special rules for these." });
    // A create body that merely carries the key is not an answer.
    await expect(websiteDraft({ set: { "text.primary": "Home loans at low interest rates", specialAdCategory: "none" } })).rejects.toMatchObject({ code: "category_question" });
    expect(h.ads.createCampaignDraft).not.toHaveBeenCalled();
    // The member's own answer on the page is the acknowledgement ads/service needs, and only for the terms: no brand kit was overridden.
    await websiteDraft({ set: { "text.primary": "Home loans at low interest rates" }, categoryAnswer: "none" });
    expect(h.ads.createCampaignDraft.mock.calls[0][1]).toMatchObject({ specialAdCategory: "none", confirmNoSpecialCategory: false, acknowledgeSpecialCategoryTerms: true });
    expect(h.store.ads[0].creative.promote.categoryAck).toMatchObject({ answer: "none", brand: null });
  });

  it("needs a spending ad account: an admin is told to ask the owner", async () => {
    h.db.spendControl.findUnique.mockResolvedValueOnce(null as never);
    await expect(websiteDraft()).rejects.toMatchObject({ status: 409, code: "no_spending_account", message: "Ask Asha to choose a spending ad account" });
  });
});

describe("updatePromotionDraft", () => {
  it("accepts draft paths only, returns the before values, and refuses a stale write with the latest draft", async () => {
    const d = await websiteDraft();
    const out = await updatePromotionDraft(actor, d.campaignId, { expectedUpdatedAt: d.updatedAt, set: { "text.headline": "Same-day delivery" } });
    expect(out.before).toEqual({ "text.headline": "" });
    expect(h.store.ads[0].creative.headline).toBe("Same-day delivery");
    await expect(updatePromotionDraft(actor, d.campaignId, { expectedUpdatedAt: out.updatedAt, set: { status: "active" } })).rejects.toMatchObject({ code: "unknown_path" });
    const stale = updatePromotionDraft(actor, d.campaignId, { expectedUpdatedAt: d.updatedAt, set: { "text.headline": "Old" } });
    await expect(stale).rejects.toMatchObject({ status: 409, code: "stale", message: "Someone else changed this draft. Showing the latest." });
    await expect(stale.catch((e) => e.extra.latest.draft.text.headline)).resolves.toBe("Same-day delivery");
  });

  it("a review on a later day moves the dates but keeps the draft's version, so the next edit isn't taken for someone else's", async () => {
    const d = await websiteDraft({ days: 7 }, MON);
    const c = h.store.campaigns[0];
    await reviewPromotion(actor, d.campaignId, { now: THU });
    expect(c.endsAt.toISOString()).toBe("2026-11-04T18:29:00.000Z");
    expect(c.updatedAt.toISOString()).toBe(d.updatedAt);
    const out = await updatePromotionDraft(actor, d.campaignId, { expectedUpdatedAt: d.updatedAt, set: { "text.headline": "Same-day delivery" } }, { now: THU });
    expect(out.draft).toMatchObject({ text: { headline: "Same-day delivery" } });
  });

  it("a save that fails leaves the version as it was, so the member's next edit goes through", async () => {
    const d = await websiteDraft();
    h.state.updateError = new HttpError(400, "Your ad copy, links or brand industry suggest the credit special ad category, but you declared none.");
    const failed = updatePromotionDraft(actor, d.campaignId, { expectedUpdatedAt: d.updatedAt, set: { "text.headline": "Pay in parts" } }, { now: WED });
    await expect(failed).rejects.toMatchObject({ status: 400, code: "category_question" });
    expect(h.store.campaigns[0].updatedAt.toISOString()).toBe(d.updatedAt);
    const out = await updatePromotionDraft(actor, d.campaignId, { expectedUpdatedAt: d.updatedAt, set: { "text.headline": "Same-day delivery" } }, { now: WED });
    expect(out.draft).toMatchObject({ text: { headline: "Same-day delivery" } });
    expect(out.updatedAt).not.toBe(d.updatedAt);
  });
});

describe("the special-category answer (3.1, D9)", () => {
  const latest = (id: string) => h.store.campaigns.find((c) => c.id === id)!.updatedAt.toISOString();

  it("covers what was detected when the member gave it: a text with new category terms asks again", async () => {
    const d = await websiteDraft({ set: { "text.primary": "Bouquets on no-cost EMI" }, categoryAnswer: "none" });
    expect(h.ads.createCampaignDraft.mock.calls[0][1]).toMatchObject({ acknowledgeSpecialCategoryTerms: true });
    // Another field changes: the answer still covers the EMI text.
    await updatePromotionDraft(actor, d.campaignId, { expectedUpdatedAt: latest(d.campaignId), set: { "text.headline": "Same-day delivery" } }, { now: WED });
    expect(h.ads.updateCampaignDraft.mock.calls.at(-1)![2]).toMatchObject({ specialAdCategory: "none", acknowledgeSpecialCategoryTerms: true });
    // The text now says something else that suggests credit: asked again, nothing saved.
    const calls = h.ads.updateCampaignDraft.mock.calls.length;
    await expect(updatePromotionDraft(actor, d.campaignId, { expectedUpdatedAt: latest(d.campaignId), set: { "text.primary": "Instant personal loans" } }, { now: WED })).rejects.toMatchObject({ code: "category_question", extra: { categories: ["credit"] } });
    expect(h.ads.updateCampaignDraft.mock.calls.length).toBe(calls);
    // Answered again on the page, it saves.
    await updatePromotionDraft(actor, d.campaignId, { expectedUpdatedAt: latest(d.campaignId), set: { "text.primary": "Instant personal loans" }, categoryAnswer: "none" }, { now: WED });
    expect(h.store.ads[0].creative.message).toBe("Instant personal loans");
  });

  it("an answer Eddy gives is never the member's: categoryAnswer from Eddy is refused, and none set by Eddy asks the question", async () => {
    await expect(createPromotionDraft(actor, { goal: "website_visits", set: { "text.primary": "Instant personal loans", specialAdCategory: "none" }, categoryAnswer: "none" }, { surface: "eddy", now: WED })).rejects.toMatchObject({
      status: 403,
      code: "member_answers",
      message: SERVICE_COPY.memberAnswers,
    });
    await expect(createPromotionDraft(actor, { goal: "website_visits", set: { "text.primary": "Instant personal loans", specialAdCategory: "none" } }, { surface: "eddy", now: WED })).rejects.toMatchObject({ code: "category_question" });
    // A draft whose texts were fine: Eddy rewriting them with loan words and setting none is asked about too.
    const d = await websiteDraft();
    await expect(
      updatePromotionDraft(actor, d.campaignId, { expectedUpdatedAt: latest(d.campaignId), set: { "text.primary": "Instant personal loans", specialAdCategory: "none" } }, { surface: "eddy", now: WED }),
    ).rejects.toMatchObject({ code: "category_question" });
    // Eddy may set a real category: that only adds Meta's rules.
    await updatePromotionDraft(actor, d.campaignId, { expectedUpdatedAt: latest(d.campaignId), set: { "text.primary": "Instant personal loans", specialAdCategory: "credit" } }, { surface: "eddy", now: WED });
    expect(h.ads.updateCampaignDraft.mock.calls.at(-1)![2]).toMatchObject({ specialAdCategory: "credit", confirmNoSpecialCategory: false, acknowledgeSpecialCategoryTerms: false });
  });

  it("the brand kit's category is overridden only by the member's own answer", async () => {
    h.db.brand.findFirst.mockResolvedValue({ specialAdCategory: "credit" } as never);
    const d = await websiteDraft();
    expect(h.ads.createCampaignDraft.mock.calls[0][1]).toMatchObject({ specialAdCategory: "credit", confirmNoSpecialCategory: false });
    // Eddy setting none is not an override.
    await expect(updatePromotionDraft(actor, d.campaignId, { expectedUpdatedAt: latest(d.campaignId), set: { specialAdCategory: "none" } }, { surface: "eddy", now: WED })).rejects.toMatchObject({ code: "category_question", extra: { categories: ["credit"] } });
    // The member choosing none on the page is.
    await updatePromotionDraft(actor, d.campaignId, { expectedUpdatedAt: latest(d.campaignId), set: { specialAdCategory: "none" } }, { now: WED });
    expect(h.ads.updateCampaignDraft.mock.calls.at(-1)![2]).toMatchObject({ specialAdCategory: "none", confirmNoSpecialCategory: true });
  });

  it("the card is blocked when something the answer doesn't cover turns up later (a brand industry)", async () => {
    const d = await websiteDraft();
    const ready = await reviewPromotion(actor, d.campaignId, { now: WED });
    expect(ready).toMatchObject({ state: "ready", policy: { unanswered: [] } });
    h.db.brand.findMany.mockResolvedValue([{ industry: "Personal loans", bannedWords: [] }] as never);
    const card = await reviewPromotion(actor, d.campaignId, { now: WED });
    expect(card).toMatchObject({ state: "blocked", canStart: false, policy: { unanswered: ["credit"] } });
    expect(card.issues).toContain("Is this ad about jobs, housing, loans or credit? Meta has special rules for these.");
    expect(await startPromotion(actor, d.campaignId, confirmOf(card), { now: WED })).toMatchObject({ state: "not_ready" });
    expect(h.state.calls).toEqual([]);
  });
});

describe("goals and places the member is offered (PROMOTE_GOALS, D22)", () => {
  it("a goal at verify state docs can't be drafted, chosen in an edit, or started", async () => {
    h.verify["goal.lead_form"] = "docs";
    await expect(createPromotionDraft(actor, { goal: "lead_form", set: { "text.primary": "Book a trial class" } }, { now: WED })).rejects.toMatchObject({ status: 400, code: "goal_not_offered", message: SERVICE_COPY.goalNotOffered });
    const d = await websiteDraft();
    await expect(createPromotionDraft(actor, { goal: "website_visits", set: { goal: "lead_form" } }, { now: WED })).rejects.toMatchObject({ code: "goal_not_offered" });
    await expect(updatePromotionDraft(actor, d.campaignId, { expectedUpdatedAt: d.updatedAt, set: { goal: "lead_form" } }, { now: WED })).rejects.toMatchObject({ status: 400, code: "goal_not_offered" });
    expect(h.ads.updateCampaignDraft).not.toHaveBeenCalled();

    // The draft's own goal stops being offered after the review: Start is refused before anything is sent.
    const card = await reviewPromotion(actor, d.campaignId, { now: WED });
    h.verify["goal.website_visits"] = "docs";
    const blocked = await reviewPromotion(actor, d.campaignId, { now: WED });
    expect(blocked).toMatchObject({ state: "blocked", canStart: false });
    expect(blocked.issues).toContain(SERVICE_COPY.goalNotOffered);
    expect(await startPromotion(actor, d.campaignId, confirmOf(card), { now: WED })).toEqual({ state: "not_ready", message: SERVICE_COPY.goalNotOffered, issues: [SERVICE_COPY.goalNotOffered] });
    expect(await savePromotionPaused(actor, d.campaignId, { materialHash: card.materialHash }, { now: WED })).toMatchObject({ state: "not_ready" });
    expect(h.state.calls).toEqual([]);
    // Other edits of that draft still save (its card stays blocked).
    await updatePromotionDraft(actor, d.campaignId, { expectedUpdatedAt: h.store.campaigns[0].updatedAt.toISOString(), set: { "text.headline": "Same-day delivery" } }, { now: WED });
  });

  it("PROMOTE_GOALS leaves a goal out; with no goal open at all, no draft is made", async () => {
    process.env.PROMOTE_GOALS = "website_visits,engagement";
    await expect(createPromotionDraft(actor, { goal: "whatsapp_chats" }, { now: WED })).rejects.toMatchObject({ code: "goal_not_offered" });
    // The default goal is picked from the offered ones: the number is linked to the Page, but WhatsApp chats aren't offered.
    h.store.assets[1].meta = { whatsappLinkState: "ok" };
    const d = await createPromotionDraft(actor, {}, { now: WED });
    expect(d.draft).toMatchObject({ goal: "engagement" });
    for (const key of ["website_visits", "engagement"]) h.verify[`goal.${key}`] = "docs";
    await expect(createPromotionDraft(actor, {}, { now: WED })).rejects.toMatchObject({ status: 409, code: "no_goals", message: SERVICE_COPY.noGoals });
  });

  it("chosen places at verify state docs are refused, and show only with PROMOTE_EXPERIMENTAL on a sandbox account", async () => {
    h.verify["placement.instagram_reels"] = "docs";
    const set = { "placements.mode": "custom", "placements.positions": ["instagram_feed", "instagram_reels"] };
    await expect(websiteDraft({ set })).rejects.toMatchObject({ status: 400, code: "places_not_offered", message: "These places aren't open yet: Instagram Reels. Choose Automatic or other places." });
    const d = await websiteDraft();
    await expect(updatePromotionDraft(actor, d.campaignId, { expectedUpdatedAt: d.updatedAt, set }, { now: WED })).rejects.toMatchObject({ code: "places_not_offered" });
    process.env.PROMOTE_EXPERIMENTAL = "1";
    h.store.assets[0].sandbox = true;
    await updatePromotionDraft(actor, d.campaignId, { expectedUpdatedAt: d.updatedAt, set }, { now: WED });
    expect(h.ads.updateCampaignDraft).toHaveBeenCalledTimes(1);
  });
});

describe("startPromotion: launch, then the guarded activation (6.1 rule 2)", () => {
  it("runs launch, then activate, confirming the sum of the versions' shares (₹290 three ways is ₹96 each, ₹288)", async () => {
    const version = (letter: string) => ({ text: { primary: `Version ${letter}`, link: "https://shop.example/flowers" }, media: { feed: "m1" } });
    const d = await websiteDraft({ set: { "budget.dailyMinor": 29_000, "compare.mode": "fair_split", "versions.B": version("B"), "versions.C": version("C") } });
    const card = await reviewPromotion(actor, d.campaignId, { now: WED });
    expect(card.dailyTotalMinor).toBe(28_800n);
    expect(card.facts.find((f) => f.key === "versions")?.value).toBe("A, B, C · ₹96 each");
    const out = await startPromotion(actor, d.campaignId, confirmOf(card), { now: WED });
    expect(out).toMatchObject({ state: "started", message: "Sent to Meta. Meta is reviewing it." });
    expect(startStatus(out)).toBe(200);
    expect(h.state.calls).toEqual(["launch", "activate"]);
    expect(h.ads.activateCampaign.mock.calls[0][2]).toEqual({ confirm: true, confirmedTotalMinor: 28_800 });
  });

  it("a worst case 0.6% higher than the card gives 409 changed with a new card; 0.4% proceeds; lower proceeds with a note", async () => {
    const d = await websiteDraft();
    const card = await reviewPromotion(actor, d.campaignId, { now: WED });
    expect(card.worstCaseMinor).toBe(262_500n);
    const shown = (pct: bigint) => String((card.worstCaseMinor * 1000n) / (1000n + pct));
    expect(roseMoreThanHalfPercent(262_500n, (262_500n * 1000n) / 1006n)).toBe(true);
    const higher = await startPromotion(actor, d.campaignId, confirmOf(card, { confirmedWorstCaseMinor: shown(6n) }), { now: WED });
    expect(higher).toMatchObject({ state: "changed", changed: ["worstCaseMinor"] });
    expect(startStatus(higher)).toBe(409);
    expect((higher as { card: ReviewCard }).card.materialHash).toBe(card.materialHash);
    expect(h.state.calls).toEqual([]);
    expect(await startPromotion(actor, d.campaignId, confirmOf(card, { confirmedWorstCaseMinor: shown(4n) }), { now: WED })).toMatchObject({ state: "started" });

    const d2 = await websiteDraft();
    const card2 = await reviewPromotion(actor, d2.campaignId, { now: WED });
    const lower = await startPromotion(actor, d2.campaignId, confirmOf(card2, { confirmedWorstCaseMinor: "300000" }), { now: WED });
    expect(lower).toMatchObject({ state: "started", note: `The most these ads can spend is now lower: ${formatMoney(262_500n, "INR")}.` });
  });

  it("asks for the typed figure at 50% of this month's room, not at 49%", async () => {
    const d = await websiteDraft();
    const month = (await reviewPromotion(actor, d.campaignId, { now: WED })).cost!.worstMonthMinor;
    expect(month).toBe(210_000n);
    h.state.leftMonth = month * 2n;
    const half = await reviewPromotion(actor, d.campaignId, { now: WED });
    expect(half.typedConfirmRequired).toBe(true);
    const typed = await startPromotion(actor, d.campaignId, confirmOf(half), { now: WED });
    expect(typed).toMatchObject({ state: "typed_confirm", message: "Type ₹2,625 to confirm. This uses a large part of what is left this month." });
    expect(h.state.calls).toEqual([]);
    expect(await startPromotion(actor, d.campaignId, confirmOf(half, { typedWorstCase: "₹2,625" }), { now: WED })).toMatchObject({ state: "started" });

    const d2 = await websiteDraft();
    h.state.leftMonth = (month * 100n + 48n) / 49n;
    const under = await reviewPromotion(actor, d2.campaignId, { now: WED });
    expect(under.typedConfirmRequired).toBe(false);
    expect(await startPromotion(actor, d2.campaignId, confirmOf(under), { now: WED })).toMatchObject({ state: "started" });
  });

  it("matches the typed figure as shown, with or without the symbol and commas", () => {
    expect(typedMatches("₹2,625", 262_500n, "INR")).toBe(true);
    expect(typedMatches("2625", 262_500n, "INR")).toBe(true);
    expect(typedMatches(2625, 262_500n, "INR")).toBe(true);
    expect(typedMatches("2,600", 262_500n, "INR")).toBe(false);
    expect(typedMatches("2625.50", 262_550n, "INR")).toBe(true);
    expect(typedMatches("2626", 262_550n, "INR")).toBe(true);
    expect(typedMatches(undefined, 262_500n, "INR")).toBe(false);
  });

  it("an edit that lands between the checks and the launch is caught: 409 changed, still PAUSED, nothing turned on", async () => {
    h.store.media[0].status = "pending";
    const d = await websiteDraft();
    const card = await reviewPromotion(actor, d.campaignId, { now: WED });
    // While the picture is sent to Meta, another tab (or Eddy) raises the budget to ₹3,000 a day.
    h.state.onSend = async () => {
      const c = h.store.campaigns.find((x) => x.id === d.campaignId)!;
      await updatePromotionDraft(actor, d.campaignId, { expectedUpdatedAt: c.updatedAt.toISOString(), set: { "budget.dailyMinor": 300_000 } }, { now: WED });
    };
    const out = await startPromotion(actor, d.campaignId, confirmOf(card), { now: WED });
    expect(out).toMatchObject({ state: "changed", message: "Something changed since you looked. Check the new figures and tap Start again." });
    expect((out as { changed: string[] }).changed).toContain("sets");
    expect(h.state.calls).toEqual(["sendAdMedia:m1", "launch"]);
    expect(h.ads.activateCampaign).not.toHaveBeenCalled();
    expect(h.store.campaigns[0].status).toBe("paused");
    // The new card shows what is on Meta; starting from it confirms that total, and activation gets exactly the confirmed figure.
    const fresh = (out as { card: ReviewCard }).card;
    expect(fresh.dailyTotalMinor).toBe(300_000n);
    expect(await startPromotion(actor, d.campaignId, confirmOf(fresh), { now: WED })).toMatchObject({ state: "started" });
    expect(h.ads.activateCampaign.mock.calls[0][2]).toEqual({ confirm: true, confirmedTotalMinor: 300_000 });
  });

  it("a launch that failed after the campaign was made on Meta is finished by the next Start", async () => {
    const d = await websiteDraft();
    const card = await reviewPromotion(actor, d.campaignId, { now: WED });
    h.state.launchError = new HttpError(502, "Could not create the ad set: Meta is busy. Objects already created on Meta were saved; launch again to continue.");
    h.state.launchPartial = true;
    expect(await startPromotion(actor, d.campaignId, confirmOf(card), { now: WED })).toMatchObject({ state: "failed", paused: false });
    expect(h.store.campaigns[0]).toMatchObject({ status: "error", metaCampaignId: `dryrun_campaign_${d.campaignId}` });
    expect(await startPromotion(actor, d.campaignId, confirmOf(card), { now: WED })).toMatchObject({ state: "started" });
    expect(h.state.calls).toEqual(["launch", "launch", "activate"]);
  });
});

describe("refusals (6.1 rule 2, 6.2)", () => {
  it("a spend.daily_limit refusal returns Phase 0's copy verbatim with [Lower to ₹280 a day], and the campaign stays PAUSED", async () => {
    const d = await websiteDraft();
    const card = await reviewPromotion(actor, d.campaignId, { now: WED });
    const params = { left: { minor: 50_000n, currency: "INR" }, needs: { minor: 52_500n, currency: "INR" } };
    h.state.activateError = new SpendBlockedError("spend.daily_limit", params);
    const out = await startPromotion(actor, d.campaignId, confirmOf(card), { now: WED });
    expect(out).toMatchObject({ state: "refused", code: "spend.daily_limit", message: spendCopy("spend.daily_limit", params), paused: true });
    const fixes = (out as { fixes: { kind: string; toMinor?: bigint; label: string }[] }).fixes;
    expect(fixes.map((f) => f.kind)).toEqual(["lower_daily", "ask_owner"]);
    expect(fixes[0]).toMatchObject({ toMinor: 28_000n, label: "Lower to ₹280 a day" });
    expect(fixes[1].label).toBe("Ask Asha to raise the limit");
    expect(startStatus(out)).toBe(409);
    // Launch created everything PAUSED; the refused activation left it that way.
    expect(h.store.campaigns.find((c) => c.id === d.campaignId)!.status).toBe("paused");
    expect(h.state.calls).toEqual(["launch", "activate"]);
  });

  it("a refusal before anything is created (the launch's own check) says nothing is paused on Meta", async () => {
    const d = await websiteDraft();
    const card = await reviewPromotion(actor, d.campaignId, { now: WED });
    h.state.launchError = new SpendBlockedError("spend.monthly_limit", { left: { minor: 100_000n, currency: "INR" } });
    const out = await startPromotion(actor, d.campaignId, confirmOf(card), { now: WED });
    expect(out).toMatchObject({ state: "refused", code: "spend.monthly_limit", paused: false });
    expect(h.ads.activateCampaign).not.toHaveBeenCalled();
  });

  it("activation refused after launch leaves the campaign PAUSED, and [Try again] only re-runs the activation", async () => {
    const d = await websiteDraft();
    const card = await reviewPromotion(actor, d.campaignId, { now: WED });
    h.state.activateError = new SpendBlockedError("spend.busy" as never);
    const busy = await startPromotion(actor, d.campaignId, confirmOf(card), { now: WED });
    expect(busy).toMatchObject({ state: "refused", code: "spend.busy", paused: true, fixes: [{ kind: "retry", label: "Try again" }] });
    expect(h.store.campaigns[0].status).toBe("paused");
    h.state.activateError = null;
    const again = await startPromotion(actor, d.campaignId, confirmOf(card), { now: WED });
    expect(again).toMatchObject({ state: "started" });
    expect(h.state.calls).toEqual(["launch", "activate", "activate"]);
  });

  it("an unclear final answer is `unknown` and is never tried again", async () => {
    const d = await websiteDraft();
    const card = await reviewPromotion(actor, d.campaignId, { now: WED });
    h.state.activateError = new HttpError(502, "Meta did not confirm the activation and it may have gone through.");
    h.state.ambiguous = true;
    const out = await startPromotion(actor, d.campaignId, confirmOf(card), { now: WED });
    expect(out).toMatchObject({ state: "unknown", message: "It isn't certain whether this went through. It's being checked, and it won't be tried again automatically." });
    expect(startStatus(out)).toBe(202);
    expect(h.ads.activateCampaign).toHaveBeenCalledTimes(1);
    expect(h.ads.launchCampaign).toHaveBeenCalledTimes(1);
  });

  it("a card that doesn't fit is refused with Phase 0's copy and fixes before anything is written (no picture, no form, no ad)", async () => {
    h.store.media[0].status = "pending";
    const d = await createPromotionDraft(actor, { goal: "lead_form", days: 5, set: { "text.primary": "Book a trial class", "media.feed": "m1" } }, { now: WED });
    h.state.leftToday = 50_000n;
    const card = await reviewPromotion(actor, d.campaignId, { now: WED });
    expect(card).toMatchObject({ state: "doesnt_fit", canStart: false });
    const out = await startPromotion(actor, d.campaignId, confirmOf(card), { now: WED });
    expect(out).toMatchObject({ state: "refused", code: "spend.daily_limit", message: card.stateText, paused: false, formCreated: false });
    expect((out as { fixes: { kind: string }[] }).fixes.map((f) => f.kind)).toContain("lower_daily");
    expect(h.state.calls).toEqual([]);
    expect(h.ensureDraftForm).not.toHaveBeenCalled();
    expect(h.store.campaigns[0].status).toBe("draft");
  });

  it("no limit set: refused with Phase 0's copy before anything is written", async () => {
    const d = await websiteDraft();
    const card = await reviewPromotion(actor, d.campaignId, { now: WED });
    h.state.daily = null;
    const out = await startPromotion(actor, d.campaignId, confirmOf(card), { now: WED });
    expect(out).toMatchObject({ state: "refused", code: "spend.no_limit", message: spendCopy("spend.no_limit"), paused: false });
    expect(h.state.calls).toEqual([]);
  });
});

describe("who may start, and what is never sent (6.1 rules 7, 15)", () => {
  it("Start closed (canStart false) gives the refusal copy and makes no Meta call", async () => {
    const d = await websiteDraft();
    const card = await reviewPromotion(actor, d.campaignId, { now: WED });
    expect(card.state).toBe("ready");
    process.env.SPEND_ENFORCE = "observe";
    const closed = await reviewPromotion(actor, d.campaignId, { now: WED });
    expect(closed).toMatchObject({ state: "start_closed", canStart: false, stateText: PROMOTE_START_CLOSED });
    const out = await startPromotion(actor, d.campaignId, confirmOf(card), { now: WED });
    expect(out).toEqual({ state: "start_closed", message: PROMOTE_START_CLOSED });
    expect(startStatus(out)).toBe(403);
    for (const fn of [h.ads.launchCampaign, h.ads.activateCampaign, h.pauseAd, h.sendAdMedia, h.ensureDraftForm]) expect(fn).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("agents get 403; the demo workspace is refused; a pending client approval gives awaiting_approval", async () => {
    const d = await websiteDraft();
    const card = await reviewPromotion(actor, d.campaignId, { now: WED });
    await expect(startPromotion({ ...actor, role: "agent" }, d.campaignId, confirmOf(card), { now: WED })).rejects.toMatchObject({ status: 403 });
    await expect(reviewPromotion({ ...actor, role: "agent" }, d.campaignId, { now: WED })).rejects.toMatchObject({ status: 403 });
    h.state.demo = true;
    expect(await startPromotion(actor, d.campaignId, confirmOf(card), { now: WED })).toEqual({ state: "demo", message: "This is a demo workspace, so nothing is sent to Meta." });
    h.state.demo = false;
    h.state.approvals = [{ id: "ap1", status: "pending" }];
    expect((await reviewPromotion(actor, d.campaignId, { now: WED })).warnings.map((w) => w.code)).toContain("needs_approval");
    expect(await startPromotion(actor, d.campaignId, confirmOf(card), { now: WED })).toEqual({ state: "awaiting_approval", message: "Waiting for your client's OK" });
    expect(h.state.calls).toEqual([]);
  });

  it("an old-wizard campaign is not started through Promote (it keeps its own typed-total flow)", async () => {
    const d = await websiteDraft();
    const card = await reviewPromotion(actor, d.campaignId, { now: WED });
    h.store.campaigns[0].surface = "wizard";
    await expect(startPromotion(actor, d.campaignId, confirmOf(card), { now: WED })).rejects.toMatchObject({ status: 409, message: SERVICE_COPY.notPromoteDraft });
    await expect(savePromotionPaused(actor, d.campaignId, { materialHash: card.materialHash }, { now: WED })).rejects.toMatchObject({ status: 409 });
    expect(h.state.calls).toEqual([]);
  });

  it("through Eddy, only the owner or a named approver may confirm", async () => {
    const d = await websiteDraft();
    const card = await reviewPromotion(actor, d.campaignId, { now: WED });
    expect(await startPromotion(actor, d.campaignId, confirmOf(card), { now: WED, via: "eddy" })).toMatchObject({ state: "needs_approver" });
    h.store.approvers = ["u1"];
    expect(await startPromotion(actor, d.campaignId, confirmOf(card), { now: WED, via: "eddy" })).toMatchObject({ state: "started" });
  });
});

describe("fix copies, lead forms, media and dates", () => {
  /**
   * A draft that fixes the rejected ad "Old offer" (5.4 replacesAdIds), as [Fix the ad] makes it. The original runs in the ad set
   * "Old set" of the campaign "Diwali"; with `sibling` that ad set also runs another ad, with `otherSet` the campaign has a
   * second ad set. Phase 0 counts each ad set as a live commitment.
   */
  async function fixCopy(o: { sibling?: boolean; otherSet?: boolean } = {}) {
    const old = { tenantId: "t1", createdAt: new Date(0), creative: {} };
    h.store.campaigns.push({ id: "old_c", tenantId: "t1", name: "Diwali", status: "active", surface: "wizard", metaCampaignId: "meta_old_c", createdAt: new Date(0), updatedAt: new Date(0) });
    h.store.adSets.push({ ...old, id: "old_set", campaignId: "old_c", name: "Old set", metaAdSetId: "meta_old_set", status: "active" });
    h.store.ads.push({ ...old, id: "orig", adSetId: "old_set", name: "Old offer", metaAdId: "meta_orig", status: "active" });
    if (o.sibling) h.store.ads.push({ ...old, id: "sib", adSetId: "old_set", name: "Still fine", metaAdId: "meta_sib", status: "active" });
    if (o.otherSet) {
      h.store.adSets.push({ ...old, id: "other_set", campaignId: "old_c", name: "Other set", metaAdSetId: "meta_other_set", status: "active" });
      h.store.ads.push({ ...old, id: "other", adSetId: "other_set", name: "Other ad", metaAdId: "meta_other", status: "active" });
    }
    h.state.commitments = { meta_old_set: "live", ...(o.otherSet ? { meta_other_set: "live" } : {}) };
    const d = await websiteDraft();
    for (const ad of h.store.ads.filter((a) => a.adSetId !== "old_set" && a.adSetId !== "other_set")) ad.creative = { ...ad.creative, replacesAdIds: ["orig"] };
    return d;
  }

  it("a fix copy pauses the original's ad set (a lowering) before the launch, so its room is freed before the copy reserves", async () => {
    const d = await fixCopy({ otherSet: true });
    const card = await reviewPromotion(actor, d.campaignId, { now: WED });
    expect(card.facts.map((f) => f.value)).toContain("Also pauses the rejected ad 'Old offer'");
    expect(card.material.pausesAdIds).toEqual(["orig"]);
    expect(card.warnings.map((w) => w.code)).not.toContain("original_holds_room");
    expect(await startPromotion(actor, d.campaignId, confirmOf(card), { now: WED })).toMatchObject({ state: "started" });
    expect(h.state.calls).toEqual(["pauseAdSet:meta_old_set", "launch", "activate"]);
    expect(h.pauseAdSet.mock.calls[0][2]).toEqual({ type: "user", userId: "u1", role: "admin" });
    // The original's commitment was stopped before the copy's activation reserved; the campaign's other ad set runs on.
    expect(h.state.commitmentsAtActivate).toEqual({ meta_old_set: "stopped", meta_other_set: "live" });
    expect(h.pauseAd).not.toHaveBeenCalled();
  });

  it("when the copy replaces every ad set of the original's campaign, the campaign is paused", async () => {
    const d = await fixCopy();
    const card = await reviewPromotion(actor, d.campaignId, { now: WED });
    expect(await startPromotion(actor, d.campaignId, confirmOf(card), { now: WED })).toMatchObject({ state: "started" });
    expect(h.state.calls).toEqual(["pauseCampaign:old_c", "launch", "activate"]);
    expect(h.state.commitmentsAtActivate).toEqual({ meta_old_set: "stopped" });
  });

  it("an original sharing its ad set with running ads is paused alone, and the card says that frees no room", async () => {
    const d = await fixCopy({ sibling: true });
    const card = await reviewPromotion(actor, d.campaignId, { now: WED });
    expect(card.warnings).toContainEqual({ code: "original_holds_room", text: "'Old offer' shares its ad set with ads that keep running, so pausing it frees no room in your limits." });
    expect(await startPromotion(actor, d.campaignId, confirmOf(card), { now: WED })).toMatchObject({ state: "started" });
    expect(h.state.calls).toEqual(["pauseAd:meta_orig", "launch", "activate"]);
    expect(h.state.commitmentsAtActivate).toEqual({ meta_old_set: "live" });
    expect(h.store.ads.find((a) => a.id === "sib")!.status).toBe("active");
  });

  it("while spending is stopped nothing is paused or sent: the copy gets Phase 0's frozen copy", async () => {
    const d = await fixCopy({ otherSet: true });
    const card = await reviewPromotion(actor, d.campaignId, { now: WED });
    h.state.freeze = "all";
    const frozen = await reviewPromotion(actor, d.campaignId, { now: WED });
    expect(frozen).toMatchObject({ state: "spend_frozen", canStart: false, stateText: spendCopy("spend.frozen") });
    const out = await startPromotion(actor, d.campaignId, confirmOf(card), { now: WED });
    expect(out).toMatchObject({ state: "refused", code: "spend.frozen", message: spendCopy("spend.frozen"), paused: false });
    expect(h.state.calls).toEqual([]);
    expect(h.store.ads.find((a) => a.id === "orig")!.status).toBe("active");
    expect(h.store.adSets.find((s) => s.id === "old_set")!.status).toBe("active");
  });

  it("a fix copy that fits only once its original's room is freed: the ad set is paused, the card is checked again, then it starts", async () => {
    const d = await fixCopy({ otherSet: true });
    h.state.leftToday = 50_000n;
    h.state.freedToday = 1_000_000n;
    const card = await reviewPromotion(actor, d.campaignId, { now: WED });
    expect(card.state).toBe("doesnt_fit");
    expect(await startPromotion(actor, d.campaignId, confirmOf(card), { now: WED })).toMatchObject({ state: "started" });
    expect(h.state.calls).toEqual(["pauseAdSet:meta_old_set", "launch", "activate"]);
  });

  it("a fix copy that still doesn't fit after the pause sends nothing more; the original stays paused (3.9)", async () => {
    const d = await fixCopy({ otherSet: true });
    h.state.leftToday = 50_000n;
    const card = await reviewPromotion(actor, d.campaignId, { now: WED });
    const out = await startPromotion(actor, d.campaignId, confirmOf(card), { now: WED });
    expect(out).toMatchObject({ state: "refused", code: "spend.daily_limit", paused: false, note: SERVICE_COPY.originalStaysPaused });
    expect(h.state.calls).toEqual(["pauseAdSet:meta_old_set"]);
  });

  it("a fix copy that doesn't fit and whose pause frees no room is refused before anything is paused", async () => {
    const d = await fixCopy({ sibling: true });
    h.state.leftToday = 50_000n;
    const card = await reviewPromotion(actor, d.campaignId, { now: WED });
    expect(await startPromotion(actor, d.campaignId, confirmOf(card), { now: WED })).toMatchObject({ state: "refused", code: "spend.daily_limit" });
    expect(h.state.calls).toEqual([]);
    expect(h.store.ads.find((a) => a.id === "orig")!.status).toBe("active");
  });

  it("a lead goal creates the draft's form once and reuses it on a retry, so there is one form", async () => {
    const d = await createPromotionDraft(actor, { goal: "lead_form", days: 5, set: { "text.primary": "Book a trial class", "media.feed": "m1" } }, { now: WED });
    const card = await reviewPromotion(actor, d.campaignId, { now: WED });
    expect(card.facts.find((f) => f.key === "form")?.value).toBe("A new form with 2 questions");
    expect(card.title).toBe("Create the form and start lead ads?");
    h.state.launchError = new HttpError(502, "Could not create the ad set: Meta is busy. Objects already created on Meta were saved; launch again to continue.");
    expect(await startPromotion(actor, d.campaignId, confirmOf(card), { now: WED })).toMatchObject({ state: "failed", formCreated: true });
    expect(h.store.ads[0].creative.leadFormId).toBe(`meta_form_${d.campaignId}`);
    // A refused activation after the form was made says the form is kept, and the next try reuses it.
    h.state.activateError = new SpendBlockedError("spend.busy" as never);
    expect(await startPromotion(actor, d.campaignId, confirmOf(card), { now: WED })).toMatchObject({ state: "refused", paused: true, formCreated: true, note: "Your form was created. The ads are saved, paused." });
    h.state.activateError = null;
    expect(await startPromotion(actor, d.campaignId, confirmOf(card), { now: WED })).toMatchObject({ state: "started" });
    expect(h.ensureDraftForm).toHaveBeenCalledTimes(2);
    expect(h.ensureDraftForm.mock.calls.map((c) => c[1])).toEqual([d.campaignId, d.campaignId]);
    expect(h.ensureDraftForm.mock.calls[0][2]).toBe("page1");
    expect(h.ensureDraftForm.mock.calls[0][3]).toMatchObject({ privacyUrl: "https://shop.example/privacy", questions: [{ type: "FULL_NAME" }, { type: "PHONE" }] });
    expect(h.store.forms).toHaveLength(1);
  });

  it("images not yet on Meta are sent inside the run (D34); a video Meta is still preparing gives media_not_ready", async () => {
    h.store.media[0].status = "pending";
    const d = await websiteDraft();
    const card = await reviewPromotion(actor, d.campaignId, { now: WED });
    expect(card.state).toBe("ready");
    expect(await startPromotion(actor, d.campaignId, confirmOf(card), { now: WED })).toMatchObject({ state: "started" });
    expect(h.state.calls).toEqual(["sendAdMedia:m1", "launch", "activate"]);

    h.state.calls = [];
    h.store.media.push({ id: "v1", tenantId: "t1", adAccountAssetId: "acc", kind: "video", status: "processing", sha256: "b".repeat(64) });
    const v = await websiteDraft({ set: { format: "single_video", "media.feed": null, "media.video": "v1" } });
    const vcard = await reviewPromotion(actor, v.campaignId, { now: WED });
    expect(vcard.state).toBe("blocked");
    expect(vcard.issues).toContain("Meta is still preparing your video. This usually takes 5 to 30 minutes.");
    const out = await startPromotion(actor, v.campaignId, confirmOf(vcard), { now: WED });
    expect(out).toEqual({ state: "media_not_ready", message: "Meta is still preparing your video. This usually takes 5 to 30 minutes.", mediaIds: ["v1"] });
    expect(startStatus(out)).toBe(409);
    expect(h.state.calls).toEqual([]);
  });

  it("a draft saved on Monday and started on Thursday keeps its 7 days (3.1a)", async () => {
    const d = await websiteDraft({ days: 7 }, MON);
    const c = h.store.campaigns[0];
    expect(c.endsAt.toISOString()).toBe("2026-11-01T18:29:00.000Z");
    const card = await reviewPromotion(actor, d.campaignId, { now: THU });
    expect(c.endsAt.toISOString()).toBe("2026-11-04T18:29:00.000Z");
    expect(c.runDays).toBe(7);
    expect(card.material.startsAt).toBe("now:2026-10-29");
    expect(card.facts.find((f) => f.key === "when")?.value).toBe("Today → Wed 4 Nov");
    expect(await startPromotion(actor, d.campaignId, confirmOf(card), { now: THU })).toMatchObject({ state: "started" });
    expect(c.endsAt.toISOString()).toBe("2026-11-04T18:29:00.000Z");
  });

  it("save without starting runs the launch only", async () => {
    const d = await websiteDraft();
    const card = await reviewPromotion(actor, d.campaignId, { now: WED });
    expect(await savePromotionPaused(actor, d.campaignId, { materialHash: card.materialHash }, { now: WED })).toMatchObject({ state: "saved", message: SERVICE_COPY.saved });
    expect(h.state.calls).toEqual(["launch"]);
    expect(h.store.campaigns[0].status).toBe("paused");
  });

  it("save without starting finishes a launch that failed part-way, and says saved only once the campaign is paused on Meta", async () => {
    const d = await websiteDraft();
    const card = await reviewPromotion(actor, d.campaignId, { now: WED });
    h.state.launchError = new HttpError(502, "Could not create the ad set: Meta is busy. Objects already created on Meta were saved; launch again to continue.");
    h.state.launchPartial = true;
    expect(await savePromotionPaused(actor, d.campaignId, { materialHash: card.materialHash }, { now: WED })).toMatchObject({ state: "failed", paused: false });
    expect(await savePromotionPaused(actor, d.campaignId, { materialHash: card.materialHash }, { now: WED })).toMatchObject({ state: "saved" });
    expect(h.state.calls).toEqual(["launch", "launch"]);
    expect(h.store.campaigns[0].status).toBe("paused");

    const d2 = await websiteDraft();
    const card2 = await reviewPromotion(actor, d2.campaignId, { now: WED });
    h.state.launchNoop = true;
    expect(await savePromotionPaused(actor, d2.campaignId, { materialHash: card2.materialHash }, { now: WED })).toEqual({ state: "failed", message: SERVICE_COPY.notSaved, paused: false, formCreated: false });
  });

  it("save without starting is allowed for a run that doesn't fit yet (nothing spends)", async () => {
    const d = await websiteDraft();
    h.state.leftToday = 50_000n;
    const card = await reviewPromotion(actor, d.campaignId, { now: WED });
    expect(card.state).toBe("doesnt_fit");
    expect(await savePromotionPaused(actor, d.campaignId, { materialHash: card.materialHash }, { now: WED })).toMatchObject({ state: "saved" });
  });
});

describe("SPEND_DRY_RUN (6.1 rule 15)", () => {
  it("runs end to end with fake ids and makes no network call", async () => {
    process.env.SPEND_DRY_RUN = "1";
    h.store.media[0].status = "pending";
    const d = await createPromotionDraft(actor, { goal: "lead_form", days: 5, set: { "text.primary": "Book a trial class", "media.feed": "m1" } }, { now: WED, dryRun: true });
    const card = await reviewPromotion(actor, d.campaignId, { now: WED, dryRun: true });
    const out = await startPromotion(actor, d.campaignId, confirmOf(card), { now: WED, dryRun: true });
    expect(out).toMatchObject({ state: "started" });
    expect(h.ensureDraftForm.mock.calls[0][4]).toEqual({ dryRun: true });
    expect(h.store.campaigns[0].metaCampaignId).toMatch(/^dryrun_/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("getPromotionDraft", () => {
  it("returns the draft for any member, with a boosted post's caption as untrusted text", async () => {
    const d = await createPromotionDraft(actor, { goal: "engagement", source: { kind: "ig_media", ref: "17890", caption: "Diwali offer", postKind: "reel" } }, { now: WED });
    const view = await getPromotionDraft({ ...actor, role: "agent" }, d.campaignId);
    expect(view.caption).toEqual({ $untrusted: "external_text", text: "Diwali offer" });
    expect(view.draft).toMatchObject({ source: { kind: "ig_media", ref: "17890" }, format: "existing_post" });
    expect(view.editable).toBe(true);
  });
});
