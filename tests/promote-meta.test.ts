import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** When on, classify() calls every request spend: proves meta.ts refuses before any network I/O. */
const forceSpend = vi.hoisted(() => ({ on: false }));

vi.mock("@/lib/graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/graph")>();
  return { ...actual, graphFetchAs: vi.fn(actual.graphFetchAs) };
});
vi.mock("@/lib/spend/classify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/spend/classify")>();
  return { ...actual, classify: (call: Parameters<typeof actual.classify>[0]) => (forceSpend.on ? { ...actual.classify(call), class: "ads_raise_or_unknown" as const } : actual.classify(call)) };
});

import { GraphError, graphFetchAs } from "@/lib/graph";
import type { AssetAccess } from "@/lib/meta-connect";
import {
  AD_ACCOUNT_HEALTH_FIELDS,
  AUDIENCE_OWNER_FIELDS,
  AUDIENCE_OWNER_TTL_MS,
  CAPABILITIES_KEY,
  CAPABILITY_TTL_MS,
  createPromoteMeta,
  leadFieldList,
  MAX_AUDIENCE_ROWS,
  MAX_ITEMS_PER_CALL,
  MAX_PAGES_PER_CALL,
  PROMOTE_CALLS,
  PROMOTE_META_MESSAGES,
  type PromoteCallId,
  type PromoteMeta,
  type PromoteMetaDeps,
  PromoteMetaError,
  REVIEW_BATCH,
  THROTTLE_BACKOFF_MS,
  TRANSPORT_GRACE_MS,
} from "@/lib/promote/meta";
import { createThrottle, PromoteThrottledError, type SettingStore } from "@/lib/promote/throttle";
import { SpendGuardBypassError } from "@/lib/spend/errors";
import { HttpError } from "@/lib/tenancy";
import { createFakeMetaPromote, FAKE_ACT, FAKE_FORM_ID, FAKE_IG_ID, FAKE_LEAD_ID, FAKE_PAGE_ID, FAKE_PIXEL_ID, FAKE_USER_TOKEN, type FakeMetaPromote } from "./helpers/fake-meta-promote";

/**
 * docs/IG-PAGE-ADS-SPEC.md 4.1, 4.2, 4.9 and PRM-03 acceptance 1 to 3 (promote-meta), against the fake Meta of 9.3: for each
 * method, the token type (previews and ad account edges only with the user token; Page and lead edges with the Page token),
 * classify() gives not_spend, paging caps and the timeout, no retry of an ambiguous POST, the #100 capability fallback cached
 * for 7 days, and zero fetches for writes in a dry run. Plus the grep rules on src/lib/promote/meta.ts.
 */

const T = "tenant_1";
const T0 = Date.parse("2026-10-31T10:00:00Z");
const PAGE = { tenantId: T, pageAssetId: "page_asset" };
const IG = { tenantId: T, instagramAssetId: "ig_asset" };
const AD = { tenantId: T, adAccountAssetId: "ad_asset" };
const AUD = "23850000000000077";
const VIDEO = "2233445566778899";
const HASH = "a".repeat(64);
const BIG_PAGE = "200000000000001";

function memoryStore() {
  const rows = new Map<string, unknown>();
  const store: SettingStore = {
    get: async (key) => (rows.has(key) ? structuredClone(rows.get(key)) : null),
    set: async (key, value) => void rows.set(key, structuredClone(value)),
  };
  return { store, rows };
}

type Setup = {
  meta: PromoteMeta;
  fake: FakeMetaPromote;
  fetches: () => number;
  access: ReturnType<typeof vi.fn>;
  sandbox: ReturnType<typeof vi.fn>;
  sleeps: number[];
  caps: ReturnType<typeof memoryStore>;
  throttleRows: ReturnType<typeof memoryStore>;
  advance: (ms: number) => void;
};

let current: Setup | null = null;

function setup(overrides: Partial<PromoteMetaDeps> & { sandboxed?: boolean; fake?: FakeMetaPromote } = {}): Setup {
  const fake = overrides.fake ?? createFakeMetaPromote();
  const fetch = vi.fn(fake.fetch);
  vi.stubGlobal("fetch", fetch);
  const assets: Record<string, AssetAccess> = {
    page_asset: { assetId: "page_asset", type: "page", externalId: FAKE_PAGE_ID, name: "Fake Shop", token: fake.pageToken() },
    ig_asset: { assetId: "ig_asset", type: "instagram", externalId: FAKE_IG_ID, name: "fakeshop", token: fake.pageToken() },
    ad_asset: { assetId: "ad_asset", type: "ad_account", externalId: FAKE_ACT, name: "Ads", token: FAKE_USER_TOKEN },
  };
  if (fake.pages.has(BIG_PAGE)) assets.big_page = { assetId: "big_page", type: "page", externalId: BIG_PAGE, name: "Big", token: fake.pageToken(BIG_PAGE) };
  const access = vi.fn(async (_tenantId: string, assetId: string) => {
    const a = assets[assetId];
    if (!a) throw new HttpError(404, "Asset not found.");
    return a;
  });
  const sandbox = vi.fn(async () => overrides.sandboxed === true);
  let now = T0;
  const sleeps: number[] = [];
  const caps = memoryStore();
  const throttleRows = memoryStore();
  const meta = createPromoteMeta({
    access,
    sandbox,
    store: caps.store,
    throttle: createThrottle({ store: throttleRows.store, now: () => now }),
    env: {},
    sleep: async (ms) => void sleeps.push(ms),
    now: () => now,
    readTimeoutMs: 2_000,
    writeTimeoutMs: 2_000,
    ...overrides,
  });
  current = { meta, fake, fetches: () => fetch.mock.calls.length, access, sandbox, sleeps, caps, throttleRows, advance: (ms) => void (now += ms) };
  return current;
}

const leadFormSpec = () => ({
  name: "Diwali offer",
  questions: [{ type: "FULL_NAME" }, { type: "PHONE" }],
  privacyPolicy: { url: "https://example.com/privacy", linkText: "Privacy policy" },
  thankYouPage: { title: "Thanks", body: "We'll call you soon.", button_type: "VIEW_WEBSITE", button_text: "Visit", website_url: "https://example.com" },
  customDisclaimer: { title: "Consent", body: "We may message you on WhatsApp.", checkboxes: [{ key: "wa", text: "WhatsApp me", is_required: false }] },
});

/** One run per call of 4.2, with the path each request must have. */
const RUN: Record<PromoteCallId, { path: RegExp; run: (m: PromoteMeta, f: FakeMetaPromote) => Promise<unknown> }> = {
  C2: { path: new RegExp(`^${FAKE_PAGE_ID}$`), run: (m) => m.getPageReadiness(PAGE) },
  C3: { path: new RegExp(`^${FAKE_PAGE_ID}/page_backed_instagram_accounts$`), run: (m) => m.listPageBackedInstagram(PAGE) },
  C4: { path: /^act_1$/, run: (m) => m.getAdAccountHealth(AD) },
  C5: { path: /^act_1\/minimum_budgets$/, run: (m) => m.getMinimumBudgets(AD) },
  C6: { path: /^act_1\/connected_instagram_accounts$/, run: (m) => m.listAdAccountInstagram(AD) },
  C7: { path: new RegExp(`^${FAKE_PIXEL_ID}$`), run: (m) => m.getPixel(AD, FAKE_PIXEL_ID) },
  C8: { path: new RegExp(`^${FAKE_PAGE_ID}/page_backed_instagram_accounts$`), run: (m) => m.createPageBackedInstagram(PAGE) },
  C9: { path: /^act_1\/adspixels$/, run: (m) => m.createPixel(AD, "Shop pixel") },
  B1: { path: new RegExp(`^${FAKE_PAGE_ID}/published_posts$`), run: (m) => m.listPublishedPosts(PAGE) },
  B2: { path: new RegExp(`^${FAKE_PAGE_ID}/promotable_posts$`), run: (m) => m.listPromotablePosts(PAGE) },
  B3: { path: new RegExp(`^${FAKE_PAGE_ID}_100000$`), run: (m) => m.getPostInstagramEligibility(PAGE, `${FAKE_PAGE_ID}_100000`) },
  B4: { path: new RegExp(`^${FAKE_IG_ID}/media$`), run: (m) => m.listInstagramMedia(IG) },
  B5: { path: new RegExp(`^${FAKE_IG_ID}/stories$`), run: (m) => m.listInstagramStories(IG) },
  M1: { path: /^act_1\/adimages$/, run: (m) => m.uploadAdImage(AD, { bytes: Uint8Array.of(0xff, 0xd8, 0xff, 1, 2, 3) }) },
  M2: { path: /^act_1\/advideos$/, run: (m) => m.createAdVideo(AD, { fileUrl: "https://media.example.com/v.mp4?sig=x", name: "Reel" }) },
  M3: {
    path: new RegExp(`^${VIDEO}$`),
    run: (m, f) => {
      f.addVideo(VIDEO);
      return m.getAdVideoStatus(AD, VIDEO);
    },
  },
  P1: {
    path: /^act_1\/generatepreviews$/,
    run: (m) => m.generatePreviews(AD, { creative: { object_story_spec: { page_id: FAKE_PAGE_ID, instagram_user_id: FAKE_IG_ID, link_data: { message: "Hi", link: "https://example.com", image_hash: "abc" } } }, adFormat: "INSTAGRAM_STANDARD" }),
  },
  P2: { path: /^23850000000000004\/previews$/, run: (m) => m.getCreativePreviews(AD, "23850000000000004", "INSTAGRAM_REELS") },
  L1: { path: new RegExp(`^${FAKE_PAGE_ID}/leadgen_forms$`), run: (m) => m.listLeadForms(PAGE) },
  L2: { path: new RegExp(`^${FAKE_PAGE_ID}/leadgen_forms$`), run: (m) => m.createLeadForm(PAGE, leadFormSpec()) },
  L4: { path: new RegExp(`^${FAKE_FORM_ID}/test_leads$`), run: (m) => m.sendTestLead(PAGE, FAKE_FORM_ID) },
  A1: { path: /^act_1\/customaudiences$/, run: (m) => m.createCustomAudience(AD, { kind: "customer_list", name: "Buyers", description: "From Edwyz contacts" }) },
  // A2, A3, A4 and A6 first read the audience's own ad account (GET {audience}), then write.
  A2: {
    path: new RegExp(`^${AUD}(/users)?$`),
    run: (m, f) => {
      f.addAudience(AUD);
      return m.addAudienceUsers(AD, AUD, { schema: ["EMAIL", "PHONE"], rows: [[HASH, HASH]] }, { id: 42, batchSeq: 1, last: true, estimatedTotal: 1 });
    },
  },
  A3: {
    path: new RegExp(`^${AUD}(/usersreplace)?$`),
    run: (m, f) => {
      f.addAudience(AUD);
      return m.replaceAudienceUsers(AD, AUD, { schema: ["EMAIL"], rows: [[HASH]] }, { id: 43, batchSeq: 1, last: true });
    },
  },
  A4: {
    path: new RegExp(`^${AUD}(/users)?$`),
    run: (m, f) => {
      f.addAudience(AUD, { rows: 5 });
      return m.removeAudienceUsers(AD, AUD, { schema: ["PHONE"], rows: [[HASH]] });
    },
  },
  A5: {
    path: new RegExp(`^${AUD}$`),
    run: (m, f) => {
      f.addAudience(AUD, { rows: 5000 });
      return m.getAudience(AD, AUD);
    },
  },
  A6: {
    path: new RegExp(`^${AUD}$`),
    run: (m, f) => {
      f.addAudience(AUD);
      return m.deleteAudience(AD, AUD);
    },
  },
  A7: { path: /^search$/, run: (m) => m.searchPlaces(AD, "Pune") },
  A8: { path: /^search$/, run: (m) => m.searchInterests(AD, "yoga") },
  A9: { path: /^act_1\/reachestimate$/, run: (m) => m.estimateReach(AD, { geo_locations: { countries: ["IN"] }, age_min: 18 }) },
  R1: {
    path: /^act_1\/ads$/,
    run: (m, f) => {
      f.scenario("review_feedback");
      return m.getAdsReview(AD, f.reviewSamples());
    },
  },
  R2: { path: /^act_1\/campaigns$/, run: (m) => m.getCampaignAdvantage(AD, ["23850000000000301"]) },
};

const IDS = Object.keys(PROMOTE_CALLS) as PromoteCallId[];
const WRITES = IDS.filter((id) => PROMOTE_CALLS[id].write);
const POST_WRITES = WRITES.filter((id) => !["A4", "A6"].includes(id));

const saved = { tripwire: process.env.SPEND_TRIPWIRE, dryRun: process.env.SPEND_DRY_RUN, base: process.env.GRAPH_BASE_URL };
beforeAll(() => {
  // Every request below would be refused before any network I/O if it were a raising write without a permit.
  process.env.SPEND_TRIPWIRE = "enforce";
  delete process.env.SPEND_DRY_RUN;
  delete process.env.GRAPH_BASE_URL;
});
afterAll(() => {
  for (const [k, v] of [["SPEND_TRIPWIRE", saved.tripwire], ["SPEND_DRY_RUN", saved.dryRun], ["GRAPH_BASE_URL", saved.base]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(() => {
  vi.mocked(graphFetchAs).mockClear();
  forceSpend.on = false;
  current = null;
});
afterEach(() => {
  // No promote call may ever reach a spend class or the unscoped preview edge (9.3).
  current?.fake.assertClean();
  vi.unstubAllGlobals();
});

describe("the catalogue", () => {
  it("has one method per call of 4.2 (C2 to C9, B1 to B5, M1 to M3, P1, P2, L1, L2, L4, A1 to A9, R1, R2), and nothing for R3 to R5, L3, L5 or L6", () => {
    expect(IDS.sort()).toEqual(
      ["C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "B1", "B2", "B3", "B4", "B5", "M1", "M2", "M3", "P1", "P2", "L1", "L2", "L4", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "R1", "R2"].sort(),
    );
    const { meta } = setup();
    for (const id of IDS) expect(typeof (meta as unknown as Record<string, unknown>)[PROMOTE_CALLS[id].method], id).toBe("function");
  });

  it("previews, search, reach and every ad account edge use the user token; Page, Instagram and form edges the Page token", () => {
    for (const id of ["P1", "P2", "A7", "A8", "A9", "C4", "C5", "C6", "C7", "C9", "M1", "M2", "M3", "R1", "R2", "A1", "A2", "A3", "A4", "A5", "A6"] as const) expect(PROMOTE_CALLS[id].token, id).toBe("user");
    for (const id of ["C2", "C3", "C8", "B1", "B2", "B3", "B4", "B5", "L1", "L2", "L4"] as const) expect(PROMOTE_CALLS[id].token, id).toBe("page");
  });
});

describe.each(IDS)("%s", (id) => {
  it(`goes through graphFetchAs with the ${PROMOTE_CALLS[id].token} token, and every request is not_spend`, async () => {
    const { meta, fake, fetches } = setup();
    await RUN[id].run(meta, fake);
    expect(fake.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(graphFetchAs).mock.calls.length).toBe(fake.calls.length);
    expect(fetches()).toBe(fake.calls.length);
    for (const call of fake.calls) {
      expect(call.class, call.pattern).toBe("not_spend");
      expect(call.tokenKind, call.pattern).toBe(PROMOTE_CALLS[id].token);
      expect(call.path).toMatch(RUN[id].path);
      expect(call.status, call.pattern).toBe(200);
    }
    for (const [token] of vi.mocked(graphFetchAs).mock.calls) expect(token).toBe(PROMOTE_CALLS[id].token === "user" ? FAKE_USER_TOKEN : fake.pageToken());
  });

  it("refuses before any network I/O if its request were ever classified as spend", async () => {
    const { meta, fake, fetches } = setup({ env: {} });
    forceSpend.on = true;
    const out = await RUN[id].run(meta, fake).then(
      () => null,
      (e: unknown) => e,
    );
    forceSpend.on = false;
    expect(out).toBeInstanceOf(SpendGuardBypassError);
    expect(fetches()).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });

  if (PROMOTE_CALLS[id].write) {
    it("in a dry run answers with a fake result and makes no network call (the asset is still checked)", async () => {
      const { meta, fake, fetches, access } = setup({ env: { SPEND_DRY_RUN: "1" } });
      const out = (await RUN[id].run(meta, fake)) as Record<string, unknown>;
      expect(fetches()).toBe(0);
      expect(fake.calls).toHaveLength(0);
      expect(vi.mocked(graphFetchAs)).not.toHaveBeenCalled();
      expect(access).toHaveBeenCalledTimes(1);
      if (typeof out.id === "string") expect(out.id).toMatch(/^dryrun_/);
      if (typeof out.hash === "string") expect(out.hash).toMatch(/^dryrun[0-9a-f]{26}$/);
    });
  }
});

describe("dry run (fakeMetaWrites)", () => {
  it("SPEND_DRY_RUN counts nowhere near production: there the write goes out", async () => {
    const { meta, fetches } = setup({ env: { SPEND_DRY_RUN: "1", NODE_ENV: "production" } });
    const { id } = await meta.createPixel(AD, "Shop pixel");
    expect(id).toMatch(/^\d+$/);
    expect(fetches()).toBe(1);
  });

  it("a sandbox ad account with SPEND_SIM is faked; a real one is not; Page writes are never faked by SPEND_SIM", async () => {
    const sandboxed = setup({ env: { SPEND_SIM: "1" }, sandboxed: true });
    expect((await sandboxed.meta.createCustomAudience(AD, { kind: "customer_list", name: "Buyers" })).id).toMatch(/^dryrun_/);
    expect(sandboxed.fetches()).toBe(0);
    expect(sandboxed.sandbox).toHaveBeenCalledWith(T, "ad_asset");
    sandboxed.fake.assertClean();

    const real = setup({ env: { SPEND_SIM: "1" }, sandboxed: false });
    expect((await real.meta.createCustomAudience(AD, { kind: "customer_list", name: "Buyers" })).id).toMatch(/^\d+$/);
    expect(real.fetches()).toBe(1);
    real.fake.assertClean();

    const page = setup({ env: { SPEND_SIM: "1" }, sandboxed: true });
    await page.meta.createLeadForm(PAGE, leadFormSpec());
    expect(page.fetches()).toBe(1);
  });

  it("the same image bytes give the same fake hash (so dedupe works in a dry run)", async () => {
    const { meta } = setup({ env: { SPEND_DRY_RUN: "1" } });
    const a = await meta.uploadAdImage(AD, { bytes: Uint8Array.of(1, 2, 3) });
    const b = await meta.uploadAdImage(AD, { bytes: Uint8Array.of(1, 2, 3) });
    const c = await meta.uploadAdImage(AD, { bytes: Uint8Array.of(1, 2, 4) });
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
  });
});

describe("token types", () => {
  it("a Page method refuses an ad account asset and an ad account method refuses a Page, with no request", async () => {
    const { meta, fetches } = setup();
    await expect(meta.listPublishedPosts({ tenantId: T, pageAssetId: "ad_asset" })).rejects.toThrow("Choose a Facebook Page first.");
    await expect(meta.listInstagramMedia({ tenantId: T, instagramAssetId: "page_asset" })).rejects.toThrow("Choose an Instagram account first.");
    await expect(meta.generatePreviews({ tenantId: T, adAccountAssetId: "page_asset" }, { creative: {}, adFormat: "MOBILE_FEED_STANDARD" })).rejects.toThrow("Choose an ad account first.");
    await expect(meta.searchInterests({ tenantId: T, adAccountAssetId: "ig_asset" }, "yoga")).rejects.toThrow("Choose an ad account first.");
    expect(fetches()).toBe(0);
  });

  it("previews never use a Page token: Meta (the fake) refuses one", async () => {
    const fake = createFakeMetaPromote();
    const { meta } = setup({
      fake,
      access: async () => ({ assetId: "ad_asset", type: "ad_account", externalId: FAKE_ACT, name: null, token: fake.pageToken() }),
    });
    await expect(meta.getCreativePreviews(AD, "23850000000000004", "MOBILE_FEED_STANDARD")).rejects.toBeInstanceOf(GraphError);
    expect(fake.calls[0].tokenKind).toBe("page");
    expect(fake.calls[0].status).toBe(400);
  });

  it("previews are only ever scoped to the ad account (P1) or a creative (P2)", async () => {
    const { meta, fake } = setup();
    await meta.generatePreviews(AD, { creative: { object_story_spec: { page_id: FAKE_PAGE_ID, link_data: { link: "https://example.com" } } }, adFormat: "MOBILE_FEED_STANDARD" });
    await meta.getCreativePreviews(AD, "23850000000000004", "MOBILE_FEED_STANDARD");
    expect(fake.calls.map((c) => c.path)).toEqual(["act_1/generatepreviews", "23850000000000004/previews"]);
    expect(fake.bannedCalls()).toHaveLength(0);
  });
});

describe("paging", () => {
  function bigFake(posts: number, forms = 0) {
    const fake = createFakeMetaPromote();
    fake.addPage({ id: BIG_PAGE, posts });
    for (let i = 0; i < forms; i++) fake.addForm(String(3000000000000000 + i), BIG_PAGE);
    return fake;
  }

  it("reads one page of 25 by default and gives the cursor to continue", async () => {
    const { meta, fake } = setup();
    const first = await meta.listPublishedPosts(PAGE);
    expect(first.items).toHaveLength(25);
    expect(first.complete).toBe(false);
    expect(first.after).toBeTruthy();
    expect(fake.calls[0].query.limit).toBe("25");
    const second = await meta.listPublishedPosts(PAGE, { after: first.after });
    expect(second.items[0].id).toBe(`${FAKE_PAGE_ID}_100025`);
  });

  it(`follows at most ${MAX_PAGES_PER_CALL} pages per call, whatever the caller asks`, async () => {
    const { meta, fake, fetches } = setup({ fake: bigFake(500) });
    const res = await meta.listPublishedPosts({ tenantId: T, pageAssetId: "big_page" }, { maxPages: 99 });
    expect(fetches()).toBe(MAX_PAGES_PER_CALL);
    expect(res.items).toHaveLength(MAX_PAGES_PER_CALL * 25);
    expect(res.complete).toBe(false);
    expect(res.after).toBeTruthy();
    fake.assertClean();
  });

  it(`returns at most ${MAX_ITEMS_PER_CALL} items per call`, async () => {
    const { meta, fetches } = setup({ fake: bigFake(1, 400) });
    const res = await meta.listLeadForms({ tenantId: T, pageAssetId: "big_page" }, { maxPages: 99 });
    expect(res.items).toHaveLength(MAX_ITEMS_PER_CALL);
    expect(res.complete).toBe(false);
    expect(fetches()).toBe(MAX_ITEMS_PER_CALL / 50);
  });

  it("stops at the end and says the list is complete", async () => {
    const { meta, fetches } = setup();
    const res = await meta.listPublishedPosts(PAGE, { maxPages: 5 });
    expect(res.items).toHaveLength(60);
    expect(res.complete).toBe(true);
    expect(res.after).toBeNull();
    expect(fetches()).toBe(3);
  });

  it("refuses a cursor that is not one, before any request", async () => {
    const { meta, fetches } = setup();
    await expect(meta.listPublishedPosts(PAGE, { after: "../act_1/campaigns?x=1" })).rejects.toBeInstanceOf(HttpError);
    expect(fetches()).toBe(0);
  });

  it(`review status goes in batches of ${REVIEW_BATCH} ids`, async () => {
    const { meta, fake } = setup();
    const ids = Array.from({ length: 120 }, (_, i) => `2385000000001${String(i).padStart(4, "0")}`);
    await meta.getAdsReview(AD, ids);
    const batches = fake.calls.map((c) => (JSON.parse(c.query.filtering) as { value: string[] }[])[0].value.length);
    expect(batches).toEqual([50, 50, 20]);
  });
});

describe("timeouts and retries", () => {
  it("a read that hangs ends at the deadline with a plain timeout", async () => {
    const { meta, fake } = setup({ readTimeoutMs: 60 });
    fake.hangNext();
    const t0 = Date.now();
    const e = await meta.listPublishedPosts(PAGE).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PromoteMetaError);
    expect((e as PromoteMetaError).kind).toBe("timeout");
    expect((e as PromoteMetaError).message).toBe("Meta took too long to answer. Try again in a minute.");
    expect(Date.now() - t0).toBeLessThan(1_500);
  });

  it("the deadline covers every page of a call", async () => {
    const { meta, fake, fetches } = setup({ readTimeoutMs: 60 });
    fake.hangNext(/published_posts/);
    await expect(meta.listPublishedPosts(PAGE, { maxPages: 5 })).rejects.toBeInstanceOf(PromoteMetaError);
    expect(fetches()).toBe(1);
  });

  it.each(POST_WRITES)("%s: an ambiguous answer (applied, then 500) is not retried", async (id) => {
    const { meta, fake } = setup();
    fake.failNextCreate({ status: 500, apply: true });
    const e = await RUN[id].run(meta, fake).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GraphError);
    expect((e as GraphError).ambiguous).toBe(true);
    expect(fake.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("a dropped connection after a create is not retried either, and the object exists on Meta", async () => {
    const { meta, fake } = setup();
    fake.failNextCreate({ kind: "network", apply: true, match: /customaudiences/ });
    const before = fake.audiences.size;
    const e = await meta.createCustomAudience(AD, { kind: "customer_list", name: "Buyers" }).catch((x: unknown) => x);
    expect((e as GraphError).ambiguous).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(fake.audiences.size).toBe(before + 1);
  });

  it("a write that hangs times out after one attempt, and says it may have reached Meta", async () => {
    const { meta, fake } = setup({ writeTimeoutMs: 60 });
    fake.hangNext(/adspixels/);
    const e = await meta.createPixel(AD, "Shop pixel").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PromoteMetaError);
    expect(e).toMatchObject({ kind: "timeout", ambiguous: true, status: 504 });
    // Shown as unknown, never "try again": a second create could make a second pixel, form or audience.
    expect((e as PromoteMetaError).message).toBe("Meta didn't confirm this in time. It may already be saved. Check before you try again.");
    expect(fake.calls).toHaveLength(1);
  });

  it("a write deadline longer than the transport's 20 s default is the one that counts (fake timers)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // AbortSignal.timeout runs on Node's own timers: route it through the faked setTimeout, so a 20 s cut-off would fire here.
    const asked: number[] = [];
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      asked.push(ms);
      const c = new AbortController();
      setTimeout(() => c.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
      return c.signal;
    });
    try {
      const { meta, fake } = setup({ writeTimeoutMs: 45_000 });
      fake.hangNext(/adimages/);
      let settled = false;
      const pending = meta
        .uploadAdImage(AD, { bytes: Uint8Array.of(0xff, 0xd8, 0xff, 1, 2, 3) })
        .then(
          () => null,
          (e: unknown) => e,
        )
        .finally(() => void (settled = true));
      await vi.advanceTimersByTimeAsync(44_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      const e = await pending;
      expect(e).toBeInstanceOf(PromoteMetaError);
      expect(e).toMatchObject({ kind: "timeout", ambiguous: true, status: 504, message: PROMOTE_META_MESSAGES.timeout_ambiguous });
      // The transport's own limit sits just past the call's deadline.
      expect(asked).toEqual([45_000 + TRANSPORT_GRACE_MS]);
      expect(fake.calls).toHaveLength(1);
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it("a create answered without its id may still exist on Meta: unknown, not 'try again'; an unreadable read says to try again", async () => {
    const { meta } = setup();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(meta.createPixel(AD, "Shop pixel")).rejects.toMatchObject({ kind: "bad_response", ambiguous: true, status: 502, message: PROMOTE_META_MESSAGES.bad_response_ambiguous });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([1, 2]), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(meta.listPublishedPosts(PAGE)).rejects.toMatchObject({ kind: "bad_response", ambiguous: false, message: PROMOTE_META_MESSAGES.bad_response });
  });

  it("only an ambiguous write's copy changes: it never says to try again in a minute", () => {
    for (const kind of ["timeout", "bad_response"] as const) {
      expect(new PromoteMetaError(kind, true).message).toMatch(/It may already be saved\. Check before you try again\.$/);
      expect(new PromoteMetaError(kind, true).message).not.toMatch(/in a minute/);
      expect(new PromoteMetaError(kind).message).toMatch(/Try again in a minute\.$/);
    }
  });

  it("a read that times out is not ambiguous", async () => {
    const { meta, fake } = setup({ readTimeoutMs: 40 });
    fake.hangNext();
    await expect(meta.getAdAccountHealth(AD)).rejects.toMatchObject({ kind: "timeout", ambiguous: false });
  });
});

describe("throttling (4.9)", () => {
  it.each([613, 17])("a read hit by %i backs off and tries again", async (code) => {
    const { meta, fake, fetches, sleeps } = setup();
    fake.throttleNext({ code, match: /published_posts/ });
    const res = await meta.listPublishedPosts(PAGE);
    expect(res.items).toHaveLength(25);
    expect(fetches()).toBe(2);
    expect(sleeps).toEqual([THROTTLE_BACKOFF_MS[0]]);
  });

  it("a back-off never runs past the call's deadline", async () => {
    const { meta, fake, fetches, sleeps } = setup({ readTimeoutMs: 2_000 });
    fake.throttleNext({ code: 613, times: 5, match: /reachestimate/ });
    await expect(meta.estimateReach(AD, { geo_locations: { countries: ["IN"] } })).rejects.toBeInstanceOf(PromoteThrottledError);
    // 1 s fits in the 2 s deadline; the next 3 s back-off does not, so the account cools down after two tries.
    expect(sleeps).toEqual([THROTTLE_BACKOFF_MS[0]]);
    expect(fetches()).toBe(2);
  });

  it("a read still throttled after the back-offs cools the account down; the next call waits without a request", async () => {
    const { meta, fake, fetches, sleeps, throttleRows } = setup({ readTimeoutMs: 10_000 });
    fake.throttleNext({ code: 613, subcode: 5044001, times: 5, match: /reachestimate/ });
    const e = await meta.estimateReach(AD, { geo_locations: { countries: ["IN"] } }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PromoteThrottledError);
    expect(fetches()).toBe(3);
    expect(sleeps).toEqual([...THROTTLE_BACKOFF_MS]);
    expect(throttleRows.rows.get("promote:throttle:act_1")).toMatchObject({ code: 613, subcode: 5044001 });
    await expect(meta.searchInterests(AD, "yoga")).rejects.toMatchObject({ reason: "cooldown" });
    expect(fetches()).toBe(3);
  });

  it("when Meta says how long to wait, a read does not retry and the cooldown is that long", async () => {
    const { meta, fake, fetches, sleeps, throttleRows } = setup();
    fake.throttleNext({ code: 17, regainMinutes: 12, match: /minimum_budgets/ });
    await expect(meta.getMinimumBudgets(AD)).rejects.toBeInstanceOf(PromoteThrottledError);
    expect(fetches()).toBe(1);
    expect(sleeps).toEqual([]);
    expect(Date.parse((throttleRows.rows.get("promote:throttle:act_1") as { until: string }).until)).toBe(T0 + 12 * 60_000);
  });

  it("a throttled write is never repeated", async () => {
    const { meta, fake, sleeps } = setup();
    fake.throttleNext({ code: 613, match: /customaudiences/ });
    await expect(meta.createCustomAudience(AD, { kind: "customer_list", name: "Buyers" })).rejects.toBeInstanceOf(PromoteThrottledError);
    expect(fake.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("above 75% usage, sources and audience uploads wait; review sync still runs", async () => {
    const { meta, fake, fetches } = setup();
    fake.setUsage(90);
    await meta.searchPlaces(AD, "Pune");
    expect(fetches()).toBe(1);
    await expect(meta.searchPlaces(AD, "Pune")).rejects.toMatchObject({ reason: "busy" });
    fake.addAudience(AUD);
    await expect(meta.addAudienceUsers(AD, AUD, { schema: ["EMAIL"], rows: [[HASH]] }, { id: 1, batchSeq: 1, last: true })).rejects.toMatchObject({ reason: "busy" });
    expect(fetches()).toBe(1);
    await meta.getAdsReview(AD, ["23850000000000104"]);
    expect(fetches()).toBe(2);
  });
});

describe("capability probes (4.1)", () => {
  it("a missing Page whatsapp_number: asked once more without it, and that answer is kept for 7 days", async () => {
    const { meta, fake, fetches, caps, advance } = setup();
    fake.scenario("page_whatsapp_missing");
    const first = await meta.getPageReadiness(PAGE);
    expect(first).toEqual({ leadgenTermsAccepted: true, whatsappNumber: null, whatsappNumberChecked: false });
    expect(fake.calls.map((c) => c.query.fields)).toEqual(["leadgen_tos_accepted,whatsapp_number", "leadgen_tos_accepted"]);
    expect(caps.rows.get(CAPABILITIES_KEY)).toMatchObject({ page_whatsapp_number: { supported: false, checkedAt: new Date(T0).toISOString() } });

    await meta.getPageReadiness(PAGE);
    expect(fetches()).toBe(3);
    expect(fake.calls[2].query.fields).toBe("leadgen_tos_accepted");

    advance(CAPABILITY_TTL_MS - 1);
    await meta.getPageReadiness(PAGE);
    expect(fetches()).toBe(4);

    advance(2);
    fake.scenario("page_whatsapp_missing", false);
    const later = await meta.getPageReadiness(PAGE);
    expect(fake.calls[4].query.fields).toBe("leadgen_tos_accepted,whatsapp_number");
    expect(later).toEqual({ leadgenTermsAccepted: true, whatsappNumber: "+919800000001", whatsappNumberChecked: true });
    expect(caps.rows.get(CAPABILITIES_KEY)).toMatchObject({ page_whatsapp_number: { supported: true } });
  });

  it("lead platform and is_organic (L5 and L6 in leads/ use probeCapability): the #100 fallback is cached for 7 days", async () => {
    const { meta, fake, caps, advance } = setup();
    fake.scenario("unknown_lead_fields");
    const readLead = (withFields: boolean) => graphFetchAs<Record<string, unknown>>(fake.pageToken(), { method: "GET", path: FAKE_LEAD_ID, query: { fields: leadFieldList(withFields) } });
    const first = await meta.probeCapability("lead_platform", readLead);
    expect(first.supported).toBe(false);
    expect(first.result.id).toBe(FAKE_LEAD_ID);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0].query.fields).toContain("platform,is_organic");
    expect(fake.calls[1].query.fields).not.toContain("platform");
    expect(await meta.capability("lead_platform")).toBe(false);
    await meta.probeCapability("lead_platform", readLead);
    expect(fake.calls).toHaveLength(3);
    advance(CAPABILITY_TTL_MS);
    expect(await meta.capability("lead_platform")).toBeNull();
    expect((caps.rows.get(CAPABILITIES_KEY) as Record<string, unknown>).lead_platform).toBeTruthy();
  });

  it("another #100 (an object that does not exist) is not a missing field: thrown, nothing cached", async () => {
    const { meta, fake, caps } = setup();
    const e = await meta
      .probeCapability("lead_platform", (withFields) => graphFetchAs(fake.pageToken(), { method: "GET", path: `${FAKE_PAGE_ID}_999999`, query: { fields: leadFieldList(withFields) } }))
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GraphError);
    expect((e as GraphError).subcode).toBe(33);
    expect(fake.calls).toHaveLength(1);
    expect(caps.rows.has(CAPABILITIES_KEY)).toBe(false);
  });

  it("if the read without the field fails too, that error is thrown and nothing is cached", async () => {
    const { meta, caps } = setup();
    let calls = 0;
    const e = await meta
      .probeCapability("lead_platform", async () => {
        calls++;
        throw calls === 1 ? new GraphError("(#100) Tried accessing nonexisting field (platform)", 400, 100) : new GraphError("boom", 500, 2);
      })
      .catch((x: unknown) => x);
    expect((e as GraphError).message).toBe("boom");
    expect(calls).toBe(2);
    expect(caps.rows.has(CAPABILITIES_KEY)).toBe(false);
  });

  it("C6 falls back to instagram_accounts on #100", async () => {
    const { meta, fake } = setup();
    fake.scenario("connected_instagram_missing");
    const res = await meta.listAdAccountInstagram(AD);
    expect(res).toEqual({ edge: "instagram_accounts", items: [{ id: FAKE_IG_ID, username: "fakeshop" }] });
    expect(fake.calls.map((c) => c.path)).toEqual(["act_1/connected_instagram_accounts", "act_1/instagram_accounts"]);
  });
});

describe("what comes back", () => {
  it("C4 keeps only whether a payment method exists", async () => {
    const { meta } = setup();
    const health = await meta.getAdAccountHealth(AD);
    expect(Object.keys(health).sort()).toEqual(["accountStatus", "businessId", "currency", "disableReason", "fundingPresent", "timezone", "tosAccepted", "userTosAccepted"]);
    expect(health).toMatchObject({ accountStatus: 1, currency: "INR", timezone: "Asia/Kolkata", businessId: "1800000000000001", fundingPresent: true, tosAccepted: { custom_audience_tos: 1 } });
    const { fundingPresent, ...rest } = health;
    expect(typeof fundingPresent).toBe("boolean");
    expect(JSON.stringify(rest)).not.toMatch(/funding|display_string|"type"/i);
  });

  it("C5 keeps Meta's minimums by their own names", async () => {
    const { meta } = setup();
    const res = await meta.getMinimumBudgets(AD);
    expect(res.currency).toBe("INR");
    expect(Object.values(res.minimumsMinor)).toContain(8900);
    expect(Object.keys(res.minimumsMinor).every((k) => k.startsWith("min_"))).toBe(true);
  });

  it("B1 and B4 carry eligibility and Meta's raw reason text", async () => {
    const { meta, fake } = setup();
    fake.scenario("boost_ineligible");
    const posts = await meta.listPublishedPosts(PAGE);
    expect(posts.items[0]).toMatchObject({ eligible: false, promotableId: `${FAKE_PAGE_ID}_100000`, mediaType: "video" });
    expect(posts.items[1].eligible).toBe(true);
    const media = await meta.listInstagramMedia(IG);
    expect(media.items[0]).toMatchObject({ productType: "REELS", boost: { eligible: false, reasons: ["This reel uses music that can't be used in ads."] }, boostAdsCount: 0 });
  });

  it("M3 moves from processing to ready, with the preferred thumbnail", async () => {
    const { meta, fake } = setup();
    fake.setVideoPolls(2);
    const { id } = await meta.createAdVideo(AD, { fileUrl: "https://media.example.com/v.mp4?sig=x", name: "Reel" });
    expect((await meta.getAdVideoStatus(AD, id)).state).toBe("processing");
    expect((await meta.getAdVideoStatus(AD, id)).state).toBe("processing");
    const ready = await meta.getAdVideoStatus(AD, id);
    expect(ready).toMatchObject({ state: "ready", progress: 100, lengthSec: 14.5 });
    expect(ready.thumbnailUrl).toMatch(/_2\.jpg$/);
  });

  it("P1 passes Meta's preview body back as it came (previews.ts checks it), hostile ones included", async () => {
    const { meta, fake } = setup();
    fake.scenario("hostile_preview");
    const res = await meta.generatePreviews(AD, { creative: { object_story_spec: { page_id: FAKE_PAGE_ID } }, adFormat: "MOBILE_FEED_STANDARD" });
    expect(res.bodies).toHaveLength(1);
    expect(res.bodies[0]).toContain("evil.example.com");
  });

  it("R1 maps review feedback per placement", async () => {
    const { meta, fake } = setup();
    fake.scenario("review_feedback");
    const rows = await meta.getAdsReview(AD, fake.reviewSamples());
    const rejected = rows.find((r) => r.effectiveStatus === "DISAPPROVED")!;
    expect(rejected.feedback).toEqual([
      { scope: "global", code: "TEXT_OVERLAY", text: "Your ad's image has too much text." },
      { scope: "global", code: "LANDING_PAGE_FAIL", text: "Your landing page doesn't work." },
    ]);
    expect(rejected.issues[0]).toMatchObject({ code: 1487302, level: "AD" });
    expect(rows.find((r) => r.effectiveStatus === "WITH_ISSUES")!.feedback).toEqual([{ scope: "instagram", code: "BRAND_USAGE", text: "Ads can't use Instagram's brand this way." }]);
  });

  it("A2 reports what Meta received; a repeated batch of a session counts once", async () => {
    const { meta, fake } = setup();
    fake.addAudience(AUD);
    const batch = { schema: ["EMAIL" as const], rows: [[HASH], ["b".repeat(64)]] };
    expect(await meta.addAudienceUsers(AD, AUD, batch, { id: 9, batchSeq: 1, last: false })).toMatchObject({ audienceId: AUD, sessionId: 9, numReceived: 2, numInvalid: 0 });
    await meta.addAudienceUsers(AD, AUD, batch, { id: 9, batchSeq: 1, last: false });
    expect(fake.audiences.get(AUD)!.rows).toBe(2);
  });

  it("A1 builds the engagement, website and lookalike shapes", async () => {
    const { meta, fake } = setup();
    await meta.createCustomAudience(AD, { kind: "engagement", name: "Engaged", sources: [{ id: FAKE_IG_ID, type: "ig_business" }], event: "ig_business_profile_all", retentionDays: 365 });
    await meta.createCustomAudience(AD, { kind: "website", name: "Visitors", pixelId: FAKE_PIXEL_ID, retentionDays: 30, urlContains: ["/checkout"] });
    fake.addAudience(AUD);
    await meta.createCustomAudience(AD, { kind: "lookalike", name: "Like buyers", originAudienceId: AUD, ratio: 0.01 });
    const bodies = fake.calls.map((c) => c.body as Record<string, unknown>);
    expect(bodies[0]).toMatchObject({ prefill: 1, rule: { inclusions: { operator: "or", rules: [{ event_sources: [{ id: FAKE_IG_ID, type: "ig_business" }], retention_seconds: 365 * 86_400 }] } } });
    expect(JSON.stringify(bodies[1])).toContain('"operator":"i_contains","value":"/checkout"');
    expect(bodies[2]).toEqual({ name: "Like buyers", subtype: "LOOKALIKE", origin_audience_id: AUD, lookalike_spec: { ratio: 0.01, country: "IN", type: "similarity" } });
  });
});

describe("input checks (nothing is sent)", () => {
  it("L2 refuses a spend key at any depth, more than 15 questions and a privacy link that is not https", async () => {
    const { meta, fetches } = setup();
    await expect(meta.createLeadForm(PAGE, { ...leadFormSpec(), thankYouPage: { title: "x", daily_budget: 100 } })).rejects.toBeInstanceOf(SpendGuardBypassError);
    await expect(meta.createLeadForm(PAGE, { ...leadFormSpec(), contextCard: { content: [{ status: "ACTIVE" }] } })).rejects.toBeInstanceOf(SpendGuardBypassError);
    await expect(meta.createLeadForm(PAGE, { ...leadFormSpec(), customDisclaimer: { checkboxes: [{ creative_test_config: {} }] } })).rejects.toBeInstanceOf(SpendGuardBypassError);
    await expect(meta.createLeadForm(PAGE, { ...leadFormSpec(), questions: Array.from({ length: 16 }, () => ({ type: "CUSTOM" })) })).rejects.toThrow("Add between 1 and 15 questions.");
    await expect(meta.createLeadForm(PAGE, { ...leadFormSpec(), privacyPolicy: { url: "http://example.com/privacy" } })).rejects.toThrow("Your privacy policy link must start with https.");
    expect(fetches()).toBe(0);
  });

  it("L2 sends only the allowlisted keys, never a spend key, and never hides the form from people outside the audience", async () => {
    const { meta, fake } = setup();
    await meta.createLeadForm(PAGE, { ...leadFormSpec(), ...({ status: "ACTIVE", extra: 1 } as object) } as ReturnType<typeof leadFormSpec>);
    const body = fake.calls[0].body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["block_display_for_non_targeted_viewer", "custom_disclaimer", "is_optimized_for_quality", "locale", "name", "privacy_policy", "questions", "thank_you_page"]);
    expect(body.block_display_for_non_targeted_viewer).toBe(false);
  });

  it("A2 refuses rows that are not hashed, rows that do not match the columns, and more than 10,000 rows", async () => {
    const { meta, fake, fetches } = setup();
    fake.addAudience(AUD);
    const s = { id: 1, batchSeq: 1, last: true };
    await expect(meta.addAudienceUsers(AD, AUD, { schema: ["EMAIL"], rows: [["asha@example.com"]] }, s)).rejects.toThrow("Customer details must be hashed before they are sent.");
    await expect(meta.addAudienceUsers(AD, AUD, { schema: ["EMAIL", "PHONE"], rows: [[HASH]] }, s)).rejects.toThrow(HttpError);
    await expect(meta.addAudienceUsers(AD, AUD, { schema: ["EMAIL"], rows: Array.from({ length: MAX_AUDIENCE_ROWS + 1 }, () => [HASH]) }, s)).rejects.toThrow("at most");
    expect(fetches()).toBe(0);
  });

  it("ids that could change the path are refused", async () => {
    const { meta, fetches } = setup();
    await expect(meta.getAudience(AD, "123/copies")).rejects.toBeInstanceOf(HttpError);
    await expect(meta.deleteAudience(AD, "act_1")).rejects.toBeInstanceOf(HttpError);
    await expect(meta.getAdVideoStatus(AD, "1?method=post")).rejects.toBeInstanceOf(HttpError);
    await expect(meta.getAdsReview(AD, ["1", "../act_1"])).rejects.toBeInstanceOf(HttpError);
    await expect(meta.searchPlaces(AD, "a")).rejects.toThrow("Type at least two letters to search.");
    await expect(meta.createAdVideo(AD, { fileUrl: "http://media.example.com/v.mp4", name: "x" })).rejects.toThrow("The video link must start with https.");
    expect(fetches()).toBe(0);
  });
});

describe("L2 builds every nested object from allowlisted keys (9.1 promote-lead-consent, D35)", () => {
  const disclaimer = (box: Record<string, unknown>) => ({ ...leadFormSpec(), customDisclaimer: { title: "Consent", body: "We may message you.", checkboxes: [box] } });

  it("rebuilds the questions, thank-you page, consent section and intro key by key, and drops anything else", async () => {
    const { meta, fake } = setup();
    await meta.createLeadForm(PAGE, {
      ...leadFormSpec(),
      questions: [
        { type: "FULL_NAME", extra: 1, conditional_questions_group_id: "x" },
        { type: "CUSTOM", key: "budget_band", label: "Your budget?", inline_context: "x", options: [{ key: "low", value: "Under ₹10k", logo: "x" }, { value: "Above ₹10k" }] },
      ],
      thankYouPage: { title: "Thanks", body: "We'll call you soon.", button_type: "VIEW_WEBSITE", button_text: "Visit", website_url: "https://example.com", gated_file: "x" },
      customDisclaimer: { title: "Consent", body: "We may message you on WhatsApp.", checkboxes: [{ key: "whatsapp_opt_in", text: "Send me WhatsApp messages", is_required: false, extra: 1 }], foo: 1 },
      contextCard: { title: "Hi", style: "LIST_STYLE", content: ["Fast", "Free"], button_text: "Next", cover_photo_id: "123456", foo: "x" },
    });
    const body = fake.calls[0].body as Record<string, unknown>;
    expect(body.questions).toEqual([{ type: "FULL_NAME" }, { type: "CUSTOM", key: "budget_band", label: "Your budget?", options: [{ key: "low", value: "Under ₹10k" }, { value: "Above ₹10k" }] }]);
    expect(body.thank_you_page).toEqual({ title: "Thanks", body: "We'll call you soon.", button_type: "VIEW_WEBSITE", button_text: "Visit", website_url: "https://example.com/" });
    // Every box goes out unticked, said explicitly, whatever Meta's default is.
    expect(body.custom_disclaimer).toEqual({ title: "Consent", body: "We may message you on WhatsApp.", checkboxes: [{ key: "whatsapp_opt_in", text: "Send me WhatsApp messages", is_required: false, is_checked_by_default: false }] });
    expect(body.context_card).toEqual({ title: "Hi", style: "LIST_STYLE", content: ["Fast", "Free"], button_text: "Next", cover_photo_id: "123456" });
  });

  it("keeps a consent text with links, and only the link fields", async () => {
    const { meta, fake } = setup();
    await meta.createLeadForm(PAGE, {
      ...leadFormSpec(),
      customDisclaimer: { body: { text: "See our policy.", url_entities: [{ offset: 8, length: 6, url: "https://example.com/p", tracking: "x" }], extra: 1 } },
    });
    expect((fake.calls[0].body as Record<string, unknown>).custom_disclaimer).toEqual({ body: { text: "See our policy.", url_entities: [{ offset: 8, length: 6, url: "https://example.com/p" }] } });
  });

  it("a box ticked in advance is refused, and nothing is sent", async () => {
    const { meta, fetches } = setup();
    for (const ticked of [true, "true", 1]) {
      await expect(meta.createLeadForm(PAGE, disclaimer({ key: "whatsapp_opt_in", text: "Send me WhatsApp messages", is_checked_by_default: ticked }))).rejects.toThrow(
        "Consent boxes can't be ticked in advance. People must tick them themselves.",
      );
    }
    expect(fetches()).toBe(0);
  });

  it("a box that asks to message people can't be required (read as lead sync reads it); a terms box can", async () => {
    const { meta, fake, fetches } = setup();
    await expect(meta.createLeadForm(PAGE, disclaimer({ key: "whatsapp_opt_in", text: "I agree to get WhatsApp messages from Fake Shop", is_required: true }))).rejects.toThrow(/must stay optional/);
    await expect(meta.createLeadForm(PAGE, disclaimer({ key: "updates", text: "Receive WhatsApp updates", is_required: true }))).rejects.toThrow(/must stay optional/);
    expect(fetches()).toBe(0);
    await meta.createLeadForm(PAGE, disclaimer({ key: "terms", text: "I accept the terms and conditions", is_required: true }));
    expect(((fake.calls[0].body as Record<string, unknown>).custom_disclaimer as { checkboxes: unknown[] }).checkboxes).toEqual([
      { key: "terms", text: "I accept the terms and conditions", is_required: true, is_checked_by_default: false },
    ]);
  });

  it("refuses nested values Meta would not take, with plain copy and nothing sent", async () => {
    const { meta, fetches } = setup();
    const form = (over: Record<string, unknown>) => meta.createLeadForm(PAGE, { ...leadFormSpec(), ...over });
    await expect(form({ questions: [{ label: "No type" }] })).rejects.toThrow("Choose a type for each question.");
    await expect(form({ questions: [{ type: "CUSTOM", label: "x".repeat(501) }] })).rejects.toThrow("Each question can be up to 500 characters.");
    await expect(form({ questions: [{ type: "CUSTOM", label: "Pick", options: [{ key: "a" }] }] })).rejects.toThrow("Each answer to choose from needs text.");
    await expect(form({ thankYouPage: { website_url: "javascript:alert(1)" } })).rejects.toThrow("The thank-you page's website link is not valid.");
    await expect(form({ thankYouPage: { button_type: "view website" } })).rejects.toThrow("Choose what the thank-you button does.");
    await expect(form({ thankYouPage: { business_phone_number: "call me" } })).rejects.toThrow("The thank-you page's phone number is not valid.");
    await expect(form({ customDisclaimer: { checkboxes: [{ key: "x" }] } })).rejects.toThrow("Each consent box needs text.");
    await expect(form({ customDisclaimer: "I agree" })).rejects.toBeInstanceOf(HttpError);
    await expect(form({ contextCard: { content: [{ text: "x" }] } })).rejects.toThrow("Each line of the intro must be text, up to 1,000 characters.");
    await expect(form({ contextCard: { cover_photo_id: "../act_1" } })).rejects.toThrow("Choose a valid intro image.");
    expect(fetches()).toBe(0);
  });
});

describe("audience writes check the audience is on this ad account first (A2, A3, A4, A6)", () => {
  const CAMPAIGN = "23850000000000555";
  const OTHER = "23850000000000088";
  const s = { id: 7, batchSeq: 1, last: true };
  const rows = { schema: ["EMAIL" as const], rows: [[HASH]] };
  const NOT_OURS = "That isn't an audience on this ad account. Choose one of its audiences.";

  it("deleting a campaign id is refused with no DELETE sent, and the campaign keeps running", async () => {
    const { meta, fake } = setup();
    fake.base.addCampaign({ id: CAMPAIGN, status: "ACTIVE" });
    await expect(meta.deleteAudience(AD, CAMPAIGN)).rejects.toMatchObject({ status: 400, message: NOT_OURS });
    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${CAMPAIGN}`]);
    expect(fake.calls[0].query.fields).toBe(AUDIENCE_OWNER_FIELDS);
    expect(fake.base.object(CAMPAIGN).status).toBe("ACTIVE");
    await expect(meta.removeAudienceUsers(AD, CAMPAIGN, rows)).rejects.toThrow(NOT_OURS);
    await expect(meta.addAudienceUsers(AD, CAMPAIGN, rows, s)).rejects.toThrow(NOT_OURS);
    expect(fake.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("another ad account's audience (one the same Meta user can reach) is refused for every write and left as it was", async () => {
    const { meta, fake } = setup();
    fake.addAudience(OTHER, { accountId: "act_2", rows: 500 });
    await expect(meta.deleteAudience(AD, OTHER)).rejects.toThrow(NOT_OURS);
    await expect(meta.addAudienceUsers(AD, OTHER, rows, s)).rejects.toThrow(NOT_OURS);
    await expect(meta.replaceAudienceUsers(AD, OTHER, rows, s)).rejects.toThrow(NOT_OURS);
    await expect(meta.removeAudienceUsers(AD, OTHER, rows)).rejects.toThrow(NOT_OURS);
    expect(fake.calls.map((c) => c.method)).toEqual(["GET", "GET", "GET", "GET"]);
    expect(fake.audiences.get(OTHER)).toMatchObject({ deleted: false, rows: 500 });
  });

  it("rows go only to a customer list; any audience of this account can be deleted", async () => {
    const { meta, fake } = setup();
    fake.addAudience(AUD, { subtype: "ENGAGEMENT" });
    await expect(meta.addAudienceUsers(AD, AUD, rows, s)).rejects.toThrow("Customers can only be added to or removed from a customer list audience.");
    await expect(meta.removeAudienceUsers(AD, AUD, rows)).rejects.toThrow("Customers can only be added to or removed from a customer list audience.");
    expect(await meta.deleteAudience(AD, AUD)).toEqual({ deleted: true });
    expect(fake.calls.map((c) => c.method)).toEqual(["GET", "DELETE"]);
  });

  it("ownership is asked once per audience, then kept for an hour", async () => {
    const { meta, fake, advance } = setup();
    fake.addAudience(AUD);
    const batch = (n: number) => meta.addAudienceUsers(AD, AUD, rows, { id: 5, batchSeq: n, last: false });
    await batch(1);
    await batch(2);
    expect(fake.calls.map((c) => c.method)).toEqual(["GET", "POST", "POST"]);
    advance(AUDIENCE_OWNER_TTL_MS);
    await batch(3);
    expect(fake.calls.map((c) => c.method)).toEqual(["GET", "POST", "POST", "GET", "POST"]);
  });

  it("an audience Meta no longer has keeps Meta's own error (nothing is cached or sent)", async () => {
    const { meta, fake } = setup();
    fake.addAudience(AUD);
    fake.audiences.get(AUD)!.deleted = true;
    const e = await meta.removeAudienceUsers(AD, AUD, rows).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GraphError);
    expect((e as GraphError).subcode).toBe(33);
    expect(fake.calls.map((c) => c.method)).toEqual(["GET"]);
  });
});

describe("src/lib/promote/meta.ts (grep rules B3, B10, B11, D18)", () => {
  const source = readFileSync(path.join(process.cwd(), "src", "lib", "promote", "meta.ts"), "utf8");

  it("never calls the ads client", () => {
    expect(source).not.toContain("adsClient(");
    expect(source).not.toMatch(/from\s+["']@\/lib\/ads\/client["']/);
  });

  it("never names a budget or end field (B10), not even inside a longer name", () => {
    expect(source).not.toMatch(/daily_budget|lifetime_budget|end_time/);
  });

  it("never names the unscoped preview edge: every generatepreviews is behind act_", () => {
    const hits = [...source.matchAll(/generatepreviews/g)];
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(source.slice(Math.max(0, (h.index ?? 0) - 16), h.index)).toMatch(/act_\$\{[\w.]+\}\/$/);
    expect(source).not.toMatch(/["'`]\/?generatepreviews/);
  });

  it("names funding_source only inside the ad account field list, which is a GET field list", () => {
    const hits = [...source.matchAll(/funding_source/g)];
    expect(hits).toHaveLength(1);
    const line = source.slice(source.lastIndexOf("\n", hits[0].index) + 1, source.indexOf("\n", hits[0].index));
    expect(line).toBe(`export const AD_ACCOUNT_HEALTH_FIELDS = "${AD_ACCOUNT_HEALTH_FIELDS}";`);
    expect(AD_ACCOUNT_HEALTH_FIELDS.endsWith(",funding_source_details{type}")).toBe(true);
    // The field list is only ever a query: besides its definition and the response key read from it, the one use is the C4 GET.
    const uses = source.split("\n").filter((l) => l.includes("AD_ACCOUNT_HEALTH_FIELDS"));
    expect(uses).toHaveLength(3);
    expect(uses[1]).toMatch(/^const FUNDING_KEY = AD_ACCOUNT_HEALTH_FIELDS\.slice\(/);
    expect(uses[2]).toMatch(/method: "GET", path: a\.act, query: \{ fields: AD_ACCOUNT_HEALTH_FIELDS \}/);
  });

  it("talks to Meta only through graphFetchAs", () => {
    expect(source).not.toMatch(/(?<![\w.$])fetch\s*\(/);
    expect(source).not.toContain("graph.facebook.com");
    expect(source).not.toMatch(/\bgraphFetch\s*[<(]|appGraphFetch|graphUpload/);
  });
});
