import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The creative-shape library (docs/IG-PAGE-ADS-SPEC.md 4.3, D11; PRM-02 acceptance 5): a snapshot of the goal x source x
 * format matrix, every body with the all-OPT_OUT enhancements block, only allowlisted keys, no banned key and no budget
 * or end-time field (rule B10).
 */
import { OPTED_OUT_FEATURES as BUILDER_FEATURES } from "@/lib/ads/builders";
import { BOOST_NEEDS_BUTTON, DEFAULT_URL_TAGS, formatsFor, goalRow, GOALS, LEAD_FORM_LINK, sourcesFor, WHATSAPP_LINK } from "@/lib/promote/catalog";
import {
  buildCreativeShape,
  chooseShape,
  CREATIVE_KEYS,
  CREATIVE_SHAPES,
  creativeShapeProblems,
  type CreativeShapeInput,
  enhancementsSpec,
  OPTED_OUT_FEATURES,
  optOutSpec,
  welcomeMessageJson,
} from "@/lib/promote/creative-shapes";
import type { AdFormat, GoalKey, SourceKind } from "@/lib/promote/types";

const ROOT = path.resolve(__dirname, "..");
const BANNED_KEYS = ["instagram_actor_id", "standard_enhancements", "effective_instagram_story_id"];
const B10 = /\b(daily_budget|lifetime_budget|end_time)\b/;

function input(goal: GoalKey, source: SourceKind, format: AdFormat, tall = false, over: Partial<CreativeShapeInput> = {}): CreativeShapeInput {
  return {
    name: `${goal} · ${source} · ${format}${tall ? " · tall" : ""}`,
    goal,
    source,
    format,
    pageId: "PAGE_1",
    instagramUserId: "IG_1",
    promotableId: "PAGE_1_POST_9",
    alsoInstagram: true,
    igEligible: true,
    igMediaId: "IGM_7",
    primaryText: "Diwali offer: 20% off all services",
    headline: "Book today",
    description: "Open 10 to 8",
    link: "https://shop.example.in/offer",
    leadFormId: "FORM_5",
    welcome: { message: "Hi! I saw your ad and want to know more", iceBreakers: [{ title: "Price?", response: "Haircuts start at ₹499." }] },
    media: tall
      ? { imageHash: "H_FEED", verticalImageHash: "H_TALL", videoId: "V_FEED", verticalVideoId: "V_TALL", thumbHash: "H_THUMB", verticalThumbHash: "H_THUMB_TALL" }
      : { imageHash: "H_FEED", videoId: "V_FEED", thumbHash: "H_THUMB" },
    cards: [
      { imageHash: "H_C1", headline: "Haircut", description: "From ₹499", link: "https://shop.example.in/hair" },
      { imageHash: "H_C2", headline: "Facial", description: "From ₹899", link: "https://shop.example.in/facial" },
      { videoId: "V_C3", thumbHash: "H_C3", headline: "Spa", description: "From ₹1,499", link: null },
    ],
    positions: [],
    ...over,
  };
}

/**
 * Every cell of the matrix: each goal's sources and formats, and the tall variant for single images and videos. A post
 * for a goal whose button carries a value is usable only once the boost button is proven (V-P3), so its cell is built as
 * the runbook builds it, with ctaOnBoost (suffix |cta).
 */
function cells(): [string, CreativeShapeInput][] {
  const out: [string, CreativeShapeInput][] = [];
  for (const g of GOALS) {
    for (const source of g.sources) {
      const needsProof = !sourcesFor(g.key).includes(source);
      for (const format of formatsFor(g.key, source, { ctaOnBoost: true })) {
        out.push(needsProof ? [`${g.key}|${source}|${format}|cta`, input(g.key, source, format, false, { ctaOnBoost: true })] : [`${g.key}|${source}|${format}`, input(g.key, source, format)]);
        if (source === "new" && (format === "single_image" || format === "single_video")) out.push([`${g.key}|${source}|${format}|tall`, input(g.key, source, format, true)]);
      }
    }
  }
  return out;
}

function keysOf(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      keysOf(x, out);
    }
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}
/** Comments removed: block comments, and line comments that do not follow a colon or a quote (URLs keep their //). */
const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

const MATRIX = cells();

describe("the goal x source x format matrix (4.3)", () => {
  it("covers every goal and every shape", () => {
    expect(new Set(MATRIX.map(([k]) => k.split("|")[0]))).toEqual(new Set(GOALS.map((g) => g.key)));
    const shapes = new Set(MATRIX.map(([, i]) => chooseShape(i)));
    expect([...shapes].sort()).toEqual([...CREATIVE_SHAPES].sort());
  });

  it("matches the snapshot", () => {
    const snapshot = Object.fromEntries(MATRIX.map(([k, i]) => [k, buildCreativeShape(i)]));
    expect(snapshot).toMatchSnapshot();
  });

  it.each(MATRIX)("%s carries the all-OPT_OUT block, only allowlisted keys, no banned key and no budget or end field", (_k, i) => {
    const { body } = buildCreativeShape(i);
    expect(body.degrees_of_freedom_spec).toEqual(optOutSpec());
    const keys = keysOf(body);
    for (const k of keys) expect(CREATIVE_KEYS.has(k), k).toBe(true);
    for (const b of BANNED_KEYS) expect(keys).not.toContain(b);
    expect(keys.some((k) => /poll/i.test(k))).toBe(false);
    expect(keys).not.toContain("status");
    const json = JSON.stringify(body);
    expect(B10.test(json)).toBe(false);
    for (const b of BANNED_KEYS) expect(json).not.toContain(b);
  });
});

describe("enhancements (D11)", () => {
  it("moves Phase 0's 17-feature list here unchanged", () => {
    expect([...OPTED_OUT_FEATURES]).toEqual([...BUILDER_FEATURES]);
    expect(OPTED_OUT_FEATURES).toHaveLength(17);
    const block = optOutSpec();
    expect(Object.keys(block.creative_features_spec)).toHaveLength(17);
    for (const f of OPTED_OUT_FEATURES) expect(block.creative_features_spec[f]).toEqual({ enroll_status: "OPT_OUT" });
  });

  it("Let Meta improve my ad flips every feature to OPT_IN; per-feature toggles win", () => {
    const { body } = buildCreativeShape(input("website_visits", "new", "single_image", false, { enhancementsOptIn: true }));
    const spec = (body.degrees_of_freedom_spec as ReturnType<typeof enhancementsSpec>).creative_features_spec;
    expect(Object.values(spec).every((s) => s.enroll_status === "OPT_IN")).toBe(true);
    const mixed = enhancementsSpec(false, { image_touchups: true }).creative_features_spec;
    expect(mixed.image_touchups.enroll_status).toBe("OPT_IN");
    expect(mixed.text_optimizations.enroll_status).toBe("OPT_OUT");
    expect(enhancementsSpec(true, { text_translation: false }).creative_features_spec.text_translation.enroll_status).toBe("OPT_OUT");
  });
});

describe("the six shapes", () => {
  it("chooses by source, format and whether a tall version exists", () => {
    expect(chooseShape({ source: "fb_post", format: "existing_post" })).toBe("fb_post_boost");
    expect(chooseShape({ source: "ig_media", format: "existing_post" })).toBe("ig_media_boost");
    expect(chooseShape({ source: "new", format: "carousel" })).toBe("carousel");
    expect(chooseShape({ source: "new", format: "single_image", media: { imageHash: "a" } })).toBe("single_image");
    expect(chooseShape({ source: "new", format: "single_image", media: { imageHash: "a", verticalImageHash: "b" } })).toBe("placement_assets");
    expect(chooseShape({ source: "new", format: "single_video", media: { videoId: "a", verticalVideoId: "b" } })).toBe("placement_assets");
    expect(() => chooseShape({ source: "new", format: "existing_post" })).toThrow(RangeError);
  });

  it("boosts a Facebook post by its promotable id, on Instagram only when asked and eligible", () => {
    const on = buildCreativeShape(input("engagement", "fb_post", "existing_post", false, { promotableId: "98765" })).body;
    expect(on).toMatchObject({ object_story_id: "PAGE_1_98765", instagram_user_id: "IG_1" });
    const ineligible = buildCreativeShape(input("engagement", "fb_post", "existing_post", false, { igEligible: false })).body;
    expect(ineligible.object_story_id).toBe("PAGE_1_POST_9");
    expect(ineligible.instagram_user_id).toBeUndefined();
    // A messaging goal can use a post only once V-P3 proves the button (or the caller says so); then DOF messaging.
    expect(creativeShapeProblems(input("whatsapp_chats", "fb_post", "existing_post"))).toEqual(["goal_source"]);
    expect(() => buildCreativeShape(input("whatsapp_chats", "fb_post", "existing_post"))).toThrow(/goal_source/);
    const chat = buildCreativeShape(input("whatsapp_chats", "fb_post", "existing_post", false, { ctaOnBoost: true })).body;
    expect(chat.asset_feed_spec).toEqual({ optimization_type: "DOF_MESSAGING_DESTINATION", call_to_actions: [{ type: "WHATSAPP_MESSAGE", value: { app_destination: "WHATSAPP" } }] });
  });

  it("boosts Instagram media with the Page, the account and the media id; a button only once proven", () => {
    const body = buildCreativeShape(input("video_views", "ig_media", "existing_post")).body;
    expect(body).toMatchObject({ object_id: "PAGE_1", instagram_user_id: "IG_1", source_instagram_media_id: "IGM_7" });
    expect(body.call_to_action).toBeUndefined();
    expect(creativeShapeProblems(input("website_visits", "ig_media", "existing_post"))).toEqual(["goal_source"]);
    const proven = buildCreativeShape(input("website_visits", "ig_media", "existing_post", false, { ctaOnBoost: true })).body;
    expect(proven).toMatchObject({ object_id: "PAGE_1", instagram_user_id: "IG_1", source_instagram_media_id: "IGM_7" });
    expect(proven.call_to_action).toEqual({ type: "LEARN_MORE", value: { link: "https://shop.example.in/offer" } });
    expect(proven.url_tags).toBe(DEFAULT_URL_TAGS);
    expect(buildCreativeShape(input("engagement", "ig_media", "existing_post", false, { ctaOnBoost: true })).body.call_to_action).toBeUndefined();
    expect(creativeShapeProblems(input("engagement", "ig_media", "existing_post", false, { instagramUserId: null }))).toContain("missing_instagram_account");
  });

  it("refuses a post for a lead, website or chat goal until the boost button is proven, whatever the caller sends", () => {
    for (const goal of BOOST_NEEDS_BUTTON) {
      for (const source of ["fb_post", "ig_media"] as const) {
        if (!goalRow(goal).sources.includes(source)) continue;
        // The catalog doesn't offer it, and the shape layer refuses it, even with the form and the link given.
        expect(sourcesFor(goal), `${goal} ${source}`).not.toContain(source);
        expect(formatsFor(goal, source), `${goal} ${source}`).toEqual([]);
        expect(creativeShapeProblems(input(goal, source, "existing_post")), `${goal} ${source}`).toContain("goal_source");
        expect(() => buildCreativeShape(input(goal, source, "existing_post")), `${goal} ${source}`).toThrow(/goal_source/);
        expect(creativeShapeProblems(input(goal, source, "existing_post", false, { ctaOnBoost: true })), `${goal} ${source}`).toEqual([]);
      }
    }
    // Goals with no button value still boost a post by default.
    for (const goal of ["engagement", "video_views", "awareness"] as const) {
      for (const source of ["fb_post", "ig_media"] as const) expect(creativeShapeProblems(input(goal, source, "existing_post")), `${goal} ${source}`).toEqual([]);
    }
    expect(creativeShapeProblems(input("profile_visits", "ig_media", "existing_post"))).toEqual([]);
  });

  it("puts the lead form on a boosted post once proven, and always asks for the form (PRM-02 review)", () => {
    // The reviewer's case: lead_form + fb_post + a form + ctaOnBoost true built a body with no form.
    const fb = buildCreativeShape(input("lead_form", "fb_post", "existing_post", false, { promotableId: "99", leadFormId: "99", ctaOnBoost: true })).body;
    expect(fb.object_story_id).toBe("PAGE_1_99");
    expect(fb.call_to_action).toEqual({ type: "SIGN_UP", value: { link: LEAD_FORM_LINK, lead_gen_form_id: "99" } });
    expect(fb.url_tags).toBeUndefined();
    const ig = buildCreativeShape(input("lead_form", "ig_media", "existing_post", false, { ctaOnBoost: true, ctaType: "BOOK_NOW" })).body;
    expect(ig.call_to_action).toEqual({ type: "BOOK_NOW", value: { link: LEAD_FORM_LINK, lead_gen_form_id: "FORM_5" } });
    // The form is needed whatever the source, proven or not.
    for (const source of ["new", "fb_post", "ig_media"] as const) {
      const format = source === "new" ? "single_image" : "existing_post";
      expect(creativeShapeProblems(input("lead_form", source, format, false, { leadFormId: null })), source).toContain("missing_form");
      expect(creativeShapeProblems(input("lead_form", source, format, false, { leadFormId: null, ctaOnBoost: true })), source).toContain("missing_form");
    }
    expect(creativeShapeProblems(input("lead_form", "fb_post", "existing_post", false, { leadFormId: "99" }))).toEqual(["goal_source"]);
  });

  it("puts the member's link on a boosted post for website goals once proven, and always asks for it", () => {
    const fb = buildCreativeShape(input("website_visits", "fb_post", "existing_post", false, { ctaOnBoost: true, ctaType: "SHOP_NOW" })).body;
    expect(fb.call_to_action).toEqual({ type: "SHOP_NOW", value: { link: "https://shop.example.in/offer" } });
    expect(fb.url_tags).toBe(DEFAULT_URL_TAGS);
    expect(fb.asset_feed_spec).toBeUndefined();
    for (const source of ["fb_post", "ig_media"] as const) {
      expect(creativeShapeProblems(input("website_visits", source, "existing_post", false, { ctaOnBoost: true, link: null })), source).toEqual(["missing_link"]);
      expect(creativeShapeProblems(input("website_visits", source, "existing_post", false, { link: null })), source).toEqual(["goal_source", "missing_link"]);
      expect(creativeShapeProblems(input("website_visits", source, "existing_post", false, { ctaOnBoost: true, link: "http://shop.example.in" })), source).toContain("link_https");
    }
    // A chat goal on a Facebook post keeps DOF messaging, with no website link.
    const messenger = buildCreativeShape(input("messenger_chats", "fb_post", "existing_post", false, { ctaOnBoost: true })).body;
    expect(messenger.asset_feed_spec).toEqual({ optimization_type: "DOF_MESSAGING_DESTINATION", call_to_actions: [{ type: "MESSAGE_PAGE", value: { app_destination: "MESSENGER" } }] });
    expect(JSON.stringify(messenger)).not.toContain("shop.example.in");
  });

  it("follows the runbook's verify state when the caller says nothing (V-P3)", () => {
    const proven = (id: string) => (id === "boost_cta.lead_form" ? ("sandbox" as const) : ("docs" as const));
    expect(sourcesFor("lead_form", { verified: proven })).toEqual(["new", "fb_post", "ig_media"]);
    expect(sourcesFor("lead_form")).toEqual(["new"]);
    expect(sourcesFor("website_visits", { verified: proven })).toEqual(["new"]);
    expect(sourcesFor("engagement")).toEqual(["new", "fb_post", "ig_media"]);
    expect(formatsFor("lead_form", "fb_post", { verified: proven })).toEqual(["existing_post"]);
    // An explicit false wins over a proven state.
    expect(sourcesFor("lead_form", { verified: proven, ctaOnBoost: false })).toEqual(["new"]);
  });

  it("builds Click-to-WhatsApp with the WhatsApp link, button and VISUAL_EDITOR v2 welcome with quick questions", () => {
    const body = buildCreativeShape(input("whatsapp_chats", "new", "single_image")).body as { object_story_spec: { link_data: Record<string, unknown> } };
    const data = body.object_story_spec.link_data;
    expect(data.link).toBe(WHATSAPP_LINK);
    expect(data.call_to_action).toEqual({ type: "WHATSAPP_MESSAGE", value: { app_destination: "WHATSAPP" } });
    const welcome = JSON.parse(data.page_welcome_message as string);
    expect(welcome).toMatchObject({ type: "VISUAL_EDITOR", version: 2, landing_screen_type: "welcome_message" });
    expect(welcome.text_format.message.ice_breakers).toEqual([{ title: "Price?", response: "Haircuts start at ₹499." }]);
    expect(JSON.parse(welcomeMessageJson("Hi")).text_format.message.ice_breakers).toBeUndefined();
  });

  it("never sends the member's website link on chat or profile goals, so the button opens the chat or profile", () => {
    for (const goal of ["instagram_dms", "messenger_chats", "profile_visits", "any_chat"] as const) {
      for (const [k, i] of MATRIX.filter(([key]) => key.startsWith(`${goal}|new|`))) {
        expect(JSON.stringify(buildCreativeShape(i).body), k).not.toContain("shop.example.in");
      }
    }
    const dm = buildCreativeShape(input("instagram_dms", "new", "single_image")).body as { object_story_spec: { link_data: Record<string, unknown> } };
    expect(dm.object_story_spec.link_data.link).toBeUndefined();
    expect(dm.object_story_spec.link_data.call_to_action).toEqual({ type: "INSTAGRAM_MESSAGE", value: { app_destination: "INSTAGRAM_DIRECT" } });
    // Website goals keep it, and so does engagement when the member gives one.
    expect(JSON.stringify(buildCreativeShape(input("website_visits", "new", "single_image")).body)).toContain("shop.example.in/offer");
    const photo = buildCreativeShape(input("engagement", "new", "single_image", false, { link: null })).body as { object_story_spec: Record<string, unknown> };
    expect(photo.object_story_spec.photo_data).toEqual({ image_hash: "H_FEED", caption: "Diwali offer: 20% off all services" });
  });

  it("refuses more than 3 quick questions, a title over 80 characters or a reply over 300", () => {
    const q = { title: "Price?", response: "₹499" };
    expect(creativeShapeProblems(input("whatsapp_chats", "new", "single_image", false, { welcome: { message: "Hi", iceBreakers: [q, q, q] } }))).toEqual([]);
    expect(creativeShapeProblems(input("whatsapp_chats", "new", "single_image", false, { welcome: { message: "Hi", iceBreakers: [q, q, q, q] } }))).toContain("ice_breakers");
    expect(creativeShapeProblems(input("whatsapp_chats", "new", "single_image", false, { welcome: { message: "Hi", iceBreakers: [{ title: "x".repeat(81), response: "y" }] } }))).toContain("ice_breakers");
    expect(creativeShapeProblems(input("whatsapp_chats", "new", "single_image", false, { welcome: { message: "Hi", iceBreakers: [{ title: "x", response: "y".repeat(301) }] } }))).toContain("ice_breakers");
    expect(() => buildCreativeShape(input("whatsapp_chats", "new", "single_image", false, { welcome: { message: "Hi", iceBreakers: [q, q, q, q] } }))).toThrow(/ice_breakers/);
  });

  it("uses one lead form for every card of a carousel lead ad", () => {
    const body = buildCreativeShape(input("lead_form", "new", "carousel")).body as { object_story_spec: { link_data: { child_attachments: { call_to_action: { value: Record<string, string> }; link: string }[]; link: string; multi_share_end_card: boolean; multi_share_optimized: boolean } } };
    const data = body.object_story_spec.link_data;
    expect(data.child_attachments).toHaveLength(3);
    for (const c of data.child_attachments) {
      expect(c.call_to_action.value.lead_gen_form_id).toBe("FORM_5");
      expect(c.link).toBe(LEAD_FORM_LINK);
    }
    expect(data.link).toBe(LEAD_FORM_LINK);
    expect(data.multi_share_end_card).toBe(false);
    expect(data.multi_share_optimized).toBe(false);
    expect(creativeShapeProblems(input("lead_form", "new", "carousel", false, { cards: [{ imageHash: "a", headline: "x" }] }))).toContain("carousel_cards");
    expect(creativeShapeProblems(input("lead_form", "new", "single_image", false, { leadFormId: null }))).toContain("missing_form");
  });

  it("filters the per-placement rules to the chosen positions; explore_home takes single images only", () => {
    const auto = buildCreativeShape(input("website_visits", "new", "single_image", true)).body as { asset_feed_spec: Record<string, unknown> };
    expect(auto.asset_feed_spec).toMatchObject({ optimization_type: "PLACEMENT", ad_formats: ["SINGLE_IMAGE"], images: [{ hash: "H_FEED", adlabels: [{ name: "feed" }] }, { hash: "H_TALL", adlabels: [{ name: "vertical" }] }] });
    expect(auto.asset_feed_spec.asset_customization_rules).toEqual([
      { customization_spec: { publisher_platforms: ["facebook", "instagram"], facebook_positions: ["feed", "marketplace", "profile_feed"], instagram_positions: ["stream", "profile_feed", "explore_home"] }, image_label: { name: "feed" }, priority: 1 },
      { customization_spec: { publisher_platforms: ["facebook", "instagram"], facebook_positions: ["story", "facebook_reels"], instagram_positions: ["story", "reels"] }, image_label: { name: "vertical" }, priority: 2 },
    ]);
    const igOnly = buildCreativeShape(input("website_visits", "new", "single_image", true, { positions: ["instagram_feed", "instagram_stories"] })).body as { asset_feed_spec: { asset_customization_rules: unknown[] } };
    expect(igOnly.asset_feed_spec.asset_customization_rules).toEqual([
      { customization_spec: { publisher_platforms: ["instagram"], instagram_positions: ["stream"] }, image_label: { name: "feed" }, priority: 1 },
      { customization_spec: { publisher_platforms: ["instagram"], instagram_positions: ["story"] }, image_label: { name: "vertical" }, priority: 2 },
    ]);
    const feedsOnly = buildCreativeShape(input("website_visits", "new", "single_image", true, { positions: ["facebook_feed"] })).body as { asset_feed_spec: { asset_customization_rules: unknown[] } };
    expect(feedsOnly.asset_feed_spec.asset_customization_rules).toHaveLength(1);
    const videoRules = (buildCreativeShape(input("website_visits", "new", "single_video", true, { positions: ["instagram_feed", "instagram_explore_home", "instagram_reels"] })).body as {
      asset_feed_spec: { asset_customization_rules: { customization_spec: { instagram_positions: string[] }; video_label: unknown }[]; videos: unknown[] };
    }).asset_feed_spec;
    expect(videoRules.asset_customization_rules[0].customization_spec.instagram_positions).toEqual(["stream"]);
    expect(videoRules.asset_customization_rules[0].video_label).toEqual({ name: "feed" });
    expect(videoRules.videos).toEqual([
      { video_id: "V_FEED", adlabels: [{ name: "feed" }], thumbnail_hash: "H_THUMB" },
      { video_id: "V_TALL", adlabels: [{ name: "vertical" }], thumbnail_hash: "H_THUMB_TALL" },
    ]);
  });

  it("adds url_tags for website goals only, and keeps the member's URL parameters", () => {
    expect(buildCreativeShape(input("website_visits", "new", "single_image")).body.url_tags).toBe(DEFAULT_URL_TAGS);
    expect(buildCreativeShape(input("website_sales", "new", "carousel")).body.url_tags).toBe(DEFAULT_URL_TAGS);
    expect(buildCreativeShape(input("website_visits", "new", "single_image", false, { urlTags: "utm_source=diwali" })).body.url_tags).toBe("utm_source=diwali");
    expect(buildCreativeShape(input("whatsapp_chats", "new", "single_image")).body.url_tags).toBeUndefined();
    expect(buildCreativeShape(input("lead_form", "new", "single_video")).body.url_tags).toBeUndefined();
    expect(DEFAULT_URL_TAGS).toBe("utm_source=edwyz&utm_medium=paid_social&utm_campaign={{campaign.id}}&utm_content={{ad.id}}");
  });

  it("refuses incomplete inputs with their codes", () => {
    expect(creativeShapeProblems(input("website_visits", "new", "single_image", false, { link: null }))).toContain("missing_link");
    expect(creativeShapeProblems(input("website_visits", "new", "single_image", false, { link: "http://plain.example.in" }))).toContain("link_https");
    expect(creativeShapeProblems(input("website_visits", "new", "single_video", false, { media: { videoId: "V" } }))).toContain("missing_thumbnail");
    expect(creativeShapeProblems(input("video_views", "new", "single_image"))).toContain("goal_format");
    expect(creativeShapeProblems(input("website_sales", "fb_post", "existing_post"))).toContain("goal_source");
    expect(creativeShapeProblems(input("engagement", "fb_post", "existing_post", false, { promotableId: null }))).toContain("missing_post");
    expect(creativeShapeProblems(input("engagement", "new", "single_image", false, { pageId: "" }))).toContain("missing_page");
  });
});

describe("grep bans over src (4.3)", () => {
  const files = walk(path.join(ROOT, "src"));

  it("no source file sends the banned creative keys or poll specs", () => {
    expect(files.length).toBeGreaterThan(200);
    const offenders: string[] = [];
    for (const f of files) {
      const code = stripComments(readFileSync(f, "utf8"));
      if (BANNED_KEYS.some((b) => code.includes(b)) || /["']?\bpolls?(_[a-z_]+)?["']?\s*:/.test(code)) offenders.push(path.relative(ROOT, f));
    }
    expect(offenders).toEqual([]);
  });

  it("the shape library names no budget or end-time field and no status (rules B10, P0-1)", () => {
    const code = stripComments(readFileSync(path.join(ROOT, "src/lib/promote/creative-shapes.ts"), "utf8"));
    expect(B10.test(code)).toBe(false);
    expect(/["']status["']\s*:|\bstatus\s*:/.test(code)).toBe(false);
    expect(code.includes("adsClient(")).toBe(false);
  });
});
