import { randomUUID } from "node:crypto";
import { isCampaignClientApproved, listApprovals } from "@/lib/approvals";
import { audit } from "@/lib/auth/audit";
import { adAccountsBlockedByPlan, assertAdAccountAllowed } from "@/lib/billing/limits";
import { prisma } from "@/lib/db";
import { getAssetAccess, listAssets } from "@/lib/meta-connect";
import { sanitizeMessage } from "@/lib/safe-error";
import { adsHeadroomDetail, permitForPausedCreate, recordLowering, reserveAds, settleAds } from "@/lib/spend/book";
import { spendCopy } from "@/lib/spend/copy";
import { SpendBlockedError } from "@/lib/spend/errors";
import { spendEnforceMode } from "@/lib/spend/flags";
import { sandboxFlagFor } from "@/lib/spend/sandbox";
import type { AdsPermit, CreatePermit, SpendActor } from "@/lib/spend/types";
import { dayRisk, NO_SPEND, remainingMonth } from "@/lib/spend/worstcase";
import { HttpError, requireRole, type Actor } from "@/lib/tenancy";
import { buildAd, buildAdSet, buildCampaign, buildCreative, creativeProblems, TEMPLATE_SPECS, type PayloadPreview } from "./builders";
import { assetImageUrl, usableAssetImage, withFreshAssetImage } from "./asset-image";
import { auditOutcome, auditStrict } from "./audit";
import { assertCapApplies, assertWithinCap, getCaps, isCurrencyCode } from "./caps";
import { describeHits, detectSpecialCategoryTerms, urlWords } from "./category-terms";
import { adsClient, type AdsClient } from "./client";
import { parseTargeting, restrictForCategory, validateTargeting } from "./targeting";
import { isCategory, isTemplate, type AdTemplate, type CreativeInput, type SpecialAdCategory, type Targeting } from "./types";

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
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const DAY_MS = 86_400_000;
/** An assistant's campaign ends within this many days, unless a lifetime budget bounds it (docs/SPEND-CONTROLS-SPEC.md 4.8, R2). */
export const ASSISTANT_MAX_END_DAYS = 90;

/** Who a campaign is for: a person, an assistant (proposal-only in Phase 0) or the API. */
export type CampaignOrigin = "human" | "assistant" | "api";

/** The person behind a request, as the Spend Book records them. */
export const userSpendActor = (actor: Actor): SpendActor => ({ type: "user", userId: actor.userId, role: actor.role });

export type DraftInput = {
  name: string;
  template: AdTemplate;
  adAccountAssetId: string;
  /** The daily budget of the ad set; null when a lifetime budget is used instead. */
  dailyBudgetMinor: number | null;
  /** A lifetime budget instead of a daily one (needs an end date). */
  lifetimeBudgetMinor: number | null;
  startsAt: Date | null;
  endsAt: Date | null;
  /** Set by trusted callers only, never read from a request body. */
  origin: CampaignOrigin;
  assistantKey: string | null;
  specialAdCategory: SpecialAdCategory;
  confirmNoSpecialCategory: boolean;
  /** Second, explicit acknowledgement needed to launch category "none" when housing, employment or credit terms are detected. */
  acknowledgeSpecialCategoryTerms: boolean;
  targeting: Targeting;
  ads: { name: string; creativeAssetId: string | null; creative: CreativeInput }[];
};

export type DraftParseOptions = {
  /** Trusted callers only: the campaign is an assistant's (ads_launcher) or the API's. A route body never sets it. */
  origin?: CampaignOrigin;
  assistantKey?: string | null;
  now?: Date;
};

/**
 * Validates untrusted JSON from a route body. Throws HttpError(400). A daily budget, or a lifetime budget with an end date.
 * An assistant's campaign (origin from the trusted caller) needs an end date within 90 days, or a lifetime budget.
 */
export function parseDraftInput(body: Record<string, unknown>, opts: DraftParseOptions = {}): DraftInput {
  const name = str(body.name, 120);
  if (!name) throw new HttpError(400, "name is required.");
  if (!isTemplate(body.template)) throw new HttpError(400, "template must be lead_generation, click_to_whatsapp, traffic or boost_post.");
  if (!isCategory(body.specialAdCategory)) throw new HttpError(400, "Declare a special ad category (use none if it does not apply).");
  const adAccountAssetId = str(body.adAccountAssetId, 100);
  if (!adAccountAssetId) throw new HttpError(400, "adAccountAssetId is required.");
  const budget = body.dailyBudgetMinor;
  const lifetimeRaw = body.lifetimeBudgetMinor === "" ? null : body.lifetimeBudgetMinor;
  const lifetime = lifetimeRaw === undefined || lifetimeRaw === null ? null : lifetimeRaw;
  if (lifetime !== null && (typeof lifetime !== "number" || !Number.isInteger(lifetime) || lifetime <= 0)) throw new HttpError(400, "lifetimeBudgetMinor must be a positive whole number in minor units.");
  let daily: number | null = null;
  if (lifetime === null || (budget !== undefined && budget !== null)) {
    if (typeof budget !== "number" || !Number.isInteger(budget) || budget <= 0) throw new HttpError(400, "dailyBudgetMinor must be a positive whole number in minor units.");
    daily = budget;
  }
  if (daily !== null && lifetime !== null) throw new HttpError(400, "Choose a daily budget or a lifetime budget, not both.");
  const date = (v: unknown, f: string) => {
    if (v === undefined || v === null || v === "") return null;
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) throw new HttpError(400, `${f} must be an ISO date.`);
    return d;
  };
  const startsAt = date(body.startsAt, "startsAt");
  const endsAt = date(body.endsAt, "endsAt");
  if (startsAt && endsAt && endsAt <= startsAt) throw new HttpError(400, "endsAt must be after startsAt.");
  if (lifetime !== null && !endsAt) throw new HttpError(400, "A lifetime budget needs an end date.");
  const origin: CampaignOrigin = opts.origin === "assistant" || opts.origin === "api" ? opts.origin : "human";
  const assistantKey = origin === "assistant" ? str(opts.assistantKey, 64) : null;
  if (origin === "assistant") {
    if (!assistantKey) throw new HttpError(400, "An assistant's campaign must name the assistant.");
    if (!endsAt) throw new SpendBlockedError("spend.end_date_required");
    const latest = (opts.now ?? new Date()).getTime() + ASSISTANT_MAX_END_DAYS * DAY_MS;
    if (lifetime === null && endsAt.getTime() > latest) throw new HttpError(400, `Ads started by an assistant must end within ${ASSISTANT_MAX_END_DAYS} days, unless they have a lifetime budget.`);
  }
  if (!Array.isArray(body.ads) || body.ads.length < 1 || body.ads.length > 10) throw new HttpError(400, "Provide 1 to 10 ads.");
  const ads = body.ads.map((a, i) => {
    if (!isObj(a) || !isObj(a.creative)) throw new HttpError(400, `ads[${i}].creative is required.`);
    const c = a.creative;
    const creative: CreativeInput = {
      pageId: str(c.pageId, 100),
      instagramId: str(c.instagramId, 100) || undefined,
      message: str(c.message, 2200),
      headline: str(c.headline, 100) || undefined,
      link: str(c.link, 1000) || undefined,
      cta: str(c.cta, 40) || undefined,
      leadFormId: str(c.leadFormId, 100) || undefined,
      whatsappNumberId: str(c.whatsappNumberId, 100) || undefined,
      welcomeMessage: str(c.welcomeMessage, 300) || undefined,
      postId: str(c.postId, 100) || undefined,
      imageUrl: str(c.imageUrl, 1000) || undefined,
      imageHash: str(c.imageHash, 100) || undefined,
    };
    return { name: str(a.name, 120) || `${name} ad ${i + 1}`, creativeAssetId: str(a.creativeAssetId, 100) || null, creative };
  });
  const used = ads.map((a) => a.creativeAssetId).filter((v): v is string => !!v);
  if (new Set(used).size !== used.length) throw new HttpError(400, "Each ad needs a different creative. Remove the repeated one, or pick another.");
  return {
    name,
    template: body.template,
    adAccountAssetId,
    dailyBudgetMinor: daily,
    lifetimeBudgetMinor: lifetime as number | null,
    startsAt,
    endsAt,
    origin,
    assistantKey,
    specialAdCategory: body.specialAdCategory,
    confirmNoSpecialCategory: body.confirmNoSpecialCategory === true,
    acknowledgeSpecialCategoryTerms: body.acknowledgeSpecialCategoryTerms === true,
    targeting: parseTargeting(body.targeting),
    ads,
  };
}

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
  return { adAccounts: accounts.map((a) => ({ ...strip(a), timezone: zone(a), planBlocked: blocked.has(a.id) })), pages: pages.map(strip), instagram: instagram.map(strip), phoneNumbers: phones, creativeAssets: (assets ?? []).map(({ storageKey, policyCheck, ...a }) => ({ ...a, hasImage: usableAssetImage({ kind: a.kind, storageKey: storageKey ?? null }), blocked: (policyCheck as { result?: string } | null)?.result === "block" })), suggestedSpecialAdCategory: suggested, caps };
}

async function resolveCreative(tenantId: string, input: DraftInput["ads"][number]) {
  const creative = { ...input.creative };
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

export async function createCampaignDraft(actor: Actor, input: DraftInput) {
  requireRole(actor, "admin");
  const tenantId = actor.tenantId;
  if (input.specialAdCategory === "none" && !input.confirmNoSpecialCategory) {
    const suggested = await suggestedCategory(tenantId);
    if (suggested !== "none") throw new HttpError(400, `Your brand is flagged for the "${suggested}" special ad category. Declare it, or confirm explicitly that none applies.`);
  }
  const creatives = await Promise.all(input.ads.map((a) => resolveCreative(tenantId, a)));
  await assertOwnedRefs(tenantId, input.adAccountAssetId, creatives);
  await assertAdAccountAllowed(tenantId, input.adAccountAssetId);
  const currency = await liveAccountCurrency(tenantId, input.adAccountAssetId);
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
  const spec = TEMPLATE_SPECS[input.template];

  // One transaction: a failure part-way (the 10th ad of an A/B test, say) leaves no campaign behind that would still hold the ad account.
  const campaign = await prisma.$transaction(async (tx) => {
    const created = await tx.adCampaign.create({
      data: {
        tenantId,
        adAccountAssetId: input.adAccountAssetId,
        name: input.name,
        template: input.template,
        objective: spec.objective,
        status: "draft",
        dailyBudgetMinor: input.dailyBudgetMinor ?? 0,
        lifetimeBudgetMinor: input.lifetimeBudgetMinor === null ? null : BigInt(input.lifetimeBudgetMinor),
        currency,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        specialAdCategory: input.specialAdCategory,
        createdByUserId: actor.userId,
        origin: input.origin,
        assistantKey: input.assistantKey,
      },
    });
    const adSet = await tx.adSet.create({
      data: {
        tenantId,
        campaignId: created.id,
        name: `${input.name} ad set`,
        targeting: json(targeting),
        dailyBudgetMinor: input.dailyBudgetMinor,
        lifetimeBudgetMinor: input.lifetimeBudgetMinor === null ? null : BigInt(input.lifetimeBudgetMinor),
      },
    });
    for (const [i, ad] of input.ads.entries()) {
      await tx.ad.create({ data: { tenantId, adSetId: adSet.id, creativeAssetId: ad.creativeAssetId, name: ad.name, creative: json(termsAcknowledged ? { ...creatives[i], categoryTermsAck: true } : creatives[i]) } });
    }
    return created;
  });
  await audit({ tenantId, userId: actor.userId, action: "ads.campaign.drafted", target: campaign.id, meta: { template: input.template, dailyBudgetMinor: input.dailyBudgetMinor, lifetimeBudgetMinor: input.lifetimeBudgetMinor, specialAdCategory: input.specialAdCategory, origin: input.origin } });
  return { campaignId: campaign.id, adjustments };
}

type FullCampaign = NonNullable<Awaited<ReturnType<typeof loadCampaign>>>;

async function loadCampaign(tenantId: string, id: string) {
  return prisma.adCampaign.findFirst({ where: { id, tenantId }, include: { adSets: { include: { ads: true }, orderBy: { createdAt: "asc" } } } });
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

/** Local validation only: targeting, creative fields, schedule, currency, cap. Returns messages; empty means ready. `assumeTermsAcknowledged` is the launch request carrying the explicit acknowledgement. */
export async function validateCampaign(c: FullCampaign, opts: { assumeTermsAcknowledged?: boolean } = {}): Promise<string[]> {
  const errors: string[] = [];
  const template = c.template as AdTemplate;
  const category = (isCategory(c.specialAdCategory) ? c.specialAdCategory : "none") as SpecialAdCategory;
  if (!isTemplate(template)) return ["Unknown template."];
  if (c.adSets.length === 0 || c.adSets.every((s) => s.ads.length === 0)) errors.push("The campaign needs at least one ad.");
  for (const s of c.adSets) {
    errors.push(...validateTargeting(parseTargeting(s.targeting), category).errors);
    for (const ad of s.ads) errors.push(...creativeProblems(template, ad.creative as unknown as CreativeInput).map((m) => `${ad.name}: ${m}`));
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
  return errors;
}

export async function previewCampaign(actor: Actor, id: string) {
  const c = await mustLoad(actor.tenantId, id);
  const template = c.template as AdTemplate;
  const category = c.specialAdCategory as SpecialAdCategory;
  const set = c.adSets[0];
  const targeting = parseTargeting(set?.targeting);
  const first = (set?.ads[0]?.creative ?? {}) as unknown as CreativeInput;
  const phone = await whatsappPhone(actor.tenantId, first.whatsappNumberId);
  const payload: PayloadPreview = {
    campaign: buildCampaign({ name: c.name, template, specialAdCategory: category }),
    adSet: buildAdSet({ name: set?.name ?? c.name, metaCampaignId: "<new campaign id>", template, targeting, specialAdCategory: category, dailyBudgetMinor: set?.dailyBudgetMinor ?? c.dailyBudgetMinor, lifetimeBudgetMinor: set && lifetimeOnly(set) ? Number(set.lifetimeBudgetMinor) : null, pageId: first.pageId, whatsappDisplayPhone: phone, startsAt: c.startsAt, endsAt: c.endsAt }),
    ads: (set?.ads ?? []).map((ad) => ({ name: ad.name, creative: buildCreative({ name: ad.name, template, creative: ad.creative as unknown as CreativeInput, whatsappDisplayPhone: phone }) })),
  };
  const caps = await getCaps(actor.tenantId);
  return { campaignId: c.id, status: c.status, payload, totalDailyBudgetMinor: totalDailyBudget(c), currency: c.currency, caps, errors: await validateCampaign(c), startsInPausedState: true };
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
 * Creates the campaign, ad set, creatives and ads on Meta, all PAUSED, under a create permit from the Spend Book (neutral:
 * refused only while all spending is stopped). Safe to call again after a failure: stored Meta ids are never recreated, and a
 * campaign whose creation timed out is looked up by name first. The "launching" claim is taken before anything is audited or
 * sent, the launch_started row is then written (a failed write releases the claim and stops the request), and the claim is
 * kept alive by a heartbeat after every Meta call. `acknowledgeSpecialCategoryTerms` is the explicit second acknowledgement for a
 * category-none campaign whose copy, links or brand industry suggest housing, employment or credit.
 */
export async function launchCampaign(actor: Actor, id: string, opts: LaunchOptions = {}) {
  requireRole(actor, "admin");
  const tenantId = actor.tenantId;
  const who = opts.spendActor ?? userSpendActor(actor);
  const c = await mustLoad(tenantId, id);
  if (!["draft", "error", "launching"].includes(c.status)) throw new HttpError(409, "This campaign has already been launched.");
  const acknowledging = opts.acknowledgeSpecialCategoryTerms === true;
  const errors = await validateCampaign(c, { assumeTermsAcknowledged: acknowledging });
  if (errors.length) throw new HttpError(400, errors.join(" "));
  await launchDryRun(c, new Date());
  const ackNeeded = acknowledging && c.specialAdCategory === "none" && (await unacknowledgedTermHits(c)).length > 0;

  const stale = new Date(Date.now() - LAUNCH_LEASE_MS);
  const claim = await prisma.adCampaign.updateMany({
    where: { id, tenantId, OR: [{ status: { in: ["draft", "error"] } }, { status: "launching", updatedAt: { lt: stale } }] },
    data: { status: "launching", lastError: null },
  });
  if (claim.count !== 1) throw new HttpError(409, "This campaign is already being launched.");
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
  const phone = await whatsappPhone(tenantId, first.whatsappNumberId);

  let step = "campaign";
  try {
    let metaCampaignId = c.metaCampaignId;
    if (!metaCampaignId && c.status !== "draft") metaCampaignId = await findOrphanCampaign(client, c, beat);
    if (!metaCampaignId) {
      metaCampaignId = await client.createCampaign(buildCampaign({ name: c.name, template, specialAdCategory: category }), await createPermit());
      await beat();
    }
    if (metaCampaignId !== c.metaCampaignId) await prisma.adCampaign.updateMany({ where: { id, tenantId }, data: { metaCampaignId } });
    for (const set of c.adSets) {
      step = "ad set";
      let metaAdSetId = set.metaAdSetId;
      if (!metaAdSetId) {
        const pageId = ((set.ads[0]?.creative ?? first) as unknown as CreativeInput).pageId;
        const body = buildAdSet({ name: set.name, metaCampaignId, template, targeting: parseTargeting(set.targeting), specialAdCategory: category, dailyBudgetMinor: set.dailyBudgetMinor ?? c.dailyBudgetMinor, lifetimeBudgetMinor: lifetimeOnly(set) ? Number(set.lifetimeBudgetMinor) : null, pageId, whatsappDisplayPhone: phone, startsAt: c.startsAt, endsAt: c.endsAt });
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
          metaCreativeId = await client.createCreative(buildCreative({ name: ad.name, template, creative: sendable, whatsappDisplayPhone: phone }), await createPermit());
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
  await audit({ tenantId, userId: actor.userId, action: "ads.campaign.launched_paused", target: id, meta: { totalDailyBudgetMinor: totalDailyBudget(c) } });
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

export async function listCampaigns(tenantId: string) {
  const rows = await prisma.adCampaign.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 100, include: { adSets: { select: { dailyBudgetMinor: true, _count: { select: { ads: true } } } } } });
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    template: c.template,
    status: c.status,
    currency: c.currency,
    specialAdCategory: c.specialAdCategory,
    lastError: c.lastError,
    createdAt: c.createdAt,
    launchedAt: c.launchedAt,
    totalDailyBudgetMinor: c.adSets.reduce((s, a) => s + (a.dailyBudgetMinor ?? c.dailyBudgetMinor), 0),
    adCount: c.adSets.reduce((s, a) => s + a._count.ads, 0),
  }));
}

export async function getCampaign(tenantId: string, id: string) {
  const c = await mustLoad(tenantId, id);
  return { ...c, totalDailyBudgetMinor: totalDailyBudget(c), confirmTotalMinor: confirmAmount(c) };
}
