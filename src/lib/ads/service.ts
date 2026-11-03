import { randomUUID } from "node:crypto";
import { expireDecidedApprovals, isCampaignClientApproved, listApprovals } from "@/lib/approvals";
import { audit } from "@/lib/auth/audit";
import { adAccountsBlockedByPlan, assertAdAccountAllowed } from "@/lib/billing/limits";
import { prisma } from "@/lib/db";
import { getAssetAccess, listAssets } from "@/lib/meta-connect";
import { carouselProblem, checkMedia, checkText, groupOfPlacement } from "@/lib/promote/catalog/formats";
import { goalOfLegacyTemplate } from "@/lib/promote/catalog/goals";
import { formatMoney, promoteText } from "@/lib/promote/copy";
import { majorUnit, splitDaily } from "@/lib/promote/cost";
import type { ShapeCard, ShapeMedia } from "@/lib/promote/creative-shapes";
import { MAX_RUN_DAYS, MIN_RUN_DAYS, runDates } from "@/lib/promote/dates";
import { assertPromoteStartOpen } from "@/lib/promote/route-guard";
import type { AdFormat, MediaProbe, PlacementKey, StartMode } from "@/lib/promote/types";
import { sanitizeMessage } from "@/lib/safe-error";
import { adsHeadroomDetail, permitForPausedCreate, recordLowering, reserveAds, settleAds } from "@/lib/spend/book";
import { spendCopy } from "@/lib/spend/copy";
import { SpendBlockedError } from "@/lib/spend/errors";
import { spendEnforceMode } from "@/lib/spend/flags";
import { resolveTimeZone } from "@/lib/spend/periods";
import { sandboxFlagFor } from "@/lib/spend/sandbox";
import type { AdsPermit, CreatePermit, SpendActor } from "@/lib/spend/types";
import { dayRisk, NO_SPEND, remainingMonth } from "@/lib/spend/worstcase";
import { HttpError, requireRole, type Actor } from "@/lib/tenancy";
import { setAdSetBudget, setSplitBudget } from "./actions";
import { buildAd, buildAdSet, buildCampaign, buildCreative, creativeBuildProblems, creativeProblems, adSetProblems, TEMPLATE_SPECS, usesCreativeShapes, type PayloadPreview } from "./builders";
import { assetImageProblem, assetImageUrl, mediaImageUrl, usableAssetImage, withFreshAssetImage } from "./asset-image";
import { auditOutcome, auditStrict } from "./audit";
import { assertCapApplies, assertWithinCap, getCaps, isCurrencyCode } from "./caps";
import { describeHits, detectSpecialCategoryTerms, urlWords } from "./category-terms";
import { adsClient, type AdsClient } from "./client";
import {
  ASSISTANT_MAX_END_DAYS,
  DAY_MS,
  END_REQUIRED,
  isDraftSurface,
  isNewFlowSurface,
  parseDraftInput,
  parseReplacesAdIds,
  readReplacesAdIds,
  runProblem,
  type CampaignOrigin,
  type DraftInput,
  type VariantKey,
} from "./draft-input";
import { readAdReview } from "./review";
import { audienceIdsOf, parseTargeting, restrictForCategory, validateTargeting } from "./targeting";
import { isAnyTemplate, isCategory, isTemplate, type AdTemplate, type CreativeInput, type SpecialAdCategory } from "./types";

// The draft body moved to ./draft-input (PRM-05); these names stay importable from here.
export { ASSISTANT_MAX_END_DAYS, parseDraftInput, type CampaignOrigin, type DraftInput, type DraftParseOptions } from "./draft-input";

const json = (v: unknown) => v as never;
/** Worst case for one Graph call: 4 attempts of 20 seconds plus the longest backoff delays (graph/index.ts MAX_ATTEMPTS, TIMEOUT_MS, backoffDelay). */
const WORST_CALL_MS = 4 * 20_000 + 7_000;
/**
 * How long a "launching" claim is honoured without a sign of life. The launcher refreshes the campaign row after every Meta call, so
 * the longest silent gap is one call at its worst case; twice that, never under 5 minutes. A crashed launch is therefore reclaimable
 * after this long, however many ads it had.
 */
export const LAUNCH_LEASE_MS = Math.max(5 * 60_000, 2 * WORST_CALL_MS);
/** Meta and this server may disagree on the clock; a campaign this much older than our draft is still not ours. */
const CLOCK_SKEW_MS = 5 * 60_000;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The person behind a request, as the Spend Book records them. */
export const userSpendActor = (actor: Actor): SpendActor => ({ type: "user", userId: actor.userId, role: actor.role });

/** A discarded draft can be brought back for this long (4.8 discard_promotion_draft, 6.4). */
export const DRAFT_RESTORE_MS = 15 * 60_000;
export const DRAFT_DISCARDED = "This draft was discarded. Restore it first.";
const DRAFT_CHANGED = "This campaign changed while you were editing it. Reload the page and try again.";
const PICTURE_NOT_READY = "Your picture is still being sent to Meta. Try again in a minute.";
const MEDIA_MISSING = "A picture or video is no longer in this ad account's library. Pick it again.";
const MEDIA_UNUSABLE = "Meta couldn't take a picture or video. Pick another one.";
const AUDIENCE_UNKNOWN = "An audience isn't in this workspace any more. Pick it again, or remove it.";
export const SOURCE_POST_UNKNOWN = "That post isn't in this workspace. Pick the post again.";
const FIX_NEEDS_META = "Only an ad that is on Meta can be fixed with a copy. Edit the draft instead.";
const FIX_ARCHIVED = "That ad is archived, so it doesn't run and there is nothing to fix. Make a copy instead.";

/**
 * A launch refused because a picture or video it uses is still being prepared for Meta (an upload or video processing in
 * progress). 409 with code media_not_ready: nothing was created, and launching again once the media is ready continues.
 */
export class AdsMediaNotReadyError extends HttpError {
  readonly code = "media_not_ready" as const;
  readonly mediaIds: string[];
  constructor(mediaIds: string[], kind: "image" | "video") {
    super(409, kind === "video" ? promoteText("error.media_not_ready") : PICTURE_NOT_READY);
    this.name = "AdsMediaNotReadyError";
    this.mediaIds = mediaIds;
  }
  toJSON() {
    return { error: this.message, code: this.code, mediaIds: this.mediaIds };
  }
}

/** The ad account as the workspace stored it (its currency and time zone are what Meta reported at the last refresh). */
async function adAccountOf(tenantId: string, accountAssetId: string) {
  return (await listAssets(tenantId, "ad_account")).find((a) => a.id === accountAssetId) ?? null;
}

const zoneOfMeta = (meta: unknown): string | null => (isObj(meta) && typeof meta.timezone === "string" && meta.timezone.trim() ? meta.timezone.trim() : null);

/** The spending ad account's IANA zone (D30), or null when the account reports none (then Meta gets UTC times, as before). */
async function accountZone(tenantId: string, accountAssetId: string): Promise<string | null> {
  return zoneOfMeta((await adAccountOf(tenantId, accountAssetId))?.meta);
}

/** A campaign made by the new flows or Eddy (6.1 rule 3: it always ends; it may use every goal of 4.4). */
const isNewFlowCampaign = (c: { surface?: string | null }) => isNewFlowSurface(c.surface ?? "wizard");

/** The 5.4 format of an ad: as stored on its creative, else existing_post for a boost and single_image for the old wizard. */
function formatOf(template: string, creative: unknown): AdFormat {
  const f = isObj(creative) ? creative.format : undefined;
  if (f === "single_image" || f === "single_video" || f === "carousel" || f === "existing_post") return f;
  return template === "boost_post" ? "existing_post" : "single_image";
}

/** Every AdMedia id a creative names (5.4): its media slots, then its carousel cards. */
export function creativeMediaIds(creative: unknown): string[] {
  if (!isObj(creative)) return [];
  const out: string[] = [];
  const media = isObj(creative.media) ? creative.media : {};
  for (const slot of ["feed", "vertical", "square", "video"]) if (typeof media[slot] === "string" && media[slot]) out.push(media[slot] as string);
  for (const card of Array.isArray(creative.cards) ? creative.cards : []) if (isObj(card) && typeof card.mediaId === "string" && card.mediaId) out.push(card.mediaId);
  return [...new Set(out)];
}

/** The boosted post an ad promotes, for Ad.sourcePostRef. */
const sourcePostOf = (c: Partial<CreativeInput>) => c.fbPromotableId || c.igMediaId || c.postId || c.instagramMediaId || null;

async function suggestedCategory(tenantId: string): Promise<SpecialAdCategory> {
  const brands = await prisma.brand.findMany({ where: { tenantId, specialAdCategory: { not: "none" } }, select: { specialAdCategory: true }, take: 1 });
  const c = brands[0]?.specialAdCategory;
  return isCategory(c) ? c : "none";
}

/**
 * Industries of the brands the ads come from: when the ads use library creatives, only those creatives' brands; otherwise (copy typed
 * by hand, so the brand is unknown) every brand of the workspace.
 */
async function brandIndustries(tenantId: string, creativeAssetIds: string[]): Promise<string[]> {
  const industries = (rows: { industry: string | null }[]) => (rows ?? []).map((b) => b.industry).filter((v): v is string => typeof v === "string" && v.length > 0);
  if (creativeAssetIds.length) {
    const assets = await prisma.creativeAsset.findMany({ where: { tenantId, id: { in: creativeAssetIds } }, select: { brief: { select: { brand: { select: { industry: true } } } } }, take: 50 });
    return industries((assets ?? []).map((a) => ({ industry: a.brief?.brand?.industry ?? null })));
  }
  return industries(await prisma.brand.findMany({ where: { tenantId }, select: { industry: true }, take: 20 }));
}

/** Housing, employment or credit terms in the copy or the brand industry. Empty when none are found. */
async function categoryTermHits(tenantId: string, copy: (string | undefined | null)[], creativeAssetIds: string[]) {
  const industries = await brandIndustries(tenantId, creativeAssetIds);
  return detectSpecialCategoryTerms(copy, industries.join(" ; "));
}

/** Everything a viewer reads or follows: message, headline, welcome message, the link and image URL words, the button label. */
const creativeCopy = (c: Partial<CreativeInput>) => [c.message, c.headline, c.welcomeMessage, urlWords(c.link), urlWords(c.imageUrl), c.cta];

/** The currency the ad account reports right now. Refuses when the account is not connected or reports none, so nothing is ever assumed. */
async function liveAccountCurrency(tenantId: string, accountAssetId: string): Promise<string> {
  const account = (await listAssets(tenantId, "ad_account")).find((a) => a.id === accountAssetId);
  if (!account) throw new HttpError(404, "Ad account not found.");
  const currency = isObj(account.meta) && typeof account.meta.currency === "string" ? account.meta.currency.trim().toUpperCase() : "";
  if (!isCurrencyCode(currency)) throw new HttpError(409, "The currency of this ad account is unknown, so the budget cannot be checked against your cap. Reconnect or refresh the ad account in Connections and try again.");
  return currency;
}

/** Campaigns saved before currency was validated may carry a defaulted INR: the stored currency must equal the account's live one. */
async function assertCampaignCurrencyMatchesAccount(c: { tenantId: string; adAccountAssetId: string; currency: string }): Promise<void> {
  const live = await liveAccountCurrency(c.tenantId, c.adAccountAssetId);
  if (live !== c.currency) throw new HttpError(409, `This campaign was saved in ${c.currency} but its ad account reports ${live}, so its budget amount cannot be trusted. Create the campaign again.`);
}

export async function adOptions(tenantId: string) {
  const [accounts, pages, instagram, phones, assets, suggested, caps] = await Promise.all([
    listAssets(tenantId, "ad_account"),
    listAssets(tenantId, "page"),
    listAssets(tenantId, "instagram"),
    prisma.phoneNumber.findMany({ where: { tenantId, status: "connected" }, select: { id: true, displayPhone: true, verifiedName: true } }),
    prisma.creativeAsset.findMany({ where: { tenantId, status: { in: ["ready", "approved"] }, kind: { in: ["copy", "image"] } }, select: { id: true, kind: true, headline: true, body: true, placement: true, status: true, storageKey: true, policyCheck: true }, orderBy: { createdAt: "desc" }, take: 50 }),
    suggestedCategory(tenantId),
    getCaps(tenantId),
  ]);
  const blocked = await adAccountsBlockedByPlan(tenantId, accounts.map((a) => a.id));
  const strip = (a: { id: string; externalId: string; name: string | null; meta: unknown }) => ({ id: a.id, externalId: a.externalId, name: a.name, currency: isObj(a.meta) && typeof a.meta.currency === "string" ? a.meta.currency : null });
  // The ad account's time zone: the wizard counts Meta's worst case per account day (docs/SPEND-CONTROLS-SPEC.md 8.2).
  const zone = (a: { meta: unknown }) => (isObj(a.meta) && typeof a.meta.timezone === "string" && a.meta.timezone ? a.meta.timezone : null);
  return { adAccounts: accounts.map((a) => ({ ...strip(a), timezone: zone(a), planBlocked: blocked.has(a.id) })), pages: pages.map(strip), instagram: instagram.map(strip), phoneNumbers: phones, creativeAssets: (assets ?? []).map(({ storageKey, policyCheck, ...a }) => ({ ...a, hasImage: usableAssetImage({ kind: a.kind, storageKey: storageKey ?? null }), imageProblem: assetImageProblem({ kind: a.kind, storageKey: storageKey ?? null }), blocked: (policyCheck as { result?: string } | null)?.result === "block" })), suggestedSpecialAdCategory: suggested, caps };
}

async function resolveCreative(tenantId: string, input: DraftInput["ads"][number]) {
  const creative = { ...input.creative };
  // A media library picture wins over a typed link. Its link is signed now for the review and again at launch.
  if (creative.mediaKey && !creative.imageHash) creative.imageUrl = await mediaImageUrl(tenantId, creative.mediaKey);
  if (input.creativeAssetId) {
    const asset = await prisma.creativeAsset.findFirst({ where: { id: input.creativeAssetId, tenantId } });
    if (!asset) throw new HttpError(404, "Creative asset not found.");
    // "ready" (generated, stored and policy-checked) and "approved" (explicitly approved in the studio) are both launchable: the studio approval is
    // optional and the wizard only sorts approved assets first. Pending, failed and rejected assets, and any with a blocking policy result, are refused.
    if (asset.status !== "ready" && asset.status !== "approved") throw new HttpError(409, "The creative asset is not ready to use.");
    const check = asset.policyCheck as { result?: string } | null;
    if (check?.result === "block") throw new HttpError(409, "The creative failed the policy check and cannot be launched.");
    if (!creative.message && asset.body) creative.message = asset.body.slice(0, 2200);
    if (!creative.headline && asset.headline) creative.headline = asset.headline.slice(0, 100);
    if (!creative.imageUrl && !creative.imageHash) creative.imageUrl = (await assetImageUrl(tenantId, asset)) ?? undefined;
  }
  return creative;
}

async function assertOwnedRefs(tenantId: string, accountAssetId: string, creatives: CreativeInput[]) {
  const [accounts, pages, instagram] = await Promise.all([listAssets(tenantId, "ad_account"), listAssets(tenantId, "page"), listAssets(tenantId, "instagram")]);
  if (!accounts.some((a) => a.id === accountAssetId)) throw new HttpError(404, "Ad account not found.");
  for (const c of creatives) {
    if (!pages.some((p) => p.externalId === c.pageId)) throw new HttpError(400, "That Facebook Page is not connected to this workspace.");
    if (c.instagramId && !instagram.some((p) => p.externalId === c.instagramId)) throw new HttpError(400, "That Instagram account is not connected to this workspace.");
    if (c.whatsappNumberId) {
      const phone = await prisma.phoneNumber.findFirst({ where: { id: c.whatsappNumberId, tenantId }, select: { id: true } });
      if (!phone) throw new HttpError(400, "That WhatsApp number does not belong to this workspace.");
    }
  }
}

/** The AdMedia a draft names must be in this workspace's library for the same ad account (readiness is checked at launch). */
async function assertDraftMedia(tenantId: string, accountAssetId: string, creatives: CreativeInput[]) {
  const ids = [...new Set(creatives.flatMap((c) => creativeMediaIds(c)))];
  if (!ids.length) return;
  const rows = await prisma.adMedia.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, adAccountAssetId: true } });
  const ok = new Set((rows ?? []).filter((r) => r.adAccountAssetId === accountAssetId).map((r) => r.id));
  if (ids.some((id) => !ok.has(id))) throw new HttpError(400, MEDIA_MISSING);
}

/** The audiences a draft names must be this workspace's own (readiness is checked at launch, when they are sent as Meta ids). */
async function assertDraftAudiences(tenantId: string, ids: string[]) {
  if (!ids.length) return;
  const rows = await prisma.adAudience.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, deletedAt: true } });
  const ok = new Set((rows ?? []).filter((r) => !r.deletedAt).map((r) => r.id));
  if (ids.some((id) => !ok.has(id))) throw new HttpError(400, AUDIENCE_UNKNOWN);
}

/** The scheduled post a draft promotes (sourcePostTargetId, a PostTarget row id) must be this workspace's own. */
async function assertDraftSource(tenantId: string, postTargetId: string | null) {
  if (!postTargetId) return;
  const row = await prisma.postTarget.findFirst({ where: { id: postTargetId, tenantId }, select: { id: true } });
  if (!row) throw new HttpError(400, SOURCE_POST_UNKNOWN);
}

/** One ad set of a draft: the whole campaign, or one compared version. */
type SetPlan = { name: string; variantKey: VariantKey | null; dailyBudgetMinor: number | null; lifetimeBudgetMinor: bigint | null; ads: number[] };
type DraftPlan = { sets: SetPlan[]; campaignDailyMinor: number; fairTest: boolean };

/**
 * The ad sets of a draft (3.8). A fair test is one ad set per version, each at the daily total divided by the number of
 * versions and rounded down to a whole major unit, so every version gets the same amount and the campaign's total (what a
 * person confirms) is the sum of the shares: ₹290 split 3 ways is ₹96 each, ₹288 a day. Otherwise one ad set holds every ad.
 */
function draftPlan(input: DraftInput, currency: string, minShareMinor: bigint): DraftPlan {
  if (input.compareMode === "fair_split" && input.ads.length > 1) {
    const split = splitDaily(BigInt(input.dailyBudgetMinor ?? 0), input.ads.length, currency);
    const min = minShareMinor > majorUnit(currency) ? minShareMinor : majorUnit(currency);
    if (split.shareMinor < min) throw new HttpError(400, `Each version needs at least ${formatMoney(min, currency)} a day. Raise the total or remove a version.`);
    return {
      sets: input.ads.map((ad, i) => ({ name: `Version ${ad.variantKey}`, variantKey: ad.variantKey, dailyBudgetMinor: Number(split.shareMinor), lifetimeBudgetMinor: null, ads: [i] })),
      campaignDailyMinor: Number(split.confirmedTotalMinor),
      fairTest: true,
    };
  }
  return {
    sets: [{ name: `${input.name} ad set`, variantKey: null, dailyBudgetMinor: input.dailyBudgetMinor, lifetimeBudgetMinor: lifetimeOf(input), ads: input.ads.map((_, i) => i) }],
    campaignDailyMinor: input.dailyBudgetMinor ?? 0,
    fairTest: false,
  };
}

/** Meta's minimum daily budget for the account, when the readiness check stored one (5.4 MetaAsset.meta.minDailyBudgetMinor). */
const minDailyOf = (meta: unknown): bigint => (isObj(meta) && typeof meta.minDailyBudgetMinor === "number" && Number.isSafeInteger(meta.minDailyBudgetMinor) && meta.minDailyBudgetMinor > 0 ? BigInt(meta.minDailyBudgetMinor) : 0n);

/**
 * The dates a draft is saved with. With a run length (3.1a) they are computed again in the ad account's own zone: the start
 * (now, or the chosen time) and the end on the start day plus runDays minus 1 at 23:59 local. Then D31 and, for the new
 * flows, the 90-day and start rules, in that zone.
 */
function draftDates(input: DraftInput, zone: string | null, now = new Date()): { startsAt: Date | null; endsAt: Date | null } {
  const tz = resolveTimeZone(zone);
  let { startsAt, endsAt } = input;
  if (input.runDays !== null) {
    const startMode: StartMode = input.startMode ?? (startsAt ? "at" : "now");
    if (startMode === "now") startsAt = null;
    endsAt = runDates({ runDays: input.runDays, startMode, startsAt, tz, now }).endsAt;
  }
  const problem = runProblem({ newFlow: isNewFlowSurface(input.surface), daily: input.dailyBudgetMinor !== null, startMode: input.startMode, startsAt, endsAt, runDays: input.runDays, now, tz });
  if (problem) throw new HttpError(400, problem);
  return { startsAt, endsAt };
}

/** Everything a draft needs before it is written: resolved creatives, the account's currency, the category checks, its ad sets. */
async function prepareDraft(actor: Actor, input: DraftInput) {
  const tenantId = actor.tenantId;
  if (input.specialAdCategory === "none" && !input.confirmNoSpecialCategory) {
    const suggested = await suggestedCategory(tenantId);
    if (suggested !== "none") throw new HttpError(400, `Your brand is flagged for the "${suggested}" special ad category. Declare it, or confirm explicitly that none applies.`);
  }
  const creatives = await Promise.all(input.ads.map((a) => resolveCreative(tenantId, a)));
  await assertOwnedRefs(tenantId, input.adAccountAssetId, creatives);
  await assertAdAccountAllowed(tenantId, input.adAccountAssetId);
  const currency = await liveAccountCurrency(tenantId, input.adAccountAssetId);
  const account = await adAccountOf(tenantId, input.adAccountAssetId);
  const dates = draftDates(input, zoneOfMeta(account?.meta));
  await assertDraftMedia(tenantId, input.adAccountAssetId, creatives);
  await assertDraftAudiences(tenantId, audienceIdsOf(input.targeting));
  await assertDraftSource(tenantId, input.sourcePostTargetId);
  let termsAcknowledged = false;
  if (input.specialAdCategory === "none") {
    const hits = await categoryTermHits(tenantId, [input.name, ...input.ads.flatMap((a, i) => [a.name, ...creativeCopy(creatives[i])])], input.ads.map((a) => a.creativeAssetId).filter((v): v is string => !!v));
    if (hits.length) {
      if (!input.acknowledgeSpecialCategoryTerms) {
        throw new HttpError(400, `Your ad copy, links or brand industry suggest the ${describeHits(hits)} special ad category, but you declared none. Choose the matching special ad category. If you have checked Meta's policy and it does not apply, confirm that explicitly (API field acknowledgeSpecialCategoryTerms).`);
      }
      termsAcknowledged = true;
    }
  }
  const { targeting, adjustments } = restrictForCategory(input.targeting, input.specialAdCategory);
  const plan = draftPlan(input, currency, minDailyOf(account?.meta));
  const adRows = input.ads.map((ad, i) => {
    const creative = creatives[i];
    const mediaIds = creativeMediaIds(creative);
    const post = sourcePostOf(creative);
    return {
      creativeAssetId: ad.creativeAssetId,
      name: ad.name,
      creative: json(termsAcknowledged ? { ...creative, categoryTermsAck: true } : creative),
      format: formatOf(input.template, creative),
      ...(mediaIds.length ? { mediaIds } : {}),
      ...(ad.variantKey ? { variantLabel: ad.variantKey } : {}),
      ...(post ? { sourcePostRef: post } : {}),
    };
  });
  return { currency, targeting, adjustments, adRows, plan, dates, objective: TEMPLATE_SPECS[input.template].objective };
}

const lifetimeOf = (input: DraftInput) => (input.lifetimeBudgetMinor === null ? null : BigInt(input.lifetimeBudgetMinor));

/** The 5.1 columns of a draft. runDays and startMode are null for an old-wizard draft. */
const draftColumns = (input: DraftInput) => ({
  goal: input.goal,
  sourceKind: input.sourceKind,
  sourceRef: input.sourceRef,
  sourcePostTargetId: input.sourcePostTargetId,
  placementMode: input.placementMode,
  runDays: input.runDays,
  startMode: input.startMode,
});

export async function createCampaignDraft(actor: Actor, input: DraftInput) {
  requireRole(actor, "admin");
  const tenantId = actor.tenantId;
  const { currency, targeting, adjustments, adRows, plan, dates, objective } = await prepareDraft(actor, input);

  // One transaction: a failure part-way (the 10th ad of an A/B test, say) leaves no campaign behind that would still hold the ad account.
  const campaign = await prisma.$transaction(async (tx) => {
    const created = await tx.adCampaign.create({
      data: {
        tenantId,
        adAccountAssetId: input.adAccountAssetId,
        name: input.name,
        template: input.template,
        objective,
        status: "draft",
        dailyBudgetMinor: plan.campaignDailyMinor,
        lifetimeBudgetMinor: lifetimeOf(input),
        currency,
        startsAt: dates.startsAt,
        endsAt: dates.endsAt,
        specialAdCategory: input.specialAdCategory,
        createdByUserId: actor.userId,
        origin: input.origin,
        assistantKey: input.assistantKey,
        surface: input.surface,
        ...draftColumns(input),
      },
    });
    for (const set of plan.sets) {
      const adSet = await tx.adSet.create({
        data: {
          tenantId,
          campaignId: created.id,
          name: set.name,
          targeting: json(targeting),
          dailyBudgetMinor: set.dailyBudgetMinor,
          lifetimeBudgetMinor: set.lifetimeBudgetMinor,
          ...(set.variantKey ? { variantKey: set.variantKey } : {}),
        },
      });
      for (const i of set.ads) await tx.ad.create({ data: { tenantId, adSetId: adSet.id, ...adRows[i] } });
    }
    // Compare versions (3.8): a fair test, decided later on cost per result.
    if (plan.fairTest) await tx.adTest.create({ data: { tenantId, campaignId: created.id, kind: "creative", mode: "fair_split", status: "draft" } });
    return created;
  });
  await audit({
    tenantId,
    userId: actor.userId,
    action: "ads.campaign.drafted",
    target: campaign.id,
    meta: { template: input.template, dailyBudgetMinor: plan.campaignDailyMinor, lifetimeBudgetMinor: input.lifetimeBudgetMinor, specialAdCategory: input.specialAdCategory, origin: input.origin, surface: input.surface, versions: plan.fairTest ? plan.sets.length : 1 },
  });
  return { campaignId: campaign.id, adjustments };
}

/** A draft can be edited until anything of it exists on Meta: a draft, or a failed first launch that created nothing. */
export function isEditableDraft(c: { status: string; metaCampaignId: string | null; adSets: { metaAdSetId: string | null; ads: { metaAdId: string | null; creative?: unknown }[] }[] }): boolean {
  if (c.status !== "draft" && c.status !== "error") return false;
  if (c.metaCampaignId) return false;
  return c.adSets.every((s) => !s.metaAdSetId && s.ads.every((a) => !a.metaAdId && !(a.creative as { metaCreativeId?: unknown } | null)?.metaCreativeId));
}

/**
 * The 409 for a claim on a draft that matched nothing: DRAFT_DISCARDED when the draft was discarded after it was loaded (the
 * claims filter on discardedAt, so a discard that lands mid-request always wins), `otherwise` for any other change.
 */
async function lostClaim(db: Pick<typeof prisma, "adCampaign">, tenantId: string, id: string, otherwise: string): Promise<HttpError> {
  const now = await db.adCampaign.findFirst({ where: { id, tenantId }, select: { discardedAt: true } }).catch(() => null);
  return new HttpError(409, now?.discardedAt ? DRAFT_DISCARDED : otherwise);
}

/**
 * PATCH of a draft: the same body as a new draft (a route body never sets origin; the stored one is kept), checked the same
 * way, then written over the draft in one transaction. Client approval links already sent for it stop working, because the
 * client would otherwise approve something that changed.
 */
export async function updateCampaignDraft(actor: Actor, id: string, body: Record<string, unknown>) {
  requireRole(actor, "admin");
  const tenantId = actor.tenantId;
  const current = await mustLoad(tenantId, id);
  if (current.discardedAt) throw new HttpError(409, DRAFT_DISCARDED);
  if (!isEditableDraft(current)) throw new HttpError(409, "Only a draft that is not on Meta yet can be edited. Change the budget or end date instead, or start a new campaign.");
  const origin: CampaignOrigin = current.origin === "assistant" || current.origin === "api" ? current.origin : "human";
  // A route body never sets origin or surface: the stored ones are kept.
  const input = parseDraftInput(body, { origin, assistantKey: current.assistantKey, surface: isDraftSurface(current.surface) ? current.surface : "wizard" });
  const { currency, targeting, adjustments, adRows: rows, plan, dates, objective } = await prepareDraft(actor, input);
  // An edited copy that fixes ads on Meta keeps saying which ones it replaces (5.4), so starting it still pauses them first.
  const replaces = [...new Set(current.adSets.flatMap((s) => s.ads.flatMap((a) => readReplacesAdIds(a.creative))))];
  const adRows = replaces.length ? rows.map((r) => ({ ...r, creative: json({ ...(r.creative as object), replacesAdIds: replaces }) })) : rows;
  await prisma.$transaction(async (tx) => {
    // Claimed in the same step: a draft that started launching, or was discarded, meanwhile is left alone.
    const claimed = await tx.adCampaign.updateMany({
      where: { id, tenantId, status: { in: ["draft", "error"] }, metaCampaignId: null, discardedAt: null },
      data: {
        adAccountAssetId: input.adAccountAssetId,
        name: input.name,
        template: input.template,
        objective,
        status: "draft",
        lastError: null,
        dailyBudgetMinor: plan.campaignDailyMinor,
        lifetimeBudgetMinor: lifetimeOf(input),
        currency,
        startsAt: dates.startsAt,
        endsAt: dates.endsAt,
        specialAdCategory: input.specialAdCategory,
        ...draftColumns(input),
      },
    });
    if (claimed.count !== 1) throw await lostClaim(tx, tenantId, id, DRAFT_CHANGED);
    // The existing ad sets are reused in order (the first keeps its id); extra ones go, missing ones are created.
    const extra = current.adSets.slice(plan.sets.length);
    if (extra.length) await tx.adSet.deleteMany({ where: { tenantId, campaignId: id, id: { in: extra.map((s) => s.id) } } });
    for (const [i, set] of plan.sets.entries()) {
      const old = current.adSets[i];
      const data = { name: set.name, targeting: json(targeting), dailyBudgetMinor: set.dailyBudgetMinor, lifetimeBudgetMinor: set.lifetimeBudgetMinor };
      let adSetId: string;
      if (old) {
        await tx.adSet.updateMany({ where: { id: old.id, tenantId }, data: { ...data, variantKey: set.variantKey } });
        await tx.ad.deleteMany({ where: { tenantId, adSetId: old.id } });
        adSetId = old.id;
      } else {
        adSetId = (await tx.adSet.create({ data: { tenantId, campaignId: id, ...data, ...(set.variantKey ? { variantKey: set.variantKey } : {}) } })).id;
      }
      for (const j of set.ads) await tx.ad.create({ data: { tenantId, adSetId, ...adRows[j] } });
    }
    if (current.adTest && !plan.fairTest) await tx.adTest.deleteMany({ where: { tenantId, campaignId: id } });
    if (plan.fairTest && !current.adTest) await tx.adTest.create({ data: { tenantId, campaignId: id, kind: "creative", mode: "fair_split", status: "draft" } });
  });
  await expireDecidedApprovals(tenantId, "ad_campaign", id, actor.userId).catch(() => console.error("[ads] could not expire the client approvals of an edited draft"));
  await audit({ tenantId, userId: actor.userId, action: "ads.campaign.draft_updated", target: id, meta: { template: input.template, dailyBudgetMinor: plan.campaignDailyMinor, specialAdCategory: input.specialAdCategory } });
  return { campaignId: id, adjustments };
}

/**
 * Discards a draft that is not on Meta yet, of any surface (4.8 discard_promotion_draft; the old wizard's drafts too). Soft:
 * the rows stay with discardedAt set, the draft drops out of the campaign list, and restoreDraft brings it back within 15
 * minutes. Retention removes it after 30 days (5.5). Discarding twice changes nothing.
 */
export async function discardDraft(actor: Actor, id: string, now = new Date()) {
  requireRole(actor, "admin");
  const tenantId = actor.tenantId;
  const c = await mustLoad(tenantId, id);
  const answer = (at: Date) => ({ campaignId: id, discardedAt: at, restorableUntil: new Date(at.getTime() + DRAFT_RESTORE_MS) });
  if (c.discardedAt) return answer(c.discardedAt);
  if (!isEditableDraft(c)) throw new HttpError(409, "Only a draft that isn't on Meta yet can be discarded. Pause or archive this campaign instead.");
  // Claimed in one step: a draft that started launching meanwhile is left alone.
  const done = await prisma.adCampaign.updateMany({ where: { id, tenantId, status: { in: ["draft", "error"] }, metaCampaignId: null, discardedAt: null }, data: { discardedAt: now } });
  if (done.count !== 1) throw new HttpError(409, DRAFT_CHANGED);
  await audit({ tenantId, userId: actor.userId, action: "ads.campaign.draft_discarded", target: id, meta: { surface: c.surface ?? "wizard" } });
  return answer(now);
}

/** Brings back a draft discarded less than 15 minutes ago (the undo of discardDraft). After that it stays discarded. */
export async function restoreDraft(actor: Actor, id: string, now = new Date()) {
  requireRole(actor, "admin");
  const tenantId = actor.tenantId;
  const c = await mustLoad(tenantId, id);
  if (!c.discardedAt) return { campaignId: id, restored: false };
  if (now.getTime() - c.discardedAt.getTime() > DRAFT_RESTORE_MS) throw new HttpError(409, "This draft was discarded more than 15 minutes ago, so it can't be brought back. Make a new one instead.");
  // A discarded draft does not hold its ad account against the plan (billing/limits usedAdAccountIds): coming back, it does
  // again, so the plan is asked first (402 when another account has taken the last place meanwhile).
  await assertAdAccountAllowed(tenantId, c.adAccountAssetId);
  const done = await prisma.adCampaign.updateMany({ where: { id, tenantId, discardedAt: c.discardedAt }, data: { discardedAt: null } });
  if (done.count !== 1) throw new HttpError(409, DRAFT_CHANGED);
  await audit({ tenantId, userId: actor.userId, action: "ads.campaign.draft_restored", target: id });
  return { campaignId: id, restored: true };
}

/** Stored creative fields that belong to the original only: its Meta creative, Meta's review, an acknowledgement, what it replaced. */
const NOT_COPIED = new Set(["metaCreativeId", "metaReview", "categoryTermsAck", "replacesAdIds"]);

function copyCreative(raw: unknown, replaces: string[] | null): Record<string, unknown> {
  const out = Object.fromEntries(Object.entries(isObj(raw) ? raw : {}).filter(([k]) => !NOT_COPIED.has(k)));
  if (replaces?.length) out.replacesAdIds = parseReplacesAdIds(replaces);
  return out;
}

/**
 * fixOf: true (every ad on Meta), one ad id, or a list of them. Each must be an ad of this campaign that is on Meta. `named`
 * says the caller picked the ads, so only those are copied.
 */
function fixedAds(raw: unknown, ads: { id: string; metaAdId: string | null }[]): { ids: Set<string>; named: boolean } | null {
  if (raw === undefined || raw === null || raw === false) return null;
  if (raw === true) {
    const onMeta = ads.filter((a) => a.metaAdId).map((a) => a.id);
    if (!onMeta.length) throw new HttpError(409, FIX_NEEDS_META);
    return { ids: new Set(onMeta), named: false };
  }
  const ids = parseReplacesAdIds(typeof raw === "string" ? [raw] : raw);
  for (const adId of ids) {
    const ad = ads.find((a) => a.id === adId);
    if (!ad) throw new HttpError(400, "That ad isn't part of this campaign.");
    if (!ad.metaAdId) throw new HttpError(409, FIX_NEEDS_META);
  }
  return { ids: new Set(ids), named: true };
}

/**
 * The copy's dates: the same run length from today (3.1a). A run with runDays starts now (or at its chosen time, if that is
 * still ahead) and ends on day runDays at 23:59 in the account zone. Without runDays, dates still ahead are kept; a run that
 * is over or nearly over runs as long as the original did, from now, so a copy never loses its end date.
 */
function copyDates(c: FullCampaign, now: Date, tz: string): { startsAt: Date | null; endsAt: Date | null; runDays: number | null; startMode: StartMode | null } {
  const ahead = (d: Date | null) => (d && d.getTime() > now.getTime() ? d : null);
  const startMode = (c.startMode === "now" || c.startMode === "at" ? c.startMode : null) as StartMode | null;
  if (c.runDays !== null && c.runDays >= MIN_RUN_DAYS && c.runDays <= MAX_RUN_DAYS) {
    const at = startMode === "at" ? ahead(c.startsAt) : null;
    const mode: StartMode = at ? "at" : "now";
    return { startsAt: at, endsAt: runDates({ runDays: c.runDays, startMode: mode, startsAt: at, tz, now }).endsAt, runDays: c.runDays, startMode: mode };
  }
  const startsAt = ahead(c.startsAt);
  const mode = startMode === "at" && !startsAt ? "now" : startMode;
  if (!c.endsAt) return { startsAt, endsAt: null, runDays: null, startMode: mode };
  if (c.endsAt.getTime() - Math.max(startsAt?.getTime() ?? now.getTime(), now.getTime()) > DAY_MS) return { startsAt, endsAt: c.endsAt, runDays: null, startMode: mode };
  const from = (c.startsAt ?? c.launchedAt ?? c.createdAt).getTime();
  const days = Math.min(MAX_RUN_DAYS, Math.max(MIN_RUN_DAYS, Math.round((c.endsAt.getTime() - from) / DAY_MS)));
  return { startsAt: null, endsAt: runDates({ runDays: days, startMode: "now", tz, now }).endsAt, runDays: null, startMode: mode === "at" ? "now" : mode };
}

export type DuplicateOptions = {
  /**
   * [Fix the ad] (D29, 3.9): true for every ad on Meta, or the ids of the ads being fixed. Each copy of such an ad records
   * replacesAdIds, so starting the copy pauses the original first and the two never hold room in the limits together. Named
   * ads are copied alone (with their ad sets); true copies the whole campaign.
   */
  fixOf?: unknown;
  now?: Date;
};

/**
 * [Make a copy] (3.9, D25, D29): a new local draft "Copy of …" with the campaign's ad sets and ads, in the same flow. Nothing
 * is sent to Meta: no object is created or copied there, and Meta's own copy edge is never used (it can start ads outside the
 * Spend Book). The copy has no Meta ids, no review and no acknowledgement of its own; it is a person's draft, edited and
 * started like any other. Archived ads are left out unless every ad is archived.
 * [Fix the ad] on chosen ads copies only those ads and the ad sets they are in: the healthy ads keep running in the original,
 * and a second copy of them would hold room in the limits twice and bid against them in the auction. A fair test is kept
 * only while the copy still compares more than one version. The answer's replacesAdIds names only ads that were copied.
 */
export async function duplicateCampaign(actor: Actor, id: string, opts: DuplicateOptions = {}) {
  requireRole(actor, "admin");
  const tenantId = actor.tenantId;
  const now = opts.now ?? new Date();
  const c = await mustLoad(tenantId, id);
  if (c.discardedAt) throw new HttpError(409, DRAFT_DISCARDED);
  if (c.status === "launching") throw new HttpError(409, "This campaign is being set up on Meta. Try again in a minute.");
  const all = c.adSets.flatMap((s) => s.ads);
  const fix = fixedAds(opts.fixOf, all);
  const keepArchived = all.every((a) => a.status === "archived");
  const copyable = (a: { status: string }) => keepArchived || a.status !== "archived";
  if (fix?.named && all.some((a) => fix.ids.has(a.id) && !copyable(a))) throw new HttpError(409, FIX_ARCHIVED);
  const sets = c.adSets.map((s) => ({ set: s, ads: s.ads.filter((a) => copyable(a) && (!fix?.named || fix.ids.has(a.id))) })).filter((x) => x.ads.length > 0);
  const replaced = sets.flatMap((x) => x.ads.filter((a) => fix?.ids.has(a.id)).map((a) => a.id));
  if (fix && !replaced.length) throw new HttpError(409, FIX_ARCHIVED);
  await assertAdAccountAllowed(tenantId, c.adAccountAssetId);
  const dates = copyDates(c, now, resolveTimeZone(await accountZone(tenantId, c.adAccountAssetId)));
  // With ad sets left out, the copy's daily total is that of the ad sets it keeps, as a new draft's is (each has its own budget).
  const ownBudgets = sets.every((x) => x.set.dailyBudgetMinor !== null || lifetimeOnly(x.set));
  const dailyBudgetMinor = sets.length < c.adSets.length && ownBudgets ? sets.reduce((sum, x) => sum + (x.set.dailyBudgetMinor ?? 0), 0) : c.dailyBudgetMinor;
  const name = `Copy of ${c.name}`.slice(0, 120);
  const copy = await prisma.$transaction(async (tx) => {
    const created = await tx.adCampaign.create({
      data: {
        tenantId,
        adAccountAssetId: c.adAccountAssetId,
        name,
        template: c.template,
        objective: c.objective,
        status: "draft",
        dailyBudgetMinor,
        lifetimeBudgetMinor: c.lifetimeBudgetMinor ?? null,
        currency: c.currency,
        startsAt: dates.startsAt,
        endsAt: dates.endsAt,
        specialAdCategory: c.specialAdCategory,
        createdByUserId: actor.userId,
        origin: "human",
        assistantKey: null,
        targetCostPerResultMinor: c.targetCostPerResultMinor ?? null,
        goal: c.goal ?? null,
        surface: c.surface ?? "wizard",
        sourceKind: c.sourceKind ?? null,
        sourceRef: c.sourceRef ?? null,
        sourcePostTargetId: c.sourcePostTargetId ?? null,
        placementMode: c.placementMode ?? "auto",
        runDays: dates.runDays,
        startMode: dates.startMode,
      },
    });
    for (const { set, ads } of sets) {
      const copied = await tx.adSet.create({
        data: {
          tenantId,
          campaignId: created.id,
          name: set.name,
          targeting: json(set.targeting),
          dailyBudgetMinor: set.dailyBudgetMinor,
          lifetimeBudgetMinor: set.lifetimeBudgetMinor ?? null,
          ...(set.variantKey ? { variantKey: set.variantKey } : {}),
          ...(set.audienceId ? { audienceId: set.audienceId } : {}),
          ...(set.optimizationGoal ? { optimizationGoal: set.optimizationGoal } : {}),
          ...(set.destinationType ? { destinationType: set.destinationType } : {}),
          ...(set.bidStrategy ? { bidStrategy: set.bidStrategy, bidAmountMinor: set.bidAmountMinor ?? null } : {}),
          ...(set.schedule ? { schedule: json(set.schedule) } : {}),
        },
      });
      for (const ad of ads) {
        await tx.ad.create({
          data: {
            tenantId,
            adSetId: copied.id,
            name: ad.name,
            creativeAssetId: ad.creativeAssetId,
            creative: json(copyCreative(ad.creative, fix?.ids.has(ad.id) ? [ad.id] : null)),
            format: ad.format ?? formatOf(c.template, ad.creative),
            ...(ad.mediaIds?.length ? { mediaIds: ad.mediaIds } : {}),
            ...(ad.variantLabel ? { variantLabel: ad.variantLabel } : {}),
            ...(ad.sourcePostRef ? { sourcePostRef: ad.sourcePostRef } : {}),
          },
        });
      }
    }
    if (c.adTest?.mode === "fair_split" && sets.filter((x) => x.set.variantKey).length > 1) {
      await tx.adTest.create({ data: { tenantId, campaignId: created.id, kind: c.adTest.kind, mode: "fair_split", status: "draft" } });
    }
    return created;
  });
  await audit({ tenantId, userId: actor.userId, action: "ads.campaign.duplicated", target: copy.id, meta: { from: id, fix: fix !== null, replaced: replaced.length } });
  return { campaignId: copy.id, replacesAdIds: replaced };
}

type FullCampaign = NonNullable<Awaited<ReturnType<typeof loadCampaign>>>;

async function loadCampaign(tenantId: string, id: string) {
  return prisma.adCampaign.findFirst({ where: { id, tenantId }, include: { adSets: { include: { ads: true }, orderBy: { createdAt: "asc" } }, adTest: true } });
}

async function mustLoad(tenantId: string, id: string): Promise<FullCampaign> {
  const c = await loadCampaign(tenantId, id);
  if (!c) throw new HttpError(404, "Campaign not found.");
  return c;
}

const lifetimeOnly = (s: FullCampaign["adSets"][number]) => s.dailyBudgetMinor === null && s.lifetimeBudgetMinor !== null && s.lifetimeBudgetMinor !== undefined;

/** The sum of the daily budgets of the campaign's ad sets (an ad set with only a lifetime budget adds nothing). */
export const totalDailyBudget = (c: FullCampaign) => c.adSets.reduce((sum, s) => sum + (lifetimeOnly(s) ? 0 : (s.dailyBudgetMinor ?? c.dailyBudgetMinor)), 0);

/** The amount a person confirms to turn the campaign on: its daily budgets, plus the lifetime budgets of lifetime-only ad sets. */
export const confirmAmount = (c: FullCampaign) => totalDailyBudget(c) + c.adSets.reduce((sum, s) => sum + (lifetimeOnly(s) ? Number(s.lifetimeBudgetMinor) : 0), 0);

/**
 * The campaign's own worst case from `now` (docs/SPEND-CONTROLS-SPEC.md 4.5): today (1.75x each daily budget, or a lifetime
 * remainder) and to its end date or the end of the account month, whichever is first. Nothing spent yet.
 */
export function campaignWorstCase(c: FullCampaign, now: Date, timeZone: string): { day: bigint; month: bigint } {
  let day = 0n;
  let month = 0n;
  for (const s of c.adSets) {
    const lifetime = s.lifetimeBudgetMinor === null || s.lifetimeBudgetMinor === undefined ? null : BigInt(s.lifetimeBudgetMinor);
    const daily = lifetimeOnly(s) ? null : BigInt(s.dailyBudgetMinor ?? c.dailyBudgetMinor);
    const math = { dailyBudgetMinor: daily, lifetimeBudgetMinor: lifetime, peakToday: daily ?? 0n, weekPeak: daily ?? 0n, endsAt: c.endsAt };
    day += dayRisk(math, NO_SPEND, now);
    month += remainingMonth(math, now, timeZone, NO_SPEND);
  }
  return { day, month };
}

async function whatsappPhone(tenantId: string, id?: string) {
  if (!id) return undefined;
  return (await prisma.phoneNumber.findFirst({ where: { id, tenantId }, select: { displayPhone: true } }))?.displayPhone;
}

const hasTermsAck = (c: FullCampaign) => c.adSets.some((s) => s.ads.some((a) => (a.creative as { categoryTermsAck?: unknown } | null)?.categoryTermsAck === true));

/** Hits for a category-none campaign that has no acknowledgement on record. Empty when acknowledged or nothing was detected. */
async function unacknowledgedTermHits(c: FullCampaign) {
  if (hasTermsAck(c)) return [];
  const copy = [c.name, ...c.adSets.flatMap((s) => s.ads.flatMap((a) => [a.name, ...creativeCopy((a.creative ?? {}) as Partial<CreativeInput>)]))];
  const ids = c.adSets.flatMap((s) => s.ads.map((a) => a.creativeAssetId)).filter((v): v is string => !!v);
  return categoryTermHits(c.tenantId, copy, ids);
}

// ===== Ad media and audiences at launch (5.4, 6.1 rule 1) =====

type MediaRow = {
  id: string;
  adAccountAssetId: string;
  kind: string;
  mime: string;
  bytes: bigint | number;
  width: number | null;
  height: number | null;
  rotation: number | null;
  durationMs: number | null;
  videoCodec: string | null;
  status: string;
  metaImageHash: string | null;
  metaVideoId: string | null;
  metaThumbHash: string | null;
};
type MediaMap = ReadonlyMap<string, MediaRow>;
/** The AdMedia states that end in ready on their own (the media pipeline is still sending or Meta is still processing). */
const MEDIA_WAITING: ReadonlySet<string> = new Set(["pending", "uploading", "processing"]);

const creativeOf = (ad: { creative: unknown }) => (ad.creative ?? {}) as unknown as CreativeInput & { metaCreativeId?: string };
/** The ads whose creative is still to be created on Meta: their media is what launch sends. */
const adsToCreate = (c: FullCampaign) => c.adSets.flatMap((s) => s.ads.filter((a) => !a.metaAdId && !creativeOf(a).metaCreativeId));

/** The AdMedia rows the creatives still to create name, of this workspace and this ad account only. */
async function loadMedia(c: FullCampaign): Promise<Map<string, MediaRow>> {
  const ids = [...new Set(adsToCreate(c).flatMap((a) => creativeMediaIds(a.creative)))];
  if (!ids.length) return new Map();
  const rows = (await prisma.adMedia.findMany({
    where: { tenantId: c.tenantId, id: { in: ids } },
    select: { id: true, adAccountAssetId: true, kind: true, mime: true, bytes: true, width: true, height: true, rotation: true, durationMs: true, videoCodec: true, status: true, metaImageHash: true, metaVideoId: true, metaThumbHash: true },
  })) as MediaRow[];
  return new Map((rows ?? []).filter((r) => r.adAccountAssetId === c.adAccountAssetId).map((r) => [r.id, r]));
}

/** 409 media_not_ready while a picture or video is still on its way to Meta: nothing is created until every one is ready. */
function assertMediaReady(media: MediaMap) {
  const waiting = [...media.values()].filter((r) => MEDIA_WAITING.has(r.status));
  if (waiting.length) throw new AdsMediaNotReadyError(waiting.map((r) => r.id), waiting.some((r) => r.kind === "video") ? "video" : "image");
}

/**
 * AdAudience id to Meta audience id for the campaign's ad sets (5.4): only this workspace's ready audiences of the same ad
 * account that Meta knows, of a kind the flags offer now (promote/audiences audienceKindOffered: a customer list only with
 * PROMOTE_AUDIENCES=all, and in production only with LEGAL_DPDP_AUDIENCES_OK=1). An audience not in the map is refused by
 * validation (AUDIENCE_NOT_READY) and by the builder.
 */
async function loadAudiences(c: FullCampaign): Promise<Record<string, string>> {
  const ids = [...new Set(c.adSets.flatMap((s) => audienceIdsOf(parseTargeting(s.targeting))))];
  if (!ids.length) return {};
  const rows = await prisma.adAudience.findMany({ where: { tenantId: c.tenantId, id: { in: ids } }, select: { id: true, adAccountAssetId: true, kind: true, status: true, metaAudienceId: true, deletedAt: true } });
  // Loaded here, only when an ad set names audiences, so this module's own import graph stays as it was.
  const { audienceKindOffered } = await import("@/lib/promote/audiences");
  const map: Record<string, string> = {};
  for (const r of rows ?? []) {
    if (r.status === "ready" && !r.deletedAt && r.metaAudienceId && r.kind !== "saved" && r.adAccountAssetId === c.adAccountAssetId && audienceKindOffered(r.kind)) map[r.id] = r.metaAudienceId;
  }
  return map;
}

/** The ad set's tall positions, for checking a tall (9:16) asset; Automatic counts every tall position. */
function tallPositions(placements: readonly PlacementKey[]): PlacementKey[] {
  const tall = placements.filter((p) => groupOfPlacement(p) !== "feed");
  return tall.length ? tall : ["instagram_stories", "instagram_reels", "facebook_stories", "facebook_reels"];
}

/** What stops a creative's library media, in plain copy: missing, not ready, refused by Meta, or the wrong shape for where it shows (4.6). */
function mediaProblems(creative: CreativeInput, placements: readonly PlacementKey[], format: AdFormat, media: MediaMap): string[] {
  const out: string[] = [];
  const cards = new Set((creative.cards ?? []).map((k) => k.mediaId));
  for (const id of creativeMediaIds(creative)) {
    const row = media.get(id);
    if (!row) {
      out.push(MEDIA_MISSING);
      continue;
    }
    if (MEDIA_WAITING.has(row.status)) {
      out.push(row.kind === "video" ? promoteText("error.media_not_ready") : PICTURE_NOT_READY);
      continue;
    }
    if (row.status !== "ready") {
      out.push(MEDIA_UNUSABLE);
      continue;
    }
    const probe: MediaProbe = { kind: row.kind === "video" ? "video" : "image", mime: row.mime, bytes: Number(row.bytes), width: row.width, height: row.height, rotation: row.rotation, durationMs: row.durationMs, videoCodec: row.videoCodec };
    const where = creative.media?.vertical === id ? tallPositions(placements) : placements;
    for (const p of checkMedia(probe, where, { format: cards.has(id) ? "carousel" : format }).problems) if (p.severity === "block") out.push(p.text.en);
  }
  return [...new Set(out)];
}

type ResolvedMedia = { media: ShapeMedia; cards: ShapeCard[] };

/**
 * The Meta ids a creative's library media resolve to (5.4): image hashes, video ids and video thumbnail hashes. AdMedia ids
 * are never sent. Null when the creative names no library media (it keeps its own image hash or picture link).
 */
function resolveMedia(creative: CreativeInput, media: MediaMap): ResolvedMedia | null {
  const slots = creative.media ?? {};
  if (!creativeMediaIds(creative).length) return null;
  const ready = (id: string | undefined) => {
    const r = id ? media.get(id) : undefined;
    return r && r.status === "ready" ? r : undefined;
  };
  const out: ShapeMedia = {};
  for (const id of [slots.video, slots.feed, slots.square]) {
    const r = ready(id);
    if (!r) continue;
    if (r.kind === "video") {
      out.videoId ??= r.metaVideoId;
      out.thumbHash ??= r.metaThumbHash;
    } else out.imageHash ??= r.metaImageHash;
  }
  const tall = ready(slots.vertical);
  if (tall?.kind === "video") {
    out.verticalVideoId = tall.metaVideoId;
    out.verticalThumbHash = tall.metaThumbHash;
  } else if (tall) out.verticalImageHash = tall.metaImageHash;
  out.imageHash ??= creative.imageHash ?? null;
  const cards = (creative.cards ?? []).map((k) => {
    const r = ready(k.mediaId);
    return {
      imageHash: r?.kind === "image" ? r.metaImageHash : null,
      videoId: r?.kind === "video" ? r.metaVideoId : null,
      thumbHash: r?.kind === "video" ? r.metaThumbHash : null,
      headline: k.headline ?? "",
      description: k.description ?? null,
      link: k.link ?? null,
    };
  });
  return { media: out, cards };
}

export type ValidateOptions = {
  /** The launch request carries the explicit acknowledgement of special category terms. */
  assumeTermsAcknowledged?: boolean;
  /** Already loaded by the caller (launch); loaded here otherwise. */
  media?: MediaMap;
  audiences?: Record<string, string>;
  /** The ad account's IANA zone; read here otherwise. */
  timeZone?: string | null;
  now?: Date;
};

/**
 * Local validation only: targeting and placements (4.5), creative fields, the format checks of 4.6 (Instagram's 2,200
 * characters and 30 hashtags, media shapes per placement, carousels of 2 to 10 cards), an Instagram account for Instagram
 * positions, library media that is ready, audiences that are ready, the run (D31, 6.1 rule 3), currency and cap. Returns
 * messages; empty means ready.
 */
export async function validateCampaign(c: FullCampaign, opts: ValidateOptions = {}): Promise<string[]> {
  const errors: string[] = [];
  const template = c.template as AdTemplate;
  const category = (isCategory(c.specialAdCategory) ? c.specialAdCategory : "none") as SpecialAdCategory;
  const newFlow = isNewFlowCampaign(c);
  // The old routes build the four old templates only (train P1 stays dark); the new flows and Eddy build every goal of 4.4.
  if (!(newFlow ? isAnyTemplate(template) : isTemplate(template))) return ["Unknown template."];
  const goalChecks = newFlow || !!c.goal;
  const now = opts.now ?? new Date();
  if (c.adSets.length === 0 || c.adSets.every((s) => s.ads.length === 0)) errors.push("The campaign needs at least one ad.");
  const media = opts.media ?? (await loadMedia(c));
  const audiences = opts.audiences ?? (await loadAudiences(c));
  for (const s of c.adSets) {
    const targeting = parseTargeting(s.targeting);
    const placements = targeting.placements as readonly PlacementKey[];
    const creatives = s.ads.map(creativeOf);
    const hasInstagramIdentity = creatives.length > 0 && creatives.every((cr) => !!cr.instagramId);
    const formats = [...new Set(s.ads.map((a) => formatOf(template, a.creative)))];
    for (const format of formats.length ? formats : [formatOf(template, null)]) {
      if (goalChecks) {
        // The new flows: the goal's placement rules, its promoted object (a pixel) and its special-category rule too.
        errors.push(
          ...adSetProblems({
            name: s.name,
            metaCampaignId: "check",
            template,
            targeting,
            specialAdCategory: category,
            dailyBudgetMinor: s.dailyBudgetMinor ?? c.dailyBudgetMinor,
            lifetimeBudgetMinor: lifetimeOnly(s) ? Number(s.lifetimeBudgetMinor) : null,
            pageId: creatives[0]?.pageId ?? "",
            endsAt: c.endsAt,
            audienceMetaIds: audiences,
            format,
            hasInstagramIdentity,
          }),
        );
      } else {
        errors.push(...validateTargeting(targeting, category, { format, hasInstagramIdentity, audienceMetaIds: audiences }).errors);
      }
    }
    for (const ad of s.ads) {
      const creative = creativeOf(ad);
      errors.push(...creativeProblems(template, creative).map((m) => `${ad.name}: ${m}`));
      if (creative.metaCreativeId || ad.metaAdId) continue;
      const format = formatOf(template, creative);
      const text = checkText({ primary: creative.message ?? "", headline: creative.headline, description: creative.description }, placements, { hasInstagramIdentity: !!creative.instagramId, format });
      errors.push(...text.problems.map((p) => `${ad.name}: ${p.text.en}`));
      if (format === "carousel") {
        const cards = carouselProblem((creative.cards ?? []).length);
        if (cards) errors.push(`${ad.name}: ${cards.text.en}`);
      }
      errors.push(...mediaProblems(creative, placements, format, media).map((m) => `${ad.name}: ${m}`));
      // A library picture deleted after the draft was saved is caught here, before anything is created on Meta.
      if (creative?.mediaKey) {
        try {
          await mediaImageUrl(c.tenantId, creative.mediaKey);
        } catch (e) {
          errors.push(`${ad.name}: ${e instanceof HttpError ? e.message : "The picture could not be read."}`);
        }
      }
    }
  }
  // The run (6.1 rule 3, D31): checked while an ad set is still to be created, since Meta checks the dates when it is.
  if (newFlow && !c.endsAt) errors.push(END_REQUIRED);
  if (c.adSets.some((s) => !s.metaAdSetId)) {
    const tz = resolveTimeZone(opts.timeZone !== undefined ? opts.timeZone : newFlow ? await accountZone(c.tenantId, c.adAccountAssetId) : null);
    const startMode = c.startMode === "now" || c.startMode === "at" ? c.startMode : null;
    const run = runProblem({ newFlow, daily: c.adSets.some((s) => !lifetimeOnly(s)), startMode, startsAt: c.startsAt, endsAt: c.endsAt, runDays: c.runDays ?? null, now, tz });
    if (run) errors.push(run);
  }
  try {
    await assertCampaignCurrencyMatchesAccount(c);
    const total = totalDailyBudget(c);
    if (total > 0) await assertWithinCap(c.tenantId, total, c.currency);
    else await assertCapApplies(c.tenantId, c.currency);
  } catch (e) {
    errors.push(e instanceof HttpError ? e.message : "Could not check the budget cap.");
  }
  if (c.origin === "assistant" && !c.endsAt) errors.push(spendCopy("spend.end_date_required"));
  if (category === "none" && !opts.assumeTermsAcknowledged) {
    const hits = await unacknowledgedTermHits(c);
    if (hits.length) errors.push(`The copy, links or brand industry suggest the ${describeHits(hits)} special ad category but none is declared. Create the campaign again with the right category, or acknowledge the terms when launching.`);
  }
  return [...new Set(errors)];
}

/** A body for the preview, or an empty one when it cannot be built yet (validation lists why). */
function previewBody(build: () => Record<string, unknown>): Record<string, unknown> {
  try {
    return build();
  } catch (e) {
    if (e instanceof RangeError) return {};
    throw e;
  }
}

export async function previewCampaign(actor: Actor, id: string) {
  const c = await mustLoad(actor.tenantId, id);
  const template = c.template as AdTemplate;
  const category = c.specialAdCategory as SpecialAdCategory;
  const set = c.adSets[0];
  const targeting = parseTargeting(set?.targeting);
  const first = (set?.ads[0]?.creative ?? {}) as unknown as CreativeInput;
  const phone = await whatsappPhone(actor.tenantId, first.whatsappNumberId);
  const [media, audiences, zone] = await Promise.all([loadMedia(c), loadAudiences(c), accountZone(actor.tenantId, c.adAccountAssetId)]);
  const payload: PayloadPreview = {
    campaign: previewBody(() => buildCampaign({ name: c.name, template, specialAdCategory: category, targeting: c.adSets.map((s) => parseTargeting(s.targeting)) })),
    // The same bodies launchCampaign sends, with the account's time zone and the audiences and media resolved to Meta ids.
    adSet: previewBody(() =>
      buildAdSet({ name: set?.name ?? c.name, metaCampaignId: "<new campaign id>", template, targeting, specialAdCategory: category, dailyBudgetMinor: set?.dailyBudgetMinor ?? c.dailyBudgetMinor, lifetimeBudgetMinor: set && lifetimeOnly(set) ? Number(set.lifetimeBudgetMinor) : null, pageId: first.pageId, whatsappDisplayPhone: phone, startsAt: c.startsAt, endsAt: c.endsAt, timeZone: zone, audienceMetaIds: audiences }),
    ),
    ads: (set?.ads ?? []).map((ad) => {
      const creative = creativeOf(ad);
      const resolved = resolveMedia(creative, media);
      return { name: ad.name, creative: previewBody(() => buildCreative({ name: ad.name, template, creative, whatsappDisplayPhone: phone, ...(resolved ?? {}), positions: targeting.placements })) };
    }),
  };
  const caps = await getCaps(actor.tenantId);
  return { campaignId: c.id, status: c.status, payload, totalDailyBudgetMinor: totalDailyBudget(c), currency: c.currency, caps, errors: await validateCampaign(c, { media, audiences, timeZone: zone }), startsInPausedState: true };
}

const failure = (e: unknown) => sanitizeMessage(e instanceof Error ? e.message : "Meta request failed.");

/** True when a Graph POST may have reached Meta although it reported a failure (timeout, reset, 5xx): GraphError.ambiguous. */
const isAmbiguous = (e: unknown) => !!e && typeof e === "object" && (e as { ambiguous?: unknown }).ambiguous === true;

async function recordError(c: FullCampaign, actor: Actor, step: string, e: unknown) {
  const message = `${step}: ${failure(e)}`;
  await prisma.adCampaign.updateMany({ where: { id: c.id, tenantId: c.tenantId }, data: { status: "error", lastError: message } });
  await audit({ tenantId: c.tenantId, userId: actor.userId, action: "ads.campaign.error", target: c.id, meta: { step } });
  return new HttpError(502, `${message}. Objects already created on Meta were saved; launch again to continue.`);
}

/**
 * After a failed or interrupted attempt a campaign may already exist on Meta without its id saved. Adopt the NEWEST paused one that has
 * our exact name, was created since the draft (a missing created_time is not good enough) and is not already stored on any campaign
 * row, so a same-named sibling campaign is never taken over.
 */
async function findOrphanCampaign(client: ReturnType<typeof adsClient>, c: FullCampaign, beat: () => Promise<void>): Promise<string | null> {
  const found = await client.findCampaignsByName(c.name, beat);
  const earliest = c.createdAt.getTime() - CLOCK_SKEW_MS;
  const candidates = found
    .filter((f) => f.name === c.name && f.status.toUpperCase() === "PAUSED" && f.createdAt !== null && f.createdAt.getTime() >= earliest)
    .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime());
  if (!candidates.length) return null;
  // Meta ids are global and only the id column is read, as an exclusion set: another workspace sharing the ad account must not be adopted either.
  const taken = await prisma.adCampaign.findMany({ where: { metaCampaignId: { in: candidates.map((f) => f.id) } }, select: { metaCampaignId: true } });
  const linked = new Set((taken ?? []).map((r) => r.metaCampaignId));
  return candidates.find((f) => !linked.has(f.id))?.id ?? null;
}

async function persistTermsAck(c: FullCampaign) {
  for (const set of c.adSets) {
    for (const ad of set.ads) await prisma.ad.updateMany({ where: { id: ad.id, tenantId: c.tenantId }, data: { creative: json({ ...((ad.creative ?? {}) as object), categoryTermsAck: true }) } });
  }
}

export type LaunchOptions = {
  acknowledgeSpecialCategoryTerms?: boolean;
  /** Who the Spend Book records as acting; the signed-in person by default. */
  spendActor?: SpendActor;
};

/** The guarded ads client for the campaign's ad account (docs/SPEND-CONTROLS-SPEC.md 4.8). */
async function guardedClient(tenantId: string, adAccountAssetId: string, actor: SpendActor): Promise<{ client: AdsClient; externalId: string }> {
  const access = await getAssetAccess(tenantId, adAccountAssetId);
  if (access.type !== "ad_account") throw new HttpError(409, "The selected asset is not an ad account.");
  const sandbox = await sandboxFlagFor(tenantId, adAccountAssetId);
  return { client: adsClient(access.token, access.externalId, { tenantId, adAccountAssetId, actor, sandbox }), externalId: access.externalId };
}

/**
 * Early refusal before anything is created (a dry run of the book's checks, no reservation): when the campaign on its own could
 * never fit the workspace's ads limits at Meta's worst case, say so now with the same copy activation would give. Whether it
 * fits next to the other running campaigns is decided when it is turned on. With SPEND_ENFORCE=observe these new checks
 * do not block a person (I12): today's cap check in validateCampaign still applies.
 */
async function launchDryRun(c: FullCampaign, now: Date): Promise<void> {
  if (spendEnforceMode() !== "enforce") return;
  const { headroom, limits, state } = await adsHeadroomDetail(c.tenantId, { currency: c.currency, fresh: true, now });
  if (limits.daily === null) throw new SpendBlockedError("spend.no_limit");
  const zone = state.accounts.find((a) => a.assetId === c.adAccountAssetId)?.timezone ?? state.control.timezone;
  const worst = campaignWorstCase(c, now, zone);
  const currency = limits.currency;
  const probation = () => new SpendBlockedError("spend.probation", { ...(limits.ceilingDetail.daily !== null ? { daily: { minor: limits.ceilingDetail.daily, currency } } : {}), ...(limits.ceilingDetail.monthly !== null ? { monthly: { minor: limits.ceilingDetail.monthly, currency } } : {}) });
  if (worst.day > limits.daily) {
    if (limits.dailyBinding === "probation") throw probation();
    throw new SpendBlockedError("spend.daily_limit", { left: { minor: headroom.today.left ?? limits.daily, currency }, needs: { minor: worst.day, currency } });
  }
  if (limits.monthly !== null && worst.month > limits.monthly) {
    if (limits.monthlyBinding === "probation") throw probation();
    throw new SpendBlockedError("spend.monthly_limit", { left: { minor: headroom.month.left ?? limits.monthly, currency }, needs: { minor: worst.month, currency } });
  }
}

/** Objects still to create on Meta: the campaign, ad sets, creatives and ads without a stored Meta id. */
function objectsToCreate(c: FullCampaign): number {
  let n = c.metaCampaignId ? 0 : 1;
  for (const set of c.adSets) {
    if (!set.metaAdSetId) n++;
    for (const ad of set.ads) {
      if (ad.metaAdId) continue;
      n += (ad.creative as { metaCreativeId?: unknown } | null)?.metaCreativeId ? 1 : 2;
    }
  }
  return n;
}

/**
 * Creates the campaign, ad sets (one per compared version), creatives and ads on Meta, all PAUSED, under a create permit from
 * the Spend Book (neutral: refused only while all spending is stopped) for exactly 1 + ad sets + 2 x ads objects. Safe to call
 * again after a failure: stored Meta ids are never recreated, and a campaign whose creation timed out is looked up by name
 * first. The "launching" claim is taken before anything is audited or sent, the launch_started row is then written (a failed
 * write releases the claim and stops the request), and the claim is kept alive by a heartbeat after every Meta call.
 * Before any of that: 409 media_not_ready while a library picture or video is still on its way to Meta, then every check of
 * validateCampaign and every creative body, built with its media resolved to Meta image hashes, video ids and thumbnail
 * hashes. Audiences are sent as Meta audience ids, and start and end times in the ad account's time zone.
 * `acknowledgeSpecialCategoryTerms` is the explicit second acknowledgement for a category-none campaign whose copy, links or
 * brand industry suggest housing, employment or credit.
 */
export async function launchCampaign(actor: Actor, id: string, opts: LaunchOptions = {}) {
  requireRole(actor, "admin");
  const tenantId = actor.tenantId;
  const who = opts.spendActor ?? userSpendActor(actor);
  const c = await mustLoad(tenantId, id);
  if (!["draft", "error", "launching"].includes(c.status)) throw new HttpError(409, "This campaign has already been launched.");
  if (c.discardedAt) throw new HttpError(409, DRAFT_DISCARDED);
  const acknowledging = opts.acknowledgeSpecialCategoryTerms === true;
  const media = await loadMedia(c);
  assertMediaReady(media);
  const [audiences, zone] = await Promise.all([loadAudiences(c), accountZone(tenantId, c.adAccountAssetId)]);
  const errors = await validateCampaign(c, { assumeTermsAcknowledged: acknowledging, media, audiences, timeZone: zone });
  if (errors.length) throw new HttpError(400, errors.join(" "));
  // Every creative still to create, with its media resolved, must build: refused here rather than after the campaign exists on Meta.
  const resolved = new Map<string, ResolvedMedia>();
  const buildErrors: string[] = [];
  for (const s of c.adSets) {
    for (const ad of s.ads) {
      const creative = creativeOf(ad);
      if (ad.metaAdId || creative.metaCreativeId || !usesCreativeShapes(c.template as AdTemplate, creative)) continue;
      const r = resolveMedia(creative, media);
      if (r) resolved.set(ad.id, r);
      buildErrors.push(...creativeBuildProblems({ name: ad.name, template: c.template as AdTemplate, creative, ...(r ?? {}), positions: parseTargeting(s.targeting).placements }).map((m) => `${ad.name}: ${m}`));
    }
  }
  if (buildErrors.length) throw new HttpError(400, [...new Set(buildErrors)].join(" "));
  await launchDryRun(c, new Date());
  const ackNeeded = acknowledging && c.specialAdCategory === "none" && (await unacknowledgedTermHits(c)).length > 0;

  const stale = new Date(Date.now() - LAUNCH_LEASE_MS);
  // The checks above take seconds: a draft discarded meanwhile is not claimed (it would end up on Meta yet hidden from the list).
  const claim = await prisma.adCampaign.updateMany({
    where: { id, tenantId, discardedAt: null, OR: [{ status: { in: ["draft", "error"] } }, { status: "launching", updatedAt: { lt: stale } }] },
    data: { status: "launching", lastError: null },
  });
  if (claim.count !== 1) throw await lostClaim(prisma, tenantId, id, "This campaign is already being launched.");
  const beat = () => prisma.adCampaign.updateMany({ where: { id, tenantId, status: "launching" }, data: { lastError: null } }).then(() => undefined, () => undefined);
  const releaseClaim = () => prisma.adCampaign.updateMany({ where: { id, tenantId, status: "launching" }, data: { status: c.status === "launching" ? "error" : c.status } }).then(() => undefined, () => undefined);

  try {
    await auditStrict({ tenantId, userId: actor.userId, action: "ads.campaign.launch_started", target: id, meta: { totalDailyBudgetMinor: totalDailyBudget(c), currency: c.currency, termsAcknowledged: ackNeeded } });
    if (ackNeeded) await persistTermsAck(c);
  } catch (e) {
    await releaseClaim();
    throw e;
  }

  let client: AdsClient;
  let externalId: string;
  let permit: CreatePermit | null = null;
  let remaining = objectsToCreate(c);
  try {
    ({ client, externalId } = await guardedClient(tenantId, c.adAccountAssetId, who));
    if (remaining > 0) permit = await permitForPausedCreate(tenantId, externalId, remaining, who);
  } catch (e) {
    await releaseClaim();
    throw e;
  }
  /** The create permit for the next object; a new one when the current one is about to expire (a long launch). */
  const createPermit = async (): Promise<CreatePermit> => {
    if (!permit || permit.expiresAt.getTime() - Date.now() < 60_000) permit = await permitForPausedCreate(tenantId, externalId, Math.max(1, remaining), who);
    remaining = Math.max(0, remaining - 1);
    return permit;
  };
  const template = c.template as AdTemplate;
  const category = c.specialAdCategory as SpecialAdCategory;
  const first = (c.adSets[0]?.ads[0]?.creative ?? {}) as unknown as CreativeInput;
  // The WhatsApp number of each ad set's ads (versions may differ), looked up once each.
  const phones = new Map<string, string | undefined>();
  const phoneOf = async (creative: Partial<CreativeInput>) => {
    const key = creative.whatsappNumberId ?? first.whatsappNumberId ?? "";
    if (!phones.has(key)) phones.set(key, await whatsappPhone(tenantId, key || undefined));
    return phones.get(key);
  };

  let step = "campaign";
  try {
    let metaCampaignId = c.metaCampaignId;
    if (!metaCampaignId && c.status !== "draft") metaCampaignId = await findOrphanCampaign(client, c, beat);
    if (!metaCampaignId) {
      metaCampaignId = await client.createCampaign(buildCampaign({ name: c.name, template, specialAdCategory: category, targeting: c.adSets.map((s) => parseTargeting(s.targeting)) }), await createPermit());
      await beat();
    }
    if (metaCampaignId !== c.metaCampaignId) await prisma.adCampaign.updateMany({ where: { id, tenantId }, data: { metaCampaignId } });
    for (const set of c.adSets) {
      step = set.variantKey ? `version ${set.variantKey}` : "ad set";
      const targeting = parseTargeting(set.targeting);
      const setCreative = (set.ads[0]?.creative ?? first) as unknown as CreativeInput;
      let metaAdSetId = set.metaAdSetId;
      if (!metaAdSetId) {
        const body = buildAdSet({
          name: set.name,
          metaCampaignId,
          template,
          targeting,
          specialAdCategory: category,
          dailyBudgetMinor: set.dailyBudgetMinor ?? c.dailyBudgetMinor,
          lifetimeBudgetMinor: lifetimeOnly(set) ? Number(set.lifetimeBudgetMinor) : null,
          pageId: setCreative.pageId,
          whatsappDisplayPhone: await phoneOf(setCreative),
          startsAt: c.startsAt,
          endsAt: c.endsAt,
          timeZone: zone,
          audienceMetaIds: audiences,
        });
        metaAdSetId = await client.createAdSet(body, await createPermit());
        await prisma.adSet.updateMany({ where: { id: set.id, tenantId }, data: { metaAdSetId, status: "paused" } });
        await beat();
      }
      for (const ad of set.ads) {
        step = `ad "${ad.name}"`;
        if (ad.metaAdId) continue;
        const creative = ad.creative as unknown as CreativeInput & { metaCreativeId?: string };
        let metaCreativeId = creative.metaCreativeId;
        if (!metaCreativeId) {
          const sendable = await withFreshAssetImage(tenantId, ad.creativeAssetId, creative);
          const r = resolved.get(ad.id);
          metaCreativeId = await client.createCreative(buildCreative({ name: ad.name, template, creative: sendable, whatsappDisplayPhone: await phoneOf(creative), ...(r ?? {}), positions: targeting.placements }), await createPermit());
          await prisma.ad.updateMany({ where: { id: ad.id, tenantId }, data: { creative: json({ ...creative, metaCreativeId, ...(ackNeeded ? { categoryTermsAck: true } : {}) }) } });
          await beat();
        }
        const metaAdId = await client.createAd(buildAd({ name: ad.name, metaAdSetId, metaCreativeId }), await createPermit());
        await prisma.ad.updateMany({ where: { id: ad.id, tenantId }, data: { metaAdId, status: "paused" } });
        await beat();
      }
    }
  } catch (e) {
    throw await recordError(c, actor, `Could not create the ${step}`, e);
  }
  await prisma.adCampaign.updateMany({ where: { id, tenantId }, data: { status: "paused", launchedAt: new Date(), lastError: null } });
  // Library media in use is kept by retention (5.5); best effort, the launch is done.
  if (media.size) await prisma.adMedia.updateMany({ where: { tenantId, id: { in: [...media.keys()] } }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  await audit({ tenantId, userId: actor.userId, action: "ads.campaign.launched_paused", target: id, meta: { totalDailyBudgetMinor: totalDailyBudget(c), adSets: c.adSets.length } });
  return mustLoad(tenantId, id);
}

export type ActivateInput = { confirm: unknown; confirmedTotalMinor: unknown };

export type ActivateOptions = {
  /** Who the Spend Book records as acting; the signed-in person by default. */
  spendActor?: SpendActor;
  /** Reuse to make a retried request return the same reservation. */
  idempotencyKey?: string;
  /** An approved SpendApproval being applied (7.3). */
  approvalId?: string;
};

type TurnedOn = { metaId: string; level: "ad" | "adset" | "campaign" };

/**
 * The only path that turns a campaign on. Needs confirm true and the exact total the person was shown, and the client's
 * approval when one was asked for. Then, in order (docs/SPEND-CONTROLS-SPEC.md 4.6, 4.8):
 * 1. the audit request row (a failed write stops the request before anything spends);
 * 2. reserveAds({kind:'activate'}) reserves the campaign's worst case against the limits, or refuses with the room that is
 *    left (the audit trail gets a failed outcome and nothing changes);
 * 3. the campaign row is claimed (paused -> active), so two activations of one campaign cannot both run;
 * 4. ads, then ad sets, then the campaign last are set ACTIVE, each with the permit (checked against the book right before
 *    each call);
 * 5. settleAds: applied. If Meta's answer to the final campaign call is ambiguous (timeout, 5xx, reset) it may have been applied,
 *    so the reservation is settled `unconfirmed` and stays counted, and the campaign is KEPT active with a lastError until the
 *    reconciler reads the truth. Any other failure pauses whatever was set ACTIVE (a lowering, through recordLowering), then
 *    settles `failed` (or `unconfirmed` when one of those pauses failed too) and puts the campaign back to paused.
 * The audit trail reads "..._requested", then exactly one of activated/resumed, "..._failed" or "..._unconfirmed".
 */
export async function activateCampaign(actor: Actor, id: string, input: ActivateInput, mode: "activate" | "resume" = "activate", opts: ActivateOptions = {}) {
  requireRole(actor, "admin");
  const tenantId = actor.tenantId;
  const who = opts.spendActor ?? userSpendActor(actor);
  const c = await mustLoad(tenantId, id);
  // Promote and Eddy campaigns turn on only through the Start gate (train P3), whichever route or job asks (IG-PAGE-ADS-SPEC 4.8).
  assertPromoteStartOpen(actor, c);
  if (c.status !== "paused" || !c.metaCampaignId) throw new HttpError(409, c.status === "active" ? "The campaign is already active." : "Only a launched, paused campaign can be activated.");
  const metaCampaignId = c.metaCampaignId;
  const total = confirmAmount(c);
  if (input.confirm !== true) throw new HttpError(400, "Set confirm to true to start spending.");
  if (input.confirmedTotalMinor !== total) throw new HttpError(409, `The total daily budget is ${total} ${c.currency} (minor units); confirm that exact amount.`);
  await assertCampaignCurrencyMatchesAccount(c);
  if ((await listApprovals(tenantId, "ad_campaign", id)).length > 0 && !(await isCampaignClientApproved(tenantId, id))) {
    throw new HttpError(409, "The client has not approved this campaign yet.");
  }

  const stem = mode === "resume" ? "resume" : "activation";
  const outcome = (suffix: string, meta?: Record<string, string | number | boolean | null>) => auditOutcome({ tenantId, userId: actor.userId, action: `ads.campaign.${stem}_${suffix}`, target: id, meta });
  const release = (lastError: string | null) => prisma.adCampaign.updateMany({ where: { id, tenantId, status: "active" }, data: { status: "paused", ...(lastError ? { lastError } : {}) } }).then(() => undefined, () => undefined);

  await auditStrict({ tenantId, userId: actor.userId, action: `ads.campaign.${stem}_requested`, target: id, meta: { totalDailyBudgetMinor: total, currency: c.currency } });

  // Reserved while the row still says paused, so the book counts this campaign once, at its own worst case. Requests made on
  // the same version of the campaign (a double click) share one idempotency key and so one reservation; only one of them
  // then wins the claim below.
  let permit: AdsPermit;
  try {
    const sets = c.adSets.filter((s) => s.metaAdSetId).map((s) => ({ adSetId: s.id, metaAdSetId: s.metaAdSetId! }));
    permit = await reserveAds(tenantId, { kind: "activate", campaignId: id, sets }, who, {
      idempotencyKey: opts.idempotencyKey ?? `ads:${stem}:${id}:${c.updatedAt instanceof Date ? c.updatedAt.getTime() : randomUUID()}`,
      reason: mode === "resume" ? `Turn '${c.name}' back on` : `Turn on '${c.name}'`,
      approvalId: opts.approvalId,
    });
  } catch (e) {
    await outcome("failed", { reason: e instanceof SpendBlockedError ? e.code : "refused" });
    throw e;
  }
  const claimed = await prisma.adCampaign.updateMany({ where: { id, tenantId, status: "paused" }, data: { status: "active" } });
  if (claimed.count !== 1) {
    // Another request is turning it on with this same reservation, or the campaign changed. Nothing was sent; a reservation
    // nobody uses expires and the reconciler stops counting it.
    await outcome("failed");
    throw new HttpError(409, "The campaign changed while it was being activated. Reload and try again.");
  }

  let client: AdsClient;
  try {
    ({ client } = await guardedClient(tenantId, c.adAccountAssetId, who));
  } catch (e) {
    await settleAds(permit, "failed", { error: "connection" });
    await release(null);
    await outcome("failed");
    throw e;
  }

  const turnedOn: TurnedOn[] = [];
  let current: TurnedOn | null = null;
  try {
    for (const set of c.adSets) {
      for (const ad of set.ads) {
        if (!ad.metaAdId || ad.status === "archived") continue;
        current = { metaId: ad.metaAdId, level: "ad" };
        await client.setStatus(ad.metaAdId, "ACTIVE", permit);
        turnedOn.push(current);
      }
      if (set.metaAdSetId) {
        current = { metaId: set.metaAdSetId, level: "adset" };
        await client.setStatus(set.metaAdSetId, "ACTIVE", permit);
        turnedOn.push(current);
      }
    }
    current = { metaId: metaCampaignId, level: "campaign" };
    await client.setStatus(metaCampaignId, "ACTIVE", permit);
    current = null;
  } catch (e) {
    const unclear = isAmbiguous(e);
    if (current?.level === "campaign" && unclear) {
      await settleAds(permit, "unconfirmed", { error: "ambiguous" });
      await prisma.adCampaign.updateMany({ where: { id, tenantId, status: "active" }, data: { lastError: `Activation not confirmed by Meta: ${failure(e)}` } }).catch(() => undefined);
      await outcome("unconfirmed");
      throw new HttpError(502, "Meta did not confirm the activation and it may have gone through. The campaign stays counted against your limits; check it in Ads Manager and pause it here if it should not be running.");
    }
    // Pause what may be on (newest first; the call that failed too when its answer was unclear). The campaign itself was never
    // switched on, so nothing delivers meanwhile.
    const back = [...turnedOn, ...(current && unclear ? [current] : [])].reverse();
    let stuck = false;
    for (const o of back) {
      try {
        await recordLowering(tenantId, { kind: "pause", metaObjectId: o.metaId }, who, "Turning on did not finish, so what was turned on was paused again.", (lowering) => client.setStatus(o.metaId, "PAUSED", lowering), { objectLevel: o.level });
      } catch {
        stuck = true;
      }
    }
    await settleAds(permit, stuck ? "unconfirmed" : "failed", { error: failure(e).slice(0, 80) });
    await release(`Activation: ${failure(e)}`);
    await outcome("failed");
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, "Could not finish activating. The campaign is still paused on Meta; try again.");
  }
  await settleAds(permit, "applied");
  await prisma.ad.updateMany({ where: { tenantId, adSet: { campaignId: id }, metaAdId: { not: null }, status: { not: "archived" } }, data: { status: "active" } });
  await prisma.adSet.updateMany({ where: { tenantId, campaignId: id, metaAdSetId: { not: null } }, data: { status: "active" } });
  await prisma.adCampaign.updateMany({ where: { id, tenantId }, data: { lastError: null } });
  // A fair test runs from its first start (3.8): budget edits keep its split until a winner is picked.
  if (c.adTest?.status === "draft") await prisma.adTest.updateMany({ where: { id: c.adTest.id, tenantId, status: "draft" }, data: { status: "running" } }).catch(() => console.error("[ads] could not mark the version test as running"));
  await auditOutcome({ tenantId, userId: actor.userId, action: mode === "resume" ? "ads.campaign.resumed" : "ads.campaign.activated", target: id, meta: { totalDailyBudgetMinor: total, currency: c.currency } });
  return mustLoad(tenantId, id);
}

export type LoweringOptions = { spendActor?: SpendActor; reason?: string };

/** Pauses the campaign on Meta. A lowering (recordLowering): never refused, works while spending is stopped. */
export async function pauseCampaign(actor: Actor, id: string, opts: LoweringOptions = {}) {
  requireRole(actor, "admin");
  const c = await mustLoad(actor.tenantId, id);
  if (c.status === "paused") return c;
  if (c.status !== "active" || !c.metaCampaignId) throw new HttpError(409, "Only an active campaign can be paused.");
  const metaCampaignId = c.metaCampaignId;
  const who = opts.spendActor ?? userSpendActor(actor);
  const { client } = await guardedClient(actor.tenantId, c.adAccountAssetId, who);
  try {
    await recordLowering(actor.tenantId, { kind: "pause", metaObjectId: metaCampaignId }, who, opts.reason ?? `Paused '${c.name}'.`, (lowering) => client.setStatus(metaCampaignId, "PAUSED", lowering), { objectLevel: "campaign" });
  } catch (e) {
    throw new HttpError(502, `Could not pause on Meta: ${failure(e)}`);
  }
  await prisma.adCampaign.updateMany({ where: { id, tenantId: actor.tenantId }, data: { status: "paused" } });
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "ads.campaign.paused", target: id });
  return mustLoad(actor.tenantId, id);
}

/** Archives the campaign on Meta (a lowering) and in the database. */
export async function archiveCampaign(actor: Actor, id: string, opts: LoweringOptions = {}) {
  requireRole(actor, "admin");
  const c = await mustLoad(actor.tenantId, id);
  if (c.status === "archived") return c;
  if (c.status === "launching") throw new HttpError(409, "The campaign is being launched.");
  if (c.metaCampaignId) {
    const metaCampaignId = c.metaCampaignId;
    const who = opts.spendActor ?? userSpendActor(actor);
    const { client } = await guardedClient(actor.tenantId, c.adAccountAssetId, who);
    try {
      // VERIFY: ARCHIVED is accepted as a campaign status update.
      await recordLowering(actor.tenantId, { kind: "archive", metaObjectId: metaCampaignId }, who, opts.reason ?? `Archived '${c.name}'.`, (lowering) => client.setStatus(metaCampaignId, "ARCHIVED", lowering), { objectLevel: "campaign" });
    } catch (e) {
      throw new HttpError(502, `Could not archive on Meta: ${failure(e)}`);
    }
  }
  await prisma.adCampaign.updateMany({ where: { id, tenantId: actor.tenantId }, data: { status: "archived" } });
  await prisma.adSet.updateMany({ where: { campaignId: id, tenantId: actor.tenantId }, data: { status: "archived" } });
  await prisma.ad.updateMany({ where: { tenantId: actor.tenantId, adSet: { campaignId: id } }, data: { status: "archived" } });
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "ads.campaign.archived", target: id });
  return mustLoad(actor.tenantId, id);
}

const ON_META = ["active", "paused"];

/**
 * The versions of a fair test that is still running (3.8): every launched ad set with a version key, in A, B, C order, while
 * the test has no winner. Empty when the campaign compares nothing, or once a winner was picked (edits then go to it alone).
 */
function fairTestVersions(c: FullCampaign) {
  const test = c.adTest;
  if (!test || test.mode !== "fair_split" || test.winnerAdSetId || !["draft", "running"].includes(test.status)) return [];
  const versions = c.adSets.filter((s) => s.metaAdSetId && s.variantKey).sort((a, b) => String(a.variantKey).localeCompare(String(b.variantKey)));
  return versions.length > 1 ? versions : [];
}

/**
 * Changes the daily budget of a launched campaign's ad set (minor units), through setAdSetBudget: a cut is a lowering and
 * always goes ahead; a raise is reserved in the Spend Book first and refused with the room that is left when it does not fit.
 * `adSetId` (the row id) is needed only when the campaign has more than one ad set on Meta. `{adSetId, dailyBudgetMinor}`
 * always means that ad set's own daily budget (the campaign page's budget dialog and EDDY-V2-02 set_adset_budget, 4.8).
 * While a fair test of versions runs (3.8) the split stays fair, every version at the same amount:
 * - with `adSetId` naming a version, the amount is that version's daily budget, and every version is set to it (the daily
 *   total is the amount times the number of versions);
 * - without `adSetId`, the amount is the daily total for all versions: each version's share is the total divided by the
 *   number of versions, rounded down to a whole major unit.
 * A cut lowers every version; a raise raises them one by one, and when one is refused the versions already raised are cut
 * back to their old share and the refusal (with the room left) is returned. The answer then also carries shareMinor (each
 * version's budget), dailyTotalMinor and versions (how many), so the caller can say that every version changed.
 */
export async function changeCampaignBudget(actor: Actor, id: string, input: { dailyBudgetMinor?: unknown; adSetId?: unknown }) {
  requireRole(actor, "admin");
  const c = await mustLoad(actor.tenantId, id);
  if (!ON_META.includes(c.status) || !c.metaCampaignId) throw new HttpError(409, "Only a campaign that is on Meta can have its budget changed. Edit the draft instead.");
  const minor = input.dailyBudgetMinor;
  if (typeof minor !== "number" || !Number.isSafeInteger(minor) || minor <= 0) throw new HttpError(400, "dailyBudgetMinor must be a positive whole number in minor units.");
  const versions = fairTestVersions(c);
  if (versions.length) return changeSplitBudget(actor, c, versions, minor, input.adSetId);
  const launched = c.adSets.filter((s) => s.metaAdSetId);
  const set = typeof input.adSetId === "string" && input.adSetId ? launched.find((s) => s.id === input.adSetId) : launched.length === 1 ? launched[0] : undefined;
  if (!set) throw new HttpError(400, launched.length > 1 ? "Choose which ad set's budget to change." : "This campaign has no ad set on Meta yet.");
  if (lifetimeOnly(set)) throw new HttpError(409, "This ad set has a lifetime budget, so its daily budget cannot be changed here. Change it in Meta Ads Manager.");
  await assertCampaignCurrencyMatchesAccount(c);
  const current = set.dailyBudgetMinor ?? c.dailyBudgetMinor;
  // A raise must still fit the workspace's daily cap for one campaign, the same check a launch makes.
  if (minor > current) await assertWithinCap(c.tenantId, totalDailyBudget(c) - current + minor, c.currency);
  const result = await setAdSetBudget(actor.tenantId, set.metaAdSetId!, minor, userSpendActor(actor), { reason: `Changed the daily budget of '${c.name}'.` });
  return { appliedDailyBudgetMinor: result.appliedDailyBudgetMinor, campaign: await getCampaignView(actor.tenantId, id) };
}

/**
 * The fair-test half of changeCampaignBudget (3.8). `amountMinor` is one version's daily budget when `adSetId` names a version,
 * else the daily total for all of them; either way every version ends at the same share. appliedDailyBudgetMinor answers in
 * the request's terms: the named version's new budget, or the new total.
 */
async function changeSplitBudget(actor: Actor, c: FullCampaign, versions: FullCampaign["adSets"], amountMinor: number, adSetId: unknown) {
  const named = typeof adSetId === "string" && adSetId ? adSetId : null;
  if (named && !versions.some((s) => s.id === named)) throw new HttpError(400, "That ad set isn't one of the versions this campaign compares.");
  if (versions.some(lifetimeOnly)) throw new HttpError(409, "These versions have a lifetime budget, so their daily budget cannot be changed here. Change it in Meta Ads Manager.");
  await assertCampaignCurrencyMatchesAccount(c);
  const share = named ? amountMinor : Number(splitDaily(BigInt(amountMinor), versions.length, c.currency).shareMinor);
  if (share < majorUnit(c.currency)) throw new HttpError(400, `Each version needs at least ${formatMoney(majorUnit(c.currency), c.currency)} a day. ${named ? "Raise the amount." : "Raise the total or remove a version."}`);
  const total = share * versions.length;
  const current = versions.reduce((sum, s) => sum + (s.dailyBudgetMinor ?? c.dailyBudgetMinor), 0);
  // A raise must still fit the workspace's daily cap for one campaign, the same check a launch makes.
  if (total > current) await assertWithinCap(c.tenantId, totalDailyBudget(c) - current + total, c.currency);
  const reason = named
    ? `Changed the daily budget of every version of '${c.name}' to the same amount, so its ${versions.length} versions stay a fair test.`
    : `Changed the daily budget of '${c.name}', split equally between its ${versions.length} versions.`;
  await setSplitBudget(actor.tenantId, versions.map((s) => s.metaAdSetId!), share, userSpendActor(actor), { reason });
  return { appliedDailyBudgetMinor: named ? share : total, shareMinor: share, dailyTotalMinor: total, versions: versions.length, campaign: await getCampaignView(actor.tenantId, c.id) };
}

/** Parses the new end date of a launched campaign: in the future (at least an hour from now) and after its start. */
export function parseNewEnd(raw: unknown, c: { startsAt: Date | null; origin: string; lifetimeBudgetMinor: bigint | number | null }, now = new Date()): Date {
  if (typeof raw !== "string" || !raw.trim()) throw new HttpError(400, "Choose the new end date.");
  const endsAt = new Date(raw);
  if (Number.isNaN(endsAt.getTime())) throw new HttpError(400, "endsAt must be an ISO date.");
  if (endsAt.getTime() < now.getTime() + 3_600_000) throw new HttpError(400, "Choose an end at least an hour from now.");
  if (c.startsAt && endsAt.getTime() <= c.startsAt.getTime()) throw new HttpError(400, "The end must be after the start.");
  if (c.origin === "assistant" && (c.lifetimeBudgetMinor === null || c.lifetimeBudgetMinor === undefined) && endsAt.getTime() > now.getTime() + ASSISTANT_MAX_END_DAYS * DAY_MS) {
    throw new HttpError(400, `Ads started by an assistant must end within ${ASSISTANT_MAX_END_DAYS} days, unless they have a lifetime budget.`);
  }
  return endsAt;
}

/**
 * Moves the end date of a launched campaign (every ad set on Meta gets the new end_time). An earlier end (or a first end on
 * a campaign that had none) is a lowering: recordLowering end_earlier, never refused. A later end extends spending: it is
 * reserved in the Spend Book first (reserveAds extend_end) and can be refused with the room that is left. Removing the end
 * date is not offered here (the book only extends to a date). The audit trail of a later end reads "..._requested", then
 * exactly one of end_extended, end_change_failed or end_change_unconfirmed.
 */
export async function changeCampaignEnd(actor: Actor, id: string, input: { endsAt?: unknown }, now = new Date(), opts: { spendActor?: SpendActor } = {}) {
  requireRole(actor, "admin");
  const tenantId = actor.tenantId;
  const c = await mustLoad(tenantId, id);
  if (!ON_META.includes(c.status) || !c.metaCampaignId) throw new HttpError(409, "Only a campaign that is on Meta can have its end date changed. Edit the draft instead.");
  const endsAt = parseNewEnd(input.endsAt, c, now);
  const sets = c.adSets.filter((s) => s.metaAdSetId);
  if (sets.length === 0) throw new HttpError(409, "This campaign has no ad set on Meta yet.");
  if (c.endsAt && c.endsAt.getTime() === endsAt.getTime()) return getCampaignView(tenantId, id);
  // Who the Spend Book records (reserveAds extend_end, recordLowering end_earlier): Eddy forwards its via_eddy actor (B14).
  const who = opts.spendActor ?? userSpendActor(actor);
  const { client } = await guardedClient(tenantId, c.adAccountAssetId, who);
  const later = c.endsAt !== null && endsAt.getTime() > c.endsAt.getTime();
  const save = () => prisma.adCampaign.updateMany({ where: { id, tenantId }, data: { endsAt } });

  if (!later) {
    for (const s of sets) {
      const metaAdSetId = s.metaAdSetId!;
      try {
        await recordLowering(tenantId, { kind: "end_earlier", metaObjectId: metaAdSetId, endsAt }, who, `Moved the end date of '${c.name}' earlier.`, (lowering) => client.setEndTime(metaAdSetId, endsAt, lowering), { objectLevel: "adset" });
      } catch (e) {
        if (e instanceof HttpError && e.status < 500) throw e;
        throw new HttpError(502, `Could not change the end date on Meta: ${failure(e)}`);
      }
    }
    await save();
    await audit({ tenantId, userId: actor.userId, action: "ads.campaign.end_changed", target: id, meta: { from: c.endsAt?.toISOString() ?? null, to: endsAt.toISOString() } });
    return getCampaignView(tenantId, id);
  }

  const meta = { from: c.endsAt?.toISOString() ?? null, to: endsAt.toISOString() };
  const outcome = (suffix: "end_extended" | "end_change_failed" | "end_change_unconfirmed") => auditOutcome({ tenantId, userId: actor.userId, action: `ads.campaign.${suffix}`, target: id, meta });
  await auditStrict({ tenantId, userId: actor.userId, action: "ads.campaign.end_change_requested", target: id, meta });
  let permit: AdsPermit;
  try {
    permit = await reserveAds(tenantId, { kind: "extend_end", campaignId: id, endsAt }, who, { idempotencyKey: `ads:extend_end:${id}:${endsAt.getTime()}:${randomUUID()}`, reason: `Move the end date of '${c.name}' later` });
  } catch (e) {
    await outcome("end_change_failed");
    throw e;
  }
  let written = 0;
  try {
    for (const s of sets) {
      await client.setEndTime(s.metaAdSetId!, endsAt, permit);
      written++;
    }
  } catch (e) {
    // Some ad sets may already run to the later end: the reservation then stays counted until the reconciler reads Meta.
    if (isAmbiguous(e) || written > 0) {
      await settleAds(permit, "unconfirmed", { error: isAmbiguous(e) ? "ambiguous" : "partial" });
      await outcome("end_change_unconfirmed");
      throw new HttpError(502, "Meta did not confirm the new end date for every ad set, and some may run longer. It stays counted against your limits; check the campaign in Ads Manager.");
    }
    await settleAds(permit, "failed", { error: failure(e).slice(0, 80) });
    await outcome("end_change_failed");
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, `Could not change the end date on Meta: ${failure(e)}`);
  }
  await settleAds(permit, "applied");
  await save();
  await outcome("end_extended");
  return getCampaignView(tenantId, id);
}

/** The workspace's campaigns, newest first. Discarded drafts are left out (they can still be restored by id for 15 minutes). */
export async function listCampaigns(tenantId: string) {
  const rows = await prisma.adCampaign.findMany({ where: { tenantId, discardedAt: null }, orderBy: { createdAt: "desc" }, take: 100, include: { adSets: { select: { dailyBudgetMinor: true, _count: { select: { ads: true } } } } } });
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    template: c.template,
    status: c.status,
    currency: c.currency,
    adAccountAssetId: c.adAccountAssetId,
    specialAdCategory: c.specialAdCategory,
    lastError: c.lastError,
    createdAt: c.createdAt,
    launchedAt: c.launchedAt,
    totalDailyBudgetMinor: c.adSets.reduce((s, a) => s + (a.dailyBudgetMinor ?? c.dailyBudgetMinor), 0),
    adCount: c.adSets.reduce((s, a) => s + a._count.ads, 0),
    surface: c.surface ?? "wizard",
    // An old-wizard campaign has no stored goal: its template says it (4.4, boost_post is engagement).
    goal: c.goal ?? goalOfLegacyTemplate(c.template)?.goal ?? null,
    reviewState: c.reviewState ?? null,
  }));
}

export async function getCampaign(tenantId: string, id: string) {
  const c = await mustLoad(tenantId, id);
  return { ...c, totalDailyBudgetMinor: totalDailyBudget(c), confirmTotalMinor: confirmAmount(c) };
}

const plainNumber = (v: bigint | number | null | undefined) => (v === null || v === undefined ? null : Number(v));

/**
 * The campaign as the campaign page reads it: JSON-safe (lifetime budgets as numbers), with Meta's review of each ad
 * (src/lib/ads/review.ts) and whether the draft can still be edited.
 */
export async function getCampaignView(tenantId: string, id: string) {
  const c = await getCampaign(tenantId, id);
  return {
    ...c,
    lifetimeBudgetMinor: plainNumber(c.lifetimeBudgetMinor),
    targetCostPerResultMinor: plainNumber(c.targetCostPerResultMinor),
    editable: isEditableDraft(c) && !c.discardedAt,
    adSets: c.adSets.map((s) => ({ ...s, lifetimeBudgetMinor: plainNumber(s.lifetimeBudgetMinor), bidAmountMinor: plainNumber(s.bidAmountMinor), ads: s.ads.map((a) => ({ ...a, review: readAdReview(a.creative) })) })),
  };
}
