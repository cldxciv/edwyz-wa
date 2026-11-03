import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/crypto/tokens", () => ({ getAccessToken: vi.fn(async () => "TENANT-TOKEN") }));

import { GraphError, graphFetchAs } from "@/lib/graph";
import { parseUsageHeaders } from "@/lib/promote/throttle";
import { mintPermit, runWithPermit } from "@/lib/spend/permit";
import { setTripwireAuditSink } from "@/lib/spend/tripwire";
import { startFakeMetaServer, type FakeMetaServer } from "../e2e/fake-meta-server";
import {
  AUDIENCE_TERMS_1870090,
  AUDIENCE_TERMS_2655,
  createFakeMetaPromote,
  FAKE_ACT,
  FAKE_FORM_ID,
  FAKE_IG_ID,
  FAKE_LEAD_ID,
  FAKE_PAGE_ID,
  FAKE_USER_TOKEN,
  HOSTILE_PREVIEW_BODY,
  LEADGEN_TOS_ERROR,
  SAFE_PREVIEW_BODY,
  type FakeMetaPromote,
} from "./helpers/fake-meta-promote";

/**
 * docs/IG-PAGE-ADS-SPEC.md 9.3 and PRM-03 acceptance 6 and 7 (fake-meta-promote): each scenario of the fake has a self-test, the
 * classify() recorder fails a test on a planted spend call, and the HTTP server (e2e/fake-meta-server.ts) serves the same
 * scenarios on 127.0.0.1, relaying Phase 0's sends (which it cannot see the app's permits for) instead of calling them violations.
 */

const G = "https://graph.facebook.com/v26.0";
type Json = Record<string, unknown>;

/** Sends one request straight to the fake (no transport, no tripwire), as a given token. */
async function call(fake: FakeMetaPromote, method: string, path: string, opts: { token?: string; query?: Record<string, string>; body?: unknown } = {}) {
  const url = new URL(`${G}/${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const res = await fake.fetch(url, {
    method,
    headers: { Authorization: `Bearer ${opts.token ?? FAKE_USER_TOKEN}`, ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, headers: res.headers, json: (await res.json()) as Json };
}
const errorOf = (r: { json: Json }) => r.json.error as Json;
const data = (r: { json: Json }) => r.json.data as Json[];

let fake: FakeMetaPromote;
const newFake = () => (fake = createFakeMetaPromote());

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("scenario: boost ineligibility with reasons", () => {
  it("off: every post and reel can be boosted; on: the first of each cannot, with Meta's reason", async () => {
    newFake();
    const pt = fake.pageToken();
    const before = await call(fake, "GET", `${FAKE_PAGE_ID}/published_posts`, { token: pt, query: { fields: "id,is_eligible_for_promotion" } });
    expect(data(before).every((p) => p.is_eligible_for_promotion === true)).toBe(true);
    fake.scenario("boost_ineligible");
    const posts = await call(fake, "GET", `${FAKE_PAGE_ID}/published_posts`, { token: pt });
    expect(data(posts)[0].is_eligible_for_promotion).toBe(false);
    expect(data(posts)[1].is_eligible_for_promotion).toBe(true);
    const media = await call(fake, "GET", `${FAKE_IG_ID}/media`, { token: pt });
    expect(data(media)[0].boost_eligibility_info).toEqual({ eligible_to_boost: false, boost_ineligible_reason: "This reel uses music that can't be used in ads." });
    const post = await call(fake, "GET", `${FAKE_PAGE_ID}_100000`, { token: pt, query: { fields: "is_instagram_eligible" } });
    expect(post.json.is_instagram_eligible).toBe(false);
    fake.assertClean();
  });
});

describe("scenario: Custom Audience terms errors 2655 and 1870090", () => {
  it.each([
    ["audience_terms_2655", AUDIENCE_TERMS_2655],
    ["audience_terms_1870090", AUDIENCE_TERMS_1870090],
  ] as const)("%s refuses a customer list, not an engagement audience, and the account shows the terms unaccepted", async (name, error) => {
    newFake();
    fake.scenario(name);
    const list = await call(fake, "POST", `${FAKE_ACT}/customaudiences`, { body: { name: "Buyers", subtype: "CUSTOM", customer_file_source: "USER_PROVIDED_ONLY" } });
    expect(list.status).toBe(400);
    expect(errorOf(list)).toMatchObject(error);
    const engaged = await call(fake, "POST", `${FAKE_ACT}/customaudiences`, { body: { name: "Engaged", rule: { inclusions: {} }, prefill: 1 } });
    expect(engaged.status).toBe(200);
    const account = await call(fake, "GET", FAKE_ACT, { query: { fields: "tos_accepted" } });
    expect(account.json.tos_accepted).toEqual({});
    fake.assertClean();
  });
});

describe("scenario: Lead Gen terms missing", () => {
  it("the Page reads leadgen_tos_accepted false and a form create is refused", async () => {
    newFake();
    const pt = fake.pageToken();
    expect((await call(fake, "GET", FAKE_PAGE_ID, { token: pt, query: { fields: "leadgen_tos_accepted" } })).json.leadgen_tos_accepted).toBe(true);
    fake.scenario("leadgen_terms_missing");
    expect((await call(fake, "GET", FAKE_PAGE_ID, { token: pt, query: { fields: "leadgen_tos_accepted" } })).json.leadgen_tos_accepted).toBe(false);
    const create = await call(fake, "POST", `${FAKE_PAGE_ID}/leadgen_forms`, { token: pt, body: { name: "x", questions: [{ type: "FULL_NAME" }], privacy_policy: { url: "https://example.com/p" } } });
    expect(create.status).toBe(400);
    expect(errorOf(create)).toMatchObject(LEADGEN_TOS_ERROR);
  });
});

describe("scenario: #100 for unknown lead fields (and the Page's whatsapp_number)", () => {
  it("asking a lead or a form's leads for platform or is_organic gives #100; without them the read works", async () => {
    newFake();
    const pt = fake.pageToken();
    const withFields = "id,field_data,platform,is_organic";
    expect((await call(fake, "GET", FAKE_LEAD_ID, { token: pt, query: { fields: withFields } })).json).toMatchObject({ platform: "ig", is_organic: false });
    fake.scenario("unknown_lead_fields");
    const lead = await call(fake, "GET", FAKE_LEAD_ID, { token: pt, query: { fields: withFields } });
    expect(lead.status).toBe(400);
    expect(errorOf(lead)).toMatchObject({ code: 100, message: "(#100) Tried accessing nonexisting field (platform) on node type (Lead)" });
    expect(errorOf(lead).error_subcode).toBeUndefined();
    expect((await call(fake, "GET", `${FAKE_FORM_ID}/leads`, { token: pt, query: { fields: "id,is_organic" } })).status).toBe(400);
    const plain = await call(fake, "GET", FAKE_LEAD_ID, { token: pt, query: { fields: "id,field_data" } });
    expect(plain.json).toMatchObject({ id: FAKE_LEAD_ID, field_data: [{ name: "full_name", values: ["Asha"] }] });
    expect(plain.json.platform).toBeUndefined();
  });

  it("page_whatsapp_missing gives #100 on whatsapp_number only", async () => {
    newFake();
    fake.scenario("page_whatsapp_missing");
    const pt = fake.pageToken();
    expect(errorOf(await call(fake, "GET", FAKE_PAGE_ID, { token: pt, query: { fields: "leadgen_tos_accepted,whatsapp_number" } })).message).toContain("(whatsapp_number)");
    expect((await call(fake, "GET", FAKE_PAGE_ID, { token: pt, query: { fields: "leadgen_tos_accepted" } })).status).toBe(200);
  });
});

describe("scenario: 613 and 17 throttles with usage headers", () => {
  it.each([
    [613, "(#613) Calls to this api have exceeded the rate limit."],
    [17, "(#17) User request limit reached"],
  ])("%i: refused with usage at 100% in every usage header, then answers again", async (code, message) => {
    newFake();
    fake.throttleNext({ code, times: 2, regainMinutes: 7, match: /insights|reachestimate/ });
    const q = { targeting_spec: JSON.stringify({ geo_locations: { countries: ["IN"] } }) };
    for (let i = 0; i < 2; i++) {
      const r = await call(fake, "GET", `${FAKE_ACT}/reachestimate`, { query: q });
      expect(r.status).toBe(400);
      expect(errorOf(r)).toMatchObject({ code, message });
      expect(parseUsageHeaders(r.headers)).toMatchObject({ pct: 100, regainMs: 7 * 60_000, sources: ["x-business-use-case-usage", "x-ad-account-usage"] });
    }
    expect((await call(fake, "GET", `${FAKE_ACT}/reachestimate`, { query: q })).status).toBe(200);
  });

  it("carries a subcode when asked, matches only the paths asked, and every answer reports the usage set", async () => {
    newFake();
    fake.throttleNext({ code: 613, subcode: 1487632, match: /minimum_budgets/ });
    expect((await call(fake, "GET", `${FAKE_ACT}/reachestimate`, { query: { targeting_spec: "{}" } })).status).toBe(200);
    expect(errorOf(await call(fake, "GET", `${FAKE_ACT}/minimum_budgets`))).toMatchObject({ code: 613, error_subcode: 1487632 });
    fake.setUsage(81);
    const r = await call(fake, "GET", `${FAKE_ACT}/minimum_budgets`);
    expect(parseUsageHeaders(r.headers)?.pct).toBe(81);
    const insights = await call(fake, "GET", `${FAKE_ACT}/insights`, { query: { level: "campaign", breakdowns: "region" } });
    expect(parseUsageHeaders(insights.headers)?.sources).toContain("x-fb-ads-insights-throttle");
  });
});

describe("scenario: video processing, then ready", () => {
  it("a new video is processing for the set number of status reads, then ready with a preferred thumbnail", async () => {
    newFake();
    fake.setVideoPolls(2);
    const created = await call(fake, "POST", `${FAKE_ACT}/advideos`, { body: { file_url: "https://media.example.com/v.mp4", name: "Reel" } });
    const id = String(created.json.id);
    const states = [];
    for (let i = 0; i < 3; i++) states.push(((await call(fake, "GET", id, { query: { fields: "status,length,thumbnails{uri,is_preferred}" } })).json.status as Json).video_status);
    expect(states).toEqual(["processing", "processing", "ready"]);
    const ready = await call(fake, "GET", id);
    expect(ready.json).toMatchObject({ length: 14.5, thumbnails: { data: [{ is_preferred: false }, { is_preferred: true }] } });
    const start = await call(fake, "POST", `${FAKE_ACT}/video_ads`, { body: { upload_phase: "start", file_size: 1000 } });
    expect(start.json.upload_url).toMatch(/^https:\/\/rupload\.facebook\.com\//);
    expect((await call(fake, "POST", `${FAKE_ACT}/video_ads`, { body: { upload_phase: "finish", video_id: start.json.video_id } })).json).toEqual({ success: true });
  });
});

describe("scenario: generatepreviews bodies, including a hostile one", () => {
  const spec = (igUser?: string) => JSON.stringify({ object_story_spec: { page_id: FAKE_PAGE_ID, ...(igUser ? { instagram_user_id: igUser } : {}), link_data: { link: "https://example.com" } } });

  it("answers Meta's iframe, or the hostile body when asked; Instagram needs instagram_user_id", async () => {
    newFake();
    const ok = await call(fake, "GET", `${FAKE_ACT}/generatepreviews`, { query: { creative: spec(FAKE_IG_ID), ad_format: "INSTAGRAM_STANDARD" } });
    expect(data(ok)).toEqual([{ body: SAFE_PREVIEW_BODY }]);
    expect(SAFE_PREVIEW_BODY).toMatch(/^<iframe src="https:\/\/www\.facebook\.com\//);
    expect(errorOf(await call(fake, "GET", `${FAKE_ACT}/generatepreviews`, { query: { creative: spec(), ad_format: "INSTAGRAM_STANDARD" } })).code).toBe(100);
    fake.scenario("hostile_preview");
    const bad = await call(fake, "GET", "23850000000000004/previews", { query: { ad_format: "MOBILE_FEED_STANDARD" } });
    expect(data(bad)).toEqual([{ body: HOSTILE_PREVIEW_BODY }]);
    expect(HOSTILE_PREVIEW_BODY).toMatch(/<script>/);
    expect(HOSTILE_PREVIEW_BODY).toMatch(/evil\.example\.com/);
    fake.assertClean();
  });

  it("the unscoped preview edge is refused and fails assertClean", async () => {
    newFake();
    const r = await call(fake, "GET", "generatepreviews", { query: { creative: spec(), ad_format: "MOBILE_FEED_STANDARD" } });
    expect(r.status).toBe(400);
    expect(fake.bannedCalls()).toHaveLength(1);
    expect(() => fake.assertNoSpend()).not.toThrow();
    expect(() => fake.assertClean()).toThrow(/unscoped preview edge/);
  });

  it("previews need the user token", async () => {
    newFake();
    const r = await call(fake, "GET", "23850000000000004/previews", { token: fake.pageToken(), query: { ad_format: "MOBILE_FEED_STANDARD" } });
    expect(errorOf(r).code).toBe(190);
    expect(fake.calls[0].tokenKind).toBe("page");
  });
});

describe("scenario: ad_review_feedback samples", () => {
  it("gives a rejected, a with-issues, a pending and an active ad, with global and per-placement feedback", async () => {
    newFake();
    fake.scenario("review_feedback");
    const ids = fake.reviewSamples();
    const r = await call(fake, "GET", `${FAKE_ACT}/ads`, { query: { filtering: JSON.stringify([{ field: "id", operator: "IN", value: ids }]), fields: "id,effective_status,ad_review_feedback" } });
    expect(data(r).map((a) => a.effective_status)).toEqual(["DISAPPROVED", "WITH_ISSUES", "PENDING_REVIEW", "ACTIVE"]);
    expect((data(r)[0].ad_review_feedback as Json).global).toEqual({ TEXT_OVERLAY: "Your ad's image has too much text.", LANDING_PAGE_FAIL: "Your landing page doesn't work." });
    expect((data(r)[1].ad_review_feedback as Json).placement_specific).toEqual({ instagram: { BRAND_USAGE: "Ads can't use Instagram's brand this way." } });
    fake.scenario("review_feedback", false);
    expect(data(await call(fake, "GET", `${FAKE_ACT}/ads`, { query: { filtering: JSON.stringify([{ field: "id", operator: "IN", value: ids }]), fields: "id,ad_review_feedback" } }))).toEqual([]);
  });
});

describe("scenario: breakdown rows", () => {
  it("gives placement, asset, age and gender, region and run-total rows in Meta's shape; plain insights stay Phase 0's", async () => {
    newFake();
    const q = (breakdowns: string) => call(fake, "GET", `${FAKE_ACT}/insights`, { query: { level: "ad", time_increment: "1", breakdowns } });
    const placement = data(await q("publisher_platform,platform_position"));
    expect(placement.map((r) => `${r.publisher_platform}|${r.platform_position}`)).toEqual(["facebook|feed", "instagram|stream", "instagram|reels", "facebook|facebook_new_surface"]);
    expect(placement[0]).toMatchObject({ spend: "120.50", impressions: "4000", ad_id: "23850000000000101" });
    expect(data(await q("body_asset"))[0].body_asset).toEqual({ id: "1001", text: "Chat with us on WhatsApp" });
    expect(data(await q("age,gender")).map((r) => `${r.age}/${r.gender}`)).toEqual(["18-24/female", "25-34/male", "35-44/unknown"]);
    expect(data(await q("region")).map((r) => r.region)).toEqual(["Maharashtra", "Karnataka"]);
    const run = await call(fake, "GET", `${FAKE_ACT}/insights`, { query: { level: "campaign", time_range: JSON.stringify({ since: "2026-10-27", until: "2026-10-31" }), fields: "campaign_id,reach,frequency" } });
    expect(data(run)).toEqual([{ campaign_id: "23850000000000301", reach: "5321", frequency: "1.84", date_start: "2026-10-27", date_stop: "2026-10-31" }]);
    const plain = await call(fake, "GET", `${FAKE_ACT}/insights`, { query: { date_preset: "today" } });
    expect(data(plain)[0]).toHaveProperty("spend");
    expect(errorOf(await q("dma")).code).toBe(100);
  });
});

describe("scenario: an ambiguous 5xx after a create", () => {
  it("the object is made, the answer is 500, and graphFetchAs does not send it again", async () => {
    newFake();
    vi.stubGlobal("fetch", fake.fetch);
    fake.failNextCreate({ match: /adspixels/ });
    const before = fake.pixels.size;
    const e = await graphFetchAs(FAKE_USER_TOKEN, { method: "POST", path: `${FAKE_ACT}/adspixels`, body: { name: "Shop pixel" } }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GraphError);
    expect((e as GraphError).status).toBe(500);
    expect((e as GraphError).ambiguous).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(fake.pixels.size).toBe(before + 1);
  });

  it("can also fail without applying, or drop the connection", async () => {
    newFake();
    fake.failNextCreate({ match: /customaudiences/, apply: false });
    const before = fake.audiences.size;
    expect((await call(fake, "POST", `${FAKE_ACT}/customaudiences`, { body: { name: "x", subtype: "CUSTOM" } })).status).toBe(500);
    expect(fake.audiences.size).toBe(before);
    fake.failNextCreate({ kind: "network", match: /customaudiences/ });
    await expect(call(fake, "POST", `${FAKE_ACT}/customaudiences`, { body: { name: "x", subtype: "CUSTOM" } })).rejects.toThrow("fetch failed");
    expect(fake.audiences.size).toBe(before + 1);
  });

  it("a hang never answers until the caller gives up", async () => {
    newFake();
    fake.hangNext();
    const controller = new AbortController();
    const pending = fake.fetch(`${G}/${FAKE_ACT}/minimum_budgets`, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toBeTruthy();
    expect(fake.calls[0].status).toBe(-1);
  });
});

describe("scenario: an adcreatives body with status is rejected (V-P0)", () => {
  const permit = () =>
    mintPermit({ type: "create", correlationId: "sc_c", tenantId: "t1", adAccountExternalId: FAKE_ACT, objectCount: 4, paths: [`${FAKE_ACT}/adcreatives`], maxUses: 4, issuedAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 60_000) });

  it("with status (PAUSED or not) Meta refuses; without it the creative is made", async () => {
    newFake();
    const p = permit();
    const paused = await runWithPermit(p, () => call(fake, "POST", `${FAKE_ACT}/adcreatives`, { body: { name: "C", status: "PAUSED", object_story_id: `${FAKE_PAGE_ID}_100000` } }));
    expect(paused.status).toBe(400);
    expect(errorOf(paused)).toMatchObject({ code: 100, message: "(#100) Param status is not a field of ad creatives" });
    const plain = await runWithPermit(p, () => call(fake, "POST", `${FAKE_ACT}/adcreatives`, { body: { name: "C", object_story_id: `${FAKE_PAGE_ID}_100000` } }));
    expect(plain.status).toBe(200);
    expect(plain.json.id).toMatch(/^cr_/);
    // Sent from the ads choke point (a permit in context), so these are not violations.
    expect(fake.calls.every((c) => c.class === "ads_create" && c.permitted)).toBe(true);
    fake.assertNoSpend();
  });
});

describe("the classify() recorder", () => {
  it("records every request's class, pattern and token kind", async () => {
    newFake();
    await call(fake, "GET", `${FAKE_PAGE_ID}/published_posts`, { token: fake.pageToken() });
    await call(fake, "POST", `${FAKE_ACT}/adimages`, { body: { bytes: "AAEC" } });
    expect(fake.calls.map((c) => [c.method, c.pattern, c.class, c.tokenKind])).toEqual([
      ["GET", "{id}/published_posts", "not_spend", "page"],
      ["POST", "act_{id}/adimages", "not_spend", "user"],
    ]);
  });

  it.each([
    ["an ad set turned on", "POST", "23850000000000201", { status: "ACTIVE" }, "ads_raise_or_unknown"],
    ["a campaign created ACTIVE", "POST", `${FAKE_ACT}/campaigns`, { name: "x", status: "ACTIVE" }, "ads_create"],
    ["a budget raise", "POST", "23850000000000201", { daily_budget: 99_000 }, "ads_raise_or_unknown"],
    ["a WhatsApp message", "POST", "1234567890/messages", { to: "919800000001" }, "msg_send"],
    ["a spending limit", "POST", FAKE_ACT, { spend_cap: "1000" }, "meta_cap"],
  ] as const)("fails the test on a planted spend call: %s", async (_name, method, path, body, cls) => {
    newFake();
    const r = await call(fake, method, path, { body });
    expect(r.status).toBe(400);
    expect(fake.calls[0]).toMatchObject({ class: cls, permitted: false });
    expect(fake.spendViolations()).toHaveLength(1);
    expect(() => fake.assertNoSpend()).toThrow(new RegExp(`reached a spend class: ${method} .*\\(${cls}\\)`));
  });

  it("catches a spend call that slipped past the tripwire in report mode (graphFetchAs, no permit)", async () => {
    newFake();
    vi.stubGlobal("fetch", fake.fetch);
    const prev = process.env.SPEND_TRIPWIRE;
    process.env.SPEND_TRIPWIRE = "report";
    setTripwireAuditSink(() => undefined);
    try {
      await graphFetchAs(FAKE_USER_TOKEN, { method: "POST", path: "23850000000000201", body: { status: "ACTIVE" } }).catch(() => undefined);
    } finally {
      setTripwireAuditSink(null);
      if (prev === undefined) delete process.env.SPEND_TRIPWIRE;
      else process.env.SPEND_TRIPWIRE = prev;
    }
    expect(() => fake.assertNoSpend()).toThrow(/ads_raise_or_unknown/);
  });

  it("a lowering without a permit counts too: promote code never pauses ads", async () => {
    newFake();
    await call(fake, "POST", "23850000000000201", { body: { status: "PAUSED" } });
    expect(fake.calls[0].class).toBe("ads_lowering");
    expect(() => fake.assertNoSpend()).toThrow(/ads_lowering/);
  });

  it("checks tokens like Meta: a Page edge with the user token and an ad account edge with a Page token are refused", async () => {
    newFake();
    expect(errorOf(await call(fake, "GET", `${FAKE_PAGE_ID}/leadgen_forms`, { token: FAKE_USER_TOKEN })).code).toBe(190);
    expect(errorOf(await call(fake, "GET", `${FAKE_ACT}/minimum_budgets`, { token: fake.pageToken() })).code).toBe(190);
    const loose = createFakeMetaPromote({ strictTokens: false });
    expect((await call(loose, "GET", `${FAKE_PAGE_ID}/leadgen_forms`, { token: FAKE_USER_TOKEN })).status).toBe(200);
  });

  it("answers an audience's ad account (without act_) and subtype; a campaign has no subtype, so Meta's #100", async () => {
    newFake();
    fake.addAudience("23850000000000077", { accountId: "act_2", subtype: "ENGAGEMENT" });
    const aud = await call(fake, "GET", "23850000000000077", { query: { fields: "account_id,subtype" } });
    expect(aud.json).toMatchObject({ id: "23850000000000077", account_id: "2", subtype: "ENGAGEMENT" });
    expect((await call(fake, "GET", "23850000000000077", { query: { fields: "approximate_count_lower_bound" } })).json.subtype).toBeUndefined();
    fake.base.addCampaign({ id: "23850000000000555", status: "ACTIVE" });
    const campaign = await call(fake, "GET", "23850000000000555", { query: { fields: "account_id,subtype" } });
    expect(campaign.status).toBe(400);
    expect(errorOf(campaign)).toMatchObject({ code: 100, message: "(#100) Tried accessing nonexisting field (subtype) on node type (Campaign)" });
    expect(errorOf(campaign).error_subcode).toBeUndefined();
    expect((await call(fake, "GET", "23850000000000555")).status).toBe(200);
  });

  it("reset clears calls, injections and scenarios", async () => {
    newFake();
    fake.scenario("hostile_preview");
    fake.throttleNext({ code: 17 });
    await call(fake, "GET", "generatepreviews");
    fake.reset();
    expect(fake.calls).toHaveLength(0);
    expect(fake.scenarios()).toEqual([]);
    expect((await call(fake, "GET", `${FAKE_ACT}/minimum_budgets`)).status).toBe(200);
  });
});

describe("the HTTP server (e2e/fake-meta-server.ts)", () => {
  let server: FakeMetaServer;
  const realFetch = globalThis.fetch;
  beforeAll(async () => {
    server = await startFakeMetaServer({ port: 0 });
  });
  afterAll(async () => {
    await server.close();
  });

  const http = (path: string, init: RequestInit = {}) => realFetch(`${server.url}${path}`, init);

  it("listens on 127.0.0.1 and answers the same scenarios over HTTP", async () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await (await http("/__fake/health")).json()).toEqual({ ok: true });
    const posts = await http(`/v26.0/${FAKE_PAGE_ID}/published_posts?limit=2`, { headers: { Authorization: `Bearer ${server.fake.pageToken()}` } });
    expect(posts.status).toBe(200);
    expect(((await posts.json()) as Json).data).toHaveLength(2);
    expect(parseUsageHeaders(posts.headers)?.pct).toBe(4);

    await http("/__fake/scenario", { method: "POST", body: JSON.stringify({ name: "hostile_preview" }) });
    const preview = await http(`/v26.0/${FAKE_ACT}/generatepreviews?ad_format=MOBILE_FEED_STANDARD&creative=${encodeURIComponent(JSON.stringify({ object_story_spec: { page_id: FAKE_PAGE_ID } }))}`, {
      headers: { Authorization: `Bearer ${FAKE_USER_TOKEN}` },
    });
    expect(((await preview.json()) as { data: Json[] }).data[0].body).toBe(HOSTILE_PREVIEW_BODY);

    await http("/__fake/throttle", { method: "POST", body: JSON.stringify({ code: 17, match: "minimum_budgets" }) });
    const throttled = await http(`/v26.0/${FAKE_ACT}/minimum_budgets`, { headers: { Authorization: `Bearer ${FAKE_USER_TOKEN}` } });
    expect(throttled.status).toBe(400);
    expect(((await throttled.json()) as { error: Json }).error.code).toBe(17);

    const calls = (await (await http("/__fake/calls")).json()) as { calls: Json[] };
    expect(calls.calls.map((c) => c.pattern)).toEqual(["{id}/published_posts", "act_{id}/generatepreviews", "act_{id}/minimum_budgets"]);
    expect(JSON.stringify(calls)).not.toContain(FAKE_USER_TOKEN);
  });

  it("refuses and lists a spend call, and refuses a request whose Host is not loopback", async () => {
    await http("/__fake/reset", { method: "POST" });
    const spend = await http(`/v26.0/${FAKE_ACT}/campaigns`, { method: "POST", headers: { Authorization: `Bearer ${FAKE_USER_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: "x", status: "ACTIVE" }) });
    expect(spend.status).toBe(400);
    expect(await (await http("/__fake/violations")).json()).toEqual({ spend: [{ method: "POST", pattern: "act_{id}/campaigns", class: "ads_create" }], bannedPreviews: 0 });

    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: server.port, path: "/__fake/health", headers: { Host: "evil.example.com" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("relays a WhatsApp message and a spending-limit write to Phase 0's fake and lists them apart; an ads class is still a violation", async () => {
    // The app's permits live in the app's process (its own tripwire checks them), so over HTTP the fake cannot see them.
    await http("/__fake/reset", { method: "POST" });
    const sends = server.fake.base.sends.length;
    const post = (path: string, body: unknown, token = FAKE_USER_TOKEN) =>
      http(`/v26.0/${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const msg = await post("1234567890/messages", { messaging_product: "whatsapp", to: "919800000001", type: "text", text: { body: "Hi" } }, "TENANT-TOKEN");
    expect(msg.status).toBe(200);
    expect(((await msg.json()) as { messages: { id: string }[] }).messages[0].id).toMatch(/^wamid\.fake/);
    expect(server.fake.base.sends.length).toBe(sends + 1);
    const cap = await post(FAKE_ACT, { spend_cap: "1000" });
    expect(cap.status).toBe(200);
    expect((await post(`${FAKE_ACT}/campaigns`, { name: "x", status: "ACTIVE" })).status).toBe(400);

    const relayed = (await (await http("/__fake/relayed")).json()) as { calls: Json[] };
    expect(relayed.calls.map((c) => [c.method, c.class, c.status])).toEqual([
      ["POST", "msg_send", 200],
      ["POST", "meta_cap", 200],
    ]);
    expect(await (await http("/__fake/violations")).json()).toEqual({ spend: [{ method: "POST", pattern: "act_{id}/campaigns", class: "ads_create" }], bannedPreviews: 0 });
    const calls = (await (await http("/__fake/calls")).json()) as { calls: Json[] };
    expect(calls.calls.map((c) => [c.class, c.permitted, c.relayed])).toEqual([
      ["msg_send", false, true],
      ["meta_cap", false, true],
      ["ads_create", false, false],
    ]);
  });

  it("in process, a WhatsApp message with no permit is still a violation (nothing is relayed there)", async () => {
    newFake();
    const r = await call(fake, "POST", "1234567890/messages", { body: { to: "919800000001" } });
    expect(r.status).toBe(400);
    expect(fake.relayedCalls()).toHaveLength(0);
    expect(fake.spendViolations()).toHaveLength(1);
    expect(fake.base.sends).toHaveLength(0);
  });

  it("validates control input", async () => {
    expect((await http("/__fake/scenario", { method: "POST", body: JSON.stringify({ name: "nope" }) })).status).toBe(400);
    expect((await http("/__fake/throttle", { method: "POST", body: "{bad" })).status).toBe(400);
    expect((await http("/__fake/unknown")).status).toBe(404);
  });
});
