import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The pure core's capability catalog (docs/IG-PAGE-ADS-SPEC.md 4.4 to 4.7, D15, D16, D22; PRM-02 acceptance 1, 2):
 * the 12 goals with complete Meta pairings, the forbidden pairings, the parity ledger, the D22 visibility filter, the
 * generated verified.ts, and the purity of the whole pure core (no prisma, fetch, graph or next import).
 */
import { PROMOTE_GOAL_KEYS } from "@/lib/promote/flags";
import {
  AUDIENCE_EVENTS,
  availableGoals,
  BASE_PREREQUISITES,
  BOOST_NEEDS_BUTTON,
  boostCtaProven,
  BREAKDOWN_DIMENSIONS,
  BREAKDOWNS,
  catalogSpecs,
  CTA_BY_GOAL,
  DEFAULT_PREVIEW_TABS,
  FORBIDDEN_PAIRINGS,
  FORM_PRESETS,
  formatsFor,
  formSpecProblems,
  goalOfLegacyTemplate,
  GOALS,
  goalRow,
  LEAD_FORM_LINK,
  LEAD_QUESTIONS,
  LOOKALIKE,
  MAX_FORM_QUESTIONS,
  NOT_BUILT,
  optimizationFor,
  pairingAllowed,
  placementName,
  PLACEMENTS,
  PREVIEW_AD_FORMATS,
  resultActionFor,
  retentionBounds,
  retentionSeconds,
  rowVisible,
  sourcesFor,
  templateFor,
  VERIFIED,
  VERIFIED_RUNBOOK_STEPS,
  verifyStateOf,
  WHATSAPP_LINK,
} from "@/lib/promote/catalog";
import { isPromoteCopyKey } from "@/lib/promote/copy";
import { CREATIVE_SHAPES } from "@/lib/promote/creative-shapes";
import { PLACEMENT_KEYS, READINESS_CHECKS, TIERS, VERIFY_STATES } from "@/lib/promote/types";

const ROOT = path.resolve(__dirname, "..");
const PROMOTE = path.join(ROOT, "src/lib/promote");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** The pure core of PRM-02: catalog, creative shapes, cost, dates, review reasons, draft paths, copy (and the shared types). */
const PURE = [
  ...walk(path.join(PROMOTE, "catalog")),
  ...walk(path.join(PROMOTE, "copy")),
  ...["creative-shapes.ts", "cost.ts", "dates.ts", "review-reasons.ts", "draft-paths.ts", "types.ts"].map((f) => path.join(PROMOTE, f)),
];
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");

/** Every import or export-from specifier, and dynamic imports. */
function specifiers(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)) out.push(m[1]);
  for (const m of code.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) out.push(m[1]);
  for (const m of code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  for (const m of code.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  return out;
}

const BANNED_IMPORT = /^(@\/lib\/db|@\/generated\/prisma|@prisma\/|prisma$|@\/lib\/graph|next$|next\/|@\/lib\/spend\/fx$|@\/lib\/auth|@\/lib\/tenancy$)/;

describe("the pure core imports nothing impure (PRM-02 acceptance 1)", () => {
  it("scans every file of the package", () => {
    expect(PURE.length).toBeGreaterThanOrEqual(20);
    expect(PURE.map(rel)).toEqual(expect.arrayContaining(["src/lib/promote/catalog/goals.ts", "src/lib/promote/copy/en.ts", "src/lib/promote/cost.ts", "src/lib/promote/draft-paths.ts"]));
  });

  it.each(PURE.map((f) => [rel(f), f] as const))("%s has no prisma, fetch, graph or next import", (_name, file) => {
    const code = readFileSync(file, "utf8");
    const bad = specifiers(code).filter((s) => BANNED_IMPORT.test(s));
    expect(bad).toEqual([]);
    expect(/\bfetch\s*\(/.test(code)).toBe(false);
    expect(/\bprisma\./.test(code)).toBe(false);
  });

  it("names no Meta screen host (8.4: Opens Meta URLs live only in meta-screens.ts)", () => {
    for (const f of PURE) expect(/facebook\.com/i.test(readFileSync(f, "utf8")), rel(f)).toBe(false);
  });
});

describe("goals (4.4)", () => {
  const OBJECTIVES = ["OUTCOME_ENGAGEMENT", "OUTCOME_LEADS", "OUTCOME_TRAFFIC", "OUTCOME_SALES", "OUTCOME_AWARENESS"];

  it("has the 12 goals in catalog order, the same keys as the flags", () => {
    expect(GOALS.map((g) => g.key)).toEqual([...PROMOTE_GOAL_KEYS]);
    expect(GOALS).toHaveLength(12);
  });

  it.each(GOALS.map((g) => [g.key, g] as const))("%s has a complete Meta pairing, doc reference, tier and verify state", (_k, g) => {
    expect(OBJECTIVES).toContain(g.objective);
    expect(g.optimizationGoal).toMatch(/^[A-Z_]+$/);
    if (g.destinationType !== null) expect(g.destinationType).toMatch(/^[A-Z_]+$/);
    expect(Array.isArray(g.promotedObject)).toBe(true);
    expect(g.docUrl).toMatch(/^\/docs\/[a-z0-9/-]+$/);
    expect(TIERS).toContain(g.tier);
    expect(VERIFY_STATES).toContain(g.verify);
    expect(g.verify).toBe(verifyStateOf(`goal.${g.key}`));
    expect(g.verifyRefs.length).toBeGreaterThan(0);
    expect(g.tripwireClass).toBe("ads_create");
    for (const check of BASE_PREREQUISITES) expect(g.prerequisites).toContain(check);
    for (const check of g.prerequisites) expect(READINESS_CHECKS).toContain(check);
    expect(g.sources.length).toBeGreaterThan(0);
    expect(g.formats.length).toBeGreaterThan(0);
    expect(g.template.new).toMatch(/^[a-z_]+$/);
    for (const key of [g.copy.title, g.copy.chip, g.copy.outcome, ...(g.copy.note ? [g.copy.note] : [])]) expect(isPromoteCopyKey(key), key).toBe(true);
    expect(CTA_BY_GOAL[g.key].goal).toBe(g.key);
  });

  it("matches the 4.4 table row by row", () => {
    const pairing = Object.fromEntries(GOALS.map((g) => [g.key, [g.objective, g.optimizationGoal, g.destinationType, [...g.promotedObject], g.template.new, g.tier]]));
    expect(pairing).toEqual({
      whatsapp_chats: ["OUTCOME_ENGAGEMENT", "CONVERSATIONS", "WHATSAPP", ["page_id", "whatsapp_phone_number"], "click_to_whatsapp", "simple"],
      lead_form: ["OUTCOME_LEADS", "LEAD_GENERATION", "ON_AD", ["page_id"], "lead_generation", "simple"],
      website_visits: ["OUTCOME_TRAFFIC", "LINK_CLICKS", "WEBSITE", [], "traffic", "simple"],
      instagram_dms: ["OUTCOME_ENGAGEMENT", "CONVERSATIONS", "INSTAGRAM_DIRECT", ["page_id"], "click_to_instagram", "more"],
      messenger_chats: ["OUTCOME_ENGAGEMENT", "CONVERSATIONS", "MESSENGER", ["page_id"], "click_to_messenger", "more"],
      website_sales: ["OUTCOME_SALES", "OFFSITE_CONVERSIONS", "WEBSITE", ["pixel_id", "custom_event_type"], "website_sales", "more"],
      profile_visits: ["OUTCOME_TRAFFIC", "VISIT_INSTAGRAM_PROFILE", "INSTAGRAM_PROFILE", ["page_id"], "profile_visits", "more"],
      engagement: ["OUTCOME_ENGAGEMENT", "POST_ENGAGEMENT", "ON_POST", ["page_id"], "engagement", "more"],
      video_views: ["OUTCOME_ENGAGEMENT", "THRUPLAY", "ON_VIDEO", ["page_id"], "video_views", "more"],
      awareness: ["OUTCOME_AWARENESS", "REACH", null, ["page_id"], "awareness", "more"],
      page_likes: ["OUTCOME_ENGAGEMENT", "PAGE_LIKES", "ON_PAGE", ["page_id"], "page_likes", "all"],
      any_chat: ["OUTCOME_ENGAGEMENT", "CONVERSATIONS", "MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP", ["page_id"], "multi_destination", "all"],
    });
    expect(goalRow("website_sales").promotedObjectFixed).toEqual({ custom_event_type: "PURCHASE" });
    expect(goalRow("lead_form").optimizationLater).toEqual(["QUALITY_LEAD"]);
    expect(goalRow("any_chat").promotedObjectOptional).toEqual(["whatsapp_phone_number"]);
  });

  it("website visits optimise for landing page views only when a pixel fired in the last 7 days", () => {
    expect(optimizationFor("website_visits", { pixelFiredRecently: true })).toBe("LANDING_PAGE_VIEWS");
    expect(optimizationFor("website_visits", { pixelFiredRecently: false })).toBe("LINK_CLICKS");
    expect(optimizationFor("website_visits")).toBe("LINK_CLICKS");
    expect(resultActionFor("website_visits", { pixelFiredRecently: true })).toBe("landing_page_view");
    expect(resultActionFor("website_visits")).toBe("link_click");
    expect(optimizationFor("whatsapp_chats", { pixelFiredRecently: true })).toBe("CONVERSATIONS");
  });

  it("counts results per goal (4.4)", () => {
    const chat = "onsite_conversion.messaging_conversation_started_7d";
    expect(resultActionFor("whatsapp_chats")).toBe(chat);
    expect(resultActionFor("instagram_dms")).toBe(chat);
    expect(resultActionFor("messenger_chats")).toBe(chat);
    expect(resultActionFor("lead_form")).toBe("lead");
    expect(resultActionFor("website_sales")).toBe("offsite_conversion.fb_pixel_purchase");
    expect(resultActionFor("engagement")).toBe("post_engagement");
    expect(resultActionFor("video_views")).toBe("video_thruplay_watched_actions");
    expect(resultActionFor("awareness")).toBe("reach");
    expect(resultActionFor("page_likes")).toBe("like");
    expect(resultActionFor("profile_visits")).toBeNull();
  });

  it("never offers Click-to-WhatsApp under OUTCOME_LEADS, nor Click-to-Instagram under OUTCOME_LEADS", () => {
    for (const g of GOALS) {
      if (g.objective === "OUTCOME_LEADS") {
        expect(g.destinationType).not.toBe("WHATSAPP");
        expect(g.destinationType).not.toBe("INSTAGRAM_DIRECT");
      }
    }
    expect(goalRow("whatsapp_chats").objective).toBe("OUTCOME_ENGAGEMENT");
    expect(goalRow("whatsapp_chats").optimizationGoal).toBe("CONVERSATIONS");
    expect(goalRow("instagram_dms").objective).not.toBe("OUTCOME_LEADS");
    expect(pairingAllowed("OUTCOME_LEADS", "WHATSAPP")).toBe(false);
    expect(pairingAllowed("OUTCOME_LEADS", "INSTAGRAM_DIRECT")).toBe(false);
    expect(pairingAllowed("OUTCOME_ENGAGEMENT", "WHATSAPP")).toBe(true);
    expect(pairingAllowed("OUTCOME_ENGAGEMENT", "INSTAGRAM_DIRECT")).toBe(true);
    expect(pairingAllowed("OUTCOME_LEADS", "ON_AD")).toBe(true);
    expect(FORBIDDEN_PAIRINGS).toHaveLength(2);
  });

  it("chats on any app never allow a special ad category; every other goal may carry one", () => {
    for (const g of GOALS) expect(g.specialCategoriesAllowed, g.key).toBe(g.key !== "any_chat");
  });

  it("Instagram DMs and Messenger chats say replies happen outside Edwyz (D15)", () => {
    expect(goalRow("instagram_dms").repliesOutsideEdwyz).toBe(true);
    expect(goalRow("instagram_dms").copy.note).toBe("goal.ig_dm.note");
    expect(goalRow("messenger_chats").repliesOutsideEdwyz).toBe(true);
    expect(goalRow("messenger_chats").copy.note).toBe("goal.messenger.note");
    expect(goalRow("whatsapp_chats").repliesOutsideEdwyz).toBe(false);
    expect(goalRow("lead_form").repliesOutsideEdwyz).toBe(false);
    expect(goalRow("instagram_dms").platforms).toEqual(["instagram"]);
  });

  it("maps sources and formats, and the legacy templates", () => {
    expect(formatsFor("whatsapp_chats", "new")).toEqual(["single_image", "single_video", "carousel"]);
    // A post for a goal whose button carries a value only once the boost button is proven (V-P3).
    expect(formatsFor("whatsapp_chats", "ig_media")).toEqual([]);
    expect(formatsFor("whatsapp_chats", "ig_media", { ctaOnBoost: true })).toEqual(["existing_post"]);
    expect(formatsFor("engagement", "ig_media")).toEqual(["existing_post"]);
    expect(formatsFor("video_views", "new")).toEqual(["single_video"]);
    expect(formatsFor("website_sales", "fb_post")).toEqual([]);
    expect(formatsFor("website_sales", "fb_post", { ctaOnBoost: true })).toEqual([]);
    expect([...BOOST_NEEDS_BUTTON].sort()).toEqual(["any_chat", "instagram_dms", "lead_form", "messenger_chats", "website_sales", "website_visits", "whatsapp_chats"]);
    for (const g of GOALS) {
      expect(sourcesFor(g.key), g.key).toEqual(BOOST_NEEDS_BUTTON.has(g.key) ? ["new"] : [...g.sources]);
      expect(sourcesFor(g.key, { ctaOnBoost: true }), g.key).toEqual([...g.sources]);
      expect(boostCtaProven(g.key), g.key).toBe(false);
    }
    expect(templateFor("engagement", "fb_post")).toBe("boost_post");
    expect(templateFor("engagement", "new")).toBe("engagement");
    expect(goalOfLegacyTemplate("boost_post")).toEqual({ goal: "engagement", source: "fb_post" });
    expect(goalOfLegacyTemplate("click_to_whatsapp")).toEqual({ goal: "whatsapp_chats", source: "new" });
    expect(goalOfLegacyTemplate("nope")).toBeNull();
    expect(goalRow("whatsapp_chats").needsWhatsApp).toBe(true);
    expect(goalRow("website_sales").prerequisites).toContain("pixel");
    expect(goalRow("lead_form").prerequisites).toEqual(expect.arrayContaining(["leadgen_tos", "privacy_link", "lead_access"]));
  });
});

describe("calls to action (4.3)", () => {
  it("covers every goal with the 4.3 values", () => {
    expect(Object.keys(CTA_BY_GOAL).sort()).toEqual([...PROMOTE_GOAL_KEYS].sort());
    expect(CTA_BY_GOAL.whatsapp_chats).toMatchObject({ types: ["WHATSAPP_MESSAGE"], value: { app_destination: "WHATSAPP" }, fixedLink: WHATSAPP_LINK, welcomeMessage: true });
    expect(CTA_BY_GOAL.instagram_dms).toMatchObject({ types: ["INSTAGRAM_MESSAGE", "MESSAGE_PAGE"], value: { app_destination: "INSTAGRAM_DIRECT" } });
    expect(CTA_BY_GOAL.messenger_chats).toMatchObject({ types: ["MESSAGE_PAGE"], value: { app_destination: "MESSENGER" } });
    expect(CTA_BY_GOAL.lead_form).toMatchObject({ types: ["SIGN_UP", "GET_QUOTE", "BOOK_NOW", "APPLY_NOW"], valueFrom: "lead_form", fixedLink: LEAD_FORM_LINK });
    expect(CTA_BY_GOAL.website_visits).toMatchObject({ types: ["LEARN_MORE", "SHOP_NOW", "BOOK_NOW"], valueFrom: "link", urlTags: true });
    expect(CTA_BY_GOAL.website_sales.urlTags).toBe(true);
    for (const c of Object.values(CTA_BY_GOAL)) for (const t of c.types) expect(isPromoteCopyKey(`cta.${t}`), t).toBe(true);
  });
});

describe("preview formats, lead questions, audience events, breakdowns", () => {
  it("has a preview format (or local) for every placement", () => {
    expect(Object.keys(PREVIEW_AD_FORMATS).sort()).toEqual([...PLACEMENT_KEYS].sort());
    expect(PREVIEW_AD_FORMATS.instagram_reels).toBe("INSTAGRAM_REELS");
    expect(PREVIEW_AD_FORMATS.facebook_stories).toBe("FACEBOOK_STORY_MOBILE");
    expect(PREVIEW_AD_FORMATS.instagram_search).toBe("local");
    expect(PREVIEW_AD_FORMATS.messenger_inbox).toBeNull();
    expect(DEFAULT_PREVIEW_TABS).toEqual(["instagram_feed", "instagram_stories", "instagram_reels", "facebook_feed", "facebook_stories", "facebook_reels"]);
  });

  it("has the lead question types, WhatsApp number as VERIFY, at most 15 questions and an optional consent box", () => {
    const wa = LEAD_QUESTIONS.find((q) => q.type === "WHATSAPP_NUMBER")!;
    expect(wa.verifyRefs).toContain("V-P7");
    expect(wa.verify).toBe("docs");
    expect(MAX_FORM_QUESTIONS).toBe(15);
    for (const q of LEAD_QUESTIONS) expect(isPromoteCopyKey(q.labelKey), q.type).toBe(true);
    for (const keys of Object.values(FORM_PRESETS)) for (const k of keys) expect(isPromoteCopyKey(k)).toBe(true);
    const ok = { questions: [{ type: "FULL_NAME" }, { type: "PHONE" }], privacyUrl: "https://example.in/privacy", formType: "more_volume" as const };
    expect(formSpecProblems(ok)).toEqual([]);
    expect(formSpecProblems({ ...ok, questions: Array.from({ length: 16 }, () => ({ type: "PHONE" })) })).toContain("too_many_questions");
    expect(formSpecProblems({ ...ok, questions: [{ type: "PHONE" }, { type: "CUSTOM" }, { type: "CUSTOM" }, { type: "CUSTOM" }, { type: "CUSTOM" }] })).toContain("too_many_custom");
    expect(formSpecProblems({ ...ok, questions: [{ type: "FULL_NAME" }] })).toContain("needs_contact");
    expect(formSpecProblems({ ...ok, privacyUrl: "http://example.in/privacy" })).toContain("privacy_https");
    expect(formSpecProblems({ ...ok, checkboxes: [{ key: "whatsapp_opt_in", required: true }] })).toContain("consent_required");
    expect(formSpecProblems({ ...ok, checkboxes: [{ key: "whatsapp_opt_in", required: false, checkedByDefault: true }] })).toContain("consent_required");
    expect(formSpecProblems({ ...ok, checkboxes: [{ key: "whatsapp_opt_in", required: false, checkedByDefault: false }] })).toEqual([]);
  });

  it("has the 3.7 audience events and retention bounds", () => {
    expect(new Set(AUDIENCE_EVENTS.map((e) => e.kind))).toEqual(new Set(["engagement_instagram", "engagement_page", "engagement_lead_form", "website"]));
    expect(retentionBounds("engagement_instagram")).toEqual({ defaultDays: 365, maxDays: 730 });
    expect(retentionBounds("engagement_page")).toEqual({ defaultDays: 365, maxDays: 730 });
    expect(retentionBounds("engagement_lead_form")).toEqual({ defaultDays: 90, maxDays: 90 });
    expect(retentionBounds("website")).toEqual({ defaultDays: 30, maxDays: 180 });
    expect(retentionSeconds("website")).toBe(30 * 86_400);
    expect(retentionSeconds("engagement_page", 730)).toBe(730 * 86_400);
    expect(() => retentionSeconds("engagement_lead_form", 91)).toThrow(RangeError);
    expect(() => retentionSeconds("website", 0)).toThrow(RangeError);
    expect(LOOKALIKE).toMatchObject({ country: "IN", minPercent: 1, maxPercent: 10, minSeed: 100 });
  });

  it("has the R3 to R5 dimensions plus the run total, and names known placements", () => {
    expect([...BREAKDOWN_DIMENSIONS]).toEqual(["placement", "asset_body", "asset_title", "asset_image", "asset_video", "asset_cta", "age_gender", "region", "run_total"]);
    expect(BREAKDOWNS.find((b) => b.dimension === "placement")!.breakdowns).toEqual(["publisher_platform", "platform_position"]);
    expect(BREAKDOWNS.find((b) => b.dimension === "run_total")).toMatchObject({ call: "R3a", daily: false, breakdowns: [] });
    expect(placementName("instagram|reels")).toBe("Instagram Reels");
    expect(placementName("facebook|feed", "hi")).toBe("Facebook फ़ीड");
    expect(placementName("facebook|some_new_spot")).toBe("Facebook: some_new_spot");
    expect(placementName("instagram|mystery", "hinglish")).toBe("Instagram: mystery");
  });
});

describe("the parity ledger (4.7)", () => {
  it("lists every deliberate exclusion with its reason", () => {
    expect(NOT_BUILT.map((n) => n.key).sort()).toEqual(
      [
        "partnership_ads",
        "catalog_ads",
        "budget_schedule_edge",
        "meta_copies_edge",
        "graph_batch",
        "async_request_sets",
        "asc_aac",
        "messenger_lead_templates",
        "reach_frequency",
        "poll_creatives",
        "existing_post_asset_customization",
        "form_archive",
        "organic_insights",
      ].sort(),
    );
    for (const n of NOT_BUILT) {
      expect(n.reason.length, n.key).toBeGreaterThan(10);
      expect(n.what.length, n.key).toBeGreaterThan(3);
      expect(n.ref, n.key).toMatch(/\d/);
    }
    expect(NOT_BUILT.find((n) => n.key === "partnership_ads")!.reason).toContain("2026-12-01");
    expect(NOT_BUILT.find((n) => n.key === "organic_insights")!.ref).toContain("D24");
    expect(NOT_BUILT.find((n) => n.key === "form_archive")!.ref).toContain("D13");
  });
});

describe("verified.ts and D22", () => {
  it("lists every catalog row, and every row is at docs until a runbook step is recorded", () => {
    for (const g of GOALS) expect(VERIFIED[`goal.${g.key}`], g.key).toBeDefined();
    for (const p of PLACEMENTS) expect(VERIFIED[`placement.${p.key}`], p.key).toBeDefined();
    for (const q of LEAD_QUESTIONS) expect(VERIFIED[`question.${q.type}`], q.type).toBeDefined();
    for (const e of AUDIENCE_EVENTS) expect(VERIFIED[`audience_event.${e.id}`], e.id).toBeDefined();
    for (const s of CREATIVE_SHAPES) expect(VERIFIED[`shape.${s}`], s).toBeDefined();
    for (const v of Object.values(VERIFIED)) expect(VERIFY_STATES).toContain(v);
    if (VERIFIED_RUNBOOK_STEPS.length === 0) for (const [id, v] of Object.entries(VERIFIED)) expect(v, id).toBe("docs");
    const header = readFileSync(path.join(PROMOTE, "catalog/verified.ts"), "utf8").slice(0, 400);
    expect(header).toMatch(/GENERATED FILE/);
  });

  it("hides docs-state rows outside sandbox accounts, even with PROMOTE_EXPERIMENTAL=1", () => {
    expect(availableGoals({ sandboxAccount: false, experimental: true })).toEqual([]);
    expect(availableGoals({ sandboxAccount: false, env: { PROMOTE_EXPERIMENTAL: "1" } })).toEqual([]);
    expect(availableGoals({ sandboxAccount: true, experimental: false })).toEqual([]);
    expect(availableGoals({ sandboxAccount: true, env: {} })).toEqual([]);
    expect(rowVisible("docs", { sandboxAccount: false, experimental: true })).toBe(false);
  });

  it("shows docs-state rows with PROMOTE_EXPERIMENTAL=1 on a sandbox account, up to the member's tier", () => {
    const more = availableGoals({ sandboxAccount: true, env: { PROMOTE_EXPERIMENTAL: "1" } }).map((g) => g.key);
    expect(more).toEqual(PROMOTE_GOAL_KEYS.filter((k) => k !== "page_likes" && k !== "any_chat"));
    expect(availableGoals({ sandboxAccount: true, experimental: true, tier: "all" })).toHaveLength(12);
    expect(availableGoals({ sandboxAccount: true, experimental: true, tier: "simple" }).map((g) => g.key)).toEqual(["whatsapp_chats", "lead_form", "website_visits"]);
  });

  it("lets PROMOTE_GOALS narrow the goals further", () => {
    const env = { PROMOTE_EXPERIMENTAL: "1", PROMOTE_GOALS: "lead_form,whatsapp_chats" };
    expect(availableGoals({ sandboxAccount: true, env }).map((g) => g.key)).toEqual(["whatsapp_chats", "lead_form"]);
    expect(availableGoals({ sandboxAccount: true, experimental: true, goals: ["engagement"] }).map((g) => g.key)).toEqual(["engagement"]);
  });

  it("shows sandbox- or live-verified rows everywhere", () => {
    const verified = (id: string) => (id === "goal.lead_form" ? ("sandbox" as const) : id === "goal.whatsapp_chats" ? ("live" as const) : ("docs" as const));
    expect(availableGoals({ sandboxAccount: false, experimental: false, verified }).map((g) => g.key)).toEqual(["whatsapp_chats", "lead_form"]);
  });

  it("serves the catalog as JSON for get_creative_specs", () => {
    const specs = catalogSpecs("whatsapp_chats");
    expect(specs.goals).toHaveLength(1);
    expect(specs.goals[0].positions.map((p) => p.key)).toContain("instagram_reels");
    expect(specs.limits).toEqual({ instagramCaption: 2_200, instagramHashtags: 30, carouselCards: { min: 2, max: 10 }, formQuestions: 15 });
    expect(() => JSON.stringify(catalogSpecs())).not.toThrow();
    // It offers only the sources the shape library can build now.
    expect(specs.goals[0].sources).toEqual(["new"]);
    expect(catalogSpecs("lead_form").goals[0].sources).toEqual(["new"]);
    expect(catalogSpecs("engagement").goals[0].sources).toEqual(["new", "fb_post", "ig_media"]);
  });
});
