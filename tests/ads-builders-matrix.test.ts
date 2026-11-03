import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// The old routes' guards are checked through ads/service below; nothing here may reach a database.
vi.mock("@/lib/db", () => ({ prisma: {} }));

/**
 * The ads builders for every goal, format and placement (docs/IG-PAGE-ADS-SPEC.md 4.3, 4.4, D7, D9, D11, D30; PRM-04
 * acceptance 2 and 3), backward compatible with the old wizard: its four templates keep their exact payloads.
 */
import {
  adSetProblems,
  buildAdSet,
  buildCampaign,
  buildCreative,
  campaignProblems,
  creativeBuildProblems,
  creativeProblems,
  LIFETIME_NEEDS_END,
  OPTED_OUT_FEATURES,
  optOutSpec,
  PIXEL_NEEDED,
  SHAPE_PROBLEM_TEXT,
  SPECIAL_CATEGORY_NOT_ALLOWED,
  specialAdCategoryCountries,
  TEMPLATE_SPECS,
  usesCreativeShapes,
  type AdSetCheckInput,
  type CreativeBuildInput,
} from "@/lib/ads/builders";
import { parseDraftInput, validateCampaign } from "@/lib/ads/service";
import { AUDIENCE_NOT_READY, AUDIENCES_NOT_HERE, emptyTargeting } from "@/lib/ads/targeting";
import { isAnyTemplate, isLegacyTemplate, isTemplate, LEGACY_TEMPLATES, SPECIAL_CATEGORIES, TEMPLATES, type AdTemplate, type CreativeInput, type Targeting } from "@/lib/ads/types";
import { formatsFor, GOALS, goalRow, sourcesFor } from "@/lib/promote/catalog/goals";
import { OPTED_OUT_FEATURES as SHAPE_FEATURES, enhancementsSpec, optOutSpec as shapeOptOutSpec } from "@/lib/promote/creative-shapes";
import { endOfRunDay } from "@/lib/promote/dates";
import type { AdFormat, SourceKind } from "@/lib/promote/types";

const ROOT = path.resolve(__dirname, "..");
const CATEGORIES = ["housing", "employment", "credit", "social_issues"] as const;
const NEW_TEMPLATES = TEMPLATES.filter((t) => !isLegacyTemplate(t));
const END = new Date("2026-11-14T18:29:00Z");
const targeting = (over: Partial<Targeting> = {}): Targeting => ({ ...emptyTargeting(), geo: { countries: ["IN"], cities: [] }, ageMin: 18, ageMax: 65, ...over });

const adSetInput = (template: AdTemplate, over: Partial<AdSetCheckInput> = {}): AdSetCheckInput => ({
  name: "Version A",
  metaCampaignId: "238500001",
  template,
  targeting: targeting(),
  specialAdCategory: "none",
  dailyBudgetMinor: 30_000,
  pageId: "PAGE_1",
  whatsappDisplayPhone: "+919800000000",
  pixelId: "PIXEL_1",
  endsAt: END,
  ...over,
});

/** 4.4, written out from the spec rather than read from the catalog, so a catalog edit can't hide a change. */
const GOAL_TABLE: Record<(typeof NEW_TEMPLATES)[number], { objective: string; optimization: string; destination: string | null; promoted: Record<string, string> }> = {
  click_to_instagram: { objective: "OUTCOME_ENGAGEMENT", optimization: "CONVERSATIONS", destination: "INSTAGRAM_DIRECT", promoted: { page_id: "PAGE_1" } },
  click_to_messenger: { objective: "OUTCOME_ENGAGEMENT", optimization: "CONVERSATIONS", destination: "MESSENGER", promoted: { page_id: "PAGE_1" } },
  website_sales: { objective: "OUTCOME_SALES", optimization: "OFFSITE_CONVERSIONS", destination: "WEBSITE", promoted: { pixel_id: "PIXEL_1", custom_event_type: "PURCHASE" } },
  profile_visits: { objective: "OUTCOME_TRAFFIC", optimization: "VISIT_INSTAGRAM_PROFILE", destination: "INSTAGRAM_PROFILE", promoted: { page_id: "PAGE_1" } },
  engagement: { objective: "OUTCOME_ENGAGEMENT", optimization: "POST_ENGAGEMENT", destination: "ON_POST", promoted: { page_id: "PAGE_1" } },
  video_views: { objective: "OUTCOME_ENGAGEMENT", optimization: "THRUPLAY", destination: "ON_VIDEO", promoted: { page_id: "PAGE_1" } },
  awareness: { objective: "OUTCOME_AWARENESS", optimization: "REACH", destination: null, promoted: { page_id: "PAGE_1" } },
  page_likes: { objective: "OUTCOME_ENGAGEMENT", optimization: "PAGE_LIKES", destination: "ON_PAGE", promoted: { page_id: "PAGE_1" } },
  multi_destination: {
    objective: "OUTCOME_ENGAGEMENT",
    optimization: "CONVERSATIONS",
    destination: "MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP",
    promoted: { page_id: "PAGE_1", whatsapp_phone_number: "+919800000000" },
  },
};

describe("templates (4.4)", () => {
  it("keeps the four legacy keys first and unchanged, and adds the catalog's legacy keys", () => {
    expect(LEGACY_TEMPLATES).toEqual(["lead_generation", "click_to_whatsapp", "traffic", "boost_post"]);
    expect(TEMPLATES.slice(0, 4)).toEqual([...LEGACY_TEMPLATES]);
    expect(NEW_TEMPLATES).toEqual(["click_to_instagram", "click_to_messenger", "website_sales", "profile_visits", "engagement", "video_views", "awareness", "page_likes", "multi_destination"]);
    for (const g of GOALS) {
      expect(isAnyTemplate(g.template.new), g.key).toBe(true);
      expect(isAnyTemplate(g.template.post), g.key).toBe(true);
    }
    expect(isAnyTemplate("lead_ads")).toBe(false);
  });

  it("the old routes' guard (isTemplate) keeps only the four old keys until PRM-05 wires the new goals", () => {
    for (const t of TEMPLATES) expect(isTemplate(t), t).toBe(isLegacyTemplate(t));
    for (const t of LEGACY_TEMPLATES) expect(isTemplate(t), t).toBe(true);
    for (const v of ["awareness", "website_sales", "multi_destination", "lead_ads", "", null, 1]) expect(isTemplate(v), String(v)).toBe(false);
  });

  it("reads every template's spec from the goal catalog", () => {
    for (const t of TEMPLATES) {
      const spec = TEMPLATE_SPECS[t];
      const row = goalRow(spec.goal);
      expect([row.template.new, row.template.post], t).toContain(t);
      expect(spec).toMatchObject({ objective: row.objective, optimizationGoal: row.optimizationGoal, destinationType: row.destinationType });
    }
  });

  it("keeps the old wizard's four specs exactly", () => {
    expect(TEMPLATE_SPECS.lead_generation).toMatchObject({ objective: "OUTCOME_LEADS", optimizationGoal: "LEAD_GENERATION", destinationType: "ON_AD", needs: ["leadFormId"] });
    expect(TEMPLATE_SPECS.click_to_whatsapp).toMatchObject({ objective: "OUTCOME_ENGAGEMENT", optimizationGoal: "CONVERSATIONS", destinationType: "WHATSAPP", needs: ["whatsappNumberId"] });
    expect(TEMPLATE_SPECS.traffic).toMatchObject({ objective: "OUTCOME_TRAFFIC", optimizationGoal: "LINK_CLICKS", destinationType: "WEBSITE", needs: ["link"] });
    expect(TEMPLATE_SPECS.boost_post).toMatchObject({ objective: "OUTCOME_ENGAGEMENT", optimizationGoal: "POST_ENGAGEMENT", destinationType: "ON_POST", needs: [] });
  });
});

describe("the old routes refuse the new goals (train P1 stays dark)", () => {
  const body = (template: string) => ({
    name: "Diwali",
    template,
    adAccountAssetId: "acc1",
    dailyBudgetMinor: 50_000,
    specialAdCategory: "none",
    targeting: { geo: { countries: ["IN"], cities: [] } },
    ads: [{ name: "A", creative: { pageId: "page1", message: "Hi", link: "https://e.com", imageUrl: "https://e.com/a.png" } }],
  });

  it.each(["awareness", "website_sales", "multi_destination", "click_to_instagram"])("parseDraftInput (POST and PATCH /api/ads/campaigns) refuses %s", (template) => {
    expect(() => parseDraftInput(body(template))).toThrow(/template must be lead_generation, click_to_whatsapp, traffic or boost_post/);
  });

  it("parseDraftInput still takes the four old keys", () => {
    for (const t of LEGACY_TEMPLATES) expect(parseDraftInput(body(t)).template).toBe(t);
  });

  it.each(["awareness", "website_sales", "multi_destination", "nonsense"])("validateCampaign (preview and launch) refuses a stored %s row before any Meta call", async (template) => {
    expect(await validateCampaign({ template, specialAdCategory: "none", adSets: [] } as never)).toEqual(["Unknown template."]);
  });
});

describe("each new goal's campaign and ad set (4.3, 4.4)", () => {
  it.each(NEW_TEMPLATES)("%s has the 4.4 objective, optimization, destination and promoted_object", (template) => {
    const want = GOAL_TABLE[template];
    const campaign = buildCampaign({ name: "C", template, specialAdCategory: "none" });
    expect(campaign).toMatchObject({ objective: want.objective, status: "PAUSED", is_adset_budget_sharing_enabled: false, special_ad_categories: [] });
    const adSet = buildAdSet(adSetInput(template));
    expect(adSet.optimization_goal).toBe(want.optimization);
    if (want.destination) expect(adSet.destination_type).toBe(want.destination);
    else expect(adSet).not.toHaveProperty("destination_type");
    expect(adSet.promoted_object).toStrictEqual(want.promoted);
    expect(adSet).toMatchObject({ status: "PAUSED", billing_event: "IMPRESSIONS", bid_strategy: "LOWEST_COST_WITHOUT_CAP", daily_budget: 30_000 });
  });

  it("the legacy goals keep their promoted objects (WhatsApp sends the number, traffic the Page)", () => {
    expect(buildAdSet(adSetInput("click_to_whatsapp")).promoted_object).toStrictEqual({ page_id: "PAGE_1", whatsapp_phone_number: "+919800000000" });
    expect(buildAdSet(adSetInput("click_to_whatsapp", { whatsappDisplayPhone: undefined })).promoted_object).toStrictEqual({ page_id: "PAGE_1" });
    expect(buildAdSet(adSetInput("lead_generation")).promoted_object).toStrictEqual({ page_id: "PAGE_1" });
    expect(buildAdSet(adSetInput("traffic")).promoted_object).toStrictEqual({ page_id: "PAGE_1" });
    expect(buildAdSet(adSetInput("boost_post")).promoted_object).toStrictEqual({ page_id: "PAGE_1" });
  });

  it("website visits optimise for landing page views only when a pixel fired in the last 7 days", () => {
    expect(buildAdSet(adSetInput("traffic")).optimization_goal).toBe("LINK_CLICKS");
    expect(buildAdSet(adSetInput("traffic", { pixelFiredRecently: false })).optimization_goal).toBe("LINK_CLICKS");
    expect(buildAdSet(adSetInput("traffic", { pixelFiredRecently: true })).optimization_goal).toBe("LANDING_PAGE_VIEWS");
    // Other goals have no pixel optimisation.
    expect(buildAdSet(adSetInput("awareness", { pixelFiredRecently: true })).optimization_goal).toBe("REACH");
  });

  it("website sales need a pixel; multi-destination sends the WhatsApp number only when there is one", () => {
    expect(() => buildAdSet(adSetInput("website_sales", { pixelId: null }))).toThrow(RangeError);
    expect(() => buildAdSet(adSetInput("website_sales", { pixelId: null }))).toThrow(/need a Meta pixel/);
    expect(buildAdSet(adSetInput("multi_destination", { whatsappDisplayPhone: undefined })).promoted_object).toStrictEqual({ page_id: "PAGE_1" });
  });

  it("special categories always send special_ad_category_country: the named countries, else the targeted ones, else India (4.3, VERIFY V-P1)", () => {
    expect(buildCampaign({ name: "C", template: "lead_generation", specialAdCategory: "housing", specialAdCategoryCountries: ["in", "IN", " ae "] })).toMatchObject({
      special_ad_categories: ["HOUSING"],
      special_ad_category_country: ["IN", "AE"],
    });
    expect(buildCampaign({ name: "C", template: "lead_generation", specialAdCategory: "none", specialAdCategoryCountries: ["IN"] })).not.toHaveProperty("special_ad_category_country");
    expect(buildCampaign({ name: "C", template: "lead_generation", specialAdCategory: "none" })).not.toHaveProperty("special_ad_category_country");
    // From the ad sets' targeting: countries and the postal codes' countries.
    const ae = targeting({ geo: { countries: ["AE"], cities: [] } });
    const zips = targeting({ geo: { countries: [], cities: [], zips: [{ key: "IN:110001" }] } });
    expect(buildCampaign({ name: "C", template: "traffic", specialAdCategory: "employment", targeting: ae }).special_ad_category_country).toEqual(["AE"]);
    expect(buildCampaign({ name: "C", template: "traffic", specialAdCategory: "employment", targeting: [ae, zips] }).special_ad_category_country).toEqual(["AE", "IN"]);
    // The old wizard's route names none: the 4.3 default, India, is sent instead of nothing.
    expect(buildCampaign({ name: "C", template: "traffic", specialAdCategory: "credit" })).toStrictEqual({
      name: "C",
      objective: "OUTCOME_TRAFFIC",
      status: "PAUSED",
      special_ad_categories: ["CREDIT"],
      buying_type: "AUCTION",
      is_adset_budget_sharing_enabled: false,
      special_ad_category_country: ["IN"],
    });
    // A city-only targeting names no country (Meta city keys carry none), so India is sent.
    expect(specialAdCategoryCountries({ specialAdCategory: "housing", targeting: targeting({ geo: { countries: [], cities: [{ key: "1035921", radiusKm: 25 }] } }) })).toEqual(["IN"]);
    // Junk is never sent.
    expect(specialAdCategoryCountries({ specialAdCategory: "housing", specialAdCategoryCountries: ["India", "", "1"] })).toEqual(["IN"]);
  });

  it("refuses a special category for a goal that has none (Chats on any app), on the campaign and on the ad set", () => {
    expect(() => buildAdSet(adSetInput("multi_destination", { specialAdCategory: "housing" }))).toThrow(SPECIAL_CATEGORY_NOT_ALLOWED);
    for (const category of CATEGORIES) {
      expect(() => buildCampaign({ name: "C", template: "multi_destination", specialAdCategory: category }), category).toThrow(SPECIAL_CATEGORY_NOT_ALLOWED);
      expect(campaignProblems({ template: "multi_destination", specialAdCategory: category })).toEqual([SPECIAL_CATEGORY_NOT_ALLOWED]);
    }
    expect(campaignProblems({ template: "multi_destination", specialAdCategory: "none" })).toEqual([]);
    for (const t of TEMPLATES.filter((x) => x !== "multi_destination")) expect(campaignProblems({ template: t, specialAdCategory: "housing" }), t).toEqual([]);
  });
});

describe("advantage_audience is in every ad set (D9)", () => {
  const allowed = (t: AdTemplate) => goalRow(TEMPLATE_SPECS[t].goal).specialCategoriesAllowed;

  it.each(TEMPLATES)("%s: 1 for 'Let Meta find people' without a category (no age_max), else 0", (template) => {
    const on = buildAdSet(adSetInput(template, { targeting: targeting({ advantageAudience: true }) })).targeting as Record<string, unknown>;
    expect(on.targeting_automation).toEqual({ advantage_audience: 1 });
    expect(on).not.toHaveProperty("age_max");
    const off = buildAdSet(adSetInput(template)).targeting as Record<string, unknown>;
    expect(off.targeting_automation).toEqual({ advantage_audience: 0 });
    expect(off.age_max).toBe(65);
    if (!allowed(template)) return;
    for (const category of CATEGORIES) {
      const special = buildAdSet(adSetInput(template, { specialAdCategory: category, targeting: targeting({ advantageAudience: true }) })).targeting as Record<string, unknown>;
      expect(special.targeting_automation, category).toEqual({ advantage_audience: 0 });
      expect(special.age_max).toBe(65);
    }
  });
});

describe("end_time and lifetime_budget (D7, 4.3)", () => {
  it.each(TEMPLATES)("%s: end_time whenever endsAt is set, and never without it", (template) => {
    expect(buildAdSet(adSetInput(template)).end_time).toBe(END.toISOString());
    expect(buildAdSet(adSetInput(template, { endsAt: null }))).not.toHaveProperty("end_time");
    expect(buildAdSet(adSetInput(template, { timeZone: "Asia/Kolkata" })).end_time).toBe("2026-11-14T23:59:00+0530");
  });

  it.each(TEMPLATES)("%s: lifetime_budget is never sent without end_time", (template) => {
    expect(() => buildAdSet(adSetInput(template, { lifetimeBudgetMinor: 900_000, endsAt: null }))).toThrow(RangeError);
    expect(() => buildAdSet(adSetInput(template, { lifetimeBudgetMinor: 900_000, endsAt: undefined }))).toThrow(/needs an end date/);
    const lifetime = buildAdSet(adSetInput(template, { lifetimeBudgetMinor: 900_000 }));
    expect(lifetime).toMatchObject({ lifetime_budget: 900_000, end_time: END.toISOString() });
    expect(lifetime).not.toHaveProperty("daily_budget");
    for (const lifetimeBudgetMinor of [null, 0, 900_000]) {
      for (const endsAt of [null, END]) {
        let body: Record<string, unknown>;
        try {
          body = buildAdSet(adSetInput(template, { lifetimeBudgetMinor, endsAt }));
        } catch (e) {
          expect(e).toBeInstanceOf(RangeError);
          continue;
        }
        if ("lifetime_budget" in body) expect(body).toHaveProperty("end_time");
        expect("lifetime_budget" in body !== "daily_budget" in body).toBe(true);
      }
    }
  });
});

describe("start and end in the ad account's time zone (D30, 3.1a)", () => {
  // A run that starts on Sat 31 Oct 2026 (EDT, -04:00) and ends on Sun 1 Nov 2026 at 23:59 (EST, -05:00).
  const startsAt = new Date("2026-10-31T13:00:00Z");
  const endsAt = endOfRunDay("2026-11-01", "America/New_York");

  it("carries the -04:00 and -05:00 offsets across 1 Nov 2026 in America/New_York", () => {
    const body = buildAdSet(adSetInput("click_to_whatsapp", { startsAt, endsAt, timeZone: "America/New_York" }));
    expect(body.start_time).toBe("2026-10-31T09:00:00-0400");
    expect(body.end_time).toBe("2026-11-01T23:59:00-0500");
    // The same instants, only written in the account's zone.
    expect(Date.parse(body.start_time as string)).toBe(startsAt.getTime());
    expect(Date.parse(body.end_time as string)).toBe(endsAt.getTime());
  });

  it("keeps UTC (toISOString) without a time zone, so the old wizard's payload is unchanged", () => {
    const body = buildAdSet(adSetInput("traffic", { startsAt, endsAt }));
    expect(body.start_time).toBe(startsAt.toISOString());
    expect(body.end_time).toBe(endsAt.toISOString());
    expect(buildAdSet(adSetInput("traffic", { startsAt, endsAt, timeZone: null })).start_time).toBe(startsAt.toISOString());
  });
});

describe("the old wizard's ad set and creatives keep their exact payloads", () => {
  it("a traffic ad set", () => {
    expect(buildAdSet({ name: "S", metaCampaignId: "c1", template: "traffic", targeting: targeting({ ageMin: 25, ageMax: 45 }), specialAdCategory: "none", dailyBudgetMinor: 50_000, pageId: "page1", endsAt: END })).toStrictEqual({
      name: "S",
      campaign_id: "c1",
      status: "PAUSED",
      daily_budget: 50_000,
      billing_event: "IMPRESSIONS",
      optimization_goal: "LINK_CLICKS",
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      destination_type: "WEBSITE",
      promoted_object: { page_id: "page1" },
      targeting: { geo_locations: { countries: ["IN"] }, age_min: 25, age_max: 45, targeting_automation: { advantage_audience: 0 } },
      end_time: END.toISOString(),
    });
  });

  it("a traffic creative", () => {
    expect(buildCreative({ name: "A", template: "traffic", creative: { pageId: "page1", message: "Hi", headline: "Sale", link: "https://e.com", imageUrl: "https://e.com/a.png" } })).toStrictEqual({
      name: "A",
      object_story_spec: { page_id: "page1", link_data: { message: "Hi", name: "Sale", picture: "https://e.com/a.png", link: "https://e.com", call_to_action: { type: "LEARN_MORE", value: { link: "https://e.com" } } } },
      degrees_of_freedom_spec: optOutSpec(),
    });
  });

  it("a lead form creative", () => {
    expect(buildCreative({ name: "L", template: "lead_generation", creative: { pageId: "page1", instagramId: "ig1", message: "Hi", leadFormId: "F1", imageHash: "H1" } })).toStrictEqual({
      name: "L",
      object_story_spec: { page_id: "page1", link_data: { message: "Hi", image_hash: "H1", link: "https://fb.me/", call_to_action: { type: "SIGN_UP", value: { lead_gen_form_id: "F1" } } }, instagram_user_id: "ig1" },
      degrees_of_freedom_spec: optOutSpec(),
    });
  });

  it("a click-to-WhatsApp creative with its welcome message", () => {
    const welcome = JSON.stringify({
      type: "VISUAL_EDITOR",
      version: 2,
      landing_screen_type: "welcome_message",
      media_type: "text",
      text_format: { customer_action_type: "autofill_message", message: { autofill_message: { body: "Hi there" }, text: "Hi there" } },
    });
    expect(buildCreative({ name: "W", template: "click_to_whatsapp", creative: { pageId: "page1", message: "Chat", whatsappNumberId: "ph1", welcomeMessage: "Hi there", imageUrl: "https://e.com/a.png" } })).toStrictEqual({
      name: "W",
      object_story_spec: {
        page_id: "page1",
        link_data: { message: "Chat", picture: "https://e.com/a.png", link: "https://api.whatsapp.com/send", call_to_action: { type: "WHATSAPP_MESSAGE", value: { app_destination: "WHATSAPP" } }, page_welcome_message: welcome },
      },
      degrees_of_freedom_spec: optOutSpec(),
    });
  });

  it("a Facebook post boost", () => {
    expect(buildCreative({ name: "B", template: "boost_post", creative: { pageId: "page1", message: "", postId: "9" } })).toStrictEqual({ name: "B", object_story_id: "page1_9", degrees_of_freedom_spec: optOutSpec() });
  });

  it("the old creative fields still choose the old path; a 5.4 format or boost id chooses creative-shapes", () => {
    const old: CreativeInput = { pageId: "p", message: "m" };
    for (const t of LEGACY_TEMPLATES) expect(usesCreativeShapes(t, old), t).toBe(false);
    for (const t of NEW_TEMPLATES) expect(usesCreativeShapes(t, old), t).toBe(true);
    expect(usesCreativeShapes("traffic", { ...old, format: "single_image" })).toBe(true);
    expect(usesCreativeShapes("boost_post", { ...old, fbPromotableId: "p_9" })).toBe(true);
    expect(usesCreativeShapes("boost_post", { ...old, igMediaId: "1789" })).toBe(true);
  });
});

describe("boost snapshots (4.3, B1, B4)", () => {
  const strip = (body: Record<string, unknown>) => {
    const { degrees_of_freedom_spec, ...rest } = body;
    expect(degrees_of_freedom_spec).toEqual(optOutSpec());
    return rest;
  };

  it("the Instagram media boost, from the old wizard and from the new fields alike", () => {
    const old = buildCreative({ name: "IG boost", template: "boost_post", creative: { pageId: "PAGE_1", message: "", instagramId: "IG_1", instagramMediaId: "17890001" } });
    const shaped = buildCreative({ name: "IG boost", template: "boost_post", creative: { pageId: "PAGE_1", message: "", instagramId: "IG_1", format: "existing_post", igMediaId: "17890001" } });
    expect(shaped).toStrictEqual(old);
    expect(strip(shaped)).toMatchInlineSnapshot(`
      {
        "instagram_user_id": "IG_1",
        "name": "IG boost",
        "object_id": "PAGE_1",
        "source_instagram_media_id": "17890001",
      }
    `);
  });

  it("the Facebook promotable_id boost, and with 'Also show on Instagram' on an eligible post", () => {
    const fb: CreativeBuildInput = { name: "FB boost", template: "boost_post", creative: { pageId: "PAGE_1", message: "", instagramId: "IG_1", format: "existing_post", fbPromotableId: "PAGE_1_POST_9" } };
    expect(strip(buildCreative(fb))).toMatchInlineSnapshot(`
      {
        "name": "FB boost",
        "object_story_id": "PAGE_1_POST_9",
      }
    `);
    expect(strip(buildCreative({ ...fb, alsoInstagram: true, igEligible: true }))).toMatchInlineSnapshot(`
      {
        "instagram_user_id": "IG_1",
        "name": "FB boost",
        "object_story_id": "PAGE_1_POST_9",
      }
    `);
    // Not eligible: Facebook only.
    expect(buildCreative({ ...fb, alsoInstagram: true, igEligible: false })).not.toHaveProperty("instagram_user_id");
    // A bare post id is joined to the Page.
    expect(buildCreative({ ...fb, creative: { ...fb.creative, fbPromotableId: "9" } }).object_story_id).toBe("PAGE_1_9");
  });
});

describe("every creative carries the enhancements block (D11)", () => {
  const MEDIA = { imageHash: "H_FEED", videoId: "V_1", thumbHash: "H_THUMB" };
  const CARDS = [
    { imageHash: "H_C1", headline: "Haircut", description: "From ₹499", link: "https://shop.example.in/hair" },
    { imageHash: "H_C2", headline: "Facial", description: "From ₹899", link: "https://shop.example.in/facial" },
  ];
  const creative = (source: SourceKind, format: AdFormat): CreativeInput => ({
    pageId: "PAGE_1",
    instagramId: "IG_1",
    message: "Diwali offer: 20% off",
    headline: "Book today",
    link: "https://shop.example.in/offer",
    leadFormId: "FORM_5",
    whatsappNumberId: "ph1",
    welcomeMessage: "Hi! I saw your ad",
    iceBreakers: [{ title: "Price?", response: "From ₹499." }],
    format,
    ...(source === "fb_post" ? { fbPromotableId: "PAGE_1_POST_9" } : {}),
    ...(source === "ig_media" ? { igMediaId: "IGM_7" } : {}),
    ...(source === "new" ? { media: { feed: "media_feed", video: "media_video" }, cards: CARDS.map((c, i) => ({ mediaId: `media_card_${i}`, headline: c.headline, description: c.description, link: c.link })) } : {}),
  });
  const cases = TEMPLATES.flatMap((template) => {
    const goal = TEMPLATE_SPECS[template].goal;
    return sourcesFor(goal).flatMap((source) => formatsFor(goal, source).map((format) => [template, source, format] as const));
  });

  it("covers every template", () => {
    expect(new Set(cases.map(([t]) => t))).toEqual(new Set(TEMPLATES));
  });

  it.each(cases)("%s from %s as %s: complete input validates and builds with every feature OPT_OUT", (template, source, format) => {
    const c = creative(source, format);
    expect(creativeProblems(template, c)).toEqual([]);
    const body = buildCreative({ name: "Ad", template, creative: c, media: MEDIA, cards: CARDS });
    expect(body.degrees_of_freedom_spec).toStrictEqual(optOutSpec());
    expect(body).not.toHaveProperty("status");
    expect(JSON.stringify(body)).not.toMatch(/\b(daily_budget|lifetime_budget|end_time)\b/);
    // AdMedia ids never reach Meta.
    expect(JSON.stringify(body)).not.toMatch(/media_(feed|video|card_)/);
    const optIn = buildCreative({ name: "Ad", template, creative: { ...c, enhancementsOptIn: true }, media: MEDIA, cards: CARDS });
    expect(optIn.degrees_of_freedom_spec).toStrictEqual(enhancementsSpec(true));
  });

  it.each(LEGACY_TEMPLATES)("the old wizard's %s creative too, and 'Let Meta improve my ad' flips it", (template) => {
    const c: CreativeInput = { pageId: "page1", message: "Hi", link: "https://e.com", imageUrl: "https://e.com/a.png", leadFormId: "F", whatsappNumberId: "ph", postId: "page1_9" };
    expect(buildCreative({ name: "A", template, creative: c }).degrees_of_freedom_spec).toStrictEqual(optOutSpec());
    expect(buildCreative({ name: "A", template, creative: { ...c, enhancementsOptIn: true } }).degrees_of_freedom_spec).toStrictEqual(enhancementsSpec(true));
  });

  it("OPTED_OUT_FEATURES and optOutSpec come from creative-shapes, with no second list in the builders", () => {
    expect(OPTED_OUT_FEATURES).toBe(SHAPE_FEATURES);
    expect(optOutSpec).toBe(shapeOptOutSpec);
    expect(OPTED_OUT_FEATURES).toHaveLength(17);
    const code = readFileSync(path.join(ROOT, "src/lib/ads/builders.ts"), "utf8");
    for (const feature of OPTED_OUT_FEATURES) expect(code, feature).not.toContain(`"${feature}"`);
  });
});

describe("creatives for the new goals", () => {
  it("delegate to creative-shapes: a website sales single image sends the default UTM tags and the member's button", () => {
    const body = buildCreative({
      name: "Sale",
      template: "website_sales",
      creative: { pageId: "PAGE_1", message: "Shop the sale", link: "https://shop.example.in", ctaType: "LEARN_MORE", format: "single_image", media: { feed: "m1" } },
      media: { imageHash: "H1" },
    }) as { object_story_spec: { link_data: Record<string, unknown> }; url_tags: string };
    expect(body.object_story_spec.link_data).toMatchObject({ image_hash: "H1", link: "https://shop.example.in", call_to_action: { type: "LEARN_MORE", value: { link: "https://shop.example.in" } } });
    expect(body.url_tags).toContain("utm_source=edwyz");
  });

  it("a WhatsApp ad with a format carries ice breakers in its welcome message", () => {
    const body = buildCreative({
      name: "W",
      template: "click_to_whatsapp",
      creative: { pageId: "PAGE_1", message: "Chat", whatsappNumberId: "ph1", welcomeMessage: "Hi", iceBreakers: [{ title: "Price?", response: "From ₹499." }], format: "single_image" },
      media: { imageHash: "H1" },
    }) as { object_story_spec: { link_data: { page_welcome_message: string } } };
    expect(JSON.parse(body.object_story_spec.link_data.page_welcome_message).text_format.message.ice_breakers).toEqual([{ title: "Price?", response: "From ₹499." }]);
  });

  it("per-placement assets follow the ad set's chosen positions", () => {
    const body = buildCreative({
      name: "Tall",
      template: "awareness",
      creative: { pageId: "PAGE_1", instagramId: "IG_1", message: "New shop", format: "single_image" },
      media: { imageHash: "H_FEED", verticalImageHash: "H_TALL" },
      positions: ["instagram_feed", "instagram_stories"],
    }) as { asset_feed_spec: { asset_customization_rules: { customization_spec: Record<string, unknown> }[] } };
    expect(body.asset_feed_spec.asset_customization_rules.map((r) => r.customization_spec)).toEqual([
      { publisher_platforms: ["instagram"], instagram_positions: ["stream"] },
      { publisher_platforms: ["instagram"], instagram_positions: ["story"] },
    ]);
  });

  it("refuses to build without resolved media, so an AdMedia id is never sent as a hash; creativeBuildProblems says so first", () => {
    const c: CreativeInput = { pageId: "PAGE_1", message: "Hi", format: "single_image", media: { feed: "media_1" } };
    expect(creativeProblems("awareness", c)).toEqual([]);
    expect(creativeBuildProblems({ name: "A", template: "awareness", creative: c })).toEqual([SHAPE_PROBLEM_TEXT.missing_media]);
    expect(() => buildCreative({ name: "A", template: "awareness", creative: c })).toThrow(RangeError);
    expect(() => buildCreative({ name: "A", template: "awareness", creative: c })).toThrow(SHAPE_PROBLEM_TEXT.missing_media);
    // Resolved: no problem, and it builds.
    expect(creativeBuildProblems({ name: "A", template: "awareness", creative: c, media: { imageHash: "H1" } })).toEqual([]);
    expect(() => buildCreative({ name: "A", template: "awareness", creative: c, media: { imageHash: "H1" } })).not.toThrow();
  });

  it("says what is missing in plain words", () => {
    expect(creativeProblems("awareness", { pageId: "PAGE_1", message: "Hi", format: "single_image" })).toEqual([SHAPE_PROBLEM_TEXT.missing_media]);
    expect(creativeProblems("website_sales", { pageId: "PAGE_1", message: "Hi", format: "single_image", media: { feed: "m" } })).toEqual([SHAPE_PROBLEM_TEXT.missing_link]);
    expect(creativeProblems("click_to_instagram", { pageId: "", message: "", format: "single_image", media: { feed: "m" } })).toEqual(["The ad needs primary text.", SHAPE_PROBLEM_TEXT.missing_page]);
    expect(creativeProblems("engagement", { pageId: "PAGE_1", message: "Hi", link: "https://shop.example.in", format: "carousel", cards: [{ mediaId: "m", headline: "One" }] })).toEqual([SHAPE_PROBLEM_TEXT.carousel_cards]);
    expect(creativeProblems("video_views", { pageId: "PAGE_1", message: "Hi", format: "single_image", media: { feed: "m" } })).toEqual([SHAPE_PROBLEM_TEXT.goal_format]);
    expect(creativeProblems("click_to_whatsapp", { pageId: "PAGE_1", message: "Hi", format: "single_image", media: { feed: "m" } })).toEqual(["Choose the WhatsApp number people will chat with."]);
    expect(creativeProblems("boost_post", { pageId: "PAGE_1", message: "", format: "existing_post" })).toEqual([SHAPE_PROBLEM_TEXT.missing_post]);
    // The old wizard's messages are unchanged.
    expect(creativeProblems("lead_generation", { pageId: "p", message: "Hi", imageUrl: "https://e.com/a.png" })).toEqual(["This template needs leadFormId."]);
    for (const text of Object.values(SHAPE_PROBLEM_TEXT)) expect(text).toMatch(/^[A-Z].*\.$/);
  });
});

describe("validators speak before the builders throw (nothing is left half-made on Meta)", () => {
  const AUDIENCE_MAP = { aud_1: "2385000000101", aud_like: "2385000000001" };
  const TARGETINGS: Targeting[] = [
    targeting(),
    targeting({ customAudienceIds: ["aud_1"] }),
    targeting({ excludedAudienceIds: ["999"] }),
    targeting({ lookalikeAudienceIds: ["aud_like"] }),
  ];

  it("every RangeError of buildCampaign and buildAdSet is in campaignProblems and adSetProblems first", () => {
    const seen = new Set<string>();
    const misses: string[] = [];
    for (const template of TEMPLATES) {
      for (const specialAdCategory of SPECIAL_CATEGORIES) {
        try {
          buildCampaign({ name: "C", template, specialAdCategory });
        } catch (e) {
          if (!(e instanceof RangeError) || !campaignProblems({ template, specialAdCategory }).includes(e.message)) misses.push(`campaign ${template} ${specialAdCategory}: ${String(e)}`);
        }
        for (const pixelId of [null, "PIXEL_1"]) {
          for (const [lifetimeBudgetMinor, endsAt] of [[null, END], [900_000, END], [900_000, null]] as const) {
            for (const t of TARGETINGS) {
              for (const audienceMetaIds of [undefined, AUDIENCE_MAP]) {
                const input = adSetInput(template, { specialAdCategory, pixelId, lifetimeBudgetMinor, endsAt, targeting: t, audienceMetaIds });
                const problems = adSetProblems(input);
                try {
                  buildAdSet(input);
                } catch (e) {
                  seen.add((e as Error).message);
                  if (!(e instanceof RangeError) || !problems.includes(e.message)) misses.push(`ad set ${template} ${specialAdCategory} ${pixelId} ${lifetimeBudgetMinor}: ${String(e)}`);
                }
              }
            }
          }
        }
      }
    }
    expect(misses).toEqual([]);
    // Every path was exercised.
    expect([...seen].sort()).toEqual([AUDIENCE_NOT_READY, AUDIENCES_NOT_HERE, LIFETIME_NEEDS_END, PIXEL_NEEDED, SPECIAL_CATEGORY_NOT_ALLOWED].sort());
  });

  it("every throw of buildCreative is in creativeBuildProblems first", () => {
    const MEDIA = { imageHash: "H_FEED", videoId: "V_1", thumbHash: "H_THUMB" };
    const CARDS = [
      { imageHash: "H_C1", headline: "One", link: "https://shop.example.in/1" },
      { imageHash: "H_C2", headline: "Two", link: "https://shop.example.in/2" },
    ];
    const full: CreativeInput = {
      pageId: "PAGE_1",
      instagramId: "IG_1",
      message: "Diwali offer",
      link: "https://shop.example.in",
      leadFormId: "FORM_5",
      whatsappNumberId: "ph1",
      imageUrl: "https://shop.example.in/a.png",
      postId: "PAGE_1_9",
    };
    const drops: (keyof CreativeInput)[] = ["pageId", "message", "link", "leadFormId", "whatsappNumberId", "imageUrl", "postId"];
    const extras: Partial<CreativeInput>[] = [
      {},
      { format: "single_image", media: { feed: "media_1" } },
      { format: "single_video", media: { video: "media_v" } },
      { format: "carousel", cards: [{ mediaId: "m1", headline: "One" }, { mediaId: "m2", headline: "Two" }] },
      { format: "existing_post", fbPromotableId: "PAGE_1_POST_9" },
      { format: "existing_post", igMediaId: "IGM_7" },
    ];
    const seen = new Set<string>();
    const misses: string[] = [];
    let builds = 0;
    for (const template of TEMPLATES) {
      for (const extra of extras) {
        for (const drop of [null, ...drops]) {
          for (const resolved of [false, true]) {
            const creative: CreativeInput = { ...full, ...extra };
            if (drop) delete creative[drop];
            const input: CreativeBuildInput = { name: "Ad", template, creative, ...(resolved ? { media: MEDIA, cards: CARDS } : {}) };
            const problems = creativeBuildProblems(input);
            try {
              buildCreative(input);
              builds++;
            } catch (e) {
              const message = (e as Error).message;
              if (e instanceof RangeError) seen.add(message);
              // The old wizard's path is unchanged and may fail on a missing post; its validator says so first all the same.
              if (problems.length === 0 || (e instanceof RangeError && !problems.some((p) => message.includes(p)))) misses.push(`${template} ${JSON.stringify(extra)} -${drop} ${resolved}: ${message}`);
            }
          }
        }
      }
    }
    expect(misses).toEqual([]);
    expect(builds).toBeGreaterThan(100);
    // Thrown text is always plain copy (one or more SHAPE_PROBLEM_TEXT sentences), never problem codes.
    const plain = Object.values(SHAPE_PROBLEM_TEXT).sort((a, b) => b.length - a.length);
    for (const text of seen) expect(plain.reduce((rest, p) => rest.split(p).join(""), text).trim(), text).toBe("");
    expect(seen).toContain(SHAPE_PROBLEM_TEXT.missing_media);
  });

  it("adSetProblems adds the targeting and the goal's placement rules, in plain copy", () => {
    expect(adSetProblems(adSetInput("traffic"))).toEqual([]);
    expect(adSetProblems(adSetInput("website_sales", { pixelId: null }))).toEqual([PIXEL_NEEDED]);
    expect(adSetProblems(adSetInput("traffic", { targeting: targeting({ placements: ["audience_network"] }) }))).toEqual(["Apps and sites outside Meta can't be the only place your ad shows."]);
    // Profile visits run on Instagram only: Automatic is not allowed for the goal.
    expect(adSetProblems(adSetInput("profile_visits"))).toEqual(["Ads for this goal show only on Instagram."]);
    expect(adSetProblems(adSetInput("profile_visits", { targeting: targeting({ placements: ["instagram_feed"] }) }))).toEqual([]);
    // A video-only place needs the ad's format.
    const instream = targeting({ placements: ["facebook_feed", "facebook_instream_video"] });
    expect(adSetProblems(adSetInput("video_views", { targeting: instream }))).toEqual([expect.stringMatching(/shows videos only\.$/)]);
    expect(adSetProblems(adSetInput("video_views", { targeting: instream, format: "single_video" }))).toEqual([]);
    // Audiences: unresolved ones are reported once, whether from the build rule or the targeting check.
    expect(adSetProblems(adSetInput("traffic", { targeting: targeting({ customAudienceIds: ["123456"] }), audienceMetaIds: { a: "1" } }))).toEqual([AUDIENCE_NOT_READY]);
    expect(adSetProblems(adSetInput("traffic", { targeting: targeting({ customAudienceIds: ["aud_1"] }), audienceMetaIds: AUDIENCE_MAP }))).toEqual([]);
    // A broken targeting (no place) is reported too, though buildAdSet itself doesn't judge targeting.
    expect(adSetProblems(adSetInput("traffic", { targeting: targeting({ geo: { countries: [], cities: [] } }) }))).toEqual(["Choose at least one country or city."]);
  });
});
