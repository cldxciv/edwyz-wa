/**
 * The body of a campaign draft, checked before anything is saved (docs/IG-PAGE-ADS-SPEC.md 3.1a, 3.8, 4.3, 5.1, 5.4, 6.1
 * rule 3, D28, D31; PRM-05). Pure: no database, no network.
 *
 * - The old wizard's body parses exactly as before (POST and PATCH /api/ads/campaigns).
 * - The new fields: goal, source, format, media (AdMedia ids), carousel cards, quick questions, audiences, versions to
 *   compare (A, B and C, each with its own creative), compare mode, "Let Meta find people", placement mode, run length and
 *   start mode.
 * - surface and origin come only from a trusted caller (opts), never from the body: a route cannot make its draft look like
 *   Eddy's or an assistant's.
 * - A promote or Eddy draft always ends (6.1 rule 3). A run with a daily budget lasts more than 24 hours (D31), counted in
 *   the ad account's time zone (promote/dates); ads/service checks again with the account's own zone before saving.
 */
import { goalRow, templateFor } from "@/lib/promote/catalog/goals";
import { CAROUSEL_MAX_CARDS, CAROUSEL_MIN_CARDS } from "@/lib/promote/catalog/formats";
import { promoteText } from "@/lib/promote/copy";
import { ICE_BREAKER_RESPONSE_MAX, ICE_BREAKER_TITLE_MAX, MAX_ICE_BREAKERS } from "@/lib/promote/creative-shapes";
import { MAX_RUN_DAYS, MIN_RUN_DAYS, runDates, validateRun } from "@/lib/promote/dates";
import { isAdFormat, isGoalKey, isSourceKind, PLACEMENT_MODES, type GoalKey, type IceBreaker, type PlacementMode, type SourceKind, type StartMode } from "@/lib/promote/types";
import { SpendBlockedError } from "@/lib/spend/errors";
import { resolveTimeZone } from "@/lib/spend/periods";
import { HttpError } from "@/lib/tenancy";
import { isAdPictureKey } from "./asset-image";
import { SHAPE_PROBLEM_TEXT } from "./builders";
import { MAX_AUDIENCES, parseTargeting } from "./targeting";
import { isAnyTemplate, isCategory, isTemplate, type AdTemplate, type CreativeCard, type CreativeInput, type CreativeMediaIds, type SpecialAdCategory, type Targeting } from "./types";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const blank = (v: unknown) => v === undefined || v === null || v === "";

export const DAY_MS = 86_400_000;
/** An assistant's campaign ends within this many days, unless a lifetime budget bounds it (docs/SPEND-CONTROLS-SPEC.md 4.8, R2). */
export const ASSISTANT_MAX_END_DAYS = 90;

/** Who a campaign is for: a person, an assistant (proposal-only in Phase 0) or the API. */
export type CampaignOrigin = "human" | "assistant" | "api";

/** Which flow made the draft (AdCampaign.surface, 5.1). */
export const DRAFT_SURFACES = ["wizard", "promote", "eddy", "api"] as const;
export type DraftSurface = (typeof DRAFT_SURFACES)[number];
export const isDraftSurface = (v: unknown): v is DraftSurface => typeof v === "string" && (DRAFT_SURFACES as readonly string[]).includes(v);
/**
 * The new flows and Eddy: their drafts always end, may use every goal of 4.4, and turn on only through the Start gate.
 * The same list as promote/route-guard's PROMOTE_START_SURFACES (a test checks they agree).
 */
export const NEW_FLOW_SURFACES: readonly DraftSurface[] = ["promote", "eddy"];
export const isNewFlowSurface = (v: unknown): boolean => typeof v === "string" && (NEW_FLOW_SURFACES as readonly string[]).includes(v);

/** Compared versions (3.8): at most three, named A, B and C. */
export const VARIANT_KEYS = ["A", "B", "C"] as const;
export type VariantKey = (typeof VARIANT_KEYS)[number];
export const isVariantKey = (v: unknown): v is VariantKey => typeof v === "string" && (VARIANT_KEYS as readonly string[]).includes(v);
/**
 * none: one ad set (the old wizard's ads, or a single version). fair_split: one ad set per version, each at an equal share
 * of the daily total. meta_picks: "Let Meta pick the best version (not a fair test)", several ads in one ad set.
 */
export type CompareMode = "none" | "fair_split" | "meta_picks";

/** Ad.creative.replacesAdIds (5.4): at most this many ads replaced by one edited copy. */
export const MAX_REPLACED_ADS = 10;

// ===== Copy =====

/** 6.1 rule 3: a draft from the new flows or Eddy without an end. */
export const END_REQUIRED = "Choose when your ads stop. Ads made here always have an end date.";
/** D31. */
export const RUN_TOO_SHORT = promoteText("run.too_short");
export const ICE_BREAKERS_INVALID = SHAPE_PROBLEM_TEXT.ice_breakers;
export const CAROUSEL_CARDS_INVALID = promoteText("carousel.cards");
export const VERSIONS_INVALID = "Compare up to 3 versions, named A, B and C.";
export const SPLIT_NEEDS_DAILY = "Comparing versions needs a daily budget. Choose a daily budget, or keep one version.";
const MEDIA_INVALID = "Pick each picture or video from your ad library again.";
const CARD_NEEDS_MEDIA = "Every carousel card needs a picture or video from your ad library.";

// ===== Types =====

export type DraftAd = {
  name: string;
  creativeAssetId: string | null;
  creative: CreativeInput;
  /** The compared version this ad is (3.8); null outside a comparison. */
  variantKey: VariantKey | null;
};

export type DraftInput = {
  name: string;
  template: AdTemplate;
  adAccountAssetId: string;
  /** The daily budget of the ad set (the daily total, split equally between versions in a fair test); null with a lifetime budget. */
  dailyBudgetMinor: number | null;
  /** A lifetime budget instead of a daily one (needs an end date). */
  lifetimeBudgetMinor: number | null;
  /** null: start now. */
  startsAt: Date | null;
  endsAt: Date | null;
  /** Set by trusted callers only, never read from a request body. */
  origin: CampaignOrigin;
  assistantKey: string | null;
  /** Set by trusted callers only, never read from a request body. */
  surface: DraftSurface;
  specialAdCategory: SpecialAdCategory;
  confirmNoSpecialCategory: boolean;
  /** Second, explicit acknowledgement needed to launch category "none" when housing, employment or credit terms are detected. */
  acknowledgeSpecialCategoryTerms: boolean;
  /** Targeting, with the audiences and "Let Meta find people" folded in. */
  targeting: Targeting;
  ads: DraftAd[];
  /** The plain goal (4.4); null for an old-wizard draft. */
  goal: GoalKey | null;
  sourceKind: SourceKind | null;
  /** The boosted post: a Facebook promotable id or an Instagram media id. */
  sourceRef: string | null;
  sourcePostTargetId: string | null;
  placementMode: PlacementMode;
  /** The run length in days (3.1a); null keeps the dates as given. */
  runDays: number | null;
  startMode: StartMode | null;
  compareMode: CompareMode;
};

export type DraftParseOptions = {
  /** Trusted callers only: the campaign is an assistant's (ads_launcher) or the API's. A route body never sets it. */
  origin?: CampaignOrigin;
  assistantKey?: string | null;
  /** Trusted callers only, like origin: the flow that made the draft. Default wizard (api for the API's origin). */
  surface?: DraftSurface;
  /** The ad account's IANA zone, for a run length (3.1a). ads/service recomputes the dates in the account zone anyway. */
  timeZone?: string | null;
  now?: Date;
};

// ===== Small parsers =====

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const isId = (v: unknown): v is string => typeof v === "string" && ID.test(v);

function parseGoal(raw: unknown): GoalKey | null {
  if (blank(raw)) return null;
  if (!isGoalKey(raw)) throw new HttpError(400, "Choose what your ad should do (a goal from the list).");
  return raw;
}

function parseSourceKind(raw: unknown): SourceKind | null {
  if (blank(raw)) return null;
  if (!isSourceKind(raw)) throw new HttpError(400, "sourceKind must be new, fb_post or ig_media.");
  return raw;
}

function parsePlacementMode(raw: unknown): PlacementMode {
  if (blank(raw)) return "auto";
  if (typeof raw !== "string" || !(PLACEMENT_MODES as readonly string[]).includes(raw)) throw new HttpError(400, "placementMode must be auto, instagram, facebook or custom.");
  return raw as PlacementMode;
}

function parseRunDays(raw: unknown): number | null {
  if (blank(raw)) return null;
  if (typeof raw !== "number" || !Number.isInteger(raw)) throw new HttpError(400, `runDays must be a whole number of days from ${MIN_RUN_DAYS} to ${MAX_RUN_DAYS}.`);
  if (raw < MIN_RUN_DAYS) throw new HttpError(400, RUN_TOO_SHORT);
  if (raw > MAX_RUN_DAYS) throw new HttpError(400, promoteText("run.too_long"));
  return raw;
}

function parseStartMode(raw: unknown): StartMode | null {
  if (blank(raw)) return null;
  if (raw !== "now" && raw !== "at") throw new HttpError(400, "startMode must be now or at.");
  return raw;
}

function parseCompareMode(raw: unknown): Exclude<CompareMode, "none"> {
  if (blank(raw)) return "fair_split";
  if (raw !== "fair_split" && raw !== "meta_picks") throw new HttpError(400, "compareMode must be fair_split or meta_picks.");
  return raw;
}

/** customAudienceIds or excludedAudienceIds at the top of the body: AdAudience ids, resolved to Meta ids at launch. */
function parseAudienceIds(raw: unknown, field: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.some((v) => !isId(v))) throw new HttpError(400, `${field} must be a list of audiences from your audience list.`);
  if (raw.length > MAX_AUDIENCES) throw new HttpError(400, `Choose at most ${MAX_AUDIENCES} audiences to include and ${MAX_AUDIENCES} to leave out.`);
  return [...new Set(raw as string[])];
}

/** creative.media (5.4): AdMedia ids for the feed, tall, square and video slots. */
function parseMedia(raw: unknown): CreativeMediaIds | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isObj(raw)) throw new HttpError(400, MEDIA_INVALID);
  const out: CreativeMediaIds = {};
  for (const slot of ["feed", "vertical", "square", "video"] as const) {
    const v = raw[slot];
    if (blank(v)) continue;
    if (!isId(v)) throw new HttpError(400, MEDIA_INVALID);
    out[slot] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** creative.cards (5.4): 2 to 10 cards, each with an AdMedia id. */
function parseCards(raw: unknown): CreativeCard[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new HttpError(400, CAROUSEL_CARDS_INVALID);
  if (raw.length === 0) return undefined;
  if (raw.length < CAROUSEL_MIN_CARDS || raw.length > CAROUSEL_MAX_CARDS) throw new HttpError(400, CAROUSEL_CARDS_INVALID);
  return raw.map((k) => {
    if (!isObj(k) || !isId(k.mediaId)) throw new HttpError(400, CARD_NEEDS_MEDIA);
    const card: CreativeCard = { mediaId: k.mediaId, headline: str(k.headline, 100) };
    const description = str(k.description, 100);
    if (description) card.description = description;
    const link = str(k.link, 1000);
    if (link) card.link = link;
    return card;
  });
}

/** creative.iceBreakers (5.4): up to 3 quick questions, each title up to 80 characters and each answer up to 300. Never cut short. */
function parseIceBreakers(raw: unknown): IceBreaker[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length > MAX_ICE_BREAKERS) throw new HttpError(400, ICE_BREAKERS_INVALID);
  if (raw.length === 0) return undefined;
  return raw.map((q) => {
    if (!isObj(q) || typeof q.title !== "string" || typeof q.response !== "string") throw new HttpError(400, ICE_BREAKERS_INVALID);
    const title = q.title.trim();
    const response = q.response.trim();
    if (!title || !response || title.length > ICE_BREAKER_TITLE_MAX || response.length > ICE_BREAKER_RESPONSE_MAX) throw new HttpError(400, ICE_BREAKERS_INVALID);
    return { title, response };
  });
}

/** The 5.4 additions to a creative. Only what the body names is set, so an old-wizard creative stays exactly as it was. */
function newCreativeFields(c: Record<string, unknown>): Partial<CreativeInput> {
  const out: Partial<CreativeInput> = {};
  if (!blank(c.format)) {
    if (!isAdFormat(c.format)) throw new HttpError(400, "format must be single_image, single_video, carousel or existing_post.");
    out.format = c.format;
  }
  const media = parseMedia(c.media);
  if (media) out.media = media;
  const cards = parseCards(c.cards);
  if (cards) out.cards = cards;
  const ice = parseIceBreakers(c.iceBreakers);
  if (ice) out.iceBreakers = ice;
  const description = str(c.description, 255);
  if (description) out.description = description;
  const igMediaId = str(c.igMediaId, 100);
  if (igMediaId) out.igMediaId = igMediaId;
  const fbPromotableId = str(c.fbPromotableId, 100);
  if (fbPromotableId) out.fbPromotableId = fbPromotableId;
  if (c.enhancementsOptIn === true) out.enhancementsOptIn = true;
  const ctaType = str(c.ctaType, 40);
  if (ctaType) out.ctaType = ctaType;
  const urlTags = str(c.urlTags, 500);
  if (urlTags) out.urlTags = urlTags;
  return out;
}

/** One ad (or one version): the old wizard's creative fields, then the 5.4 additions. */
function parseAd(a: unknown, i: number, label: string, fallbackName: string): Omit<DraftAd, "variantKey"> {
  if (!isObj(a) || !isObj(a.creative)) throw new HttpError(400, `${label}[${i}].creative is required.`);
  const c = a.creative;
  if (c.mediaKey !== undefined && c.mediaKey !== null && c.mediaKey !== "" && !isAdPictureKey(c.mediaKey)) throw new HttpError(400, "Choose a JPG or PNG picture for your ad.");
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
    instagramMediaId: str(c.instagramMediaId, 100) || undefined,
    imageUrl: str(c.imageUrl, 1000) || undefined,
    imageHash: str(c.imageHash, 100) || undefined,
    mediaKey: isAdPictureKey(c.mediaKey) ? c.mediaKey : undefined,
    ...newCreativeFields(c),
  };
  return { name: str(a.name, 120) || fallbackName, creativeAssetId: str(a.creativeAssetId, 100) || null, creative };
}

/** The template: as given, or (new flows only) from the goal and source. A goal must match the template it names. */
function parseTemplate(raw: unknown, goal: GoalKey | null, sourceKind: SourceKind | null, newFlow: boolean): AdTemplate {
  const template = blank(raw) && goal && newFlow ? templateFor(goal, sourceKind ?? "new") : raw;
  // The old routes take the four old templates only (train P1 stays dark); the new flows and Eddy take every goal of 4.4.
  if (newFlow ? !isAnyTemplate(template) : !isTemplate(template)) {
    throw new HttpError(400, newFlow ? "Choose what your ad should do (a goal from the list)." : "template must be lead_generation, click_to_whatsapp, traffic or boost_post.");
  }
  if (goal) {
    const row = goalRow(goal);
    if (template !== row.template.new && template !== row.template.post) throw new HttpError(400, "That goal doesn't match this kind of ad. Choose the goal again.");
  }
  return template as AdTemplate;
}

export type RunCheck = {
  /** The new flows and Eddy: also the 90-day and start rules (D6, D32), counted in the account zone. */
  newFlow: boolean;
  /** At least one ad set has a daily budget (D31 is about daily budgets). */
  daily: boolean;
  startMode: StartMode | null;
  startsAt: Date | null;
  endsAt: Date | null;
  runDays: number | null;
  now: Date;
  tz: string;
};

/**
 * What stops a run before any Meta call, as plain copy; null when it is fine. Every surface: with a daily budget, the run
 * lasts more than 24 hours from when it really starts (D31). The new flows and Eddy also follow promote/dates validateRun:
 * at most 90 days, a start that has not passed and is at most 14 days ahead.
 */
export function runProblem(i: RunCheck): string | null {
  if (!i.endsAt) return null;
  if (i.newFlow) {
    const startMode: StartMode = i.startMode ?? (i.startsAt ? "at" : "now");
    const issues = validateRun({ startMode, startsAt: i.startsAt ?? i.now, endsAt: i.endsAt, now: i.now, tz: resolveTimeZone(i.tz), runDays: i.runDays }).filter((x) => i.daily || x.code !== "run.too_short");
    return issues[0]?.text ?? null;
  }
  if (!i.daily) return null;
  const start = Math.max(i.startsAt?.getTime() ?? i.now.getTime(), i.now.getTime());
  return i.endsAt.getTime() - start <= DAY_MS ? RUN_TOO_SHORT : null;
}

// ===== Ad.creative.replacesAdIds (5.4) =====

/** Validates the ads an edited copy replaces (row ids of ads on Meta): 1 to 10 ids, no repeats. */
export function parseReplacesAdIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_REPLACED_ADS || raw.some((v) => !isId(v))) {
    throw new HttpError(400, `An edited copy can replace 1 to ${MAX_REPLACED_ADS} ads.`);
  }
  return [...new Set(raw as string[])];
}

/** The ads a stored creative replaces; [] when it replaces none or the stored value is not valid (never trusted blindly). */
export function readReplacesAdIds(creative: unknown): string[] {
  const raw = isObj(creative) ? creative.replacesAdIds : undefined;
  if (raw === undefined || raw === null) return [];
  try {
    return parseReplacesAdIds(raw);
  } catch {
    return [];
  }
}

// ===== The parser =====

/**
 * Validates untrusted JSON from a route body. Throws HttpError(400). A daily budget, or a lifetime budget with an end date.
 * An assistant's campaign (origin from the trusted caller) needs an end date within 90 days, or a lifetime budget. A draft
 * of the new flows or Eddy (surface from the trusted caller) needs an end date. With runDays, the end is the start day plus
 * runDays minus 1 at 23:59 in the account zone, whatever endsAt the body sent (3.1a).
 */
export function parseDraftInput(body: Record<string, unknown>, opts: DraftParseOptions = {}): DraftInput {
  const now = opts.now ?? new Date();
  const name = str(body.name, 120);
  if (!name) throw new HttpError(400, "name is required.");
  const surface: DraftSurface = isDraftSurface(opts.surface) ? opts.surface : opts.origin === "api" ? "api" : "wizard";
  const newFlow = isNewFlowSurface(surface);
  const goal = parseGoal(body.goal);
  const sourceKind = parseSourceKind(body.sourceKind);
  const template = parseTemplate(body.template, goal, sourceKind, newFlow);
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
  let startsAt = date(body.startsAt, "startsAt");
  let endsAt = date(body.endsAt, "endsAt");
  if (startsAt && endsAt && endsAt <= startsAt) throw new HttpError(400, "endsAt must be after startsAt.");

  // A run length and a start mode (3.1a): the dates follow from them, in the account zone.
  const runDays = parseRunDays(body.runDays);
  let startMode = parseStartMode(body.startMode);
  if (runDays !== null || startMode !== null) {
    startMode = startMode ?? (startsAt ? "at" : "now");
    if (startMode === "now") startsAt = null;
    else if (!startsAt) throw new HttpError(400, "Choose when your ads start, or start them now.");
    else if (startsAt.getTime() < now.getTime()) throw new HttpError(400, promoteText("run.start_passed"));
    if (runDays !== null) endsAt = runDates({ runDays, startMode, startsAt, tz: resolveTimeZone(opts.timeZone), now }).endsAt;
  }

  if (lifetime !== null && !endsAt) throw new HttpError(400, "A lifetime budget needs an end date.");
  const origin: CampaignOrigin = opts.origin === "assistant" || opts.origin === "api" ? opts.origin : "human";
  const assistantKey = origin === "assistant" ? str(opts.assistantKey, 64) : null;
  if (origin === "assistant") {
    if (!assistantKey) throw new HttpError(400, "An assistant's campaign must name the assistant.");
    if (!endsAt) throw new SpendBlockedError("spend.end_date_required");
    const latest = now.getTime() + ASSISTANT_MAX_END_DAYS * DAY_MS;
    if (lifetime === null && endsAt.getTime() > latest) throw new HttpError(400, `Ads started by an assistant must end within ${ASSISTANT_MAX_END_DAYS} days, unless they have a lifetime budget.`);
  }
  // 6.1 rule 3: the new flows and Eddy always end.
  if (newFlow && !endsAt) throw new HttpError(400, END_REQUIRED);
  const run = runProblem({ newFlow, daily: daily !== null, startMode, startsAt, endsAt, runDays, now, tz: resolveTimeZone(opts.timeZone) });
  if (run) throw new HttpError(400, run);

  // Ads, or versions to compare (3.8): each version is one ad with its own creative.
  let ads: DraftAd[];
  let compareMode: CompareMode = "none";
  if (body.versions !== undefined && body.versions !== null) {
    if (body.ads !== undefined && body.ads !== null) throw new HttpError(400, "Send the versions or the ads, not both.");
    const versions = body.versions;
    if (!Array.isArray(versions) || versions.length < 1 || versions.length > VARIANT_KEYS.length) throw new HttpError(400, VERSIONS_INVALID);
    const keys = versions.map((v) => (isObj(v) ? v.key : undefined));
    if (keys.some((k) => !isVariantKey(k)) || [...keys].sort().join("") !== VARIANT_KEYS.slice(0, versions.length).join("")) throw new HttpError(400, VERSIONS_INVALID);
    ads = versions
      .map((v, i) => {
        const key = (v as Record<string, unknown>).key as VariantKey;
        return { ...parseAd(v, i, "versions", `${name} · Version ${key}`), variantKey: key };
      })
      .sort((a, b) => a.variantKey.localeCompare(b.variantKey));
    if (ads.length > 1) compareMode = parseCompareMode(body.compareMode);
  } else {
    if (!Array.isArray(body.ads) || body.ads.length < 1 || body.ads.length > 10) throw new HttpError(400, "Provide 1 to 10 ads.");
    ads = body.ads.map((a, i) => ({ ...parseAd(a, i, "ads", `${name} ad ${i + 1}`), variantKey: null }));
  }
  if (compareMode === "fair_split" && lifetime !== null) throw new HttpError(400, SPLIT_NEEDS_DAILY);
  const used = ads.map((a) => a.creativeAssetId).filter((v): v is string => !!v);
  if (new Set(used).size !== used.length) throw new HttpError(400, "Each ad needs a different creative. Remove the repeated one, or pick another.");

  // Audiences and "Let Meta find people" may come at the top of the body; they live in the ad set's targeting (5.4).
  const targeting = parseTargeting(body.targeting);
  const include = parseAudienceIds(body.customAudienceIds, "customAudienceIds");
  const exclude = parseAudienceIds(body.excludedAudienceIds, "excludedAudienceIds");
  if (include) {
    if (include.length) targeting.customAudienceIds = include;
    else delete targeting.customAudienceIds;
  }
  if (exclude) {
    if (exclude.length) targeting.excludedAudienceIds = exclude;
    else delete targeting.excludedAudienceIds;
  }
  if (body.advantageAudience === true) targeting.advantageAudience = true;
  else if (body.advantageAudience === false) delete targeting.advantageAudience;

  return {
    name,
    template,
    adAccountAssetId,
    dailyBudgetMinor: daily,
    lifetimeBudgetMinor: lifetime as number | null,
    startsAt,
    endsAt,
    origin,
    assistantKey,
    surface,
    specialAdCategory: body.specialAdCategory,
    confirmNoSpecialCategory: body.confirmNoSpecialCategory === true,
    acknowledgeSpecialCategoryTerms: body.acknowledgeSpecialCategoryTerms === true,
    targeting,
    ads,
    goal,
    sourceKind,
    sourceRef: str(body.sourceRef, 200) || null,
    sourcePostTargetId: str(body.sourcePostTargetId, 100) || null,
    placementMode: parsePlacementMode(body.placementMode),
    runDays,
    startMode,
    compareMode,
  };
}
