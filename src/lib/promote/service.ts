/**
 * The Promote service (docs/IG-PAGE-ADS-SPEC.md 3.1, 3.1a, 3.3 to 3.6, 3.9, 4.8, 6.1, 6.2, 6.5, D3 to D9, D26, D28, D32, D34;
 * PRM-09). The page's routes and Eddy's promotion actions call these functions, so both get the same draft, the same card and
 * the same Start (D26).
 *
 * - Drafts are rows (D28): createPromotionDraft fills the 3.1 smart defaults (defaults.ts) and saves through
 *   ads/service.createCampaignDraft with origin human and surface promote or eddy. The member's whole draft (the draft-paths
 *   view, the form spec Start will create, a boosted post's caption, and who wrote each text) is kept on the ads' creative under
 *   `promote`, so values the rows can't hold survive a reload, a notification tap and "Make a copy".
 * - updatePromotionDraft takes only draft-paths keys, refuses a stale write (409 "Someone else changed this draft. Showing the
 *   latest.") and returns the before values for Undo. A save that fails leaves the draft's version as it was, so the next edit
 *   isn't taken for someone else's. Discard and restore are ads/service's (PRM-05).
 * - Goals (and chosen places) are only those the member is offered: PROMOTE_GOALS and the D22 verify states, the same filter as
 *   the catalog route. Create and a goal change refuse any other; the card is blocked when the draft's goal isn't offered.
 * - The special-category question (3.1, D9) is answered only by the member on the page (`categoryAnswer`, or a page edit of
 *   specialAdCategory), never by Eddy and never by a create body. The answer covers what was detected when it was given: each
 *   text and brand industry that suggests a category; a new or changed one asks again.
 * - reviewPromotion builds the Start card (6.5): facts with every text, link and first message verbatim, warnings, the cost
 *   (presentCost on Phase 0's headroom), readiness failures, the policy pre-flight, preview references, the typed-confirmation
 *   flag and the material hash (material.ts). It writes nothing except a startMode 'now' draft's dates, recomputed from runDays
 *   in the ad account's zone (3.1a), which keeps the draft's version (the dates follow from runDays; nobody edited anything).
 * - startPromotion: refused unless Start is open (canStart), in a demo workspace, or while the client hasn't approved. It
 *   rebuilds the card and answers 409 changed when the material changed or the worst case rose more than 0.5%, asks for the
 *   typed figure at 50% or more of this month's room, and stops on what blocks the run or a video Meta is still preparing.
 *   Before anything is written it also stops on a card that isn't ready (spending stopped, no limit, not connected, Start
 *   closed, or doesn't fit, with Phase 0's copy and fixes). Then, in order: it pauses what a fix copy replaces (3.9, a
 *   lowering: the original's ad set or campaign when the copy replaces all of it, so its room is freed; the ad alone otherwise,
 *   and the card says that frees no room); uploads images not yet on Meta (D34); creates or reuses the draft's lead form;
 *   launchCampaign (all PAUSED, resuming a launch that failed part-way); reads the launched rows back and answers 409 changed
 *   (still PAUSED) when they aren't what the card showed; activateCampaign confirming the total the member confirmed. A
 *   refusal carries Phase 0's code, its copy verbatim and the fixes that fit; after launch the campaign stays PAUSED; an
 *   unclear final answer is `unknown` and is never tried again here.
 * - savePromotionPaused runs the same preparation and the launch only, and says "saved" only once the campaign is paused on Meta.
 *
 * Nothing here talks to Meta directly: every write goes through ads/service, ads/actions, promote/media or promote/lead-forms.
 */
import { hashCanonical } from "@/lib/actions/canonical";
import { u } from "@/lib/actions/untrusted";
import type { UntrustedText } from "@/lib/actions/types";
import { pauseAd, pauseAdSet } from "@/lib/ads/actions";
import { detectSpecialCategoryTerms, urlWords } from "@/lib/ads/category-terms";
import { isNewFlowSurface, parseDraftInput, readReplacesAdIds, type DraftSurface } from "@/lib/ads/draft-input";
import {
  activateCampaign,
  AdsMediaNotReadyError,
  createCampaignDraft,
  creativeMediaIds,
  discardDraft,
  DRAFT_DISCARDED,
  isEditableDraft,
  launchCampaign,
  pauseCampaign,
  restoreDraft,
  updateCampaignDraft,
  userSpendActor,
  validateCampaign,
} from "@/lib/ads/service";
import { parseTargeting } from "@/lib/ads/targeting";
import { isCategory, type SpecialAdCategory } from "@/lib/ads/types";
import { isCampaignClientApproved, listApprovals } from "@/lib/approvals";
import { checkPolicy, type Finding } from "@/lib/creative/policy";
import { prisma } from "@/lib/db";
import { adsHeadroomDetail, type AdsHeadroomDetail } from "@/lib/spend/book";
import { spendCopy, type SpendCopyCode, type SpendCopyParams } from "@/lib/spend/copy";
import { isDemoWorkspace } from "@/lib/spend/demo";
import { serializeCopyParams, SpendBlockedError, SpendBusyError } from "@/lib/spend/errors";
import { jsonSafe, spendErrorResponse } from "@/lib/spend/http";
import { dayKey, resolveTimeZone } from "@/lib/spend/periods";
import type { SpendActor } from "@/lib/spend/types";
import { errorResponse, hasRole, HttpError, requireRole, type Actor } from "@/lib/tenancy";
import { availableGoals, rowVisible, verifyStateOf } from "./catalog";
import { CTA_BY_GOAL, ctaTypeFor } from "./catalog/cta";
import { checkText, carouselProblem, type TextProblem } from "./catalog/formats";
import { goalOfLegacyTemplate, goalRow } from "./catalog/goals";
import { placementRow, resolvePositions } from "./catalog/placements";
import { DEFAULT_PREVIEW_TABS } from "./catalog/preview-formats";
import { formatMoney, promoteText, type PromoteCopyKey } from "./copy";
import { budgetStep, fixesFor, fixLabel, majorUnit, presentCost, type FixCode } from "./cost";
import { loadDefaultFacts, smartDefaults, type DefaultChip, type DefaultRequest } from "./defaults";
import { applyPaths, defaultDraft, DraftPathError, isDraftPath } from "./draft-paths";
import { runDates, whenLine, zoneNote } from "./dates";
import type { PromoteAccess } from "./flags";
import { presetSpec } from "./form-presets";
import { buildMaterial, creativeMaterial, audienceMaterial, materialDiff, materialHash, type Material } from "./material";
import { checkPromotionSetup, type PrereqRow } from "./prereqs";
import { accessFor, PROMOTE_START_CLOSED } from "./route-guard";
import { getPromoteSettings } from "./settings";
import { isGoalKey, isSourceKind, type DraftVersion, type GoalKey, type PlacementKey, type PromoteLang, type PromotionDraft, type SourceKind } from "./types";

type Env = Record<string, string | undefined>;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

// =====================================================================================================================
// Copy and errors
// =====================================================================================================================

export const SERVICE_COPY = {
  stale: promoteText("draft.conflict"),
  expectedUpdatedAt: "Reload the draft, then try again.",
  notPromoteDraft: "This campaign was made in All settings. Change it there.",
  notEditable: "Only a draft that isn't on Meta yet can be changed. Change the budget or end date instead.",
  connectPage: "Connect a Facebook Page first. Ads run from a Page.",
  choosePage: "Choose the Facebook Page your ad runs from.",
  badBody: "Send the draft as an object.",
  badSet: "Send the changes as {path: value}.",
  badGoal: "Choose what your ad should do (a goal from the list).",
  badSource: "Choose a new ad or a post to boost.",
  badDays: "Choose how many days the ads run.",
  badMoney: "Send the amounts as whole numbers in the smallest unit of the currency.",
  badHash: "Review the ad again, then tap Start.",
  alreadyRunning: "These ads are already running.",
  chooseForm: "Choose a form or make one, then start again.",
  mediaFailed: "A picture couldn't be sent to Meta. Pick it again, or try again in a few minutes.",
  pauseOriginalFailed: "The rejected ad couldn't be paused, so the copy wasn't started. Try again in a minute.",
  originalStaysPaused: "The rejected ad stays paused.",
  originalHoldsRoom: (names: string) => `${names} shares its ad set with ads that keep running, so pausing it frees no room in your limits.`,
  saved: "Saved on Meta, paused. Nothing is spent until you start it.",
  notSaved: "The ads aren't saved on Meta yet. Try again in a minute.",
  notReady: "This can't start yet. Check the card for what to fix.",
  goalNotOffered: "This goal isn't open yet. Choose another goal.",
  noGoals: "No goal is open for ads from here yet. Try again later.",
  placesNotOffered: (names: string) => `These places aren't open yet: ${names}. Choose Automatic or other places.`,
  badCategory: "Choose a category from the list, or none.",
  memberAnswers: "Only you can answer this. Answer it on the Promote page.",
  lower: (amount: string) => `The most these ads can spend is now lower: ${amount}.`,
  nearShop: (label: string, km: number) => `People within ${km} km of ${label}, 18+`,
  chosen: "People you chose",
  newForm: (count: number) => `A new form with ${count} questions`,
  leadsGo: "Leads hub, with a WhatsApp welcome when it is on",
  versions: (letters: string, share: string) => `${letters} · ${share} each`,
  days: (budget: string, days: number) => `${budget} · ${days} days`,
} as const;

/** A refusal with a code the page and Eddy act on, and anything else the answer needs (chips, the latest draft, a card). */
export class PromoteError extends HttpError {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(status, message);
    this.name = "PromoteError";
  }
  toJSON() {
    return jsonSafe({ error: this.message, code: this.code, ...this.extra }) as Record<string, unknown>;
  }
}

/** The JSON answer for any error of this service: codes and extras for its own errors and Phase 0's, plain errors otherwise. */
export function promoteErrorResponse(error: unknown, request?: Request): Response {
  if (error instanceof PromoteError) return Response.json(error.toJSON(), { status: error.status });
  if (error instanceof DraftPathError) return Response.json({ error: promoteText(error.key), code: error.code, path: error.path }, { status: 400 });
  if (error instanceof AdsMediaNotReadyError) return Response.json(error.toJSON(), { status: 409 });
  if (error instanceof SpendBlockedError || error instanceof SpendBusyError) return spendErrorResponse(error);
  return errorResponse(error, request);
}

// =====================================================================================================================
// The stored draft (5.4 Ad.creative.promote)
// =====================================================================================================================

/** Who wrote a text: the member on the page, Eddy (the model), or a post's caption copied from Meta. */
export type TextSource = "member" | "eddy" | "caption";

/** What a promotion keeps on its ads' creative under `promote`. */
export type PromoteExtras = {
  v: 1;
  /** The draft-paths view, bigints as strings. */
  draft: Record<string, unknown>;
  /** The lead form Start creates when no saved form is chosen (validated by promote/lead-forms at Start). */
  formSpec?: unknown;
  /** A boosted post's caption, as Meta gave it: shown as untrusted text on the card. */
  caption?: string | null;
  postKind?: "reel" | "post" | "story" | "video" | null;
  /** Who wrote each text path ("text.primary", "versions.B.text.link", "welcome.message"...). */
  provenance?: Record<string, TextSource>;
  /** The member's answer to the special-category question, with what it covers. */
  categoryAck?: CategoryAck | null;
  /** Written by an earlier version, which counted any write of the key as an answer. Never read: the question is asked again. */
  categoryAnswered?: boolean;
  pageAssetId?: string | null;
  igAssetId?: string | null;
};

/**
 * The member's answer to the special-category question (3.1, D9), tied to what was detected when they gave it. An answer of
 * "none" covers only those detections: a text or brand industry that suggests a category later is asked about again.
 */
export type CategoryAck = {
  /** The category the member chose. */
  answer: SpecialAdCategory;
  /** The detections the answer covers (categoryHitKeys). */
  keys: string[];
  /** The brand kit's category the member overrode with "none"; null when the brand kit names none. */
  brand: SpecialAdCategory | null;
};

const isCategoryAck = (v: unknown): v is CategoryAck => isObj(v) && isCategory(v.answer) && Array.isArray(v.keys) && v.keys.every((k) => typeof k === "string") && (v.brand === null || isCategory(v.brand));

const BIGINT_PATHS = [
  ["budget", "dailyMinor"],
  ["budget", "lifetimeMinor"],
  ["bid", "amountMinor"],
] as const;

/** The view as JSON (bigints as decimal strings). */
export function serializeDraft(view: PromotionDraft): Record<string, unknown> {
  return jsonSafe(view) as Record<string, unknown>;
}

/** A stored view back to the draft-paths shape; null when it isn't one. */
export function deserializeDraft(raw: unknown): PromotionDraft | null {
  if (!isObj(raw) || !isGoalKey(raw.goal)) return null;
  const out = structuredClone(raw) as Record<string, Record<string, unknown>>;
  for (const [group, key] of BIGINT_PATHS) {
    const g = out[group];
    if (!isObj(g)) continue;
    const v = g[key];
    g[key] = typeof v === "string" && /^\d{1,18}$/.test(v) ? BigInt(v) : typeof v === "number" && Number.isSafeInteger(v) ? BigInt(v) : null;
  }
  const base = defaultDraft(raw.goal);
  const merged = { ...base, ...(out as unknown as PromotionDraft) };
  if (typeof merged.budget?.dailyMinor !== "bigint") merged.budget = { ...base.budget, ...merged.budget, dailyMinor: base.budget.dailyMinor };
  return merged;
}

// =====================================================================================================================
// Rows
// =====================================================================================================================

async function loadRows(tenantId: string, id: string) {
  return prisma.adCampaign.findFirst({ where: { id, tenantId }, include: { adSets: { include: { ads: true }, orderBy: { createdAt: "asc" } }, adTest: true } });
}
type Rows = NonNullable<Awaited<ReturnType<typeof loadRows>>>;
type RowAd = Rows["adSets"][number]["ads"][number];

async function mustLoad(tenantId: string, id: string): Promise<Rows> {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new HttpError(404, "Draft not found.");
  const c = await loadRows(tenantId, id);
  if (!c) throw new HttpError(404, "Draft not found.");
  return c;
}

const allAds = (c: Rows): RowAd[] => c.adSets.flatMap((s) => s.ads);
const creativeOf = (ad: { creative: unknown }): Record<string, unknown> => (isObj(ad.creative) ? ad.creative : {});

/** The extras of the first ad that carries them. */
export function extrasOf(c: Pick<Rows, "adSets">): PromoteExtras | null {
  for (const ad of c.adSets.flatMap((s) => s.ads)) {
    const p = creativeOf(ad).promote;
    if (isObj(p) && p.v === 1 && isObj(p.draft)) return p as unknown as PromoteExtras;
  }
  return null;
}

const versionOfAd = (ad: RowAd | undefined): DraftVersion => {
  const c = ad ? creativeOf(ad) : {};
  const media = isObj(c.media) ? c.media : {};
  return {
    text: { primary: str(c.message) ?? "", headline: str(c.headline) ?? "", description: str(c.description) ?? "", link: str(c.link) },
    media: { feed: str(media.feed), vertical: str(media.vertical), square: str(media.square), video: str(media.video) },
  };
};

/** A view rebuilt from the rows alone (an old-wizard campaign, or a draft whose extras were lost). */
export function viewFromRows(c: Rows): PromotionDraft {
  const legacy = goalOfLegacyTemplate(c.template);
  const goal: GoalKey = isGoalKey(c.goal) ? c.goal : (legacy?.goal ?? "engagement");
  const view = defaultDraft(goal, { name: c.name, dailyMinor: BigInt(c.dailyBudgetMinor) });
  const first = c.adSets[0];
  const ad = first?.ads[0];
  const creative = ad ? creativeOf(ad) : {};
  const t = parseTargeting(first?.targeting);
  const pin = t.geo.customLocations?.[0];
  const sourceKind: SourceKind = isSourceKind(c.sourceKind) ? c.sourceKind : (legacy?.source ?? "new");
  const a = versionOfAd(ad);
  const versionAd = (key: "B" | "C") => c.adSets.find((s) => s.variantKey === key)?.ads[0] ?? c.adSets[0]?.ads.find((x) => x.variantLabel === key);
  const iceBreakers = Array.isArray(creative.iceBreakers) ? (creative.iceBreakers as { title: string; response: string }[]) : [];
  return {
    ...view,
    source: { kind: sourceKind, ref: c.sourceRef ?? null },
    format: ad?.format === "single_video" || ad?.format === "carousel" || ad?.format === "existing_post" ? ad.format : sourceKind === "new" ? "single_image" : "existing_post",
    text: { ...a.text, description: a.text.description },
    ctaType: str(creative.ctaType),
    welcome: { message: str(creative.welcomeMessage) ?? "", iceBreakers },
    media: a.media,
    cards: Array.isArray(creative.cards) ? (creative.cards as PromotionDraft["cards"]).map((k) => ({ mediaId: k.mediaId, headline: k.headline ?? "", description: k.description ?? "", link: k.link ?? null })) : [],
    audience: {
      ...view.audience,
      mode: pin ? "near_shop" : t.advantageAudience ? "meta_finds" : "i_choose",
      countries: t.geo.countries.length ? t.geo.countries : view.audience.countries,
      ageMin: Math.max(18, t.ageMin),
      ageMax: t.ageMax >= 65 ? null : t.ageMax,
      genders: t.genders,
      interests: t.interests,
      customAudienceIds: t.customAudienceIds ?? [],
      excludedAudienceIds: t.excludedAudienceIds ?? [],
      nearShop: pin ? { lat: pin.lat, lng: pin.lng, radiusKm: pin.radiusKm, label: pin.label ?? "" } : null,
    },
    placements: { ...view.placements, mode: c.placementMode === "instagram" || c.placementMode === "facebook" || c.placementMode === "custom" ? c.placementMode : "auto", positions: t.placements as PlacementKey[] },
    compare: { mode: c.adTest?.mode === "fair_split" ? "fair_split" : allAds(c).length > 1 ? "meta_picks" : "single", variable: "creative" },
    versions: { B: versionAd("B") ? versionOfAd(versionAd("B")) : null, C: versionAd("C") ? versionOfAd(versionAd("C")) : null },
    enhancementsOptIn: creative.enhancementsOptIn === true,
    urlTags: str(creative.urlTags),
  };
}

/** The member's draft: the stored view, with what only the rows know (name, goal, category, run) taken from them. */
export function viewOf(c: Rows): { view: PromotionDraft; extras: PromoteExtras | null } {
  const extras = extrasOf(c);
  const stored = extras ? deserializeDraft(extras.draft) : null;
  const base = stored ?? viewFromRows(c);
  const view: PromotionDraft = {
    ...base,
    name: c.name,
    goal: isGoalKey(c.goal) ? c.goal : base.goal,
    specialAdCategory: (isCategory(c.specialAdCategory) ? c.specialAdCategory : base.specialAdCategory) as SpecialAdCategory,
    run: {
      runDays: typeof c.runDays === "number" ? c.runDays : base.run.runDays,
      startMode: c.startMode === "at" || c.startMode === "now" ? c.startMode : base.run.startMode,
      startsAt: c.startMode === "at" && c.startsAt ? c.startsAt.toISOString() : null,
    },
  };
  return { view, extras };
}

/** Writes the extras onto every ad of the campaign (a direct write: ads/service keeps only the fields Meta gets). */
async function writeExtras(tenantId: string, campaignId: string, extras: PromoteExtras): Promise<void> {
  const ads = await prisma.ad.findMany({ where: { tenantId, adSet: { campaignId } }, select: { id: true, creative: true } });
  for (const ad of ads ?? []) {
    await prisma.ad.updateMany({ where: { id: ad.id, tenantId }, data: { creative: { ...creativeOf(ad), promote: extras } as never } });
  }
}

// =====================================================================================================================
// The draft as ads/service takes it
// =====================================================================================================================

export type DraftContext = {
  adAccountAssetId: string;
  pageExternalId: string;
  igExternalId: string | null;
  whatsappNumberId: string | null;
  /** The ad account's zone (D30). */
  tz: string;
  /** The Meta form id a lead ad sends (a saved form chosen, or the draft's form after Start created it). */
  leadFormMetaId: string | null;
  sourcePostTargetId: string | null;
  /**
   * The member's "none" (categoryCheck): `terms` when it covers every text and brand industry that suggests a category
   * (acknowledgeSpecialCategoryTerms), `brand` when it overrode the brand kit's category (confirmNoSpecialCategory).
   */
  category: { terms: boolean; brand: boolean };
  now: Date;
};

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const mediaOf = (m: DraftVersion["media"]) => {
  const out: Record<string, string> = {};
  for (const slot of ["feed", "vertical", "square", "video"] as const) if (m[slot] && ID.test(m[slot]!)) out[slot] = m[slot]!;
  return Object.keys(out).length ? out : undefined;
};
const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));

/** The positions the draft sends (Automatic is [] when Meta may choose). */
export function draftPositions(view: PromotionDraft, hasInstagramIdentity: boolean): PlacementKey[] {
  const format = view.source.kind !== "new" ? "existing_post" : view.format === "existing_post" ? "single_image" : view.format;
  return resolvePositions(view.placements.mode, view.placements.positions, view.goal, format, { hasInstagramIdentity, formType: view.formType });
}

/**
 * The body ads/service parses (parseDraftInput) for a view. Only values in a sendable state go to the rows (a carousel of 2 to
 * 10 cards, library ids); the view keeps everything else, so a half-made draft still saves.
 */
export function draftBody(view: PromotionDraft, ctx: DraftContext): Record<string, unknown> {
  const goal = view.goal;
  const cta = CTA_BY_GOAL[goal];
  const row = goalRow(goal);
  const boost = view.source.kind !== "new";
  const format = boost ? "existing_post" : view.format === "existing_post" ? "single_image" : view.format;
  const positions = draftPositions(view, !!ctx.igExternalId);
  const instagramId = ctx.igExternalId && (view.placements.mode !== "facebook" || view.source.kind === "ig_media") ? ctx.igExternalId : undefined;
  const carousel = !boost && format === "carousel" && view.cards.length >= 2 && view.cards.length <= 10 ? view.cards.map((k) => clean({ mediaId: k.mediaId, headline: k.headline, description: k.description, link: k.link })) : undefined;
  const creative = (v: DraftVersion) =>
    clean({
      pageId: ctx.pageExternalId,
      instagramId,
      message: v.text.primary,
      headline: v.text.headline,
      description: v.text.description,
      // Only goals whose button carries a link send the member's link (4.3); engagement goals may add one for LEARN_MORE.
      link: cta.valueFrom === "link" ? (v.text.link ?? undefined) : undefined,
      whatsappNumberId: row.needsWhatsApp ? (ctx.whatsappNumberId ?? undefined) : undefined,
      welcomeMessage: cta.welcomeMessage && view.welcome.message ? view.welcome.message : undefined,
      iceBreakers: cta.welcomeMessage && view.welcome.iceBreakers.length ? view.welcome.iceBreakers : undefined,
      leadFormId: cta.valueFrom === "lead_form" ? (ctx.leadFormMetaId ?? undefined) : undefined,
      format,
      media: boost ? undefined : mediaOf(v.media),
      cards: carousel,
      igMediaId: view.source.kind === "ig_media" ? (view.source.ref ?? undefined) : undefined,
      fbPromotableId: view.source.kind === "fb_post" ? (view.source.ref ?? undefined) : undefined,
      enhancementsOptIn: view.enhancementsOptIn ? true : undefined,
      ctaType: view.ctaType ?? undefined,
      urlTags: cta.urlTags ? (view.urlTags ?? undefined) : undefined,
    });
  const a: DraftVersion = { text: view.text, media: view.media };
  const versions = (["B", "C"] as const).filter((k) => view.versions[k]).map((k) => ({ key: k, creative: creative(view.versions[k]!) }));
  const nearShop = view.audience.mode === "near_shop" ? view.audience.nearShop : null;
  const chooses = view.audience.mode === "i_choose";
  const targeting = {
    geo: { countries: nearShop ? [] : view.audience.countries, cities: [], ...(nearShop ? { customLocations: [{ lat: nearShop.lat, lng: nearShop.lng, radiusKm: nearShop.radiusKm, label: nearShop.label }] } : {}) },
    ageMin: view.audience.ageMin,
    ageMax: view.audience.ageMax ?? 65,
    genders: chooses ? view.audience.genders : [],
    interests: chooses ? view.audience.interests : [],
    placements: positions,
    lookalikeAudienceIds: [],
  };
  const none = view.specialAdCategory === "none";
  const body: Record<string, unknown> = {
    name: view.name.trim() || promoteText(row.copy.title),
    goal,
    sourceKind: view.source.kind,
    sourceRef: view.source.ref,
    sourcePostTargetId: ctx.sourcePostTargetId,
    adAccountAssetId: ctx.adAccountAssetId,
    specialAdCategory: view.specialAdCategory,
    // Only the member's own answer, and only for what it covers, passes ads/service's category guards.
    confirmNoSpecialCategory: none && ctx.category.brand,
    acknowledgeSpecialCategoryTerms: none && ctx.category.terms,
    dailyBudgetMinor: Number(view.budget.dailyMinor),
    runDays: view.run.runDays,
    startMode: view.run.startMode,
    ...(view.run.startMode === "at" && view.run.startsAt ? { startsAt: view.run.startsAt } : {}),
    placementMode: view.placements.mode,
    targeting,
    advantageAudience: view.audience.mode === "meta_finds" && view.specialAdCategory === "none",
    customAudienceIds: chooses ? view.audience.customAudienceIds : [],
    excludedAudienceIds: chooses ? view.audience.excludedAudienceIds : [],
  };
  if (versions.length && view.compare.mode !== "single") {
    body.versions = [{ key: "A", creative: creative(a) }, ...versions];
    body.compareMode = view.compare.mode === "meta_picks" ? "meta_picks" : "fair_split";
  } else {
    body.ads = [{ name: `${body.name as string} ad`, creative: creative(a) }];
  }
  return body;
}

type BrandFacts = { industries: string; bannedWords: string[]; category: SpecialAdCategory };

/**
 * The workspace's brand industries and banned words, and the brand kit's special ad category (for the special-category check;
 * the category is read the way ads/service reads it, so both guards agree).
 */
async function brandFacts(tenantId: string): Promise<BrandFacts> {
  const [brands, flagged] = await Promise.all([
    prisma.brand.findMany({ where: { tenantId }, select: { industry: true, bannedWords: true }, take: 20 }).catch(() => []),
    prisma.brand.findFirst({ where: { tenantId, specialAdCategory: { not: "none" } }, select: { specialAdCategory: true } }).catch(() => null),
  ]);
  const rows = (brands ?? []) as { industry: string | null; bannedWords: string[] | null }[];
  const category = (flagged as { specialAdCategory?: string | null } | null)?.specialAdCategory;
  return {
    industries: rows.map((b) => b.industry).filter((v): v is string => !!v).join(" ; "),
    bannedWords: [...new Set(rows.flatMap((b) => b.bannedWords ?? []))],
    category: (isCategory(category) ? category : "none") as SpecialAdCategory,
  };
}

/** The texts a viewer reads, for the special-category check (every field ads/service checks, and the carousel cards). */
function viewCopy(view: PromotionDraft): string[] {
  const versions = [view.text, view.versions.B?.text, view.versions.C?.text].filter((t): t is DraftVersion["text"] => !!t);
  return [
    view.name,
    view.welcome.message,
    ...versions.flatMap((t) => [t.primary, t.headline, t.description, urlWords(t.link)]),
    ...view.cards.flatMap((k) => [k.headline, k.description, urlWords(k.link)]),
  ];
}

const normText = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();

/**
 * One key per text (and per brand industry line) and per special category it suggests: "credit:copy:<sha>". Detection is per
 * text, so every hit of the joined check is here too, and a text that changes gets a new key.
 */
export function categoryHitKeys(copy: readonly (string | null | undefined)[], industries: string): { key: string; category: string }[] {
  const out = new Map<string, string>();
  for (const raw of copy) {
    if (typeof raw !== "string") continue;
    const text = normText(raw);
    if (!text) continue;
    for (const hit of detectSpecialCategoryTerms([text])) out.set(`${hit.category}:copy:${hashCanonical(text).slice(0, 24)}`, hit.category);
  }
  const industry = normText(industries);
  if (industry) for (const hit of detectSpecialCategoryTerms([], industry)) out.set(`${hit.category}:industry:${hashCanonical(industry).slice(0, 24)}`, hit.category);
  return [...out].map(([key, category]) => ({ key, category })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export type CategoryCheck = {
  /** The categories still to ask about: detections the member's "none" doesn't cover, and a brand kit category not overridden. */
  open: string[];
  detected: { key: string; category: string }[];
  /** acknowledgeSpecialCategoryTerms: every detection is covered by the member's "none". */
  terms: boolean;
  /** confirmNoSpecialCategory: the member overrode the brand kit's category with "none". */
  brand: boolean;
};

/** Pure: what the member's answer covers for this draft (D9). A category other than none needs no answer. */
export function categoryCheck(view: PromotionDraft, ack: CategoryAck | null, brand: BrandFacts): CategoryCheck {
  if (view.specialAdCategory !== "none") return { open: [], detected: [], terms: false, brand: false };
  const detected = categoryHitKeys(viewCopy(view), brand.industries);
  const none = ack?.answer === "none";
  const covered = new Set(none ? ack.keys : []);
  const open = detected.filter((h) => !covered.has(h.key)).map((h) => h.category);
  const brandOverridden = brand.category !== "none" && none && ack.brand === brand.category;
  if (brand.category !== "none" && !brandOverridden) open.push(brand.category);
  return { open: [...new Set(open)], detected, terms: detected.length > 0 && open.length === 0, brand: brandOverridden };
}

/** The member's "none" (or other category), covering what is detected now. */
function ackFor(answer: SpecialAdCategory, view: PromotionDraft, brand: BrandFacts): CategoryAck {
  if (answer !== "none") return { answer, keys: [], brand: null };
  return { answer, keys: categoryHitKeys(viewCopy(view), brand.industries).map((h) => h.key), brand: brand.category !== "none" ? brand.category : null };
}

const categoryQuestion = (open: string[], lang: PromoteLang) =>
  new PromoteError(400, "category_question", promoteText("category.question", {}, lang), { categories: open, detected: open.join(", ") });

/**
 * The answer a write carries, or null. Only the member on the page answers: `categoryAnswer` on create or edit, or an edit of
 * specialAdCategory. Eddy never answers for them (403), and a create body that carries specialAdCategory is not an answer.
 */
function memberAnswer(input: Record<string, unknown>, set: Readonly<Record<string, unknown>>, surface: DraftSurface, kind: "create" | "update"): SpecialAdCategory | null {
  const explicit = input.categoryAnswer;
  if (explicit !== undefined && explicit !== null) {
    if (surface === "eddy") throw new PromoteError(403, "member_answers", SERVICE_COPY.memberAnswers);
    if (!isCategory(explicit)) throw new HttpError(400, SERVICE_COPY.badCategory);
    return explicit as SpecialAdCategory;
  }
  if (kind === "update" && surface !== "eddy" && Object.prototype.hasOwnProperty.call(set, "specialAdCategory") && isCategory(set.specialAdCategory)) return set.specialAdCategory as SpecialAdCategory;
  return null;
}

/** ads/service's own special-category refusals (copy terms, the brand kit's category), as the same question. */
const CATEGORY_PREFIXES = ["Your ad copy, links or brand industry suggest", "Your brand is flagged for the"];
function asCategoryQuestion(e: unknown, lang: PromoteLang): unknown {
  if (e instanceof HttpError && !(e instanceof PromoteError) && e.status === 400 && CATEGORY_PREFIXES.some((p) => e.message.startsWith(p))) return new PromoteError(400, "category_question", promoteText("category.question", {}, lang));
  return e;
}

// =====================================================================================================================
// What the member is offered (PROMOTE_GOALS and the D22 verify states)
// =====================================================================================================================

/** The member's access: the route's, or worked out the same way (with the sandbox lookup PROMOTE_EXPERIMENTAL needs). */
async function accessOf(actor: Actor, opts: ServiceOptions): Promise<PromoteAccess> {
  return opts.access ?? accessFor(actor, opts.env ?? process.env);
}

/** The goals this member may draft and start: the catalog route's filter, at every tier (the tier only hides rows in the UI). */
export function offeredGoals(access: Pick<PromoteAccess, "goals" | "experimental">): GoalKey[] {
  return availableGoals({ goals: access.goals, experimental: access.experimental, sandboxAccount: access.experimental, tier: "all" }).map((g) => g.key);
}

/** Positions the member chose (Choose places) that aren't open yet (D22), as names for the copy. */
function closedPlaces(view: PromotionDraft, access: Pick<PromoteAccess, "experimental">, lang: PromoteLang): string[] {
  if (view.placements.mode !== "custom") return [];
  const name = (k: PlacementKey) => {
    try {
      return promoteText(placementRow(k).nameKey, {}, lang);
    } catch {
      return String(k);
    }
  };
  return view.placements.positions.filter((k) => !rowVisible(verifyStateOf(`placement.${k}`), { sandboxAccount: access.experimental, experimental: access.experimental })).map(name);
}

/** The Meta form id of a saved form the member chose (a LeadForm row id or a Meta form id of this workspace). */
async function formMetaIdOf(tenantId: string, chosen: string | null): Promise<string | null> {
  if (!chosen) return null;
  const form = await prisma.leadForm.findFirst({ where: { tenantId, OR: [{ id: chosen }, { metaFormId: chosen }] }, select: { id: true, metaFormId: true } });
  return form?.metaFormId ?? null;
}

const TEXT_PATH = /^(text\.(primary|headline|description|link)|welcome\.(message|iceBreakers)|versions\.[BC](\.text(\.(primary|headline|description|link))?)?|cards)$/;

/** Who wrote each text path set now. */
function provenanceFor(set: Readonly<Record<string, unknown>>, surface: DraftSurface, prev: Record<string, TextSource> = {}): Record<string, TextSource> {
  const out = { ...prev };
  for (const path of Object.keys(set)) if (TEXT_PATH.test(path)) out[path] = surface === "eddy" ? "eddy" : "member";
  return out;
}

// =====================================================================================================================
// Create, read, update, discard
// =====================================================================================================================

export type ServiceOptions = {
  surface?: "promote" | "eddy";
  lang?: PromoteLang;
  now?: Date;
  env?: Env;
  dryRun?: boolean;
  access?: PromoteAccess;
  /** Who the Spend Book records for Start and Save (launch, pauses, activation): Eddy forwards its via_eddy actor (B14). The signed-in person by default. */
  spendActor?: SpendActor;
};

export type CreateDraftInput = {
  goal?: unknown;
  days?: unknown;
  placements?: unknown;
  nearShop?: unknown;
  source?: unknown;
  pageAssetId?: unknown;
  igAssetId?: unknown;
  /** The daily budget the member typed (minor units). */
  dailyMinor?: unknown;
  /** Any draft-paths values to start with ({path: value}). */
  set?: unknown;
  /** The lead form spec Start creates (lead goals). */
  form?: unknown;
  /** The member's answer to the special-category question, from the page only ("none" or a category). */
  categoryAnswer?: unknown;
};

function parseCreate(input: unknown, lang: PromoteLang): { req: DefaultRequest; set: Record<string, unknown>; sourcePostTargetId: string | null; form: unknown } {
  if (input !== undefined && input !== null && !isObj(input)) throw new HttpError(400, SERVICE_COPY.badBody);
  const i = (input ?? {}) as CreateDraftInput;
  if (i.goal !== undefined && i.goal !== null && !isGoalKey(i.goal)) throw new HttpError(400, SERVICE_COPY.badGoal);
  if (i.days !== undefined && i.days !== null && (typeof i.days !== "number" || !Number.isFinite(i.days))) throw new HttpError(400, SERVICE_COPY.badDays);
  let source: DefaultRequest["source"] = null;
  let sourcePostTargetId: string | null = null;
  if (i.source !== undefined && i.source !== null) {
    if (!isObj(i.source) || !isSourceKind(i.source.kind)) throw new HttpError(400, SERVICE_COPY.badSource);
    const ref = str(i.source.ref);
    if (i.source.kind !== "new" && (!ref || !/^[A-Za-z0-9_:.-]{1,128}$/.test(ref))) throw new HttpError(400, SERVICE_COPY.badSource);
    const postKind = i.source.postKind;
    source = {
      kind: i.source.kind,
      ref,
      caption: typeof i.source.caption === "string" ? i.source.caption.slice(0, 2200) : null,
      postKind: postKind === "reel" || postKind === "post" || postKind === "story" || postKind === "video" ? postKind : null,
      hasLink: i.source.hasLink === true,
    };
    sourcePostTargetId = str(i.source.postTargetId) && ID.test(str(i.source.postTargetId)!) ? str(i.source.postTargetId) : null;
  }
  if (i.set !== undefined && i.set !== null && !isObj(i.set)) throw new HttpError(400, SERVICE_COPY.badSet);
  const set: Record<string, unknown> = { ...((i.set as Record<string, unknown>) ?? {}) };
  if (i.dailyMinor !== undefined && i.dailyMinor !== null) set["budget.dailyMinor"] = i.dailyMinor;
  for (const path of Object.keys(set)) if (!isDraftPath(path)) throw new DraftPathError("unknown_path", path);
  const placements = i.placements === "instagram" || i.placements === "facebook" || i.placements === "auto" ? i.placements : null;
  return {
    req: {
      goal: (i.goal as GoalKey | undefined) ?? null,
      days: typeof i.days === "number" ? i.days : null,
      placements,
      nearShop: i.nearShop === true,
      source,
      pageAssetId: str(i.pageAssetId),
      igAssetId: str(i.igAssetId),
      lang,
    },
    set,
    sourcePostTargetId,
    form: i.form,
  };
}

export type DraftChips = DefaultChip[];

/**
 * create_promotion_draft: a draft with every 3.1 default, saved through ads/service.createCampaignDraft with origin human and
 * the surface it came from. Refused with a chip when there is no spending ad account or no Page (a draft needs both), and
 * refused when the goal (asked, or set) or a chosen place isn't offered to this member (PROMOTE_GOALS, D22).
 */
export async function createPromotionDraft(actor: Actor, input: unknown, opts: ServiceOptions = {}) {
  requireRole(actor, "admin");
  const surface = opts.surface ?? "promote";
  const lang = opts.lang ?? "en";
  const now = opts.now ?? new Date();
  const { req, set, sourcePostTargetId, form } = parseCreate(input, lang);
  const access = await accessOf(actor, opts);
  const offered = offeredGoals(access);
  const facts = await loadDefaultFacts(actor, { allowedGoals: offered, now });
  const d = smartDefaults(facts, req);
  // What the member can fix comes first: the spending account and the Page, then the goal.
  if (!d.adAccount) {
    const chip = d.chips.find((c) => c.key === "choose_spending_account" || c.key === "ask_owner_spending_account")!;
    throw new PromoteError(409, "no_spending_account", chip.text, { chips: [chip] });
  }
  if (!d.page) {
    const chip = d.chips.find((c) => c.key === "choose_page" || c.key === "connect_page");
    throw new PromoteError(409, chip?.key ?? "connect_page", chip?.text ?? SERVICE_COPY.connectPage, { chips: d.chips, pages: facts.pages.map((p) => ({ assetId: p.assetId, name: p.name })) });
  }
  if (!offered.length) throw new PromoteError(409, "no_goals", SERVICE_COPY.noGoals);
  if (req.goal && !offered.includes(req.goal)) throw new PromoteError(400, "goal_not_offered", SERVICE_COPY.goalNotOffered, { goals: offered });

  let view = defaultDraft(d.goal, { country: d.audience.countries[0], dailyMinor: d.budget.dailyMinor, name: d.name });
  const source = req.source;
  view = {
    ...view,
    source: { kind: source?.kind ?? "new", ref: source?.kind && source.kind !== "new" ? (source.ref ?? null) : null },
    format: source?.kind && source.kind !== "new" ? "existing_post" : "single_image",
    placements: { ...view.placements, mode: d.placementMode },
    audience: { ...view.audience, mode: d.audience.mode, countries: d.audience.countries, ageMin: d.audience.ageMin, nearShop: d.audience.nearShop },
    run: { runDays: d.run.runDays, startMode: "now", startsAt: null },
    specialAdCategory: d.specialAdCategory,
    enhancementsOptIn: false,
    ctaType: d.ctaType,
    welcome: d.welcome,
  };
  view = applyPaths(view, set).draft;
  if (!offered.includes(view.goal)) throw new PromoteError(400, "goal_not_offered", SERVICE_COPY.goalNotOffered, { goals: offered });
  const closed = closedPlaces(view, access, lang);
  if (closed.length) throw new PromoteError(400, "places_not_offered", SERVICE_COPY.placesNotOffered(closed.join(", ")));

  // The special-category question (3.1, D9): drafts save after every step, so it is asked instead of refusing the save.
  const answer = memberAnswer(isObj(input) ? input : {}, set, surface, "create");
  if (answer) view = { ...view, specialAdCategory: answer };
  const brand = await brandFacts(actor.tenantId);
  const ack = answer ? ackFor(answer, view, brand) : null;
  const category = categoryCheck(view, ack, brand);
  if (category.open.length) throw categoryQuestion(category.open, lang);

  const extras: PromoteExtras = {
    v: 1,
    draft: {},
    ...(form !== undefined && form !== null ? { formSpec: form } : {}),
    caption: source?.caption ?? null,
    postKind: source?.postKind ?? null,
    provenance: provenanceFor(set, surface),
    categoryAck: ack,
    pageAssetId: d.page.assetId,
    igAssetId: d.instagram?.assetId ?? null,
  };
  const ctx: DraftContext = {
    adAccountAssetId: d.adAccount.assetId,
    pageExternalId: d.page.externalId,
    igExternalId: d.instagram?.externalId ?? null,
    whatsappNumberId: facts.whatsappNumberId,
    tz: d.adAccount.timezone,
    leadFormMetaId: await formMetaIdOf(actor.tenantId, view.leadFormId),
    sourcePostTargetId,
    category: { terms: category.terms, brand: category.brand },
    now,
  };
  const parsed = parseDraftInput(draftBody(view, ctx), { origin: "human", surface, timeZone: ctx.tz, now });
  let campaignId: string;
  try {
    ({ campaignId } = await createCampaignDraft(actor, parsed));
  } catch (e) {
    throw asCategoryQuestion(e, lang);
  }
  await writeExtras(actor.tenantId, campaignId, { ...extras, draft: serializeDraft(view) });
  return { ...(await getPromotionDraft(actor, campaignId)), chips: d.chips, quickQuestionPresets: d.quickQuestionPresets, stepMinor: d.budget.stepMinor };
}

/** get_promotion: the draft as the page and Eddy read it. Agents may read (read-only). */
export async function getPromotionDraft(actor: Actor, id: string) {
  const c = await mustLoad(actor.tenantId, id);
  const { view, extras } = viewOf(c);
  return {
    campaignId: c.id,
    updatedAt: c.updatedAt.toISOString(),
    status: c.status,
    surface: c.surface ?? "wizard",
    editable: isEditableDraft(c) && !c.discardedAt && isNewFlowSurface(c.surface ?? "wizard"),
    discardedAt: c.discardedAt ? c.discardedAt.toISOString() : null,
    currency: c.currency,
    draft: serializeDraft(view),
    caption: extras?.caption ? u("external_text", extras.caption, 2200) : null,
  };
}

export type UpdateDraftInput = { expectedUpdatedAt?: unknown; set?: unknown; restore?: unknown; categoryAnswer?: unknown };

const hasOwn = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

/**
 * update_promotion_draft: draft-paths keys only, all or nothing, on a promote or Eddy draft that is not on Meta yet. A write made
 * against an older version (expectedUpdatedAt) is refused with 409 and the latest draft. Returns the draft and the before values
 * (Undo replays them). `restore: true` brings back a draft discarded in the last 15 minutes. `categoryAnswer` (the page only)
 * answers the special-category question. A goal or chosen place that isn't offered is refused.
 */
export async function updatePromotionDraft(actor: Actor, id: string, input: unknown, opts: ServiceOptions = {}) {
  requireRole(actor, "admin");
  if (!isObj(input)) throw new HttpError(400, SERVICE_COPY.badBody);
  const lang = opts.lang ?? "en";
  if (input.restore === true) {
    await restoreDraft(actor, id, opts.now);
    return { ...(await getPromotionDraft(actor, id)), before: {} };
  }
  const c = await mustLoad(actor.tenantId, id);
  if (c.discardedAt) throw new HttpError(409, DRAFT_DISCARDED);
  if (!isNewFlowSurface(c.surface ?? "wizard")) throw new HttpError(409, SERVICE_COPY.notPromoteDraft);
  if (!isEditableDraft(c)) throw new HttpError(409, SERVICE_COPY.notEditable);
  if (typeof input.expectedUpdatedAt !== "string" || Number.isNaN(Date.parse(input.expectedUpdatedAt))) throw new HttpError(400, SERVICE_COPY.expectedUpdatedAt);
  const conflict = async () => new PromoteError(409, "stale", SERVICE_COPY.stale, { latest: await getPromotionDraft(actor, id) });
  if (new Date(input.expectedUpdatedAt).getTime() !== c.updatedAt.getTime()) throw await conflict();
  const answering = input.categoryAnswer !== undefined && input.categoryAnswer !== null;
  if (!isObj(input.set) && !(answering && (input.set === undefined || input.set === null))) throw new HttpError(400, SERVICE_COPY.badSet);
  const set: Record<string, unknown> = isObj(input.set) ? input.set : {};
  const { view: current, extras } = viewOf(c);
  const applied = applyPaths(current, set);
  let view = applied.draft;
  const before: Record<string, unknown> = { ...applied.before };
  // Who typed the change: the member on the page unless Eddy's action says it wrote it.
  const surface: DraftSurface = opts.surface ?? "promote";

  // Only goals and places this member is offered (PROMOTE_GOALS, D22). A draft whose goal stopped being offered can still be
  // edited (its card is blocked); changing to such a goal is refused.
  const access = await accessOf(actor, opts);
  if (hasOwn(set, "goal") && !offeredGoals(access).includes(view.goal)) throw new PromoteError(400, "goal_not_offered", SERVICE_COPY.goalNotOffered, { goals: offeredGoals(access) });
  if (hasOwn(set, "goal") || Object.keys(set).some((p) => p.startsWith("placements."))) {
    const closed = closedPlaces(view, access, lang);
    if (closed.length) throw new PromoteError(400, "places_not_offered", SERVICE_COPY.placesNotOffered(closed.join(", ")));
  }

  const answer = memberAnswer(input, set, surface, "update");
  if (answer && answer !== view.specialAdCategory) {
    if (!hasOwn(before, "specialAdCategory")) before.specialAdCategory = current.specialAdCategory;
    view = { ...view, specialAdCategory: answer };
  }
  const brand = await brandFacts(actor.tenantId);
  const stored = isCategoryAck(extras?.categoryAck) ? extras.categoryAck : null;
  const ack = answer ? ackFor(answer, view, brand) : stored;
  const category = categoryCheck(view, ack, brand);
  if (category.open.length) throw categoryQuestion(category.open, lang);

  const { categoryAnswered: _legacy, ...kept } = extras ?? { v: 1 as const, draft: {} };
  void _legacy;
  const next: PromoteExtras = { ...kept, v: 1, draft: serializeDraft(view), provenance: provenanceFor(set, surface, extras?.provenance), categoryAck: ack };
  const ctx = await contextOf(actor, c, view, next, opts.now ?? new Date(), category);
  const body = draftBody(view, ctx);
  // The version check and the write are one claim: a write that lands between them loses (count 0) and gets the latest.
  const claimedAt = new Date(Math.max(Date.now(), c.updatedAt.getTime() + 1));
  const claimed = await prisma.adCampaign.updateMany({ where: { id, tenantId: actor.tenantId, updatedAt: c.updatedAt, discardedAt: null }, data: { updatedAt: claimedAt } });
  if (claimed.count !== 1) throw await conflict();
  try {
    await updateCampaignDraft(actor, id, body);
  } catch (e) {
    // Nothing was saved (ads/service writes in one transaction), so the version goes back: the member's next edit must not be
    // refused as someone else's change. Skipped when anyone wrote meanwhile.
    await prisma.adCampaign.updateMany({ where: { id, tenantId: actor.tenantId, updatedAt: claimedAt }, data: { updatedAt: c.updatedAt } }).catch(() => undefined);
    throw asCategoryQuestion(e, lang);
  }
  await writeExtras(actor.tenantId, id, next);
  return { ...(await getPromotionDraft(actor, id)), before: jsonSafe(before) as Record<string, unknown> };
}

/** discard_promotion_draft: a soft discard (ads/service), restorable for 15 minutes. Any surface. */
export async function discardPromotionDraft(actor: Actor, id: string, now?: Date) {
  requireRole(actor, "admin");
  const out = await discardDraft(actor, id, now);
  return { campaignId: out.campaignId, discardedAt: out.discardedAt.toISOString(), restorableUntil: out.restorableUntil.toISOString() };
}

/** The undo of discardPromotionDraft. */
export async function restorePromotionDraft(actor: Actor, id: string, now?: Date) {
  requireRole(actor, "admin");
  return restoreDraft(actor, id, now);
}

/** The Page, Instagram account, number, form and zone a stored draft is built with. */
async function contextOf(actor: Actor, c: Rows, view: PromotionDraft, extras: PromoteExtras | null, now: Date, category: Pick<CategoryCheck, "terms" | "brand">): Promise<DraftContext> {
  const first = creativeOf(allAds(c)[0] ?? { creative: {} });
  const tz = await accountZone(actor.tenantId, c.adAccountAssetId);
  let whatsappNumberId = str(first.whatsappNumberId);
  if (!whatsappNumberId && goalRow(view.goal).needsWhatsApp) {
    whatsappNumberId = (await prisma.phoneNumber.findFirst({ where: { tenantId: actor.tenantId, status: "connected" }, select: { id: true } }))?.id ?? null;
  }
  return {
    adAccountAssetId: c.adAccountAssetId,
    pageExternalId: str(first.pageId) ?? "",
    igExternalId: str(first.instagramId) ?? (extras?.igAssetId ? await externalIdOf(actor.tenantId, extras.igAssetId) : null),
    whatsappNumberId,
    tz,
    leadFormMetaId: view.leadFormId ? await formMetaIdOf(actor.tenantId, view.leadFormId) : str(first.leadFormId),
    sourcePostTargetId: c.sourcePostTargetId ?? null,
    category: { terms: category.terms, brand: category.brand },
    now,
  };
}

async function externalIdOf(tenantId: string, assetId: string): Promise<string | null> {
  const row = await prisma.metaAsset.findFirst({ where: { id: assetId, tenantId }, select: { externalId: true } });
  return row?.externalId ?? null;
}

/** The ad account's IANA zone (D30); the default zone when the account reports none. */
async function accountZone(tenantId: string, adAccountAssetId: string): Promise<string> {
  const row = await prisma.metaAsset.findFirst({ where: { id: adAccountAssetId, tenantId }, select: { meta: true } });
  const meta = isObj(row?.meta) ? row.meta : {};
  return resolveTimeZone(typeof meta.timezone === "string" ? meta.timezone : null);
}

// =====================================================================================================================
// The card (6.5)
// =====================================================================================================================

export type CardState =
  | "ready"
  | "running"
  | "blocked"
  | "doesnt_fit"
  | "spend_frozen"
  | "spend_not_set_up"
  | "awaiting_approval"
  | "demo"
  | "start_closed"
  | "not_connected";

export type CardFact = { key: string; label: string; value: string; caption?: UntrustedText | null };
export type CardWarning = { code: string; text: string };
export type CardText = {
  version: string;
  primary: string;
  /** The primary text clipped at 300 characters, with `primary` holding all of it ([Show all]). */
  primaryShort: string;
  clipped: boolean;
  headline: string;
  description: string;
  link: string | null;
  linkDomain: string | null;
  button: string | null;
};
export type FixView = { kind: string; label: string; toMinor?: bigint; days?: number; at?: Date };

export type ReviewCard = {
  campaignId: string;
  updatedAt: string;
  status: string;
  state: CardState;
  canStart: boolean;
  title: string;
  primary: string;
  secondary: string;
  facts: CardFact[];
  text: { versions: CardText[]; firstMessage: string | null; quickQuestions: { title: string; response: string }[]; caption: UntrustedText | null };
  warnings: CardWarning[];
  cost: (ReturnType<typeof presentCost> & { worstThisMonth: string }) | null;
  /** The fixes for a run that doesn't fit what is left (only fixes that fit). */
  fixes: FixView[];
  readiness: { ready: boolean; rows: PrereqRow[] } | null;
  issues: string[];
  /** The draft paths the card's [Edit] changes without the model (6.5): ₹ per day, days and goal. */
  editable: readonly string[];
  /** `unanswered`: the special categories the member still has to answer about (the question chip), empty when none. */
  policy: { findings: Finding[]; categories: string[]; format: string[]; unanswered: string[] };
  previews: { draftId: string; placements: PlacementKey[]; kind: "meta" | "local" };
  typedConfirmRequired: boolean;
  /** The sum of the ad sets' daily budgets: what Start confirms (confirmedTotalMinor). */
  dailyTotalMinor: bigint;
  /** The worst case the button shows (confirmedWorstCaseMinor). */
  worstCaseMinor: bigint;
  material: Material;
  materialHash: string;
  stateText: string | null;
};

/** What only Start needs from building the card. */
type CardInternals = {
  c: Rows;
  view: PromotionDraft;
  extras: PromoteExtras | null;
  tz: string;
  headroom: AdsHeadroomDetail | null;
  leftTodayMinor: bigint | null;
  leftMonthMinor: bigint | null;
  pending: { videos: string[]; images: string[] };
  pausesAdIds: string[];
  /** How Start pauses what a fix copy replaces (3.9). */
  originals: OriginalsPlan;
  formChosen: string | null;
  formSpec: unknown;
  pageAssetId: string | null;
  awaitingApproval: boolean;
  demo: boolean;
  blocking: string[];
  /** The refusal a card that doesn't fit stands for (Phase 0's code and its figures). */
  fit: { code: SpendCopyCode; params: SpendCopyParams } | null;
  access: PromoteAccess;
};

/**
 * How Start pauses the ads a fix copy replaces (3.9). Pausing an ad frees no room in Phase 0 (its ad set is the commitment), so
 * the original's ad set is paused when the copy replaces every ad in it, and its campaign when it replaces every ad set.
 */
export type OriginalsPlan = {
  /** Campaigns to pause (pauseCampaign): every non-archived ad set in them is replaced. */
  campaigns: { id: string; name: string }[];
  /** Ad sets to pause (pauseAdSet): every non-archived ad in them is replaced. */
  adSets: { metaAdSetId: string; name: string }[];
  /** Ads paused alone (pauseAd): other ads in their ad set keep running, so no room is freed. */
  ads: { metaAdId: string; name: string }[];
  /** The replaced ads whose ad set keeps running: their room stays held (the card says so). */
  roomHeld: string[];
  /** True when the pause frees room (an ad set or campaign is paused, or already was). */
  freesRoom: boolean;
};

const NO_ORIGINALS: OriginalsPlan = Object.freeze({ campaigns: [], adSets: [], ads: [], roomHeld: [], freesRoom: false }) as OriginalsPlan;

/** Works out what to pause for a fix copy (3.9). Reads only. */
async function planOriginals(tenantId: string, ids: readonly string[]): Promise<OriginalsPlan> {
  if (!ids.length) return NO_ORIGINALS;
  type A = { id: string; name: string; metaAdId: string | null; status: string; adSetId: string };
  type S = { id: string; name: string; metaAdSetId: string | null; status: string; campaignId: string };
  const originals = ((await prisma.ad.findMany({ where: { tenantId, id: { in: [...ids] } }, select: { id: true, name: true, metaAdId: true, status: true, adSetId: true } })) ?? []) as A[];
  const onMeta = originals.filter((a) => a.metaAdId && a.status !== "archived");
  if (!onMeta.length) return NO_ORIGINALS;
  const setIds = [...new Set(onMeta.map((a) => a.adSetId))];
  const [sets, siblings] = await Promise.all([
    prisma.adSet.findMany({ where: { tenantId, id: { in: setIds } }, select: { id: true, name: true, metaAdSetId: true, status: true, campaignId: true } }) as Promise<S[]>,
    prisma.ad.findMany({ where: { tenantId, adSetId: { in: setIds } }, select: { id: true, adSetId: true, status: true } }) as Promise<{ id: string; adSetId: string; status: string }[]>,
  ]);
  const replaced = new Set(ids);
  const wholeSet = (s: S) => !!s.metaAdSetId && (siblings ?? []).filter((a) => a.adSetId === s.id && a.status !== "archived").every((a) => replaced.has(a.id));
  const whole = (sets ?? []).filter(wholeSet);
  const wholeIds = new Set(whole.map((s) => s.id));
  const campaignIds = [...new Set(whole.map((s) => s.campaignId))];
  const [campaignSets, campaigns] = campaignIds.length
    ? await Promise.all([
        prisma.adSet.findMany({ where: { tenantId, campaignId: { in: campaignIds } }, select: { id: true, status: true, campaignId: true } }) as Promise<{ id: string; status: string; campaignId: string }[]>,
        prisma.adCampaign.findMany({ where: { tenantId, id: { in: campaignIds } }, select: { id: true, name: true, status: true, metaCampaignId: true } }) as Promise<{ id: string; name: string; status: string; metaCampaignId: string | null }[]>,
      ])
    : [[], []];
  const wholeCampaigns = (campaigns ?? []).filter((c) => c.status === "active" && !!c.metaCampaignId && (campaignSets ?? []).filter((s) => s.campaignId === c.id && s.status !== "archived").every((s) => wholeIds.has(s.id)));
  const byCampaign = new Set(wholeCampaigns.map((c) => c.id));
  const live = (status: string) => status !== "paused" && status !== "archived";
  return {
    campaigns: wholeCampaigns.map((c) => ({ id: c.id, name: c.name })),
    adSets: whole.filter((s) => !byCampaign.has(s.campaignId) && live(s.status)).map((s) => ({ metaAdSetId: s.metaAdSetId!, name: s.name })),
    ads: onMeta.filter((a) => !wholeIds.has(a.adSetId) && live(a.status)).map((a) => ({ metaAdId: a.metaAdId!, name: a.name })),
    roomHeld: onMeta.filter((a) => !wholeIds.has(a.adSetId)).map((a) => a.name),
    freesRoom: whole.length > 0,
  };
}

/** 6.5 editable fields. */
export const CARD_EDITABLE: readonly string[] = Object.freeze(["budget.dailyMinor", "run.runDays", "goal"]);

const LINK_OR_NUMBER = /(https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|in|net|org|co|io|app|shop|store|me|ly|info|biz|xyz|link|site|online)\b|\+?\d[\d\s().-]{7,}\d/i;

/** True when a text carries a link or a phone number (6.5 contains_link_or_number). */
export function hasLinkOrNumber(text: string | null | undefined): boolean {
  return typeof text === "string" && LINK_OR_NUMBER.test(text);
}

function domainOf(link: string | null): string | null {
  if (!link) return null;
  try {
    return new URL(link).hostname;
  } catch {
    return null;
  }
}

const clip300 = (s: string) => (s.length > 300 ? `${s.slice(0, 300)}…` : s);

async function approvalPending(tenantId: string, id: string): Promise<boolean> {
  const approvals = await listApprovals(tenantId, "ad_campaign", id).catch(() => []);
  if (!approvals.length) return false;
  return !(await isCampaignClientApproved(tenantId, id).catch(() => false));
}

/** The daily total activateCampaign confirms: each ad set's daily budget (the versions' shares), or its lifetime budget alone. */
function confirmTotal(c: Rows): number {
  return c.adSets.reduce((sum, s) => {
    const lifetimeOnly = s.dailyBudgetMinor === null && s.lifetimeBudgetMinor !== null && s.lifetimeBudgetMinor !== undefined;
    return sum + (lifetimeOnly ? Number(s.lifetimeBudgetMinor) : (s.dailyBudgetMinor ?? c.dailyBudgetMinor));
  }, 0);
}

const isDraftStatus = (c: Pick<Rows, "status" | "metaCampaignId">) => (c.status === "draft" || c.status === "error") && !c.metaCampaignId;

/** A campaign Start still has to launch: a draft, a launch that failed (part-way or not), or one being launched. */
const needsLaunch = (c: Pick<Rows, "status">) => c.status === "draft" || c.status === "error" || c.status === "launching";

/**
 * Builds the card. Writes only a startMode 'now' draft's recomputed dates (3.1a), and only when they moved (a new day), so the
 * same card stays valid all day. That write keeps the draft's version (updatedAt): the dates follow from runDays and today and
 * nobody edited anything, so the member's next edit isn't taken for someone else's.
 */
async function buildCard(actor: Actor, id: string, opts: ServiceOptions): Promise<{ card: ReviewCard; internal: CardInternals }> {
  const tenantId = actor.tenantId;
  const lang = opts.lang ?? "en";
  const now = opts.now ?? new Date();
  const c = await mustLoad(tenantId, id);
  if (c.discardedAt) throw new HttpError(409, DRAFT_DISCARDED);
  const access = await accessOf(actor, opts);
  const { view, extras } = viewOf(c);
  const tz = await accountZone(tenantId, c.adAccountAssetId);
  const currency = c.currency;
  const blocking: string[] = [];

  // ----- Dates (3.1a): a 'now' draft runs runDays from today, whenever it is started.
  let startsAt: Date = c.startsAt && c.startsAt.getTime() > now.getTime() ? c.startsAt : now;
  let startKey = c.startsAt ? c.startsAt.toISOString() : `now:${dayKey(c.launchedAt ?? now, tz)}`;
  if (isDraftStatus(c) && c.startMode === "now" && typeof c.runDays === "number") {
    const d = runDates({ runDays: c.runDays, startMode: "now", tz, now });
    if (c.endsAt?.getTime() !== d.endsAt.getTime() || c.startsAt !== null) {
      await prisma.adCampaign.updateMany({ where: { id, tenantId, status: { in: ["draft", "error"] }, metaCampaignId: null, updatedAt: c.updatedAt }, data: { startsAt: null, endsAt: d.endsAt, updatedAt: c.updatedAt } });
      c.endsAt = d.endsAt;
      c.startsAt = null;
    }
    startsAt = now;
    startKey = `now:${d.startDay}`;
  } else if (isDraftStatus(c) && c.startMode === "at" && c.startsAt) {
    startsAt = c.startsAt;
    startKey = c.startsAt.toISOString();
    if (c.startsAt.getTime() < now.getTime()) blocking.push(promoteText("run.start_passed", {}, lang));
  }
  const endsAt = c.endsAt;
  if (!endsAt) blocking.push("Choose when your ads stop. Ads made here always have an end date.");

  // ----- Money.
  const sets = c.adSets.map((s) => ({ key: s.variantKey ?? s.id, dailyMinor: BigInt(s.dailyBudgetMinor ?? c.dailyBudgetMinor) }));
  const dailyTotal = BigInt(confirmTotal(c));
  let detail: AdsHeadroomDetail | null = null;
  try {
    detail = await adsHeadroomDetail(tenantId, { currency, now });
  } catch {
    detail = null;
  }
  const leftTodayMinor = detail?.headroom.today.left ?? null;
  const leftMonthMinor = detail?.headroom.month.left ?? null;
  // 6.1 rule 6 (D3): only the workspace's spending ad account spends.
  const spending = detail?.state?.spendingAccount;
  if (detail && spending !== undefined && spending?.assetId !== c.adAccountAssetId) blocking.push(spendCopy("spend.not_spending_account"));
  const boost = view.source.kind !== "new";
  let cost: ReviewCard["cost"] = null;
  if (endsAt) {
    try {
      const view6 = presentCost({ sets: sets.map((s) => ({ dailyMinor: s.dailyMinor })), startsAt, endsAt, tz, headroom: { currency, today: { left: leftTodayMinor }, month: { left: leftMonthMinor } }, lang, currency, kind: boost ? "boost" : "ads", now });
      cost = { ...view6, worstThisMonth: promoteText("cost.worst_this_month", { amount: formatMoney(view6.worstMonthMinor, currency) }, lang) };
    } catch (e) {
      blocking.push(e instanceof RangeError ? promoteText("run.too_long", {}, lang) : "The cost couldn't be worked out. Try again.");
    }
  }

  // ----- Readiness (3.2) and local validation (what launch checks anyway).
  const firstCreative = creativeOf(allAds(c)[0] ?? { creative: {} });
  const igExternal = str(firstCreative.instagramId);
  const pageAssetId = extras?.pageAssetId ?? null;
  let readiness: ReviewCard["readiness"] = null;
  try {
    const r = await checkPromotionSetup(actor, {
      goal: view.goal,
      pageAssetId,
      igAssetId: extras?.igAssetId ?? null,
      placements: view.placements.mode === "custom" ? "auto" : view.placements.mode,
      nearShop: view.audience.mode === "near_shop",
      customAudience: view.audience.mode === "i_choose" && view.audience.customAudienceIds.length > 0,
      lang,
    });
    readiness = { ready: r.ready, rows: r.rows.filter((row) => row.status !== "ok") };
  } catch {
    readiness = null;
  }
  let issues: string[] = [];
  if (isDraftStatus(c)) {
    try {
      issues = await validateCampaign(c as never, { now, timeZone: tz });
    } catch (e) {
      issues = [e instanceof HttpError ? e.message : "This draft couldn't be checked. Try again."];
    }
    // A lead ad gets its form at Start (3.5), and its library images are sent at Start (D34): neither blocks the card.
    const formIssue = /leadFormId|lead form/i;
    if (CTA_BY_GOAL[view.goal].valueFrom === "lead_form") issues = issues.filter((m) => !formIssue.test(m));
  }

  // ----- Media (D34): videos must be ready; images not yet on Meta are sent inside the run.
  const mediaIds = [...new Set(allAds(c).flatMap((ad) => creativeMediaIds(ad.creative)))];
  const mediaRows = (mediaIds.length ? await prisma.adMedia.findMany({ where: { tenantId, id: { in: mediaIds } }, select: { id: true, kind: true, status: true, sha256: true } }) : []) as { id: string; kind: string; status: string; sha256: string }[];
  const waiting = (r: { status: string }) => r.status === "pending" || r.status === "uploading" || r.status === "processing";
  const pendingVideos = mediaRows.filter((r) => r.kind === "video" && waiting(r)).map((r) => r.id);
  const pendingImages = mediaRows.filter((r) => r.kind !== "video" && waiting(r)).map((r) => r.id);
  const picturesWaiting = /picture is still being sent to Meta/i;
  issues = issues.filter((m) => !picturesWaiting.test(m) && !/still preparing your video/i.test(m));
  // A video Meta is still preparing is its own state (media_not_ready, with the progress chip), not a fix the member makes.
  const videoWaiting = pendingVideos.length ? promoteText("error.media_not_ready", {}, lang) : null;

  // ----- Texts, verbatim (6.5).
  const goal = view.goal;
  const cta = CTA_BY_GOAL[goal];
  const ads = allAds(c);
  const versions: CardText[] = ads.map((ad, i) => {
    const cr = creativeOf(ad);
    const primary = str(cr.message) ?? "";
    const link = cta.valueFrom === "link" ? str(cr.link) : null;
    const button = ctaTypeFor(goal, str(cr.ctaType), !!link);
    return {
      version: ad.variantLabel ?? c.adSets.find((s) => s.ads.includes(ad))?.variantKey ?? (ads.length > 1 ? String.fromCharCode(65 + i) : "A"),
      primary,
      primaryShort: clip300(primary),
      clipped: primary.length > 300,
      headline: str(cr.headline) ?? "",
      description: str(cr.description) ?? "",
      link,
      linkDomain: domainOf(link),
      button: button ? promoteText(`cta.${button}` as PromoteCopyKey, {}, lang) : null,
    };
  });
  const firstMessage = cta.welcomeMessage ? (str(firstCreative.welcomeMessage) ?? null) : null;
  const quickQuestions = cta.welcomeMessage && Array.isArray(firstCreative.iceBreakers) ? (firstCreative.iceBreakers as { title: string; response: string }[]).map((q) => ({ title: q.title, response: q.response })) : [];
  const caption = extras?.caption ? u("external_text", extras.caption, 2200) : null;

  // ----- Policy pre-flight: creative/policy.ts, special-category terms, formats (4.6).
  const brand = await brandFacts(tenantId);
  const findings = versions.flatMap((v) => checkPolicy({ headline: v.headline, body: v.primary, description: v.description, brand: { bannedWords: brand.bannedWords, specialAdCategory: c.specialAdCategory } }).findings);
  const categories = c.specialAdCategory === "none" ? [...new Set(detectSpecialCategoryTerms(viewCopy(view), brand.industries).map((h) => h.category))] : [];
  const positions = c.adSets[0] ? (parseTargeting(c.adSets[0].targeting).placements as PlacementKey[]) : [];
  const format: string[] = [];
  if (!boost) {
    for (const v of versions) format.push(...checkText({ primary: v.primary, headline: v.headline, description: v.description }, positions, { hasInstagramIdentity: !!igExternal, format: view.format }).problems.map((p: TextProblem) => p.text[lang]));
    if (view.format === "carousel") {
      const p = carouselProblem(view.cards.length);
      if (p) format.push(p.text[lang]);
    }
  }
  const policyBlocks = findings.filter((f) => f.severity === "block").map((f) => f.message);
  // The special-category question (D9) on a draft: a text or brand industry the member's "none" doesn't cover blocks Start
  // until they answer on the page. Once the campaign is on Meta, launch's own check (ads/service) already ran.
  const unanswered = isDraftStatus(c) ? categoryCheck(view, isCategoryAck(extras?.categoryAck) ? extras.categoryAck : null, brand).open : [];
  if (unanswered.length) blocking.push(promoteText("category.question", {}, lang));
  // Only goals and chosen places this member is offered (PROMOTE_GOALS, D22): the same filter as the catalog route.
  if (!offeredGoals(access).includes(goal)) blocking.push(SERVICE_COPY.goalNotOffered);
  const closed = closedPlaces(view, access, lang);
  if (closed.length) blocking.push(SERVICE_COPY.placesNotOffered(closed.join(", ")));

  // ----- Fix copies (3.9): the rejected ads Start pauses first.
  const pausesAdIds = [...new Set(ads.flatMap((ad) => readReplacesAdIds(ad.creative)))].sort();
  const originals = pausesAdIds.length ? ((await prisma.ad.findMany({ where: { tenantId, id: { in: pausesAdIds } }, select: { id: true, name: true } })) as { id: string; name: string }[]) : [];
  const originalsPlan = await planOriginals(tenantId, pausesAdIds);

  // ----- The lead form (3.5).
  const lead = cta.valueFrom === "lead_form";
  const settings = lead ? await getPromoteSettings(tenantId).catch(() => null) : null;
  const formChosen = lead ? view.leadFormId : null;
  const chosenForm = formChosen ? await prisma.leadForm.findFirst({ where: { tenantId, OR: [{ id: formChosen }, { metaFormId: formChosen }] }, select: { id: true, name: true, metaFormId: true } }) : null;
  const formSpec = lead && !formChosen ? (extras?.formSpec ?? presetSpec("generic", { privacyUrl: settings?.privacyUrl ?? null, formType: view.formType, lang })) : null;
  if (lead && formChosen && !chosenForm) blocking.push(SERVICE_COPY.chooseForm);

  // ----- Facts.
  const money = (m: bigint) => formatMoney(m, currency);
  const runDays = view.run.runDays;
  const facts: CardFact[] = [];
  if (boost) facts.push({ key: "post", label: promoteText("card.fact.post", {}, lang), value: promoteText(`kind.${extras?.postKind ?? "post"}` as PromoteCopyKey, {}, lang), caption });
  facts.push({ key: "goal", label: promoteText("card.fact.goal", {}, lang), value: promoteText(goalRow(goal).copy.chip, {}, lang) });
  const who =
    view.audience.mode === "near_shop" && view.audience.nearShop
      ? SERVICE_COPY.nearShop(view.audience.nearShop.label || "your shop", view.audience.nearShop.radiusKm)
      : view.audience.mode === "i_choose"
        ? SERVICE_COPY.chosen
        : promoteText("card.who.meta_finds", { country: countryName(view.audience.countries[0] ?? "IN"), ageMin: String(view.audience.ageMin) }, lang);
  facts.push({ key: "who", label: promoteText("card.fact.who", {}, lang), value: who });
  const where = c.placementMode === "instagram" || c.placementMode === "facebook" ? promoteText(`card.where.${c.placementMode}` as PromoteCopyKey, {}, lang) : c.placementMode === "custom" ? promoteText("card.where.custom", { count: String(positions.length) }, lang) : promoteText("card.where.auto", {}, lang);
  facts.push({ key: "where", label: promoteText("card.fact.where", {}, lang), value: where });
  if (endsAt) facts.push({ key: "when", label: promoteText("card.fact.when", {}, lang), value: whenLine({ startsAt, endsAt }, now, tz, lang) });
  facts.push({ key: "budget", label: promoteText("card.fact.budget", {}, lang), value: SERVICE_COPY.days(promoteText("card.budget_line", { amount: money(dailyTotal) }, lang), runDays) });
  if (c.adSets.length > 1) {
    const letters = c.adSets.map((s) => s.variantKey ?? "").filter(Boolean).join(", ");
    facts.push({ key: "versions", label: promoteText("card.fact.versions", {}, lang), value: SERVICE_COPY.versions(letters, money(sets[0].dailyMinor)) });
  }
  if (lead) {
    const questions = isObj(formSpec) && Array.isArray(formSpec.questions) ? formSpec.questions.length : 0;
    facts.push({ key: "form", label: promoteText("card.fact.form", {}, lang), value: chosenForm?.name ?? SERVICE_COPY.newForm(questions) });
    facts.push({ key: "leads_go", label: promoteText("card.fact.leads_go", {}, lang), value: SERVICE_COPY.leadsGo });
  }
  for (const o of originals) facts.push({ key: "pauses_original", label: promoteText("card.fact.post", {}, lang), value: promoteText("card.pauses_original", { name: o.name }, lang) });

  // ----- Warnings (6.5).
  const warnings: CardWarning[] = [
    { code: "external_meta", text: promoteText("card.goes_to_meta", {}, lang) },
    { code: "meta_reviews", text: promoteText("card.meta_reviews", {}, lang) },
  ];
  const awaitingApproval = await approvalPending(tenantId, id);
  if (awaitingApproval) warnings.push({ code: "needs_approval", text: promoteText("card.waiting_client", {}, lang) });
  if (cost?.lines.monthCross) warnings.push({ code: "month_cross", text: cost.lines.monthCross });
  if (cost?.lines.setAside) warnings.push({ code: "set_aside_from_today", text: cost.lines.setAside });
  const zone = zoneNote(tz, detail?.state?.control?.timezone ?? tz, lang);
  if (zone) warnings.push({ code: "time_zone", text: zone });
  const note = goalRow(goal).copy.note;
  if (note) warnings.push({ code: "replies_outside", text: promoteText(note, {}, lang) });
  if (goal === "whatsapp_chats") warnings.push({ code: "chats_inbox", text: promoteText("chat.leads_note", {}, lang) });
  if (lead) warnings.push({ code: "form_change", text: promoteText("form.change_note", {}, lang) });
  const metaRoom = detail?.headroom.metaLimit?.roomMinor ?? null;
  if (cost && metaRoom !== null && metaRoom < cost.worstMonthMinor) warnings.push({ code: "meta_limit_close", text: promoteText("cost.meta_limit_close", {}, lang) });
  const provenance = extras?.provenance ?? {};
  const notTyped = (path: string) => provenance[path] !== undefined && provenance[path] !== "member";
  const suspicious =
    (boost && hasLinkOrNumber(extras?.caption)) ||
    versions.some((v, i) => {
      const prefix = i === 0 ? "text" : `versions.${v.version}.text`;
      const whole = i === 0 ? false : notTyped(`versions.${v.version}`);
      return (["primary", "headline", "description", "link"] as const).some((f) => (whole || notTyped(`${prefix}.${f}`)) && hasLinkOrNumber(f === "link" ? v.link : v[f]));
    }) ||
    (notTyped("welcome.message") && hasLinkOrNumber(firstMessage)) ||
    (notTyped("welcome.iceBreakers") && quickQuestions.some((q) => hasLinkOrNumber(q.title) || hasLinkOrNumber(q.response)));
  if (suspicious) warnings.push({ code: "contains_link_or_number", text: promoteText("card.contains_link", {}, lang) });
  // 3.9: an original paused on its own frees no room (its ad set keeps running with other ads), so say so.
  if (originalsPlan.roomHeld.length) warnings.push({ code: "original_holds_room", text: SERVICE_COPY.originalHoldsRoom(originalsPlan.roomHeld.map((n) => `'${n}'`).join(", ")) });

  // ----- Material (6.5).
  const shaById = new Map(mediaRows.map((r) => [r.id, r.sha256]));
  const material = buildMaterial({
    campaignId: c.id,
    sets: c.adSets.map((s) => ({ key: s.variantKey ?? "A", dailyBudgetMinor: s.dailyBudgetMinor ?? c.dailyBudgetMinor, lifetimeBudgetMinor: s.lifetimeBudgetMinor ?? null })),
    startsAt: startKey,
    endsAt: endsAt ? endsAt.toISOString() : null,
    timezone: tz,
    currency,
    placements: { mode: c.placementMode ?? "auto", positions: c.adSets.map((s) => parseTargeting(s.targeting).placements) },
    audiences: c.adSets.map((s) => audienceMaterial(s.targeting)),
    creatives: ads.map((ad) => creativeMaterial(ad.creative)),
    mediaShas: ads.flatMap((ad) => creativeMediaIds(ad.creative)).map((m) => shaById.get(m) ?? `missing:${m}`),
    text: { versions: versions.map((v) => ({ version: v.version, primary: v.primary, headline: v.headline, description: v.description, link: v.link, button: v.button })), caption: extras?.caption ?? null },
    welcome: cta.welcomeMessage ? { message: firstMessage, quickQuestions } : null,
    form: lead ? { chosen: chosenForm?.id ?? formChosen ?? null, spec: formSpec, privacyUrl: formChosen ? null : (settings?.privacyUrl ?? null) } : null,
    pausesAdIds,
  });

  // ----- State.
  const demo = await isDemoWorkspace(tenantId).catch(() => false);
  const freeze = detail?.headroom.freeze;
  const blockingRows = readiness?.rows.filter((r) => r.blocks) ?? [];
  const allBlocking = [...blocking, ...issues, ...policyBlocks, ...blockingRows.map((r) => r.detail ?? r.label)];
  let state: CardState = "ready";
  let stateText: string | null = null;
  let fixes: FixView[] = [];
  let fit: CardInternals["fit"] = null;
  const isOwner = actor.role === "owner";
  const fixContext = { currency, tz, lang, isOwner };
  if (c.status === "active") state = "running";
  else if (demo) [state, stateText] = ["demo", promoteText("card.demo", {}, lang)];
  else if (readiness?.rows.some((r) => r.check === "facebook_connected" && r.status === "missing")) [state, stateText] = ["not_connected", readiness.rows.find((r) => r.check === "facebook_connected")?.label ?? null];
  else if (awaitingApproval) [state, stateText] = ["awaiting_approval", promoteText("card.waiting_client", {}, lang)];
  else if (freeze && freeze.effective === "all") [state, stateText] = ["spend_frozen", spendCopy(freeze.platform === "all" ? "spend.platform_frozen" : "spend.frozen")];
  else if (detail && detail.limits.daily === null) [state, stateText] = ["spend_not_set_up", spendCopy("spend.no_limit")];
  else if (allBlocking.length || videoWaiting) state = "blocked";
  else if (cost && !cost.fits) {
    state = "doesnt_fit";
    const code: SpendCopyCode = leftTodayMinor !== null && cost.todayMinor > leftTodayMinor ? "spend.daily_limit" : "spend.monthly_limit";
    const params: SpendCopyParams = { left: { minor: (code === "spend.daily_limit" ? leftTodayMinor : leftMonthMinor) ?? 0n, currency }, needs: { minor: code === "spend.daily_limit" ? cost.todayMinor : cost.worstMonthMinor, currency } };
    stateText = spendCopy(code, params);
    fit = { code, params };
    fixes = fixViews(fixesFor(code, fixInput(view, c, tz, now, leftTodayMinor, leftMonthMinor)), fixContext, await ownerName(tenantId));
  } else if (!access.canStart) [state, stateText] = ["start_closed", PROMOTE_START_CLOSED];

  const worst = cost?.atMostMinor ?? 0n;
  const kindKey = extras?.postKind ?? "post";
  const title = boost
    ? promoteText("card.boost.title", { kind: promoteText(`kind.${kindKey}` as PromoteCopyKey, {}, lang), days: String(runDays) }, lang)
    : goal === "whatsapp_chats"
      ? promoteText("card.whatsapp.title", {}, lang)
      : lead
        ? promoteText("card.lead.title", {}, lang)
        : promoteText("card.ads.title", { days: String(runDays) }, lang);
  const primary = promoteText(boost ? "card.boost.start" : lead ? "card.lead.start" : "card.ads.start", { amount: money(worst) }, lang);

  const card: ReviewCard = {
    campaignId: c.id,
    updatedAt: c.updatedAt.toISOString(),
    status: c.status,
    state,
    canStart: state === "ready",
    title,
    primary,
    secondary: promoteText("card.save_paused", {}, lang),
    facts,
    text: { versions, firstMessage, quickQuestions, caption },
    warnings,
    cost,
    fixes,
    readiness,
    issues: [...new Set([...allBlocking, ...(videoWaiting ? [videoWaiting] : [])])],
    editable: CARD_EDITABLE,
    policy: { findings, categories, format: [...new Set(format)], unanswered },
    previews: { draftId: c.id, placements: positions.length ? positions : [...DEFAULT_PREVIEW_TABS], kind: access.previews },
    typedConfirmRequired: cost?.typedConfirmRequired ?? false,
    dailyTotalMinor: dailyTotal,
    worstCaseMinor: worst,
    material,
    materialHash: materialHash(material),
    stateText,
  };
  return {
    card,
    internal: {
      c,
      view,
      extras,
      tz,
      headroom: detail,
      leftTodayMinor,
      leftMonthMinor,
      pending: { videos: pendingVideos, images: pendingImages },
      pausesAdIds,
      originals: originalsPlan,
      formChosen: chosenForm?.metaFormId ?? null,
      formSpec,
      pageAssetId,
      awaitingApproval,
      demo,
      blocking: [...new Set(allBlocking)],
      fit,
      access,
    },
  };
}

const COUNTRY_NAMES: Readonly<Record<string, string>> = { IN: "India", US: "the United States", GB: "the United Kingdom", AE: "the UAE", SG: "Singapore", AU: "Australia", NP: "Nepal", BD: "Bangladesh", LK: "Sri Lanka", SA: "Saudi Arabia", QA: "Qatar", MY: "Malaysia", KW: "Kuwait", OM: "Oman", BH: "Bahrain" };
const countryName = (code: string) => COUNTRY_NAMES[code] ?? code;

async function ownerName(tenantId: string): Promise<string | null> {
  const row = await prisma.membership.findFirst({ where: { tenantId, role: "owner" }, select: { user: { select: { name: true } } }, orderBy: { createdAt: "asc" } }).catch(() => null);
  return str(row?.user?.name);
}

function fixInput(view: PromotionDraft, c: Rows, tz: string, now: Date, leftTodayMinor: bigint | null, leftMonthMinor: bigint | null) {
  const versions = c.adSets.length;
  return {
    dailyMinor: versions > 1 ? BigInt(confirmTotal(c)) : BigInt(c.adSets[0]?.dailyBudgetMinor ?? c.dailyBudgetMinor),
    runDays: view.run.runDays,
    startMode: view.run.startMode,
    startsAt: view.run.startsAt ? new Date(view.run.startsAt) : null,
    tz,
    now,
    leftTodayMinor,
    leftMonthMinor,
    currency: c.currency,
    stepMinor: budgetStep(c.currency),
    versions,
    minDailyMinor: null,
  };
}

function fixViews(fixes: ReturnType<typeof fixesFor>, ctx: { currency: string; tz: string; lang: PromoteLang; isOwner: boolean }, owner: string | null): FixView[] {
  return fixes.map((f) => ({ ...f, label: fixLabel(f, { ...ctx, owner: owner ?? undefined }) }));
}

/** review_promotion (D26): the Start card, shared by the page and Eddy. */
export async function reviewPromotion(actor: Actor, id: string, opts: ServiceOptions = {}): Promise<ReviewCard> {
  requireRole(actor, "admin");
  return (await buildCard(actor, id, opts)).card;
}

// =====================================================================================================================
// Start and Save without starting (6.1 rules 2, 4, 5, 6, 7, 15)
// =====================================================================================================================

export type StartInput = { confirmedTotalMinor?: unknown; confirmedWorstCaseMinor?: unknown; materialHash?: unknown; typedWorstCase?: unknown };

export type StartOutcome =
  | { state: "started"; campaignId: string; message: string; note?: string; formCreated: boolean }
  | { state: "saved"; campaignId: string; message: string; formCreated: boolean }
  | { state: "changed"; message: string; changed: string[]; card: ReviewCard }
  | { state: "typed_confirm"; message: string; card: ReviewCard }
  | { state: "refused"; code: string; message: string; params?: Record<string, unknown>; fixes: FixView[]; paused: boolean; formCreated: boolean; note?: string }
  | { state: "awaiting_approval"; message: string }
  | { state: "demo"; message: string }
  | { state: "start_closed"; message: string }
  | { state: "needs_approver"; message: string }
  | { state: "not_ready"; message: string; issues: string[] }
  | { state: "media_not_ready"; message: string; mediaIds: string[] }
  | { state: "unknown"; message: string; formCreated: boolean }
  | { state: "failed"; message: string; paused: boolean; formCreated: boolean };

/** The HTTP status of each outcome. */
export function startStatus(o: StartOutcome): number {
  switch (o.state) {
    case "started":
    case "saved":
      return 200;
    case "unknown":
      return 202;
    case "start_closed":
    case "needs_approver":
      return 403;
    case "refused":
      return o.code === "spend.busy" ? 503 : o.code === "spend.only_owner_raise" ? 403 : 409;
    case "failed":
      return 502;
    default:
      return 409;
  }
}

/** Money from JSON: a safe whole number or a string of digits. */
function minorOf(v: unknown): bigint | null {
  if (typeof v === "bigint") return v >= 0n ? v : null;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^\d{1,18}$/.test(v.trim())) return BigInt(v.trim());
  return null;
}

/**
 * True when the typed figure is the worst case shown on the button: the amount as formatted ("₹2,625", "2625", "2,625.00"), or
 * its whole major units rounded either way when the member leaves out the paise.
 */
export function typedMatches(typed: unknown, minor: bigint, currency: string): boolean {
  if (typeof typed !== "string" && typeof typed !== "number") return false;
  const text = String(typed).replace(/[^\d.]/g, "");
  if (!/^\d{1,15}(\.\d{1,4})?$/.test(text)) return false;
  const unit = majorUnit(currency);
  const exp = unit.toString().length - 1;
  const [whole, frac = ""] = text.split(".");
  if (frac.length > exp) return false;
  const typedMinor = BigInt(whole) * unit + (frac ? BigInt(frac.padEnd(exp, "0")) : 0n);
  if (typedMinor === minor) return true;
  if (frac) return false;
  const floor = (minor / unit) * unit;
  const ceil = minor % unit === 0n ? floor : floor + unit;
  return typedMinor === floor || typedMinor === ceil;
}

/** True when the server's worst case is more than 0.5% above what the card showed (6.1 rule 4). */
export const roseMoreThanHalfPercent = (server: bigint, confirmed: bigint): boolean => server * 1000n > confirmed * 1005n;

function refusal(e: SpendBlockedError | SpendBusyError, internal: CardInternals, actor: Actor, owner: string | null, lang: PromoteLang, paused: boolean, formCreated: boolean): StartOutcome {
  const code = e.code as SpendCopyCode;
  const params: SpendCopyParams = e instanceof SpendBlockedError ? e.params : {};
  const amount = (p: SpendCopyParams["left"]) => (p ? BigInt(String(p.minor)) : null);
  const leftToday = code === "spend.daily_limit" && params.left ? amount(params.left) : internal.leftTodayMinor;
  const leftMonth = code === "spend.monthly_limit" && params.left ? amount(params.left) : internal.leftMonthMinor;
  const input = fixInput(internal.view, internal.c, internal.tz, new Date(), leftToday, leftMonth);
  const retryAt = params.retryAt ? new Date(params.retryAt) : null;
  const fixes = fixesFor(code as FixCode, { ...input, retryAt, minutes: params.minutes });
  return {
    state: "refused",
    code,
    message: e.message,
    params: e instanceof SpendBlockedError ? serializeCopyParams(e.params) : undefined,
    fixes: fixViews(fixes, { currency: internal.c.currency, tz: internal.tz, lang, isOwner: actor.role === "owner" }, owner),
    paused,
    formCreated,
    // 3.5: the form stays on Meta (it can't be deleted) and the next try reuses it.
    ...(formCreated && paused ? { note: promoteText("card.form_created_paused", {}, lang) } : {}),
  };
}

/** Sends the images a draft uses that are not on Meta yet (D34): inside the confirmed run. False when one didn't make it. */
async function sendPendingImages(tenantId: string, ids: string[]): Promise<boolean> {
  if (!ids.length) return true;
  const { sendAdMedia } = await import("./media");
  for (const id of ids) {
    const row = await prisma.adMedia.findFirst({ where: { tenantId, id } });
    if (!row) return false;
    const after = row.status === "ready" ? row : await sendAdMedia(row);
    if (after.status !== "ready") return false;
  }
  return true;
}

type Built = { card: ReviewCard; internal: CardInternals };
type Prepared = { ok: true; formCreated: boolean } | { ok: false; outcome: StartOutcome };

const changedOutcome = (card: ReviewCard, changed: string[], lang: PromoteLang): StartOutcome => ({ state: "changed", message: promoteText("card.changed", {}, lang), changed, card });

/** The checks that write nothing: the material, what blocks the run, and videos Meta is still preparing (D34). */
function checkRun(built: Built, hash: unknown, lang: PromoteLang): StartOutcome | null {
  const { card, internal } = built;
  if (typeof hash !== "string" || hash !== card.materialHash) return changedOutcome(card, [], lang);
  if (internal.blocking.length) return { state: "not_ready", message: internal.blocking[0], issues: internal.blocking };
  if (internal.pending.videos.length) return { state: "media_not_ready", message: promoteText("error.media_not_ready", {}, lang), mediaIds: internal.pending.videos };
  return null;
}

/**
 * A card that isn't ready stops Start before anything is written: no pause, no image, no lead form, no ad. Phase 0's copy and
 * fixes when spending is stopped, no limit is set or the run doesn't fit what is left; the plain reason otherwise. Phase 0
 * stays the authority at activation. With `fixRoom`, a fix copy whose originals' ad sets hold the room it lacks goes on:
 * pausing them frees that room, and Start checks the card again right after (3.9).
 */
async function notReady(built: Built, actor: Actor, lang: PromoteLang, fixRoom: boolean): Promise<StartOutcome | null> {
  const { card, internal } = built;
  switch (card.state) {
    case "ready":
    case "running":
      return null;
    case "doesnt_fit":
      if (fixRoom && internal.originals.freesRoom) return null;
      if (internal.fit) return refusal(new SpendBlockedError(internal.fit.code, internal.fit.params), internal, actor, await ownerName(actor.tenantId), lang, false, false);
      break;
    case "spend_frozen":
      return refusal(new SpendBlockedError(internal.headroom?.headroom.freeze?.platform === "all" ? "spend.platform_frozen" : "spend.frozen"), internal, actor, null, lang, false, false);
    case "spend_not_set_up":
      return refusal(new SpendBlockedError("spend.no_limit"), internal, actor, await ownerName(actor.tenantId), lang, false, false);
    case "start_closed":
      return { state: "start_closed", message: PROMOTE_START_CLOSED };
    case "demo":
      return { state: "demo", message: promoteText("card.demo", {}, lang) };
    case "awaiting_approval":
      return { state: "awaiting_approval", message: promoteText("card.waiting_client", {}, lang) };
  }
  const issues = card.issues.length ? card.issues : card.stateText ? [card.stateText] : [SERVICE_COPY.notReady];
  return { state: "not_ready", message: card.stateText ?? issues[0], issues };
}

/**
 * After the launch in this request: the rows as launched, against the card the member confirmed. An edit that landed between
 * the check and the launch's own claim was launched (PAUSED) instead of what the card showed, so the answer is `changed` with
 * the new card and nothing is turned on (6.1 rules 2 and 4, 6.5). Goes on only when the campaign is paused on Meta.
 */
async function launchedAsShown(actor: Actor, id: string, card: ReviewCard, opts: ServiceOptions, formCreated: boolean, lang: PromoteLang): Promise<{ outcome: StartOutcome } | { built: Built }> {
  const after = await buildCard(actor, id, opts);
  if (after.card.materialHash !== card.materialHash) return { outcome: changedOutcome(after.card, materialDiff(card.material, after.card.material), lang) };
  if (after.internal.c.status !== "paused" || !after.internal.c.metaCampaignId) return { outcome: { state: "failed", message: SERVICE_COPY.notSaved, paused: false, formCreated } };
  return { built: after };
}

/**
 * What Start and Save without starting send before the launch, inside the confirmed run: images not on Meta yet (D34) and the
 * draft's lead form (created once, reused on every retry, an unclear answer settled by its name; 3.5). Also for a launch that
 * failed part-way: what it still has to create needs both.
 */
async function prepareRun(actor: Actor, id: string, built: Built, opts: ServiceOptions): Promise<Prepared> {
  const { internal } = built;
  if (!needsLaunch(internal.c)) return { ok: true, formCreated: false };
  if (!(await sendPendingImages(actor.tenantId, internal.pending.images))) return { ok: false, outcome: { state: "media_not_ready", message: SERVICE_COPY.mediaFailed, mediaIds: internal.pending.images } };

  let formCreated = false;
  if (CTA_BY_GOAL[internal.view.goal].valueFrom === "lead_form") {
    let metaFormId = internal.formChosen;
    if (!metaFormId) {
      if (!internal.pageAssetId) return { ok: false, outcome: { state: "not_ready", message: SERVICE_COPY.chooseForm, issues: [SERVICE_COPY.chooseForm] } };
      const forms = await import("./lead-forms");
      try {
        const dryRun = opts.dryRun;
        const result = await forms.ensureDraftForm(actor, id, internal.pageAssetId, internal.formSpec, dryRun === undefined ? {} : { dryRun });
        let form = result.form;
        // A form saved from an earlier spec is never changed on Meta (D13): an edit makes a copy, which keeps the draft's name.
        if (!result.specMatches) form = await forms.copyForm(actor, form.id, internal.formSpec, dryRun === undefined ? {} : { dryRun });
        metaFormId = form.metaFormId;
        formCreated = true;
      } catch (e) {
        if (e instanceof HttpError) return { ok: false, outcome: { state: "not_ready", message: e.message, issues: [e.message] } };
        throw e;
      }
    }
    for (const ad of allAds(internal.c)) {
      const cr = creativeOf(ad);
      if (ad.metaAdId || cr.leadFormId === metaFormId) continue;
      await prisma.ad.updateMany({ where: { id: ad.id, tenantId: actor.tenantId, metaAdId: null }, data: { creative: { ...cr, leadFormId: metaFormId } as never } });
    }
  }
  return { ok: true, formCreated };
}

/**
 * Pauses what a fix copy replaces (3.9, planOriginals): the original's campaign or ad set when the copy replaces all of it, so
 * its room in Phase 0 is freed, else the ad alone. All lowerings (recordLowering): never refused.
 */
async function pauseOriginals(actor: Actor, plan: OriginalsPlan, spendActor?: SpendActor): Promise<boolean> {
  const who = spendActor ?? userSpendActor(actor);
  try {
    for (const c of plan.campaigns) await pauseCampaign(actor, c.id, { spendActor: who, reason: `Paused '${c.name}' before the fixed copy of its rejected ads starts.` });
    for (const s of plan.adSets) await pauseAdSet(actor.tenantId, s.metaAdSetId, who, { reason: `Paused the ad set '${s.name}' before the fixed copy of its rejected ads starts.` });
    for (const a of plan.ads) await pauseAd(actor.tenantId, a.metaAdId, who, { reason: `Paused the rejected ad '${a.name}' before its fixed copy starts.` });
  } catch {
    return false;
  }
  return true;
}

/**
 * Launches (all PAUSED) whenever the campaign still has to be launched: a draft, a launch that failed part-way (status error
 * with its Meta campaign stored: launchCampaign resumes it and never recreates what exists), or one left launching. Skipped once
 * it is paused on Meta. `launched` says whether this request ran the launch.
 */
async function launchStep(actor: Actor, id: string, internal: CardInternals, lang: PromoteLang, formCreated: boolean, spendActor?: SpendActor): Promise<{ outcome: StartOutcome | null; launched: boolean }> {
  if (!needsLaunch(internal.c)) return { outcome: null, launched: false };
  try {
    await launchCampaign(actor, id, spendActor ? { spendActor } : {});
    return { outcome: null, launched: true };
  } catch (e) {
    if (e instanceof SpendBlockedError || e instanceof SpendBusyError) return { outcome: refusal(e, internal, actor, await ownerName(actor.tenantId), lang, false, formCreated), launched: false };
    if (e instanceof AdsMediaNotReadyError) return { outcome: { state: "media_not_ready", message: e.message, mediaIds: e.mediaIds }, launched: false };
    if (e instanceof HttpError) return { outcome: { state: "failed", message: e.message, paused: false, formCreated }, launched: false };
    throw e;
  }
}

/**
 * start_promotion: one tap (D4). See the file comment for the order. Every refusal before the launch sends nothing to Meta.
 */
export async function startPromotion(actor: Actor, id: string, input: unknown, opts: ServiceOptions & { via?: "page" | "eddy" } = {}): Promise<StartOutcome> {
  requireRole(actor, "admin");
  const lang = opts.lang ?? "en";
  const access = await accessOf(actor, opts);
  if (!access.canStart) return { state: "start_closed", message: PROMOTE_START_CLOSED };
  if (await isDemoWorkspace(actor.tenantId)) return { state: "demo", message: promoteText("card.demo", {}, lang) };
  const i = (isObj(input) ? input : {}) as StartInput;
  const confirmedTotal = minorOf(i.confirmedTotalMinor);
  const confirmedWorst = minorOf(i.confirmedWorstCaseMinor);
  if (confirmedTotal === null || confirmedWorst === null) throw new HttpError(400, SERVICE_COPY.badMoney);
  if (typeof i.materialHash !== "string" || !/^[0-9a-f]{64}$/.test(i.materialHash)) throw new HttpError(400, SERVICE_COPY.badHash);

  // Eddy 6.6: through Eddy only the owner or a named approver confirms a start.
  if (opts.via === "eddy" && actor.role !== "owner") {
    const control = await prisma.spendControl.findUnique({ where: { tenantId: actor.tenantId }, select: { approverUserIds: true } });
    if (!(control?.approverUserIds ?? []).includes(actor.userId)) return { state: "needs_approver", message: promoteText("card.needs_approver", { owner: (await ownerName(actor.tenantId)) ?? "the owner" }, lang) };
  }

  const o: ServiceOptions = { ...opts, access };
  let built = await buildCard(actor, id, o);
  const { card } = built;
  let internal = built.internal;
  // Old-wizard campaigns keep their own launch and typed-total confirmation (All settings).
  if (!isNewFlowSurface(internal.c.surface ?? "wizard")) throw new HttpError(409, SERVICE_COPY.notPromoteDraft);
  if (internal.c.status === "active") throw new HttpError(409, SERVICE_COPY.alreadyRunning);
  if (internal.awaitingApproval) return { state: "awaiting_approval", message: promoteText("card.waiting_client", {}, lang) };

  // 6.1 rule 4: what the card showed against what the server sees now.
  if (i.materialHash !== card.materialHash) return changedOutcome(card, [], lang);
  if (confirmedTotal !== card.dailyTotalMinor || roseMoreThanHalfPercent(card.worstCaseMinor, confirmedWorst)) {
    return changedOutcome(card, confirmedTotal !== card.dailyTotalMinor ? ["dailyTotalMinor"] : ["worstCaseMinor"], lang);
  }
  const note = card.worstCaseMinor < confirmedWorst ? SERVICE_COPY.lower(formatMoney(card.worstCaseMinor, internal.c.currency)) : undefined;
  // 6.1 rule 5 (D5): at 50% or more of what is left this month, the figure is typed.
  if (card.typedConfirmRequired && !typedMatches(i.typedWorstCase, card.worstCaseMinor, internal.c.currency)) {
    return { state: "typed_confirm", message: promoteText("card.typed_confirm", { amount: formatMoney(card.worstCaseMinor, internal.c.currency) }, lang), card };
  }
  const check = checkRun(built, i.materialHash, lang);
  if (check) return check;
  // A card that can't start stops here, before anything is written (spending stopped, no limit, doesn't fit...).
  const stop = await notReady(built, actor, lang, true);
  if (stop) return stop;

  // 3.9: a fix copy pauses the rejected original first (a lowering: never refused), so the two never hold room together.
  if (!(await pauseOriginals(actor, internal.originals, opts.spendActor))) return { state: "failed", message: SERVICE_COPY.pauseOriginalFailed, paused: false, formCreated: false };
  if (card.state === "doesnt_fit") {
    // The copy didn't fit while its original held room. With that room freed it has to fit now, or nothing more is sent; the
    // original stays paused (3.9: it wasn't delivering anyway).
    const again = await buildCard(actor, id, o);
    if (again.card.materialHash !== card.materialHash) return changedOutcome(again.card, materialDiff(card.material, again.card.material), lang);
    const still = await notReady(again, actor, lang, false);
    if (still) return still.state === "refused" ? { ...still, note: SERVICE_COPY.originalStaysPaused } : still;
    built = again;
    internal = again.internal;
  }

  const prepared = await prepareRun(actor, id, built, opts);
  if (!prepared.ok) return prepared.outcome;
  const formCreated = prepared.formCreated;

  const step = await launchStep(actor, id, internal, lang, formCreated, opts.spendActor);
  if (step.outcome) return step.outcome;
  if (step.launched) {
    // The draft could still be edited until the launch claimed it: what was launched must be what the card showed.
    const shown = await launchedAsShown(actor, id, card, o, formCreated, lang);
    if ("outcome" in shown) return shown.outcome;
    internal = shown.built.internal;
  }

  // 6.1 rule 2: the guarded activation, confirming the total the member confirmed (the sum of the reviewed ad sets' budgets).
  // activateCampaign checks it against the rows, so a budget that changed after the review is refused, never turned on.
  try {
    await activateCampaign(actor, id, { confirm: true, confirmedTotalMinor: Number(confirmedTotal) }, "activate", opts.spendActor ? { spendActor: opts.spendActor } : {});
  } catch (e) {
    if (e instanceof SpendBlockedError || e instanceof SpendBusyError) return refusal(e, internal, actor, await ownerName(actor.tenantId), lang, true, formCreated);
    // An unclear final answer leaves the campaign counted and active until the reconciler reads Meta: never tried again here.
    const now = await loadRows(actor.tenantId, id).catch(() => null);
    if (now?.status === "active") return { state: "unknown", message: promoteText("card.unknown", {}, lang), formCreated };
    const message = e instanceof HttpError ? e.message : "Couldn't turn the ads on. They are saved on Meta, paused.";
    if (e instanceof HttpError || e instanceof Error) return { state: "failed", message: formCreated ? `${promoteText("card.form_created_paused", {}, lang)} ${message}` : message, paused: true, formCreated };
    throw e;
  }
  return { state: "started", campaignId: id, message: promoteText("card.sent", {}, lang), ...(note ? { note } : {}), formCreated };
}

/**
 * save_promotion_paused: the same preparation, then the launch only (every object PAUSED, nothing spends). Saving spends
 * nothing, so a run that doesn't fit yet, a missing limit or a closed Start don't stop it; spending stopped (Meta creates are
 * refused) and a missing connection do, before anything is written. "saved" only once the campaign is paused on Meta.
 */
export async function savePromotionPaused(actor: Actor, id: string, input: unknown, opts: ServiceOptions = {}): Promise<StartOutcome> {
  requireRole(actor, "admin");
  const lang = opts.lang ?? "en";
  if (await isDemoWorkspace(actor.tenantId)) return { state: "demo", message: promoteText("card.demo", {}, lang) };
  const i = (isObj(input) ? input : {}) as StartInput;
  if (typeof i.materialHash !== "string" || !/^[0-9a-f]{64}$/.test(i.materialHash)) throw new HttpError(400, SERVICE_COPY.badHash);
  const o: ServiceOptions = { ...opts, access: await accessOf(actor, opts) };
  const built = await buildCard(actor, id, o);
  if (!isNewFlowSurface(built.internal.c.surface ?? "wizard")) throw new HttpError(409, SERVICE_COPY.notPromoteDraft);
  if (built.internal.c.status === "active") throw new HttpError(409, SERVICE_COPY.alreadyRunning);
  const check = checkRun(built, i.materialHash, lang);
  if (check) return check;
  if (built.card.state === "spend_frozen" || built.card.state === "not_connected") {
    const stop = await notReady(built, actor, lang, false);
    if (stop) return stop;
  }
  const prepared = await prepareRun(actor, id, built, opts);
  if (!prepared.ok) return prepared.outcome;
  const step = await launchStep(actor, id, built.internal, lang, prepared.formCreated, opts.spendActor);
  if (step.outcome) return step.outcome;
  if (step.launched) {
    const shown = await launchedAsShown(actor, id, built.card, o, prepared.formCreated, lang);
    if ("outcome" in shown) return shown.outcome;
  } else if (built.internal.c.status !== "paused" || !built.internal.c.metaCampaignId) {
    return { state: "failed", message: SERVICE_COPY.notSaved, paused: false, formCreated: prepared.formCreated };
  }
  return { state: "saved", campaignId: id, message: SERVICE_COPY.saved, formCreated: prepared.formCreated };
}

// =====================================================================================================================
// Settings and catalog (read helpers for the routes)
// =====================================================================================================================

/** True when the member may write promotions (owners and admins). */
export const canWritePromotions = (actor: Actor) => hasRole(actor, "admin");

/**
 * What is left of the ads limits today and this month in `currency` (the headroom the review card uses, 6.2), for a card built
 * outside the review: Eddy's later end date (change_end_date). Null when it can't be read; Phase 0 still checks at the tap.
 */
export async function adsHeadroomFor(tenantId: string, currency: string, now = new Date()): Promise<{ currency: string; today: { left: bigint | null }; month: { left: bigint | null } } | null> {
  try {
    const detail = await adsHeadroomDetail(tenantId, { currency, now });
    return { currency, today: { left: detail.headroom.today.left }, month: { left: detail.headroom.month.left } };
  } catch {
    return null;
  }
}

/** The material names that differ between two cards (for logs and tests). */
export const cardChanges = (a: ReviewCard, b: ReviewCard) => materialDiff(a.material, b.material);
