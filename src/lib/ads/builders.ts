import { metaSpecialCategories, toMetaTargeting } from "./targeting";
import type { AdTemplate, CreativeInput, SpecialAdCategory, Targeting } from "./types";

/*
 * Request builders for the Marketing API. Every campaign, ad set and ad is created with status PAUSED; a creative carries no
 * status at all (it has no delivery status, docs/SPEND-CONTROLS-SPEC.md erratum 12.1b).
 * Spend controls (4.5, 4.8): budget sharing between ad sets is always sent off (sharing would let Meta spend 2.1x a day); an
 * ad set sends end_time whenever the campaign has an end date, and a lifetime budget (lifetime_budget, which Meta only takes
 * with an end date) instead of a daily budget when one is set.
 * Shapes are written from memory of the Marketing API; every field marked VERIFY must be checked against the
 * current reference (campaign, adset, adcreative, ad) for the pinned GRAPH_API_VERSION before real use.
 */

type TemplateSpec = {
  objective: string;
  optimizationGoal: string;
  destinationType: string;
  /** What the creative must provide. */
  needs: ("link" | "leadFormId" | "whatsappNumberId" | "postId")[];
};

// VERIFY: objective names (ODAX), optimization_goal and destination_type pairings per template.
export const TEMPLATE_SPECS: Record<AdTemplate, TemplateSpec> = {
  lead_generation: { objective: "OUTCOME_LEADS", optimizationGoal: "LEAD_GENERATION", destinationType: "ON_AD", needs: ["leadFormId"] },
  click_to_whatsapp: { objective: "OUTCOME_ENGAGEMENT", optimizationGoal: "CONVERSATIONS", destinationType: "WHATSAPP", needs: ["whatsappNumberId"] },
  traffic: { objective: "OUTCOME_TRAFFIC", optimizationGoal: "LINK_CLICKS", destinationType: "WEBSITE", needs: ["link"] },
  boost_post: { objective: "OUTCOME_ENGAGEMENT", optimizationGoal: "POST_ENGAGEMENT", destinationType: "ON_POST", needs: ["postId"] },
};

export const DEFAULT_CTA: Record<AdTemplate, string> = {
  lead_generation: "SIGN_UP",
  click_to_whatsapp: "WHATSAPP_MESSAGE",
  traffic: "LEARN_MORE",
  boost_post: "LEARN_MORE",
};

export function creativeProblems(template: AdTemplate, c: CreativeInput): string[] {
  const out: string[] = [];
  if (!c.pageId) out.push("Choose a Facebook Page.");
  if (template !== "boost_post" && !c.message?.trim()) out.push("The ad needs primary text.");
  for (const need of TEMPLATE_SPECS[template].needs) {
    if (!c[need]) out.push(`This template needs ${need}.`);
  }
  if (c.link && !/^https:\/\/[^\s]+$/.test(c.link)) out.push("The link must start with https://.");
  if (template !== "boost_post" && !c.imageUrl && !c.imageHash) out.push("Add an image (imageUrl or imageHash).");
  return out;
}

export const actId = (externalId: string) => (externalId.startsWith("act_") ? externalId : `act_${externalId}`);

export function buildCampaign(input: { name: string; template: AdTemplate; specialAdCategory: SpecialAdCategory }) {
  return {
    name: input.name,
    objective: TEMPLATE_SPECS[input.template].objective,
    status: "PAUSED",
    // Always sent, even when empty, so Meta never infers a category.
    special_ad_categories: metaSpecialCategories(input.specialAdCategory),
    buying_type: "AUCTION",
    // VERIFY: required when the budget lives on the ad set rather than the campaign.
    // Always off: with sharing on, Meta may move up to 20% between ad sets and spend 2.1x a day (4.5).
    is_adset_budget_sharing_enabled: false,
  };
}

export type AdSetBuildInput = {
  name: string;
  metaCampaignId: string;
  template: AdTemplate;
  targeting: Targeting;
  specialAdCategory: SpecialAdCategory;
  /** The daily budget; ignored when a lifetime budget is set (Meta takes one or the other). */
  dailyBudgetMinor: number;
  /** A lifetime budget instead of a daily one. Needs endsAt. */
  lifetimeBudgetMinor?: number | null;
  pageId: string;
  whatsappDisplayPhone?: string;
  startsAt?: Date | null;
  endsAt?: Date | null;
};

export function buildAdSet(input: AdSetBuildInput) {
  const spec = TEMPLATE_SPECS[input.template];
  const promoted: Record<string, string> = { page_id: input.pageId };
  // VERIFY: whatsapp_phone_number format (E.164 with plus) for click-to-WhatsApp promoted_object.
  if (input.template === "click_to_whatsapp" && input.whatsappDisplayPhone) promoted.whatsapp_phone_number = input.whatsappDisplayPhone;
  const lifetime = typeof input.lifetimeBudgetMinor === "number" && input.lifetimeBudgetMinor > 0 ? input.lifetimeBudgetMinor : null;
  if (lifetime !== null && !input.endsAt) throw new RangeError("A lifetime budget needs an end date.");
  const body: Record<string, unknown> = {
    name: input.name,
    campaign_id: input.metaCampaignId,
    status: "PAUSED",
    ...(lifetime !== null ? { lifetime_budget: lifetime } : { daily_budget: input.dailyBudgetMinor }),
    billing_event: "IMPRESSIONS",
    optimization_goal: spec.optimizationGoal,
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    destination_type: spec.destinationType,
    promoted_object: promoted,
    targeting: toMetaTargeting(input.targeting, input.specialAdCategory),
  };
  if (input.startsAt) body.start_time = input.startsAt.toISOString();
  if (input.endsAt) body.end_time = input.endsAt.toISOString();
  return body;
}

export type CreativeBuildInput = { name: string; template: AdTemplate; creative: CreativeInput; whatsappDisplayPhone?: string };

export function buildCreative(input: CreativeBuildInput) {
  const { template, creative: c } = input;
  if (template === "boost_post") {
    // VERIFY: object_story_id is "<page_id>_<post_id>"; Instagram posts use source_instagram_media_id instead.
    return { name: input.name, object_story_id: c.postId!.includes("_") ? c.postId : `${c.pageId}_${c.postId}` };
  }
  const cta = c.cta || DEFAULT_CTA[template];
  const linkData: Record<string, unknown> = { message: c.message };
  if (c.headline) linkData.name = c.headline;
  if (c.imageHash) linkData.image_hash = c.imageHash;
  else if (c.imageUrl) linkData.picture = c.imageUrl;
  if (template === "lead_generation") {
    // VERIFY: lead form ads carry the form in call_to_action.value.lead_gen_form_id and a link to the form's privacy policy or site.
    linkData.link = c.link ?? "https://fb.me/";
    linkData.call_to_action = { type: cta, value: { lead_gen_form_id: c.leadFormId } };
  } else if (template === "click_to_whatsapp") {
    // VERIFY: link and app_destination shape for click-to-WhatsApp creatives.
    linkData.link = "https://api.whatsapp.com/send";
    linkData.call_to_action = { type: cta, value: { app_destination: "WHATSAPP" } };
  } else {
    linkData.link = c.link;
    linkData.call_to_action = { type: cta, value: { link: c.link } };
  }
  const storySpec: Record<string, unknown> = { page_id: c.pageId, link_data: linkData };
  if (c.instagramId) storySpec.instagram_user_id = c.instagramId;
  const body: Record<string, unknown> = { name: input.name, object_story_spec: storySpec };
  if (template === "click_to_whatsapp" && c.welcomeMessage) {
    // VERIFY: page_welcome_message is a JSON string in the visual-editor format; confirm the current schema.
    body.object_story_spec = {
      ...storySpec,
      link_data: {
        ...linkData,
        page_welcome_message: JSON.stringify({
          type: "VISUAL_EDITOR",
          version: 2,
          landing_screen_type: "welcome_message",
          media_type: "text",
          text_format: { customer_action_type: "autofill_message", message: { autofill_message: { body: c.welcomeMessage }, text: c.welcomeMessage } },
        }),
      },
    };
  }
  return body;
}

export function buildAd(input: { name: string; metaAdSetId: string; metaCreativeId: string }) {
  return { name: input.name, adset_id: input.metaAdSetId, creative: { creative_id: input.metaCreativeId }, status: "PAUSED" };
}

export type PayloadPreview = {
  campaign: Record<string, unknown>;
  adSet: Record<string, unknown>;
  ads: { name: string; creative: Record<string, unknown> }[];
};
