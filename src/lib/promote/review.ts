/**
 * Ad review status: the sync (R1, R2) and the explanation the campaign page and Eddy show (docs/IG-PAGE-ADS-SPEC.md 3.9,
 * 4.2 R1 and R2, 4.9, 4.10, 5.1, PRM-08).
 *
 * Sync (promote/tasks/review.ts runs it). Which ads are read follows Edwyz's own state (Ad.status, the campaign's status), not
 * only the Meta status stored last time, which goes stale once the member starts a campaign that launched paused:
 * - promote.review, every 15 min: platform ads in review, with issues or not approved, ads not read yet, and started ads
 *   (Ad.status active) Meta last saw paused or waiting for billing, so the first answer after Start is read. Oldest check first.
 * - promote.review.sweep, every 2 h: every started platform ad of a running campaign, whatever is stored, so an ad Meta rejects
 *   after approving it is seen.
 * - Not read (moved to the back of the queue): demo accounts, campaigns still launching, dry-run ids that are not Meta ids,
 *   and, in a paused campaign, ads Meta already showed as paused. An account whose read fails moves its ads back too, so an
 *   expired token never holds the run for the healthy accounts.
 * - Reads go through promote/meta.ts R1: act_X/ads filtering on id IN batches of 50 (never the ids= form, which errors on v26),
 *   with the user token at throttle priority 2. One failed account never stops the others.
 * - Writes, per ad: Ad.effectiveStatus, Ad.reviewFeedback (codes and placements only, never Meta's words or the ad's text) and
 *   Ad.reviewCheckedAt, plus creative.metaReview built from Meta's raw ad_review_feedback with ads/review.ts reviewFromMeta,
 *   exactly as the structure sync builds it, so the two syncs never rewrite each other. Per campaign: AdCampaign.reviewState
 *   (in_review, approved, partly_rejected, rejected or with_issues; cleared from in_review when every ad went quiet into a
 *   paused status) and reviewCheckedAt. Per ad set, as seen through its ads: AdSet.effectiveStatus.
 * - Once after launch: R2 advantage_state_info into AdCampaign.advantageState, and the ad set's targeting as Meta holds it
 *   into AdSet.effectivePlacements (with the positions the member chose that Meta dropped).
 * - Notices: ad_approved (fyi) when an ad leaves review approved, ad_rejected (action needed) when it is not approved, on every
 *   app or on some. One notice per ad and state (dedupe `ad-review:<ad>:<state>`), published through publishNotice with ids and
 *   codes only; the opposite state's notice resolves. An ad read for the first time more than 3 days after its campaign
 *   launched and after its last Start or resume only stores its state. While PROMOTE_ENABLED=admins (train P2) only campaigns
 *   made in the new flows are announced (announcesFor).
 *
 * Explanation (GET /api/ads/campaigns/[id]/review-status, Eddy's explain_ad_rejection): plain reasons and fix kinds from
 * review-reasons, the per-placement line, the special-category fix, appeal_ad as an Opens Meta fix, account restrictions with
 * account_quality, and [Pause and free ₹X] when every ad of an ad set is not approved (the commitment's worst case).
 */
import { readAdReview, reviewChanged, reviewFromMeta } from "@/lib/ads/review";
import type { SpecialAdCategory } from "@/lib/ads/types";
import { prisma } from "@/lib/db";
import { log } from "@/lib/log";
import { act, dedupe, KIND_SPECS } from "@/lib/notices/kinds";
import { publishNotice, resolveNotices, type PublishInput, type PublishResult, type ResolveFilter } from "@/lib/notices/publish";
import { toBookCommitment, toMath } from "@/lib/spend/commitments";
import { isDemoAsset } from "@/lib/spend/demo";
import { commitmentWorstCase, NO_SPEND } from "@/lib/spend/worstcase";
import { HttpError } from "@/lib/tenancy";
import { placementRow } from "./catalog/placements";
import { joinList, promoteText, type PromoteCopyKey } from "./copy";
import { promoteEnabled } from "./flags";
import { promoteMeta, type AdReview as MetaAdReview, type PromoteMeta, type ReviewFeedback as MetaFeedback } from "./meta";
import { explainReviewFeedback, normalizeFeedbackCode, type AdReviewFeedback } from "./review-reasons";
import type { ReviewTaskResult } from "./tasks/review";
import { isPlacementKey, type PlacementKey, type PromoteLang, type ReviewFixKind } from "./types";

// =====================================================================================================================
// States and stored shapes
// =====================================================================================================================

/** Meta's statuses R1 follows every 15 minutes (the open-review index of 0013). */
export const REVIEW_OPEN_STATUSES = ["PENDING_REVIEW", "IN_PROCESS", "WITH_ISSUES", "DISAPPROVED"] as const;
/** Meta's statuses of an ad that is off (itself, its ad set or its campaign) or waiting for billing: read again once started. */
export const REVIEW_PAUSED_STATUSES = ["PAUSED", "CAMPAIGN_PAUSED", "ADSET_PAUSED", "PENDING_BILLING_INFO"] as const;
const PAUSED: ReadonlySet<string> = new Set(REVIEW_PAUSED_STATUSES);
/** A Meta ad id. Dry-run and simulated launches store ids such as "dryrun_ad_…", which are never sent to Meta. */
const META_AD_ID = /^\d{1,30}$/;
/** The audit actions of Start and resume (ads/service.ts activateCampaign): the notice window also runs from these. */
export const START_AUDIT_ACTIONS = ["ads.campaign.activated", "ads.campaign.resumed"] as const;
const IN_REVIEW = new Set(["PENDING_REVIEW", "IN_PROCESS"]);
const APPROVED = new Set(["ACTIVE", "PREAPPROVED"]);

/** AdCampaign.reviewState (5.1 AdCampaign_reviewState_check), and the same words for one ad. */
export const REVIEW_STATES = ["in_review", "approved", "partly_rejected", "rejected", "with_issues"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/** Ad.reviewFeedback: Meta's policy codes, each with its placement (null for the whole ad), and the issue codes. No text. */
export type StoredFeedback = { v: 1; items: { code: string; placement: string | null }[]; issues: number[] };

export type { ReviewTaskResult };

/** Ads read per 15-minute run, and per 2-hour sweep (at 50 ids a request). */
export const REVIEW_SYNC_MAX_ADS = 1_000;
export const REVIEW_SWEEP_MAX_ADS = 5_000;
/** An ad read for the first time this soon after launch, or after a Start or resume, still gets its approval or rejection notice. */
export const NEW_AD_NOTICE_WINDOW_MS = 3 * 24 * 3_600_000;
const MAX_ITEMS = 25;
const MAX_ISSUES = 20;
const MAX_NOTICE_CODES = 10;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const upper = (v: unknown): string => (typeof v === "string" ? v.trim().toUpperCase() : "");
const CODE = /^[A-Z0-9_]{1,80}$/;
const PLACEMENT = /^[a-z][a-z0-9_]{0,39}$/;

/** Meta's placement key of a placement-specific reason, as a short lower-case word ("instagram"), or null. */
function placementKeyOf(scope: string): string | null {
  const p = scope.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return PLACEMENT.test(p) ? p : null;
}

/** The codes of one R1 answer, normalised (aliases resolved), with their placements, and the issue codes. Never any text. */
export function storedFeedbackOf(read: Pick<MetaAdReview, "feedback" | "issues">): StoredFeedback {
  const items: StoredFeedback["items"] = [];
  const seen = new Set<string>();
  for (const f of read.feedback ?? []) {
    const code = normalizeFeedbackCode(f.code);
    if (!CODE.test(code)) continue;
    const placement = f.scope === "global" ? null : placementKeyOf(f.scope);
    if (f.scope !== "global" && placement === null) continue;
    const key = `${code}|${placement ?? ""}`;
    if (seen.has(key) || items.length >= MAX_ITEMS) continue;
    seen.add(key);
    items.push({ code, placement });
  }
  const issues = [...new Set((read.issues ?? []).map((i) => i.code).filter((c): c is number => typeof c === "number" && Number.isSafeInteger(c)))].slice(0, MAX_ISSUES);
  return { v: 1, items, issues };
}

/** Ad.reviewFeedback as stored, re-checked: anything that is not a code or a placement is dropped. */
export function readStoredFeedback(raw: unknown): StoredFeedback | null {
  if (!isObject(raw) || !Array.isArray(raw.items)) return null;
  const items = raw.items
    .filter(isObject)
    .filter((i) => typeof i.code === "string" && CODE.test(i.code) && (i.placement === null || (typeof i.placement === "string" && PLACEMENT.test(i.placement))))
    .slice(0, MAX_ITEMS)
    .map((i) => ({ code: i.code as string, placement: (i.placement as string | null) ?? null }));
  const issues = Array.isArray(raw.issues) ? raw.issues.filter((c): c is number => typeof c === "number" && Number.isSafeInteger(c)).slice(0, MAX_ISSUES) : [];
  return { v: 1, items, issues };
}

/** One ad's review in Edwyz's words. null: nothing to say (paused, billing, removed, or not read). */
export function adReviewState(effectiveStatus: string | null | undefined, feedback: StoredFeedback | null): ReviewState | null {
  const s = upper(effectiveStatus);
  if (s === "DELETED" || s === "ARCHIVED") return null;
  if (s === "DISAPPROVED") return "rejected";
  // Rejected on some apps only: the ad still runs on the others (3.9).
  if (feedback?.items.some((i) => i.placement !== null)) return "partly_rejected";
  if (s === "WITH_ISSUES") return "with_issues";
  if (IN_REVIEW.has(s)) return "in_review";
  if (APPROVED.has(s)) return "approved";
  return null;
}

/** AdCampaign.reviewState from its ads: every ad not approved, some, issues, still in review, or all approved. */
export function campaignReviewState(states: readonly (ReviewState | null)[]): ReviewState | null {
  const known = states.filter((s): s is ReviewState => s !== null);
  if (known.length === 0) return null;
  if (known.every((s) => s === "rejected")) return "rejected";
  if (known.some((s) => s === "rejected" || s === "partly_rejected")) return "partly_rejected";
  if (known.some((s) => s === "with_issues")) return "with_issues";
  if (known.some((s) => s === "in_review")) return "in_review";
  return "approved";
}

/**
 * The ad set's status as seen through its ads (R1 reads the ads, not the ad set): paused with its campaign, paused itself, or
 * running. null when its ads say nothing about it.
 */
export function adSetStatusFromAds(statuses: readonly (string | null | undefined)[]): string | null {
  const s = statuses.map(upper);
  if (s.includes("CAMPAIGN_PAUSED")) return "CAMPAIGN_PAUSED";
  if (s.includes("ADSET_PAUSED")) return "PAUSED";
  if (s.some((x) => APPROVED.has(x))) return "ACTIVE";
  return null;
}

/** Which notice a change of review state raises, if any. `fresh`: the earlier state is a real earlier read (or a new ad). */
export function reviewNoticeFor(prev: ReviewState | null, next: ReviewState | null, fresh: boolean): "approved" | "rejected" | "partly_rejected" | null {
  if (!fresh || next === null || next === prev) return null;
  if (next === "approved") return prev === null || prev === "in_review" || prev === "rejected" || prev === "partly_rejected" ? "approved" : null;
  if (next === "rejected") return "rejected";
  if (next === "partly_rejected") return "partly_rejected";
  return null;
}

// =====================================================================================================================
// Effective placements (read back once after launch)
// =====================================================================================================================

const PLATFORM_FIELDS = ["facebook", "instagram", "messenger", "audience_network", "threads", "whatsapp"] as const;
const POSITION = /^[a-z][a-z0-9_]{0,59}$/;

/** AdSet.effectivePlacements: what Meta holds in the ad set's targeting, and the chosen positions Meta no longer shows. */
export type EffectivePlacements = {
  /** No platform or position in Meta's targeting: Meta picks the placements. */
  automatic: boolean;
  platforms: string[];
  positions: Record<string, string[]>;
  dropped: PlacementKey[];
  checkedAt: string;
};

const words = (v: unknown, max = 30): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && POSITION.test(x)))].slice(0, max) : []);

/** Meta's targeting (R1 adset{targeting}) against the positions the member chose (AdSet.targeting.placements). */
export function effectivePlacementsOf(targeting: unknown, chosen: readonly unknown[], now: Date): EffectivePlacements | null {
  if (!isObject(targeting)) return null;
  const platforms = words(targeting.publisher_platforms, 10);
  const positions: Record<string, string[]> = {};
  for (const platform of PLATFORM_FIELDS) {
    const list = words(targeting[`${platform}_positions`]);
    if (list.length) positions[platform] = list;
  }
  const automatic = platforms.length === 0 && Object.keys(positions).length === 0;
  const dropped = automatic
    ? []
    : [...new Set(chosen.filter(isPlacementKey))].filter((key) => {
        const row = placementRow(key);
        if (platforms.length > 0 && !platforms.includes(row.platform)) return true;
        const list = positions[row.platform];
        return list !== undefined && !list.includes(row.position);
      });
  return { automatic, platforms, positions, dropped, checkedAt: now.toISOString() };
}

function readEffectivePlacements(raw: unknown): EffectivePlacements | null {
  if (!isObject(raw)) return null;
  return {
    automatic: raw.automatic === true,
    platforms: words(raw.platforms, 10),
    positions: isObject(raw.positions) ? Object.fromEntries(Object.entries(raw.positions).map(([k, v]) => [k, words(v)])) : {},
    dropped: words(raw.dropped).filter(isPlacementKey),
    checkedAt: typeof raw.checkedAt === "string" ? raw.checkedAt : "",
  };
}

/**
 * Meta's feedback list back in the ad_review_feedback shape: only for an R1 answer without Meta's raw object (rawFeedback),
 * which is what reviewFromMeta reads, exactly as the structure sync does.
 */
function metaFeedbackOf(list: readonly MetaFeedback[]): Record<string, unknown> {
  const global: Record<string, string> = {};
  const placementSpecific: Record<string, Record<string, string>> = {};
  for (const f of list) {
    if (f.scope === "global") global[f.code] = f.text;
    else (placementSpecific[f.scope] ??= {})[f.code] = f.text;
  }
  return { global, placement_specific: placementSpecific };
}

// =====================================================================================================================
// The sync
// =====================================================================================================================

type Row = Record<string, unknown>;
type Args = Record<string, unknown>;
type Many = { findMany(a: Args): Promise<Row[]> };
type First = { findFirst(a: Args): Promise<Row | null> };
type Update = { updateMany(a: Args): Promise<{ count: number }> };
/** The tables review sync and the explanation use (Prisma, or a test double). */
export type ReviewDb = {
  ad: Many & Update;
  adSet: Many & Update;
  adCampaign: Many & First & Update;
  metaAsset: Many & First;
  spendCommitment: Many;
  /** Start and resume times (START_AUDIT_ACTIONS), for the notice window. Optional: without it the window runs from launch. */
  auditLog?: Many;
};

export type ReviewDeps = {
  db: ReviewDb;
  meta: Pick<PromoteMeta, "getAdsReview" | "getCampaignAdvantage" | "getAdAccountHealth">;
  publish: (input: PublishInput) => Promise<PublishResult>;
  resolve: (tenantId: string, filter: ResolveFilter) => Promise<number>;
  now: () => Date;
  env: Record<string, string | undefined>;
};

const defaultDeps = (): ReviewDeps => ({
  db: prisma as unknown as ReviewDb,
  meta: promoteMeta,
  publish: (input) => publishNotice(input),
  resolve: (tenantId, filter) => resolveNotices(tenantId, filter),
  now: () => new Date(),
  env: process.env,
});

/** Campaigns made in the new flows (route-guard PROMOTE_START_SURFACES): the only ones only Edwyz staff can make in train P2. */
const NEW_FLOW_SURFACES: readonly string[] = ["promote", "eddy"];

/**
 * Whether the review notices go to this campaign's workspace. With PROMOTE_ENABLED=on, for every platform ad. In train P2
 * (admins) the sync still keeps every ad's state, but announces only campaigns made in the new flows, which only Edwyz platform
 * admins can reach then; an old-wizard rejection keeps Phase 0's own notice from the structure sync.
 */
export function announcesFor(campaign: { surface?: unknown }, env: Record<string, string | undefined>): boolean {
  const mode = promoteEnabled(env);
  return mode === "on" || (mode === "admins" && NEW_FLOW_SURFACES.includes(String(campaign.surface ?? "wizard")));
}

const AD_SELECT = { id: true, tenantId: true, adSetId: true, metaAdId: true, status: true, effectiveStatus: true, reviewFeedback: true, creative: true };
const SET_SELECT = { id: true, tenantId: true, campaignId: true, metaAdSetId: true, targeting: true, effectivePlacements: true, effectiveStatus: true };
const CAMPAIGN_SELECT = { id: true, tenantId: true, adAccountAssetId: true, metaCampaignId: true, status: true, surface: true, launchedAt: true, reviewState: true, advantageState: true };

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const ids = (rows: readonly Row[], key: string): string[] => [...new Set(rows.map((r) => str(r[key])).filter((x): x is string => x !== null))];
const errorCode = (e: unknown): number | string | null => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "number" || typeof c === "string" ? c : null;
};

/** ad_rejected's codes payload: unique codes, comma separated, within the payload's 400 characters. */
function codesPayload(feedback: StoredFeedback): string {
  const out: string[] = [];
  for (const code of new Set(feedback.items.map((i) => i.code))) {
    if (out.length >= MAX_NOTICE_CODES || [...out, code].join(",").length > 400) break;
    out.push(code);
  }
  return out.join(",");
}

const NOTICE_STATES = ["approved", "rejected", "partly_rejected"] as const;

/** The campaigns of `campaignIds` started or resumed since `since` (audit trail of activateCampaign). Empty when unknown. */
async function startedSince(d: ReviewDeps, tenantId: string, campaignIds: readonly string[], since: Date): Promise<Set<string>> {
  if (!d.db.auditLog || campaignIds.length === 0) return new Set();
  try {
    const rows = await d.db.auditLog.findMany({
      where: { tenantId, action: { in: [...START_AUDIT_ACTIONS] }, target: { in: [...campaignIds] }, createdAt: { gte: since } },
      select: { target: true },
    });
    return new Set(rows.map((r) => str(r.target)).filter((x): x is string => x !== null));
  } catch (e) {
    // The window then runs from launch only; the state is still stored.
    log.warn("promote.review.started_read_failed", { code: errorCode(e) });
    return new Set();
  }
}

/**
 * The ads one pass reads, by Edwyz's own state as well as the Meta status stored last time (which goes stale once a campaign
 * that launched paused is started). "review": in review, with issues, not approved, not read yet, or started (Ad.status active)
 * while Meta last showed it paused or waiting for billing. "sweep": every started ad, whatever is stored.
 */
export function reviewWhere(kind: "review" | "sweep"): Record<string, unknown> {
  if (kind === "sweep") return { metaAdId: { not: null }, status: "active" };
  return {
    metaAdId: { not: null },
    status: { not: "archived" },
    OR: [{ effectiveStatus: { in: [...REVIEW_OPEN_STATUSES] } }, { effectiveStatus: null }, { status: "active", effectiveStatus: { in: [...REVIEW_PAUSED_STATUSES] } }],
  };
}

/**
 * One pass of R1: "review" every 15 min, "sweep" every 2 h (reviewWhere). Never throws for Meta's answers: an account whose read
 * fails counts its ads as failed and moves them to the back of the queue.
 */
export async function syncAdReviews(kind: "review" | "sweep", overrides: Partial<ReviewDeps> = {}): Promise<ReviewTaskResult> {
  const d: ReviewDeps = { ...defaultDeps(), ...overrides };
  const { db } = d;
  const now = d.now();
  const where = reviewWhere(kind);
  const ads = await db.ad.findMany({
    where,
    select: AD_SELECT,
    orderBy: [{ reviewCheckedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
    take: kind === "review" ? REVIEW_SYNC_MAX_ADS : REVIEW_SWEEP_MAX_ADS,
  });
  const result: ReviewTaskResult = { checked: 0, changed: 0, failed: 0 };
  if (ads.length === 0) return result;

  const firstSets = await db.adSet.findMany({ where: { id: { in: ids(ads, "adSetId") } }, select: { id: true, campaignId: true } });
  const campaigns = await db.adCampaign.findMany({ where: { id: { in: ids(firstSets, "campaignId") } }, select: CAMPAIGN_SELECT });
  // Launched campaigns only: not drafts, not one still launching or whose launch failed, not archived.
  const live = campaigns.filter((c) => str(c.metaCampaignId) && (c.status === "paused" || c.status === "active"));
  const sets = live.length ? await db.adSet.findMany({ where: { campaignId: { in: ids(live, "id") } }, select: SET_SELECT }) : [];
  const assets = live.length ? await db.metaAsset.findMany({ where: { id: { in: ids(live, "adAccountAssetId") }, type: "ad_account" }, select: { id: true, tenantId: true, meta: true } }) : [];
  const setById = new Map(sets.map((s) => [String(s.id), s]));
  const campaignById = new Map(live.map((c) => [String(c.id), c]));
  const assetById = new Map(assets.map((a) => [String(a.id), a]));

  // Ads grouped by workspace and ad account; every row must agree on the workspace.
  const groups = new Map<string, { tenantId: string; adAccountAssetId: string; ads: Row[] }>();
  const skipped: string[] = [];
  for (const ad of ads) {
    const set = setById.get(String(ad.adSetId));
    const campaign = set ? campaignById.get(String(set.campaignId)) : undefined;
    const account = campaign ? String(campaign.adAccountAssetId) : "";
    const asset = assetById.get(account);
    if (!set || !campaign || set.tenantId !== ad.tenantId || campaign.tenantId !== ad.tenantId || !asset || asset.tenantId !== ad.tenantId || isDemoAsset(asset)) {
      skipped.push(String(ad.id));
      continue;
    }
    // A dry-run id is not on Meta. In a paused campaign, an ad Meta already showed as paused has nothing new to say (the
    // sweep reads running campaigns only); an ad in review or not read yet is still read, as right after launch.
    const off = campaign.status !== "active" && (kind === "sweep" || PAUSED.has(upper(ad.effectiveStatus)));
    if (!META_AD_ID.test(String(ad.metaAdId)) || off) {
      skipped.push(String(ad.id));
      continue;
    }
    const key = `${ad.tenantId}|${account}`;
    const g = groups.get(key) ?? { tenantId: String(ad.tenantId), adAccountAssetId: account, ads: [] };
    g.ads.push(ad);
    groups.set(key, g);
  }
  // Ads not read go to the back of the queue so they never hold it for the ads that can be read.
  if (skipped.length) await db.ad.updateMany({ where: { id: { in: skipped } }, data: { reviewCheckedAt: now } });

  const touchedCampaigns = new Set<string>();
  for (const g of groups.values()) {
    const ctx = { tenantId: g.tenantId, adAccountAssetId: g.adAccountAssetId };
    let reads: MetaAdReview[];
    try {
      reads = await d.meta.getAdsReview(ctx, ids(g.ads, "metaAdId"));
    } catch (e) {
      result.failed += g.ads.length;
      log.warn("promote.review.read_failed", { kind, ads: g.ads.length, code: errorCode(e) });
      // To the back of the queue too: an account that fails every run (an expired token) never crowds out the others.
      await db.ad.updateMany({ where: { id: { in: ids(g.ads, "id") }, tenantId: g.tenantId }, data: { reviewCheckedAt: now } });
      continue;
    }
    // The notice window also runs from the campaign's last Start or resume (read once per account, only when needed).
    let started: Set<string> | null = null;
    const startedRecently = async (campaignId: string): Promise<boolean> => {
      started ??= await startedSince(d, g.tenantId, [...new Set(g.ads.map((a) => String(setById.get(String(a.adSetId))?.campaignId)))], new Date(now.getTime() - NEW_AD_NOTICE_WINDOW_MS));
      return started.has(campaignId);
    };
    const byMetaId = new Map(reads.map((r) => [r.id, r]));
    const groupCampaigns = new Set<string>();
    for (const ad of g.ads) {
      result.checked += 1;
      const set = setById.get(String(ad.adSetId)) as Row;
      const campaign = campaignById.get(String(set.campaignId)) as Row;
      groupCampaigns.add(String(campaign.id));
      const read = byMetaId.get(String(ad.metaAdId));
      if (!read) {
        // Meta returned nothing for it (deleted there): only the check time moves, so it does not hold the queue.
        await db.ad.updateMany({ where: { id: ad.id, tenantId: g.tenantId }, data: { reviewCheckedAt: now } });
        continue;
      }
      const status = upper(read.effectiveStatus) || null;
      const feedback = storedFeedbackOf(read);
      const before = readStoredFeedback(ad.reviewFeedback);
      const prevState = adReviewState(str(ad.effectiveStatus), before);
      const nextState = adReviewState(status, feedback);
      const data: Row = { effectiveStatus: status, reviewFeedback: feedback, reviewCheckedAt: now };
      // Meta's own object, as the structure sync reads it, so both write the same creative.metaReview.
      const rawFeedback = read.rawFeedback !== undefined ? read.rawFeedback : metaFeedbackOf(read.feedback);
      const metaReview = reviewFromMeta({ effective_status: status ?? undefined, ad_review_feedback: rawFeedback }, now);
      if (metaReview && reviewChanged(readAdReview(ad.creative), metaReview)) {
        const creative = isObject(ad.creative) ? ad.creative : {};
        data.creative = { ...creative, metaReview };
      }
      if (status !== str(ad.effectiveStatus) || JSON.stringify(feedback.items) !== JSON.stringify(before?.items ?? [])) result.changed += 1;
      await db.ad.updateMany({ where: { id: ad.id, tenantId: g.tenantId }, data });

      // Once after launch: the ad set's targeting as Meta holds it.
      if (set.effectivePlacements === null || set.effectivePlacements === undefined) {
        if (read.adSetId && read.adSetId === str(set.metaAdSetId)) {
          const chosen = isObject(set.targeting) && Array.isArray(set.targeting.placements) ? set.targeting.placements : [];
          const placements = effectivePlacementsOf(read.targeting, chosen, now);
          if (placements) {
            await db.adSet.updateMany({ where: { id: set.id, tenantId: g.tenantId }, data: { effectivePlacements: placements } });
            set.effectivePlacements = placements;
          }
        }
      }

      // `fresh`: the earlier state is a real earlier read (a paused one counts), or the ad is new: its campaign launched, or
      // was started or resumed, within the window. An old ad read for the first time only stores its state.
      const notice = reviewNoticeFor(prevState, nextState, true);
      if (notice && announcesFor(campaign, d.env)) {
        const launchedAt = campaign.launchedAt instanceof Date ? campaign.launchedAt.getTime() : null;
        const fresh = str(ad.effectiveStatus) !== null || (launchedAt !== null && now.getTime() - launchedAt <= NEW_AD_NOTICE_WINDOW_MS) || (await startedRecently(String(campaign.id)));
        if (fresh) await announce(d, g.tenantId, String(ad.id), String(campaign.id), notice, feedback);
      }
    }

    // Once after launch: Meta's Advantage+ state of each campaign (R2).
    const needAdvantage = [...groupCampaigns].map((id) => campaignById.get(id) as Row).filter((c) => c.advantageState === null || c.advantageState === undefined);
    if (needAdvantage.length) {
      try {
        const states = await d.meta.getCampaignAdvantage(ctx, ids(needAdvantage, "metaCampaignId"));
        for (const c of needAdvantage) {
          const found = states.find((s) => s.id === c.metaCampaignId);
          if (!found) continue;
          const value = (found.state.advantage_state ?? "UNKNOWN").slice(0, 60);
          await db.adCampaign.updateMany({ where: { id: c.id, tenantId: g.tenantId }, data: { advantageState: value } });
          c.advantageState = value;
        }
      } catch (e) {
        // Tried again on the next run.
        log.warn("promote.review.advantage_failed", { campaigns: needAdvantage.length, code: errorCode(e) });
      }
    }
    for (const id of groupCampaigns) touchedCampaigns.add(id);
  }

  if (touchedCampaigns.size) await settleCampaigns(d, [...touchedCampaigns].map((id) => campaignById.get(id) as Row), sets, now);
  return result;
}

/** Campaign review states and ad set statuses from every platform ad of the touched campaigns, after this run's writes. */
async function settleCampaigns(d: ReviewDeps, campaigns: Row[], sets: Row[], now: Date): Promise<void> {
  const campaignIds = new Set(campaigns.map((c) => String(c.id)));
  const own = sets.filter((s) => campaignIds.has(String(s.campaignId)));
  if (own.length === 0) return;
  const ads = await d.db.ad.findMany({ where: { adSetId: { in: ids(own, "id") }, metaAdId: { not: null }, status: { not: "archived" } }, select: { id: true, tenantId: true, adSetId: true, effectiveStatus: true, reviewFeedback: true } });
  for (const set of own) {
    const setAds = ads.filter((a) => a.adSetId === set.id && a.tenantId === set.tenantId);
    const status = adSetStatusFromAds(setAds.map((a) => str(a.effectiveStatus)));
    if (status !== null && status !== set.effectiveStatus) await d.db.adSet.updateMany({ where: { id: set.id, tenantId: set.tenantId }, data: { effectiveStatus: status } });
  }
  for (const c of campaigns) {
    const setIds = new Set(own.filter((s) => s.campaignId === c.id).map((s) => String(s.id)));
    const states = ads.filter((a) => setIds.has(String(a.adSetId)) && a.tenantId === c.tenantId).map((a) => adReviewState(str(a.effectiveStatus), readStoredFeedback(a.reviewFeedback)));
    const next = campaignReviewState(states);
    const data: Row = { reviewCheckedAt: now };
    if (next !== null && next !== c.reviewState) data.reviewState = next;
    // Every ad left review into a paused status with no feedback (Meta says nothing of the review while paused): the campaign
    // is no longer "in review"; the next read after Start says what Meta decided.
    else if (next === null && c.reviewState === "in_review") data.reviewState = null;
    await d.db.adCampaign.updateMany({ where: { id: c.id, tenantId: c.tenantId }, data });
  }
}

/** Publishes the ad's notice (ids and codes only) and resolves the notices of its other review states. */
async function announce(d: ReviewDeps, tenantId: string, adId: string, campaignId: string, state: (typeof NOTICE_STATES)[number], feedback: StoredFeedback): Promise<void> {
  const kind = state === "approved" ? "ad_approved" : "ad_rejected";
  const others = NOTICE_STATES.filter((s) => s !== state).map((s) => dedupe.adReview(adId, s));
  await d.resolve(tenantId, { keys: others });
  const page = `/app/ads/${campaignId}`;
  await d.publish({
    tenantId,
    kind,
    severity: KIND_SPECS[kind].severity,
    dedupeKey: dedupe.adReview(adId, state),
    audience: { minRole: KIND_SPECS[kind].minRole },
    subjectType: "ad",
    subjectId: adId,
    payload: { adId, campaignId, state, ...(state === "approved" ? {} : { codes: codesPayload(feedback) }) },
    actions: state === "approved" ? [act.go(page, "btn.open")] : [act.askEddy("btn.fix_with_eddy"), act.go(page, "btn.review")],
  });
}

// =====================================================================================================================
// The explanation (GET /api/ads/campaigns/[id]/review-status)
// =====================================================================================================================

type Category = Exclude<SpecialAdCategory, "none">;

export type ReviewFix =
  | { kind: "fix_ad"; label: string; category?: Category }
  | { kind: "opens_meta"; key: "appeal_ad" | "account_quality"; label: string | null }
  | { kind: "pause_and_free"; adSetId: string | null; amountMinor: number; currency: string; label: string };

export type ReasonView = {
  code: string;
  /** Meta's placement of the reason ("instagram"), or null for the whole ad. */
  placement: string | null;
  fix: ReviewFixKind;
  category?: Category;
  reason: string;
  whatToDo: string;
  /** The timeline line: "Not approved: …", "Not approved on Instagram: …. It still runs on Facebook.", or the category fix. */
  line: string;
};

export type AdReviewView = {
  id: string;
  name: string;
  adSetId: string;
  effectiveStatus: string | null;
  state: ReviewState | null;
  line: string | null;
  reasons: ReasonView[];
  fixes: ReviewFix[];
  checkedAt: string | null;
};

export type PauseAndFree = Extract<ReviewFix, { kind: "pause_and_free" }> & { line: string };

export type CampaignReviewView = {
  campaignId: string;
  lang: PromoteLang;
  reviewState: ReviewState | null;
  checkedAt: string | null;
  advantageState: string | null;
  ads: AdReviewView[];
  /** [Pause and free ₹X] for each ad set whose every ad is not approved, and the money it holds (3.9). */
  pauseAndFree: PauseAndFree[];
  /** "Meta isn't showing this on Messenger Stories any more", per dropped position. */
  dropped: { adSetId: string; placement: PlacementKey; line: string }[];
  /** The ad account is restricted (account_status 2 or 3): Start is disabled, pausing and every lowering still work. */
  account: { restricted: true; accountStatus: number; disableReason: number | null; line: string; blocksStart: true; fix: ReviewFix } | null;
};

const PLATFORM_NAMES: Readonly<Record<string, PromoteCopyKey>> = {
  facebook: "results.platform.facebook",
  instagram: "results.platform.instagram",
  messenger: "results.platform.messenger",
  threads: "results.platform.threads",
  whatsapp: "results.platform.whatsapp",
  audience_network: "results.platform.audience_network",
};

function platformName(p: string, lang: PromoteLang): string {
  const key = PLATFORM_NAMES[p];
  return key ? promoteText(key, {}, lang) : p.replace(/_/g, " ");
}

/** Where the ad still runs when one app did not approve it. */
function otherPlatforms(p: string, lang: PromoteLang): string {
  if (p === "instagram") return platformName("facebook", lang);
  if (p === "facebook") return platformName("instagram", lang);
  return joinList(["facebook", "instagram"].map((x) => platformName(x, lang)), lang);
}

/** An unmapped code shown in words ("SOME_POLICY" -> "some policy"): reviewFeedback holds no Meta text to show instead. */
const codeWords = (code: string) => code.toLowerCase().replace(/_+/g, " ").trim();

/** Stored codes in the ad_review_feedback shape review-reasons explains. */
function feedbackForExplain(stored: StoredFeedback): AdReviewFeedback {
  const global: Record<string, string> = {};
  const placementSpecific: Record<string, Record<string, string>> = {};
  for (const i of stored.items) {
    if (i.placement === null) global[i.code] = codeWords(i.code);
    else (placementSpecific[i.placement] ??= {})[i.code] = codeWords(i.code);
  }
  return { global, placement_specific: placementSpecific };
}

/** An ad the sync has not read yet: its review as the structure sync stored it (Meta's own words, kept on creative.metaReview). */
function legacyView(creative: unknown): { state: ReviewState | null; feedback: AdReviewFeedback } {
  const r = readAdReview(creative);
  if (!r) return { state: null, feedback: {} };
  const state: ReviewState | null = r.state === "rejected" ? "rejected" : r.state === "issues" ? "with_issues" : r.state === "in_review" ? "in_review" : r.state === "approved" ? "approved" : null;
  return { state, feedback: { global: Object.fromEntries(r.reasons.map((text, i) => [`META_REASON_${i + 1}`, text])) } };
}

function explainAd(ad: Row, lang: PromoteLang): AdReviewView {
  const stored = readStoredFeedback(ad.reviewFeedback);
  const effectiveStatus = str(ad.effectiveStatus);
  const legacy = stored === null && effectiveStatus === null ? legacyView(ad.creative) : null;
  const state = legacy ? legacy.state : adReviewState(effectiveStatus, stored);
  const explained = explainReviewFeedback(legacy ? legacy.feedback : stored ? feedbackForExplain(stored) : null, lang);
  const reasons: ReasonView[] = explained.map((r) => {
    let line: string;
    if (r.category) line = promoteText("status.special_category", { category: promoteText(`category.${r.category}` as PromoteCopyKey, {}, lang) }, lang);
    else if (r.placement && state === "partly_rejected") line = promoteText("status.rejected_on", { platform: platformName(r.placement, lang), reason: r.reason, other: otherPlatforms(r.placement, lang) }, lang);
    else if (state === "with_issues") line = promoteText("status.with_issues", { reason: r.reason }, lang);
    else line = promoteText("status.rejected", { reason: r.reason }, lang);
    return { code: r.code, placement: r.placement, fix: r.fix, ...(r.category ? { category: r.category } : {}), reason: r.reason, whatToDo: r.whatToDo, line };
  });
  const fixes: ReviewFix[] = [];
  if (state === "rejected" || state === "partly_rejected" || state === "with_issues") {
    const category = reasons.find((r) => r.category)?.category;
    // [Fix the ad] makes an edited copy (D29); with a category reason the copy has the category set (3.9).
    fixes.push({ kind: "fix_ad", label: promoteText("status.fix_ad", {}, lang), ...(category ? { category } : {}) });
    if (state !== "with_issues") fixes.push({ kind: "opens_meta", key: "appeal_ad", label: promoteText("status.appeal", {}, lang) });
  }
  let line: string | null = reasons[0]?.line ?? null;
  if (line === null && state === "in_review") line = promoteText("status.in_review", {}, lang);
  if (line === null && state === "approved" && upper(effectiveStatus) === "ACTIVE") line = promoteText("status.running", {}, lang);
  const checked = ad.reviewCheckedAt instanceof Date ? ad.reviewCheckedAt.toISOString() : null;
  return { id: String(ad.id), name: String(ad.name ?? ""), adSetId: String(ad.adSetId), effectiveStatus, state, line, reasons, fixes, checkedAt: checked };
}

const OPEN_COMMITMENTS = ["reserved", "live", "unconfirmed"];

/** What a commitment holds in the limits: its worst case to the end date or month end (at least today's), nothing spent. */
function heldBy(row: Row, now: Date): { minor: bigint; currency: string } {
  const c = toBookCommitment(row);
  const w = commitmentWorstCase(toMath(c, now), now, c.timezone, NO_SPEND);
  return { minor: w.remainingMonth > w.dayRisk ? w.remainingMonth : w.dayRisk, currency: c.currency };
}

const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d{1,6}$/.test(v) ? Number(v) : null);

export type ExplainOptions = { lang?: PromoteLang; now?: Date; /** Ask Meta (C4) when the account's status is not stored. Default true. */ readAccount?: boolean };

/**
 * The review of one campaign, in plain words, in `lang` (Eddy cards: the member's Eddy language; pages: English, D23). 404 for
 * a campaign of another workspace. Reads only; the only Meta call is the account read when its status is not stored yet.
 */
export async function explainCampaignReview(tenantId: string, campaignId: string, opts: ExplainOptions = {}, overrides: Partial<ReviewDeps> = {}): Promise<CampaignReviewView> {
  const d: ReviewDeps = { ...defaultDeps(), ...overrides };
  const { db } = d;
  const lang = opts.lang ?? "en";
  const now = opts.now ?? d.now();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(campaignId)) throw new HttpError(404, "Campaign not found.");
  const campaign = await db.adCampaign.findFirst({ where: { id: campaignId, tenantId }, select: { id: true, adAccountAssetId: true, reviewState: true, reviewCheckedAt: true, advantageState: true } });
  if (!campaign) throw new HttpError(404, "Campaign not found.");
  const sets = await db.adSet.findMany({ where: { tenantId, campaignId }, select: { id: true, effectivePlacements: true }, orderBy: { createdAt: "asc" } });
  const ads = sets.length
    ? await db.ad.findMany({
        where: { tenantId, adSetId: { in: ids(sets, "id") }, status: { not: "archived" } },
        select: { id: true, name: true, adSetId: true, metaAdId: true, effectiveStatus: true, reviewFeedback: true, reviewCheckedAt: true, creative: true },
        orderBy: { createdAt: "asc" },
      })
    : [];
  const platformAds = ads.filter((a) => str(a.metaAdId));
  const views = platformAds.map((a) => explainAd(a, lang));

  // [Pause and free ₹X]: every ad of the ad set is not approved, yet its commitment still holds room in the limits (3.9).
  const pauseAndFree: PauseAndFree[] = [];
  const disapproved = (list: Row[]) => list.length > 0 && list.every((a) => upper(a.effectiveStatus) === "DISAPPROVED");
  const rejectedSets = sets.filter((s) => disapproved(platformAds.filter((a) => a.adSetId === s.id)));
  const wholeCampaign = disapproved(platformAds);
  if (rejectedSets.length || wholeCampaign) {
    const open = await db.spendCommitment.findMany({ where: { tenantId, campaignId, status: { in: OPEN_COMMITMENTS } } });
    const add = (adSetId: string | null, rows: Row[]) => {
      if (!rows.length) return;
      let minor = 0n;
      let currency = "";
      for (const r of rows) {
        const h = heldBy(r, now);
        minor += h.minor;
        currency ||= h.currency;
      }
      if (minor <= 0n) return;
      const amount = { minor, currency };
      pauseAndFree.push({ kind: "pause_and_free", adSetId, amountMinor: Number(minor), currency, label: promoteText("status.pause_free", { amount }, lang), line: promoteText("status.set_aside_rejected", { amount }, lang) });
    };
    for (const s of rejectedSets) add(String(s.id), open.filter((r) => r.adSetId === s.id));
    if (wholeCampaign) add(null, open.filter((r) => r.adSetId === null || r.adSetId === undefined));
  }

  const dropped: CampaignReviewView["dropped"] = [];
  for (const s of sets) {
    for (const key of readEffectivePlacements(s.effectivePlacements)?.dropped ?? []) {
      dropped.push({ adSetId: String(s.id), placement: key, line: promoteText("placement.dropped", { placement: promoteText(`placement.${key}` as PromoteCopyKey, {}, lang) }, lang) });
    }
  }

  // Account restrictions (account_status 2 or 3): the stored status, else Meta's (C4) when it can be read.
  let account: CampaignReviewView["account"] = null;
  const asset = await db.metaAsset.findFirst({ where: { id: campaign.adAccountAssetId, tenantId }, select: { id: true, name: true, externalId: true, meta: true } });
  if (asset) {
    const meta = isObject(asset.meta) ? asset.meta : {};
    let status = numOrNull(meta.accountStatus);
    let disable = numOrNull(meta.disableReason);
    if (status === null && opts.readAccount !== false && !isDemoAsset(asset)) {
      try {
        const health = await d.meta.getAdAccountHealth({ tenantId, adAccountAssetId: String(asset.id) });
        status = health.accountStatus;
        disable = health.disableReason;
      } catch (e) {
        log.warn("promote.review.account_read_failed", { code: errorCode(e) });
      }
    }
    if (status === 2 || status === 3) {
      const name = str(asset.name) ?? str(asset.externalId) ?? "";
      account = {
        restricted: true,
        accountStatus: status,
        disableReason: disable,
        line: promoteText("error.account_restricted", { account: name }, lang),
        blocksStart: true,
        fix: { kind: "opens_meta", key: "account_quality", label: null },
      };
    }
  }

  const reviewState = (REVIEW_STATES as readonly string[]).includes(String(campaign.reviewState)) ? (campaign.reviewState as ReviewState) : campaignReviewState(views.map((v) => v.state));
  return {
    campaignId: String(campaign.id),
    lang,
    reviewState,
    checkedAt: campaign.reviewCheckedAt instanceof Date ? campaign.reviewCheckedAt.toISOString() : null,
    advantageState: str(campaign.advantageState),
    ads: views,
    pauseAndFree,
    dropped,
    account,
  };
}
