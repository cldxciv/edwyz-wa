import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAd, buildAdSet, buildCampaign, buildCreative } from "@/lib/ads/builders";
import { BANNED_PARAMS, classify, CONFLICTING_VALUE, normalizePath, parseDecimalParam, parseMinorParam, parseTimeParam, pathPattern, type GraphCall } from "@/lib/spend/classify";

/**
 * docs/SPEND-CONTROLS-SPEC.md 4.7 and 10.1 (spend-classify.test.ts): a fixture for every Graph call the code makes today.
 * Each not_spend fixture names the file it comes from; every ads client body, spend_cap write and /messages POST is spend.
 */

const ACT = "act_1234567890";
const PAGE = "104857600123";
const IG = "17841400000000001";
const WABA = "102290129340398";
const PHONE = "106540352242922";

// ===== Today's calls that must stay not_spend =====
const NOT_SPEND: [string, GraphCall][] = [
  ["conversions/worker.ts: CAPI events", { method: "POST", path: `${"1234"}/events`, body: { data: [{ event_name: "Lead", event_time: 1761600000, event_id: "e1", action_source: "system_generated", user_data: { ph: ["abc"] } }] } }],
  ["meta-connect/discovery.ts: page subscribed_apps (POST with query)", { method: "POST", path: `${PAGE}/subscribed_apps`, query: { subscribed_fields: "leadgen" } }],
  ["meta-connect/discovery.ts: page subscribed_apps (DELETE)", { method: "DELETE", path: `${PAGE}/subscribed_apps` }],
  ["meta-connect/discovery.ts: page subscribed_apps (GET)", { path: `${PAGE}/subscribed_apps`, query: { fields: "id,subscribed_fields" } }],
  ["onboarding/index.ts: WABA subscribed_apps", { method: "POST", path: `${WABA}/subscribed_apps` }],
  ["content/publishers.ts: Facebook feed", { method: "POST", path: `${PAGE}/feed`, body: { message: "Hello", link: "https://example.com" } }],
  ["content/publishers.ts: Facebook photo", { method: "POST", path: `${PAGE}/photos`, body: { url: "https://cdn.example.com/a.jpg", caption: "Hi", published: true } }],
  ["content/publishers.ts: Facebook video", { method: "POST", path: `${PAGE}/videos`, body: { file_url: "https://cdn.example.com/a.mp4", description: "Hi" } }],
  ["content/publishers.ts: Instagram image container", { method: "POST", path: `${IG}/media`, body: { image_url: "https://cdn.example.com/a.jpg", caption: "Hi" } }],
  ["content/publishers.ts: Instagram reel container", { method: "POST", path: `${IG}/media`, body: { media_type: "REELS", video_url: "https://cdn.example.com/a.mp4", caption: "Hi" } }],
  ["content/publishers.ts: Instagram publish", { method: "POST", path: `${IG}/media_publish`, body: { creation_id: "179000" } }],
  ["content/publishers.ts: publishing limit", { path: `${IG}/content_publishing_limit`, query: { fields: "quota_usage,config" } }],
  ["content/publishers.ts: container status", { path: "179000", query: { fields: "status_code" } }],
  ["meta-connect/service.ts: DELETE permissions", { method: "DELETE", path: "10159000000/permissions" }],
  ["meta-connect/service.ts: debug_token", { path: "debug_token", query: { input_token: "x" } }],
  ["meta-connect/service.ts: code exchange", { path: "oauth/access_token", query: { code: "c", redirect_uri: "https://wa.edwyz.com/x" } }],
  ["meta-connect/service.ts: long-lived exchange", { path: "oauth/access_token", query: { grant_type: "fb_exchange_token", fb_exchange_token: "t" } }],
  ["meta-connect/discovery.ts: me/accounts", { path: "me/accounts", query: { fields: "id,name,access_token" } }],
  ["meta-connect/discovery.ts: ad account read with spend_cap field", { path: ACT, query: { fields: "name,currency,timezone_name,amount_spent,spend_cap" } }],
  ["onboarding/index.ts: code exchange", { path: "oauth/access_token", query: { code: "c" } }],
  ["onboarding/index.ts: phone numbers", { path: `${WABA}/phone_numbers`, query: { fields: "id", limit: "100" } }],
  ["onboarding/index.ts: register the number", { method: "POST", path: `${PHONE}/register`, body: { messaging_product: "whatsapp", pin: "123456" } }],
  ["onboarding/index.ts: number details", { path: PHONE, query: { fields: "display_phone_number,verified_name,quality_rating,messaging_limit_tier,name_status" } }],
  ["templates/service.ts: template create", { method: "POST", path: `${WABA}/message_templates`, body: { name: "order_update", language: "en", category: "UTILITY", components: [{ type: "BODY", text: "Hi {{1}}" }] } }],
  ["templates/service.ts: template list", { path: `${WABA}/message_templates`, query: { limit: "100", fields: "id,name,language,category,status,components,rejected_reason" } }],
  ["templates/service.ts: template delete", { method: "DELETE", path: `${WABA}/message_templates`, query: { name: "order_update" } }],
  ["templates/upload.ts: upload session", { method: "POST", path: "1799953191201553/uploads", query: { file_length: "1024", file_type: "image/png", file_name: "a.png" } }],
  ["templates/upload.ts: upload bytes", { method: "POST", path: "upload:MTphdHRhY2htZW50OjEyMzQ=", body: new Uint8Array([1, 2, 3]) }],
  ["inbox/upload.ts: media upload (graphUpload fields)", { method: "POST", path: `${PHONE}/media`, body: { messaging_product: "whatsapp", type: "application/pdf" } }],
  ["inbox/media.ts: media lookup", { path: "1234567890123456" }],
  ["ads/insights-fetch.ts: insights", { path: `${ACT}/insights`, query: { level: "adset", fields: "spend,impressions,clicks", time_range: "{}" } }],
  ["ads/client.ts: findCampaignsByName", { method: "GET", path: `${ACT}/campaigns`, query: { fields: "id,name,status,created_time", filtering: "[]", limit: "100" } }],
  ["leads/ingest.ts: lead read", { path: "9988776655", query: { fields: "field_data,form_id,created_time" } }],
  ["leads/form-definition.ts: form read", { path: "5566778899", query: { fields: "questions,legal_content" } }],
  ["spend/reconcile.ts: object read", { method: "GET", path: "23850000000000001", query: { fields: "effective_status,status,daily_budget,lifetime_budget,end_time" } }],
  ["a rename of an ad object", { method: "POST", path: "23850000000000001", body: { name: "Diwali leads" } }],
  ["a read receipt", { method: "POST", path: `${PHONE}/messages`, body: { messaging_product: "whatsapp", status: "read", message_id: "wamid.X" } }],
];

describe("every existing non-spend Graph call is not_spend", () => {
  it.each(NOT_SPEND)("%s", (_name, call) => {
    const c = classify(call);
    expect(c.class).toBe("not_spend");
    expect(c.direction).toBe("none");
  });
});

// ===== Spend writes =====
const campaign = buildCampaign({ name: "Diwali", template: "lead_generation", specialAdCategory: "none" });
const adSet = buildAdSet({
  name: "Delhi",
  metaCampaignId: "238500001",
  template: "lead_generation",
  targeting: { geo: { countries: ["IN"], cities: [] }, ageMin: 18, ageMax: 65, genders: [], interests: [], placements: [], lookalikeAudienceIds: [] },
  specialAdCategory: "none",
  dailyBudgetMinor: 100_000,
  pageId: PAGE,
  endsAt: new Date("2026-11-30T18:29:59Z"),
});
const creative = buildCreative({ name: "C1", template: "traffic", creative: { pageId: PAGE, message: "Hi", link: "https://example.com", imageUrl: "https://cdn.example.com/a.jpg" } });
const ad = buildAd({ name: "A1", metaAdSetId: "238500002", metaCreativeId: "238500003" });

describe("every ads client body is spend, with the right direction", () => {
  it.each([
    ["createCampaign", "campaigns", campaign],
    ["createAdSet", "adsets", adSet],
    ["createCreative", "adcreatives", creative],
    ["createAd", "ads", ad],
  ] as const)("%s -> ads_create (neutral: created PAUSED)", (_name, edge, body) => {
    const c = classify({ method: "POST", path: `${ACT}/${edge}`, body });
    expect(c).toMatchObject({ class: "ads_create", direction: "neutral", createKind: edge, account: ACT, pattern: `act_{id}/${edge}` });
  });

  it("builders create everything PAUSED except creatives, which carry no status (erratum 12.1b)", () => {
    expect(campaign.status).toBe("PAUSED");
    expect(adSet.status).toBe("PAUSED");
    expect(ad.status).toBe("PAUSED");
    expect("status" in creative).toBe(false);
  });

  it("setStatus ACTIVE is a raise; PAUSED and ARCHIVED are lowering", () => {
    expect(classify({ method: "POST", path: "238500002", body: { status: "ACTIVE" } })).toMatchObject({ class: "ads_raise_or_unknown", direction: "raise", objectId: "238500002", pattern: "{id}" });
    expect(classify({ method: "POST", path: "238500002", body: { status: "PAUSED" } })).toMatchObject({ class: "ads_lowering", direction: "lower" });
    expect(classify({ method: "POST", path: "238500002", body: { status: "ARCHIVED" } })).toMatchObject({ class: "ads_lowering", direction: "lower" });
    expect(classify({ method: "POST", path: "238500002", body: { status: "DELETED" } }).class).toBe("ads_lowering");
    expect(classify({ method: "POST", path: "238500002", body: { status: "paused", name: "x" } }).class).toBe("ads_lowering");
  });

  it("setDailyBudget and other spend fields on an object need a permit (direction unknown to the transport)", () => {
    for (const body of [
      { daily_budget: 120_000 },
      { lifetime_budget: "5000000" },
      { end_time: "2026-12-31T00:00:00Z" },
      { stop_time: "2026-12-31T00:00:00Z" },
      { bid_amount: 500 },
      { spend_cap: 1000 },
      { daily_spend_cap: 1000 },
      { is_adset_budget_sharing_enabled: true },
      { status: "PAUSED", daily_budget: 50_000 },
      { status: "IN_PROCESS" },
    ]) {
      expect(classify({ method: "POST", path: "238500002", body }), JSON.stringify(body)).toMatchObject({ class: "ads_raise_or_unknown" });
    }
  });

  it("spend_cap and spend_cap_action on the ad account are meta_cap", () => {
    expect(classify({ method: "POST", path: ACT, body: { spend_cap: "1234.56" } })).toMatchObject({ class: "meta_cap", account: ACT, pattern: "act_{id}" });
    expect(classify({ method: "POST", path: ACT, body: { spend_cap_action: "delete" } }).class).toBe("meta_cap");
    expect(classify({ method: "POST", path: ACT, query: { spend_cap: "10" } }).class).toBe("meta_cap");
    // Any other write to the ad account itself is treated as raising.
    expect(classify({ method: "POST", path: ACT, body: { name: "x" } }).class).toBe("ads_raise_or_unknown");
  });

  it("a message send is msg_send", () => {
    const send = classify({ method: "POST", path: `${PHONE}/messages`, body: { messaging_product: "whatsapp", to: "919800000000", type: "template", template: { name: "x" } } });
    expect(send).toMatchObject({ class: "msg_send", direction: "raise", objectId: PHONE, pattern: "{id}/messages" });
    // A "read" status with a recipient is a send, not a receipt.
    expect(classify({ method: "POST", path: `${PHONE}/messages`, body: { status: "read", to: "91980" } }).class).toBe("msg_send");
  });
});

describe("parameters Meta reads from anywhere count, and odd shapes are treated as raising", () => {
  it("reads spend fields from the query string, a query inside the path and string bodies", () => {
    expect(classify({ method: "POST", path: "238500002", query: { status: "ACTIVE" } }).class).toBe("ads_raise_or_unknown");
    expect(classify({ method: "POST", path: "238500002?daily_budget=999999" }).class).toBe("ads_raise_or_unknown");
    expect(classify({ method: "POST", path: "238500002", body: JSON.stringify({ status: "ACTIVE" }) }).class).toBe("ads_raise_or_unknown");
    expect(classify({ method: "POST", path: "238500002", body: "status=ACTIVE" }).class).toBe("ads_raise_or_unknown");
    const form = new FormData();
    form.set("status", "ACTIVE");
    expect(classify({ method: "POST", path: "238500002", body: form }).class).toBe("ads_raise_or_unknown");
    expect(classify({ method: "POST", path: `${ACT}/campaigns?status=ACTIVE`, body: { name: "x" } }).params.status).toBe("ACTIVE");
  });

  it("a field given twice with different values is unreadable, so a 'pause' that also says ACTIVE is not lowering", () => {
    const c = classify({ method: "POST", path: "238500002", query: { status: "ACTIVE" }, body: { status: "PAUSED" } });
    expect(c.class).toBe("ads_raise_or_unknown");
    expect(c.params.status).toBe(CONFLICTING_VALUE);
    expect(classify({ method: "POST", path: "238500002", query: { status: "PAUSED" }, body: { status: "PAUSED" } }).class).toBe("ads_lowering");
  });

  it("a GET with a method=post override is a write", () => {
    expect(classify({ method: "GET", path: "238500002", query: { method: "post", status: "ACTIVE" } }).class).toBe("ads_raise_or_unknown");
    expect(classify({ method: "GET", path: "238500002", query: { method: " post ", status: "ACTIVE" } }).method).toBe("POST");
    // An override that cannot be read (given twice, or in bracket form) counts as a write.
    expect(classify({ method: "GET", path: "238500002?method=get", query: { method: "post", status: "ACTIVE" } })).toMatchObject({ method: "POST", class: "ads_raise_or_unknown" });
    expect(classify({ method: "GET", path: "238500002", query: { "method[0]": "post", status: "ACTIVE" } })).toMatchObject({ method: "POST", class: "ads_raise_or_unknown" });
    expect(classify({ method: "GET", path: "238500002", query: { fields: "id,name" } }).class).toBe("not_spend");
  });

  it("a field the classifier reads, given in bracket form, counts as given with a value no check can read", () => {
    const budget = classify({ method: "POST", path: "238500002", query: { "daily_budget[0]": "999999" } });
    expect(budget).toMatchObject({ class: "ads_raise_or_unknown", why: "spend_field", spendKeys: ["daily_budget"] });
    expect(budget.params.daily_budget).toBe(CONFLICTING_VALUE);
    expect(classify({ method: "POST", path: "238500002?end_time[]=2030-01-01" }).class).toBe("ads_raise_or_unknown");
    expect(classify({ method: "POST", path: "238500002", body: { " bid_amount": 5 } }).class).toBe("ads_raise_or_unknown");
    // A pause that also gives status in bracket form is not lowering.
    const pause = classify({ method: "POST", path: "238500002", body: "status=PAUSED&status[0]=ACTIVE" });
    expect(pause).toMatchObject({ class: "ads_raise_or_unknown", why: "status" });
    expect(pause.params.status).toBe(CONFLICTING_VALUE);
    // A create whose status is also given in bracket form is not PAUSED (the tripwire refuses it as not_paused).
    const create = classify({ method: "POST", path: `${ACT}/adsets`, body: { ...adSet, "status[0]": "ACTIVE" } });
    expect(create.class).toBe("ads_create");
    expect(create.params.status).toBe(CONFLICTING_VALUE);
    // A spend cap in bracket form is a meta_cap write whose value cannot be read.
    const cap = classify({ method: "POST", path: ACT, query: { "spend_cap[0]": "1" } });
    expect(cap.class).toBe("meta_cap");
    expect(cap.params.spend_cap).toBe(CONFLICTING_VALUE);
  });

  it("a batch or a message recipient in bracket form is read as given", () => {
    expect(classify({ method: "POST", path: "238500002", body: "batch[0][method]=POST&batch[0][relative_url]=238500002" })).toMatchObject({ class: "ads_raise_or_unknown", why: "batch" });
    expect(classify({ method: "POST", path: "238500002", query: { "batch[0][relative_url]": "238500002" } })).toMatchObject({ why: "batch" });
    const send = classify({ method: "POST", path: `${PHONE}/messages`, body: { messaging_product: "whatsapp", status: "read", message_id: "wamid.1", "to[0]": "919800000000" } });
    expect(send.class).toBe("msg_send");
    expect(classify({ method: "POST", path: `${PHONE}/messages`, body: { messaging_product: "whatsapp", status: "read", message_id: "wamid.1" } }).class).toBe("not_spend");
  });

  it("a bracketed key whose outer field is not read leaves the class alone", () => {
    expect(classify({ method: "POST", path: "238500002", query: { "targeting[geo_locations][countries][0]": "IN" } })).toMatchObject({ class: "not_spend", why: "no_spend_field" });
    expect(classify({ method: "POST", path: `${PAGE}/feed`, body: { message: "Hi", "child_attachments[0][link]": "https://example.com" } }).class).toBe("not_spend");
    expect(classify({ method: "POST", path: `${ACT}/ads`, query: { "creative[creative_id]": "238500003" }, body: ad })).toMatchObject({ class: "ads_create", createKind: "ads" });
  });

  it("normalizes slashes, a version prefix, full URLs and encoded slashes", () => {
    expect(classify({ method: "POST", path: `/v21.0/${ACT}/campaigns/`, body: campaign }).class).toBe("ads_create");
    expect(classify({ method: "POST", path: `https://graph.example/v21.0/${ACT}/adsets`, body: adSet }).class).toBe("ads_create");
    expect(classify({ method: "POST", path: `${ACT}%2Fads`, body: ad }).class).toBe("ads_create");
    expect(normalizePath("/v19.0/a/b?x=1#frag")).toEqual({ segments: ["a", "b"], query: { x: "1" } });
  });

  it("batch requests, copies, root writes, unknown account edges and unreadable bodies are raising or unknown", () => {
    expect(classify({ method: "POST", path: "", body: { batch: "[]" } }).class).toBe("ads_raise_or_unknown");
    expect(classify({ method: "POST", path: "238500002/copies", body: { status_option: "ACTIVE" } }).class).toBe("ads_raise_or_unknown");
    expect(classify({ method: "POST", path: `${ACT}/adrules_library`, body: { name: "raise budgets" } }).class).toBe("ads_raise_or_unknown");
    expect(classify({ method: "POST", path: `${ACT}/campaigns/extra` }).class).toBe("ads_raise_or_unknown");
    expect(classify({ method: "POST", path: "238500002", body: [1, 2] }).class).toBe("ads_raise_or_unknown");
    expect(classify({ method: "POST", path: `${ACT}/adimages`, body: { bytes: "..." } }).class).toBe("not_spend");
    expect(classify({ method: "PUT", path: "238500002", body: { status: "ACTIVE" } }).class).toBe("ads_raise_or_unknown");
  });

  it("never drops a secret into params, and the pattern never carries ids, queries or bodies", () => {
    const c = classify({ method: "POST", path: `${PHONE}/messages?access_token=EAAsecret`, query: { appsecret_proof: "deadbeef" }, body: { to: "919800000000" } });
    expect(c.params).not.toHaveProperty("access_token");
    expect(c.params).not.toHaveProperty("appsecret_proof");
    expect(c.pattern).toBe("{id}/messages");
    expect(pathPattern(["act_99", "campaigns"])).toBe("act_{id}/campaigns");
    expect(pathPattern(["upload:abc"])).toBe("upload:{id}");
    expect(pathPattern([])).toBe("/");
    expect(pathPattern(["me", "accounts"])).toBe("me/accounts");
    expect(pathPattern(["EAAsecretToken"])).toBe("{id}");
  });
});

describe("value parsers", () => {
  it("parses budgets, caps and end times the way Meta reads them", () => {
    expect(parseMinorParam(120_000)).toBe(120_000n);
    expect(parseMinorParam("120000")).toBe(120_000n);
    expect(parseMinorParam("12.5")).toBeNull();
    expect(parseMinorParam(-1)).toBeNull();
    expect(parseMinorParam(1.5)).toBeNull();
    expect(parseDecimalParam("1234.56")).toEqual({ units: 123456n, scale: 2 });
    expect(parseDecimalParam(10)).toEqual({ units: 10n, scale: 0 });
    expect(parseDecimalParam("abc")).toBeNull();
    expect(parseTimeParam("2026-12-31T00:00:00Z")?.toISOString()).toBe("2026-12-31T00:00:00.000Z");
    expect(parseTimeParam(1798675200)?.toISOString()).toBe("2026-12-31T00:00:00.000Z");
    expect(parseTimeParam("1798675200")?.toISOString()).toBe("2026-12-31T00:00:00.000Z");
    expect(parseTimeParam("soon")).toBeNull();
  });
});

// =====================================================================================================================
// Instagram and Facebook Page ads (docs/IG-PAGE-ADS-SPEC.md 4.2, request P0-2 and P0-12, PRM-01 acceptance 1): one fixture per
// request shape, each not_spend. Shapes with more than one form (M1, M2, A1, C6, C9, R4, R5) have one row per form.
// =====================================================================================================================

const BIZ = "1800000000000001";
const POST_ID = `${PAGE}_9876543210`;
const PIXEL = "1122334455667788";
const VIDEO = "2233445566778899";
const CREATIVE_ID = "23850000000000004";
const FORM = "5566778899001122";
const LEAD = "9988776655443322";
const AUD = "23850000000000077";
const STUDY = "23850000000000099";
const MEDIA_FIELDS = "id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,boost_eligibility_info,boost_ads_list";
const POST_FIELDS = "id,message,created_time,full_picture,permalink_url,status_type,attachments{media_type,media,subattachments},is_eligible_for_promotion,promotable_id";
const LEAD_FIELDS = "id,created_time,ad_id,adset_id,campaign_id,form_id,field_data,custom_disclaimer_responses,platform,is_organic";
const inIds = (ids: string[], field = "id") => JSON.stringify([{ field, operator: "IN", value: ids }]);
const creativeSpec = JSON.stringify({ object_story_spec: { page_id: PAGE, instagram_user_id: IG, link_data: { message: "Hi", link: "https://example.com", image_hash: "abc" } } });
const engagementRule = (type: string, event: string) => ({
  inclusions: { operator: "or", rules: [{ event_sources: [{ id: type === "pixel" ? PIXEL : PAGE, type }], retention_seconds: 31_536_000, filter: { operator: "and", filters: [{ field: "event", operator: "eq", value: event }] } }] },
});

const PROMOTE_NOT_SPEND: [string, GraphCall][] = [
  // Connect and readiness
  ["C1 Pages, tasks and linked Instagram", { path: "me/accounts", query: { fields: "id,name,access_token,tasks,picture{url},instagram_business_account{id,username,name,profile_picture_url}" } }],
  ["C2 Lead Gen terms and WhatsApp link", { path: PAGE, query: { fields: "leadgen_tos_accepted,whatsapp_number" } }],
  ["C3 Page-backed Instagram (read)", { path: `${PAGE}/page_backed_instagram_accounts`, query: { fields: "id,username" } }],
  ["C4 ad account health", { path: ACT, query: { fields: "account_status,disable_reason,currency,timezone_name,business{id},tos_accepted,user_tos_accepted,funding_source_details{type}" } }],
  ["C5 minimum budgets", { path: `${ACT}/minimum_budgets` }],
  ["C6 connected Instagram accounts", { path: `${ACT}/connected_instagram_accounts`, query: { fields: "id,username" } }],
  ["C6 Instagram accounts (alternative)", { path: `${ACT}/instagram_accounts`, query: { fields: "id,username" } }],
  ["C7 pixel readiness", { path: PIXEL, query: { fields: "id,name,last_fired_time,is_unavailable" } }],
  ["C8 Page-backed Instagram (create)", { method: "POST", path: `${PAGE}/page_backed_instagram_accounts` }],
  ["C9 create a pixel on the ad account (P0-12)", { method: "POST", path: `${ACT}/adspixels`, body: { name: "Shop pixel" } }],
  ["C9 create a pixel on the business (P0-12)", { method: "POST", path: `${BIZ}/adspixels`, body: { name: "Shop pixel" } }],
  ["C9 pixel install code", { path: PIXEL, query: { fields: "id,name,code" } }],
  // Boost a post
  ["B1 Facebook published posts", { path: `${PAGE}/published_posts`, query: { fields: POST_FIELDS, limit: "25" } }],
  ["B2 promotable posts", { path: `${PAGE}/promotable_posts`, query: { fields: POST_FIELDS, limit: "25" } }],
  ["B3 Instagram eligibility of a post", { path: POST_ID, query: { fields: "is_instagram_eligible" } }],
  ["B4 Instagram media", { path: `${IG}/media`, query: { fields: MEDIA_FIELDS, limit: "25" } }],
  ["B5 Instagram stories", { path: `${IG}/stories`, query: { fields: MEDIA_FIELDS } }],
  // Media
  ["M1 image upload (bytes)", { method: "POST", path: `${ACT}/adimages`, body: { bytes: "iVBORw0KGgo=" } }],
  ["M1 image copy from another account", { method: "POST", path: `${ACT}/adimages`, body: { copy_from: { source_account_id: "999", hash: "abc123" } } }],
  ["M2 video from a signed URL", { method: "POST", path: `${ACT}/advideos`, body: { file_url: "https://media.example.com/v.mp4?sig=x", name: "Reel" } }],
  ["M2 resumable video start (P0-9)", { method: "POST", path: `${ACT}/video_ads`, body: { upload_phase: "start", file_size: 104_857_600 } }],
  ["M2 resumable video finish (P0-9)", { method: "POST", path: `${ACT}/video_ads`, body: { upload_phase: "finish", video_id: VIDEO, upload_session_id: "77" } }],
  ["M3 video status", { path: VIDEO, query: { fields: "status,length,thumbnails{uri,is_preferred}" } }],
  // Previews
  ["P1 preview before launch", { path: `${ACT}/generatepreviews`, query: { creative: creativeSpec, ad_format: "INSTAGRAM_STANDARD" } }],
  ["P2 preview after launch", { path: `${CREATIVE_ID}/previews`, query: { ad_format: "INSTAGRAM_REELS" } }],
  // Lead forms and leads
  ["L1 lead forms of a Page", { path: `${PAGE}/leadgen_forms`, query: { fields: "id,name,status,locale,questions,privacy_policy_url,created_time,leads_count", limit: "50" } }],
  [
    "L2 create a lead form",
    {
      method: "POST",
      path: `${PAGE}/leadgen_forms`,
      body: {
        name: "Diwali offer",
        questions: [{ type: "FULL_NAME" }, { type: "PHONE" }, { type: "CUSTOM", key: "city", label: "Which city?", options: [{ key: "del", value: "Delhi" }] }],
        privacy_policy: { url: "https://example.com/privacy", link_text: "Privacy policy" },
        thank_you_page: { title: "Thanks", body: "We'll call you soon.", button_type: "VIEW_WEBSITE", button_text: "Visit", website_url: "https://example.com" },
        custom_disclaimer: { title: "Consent", body: "We may message you.", checkboxes: [{ key: "wa", text: "WhatsApp me", is_required: false }] },
        locale: "en_US",
        is_optimized_for_quality: true,
        block_display_for_non_targeted_viewer: false,
      },
    },
  ],
  ["L3 form definition", { path: FORM, query: { fields: "id,name,status,questions,legal_content,privacy_policy_url" } }],
  ["L4 test lead", { method: "POST", path: `${FORM}/test_leads`, body: { field_data: [{ name: "full_name", values: ["Test Lead"] }] } }],
  ["L5 lead backfill", { path: `${FORM}/leads`, query: { filtering: JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: 1761600000 }]), fields: LEAD_FIELDS, limit: "100" } }],
  ["L6 one lead", { path: LEAD, query: { fields: LEAD_FIELDS } }],
  // Audiences and targeting
  ["A1 customer list audience", { method: "POST", path: `${ACT}/customaudiences`, body: { name: "Buyers", subtype: "CUSTOM", customer_file_source: "USER_PROVIDED_ONLY", description: "From Edwyz contacts" } }],
  ["A1 engagement audience", { method: "POST", path: `${ACT}/customaudiences`, body: { name: "Engaged", rule: engagementRule("ig_business", "ig_business_profile_all"), prefill: 1 } }],
  ["A1 website audience", { method: "POST", path: `${ACT}/customaudiences`, body: { name: "Visitors", rule: JSON.stringify(engagementRule("pixel", "PageView")), prefill: 1 } }],
  ["A1 lookalike audience", { method: "POST", path: `${ACT}/customaudiences`, body: { name: "Like buyers", subtype: "LOOKALIKE", origin_audience_id: AUD, lookalike_spec: { ratio: 0.01, country: "IN", type: "similarity" } } }],
  [
    "A2 add customer rows",
    {
      method: "POST",
      path: `${AUD}/users`,
      body: { payload: { schema: ["EMAIL", "PHONE", "FN", "LN", "COUNTRY"], data: [["a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64), "e".repeat(64)]] }, session: { session_id: 42, batch_seq: 1, last_batch_flag: true, estimated_num_total: 1 } },
    },
  ],
  ["A3 replace customer rows", { method: "POST", path: `${AUD}/usersreplace`, body: { payload: { schema: ["EMAIL"], data: [["a".repeat(64)]] }, session: { session_id: 43, batch_seq: 1, last_batch_flag: true } } }],
  ["A4 remove customer rows (DELETE {aud}/users)", { method: "DELETE", path: `${AUD}/users`, body: { payload: { schema: ["PHONE"], data: [["b".repeat(64)]] } } }],
  ["A5 audience size and status", { path: AUD, query: { fields: "approximate_count_lower_bound,approximate_count_upper_bound,operation_status,delivery_status" } }],
  ["A6 delete an audience (DELETE {aud})", { method: "DELETE", path: AUD }],
  ["A7 city, zip and region search", { path: "search", query: { type: "adgeolocation", location_types: JSON.stringify(["city", "zip", "region"]), country_code: "IN", q: "Pune" } }],
  ["A8 interest search", { path: "search", query: { type: "adinterest", q: "yoga", limit: "25" } }],
  ["A9 reach estimate", { path: `${ACT}/reachestimate`, query: { targeting_spec: JSON.stringify({ geo_locations: { countries: ["IN"] }, age_min: 18 }) } }],
  // Review status and results
  [
    "R1 review status of ads",
    { path: `${ACT}/ads`, query: { filtering: inIds(["1", "2"]), fields: "id,effective_status,configured_status,ad_review_feedback,issues_info,adset{id,targeting},creative{effective_object_story_id,effective_instagram_media_id}" } },
  ],
  ["R2 Advantage+ state of campaigns", { path: `${ACT}/campaigns`, query: { filtering: inIds(["1"]), fields: "id,advantage_state_info" } }],
  [
    "R3 results by placement",
    {
      path: `${ACT}/insights`,
      query: {
        level: "ad",
        time_increment: "1",
        breakdowns: "publisher_platform,platform_position",
        fields: "ad_id,adset_id,campaign_id,spend,impressions,reach,clicks,actions,cost_per_action_type,video_thruplay_watched_actions,video_p25_watched_actions",
        filtering: inIds(["1"], "campaign.id"),
      },
    },
  ],
  ["R3a reach of the whole run", { path: `${ACT}/insights`, query: { level: "campaign", time_range: JSON.stringify({ since: "2026-10-28", until: "2026-10-31" }), fields: "campaign_id,reach,frequency", filtering: inIds(["1"], "campaign.id") } }],
  ["R4 results by text", { path: `${ACT}/insights`, query: { level: "ad", breakdowns: "body_asset" } }],
  ["R4 results by video", { path: `${ACT}/insights`, query: { level: "ad", breakdowns: "video_asset" } }],
  ["R5 results by age and gender", { path: `${ACT}/insights`, query: { level: "campaign", time_increment: "1", breakdowns: "age,gender" } }],
  ["R5 results by region", { path: `${ACT}/insights`, query: { level: "campaign", time_increment: "1", breakdowns: "region" } }],
  // Meta split tests (read only; T1 itself is banned until P0-7)
  ["T2 split test results", { path: STUDY, query: { fields: "id,name,type,cells,objectives{id,name,results}" } }],
];

const IDS_IN_4_2 = [
  ...["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9"],
  ...["B1", "B2", "B3", "B4", "B5"],
  ...["M1", "M2", "M3"],
  ...["P1", "P2"],
  ...["L1", "L2", "L3", "L4", "L5", "L6"],
  ...["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9"],
  ...["R1", "R2", "R3", "R3a", "R4", "R5"],
];

describe("every Instagram and Page ads request shape in 4.2 is not_spend (P0-2)", () => {
  it.each(PROMOTE_NOT_SPEND)("%s", (_name, call) => {
    const c = classify(call);
    expect(c, c.why).toMatchObject({ class: "not_spend", direction: "none" });
  });

  it("has a row for every id in 4.2, and no row for an id that is not there", () => {
    const ids = new Set(PROMOTE_NOT_SPEND.map(([name]) => name.split(" ")[0]));
    expect([...ids].filter((id) => id !== "T2").sort()).toEqual([...IDS_IN_4_2].sort());
  });

  it("the pixel create and the resumable video upload are not spend for an explicit reason (P0-12, P0-9)", () => {
    expect(classify({ method: "POST", path: `${ACT}/adspixels`, body: { name: "Shop pixel" } })).toMatchObject({ class: "not_spend", why: "pixel_create", pattern: "act_{id}/adspixels" });
    expect(classify({ method: "POST", path: `${BIZ}/adspixels`, body: { name: "Shop pixel" } })).toMatchObject({ class: "not_spend", why: "pixel_create" });
    expect(classify({ method: "POST", path: `${ACT}/video_ads`, body: { upload_phase: "start", file_size: 10 } })).toMatchObject({ class: "not_spend", why: "video_upload", pattern: "act_{id}/video_ads" });
    const form = new FormData();
    form.set("upload_phase", "transfer");
    form.set("video_file_chunk", new Blob([new Uint8Array([1, 2, 3])]));
    expect(classify({ method: "POST", path: `${ACT}/video_ads`, body: form }).why).toBe("video_upload");
  });

  it("the pixel and video edges still need a permit once they carry a spend field or an unreadable body", () => {
    expect(classify({ method: "POST", path: `${ACT}/adspixels`, body: { name: "x", status: "ACTIVE" } }).class).toBe("ads_raise_or_unknown");
    expect(classify({ method: "POST", path: `${ACT}/video_ads`, body: { upload_phase: "finish", daily_budget: 1 } }).class).toBe("ads_raise_or_unknown");
    expect(classify({ method: "POST", path: `${ACT}/video_ads`, body: [1] }).class).toBe("ads_raise_or_unknown");
    expect(classify({ method: "POST", path: `${BIZ}/adspixels`, body: { name: "x", end_time: "2027-01-01" } }).class).toBe("ads_raise_or_unknown");
  });
});

// ===== Banned edges and parameters (IG-PAGE-ADS-SPEC 4.7, D25, P0-3; PRM-01 acceptance 2) =====

const ADSET = "238500002";
const CAMPAIGN = "238500001";
const deep = (levels: number, leaf: Record<string, unknown>): Record<string, unknown> => {
  let v: Record<string, unknown> = leaf;
  for (let i = 0; i < levels; i++) v = { nested: v };
  return v;
};

const BANNED: [string, GraphCall, string][] = [
  ["budget schedule on an ad set", { method: "POST", path: `${ADSET}/budget_schedules`, body: { budget_value: 100, budget_value_type: "ABSOLUTE", time_start: 1761600000, time_end: 1761686400 } }, "budget_schedule"],
  ["budget schedule on a campaign", { method: "POST", path: `${CAMPAIGN}/budget_schedules`, body: { budget_value: 200, budget_value_type: "MULTIPLIER" } }, "budget_schedule"],
  ["budget schedule with no body", { method: "POST", path: `${ADSET}/budget_schedules` }, "budget_schedule"],
  ["copies of an ad set", { method: "POST", path: `${ADSET}/copies`, body: { status_option: "PAUSED", deep_copy: true } }, "copies"],
  ["copies of a campaign with no body", { method: "POST", path: `${CAMPAIGN}/copies` }, "copies"],
  ["async ad request set", { method: "POST", path: `${ACT}/asyncadrequestsets`, body: { name: "bulk", ad_specs: "[]" } }, "async_ad_requests"],
  ["Graph batch POST /", { method: "POST", path: "/", body: { batch: JSON.stringify([{ method: "POST", relative_url: `${ADSET}`, body: "status=ACTIVE" }]) } }, "batch"],
  ["Graph batch in the query", { method: "POST", path: "", query: { batch: "[]" } }, "batch"],
  ["daily_min_spend_target on an ad set", { method: "POST", path: ADSET, body: { daily_min_spend_target: 50_000 } }, "min_spend_target"],
  ["daily_min_spend_target on an ad set create", { method: "POST", path: `${ACT}/adsets`, body: { ...adSet, daily_min_spend_target: 50_000 } }, "min_spend_target"],
  ["daily_min_spend_target on an edge that is otherwise not spend", { method: "POST", path: `${PAGE}/feed`, body: { message: "Hi", daily_min_spend_target: 1 } }, "min_spend_target"],
  ["lifetime_min_spend_target on an ad set", { method: "POST", path: ADSET, body: { lifetime_min_spend_target: 1 } }, "min_spend_target"],
  ["creative_test_config on an ad set", { method: "POST", path: ADSET, body: { creative_test_config: { test_budget: 5000 } } }, "creative_test"],
  ["creative_test_config on an ad set create", { method: "POST", path: `${ACT}/adsets`, body: { ...adSet, creative_test_config: { test_budget: 5000 } } }, "creative_test"],
  ["creative_test_config nested in an ad create", { method: "POST", path: `${ACT}/ads`, body: { ...ad, creative: { creative_id: "1", creative_test_config: {} } } }, "creative_test"],
  ["creative_test_config inside JSON text", { method: "POST", path: ADSET, body: { targeting: JSON.stringify({ geo_locations: { countries: ["IN"] }, x: [{ creative_test_config: 1 }] }) } }, "creative_test"],
  ["creative_test_config as a bracketed form key", { method: "POST", path: ADSET, body: "creative_test_config[test_budget]=5000" }, "creative_test"],
  ["creative_test_config in JSON text that does not parse", { method: "POST", path: ADSET, body: { cells: '[{"creative_test_config": 1,]' } }, "creative_test"],
  ["creative_test_config in the query", { method: "POST", path: `${PAGE}/photos`, query: { creative_test_config: "{}" } }, "creative_test"],
  [
    "T1 split test on the business",
    { method: "POST", path: `${BIZ}/ad_studies`, body: { name: "A vs B", type: "SPLIT_TEST", cells: [{ name: "A", treatment_percentage: 50, adsets: [ADSET] }], start_time: 1761600000, end_time: 1762204800 } },
    "ad_study",
  ],
  ["T1' split test with a budget at depth", { method: "POST", path: `${BIZ}/ad_studies`, body: { name: "x", cells: JSON.stringify([{ name: "A", adsets: [ADSET], daily_budget: 1 }]) } }, "ad_study"],
  ["T1' split test with creative_test_config", { method: "POST", path: `${BIZ}/ad_studies`, body: { name: "x", creative_test_config: {} } }, "ad_study"],
  ["creative_test_config in a bracketed key of a JSON body", { method: "POST", path: `${ACT}/ads`, body: { ...ad, "creative[creative_test_config]": "{}" } }, "creative_test"],
  ["daily_min_spend_target in a bracketed key, in any case", { method: "POST", path: ADSET, query: { "X[Daily_Min_Spend_Target]": "1" } }, "min_spend_target"],
  ["creative_test_config in a bracketed key inside JSON text", { method: "POST", path: ADSET, body: { name: "x", targeting: JSON.stringify({ "cells[0][creative_test_config]": 1 }) } }, "creative_test"],
];

/**
 * A banned parameter inside a nested bracket key (Meta builds nested fields from them), in the query, in the query inside the
 * path (as typed and percent-encoded) and in a urlencoded body, on the three writes a permit can otherwise cover.
 */
const NESTED_KEYS: [string, string][] = [
  ["creative[creative_test_config]", "creative_test"],
  ["cells[0][creative_test_config]", "creative_test"],
  ["x[daily_min_spend_target]", "min_spend_target"],
  ["adset_spec[lifetime_min_spend_target]", "min_spend_target"],
];
const NESTED_TARGETS: [string, string, Record<string, string>, string][] = [
  ["an ad create", `${ACT}/ads`, { name: "A1", status: "PAUSED", adset_id: ADSET, creative: '{"creative_id":"238500003"}' }, "ads_create"],
  ["an ad set create", `${ACT}/adsets`, { name: "Delhi", status: "PAUSED", campaign_id: CAMPAIGN }, "ads_create"],
  ["an ad set update", ADSET, { name: "Renamed" }, "not_spend"],
];
const NESTED_BANNED: [string, GraphCall, string][] = NESTED_TARGETS.flatMap(([target, path, fields]) =>
  NESTED_KEYS.flatMap(([key, why]): [string, GraphCall, string][] => [
    [`${key} in the query on ${target}`, { method: "POST", path, query: { [key]: "1" }, body: fields }, why],
    [`${key} in the path query on ${target}`, { method: "POST", path: `${path}?${key}=1`, body: fields }, why],
    [`${key} percent-encoded in the path query on ${target}`, { method: "POST", path: `${path}?${new URLSearchParams({ [key]: "1" })}`, body: fields }, why],
    [`${key} in a urlencoded body on ${target}`, { method: "POST", path, body: new URLSearchParams({ ...fields, [key]: "1" }).toString() }, why],
  ]),
);

describe("banned edges and parameters are ads_raise_or_unknown (4.7, D25)", () => {
  it.each(BANNED)("%s", (_name, call, why) => {
    expect(classify(call)).toMatchObject({ class: "ads_raise_or_unknown", direction: "unknown", why });
  });

  it.each(NESTED_BANNED)("%s", (_name, call, why) => {
    const c = classify(call);
    expect(c).toMatchObject({ class: "ads_raise_or_unknown", direction: "unknown", why });
    expect(c.spendKeys.some((k) => BANNED_PARAMS.includes(k))).toBe(true);
  });

  it("the same writes with a nested key that is not banned keep their class (so the rows above are about the banned name)", () => {
    for (const [target, path, fields, cls] of NESTED_TARGETS) {
      expect(classify({ method: "POST", path, body: fields }).class, target).toBe(cls);
      expect(classify({ method: "POST", path, query: { "creative[creative_id]": "1" }, body: fields }).class, target).toBe(cls);
      expect(classify({ method: "POST", path: `${path}?targeting[geo_locations][countries][0]=IN`, body: fields }).class, target).toBe(cls);
      expect(classify({ method: "POST", path, body: new URLSearchParams({ ...fields, "cells[0][name]": "A" }).toString() }).class, target).toBe(cls);
    }
  });

  it("a banned parameter is listed in spendKeys at any depth, so no permit can cover it", () => {
    expect(classify({ method: "POST", path: ADSET, body: { name: "x", targeting: JSON.stringify({ creative_test_config: 1 }) } }).spendKeys).toEqual(["creative_test_config"]);
    expect(classify({ method: "POST", path: ADSET, body: { status: "ACTIVE", daily_min_spend_target: 1 } }).spendKeys).toEqual(["daily_min_spend_target", "status"]);
    expect([...BANNED_PARAMS].sort()).toEqual(["creative_test_config", "daily_min_spend_target", "lifetime_min_spend_target"]);
  });

  it("a write nested past the depth that is read is treated as raising", () => {
    expect(classify({ method: "POST", path: `${PAGE}/feed`, body: deep(40, { message: "Hi" }) })).toMatchObject({ class: "ads_raise_or_unknown", why: "deep_body" });
    expect(classify({ method: "POST", path: `${PAGE}/feed`, body: deep(10, { message: "Hi" }) }).class).toBe("not_spend");
  });

  it("reading or deleting is still not spend, and text that only mentions a name is not a parameter", () => {
    expect(classify({ path: `${ADSET}/budget_schedules` }).class).toBe("not_spend");
    expect(classify({ path: `${ADSET}/copies` }).class).toBe("not_spend");
    expect(classify({ method: "DELETE", path: `${ADSET}/budget_schedules` }).class).toBe("not_spend");
    expect(classify({ path: STUDY, query: { fields: "creative_test_config" } }).class).toBe("not_spend");
    expect(classify({ method: "POST", path: `${PAGE}/feed`, body: { message: "Our creative_test_config tips" } }).class).toBe("not_spend");
  });

  it("S1 to S5 keep their classes (4.7 spend paths)", () => {
    for (const [edge, body] of [["campaigns", campaign], ["adsets", adSet], ["adcreatives", creative], ["ads", ad]] as const) {
      expect(classify({ method: "POST", path: `${ACT}/${edge}`, body }).class, edge).toBe("ads_create");
    }
    expect(classify({ method: "POST", path: ADSET, body: { status: "ACTIVE" } })).toMatchObject({ class: "ads_raise_or_unknown", why: "status" });
    expect(classify({ method: "POST", path: ADSET, body: { daily_budget: 30_000 } })).toMatchObject({ class: "ads_raise_or_unknown", why: "spend_field" });
    expect(classify({ method: "POST", path: ADSET, body: { end_time: "2026-11-01T23:59:00+0530" } })).toMatchObject({ class: "ads_raise_or_unknown", why: "spend_field" });
    expect(classify({ method: "POST", path: ADSET, body: { status: "PAUSED" } })).toMatchObject({ class: "ads_lowering", why: "pause" });
    expect(classify({ method: "POST", path: ADSET, body: { status: "ARCHIVED" } })).toMatchObject({ class: "ads_lowering", why: "pause" });
  });
});

describe("purity (WP-01 acceptance 1)", () => {
  it("classify.ts imports neither prisma nor fetch", () => {
    const text = readFileSync(path.join(process.cwd(), "src/lib/spend/classify.ts"), "utf8");
    const imports = [...text.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(imports).toEqual(["./types"]);
    expect(text).not.toMatch(/(?<![\w.])fetch\s*\(/);
    expect(text).not.toMatch(/@\/lib\/db|@prisma|generated\/prisma/);
  });
});
