import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAd, buildAdSet, buildCampaign, buildCreative } from "@/lib/ads/builders";
import { classify, CONFLICTING_VALUE, normalizePath, parseDecimalParam, parseMinorParam, parseTimeParam, pathPattern, type GraphCall } from "@/lib/spend/classify";

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

describe("purity (WP-01 acceptance 1)", () => {
  it("classify.ts imports neither prisma nor fetch", () => {
    const text = readFileSync(path.join(process.cwd(), "src/lib/spend/classify.ts"), "utf8");
    const imports = [...text.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(imports).toEqual(["./types"]);
    expect(text).not.toMatch(/(?<![\w.])fetch\s*\(/);
    expect(text).not.toMatch(/@\/lib\/db|@prisma|generated\/prisma/);
  });
});
