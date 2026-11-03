import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

/**
 * docs/IG-PAGE-ADS-SPEC.md 6.5 (the Start card's facts and material), 6.1 rule 4, 3.1a and PRM-09 acceptance 3
 * (promote-card-material): the card shows the text, headline, link, first message and quick questions verbatim; a link or number
 * the member didn't type (a boosted post's caption, text Eddy wrote) carries contains_link_or_number; and changing any text,
 * link, first message, time zone, currency, placement, audience, form spec or date between review and Start gives 409 changed
 * with a new card, before anything is sent. The harness is the same in-memory fake as tests/promote-service.test.ts.
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
// The catalog's verify states (D22): every row proven here, so the goals and places these drafts use are offered.
vi.mock("@/lib/promote/catalog/verified", async (original) => ({ ...(await original<Record<string, unknown>>()), verifyStateOf: () => "sandbox" }));
vi.mock("@/lib/spend/book", () => ({ adsHeadroomDetail: (...a: unknown[]) => h.headroom(...(a as [])) }));
vi.mock("@/lib/spend/demo", () => ({ isDemoWorkspace: async () => h.state.demo }));
vi.mock("@/lib/approvals", () => ({ listApprovals: async () => h.state.approvals, isCampaignClientApproved: async () => h.state.approved }));
vi.mock("@/lib/promote/prereqs", () => ({ checkPromotionSetup: (...a: unknown[]) => h.prereqs(...(a as [unknown, Row])) }));
vi.mock("@/lib/promote/lead-forms", () => ({ ensureDraftForm: (...a: unknown[]) => h.ensureDraftForm(...(a as [unknown, string])), copyForm: (...a: unknown[]) => h.copyForm(...a) }));
vi.mock("@/lib/promote/media", () => ({ sendAdMedia: (...a: unknown[]) => h.sendAdMedia(...(a as [Row])) }));

import { buildMaterial, materialDiff, materialHash, type MaterialInput } from "@/lib/promote/material";
import { createPromotionDraft, hasLinkOrNumber, reviewPromotion, startPromotion, startStatus, updatePromotionDraft, type ReviewCard } from "@/lib/promote/service";

const actor = { tenantId: "t1", userId: "u1", role: "admin" as const };
const WED = new Date("2026-10-28T06:00:00Z");
const THU = new Date("2026-10-29T06:00:00Z");

const confirmOf = (card: ReviewCard) => ({ confirmedTotalMinor: String(card.dailyTotalMinor), confirmedWorstCaseMinor: String(card.worstCaseMinor), materialHash: card.materialHash });

async function draftOf(goal: string, set: Record<string, unknown>, extra: Record<string, unknown> = {}, surface: "promote" | "eddy" = "promote") {
  return createPromotionDraft(actor, { goal, days: 5, ...extra, set }, { now: WED, surface });
}

const website = () => draftOf("website_visits", { "text.primary": "Fresh flowers every day", "text.headline": "Same-day delivery", "text.link": "https://shop.example/flowers", "media.feed": "m1" });
const chats = () =>
  draftOf("whatsapp_chats", {
    "text.primary": "Ask us about wedding flowers",
    "media.feed": "m1",
    "welcome.message": "Hi! I want to know more",
    "welcome.iceBreakers": [{ title: "Price?", response: "Prices start at ₹500." }],
  });

/** Reviews, applies a change, then starts with the card from before the change: the answer is 409 changed and nothing is sent. */
async function changedBetween(id: string, change: () => Promise<unknown> | unknown, startAt = WED) {
  const card = await reviewPromotion(actor, id, { now: WED });
  await change();
  const out = await startPromotion(actor, id, confirmOf(card), { now: startAt });
  expect(out.state).toBe("changed");
  expect(startStatus(out)).toBe(409);
  const fresh = (out as { card: ReviewCard }).card;
  expect(fresh.materialHash).not.toBe(card.materialHash);
  expect(h.state.calls).toEqual([]);
  return materialDiff(card.material, fresh.material);
}

const patch = async (id: string, set: Record<string, unknown>) => {
  const c = h.store.campaigns.find((r) => r.id === id)!;
  await updatePromotionDraft(actor, id, { expectedUpdatedAt: c.updatedAt.toISOString(), set });
};

let fetchSpy: MockInstance<typeof fetch>;

beforeEach(() => {
  process.env.PROMOTE_ENABLED = "on";
  process.env.SPEND_ENFORCE = "enforce";
  process.env.SPEND_TRIPWIRE = "enforce";
  delete process.env.SPEND_DRY_RUN;
  Object.assign(h.store, { campaigns: [], adSets: [], ads: [], media: [], forms: [], settings: {}, approvers: [], seq: 0 });
  h.store.assets = [
    { id: "acc", tenantId: "t1", type: "ad_account", externalId: "act_1", name: "Ads", meta: { currency: "INR", timezone: "Asia/Kolkata" } },
    { id: "page1", tenantId: "t1", type: "page", externalId: "p1", name: "Asha Flowers", meta: {} },
    { id: "ig1", tenantId: "t1", type: "instagram", externalId: "i1", name: "ashaflowers", meta: { pageId: "p1", username: "ashaflowers" } },
  ];
  h.store.media.push({ id: "m1", tenantId: "t1", adAccountAssetId: "acc", kind: "image", status: "ready", sha256: "a".repeat(64) });
  h.store.settings["promote:settings:t1"] = { privacyUrl: "https://shop.example/privacy" };
  Object.assign(h.state, { leftToday: 10_000_000n, leftMonth: 100_000_000n, daily: 10_000_000n, freeze: "none", demo: false, approvals: [], approved: false, launchError: null, activateError: null, ambiguous: false, calls: [] });
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in unit tests"));
});

afterEach(() => fetchSpy.mockRestore());

describe("the card shows what Meta will show, verbatim (6.5)", () => {
  it("text, headline, link with its domain, and the button", async () => {
    const d = await website();
    const card = await reviewPromotion(actor, d.campaignId, { now: WED });
    expect(card.text.versions).toEqual([
      { version: "A", primary: "Fresh flowers every day", primaryShort: "Fresh flowers every day", clipped: false, headline: "Same-day delivery", description: "", link: "https://shop.example/flowers", linkDomain: "shop.example", button: "Learn more" },
    ]);
    expect(card.title).toBe("Start ads for 5 days?");
    expect(card.primary).toBe("Start ads · up to ₹2,625");
    expect(card.warnings).toEqual([
      { code: "external_meta", text: "This goes to Meta." },
      { code: "meta_reviews", text: "Meta reviews ads, usually within minutes, up to 24 hours." },
      { code: "month_cross", text: "November's part is set aside on 1 Nov. If November's limit is lower, the ads may pause then." },
    ]);
  });

  it("the first message and quick questions of a chat ad, and a long text clipped at 300 characters with all of it kept", async () => {
    const d = await chats();
    const card = await reviewPromotion(actor, d.campaignId, { now: WED });
    expect(card.text.firstMessage).toBe("Hi! I want to know more");
    expect(card.text.quickQuestions).toEqual([{ title: "Price?", response: "Prices start at ₹500." }]);
    expect(card.title).toBe("Start WhatsApp chat ads?");
    const long = "x".repeat(350);
    await patch(d.campaignId, { "text.primary": long });
    const after = await reviewPromotion(actor, d.campaignId, { now: WED });
    expect(after.text.versions[0]).toMatchObject({ primary: long, primaryShort: `${"x".repeat(300)}…`, clipped: true });
  });

  it("a boosted post's caption is untrusted text, and a link or number in it carries contains_link_or_number", async () => {
    const d = await draftOf("engagement", {}, { source: { kind: "ig_media", ref: "17890", caption: "Diwali sale! Order at https://evil.example or call +91 98765 43210", postKind: "reel" } });
    const card = await reviewPromotion(actor, d.campaignId, { now: WED });
    expect(card.text.caption).toEqual({ $untrusted: "external_text", text: "Diwali sale! Order at https://evil.example or call +91 98765 43210" });
    expect(card.facts[0]).toMatchObject({ key: "post", value: "reel", caption: { $untrusted: "external_text" } });
    expect(card.warnings).toContainEqual({ code: "contains_link_or_number", text: "This text has a link or phone number you didn't type. Check it before you start." });
    expect(card.title).toBe("Boost your reel for 5 days?");

    const clean = await draftOf("engagement", {}, { source: { kind: "ig_media", ref: "17891", caption: "Diwali sale on every saree", postKind: "reel" } });
    expect((await reviewPromotion(actor, clean.campaignId, { now: WED })).warnings.map((w) => w.code)).not.toContain("contains_link_or_number");
  });

  it("a link Eddy wrote carries the warning; the same link typed by the member does not", async () => {
    const set = { "text.primary": "Visit www.shop.example today", "text.link": "https://shop.example", "media.feed": "m1" };
    const eddy = await draftOf("website_visits", set, {}, "eddy");
    expect((await reviewPromotion(actor, eddy.campaignId, { now: WED })).warnings.map((w) => w.code)).toContain("contains_link_or_number");
    const typed = await draftOf("website_visits", set, {}, "promote");
    expect((await reviewPromotion(actor, typed.campaignId, { now: WED })).warnings.map((w) => w.code)).not.toContain("contains_link_or_number");
  });

  it("recognises links and phone numbers", () => {
    for (const s of ["https://x.example", "go to www.shop.in", "shop.example.com/sale", "call 98765 43210", "+91-98765-43210"]) expect(hasLinkOrNumber(s), s).toBe(true);
    for (const s of ["Fresh flowers every day", "Prices from 500", "Open 10 to 8", null]) expect(hasLinkOrNumber(s), String(s)).toBe(false);
  });
});

describe("a change between review and Start gives 409 changed (6.1 rule 4)", () => {
  it("the text", async () => {
    const d = await website();
    expect(await changedBetween(d.campaignId, () => patch(d.campaignId, { "text.primary": "Fresh roses every day" }))).toEqual(expect.arrayContaining(["textSha256", "creativeHash"]));
  });

  it("the link", async () => {
    const d = await website();
    expect(await changedBetween(d.campaignId, () => patch(d.campaignId, { "text.link": "https://other.example" }))).toContain("textSha256");
  });

  it("the first message", async () => {
    const d = await chats();
    expect(await changedBetween(d.campaignId, () => patch(d.campaignId, { "welcome.message": "Hello! Send me the price list" }))).toContain("welcomeSha256");
  });

  it("the quick questions", async () => {
    const d = await chats();
    expect(await changedBetween(d.campaignId, () => patch(d.campaignId, { "welcome.iceBreakers": [{ title: "Delivery?", response: "Yes, across the city." }] }))).toContain("welcomeSha256");
  });

  it("the ad account's time zone", async () => {
    const d = await website();
    expect(await changedBetween(d.campaignId, () => void (h.store.assets[0].meta = { currency: "INR", timezone: "America/New_York" }))).toContain("timezone");
  });

  it("the currency", async () => {
    const d = await website();
    expect(await changedBetween(d.campaignId, () => void (h.store.campaigns[0].currency = "USD"))).toContain("currency");
  });

  it("the placements", async () => {
    const d = await website();
    expect(await changedBetween(d.campaignId, () => patch(d.campaignId, { "placements.mode": "facebook" }))).toContain("placementsHash");
  });

  it("the audience", async () => {
    const d = await website();
    expect(await changedBetween(d.campaignId, () => patch(d.campaignId, { "audience.countries": ["AE"] }))).toContain("audienceHash");
  });

  it("the form spec: a new privacy link, or a saved form chosen instead", async () => {
    const d = await draftOf("lead_form", { "text.primary": "Book a trial class", "media.feed": "m1" });
    expect(await changedBetween(d.campaignId, () => void (h.store.settings["promote:settings:t1"] = { privacyUrl: "https://shop.example/privacy-v2" }))).toEqual(["formSpecHash"]);
    h.store.forms.push({ id: "lf_saved", tenantId: "t1", metaFormId: "9001", name: "Saved form" });
    expect(await changedBetween(d.campaignId, () => patch(d.campaignId, { leadFormId: "lf_saved" }))).toContain("formSpecHash");
  });

  it("the dates: a longer run, or a review before midnight and a Start after it", async () => {
    const d = await website();
    expect(await changedBetween(d.campaignId, () => patch(d.campaignId, { "run.runDays": 6 }))).toContain("endsAt");
    const d2 = await website();
    expect(await changedBetween(d2.campaignId, () => undefined, THU)).toEqual(expect.arrayContaining(["startsAt", "endsAt"]));
  });

  it("the budget", async () => {
    const d = await website();
    expect(await changedBetween(d.campaignId, () => patch(d.campaignId, { "budget.dailyMinor": 40_000 }))).toContain("sets");
  });

  it("an unchanged draft starts with the same card", async () => {
    const d = await website();
    const card = await reviewPromotion(actor, d.campaignId, { now: WED });
    const again = await reviewPromotion(actor, d.campaignId, { now: new Date(WED.getTime() + 3_600_000) });
    expect(again.materialHash).toBe(card.materialHash);
    expect(await startPromotion(actor, d.campaignId, confirmOf(card), { now: WED })).toMatchObject({ state: "started" });
  });
});

describe("buildMaterial (pure)", () => {
  const base: MaterialInput = {
    campaignId: "c1",
    sets: [{ key: "A", dailyBudgetMinor: 30_000 }],
    startsAt: "now:2026-10-28",
    endsAt: "2026-11-01T18:29:00.000Z",
    timezone: "Asia/Kolkata",
    currency: "INR",
    placements: { mode: "auto", positions: [[]] },
    audiences: [{ geo: { countries: ["IN"] }, ageMin: 18 }],
    creatives: [{ message: "Hi", link: "https://a.example" }],
    mediaShas: ["a".repeat(64)],
    text: { versions: [{ primary: "Hi", link: "https://a.example" }], caption: null },
    welcome: { message: "Hello", quickQuestions: [] },
    form: null,
    pausesAdIds: [],
  };
  const changes: [string, Partial<MaterialInput>, string][] = [
    ["text", { text: { versions: [{ primary: "Hi!", link: "https://a.example" }], caption: null } }, "textSha256"],
    ["link", { text: { versions: [{ primary: "Hi", link: "https://b.example" }], caption: null } }, "textSha256"],
    ["first message", { welcome: { message: "Hello there", quickQuestions: [] } }, "welcomeSha256"],
    ["time zone", { timezone: "America/New_York" }, "timezone"],
    ["currency", { currency: "USD" }, "currency"],
    ["placement", { placements: { mode: "instagram", positions: [["instagram_feed"]] } }, "placementsHash"],
    ["audience", { audiences: [{ geo: { countries: ["AE"] }, ageMin: 18 }] }, "audienceHash"],
    ["form spec", { form: { chosen: null, spec: { questions: [] }, privacyUrl: "https://a.example/p" } }, "formSpecHash"],
    ["start date", { startsAt: "now:2026-10-29" }, "startsAt"],
    ["end date", { endsAt: "2026-11-02T18:29:00.000Z" }, "endsAt"],
    ["budget", { sets: [{ key: "A", dailyBudgetMinor: 31_000 }] }, "sets"],
    ["media", { mediaShas: ["b".repeat(64)] }, "mediaShas"],
    ["paused originals", { pausesAdIds: ["orig"] }, "pausesAdIds"],
  ];

  it.each(changes)("changing the %s changes the hash", (_name, change, field) => {
    const a = buildMaterial(base);
    const b = buildMaterial({ ...base, ...change });
    expect(materialHash(b)).not.toBe(materialHash(a));
    expect(materialDiff(a, b)).toEqual([field]);
  });

  it("is the same for the same draft, whatever the key order", () => {
    const reordered = { ...base, creatives: [{ link: "https://a.example", message: "Hi" }] };
    expect(materialHash(buildMaterial(reordered))).toBe(materialHash(buildMaterial(base)));
  });
});
