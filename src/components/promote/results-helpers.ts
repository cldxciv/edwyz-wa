/**
 * Pure helpers of the Ads page tiles, the campaign page (status timeline, edits, results tabs, compare card) and the audience
 * manager (docs/IG-PAGE-ADS-SPEC.md 3.7 to 3.10, 7.1, 7.3, D24, D25, D29; PRM-15b). Client-safe: no React, no fetch, no
 * database. Server modules are imported as types only; everything else comes from the pure promote core (copy, catalog, cost).
 *
 * Copy comes from src/lib/promote/copy where the catalogue has the key; the few labels it has no key for (tab names, the tile
 * bodies, confirm titles) are English constants here, because the ads pages render English until PROMOTE_PAGE_LANGS allows
 * more (D23).
 */
import type { Tone } from "@/components/ui";
import { budgetChangeKind, endChangeKind } from "@/components/ads/campaign-edit";
import { LOOKALIKE, MIN_AUDIENCE_PEOPLE, retentionBounds, type AudienceEventKind } from "@/lib/promote/catalog/audience-events";
import { placementName } from "@/lib/promote/catalog/breakdowns";
import { formatCount, formatDay, formatMoney, isPromoteCopyKey, promoteText, type PromoteCopyKey } from "@/lib/promote/copy";
import { majorUnit, splitDaily, type CostHeadroom } from "@/lib/promote/cost";
import type { AudienceChip, AudienceKind } from "@/lib/promote/audiences";
import type { PromoteAudiences } from "@/lib/promote/flags";
import type { ReviewState } from "@/lib/promote/review";
import { addDays, dayKey, resolveTimeZone } from "@/lib/spend/periods";

// =====================================================================================================================
// Paths and access
// =====================================================================================================================

export const PROMOTE_ACCESS_PATH = "/api/promote/access";
export const BOOST_PATH = "/app/ads/boost";
export const CREATE_PATH = "/app/ads/create";
/** The old wizard, kept as "All settings (advanced)" until PRM-18 (D2, D5). */
export const ADVANCED_PATH = "/app/ads/new";
export const AUDIENCES_PATH = "/app/ads/audiences";
/** A discarded draft can be restored for 15 minutes (4.8 discard_promotion_draft). */
export const UNDO_WINDOW_MS = 15 * 60_000;
/** Campaigns made by the new flows. Old-wizard and API campaigns keep the old page controls (D5). */
export const PROMOTE_SURFACES: readonly string[] = Object.freeze(["promote", "eddy"]);

/** What the client reads from GET /api/promote/access (404 while the feature is hidden from this member). */
export type AccessLite = { visible: boolean; canWrite?: boolean; canStart?: boolean; audiences?: PromoteAudiences; goals?: readonly string[] };

/** The tiles, the timeline, results and the audience manager show only when the feature is open to this member. */
export const promoteVisible = (access: Pick<AccessLite, "visible"> | null | undefined): boolean => access?.visible === true;

export const isPromoteSurface = (surface: string | null | undefined): boolean => PROMOTE_SURFACES.includes(surface ?? "wizard");

// =====================================================================================================================
// The Ads page tiles (7.1, 7.3 PromoteTiles)
// =====================================================================================================================

export type PromoteTileId = "boost" | "whatsapp" | "leads" | "more" | "advanced";
export type PromoteTile = { id: PromoteTileId; title: string; body: string; href: string };

export const TILES_TEXT = {
  heading: "Promote on Instagram and Facebook",
  intro: "Pick what you want people to do. Each one starts with your choices filled in, and nothing is spent until you tap Start.",
  boost: "Boost a post",
  boostBody: "Show a post or reel you already shared to more people.",
  leads: "Get leads",
  moreGoals: "More goals",
  moreGoalsBody: "Website visits, Instagram messages, video views and more.",
  advancedBody: "Every option on one page, for people who know Meta's ads.",
  audiences: "Audiences",
  running: "Running promotions",
  drafts: "Drafts",
  resume: "Resume",
  discard: "Discard",
  discarded: (name: string) => `Discarded "${name}". You can undo this for 15 minutes.`,
  restored: (name: string) => `"${name}" is back in your drafts.`,
  paused: (name: string) => `Paused "${name}". Nothing is being spent.`,
  pauseLabel: (name: string) => `Pause "${name}"`,
  resumeLabel: (name: string) => `Resume the draft "${name}"`,
  discardLabel: (name: string) => `Discard the draft "${name}"`,
  undoLabel: (name: string) => `Undo discarding "${name}"`,
  perDay: (amount: string) => `${amount} a day`,
} as const;

/**
 * The tiles row (7.1): "Boost a post", "Get WhatsApp chats", "Get leads", then "More goals" and "All settings (advanced)".
 * A goal tile shows only while its goal is offered (PROMOTE_GOALS); boosting and the two last tiles always show. The names
 * never say "New campaign", "Create a campaign" or "Connect ad account", which the old list's own buttons are found by.
 */
export function promoteTiles(goals?: readonly string[] | null): PromoteTile[] {
  const offered = (goal: string) => !goals || goals.includes(goal);
  const tiles: PromoteTile[] = [{ id: "boost", title: TILES_TEXT.boost, body: TILES_TEXT.boostBody, href: BOOST_PATH }];
  if (offered("whatsapp_chats")) tiles.push({ id: "whatsapp", title: promoteText("goal.whatsapp_chats.title"), body: promoteText("goal.whatsapp_chats.outcome"), href: `${CREATE_PATH}?goal=whatsapp_chats` });
  if (offered("lead_form")) tiles.push({ id: "leads", title: TILES_TEXT.leads, body: promoteText("goal.lead_form.outcome"), href: `${CREATE_PATH}?goal=lead_form` });
  tiles.push({ id: "more", title: TILES_TEXT.moreGoals, body: TILES_TEXT.moreGoalsBody, href: CREATE_PATH });
  tiles.push({ id: "advanced", title: promoteText("more.all_settings"), body: TILES_TEXT.advancedBody, href: ADVANCED_PATH });
  return tiles;
}

/** A row of GET /api/ads/campaigns. */
export type PromotionItem = {
  id: string;
  name: string;
  template: string;
  status: string;
  currency: string;
  totalDailyBudgetMinor: number;
  surface?: string | null;
  goal?: string | null;
  reviewState?: string | null;
};

/** Promotions on Meta (running, paused or being set up), newest first as the list gives them. */
export const runningPromotions = <T extends PromotionItem>(list: readonly T[]): T[] => list.filter((c) => isPromoteSurface(c.surface) && ["active", "paused", "launching"].includes(c.status));

/** Promotion drafts not on Meta yet. */
export const promotionDrafts = <T extends PromotionItem>(list: readonly T[]): T[] => list.filter((c) => isPromoteSurface(c.surface) && c.status === "draft");

/** The status chip of a promotion in the list: a word and a tone, never the colour alone. */
export function promotionChip(c: Pick<PromotionItem, "status" | "reviewState">): { label: string; tone: Tone } {
  switch (c.status) {
    case "draft":
      return { label: "Draft", tone: "neutral" };
    case "launching":
      return { label: promoteText("status.getting_ready"), tone: "info" };
    case "paused":
      return { label: "Paused", tone: "neutral" };
    case "archived":
      return { label: "Finished", tone: "neutral" };
    case "error":
      return { label: "Needs attention", tone: "bad" };
  }
  if (c.reviewState === "in_review") return { label: promoteText("status.in_review"), tone: "info" };
  if (c.reviewState === "rejected") return { label: "Not approved", tone: "bad" };
  if (c.reviewState === "partly_rejected") return { label: "Partly not approved", tone: "warn" };
  if (c.reviewState === "with_issues") return { label: "Approved with issues", tone: "warn" };
  return { label: promoteText("status.running"), tone: "good" };
}

/** Where a draft continues: the boost flow for a boost, the goal flow otherwise; old-wizard drafts reopen in the wizard. */
export function draftHref(c: { id: string; template?: string | null; surface?: string | null }): string {
  const id = encodeURIComponent(c.id);
  if (!isPromoteSurface(c.surface)) return `${ADVANCED_PATH}?draft=${id}`;
  return c.template === "boost_post" ? `${BOOST_PATH}?draft=${id}` : `${CREATE_PATH}?draft=${id}`;
}

/** Whether the Undo of a discard is still open (the server restores for 15 minutes). */
export function undoOpen(restorableUntil: string | Date | null | undefined, now: Date): boolean {
  const until = toDate(restorableUntil);
  return until !== null && until.getTime() > now.getTime();
}

// =====================================================================================================================
// The status timeline (3.9)
// =====================================================================================================================

export type TimelineStepKey = "getting_ready" | "in_review" | "running";
export type TimelineState =
  | "draft"
  | "getting_ready"
  | "in_review"
  | "running"
  | "rejected"
  | "partly_rejected"
  | "with_issues"
  | "paused_by_you"
  | "paused_limit"
  | "paused_limit_month"
  | "paused_safety"
  | "paused_stop"
  | "paused_stopped"
  | "paused_unknown"
  | "finished"
  | "archived";

export type TimelineButton =
  | { kind: "fix_ad"; label: string; adIds: string[]; category?: string }
  | { kind: "opens_meta"; screen: "appeal_ad" | "account_quality"; label: string }
  | { kind: "pause_and_free"; label: string; adSetId: string | null; amountMinor: number; currency: string };

export type TimelineLine = { key: string; line: string; tone: Tone; buttons: TimelineButton[] };
export type TimelineStep = { key: TimelineStepKey; label: string; status: "done" | "current" | "todo" };

export type TimelineView = {
  state: TimelineState;
  steps: TimelineStep[];
  /** The main line ("Not approved: …", "Paused by you", "Finished on Sun 1 Nov"), or null for a draft. */
  outcome: TimelineLine | null;
  /** More lines: money set aside for a rejected ad, places Meta dropped, a restricted account, a second state. */
  lines: TimelineLine[];
  /** The ad account is restricted: every start and raise is disabled; pausing and every lowering still work. */
  blocksStart: boolean;
};

/** The parts of GET /api/ads/campaigns/[id]/review-status (CampaignReviewView) the timeline reads. */
export type TimelineAd = { id: string; state: ReviewState | null; line: string | null; reasons?: readonly { category?: string; line?: string }[] };
export type TimelineReview = {
  reviewState: ReviewState | null;
  ads: readonly TimelineAd[];
  pauseAndFree?: readonly { adSetId: string | null; amountMinor: number; currency: string; label?: string; line?: string }[];
  dropped?: readonly { adSetId: string; placement: string; line?: string }[];
  account?: { line: string } | null;
};

export type TimelineInput = {
  /** AdCampaign.status: draft | launching | paused | active | archived | error. */
  status: string;
  endsAt?: string | Date | null;
  now: Date;
  /** The ad account's zone (D30), for "Finished on Sun 1 Nov". */
  timeZone?: string | null;
  review?: TimelineReview | null;
  /** Why a paused campaign is paused (pauseCauseOf): by a person (default), a limit, a safety stop, a stop, or not known yet. */
  pausedBy?: PausedBy | null;
  safetyReason?: string | null;
  /** Who stopped spending ("Priya", "Edwyz support"), for the "stopped" and "stop" lines. */
  stoppedBy?: string | null;
  /**
   * The campaign's ad sets on Meta that a campaign pause stops (row ids). [Pause and free ₹X] pauses the whole campaign, so it
   * is offered only when that frees exactly what is held: the money of every one of these ad sets is set aside (one line, the
   * amounts added up), or a campaign-level amount is. Otherwise each line says why there is no button. Left out, every line
   * keeps its button.
   */
  launchedAdSetIds?: readonly string[];
};

export const TIMELINE_TEXT = {
  heading: "Status",
  archived: "Archived. It doesn't run any more.",
  safetyDefault: "something looked wrong with the spending",
  reasonUnknown: "Meta didn't say why",
  /** While the spend summary hasn't said why yet: no guess. */
  paused: "Paused",
  pausedMonth: "Paused: this month's ads limit is used up",
  /** All spending is stopped right now (Phase 0 freeze `all`). */
  pausedStopped: (by: string | null) => `Paused: all spending is stopped${by ? ` (stopped by ${by})` : ""}`,
  /** A stop paused it and no open stop explains it any more: the stop was cleared, or Meta was disconnected. Neutral words. */
  pausedStop: (by: string | null) => `Paused: spending was stopped${by ? ` (stopped by ${by})` : ""}`,
  /** Several rejected ad sets, freed together by pausing the campaign. */
  setAsideAll: (amount: string) => `${amount} is set aside for these ads while they're not approved.`,
  /** Only some of the ad sets hold money: pausing the campaign frees it, and stops the others too. */
  freeNeedsPause: "To free it, pause the campaign. Its other ads stop too.",
  done: "Done: ",
  now: "Now: ",
  next: "Next: ",
} as const;

const STEP_KEYS: readonly TimelineStepKey[] = ["getting_ready", "in_review", "running"];
const REVIEW_PROBLEMS: readonly (ReviewState | null)[] = ["rejected", "partly_rejected", "with_issues"];

const toDate = (v: string | Date | null | undefined): Date | null => {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

function adsIn(review: TimelineReview | null, states: readonly (ReviewState | null)[]): TimelineAd[] {
  return (review?.ads ?? []).filter((a) => states.includes(a.state));
}

/** The review line: Meta's reason in plain words from the server, or the copy with a stand-in reason. */
function reviewLine(state: "rejected" | "partly_rejected" | "with_issues", review: TimelineReview | null): { line: string; adIds: string[]; category?: string } {
  const ads = adsIn(review, [state]);
  const all = ads.length ? ads : adsIn(review, REVIEW_PROBLEMS);
  const category = all.flatMap((a) => a.reasons ?? []).find((r) => r.category)?.category;
  const fromServer = all.find((a) => a.line)?.line ?? null;
  const fallback = state === "with_issues" ? promoteText("status.with_issues", { reason: TIMELINE_TEXT.reasonUnknown }) : promoteText("status.rejected", { reason: TIMELINE_TEXT.reasonUnknown });
  return { line: fromServer ?? fallback, adIds: all.map((a) => a.id), ...(category ? { category } : {}) };
}

function fixButtons(state: "rejected" | "partly_rejected" | "with_issues", adIds: string[], category?: string): TimelineButton[] {
  const buttons: TimelineButton[] = [{ kind: "fix_ad", label: promoteText("status.fix_ad"), adIds, ...(category ? { category } : {}) }];
  // An ad approved with issues runs; there is nothing to appeal (review.ts gives the same fixes).
  if (state !== "with_issues") buttons.push({ kind: "opens_meta", screen: "appeal_ad", label: promoteText("status.appeal") });
  return buttons;
}

function pauseLine(input: Pick<TimelineInput, "pausedBy" | "safetyReason" | "stoppedBy">): { state: TimelineState; line: string; tone: Tone } {
  const by = input.stoppedBy?.trim() || null;
  switch (input.pausedBy) {
    case "limit":
      return { state: "paused_limit", line: promoteText("status.paused_limit"), tone: "warn" };
    case "limit_month":
      return { state: "paused_limit_month", line: TIMELINE_TEXT.pausedMonth, tone: "warn" };
    case "safety":
      return { state: "paused_safety", line: promoteText("status.paused_safety", { reason: input.safetyReason?.trim() || TIMELINE_TEXT.safetyDefault }), tone: "warn" };
    case "stopped":
      return { state: "paused_stopped", line: TIMELINE_TEXT.pausedStopped(by), tone: "warn" };
    case "stop":
      return { state: "paused_stop", line: TIMELINE_TEXT.pausedStop(by), tone: "neutral" };
    case "unknown":
      return { state: "paused_unknown", line: TIMELINE_TEXT.paused, tone: "neutral" };
    default:
      return { state: "paused_by_you", line: promoteText("status.paused_by_you"), tone: "neutral" };
  }
}

type FreeRow = NonNullable<TimelineReview["pauseAndFree"]>[number];

/**
 * The "₹X is set aside …" lines and their [Pause and free ₹X]. The button pauses the whole campaign (the campaign's pause
 * route), so it shows only when that frees exactly what is held: a campaign-level amount, or every ad set that a campaign
 * pause stops listed. Then the lines become one line with the amounts added up. When only some ad sets hold money, each line
 * says that pausing the campaign frees it and stops the other ads too. Buttons only while the campaign is active.
 */
function freeLines(list: readonly FreeRow[], input: TimelineInput): TimelineLine[] {
  if (list.length === 0) return [];
  const active = input.status === "active";
  const amountOf = (minor: number, currency: string) => ({ minor, currency });
  const ownLine = (p: FreeRow) => p.line ?? promoteText("status.set_aside_rejected", { amount: amountOf(p.amountMinor, p.currency) });
  const button = (adSetId: string | null, amountMinor: number, currency: string, label?: string): TimelineButton => ({
    kind: "pause_and_free",
    label: label ?? promoteText("status.pause_free", { amount: amountOf(amountMinor, currency) }),
    adSetId,
    amountMinor,
    currency,
  });
  const keyOf = (adSetId: string | null) => `free-${adSetId ?? "campaign"}`;

  const launched = input.launchedAdSetIds;
  // The page didn't say which ad sets a pause stops: every line keeps its button.
  if (!launched) return list.map((p) => ({ key: keyOf(p.adSetId), line: ownLine(p), tone: "warn", buttons: active ? [button(p.adSetId, p.amountMinor, p.currency, p.label)] : [] }));

  const oneCurrency = new Set(list.map((p) => p.currency)).size === 1;
  const campaignWide = list.some((p) => p.adSetId === null);
  const everySet = launched.length > 0 && launched.every((id) => list.some((p) => p.adSetId === id));
  if (oneCurrency && (campaignWide || everySet)) {
    if (list.length === 1) {
      const p = list[0];
      return [{ key: keyOf(p.adSetId), line: ownLine(p), tone: "warn", buttons: active ? [button(p.adSetId, p.amountMinor, p.currency, p.label)] : [] }];
    }
    const total = list.reduce((sum, p) => sum + p.amountMinor, 0);
    const currency = list[0].currency;
    return [{ key: keyOf(null), line: TIMELINE_TEXT.setAsideAll(formatMoney(total, currency)), tone: "warn", buttons: active ? [button(null, total, currency)] : [] }];
  }
  return list.map((p) => ({ key: keyOf(p.adSetId), line: active ? `${ownLine(p)} ${TIMELINE_TEXT.freeNeedsPause}` : ownLine(p), tone: "warn", buttons: [] }));
}

/**
 * The 3.9 timeline of one campaign: the three steps ("Getting ready", "Meta is reviewing", "Running"), then the one state it
 * is in, with its buttons: [Fix the ad] (an edited copy, D29) and [Ask Meta to review again] (Opens Meta appeal_ad) for a
 * rejection, also on one placement only; [Fix the ad] for "Approved with issues"; nothing for a pause or a finished run. More
 * lines carry what review-status adds: "₹2,100 is set aside for this ad while it's not approved." with [Pause and free ₹2,100],
 * "Meta isn't showing this on Messenger Stories any more", and a restricted account with Opens Meta account_quality.
 */
export function statusTimeline(input: TimelineInput): TimelineView {
  const review = input.review ?? null;
  const rs = review?.reviewState ?? null;
  const ends = toDate(input.endsAt);
  const tz = input.timeZone || "Asia/Kolkata";
  const onMeta = ["active", "paused", "archived"].includes(input.status);
  const finished = onMeta && ends !== null && ends.getTime() <= input.now.getTime();

  const lines: TimelineLine[] = [];
  let state: TimelineState;
  let outcome: TimelineLine | null = null;

  if (input.status === "draft" || input.status === "error") state = "draft";
  else if (input.status === "launching") state = "getting_ready";
  else if (finished) state = "finished";
  else if (input.status === "archived") state = "archived";
  else if (rs === "rejected" || rs === "partly_rejected") state = rs;
  else if (input.status === "paused") state = pauseLine(input).state;
  else if (rs === "with_issues") state = "with_issues";
  else if (rs === "in_review" || (rs === null && adsIn(review, ["in_review"]).length > 0)) state = "in_review";
  else state = "running";

  switch (state) {
    case "draft":
      break;
    case "getting_ready":
      outcome = { key: "getting_ready", line: promoteText("status.getting_ready"), tone: "info", buttons: [] };
      break;
    case "in_review":
      outcome = { key: "in_review", line: promoteText("status.in_review"), tone: "info", buttons: [] };
      break;
    case "running":
      outcome = { key: "running", line: promoteText("status.running"), tone: "good", buttons: [] };
      break;
    case "finished":
      outcome = { key: "finished", line: promoteText("status.finished", { date: formatDay(ends!, tz, "en", { weekday: true }) }), tone: "neutral", buttons: [] };
      break;
    case "archived":
      outcome = { key: "archived", line: TIMELINE_TEXT.archived, tone: "neutral", buttons: [] };
      break;
    case "rejected":
    case "partly_rejected":
    case "with_issues": {
      const r = reviewLine(state, review);
      outcome = { key: state, line: r.line, tone: state === "rejected" ? "bad" : "warn", buttons: fixButtons(state, r.adIds, r.category) };
      break;
    }
    default: {
      const p = pauseLine(input);
      outcome = { key: p.state, line: p.line, tone: p.tone, buttons: [] };
    }
  }

  // A second state that is also true: a rejected campaign that is paused, or a paused one approved with issues.
  if ((state === "rejected" || state === "partly_rejected") && input.status === "paused") {
    const p = pauseLine(input);
    lines.push({ key: p.state, line: p.line, tone: p.tone, buttons: [] });
  }
  if (state.startsWith("paused_") && rs === "with_issues") {
    const r = reviewLine("with_issues", review);
    lines.push({ key: "with_issues", line: r.line, tone: "warn", buttons: fixButtons("with_issues", r.adIds, r.category) });
  }

  if (state !== "draft" && state !== "finished" && state !== "archived") lines.push(...freeLines(review?.pauseAndFree ?? [], input));
  for (const d of review?.dropped ?? []) {
    lines.push({ key: `dropped-${d.adSetId}-${d.placement}`, line: d.line ?? promoteText("placement.dropped", { placement: placementLabelOf(d.placement) }), tone: "info", buttons: [] });
  }
  const restricted = !!review?.account;
  if (review?.account) lines.push({ key: "account", line: review.account.line, tone: "bad", buttons: [{ kind: "opens_meta", screen: "account_quality", label: promoteText("status.appeal") }] });

  return { state, steps: timelineSteps(state, input.status, rs), outcome, lines, blocksStart: restricted };
}

/** A placement key ("messenger_stories") as the catalogue names it, or its words when the catalogue has no name. */
function placementLabelOf(key: string): string {
  const copyKey = `placement.${key}`;
  return isPromoteCopyKey(copyKey) ? promoteText(copyKey) : key.replace(/_/g, " ");
}

function timelineSteps(state: TimelineState, status: string, rs: ReviewState | null): TimelineStep[] {
  // How far the campaign got: 0 setting up, 1 in review (or rejected there), 2 approved and on Meta.
  let reached = -1;
  if (state === "getting_ready") reached = 0;
  else if (state === "in_review" || state === "rejected") reached = 1;
  else if (state !== "draft") reached = rs === "in_review" ? 1 : 2;
  const live = (status === "active" || status === "launching") && state !== "rejected" && state !== "finished";
  return STEP_KEYS.map((key, i) => ({
    key,
    label: promoteText(`status.${key}` as PromoteCopyKey),
    status: i < reached ? "done" : i === reached ? (live ? "current" : "done") : "todo",
  }));
}

/**
 * Where [Fix the ad] opens the edited copy (D29): the new flow for promotions (/app/ads/create?draft=), the old wizard for its
 * own campaigns, which the new flow does not edit.
 */
export function fixHref(copyId: string, surface: string | null | undefined): string {
  const id = encodeURIComponent(copyId);
  return isPromoteSurface(surface) ? `${CREATE_PATH}?draft=${id}` : `${ADVANCED_PATH}?draft=${id}`;
}

/** The parts of GET /api/spend/summary (SpendSummaryView) that say why a campaign is paused. */
export type PauseSummaryLite = {
  pausedByStop?: readonly { campaignId: string; canResume?: boolean }[];
  banners?: readonly { kind: string; text?: string }[];
  breakers?: readonly { kind: string; label?: string; reason?: string; scopeType?: string; scopeId?: string; state?: string; effect?: string }[];
  pots?: { ads?: { status?: string; month?: { left?: { minor: string } | null } | null } | null } | null;
  /** Phase 0's stop: while `effective` is "all", every ad is paused and nothing can start or raise (pausedByStop is then empty). */
  freeze?: { effective?: string; platform?: string; byName?: string | null } | null;
  /** "Only the owner can turn spending back on." while spending is stopped; null for the owner. */
  stopNote?: string | null;
};

/**
 * Who or what paused a campaign (3.9): a person, today's or this month's ads limit, a safety stop, a stop that no open stop
 * explains any more (cleared, or Meta was disconnected), all spending stopped right now, or not known yet (the summary is
 * still loading or didn't load).
 */
export type PausedBy = "you" | "limit" | "limit_month" | "safety" | "stop" | "stopped" | "unknown";

/**
 * pausedBy and its reason for the timeline, and what [Resume] may do. canResume is false, with resumeNote saying why, when a
 * stop paused it and this member is neither the owner nor an approver (Phase 0 2.3.13), when all spending is stopped, and
 * while the summary hasn't said who may resume (the check fails closed). raisesBlocked: all spending is stopped, so every
 * raise is refused too, with this reason.
 */
export type PauseCause = {
  pausedBy: PausedBy;
  safetyReason: string | null;
  /** Who stopped spending ("Priya", "Edwyz support"), when the summary says. */
  stoppedBy: string | null;
  canResume: boolean;
  resumeNote: string | null;
  raisesBlocked: string | null;
};

/** WhatsApp stops never pause an ad campaign. */
const isWhatsAppBreaker = (kind: string) => kind.startsWith("wa_") || kind === "waba_disabled";
const SAFETY_PREFIX = /^safety stop:\s*/i;

/** Why nothing can resume or raise while all spending is stopped: Edwyz's own stop, or the workspace's (and who can lift it). */
function frozenNote(summary: PauseSummaryLite): string {
  if (summary.freeze?.platform === "all") return EDITS_TEXT.frozenPlatform;
  const note = summary.stopNote?.trim();
  return note ? `${EDITS_TEXT.frozen} ${note}` : `${EDITS_TEXT.frozen} ${EDITS_TEXT.frozenOwner}`;
}

/**
 * Why a paused campaign is paused (3.9) and whether this member may resume it.
 * - No summary yet (loading, or it failed): "unknown". The line says only "Paused" and [Resume] stays disabled until the
 *   summary says who may resume (2.3.13 must not fail open).
 * - All spending is stopped (freeze `all`): "stopped", for every paused campaign, since nothing can start until it is turned
 *   back on; [Resume] and every raise are disabled with the summary's stop note.
 * - Not listed under pausedByStop: a person paused it ("Paused by you").
 * - Listed: an open breaker on this campaign, one of its ad sets, its ad account or the workspace says which stop. The monthly
 *   ads limit (a breaker, or the ads pot at its limit with nothing left this month) is "limit_month"; today's is "limit"; any
 *   other breaker is a safety stop with its reason. The AI and WhatsApp limits share the banner kind `limit_reached`, so a
 *   banner counts only when it is about ads and the summary has no pots to read.
 * - Listed, and nothing open explains it (the stop was cleared, or a Meta disconnect paused it): "stop", in neutral words.
 */
export function pauseCauseOf(
  c: { id: string; metaCampaignId?: string | null; adSetIds?: readonly (string | null | undefined)[] },
  summary: PauseSummaryLite | null | undefined,
  opts: { failed?: boolean } = {},
): PauseCause {
  const cause = (pausedBy: PausedBy, over: Partial<PauseCause> = {}): PauseCause => ({ pausedBy, safetyReason: null, stoppedBy: null, canResume: true, resumeNote: null, raisesBlocked: null, ...over });
  if (!summary) return cause("unknown", { canResume: false, resumeNote: opts.failed ? EDITS_TEXT.resumeCheckFailed : EDITS_TEXT.resumeChecking });
  const by = summary.freeze?.byName?.trim() || null;
  if (summary.freeze?.effective === "all") {
    const note = frozenNote(summary);
    return cause("stopped", { stoppedBy: by, canResume: false, resumeNote: note, raisesBlocked: note });
  }
  const row = summary.pausedByStop?.find((p) => p.campaignId === c.id || (!!c.metaCampaignId && p.campaignId === c.metaCampaignId));
  if (!row) return cause("you");
  const guard: Partial<PauseCause> = row.canResume === false ? { canResume: false, resumeNote: EDITS_TEXT.stopResume } : {};
  const mine = new Set([c.id, c.metaCampaignId, ...(c.adSetIds ?? [])].filter((x): x is string => typeof x === "string" && x !== ""));
  const applies = (b: NonNullable<PauseSummaryLite["breakers"]>[number]) => {
    if (b.state && b.state !== "tripped") return false;
    if (b.effect && b.effect !== "pause_scope") return false;
    if (isWhatsAppBreaker(b.kind)) return false;
    if (b.scopeType === "campaign" || b.scopeType === "adset") return !!b.scopeId && mine.has(b.scopeId);
    return b.scopeType === undefined || b.scopeType === "ad_account" || b.scopeType === "workspace";
  };
  const open = (summary.breakers ?? []).filter(applies);
  // The month's limit first: it doesn't lift tomorrow, so the line must not say "today".
  if (open.some((b) => b.kind === "monthly_limit")) return cause("limit_month", guard);
  if (open.some((b) => b.kind === "daily_limit")) return cause("limit", guard);
  const stop = open.find((b) => b.scopeType === "campaign" || b.scopeType === "adset") ?? open[0];
  if (stop) {
    // "Safety stop: spending too fast" reads "Paused by a safety stop: spending too fast"; the label keeps "Meta" capitalised.
    const words = (stop.label?.replace(SAFETY_PREFIX, "") || stop.reason || "").trim().replace(/\.$/, "");
    return cause("safety", { ...guard, safetyReason: words || null });
  }
  const ads = summary.pots?.ads;
  if (ads?.status === "limit_reached") return cause(ads.month?.left?.minor === "0" ? "limit_month" : "limit", guard);
  const banner = summary.pots ? undefined : summary.banners?.find((b) => b.kind === "limit_reached" && (!b.text || /^ads\b/i.test(b.text)));
  if (banner) return cause(/\bmonth/i.test(banner.text ?? "") ? "limit_month" : "limit", guard);
  // A stop paused it and nothing open explains it: the stop was cleared, or Meta was disconnected. Name who stopped spending
  // only while a stop is still on (an assistants stop); otherwise the name could belong to a different stop.
  return cause("stop", { ...guard, stoppedBy: summary.freeze?.effective && summary.freeze.effective !== "none" ? by : null });
}

/** Why a paused campaign is paused, from GET /api/spend/summary (pauseCauseOf's pausedBy). */
export function pausedByOf(campaignId: string, summary: PauseSummaryLite | null | undefined): PausedBy {
  return pauseCauseOf({ id: campaignId }, summary).pausedBy;
}

/** The cost line's headroom from the summary's ads pot (amounts arrive as strings of minor units). */
export function headroomFrom(pot: { currency: string; today: { left: { minor: string } | null }; month: { left: { minor: string } | null } } | null | undefined): CostHeadroom | null {
  if (!pot) return null;
  const big = (m: { minor: string } | null) => (m && /^-?\d{1,30}$/.test(m.minor) ? BigInt(m.minor) : null);
  return { currency: pot.currency, today: { left: big(pot.today.left) }, month: { left: big(pot.month.left) } };
}

// =====================================================================================================================
// Edits on a campaign on Meta (3.9 table, 3.8 fair split)
// =====================================================================================================================

export type EditKind = "pause" | "end_earlier" | "run_longer" | "spend_less" | "spend_more" | "copy" | "resume";
/**
 * instant: a lowering that applies at once ([Pause]). undo: a lowering that applies at once and offers Undo ([End earlier],
 * [Spend less per day]); the Undo is a raise, so it opens the confirm sheet. confirm: a raise, shown in a confirm sheet with the
 * cost line first. local: a local draft only, never Meta's own copy endpoint (D25).
 */
export type EditMode = "instant" | "undo" | "confirm" | "local";

export const EDIT_MODE: Readonly<Record<EditKind, EditMode>> = Object.freeze({
  pause: "instant",
  end_earlier: "undo",
  spend_less: "undo",
  run_longer: "confirm",
  spend_more: "confirm",
  copy: "local",
  resume: "confirm",
});

const EDIT_COPY: Readonly<Record<EditKind, PromoteCopyKey>> = {
  pause: "edit.pause",
  end_earlier: "edit.end_earlier",
  run_longer: "edit.run_longer",
  spend_less: "edit.spend_less",
  spend_more: "edit.spend_more",
  copy: "edit.copy",
  resume: "edit.resume",
};

export const editLabel = (kind: EditKind): string => promoteText(EDIT_COPY[kind]);

/** A raise: Phase 0 checks it first, so it is never applied without the confirm sheet. */
export const editNeedsConfirm = (kind: EditKind): boolean => EDIT_MODE[kind] === "confirm";

/** A new daily budget against the current one: a cut applies at once with Undo; a raise needs the confirm sheet. */
export function budgetEdit(currentMinor: number, nextMinor: number): { kind: "spend_less" | "spend_more"; mode: EditMode } | null {
  const k = budgetChangeKind(currentMinor, nextMinor);
  if (k === "same") return null;
  const kind = k === "cut" ? "spend_less" : "spend_more";
  return { kind, mode: EDIT_MODE[kind] };
}

/** A new end against the current one: an earlier end (or a first end) applies at once with Undo; a later end needs the confirm sheet. */
export function endEdit(current: Date | null, next: Date): { kind: "end_earlier" | "run_longer"; mode: EditMode } | null {
  const k = endChangeKind(current, next);
  if (k === "same") return null;
  const kind = k === "earlier" ? "end_earlier" : "run_longer";
  return { kind, mode: EDIT_MODE[kind] };
}

/** The Undo of a lowering is the matching raise, through the confirm sheet (a raise is never applied without it). */
export function undoKindOf(kind: "end_earlier" | "spend_less"): "run_longer" | "spend_more" {
  return kind === "end_earlier" ? "run_longer" : "spend_more";
}

export type EditCampaignLite = {
  status: string;
  metaCampaignId: string | null;
  surface?: string | null;
  endsAt?: string | null;
  adSets: readonly { metaAdSetId: string | null; dailyBudgetMinor: number | null; lifetimeBudgetMinor?: number | null }[];
};

export type EditButton = { kind: EditKind; mode: EditMode; label: string; disabled: boolean; reason: string | null };

export const EDITS_TEXT = {
  heading: "Change this campaign",
  restricted: "Meta has limited ads on this account, so it can't spend more for now. Pausing and spending less still work.",
  /** Phase 0 2.3.13: what a stop paused, only the owner or an approver resumes. */
  stopResume: "A stop paused this, so only the owner or an approver can resume it. Ask one of them.",
  /** The spend summary hasn't said yet who may resume: [Resume] waits (2.3.13 fails closed). */
  resumeChecking: "Checking who can resume this…",
  resumeCheckFailed: "We couldn't check who can resume this. Reload the page to try again.",
  /** All spending is stopped (freeze `all`): nothing resumes or spends more until it is turned back on. */
  frozen: "All spending is stopped.",
  frozenOwner: "Turn it back on in Settings > Spending limits, then resume this.",
  frozenPlatform: "Edwyz has paused spending for all workspaces while we check something. You can resume this when it's back.",
  /** PROMOTE_ENABLED keeps starting closed (route-guard PROMOTE_START_CLOSED): the server refuses a resume. */
  startClosed: "Turning ads back on from here isn't open yet. It stays paused, so nothing is spent.",
  noDaily: "This campaign has a lifetime budget, so its daily budget is changed in Meta Ads Manager.",
  noEndToUndo: "This campaign had no end date before, so there's nothing to put back.",
  undoBudget: (amount: string) => `Daily budget is now ${amount}.`,
  undoEnd: (date: string) => `It now ends on ${date}.`,
  copied: "A copy was saved as a draft. Nothing was sent to Meta.",
  paused: "Paused. Nothing is being spent.",
  resumed: "It's running again.",
} as const;

const hasDaily = (c: EditCampaignLite) => c.adSets.some((s) => s.metaAdSetId && (s.dailyBudgetMinor !== null || s.lifetimeBudgetMinor === null || s.lifetimeBudgetMinor === undefined));

export type EditOptions = {
  /** The ad account is restricted: every raise is disabled with EDITS_TEXT.restricted. */
  blocksStart?: boolean;
  /** Offer [Resume] (default: promotions only). */
  showResume?: boolean;
  /** False: [Resume] is disabled with resumeNote (pauseCauseOf). */
  canResume?: boolean;
  /** Why [Resume] is disabled when canResume is false (default: the 2.3.13 stop note). */
  resumeNote?: string | null;
  /** All spending is stopped: [Resume] and every raise are disabled with this reason. */
  raisesBlocked?: string | null;
  /** False while starting promotions is closed (promoteAccess canStart): the server refuses a resume, so [Resume] says so. */
  canStart?: boolean;
};

/**
 * The edit buttons of a campaign, in the 3.9 order. On Meta: [Pause] while active, [Resume] while paused (promotions only:
 * old-wizard campaigns keep their typed activation, D5), the end and budget edits, and [Make a copy]. A draft, an error or an
 * archived campaign can only be copied. While the ad account is restricted, or all spending is stopped, every raise is
 * disabled with the reason; pausing and every lowering still work. [Resume] is also disabled, with the reason, while starting
 * is closed (canStart false), and when canResume is false: a stop paused it and this member is neither the owner nor an
 * approver, or the summary hasn't said yet who may resume.
 */
export function availableEdits(c: EditCampaignLite, opts: EditOptions = {}): EditButton[] {
  const btn = (kind: EditKind, disabled = false, reason: string | null = null): EditButton => ({ kind, mode: EDIT_MODE[kind], label: editLabel(kind), disabled, reason });
  const onMeta = (c.status === "active" || c.status === "paused") && !!c.metaCampaignId;
  if (c.status === "launching") return [];
  if (!onMeta) return [btn("copy")];
  const raiseReason = opts.blocksStart === true ? EDITS_TEXT.restricted : opts.raisesBlocked?.trim() || null;
  const raise = (kind: EditKind) => btn(kind, raiseReason !== null, raiseReason);
  const resume = (): EditButton => {
    if (raiseReason) return raise("resume");
    if (opts.canStart === false) return btn("resume", true, EDITS_TEXT.startClosed);
    if (opts.canResume === false) return btn("resume", true, opts.resumeNote?.trim() || EDITS_TEXT.stopResume);
    return btn("resume");
  };
  const out: EditButton[] = [];
  if (c.status === "active") out.push(btn("pause"));
  if (c.status === "paused" && (opts.showResume ?? isPromoteSurface(c.surface))) out.push(resume());
  out.push(btn("end_earlier"), raise("run_longer"));
  if (hasDaily(c)) out.push(btn("spend_less"), raise("spend_more"));
  out.push(btn("copy"));
  return out;
}

/**
 * What a budget edit applies (3.8). Outside a fair test, the typed amount. While a fair test runs, the server splits the typed
 * daily total into equal shares rounded down to a whole unit, so the confirm, the cost line and the message use the sum of
 * the shares, never the typed total (₹301 on two versions is ₹150 each, ₹300 in all). A share under one whole unit is refused
 * by the server, so `problem` says so first.
 */
export function appliedBudget(typedMinor: number, opts: { fair: boolean; versions: number; currency: string }): { minor: number; shareMinor: number | null; problem: string | null } {
  if (!opts.fair) return { minor: typedMinor, shareMinor: null, problem: null };
  const split = splitDaily(BigInt(Math.max(0, Math.trunc(typedMinor))), opts.versions, opts.currency);
  const min = majorUnit(opts.currency);
  const problem = split.shareMinor < min ? promoteText("version.min_share", { min: { minor: min, currency: opts.currency } }) : null;
  return { minor: Number(split.confirmedTotalMinor), shareMinor: Number(split.shareMinor), problem };
}

/**
 * The amounts [Resume] confirms. The server checks confirmTotalMinor exactly: the daily budgets plus the lifetime budgets of
 * lifetime-only ad sets. The sheet shows that amount, not only the daily part.
 */
export function resumeAmounts(c: { totalDailyBudgetMinor: number; confirmTotalMinor?: number | null }): { confirmMinor: number; dailyMinor: number; lifetimeMinor: number } {
  const dailyMinor = Math.max(0, Math.trunc(c.totalDailyBudgetMinor));
  const confirmMinor = typeof c.confirmTotalMinor === "number" && Number.isFinite(c.confirmTotalMinor) ? Math.trunc(c.confirmTotalMinor) : dailyMinor;
  return { confirmMinor, dailyMinor, lifetimeMinor: Math.max(0, confirmMinor - dailyMinor) };
}

export const RESUME_TEXT = {
  label: (a: ReturnType<typeof resumeAmounts>, currency: string): string => {
    const m = (n: number) => formatMoney(n, currency);
    if (a.lifetimeMinor === 0) return `Resume · up to ${m(a.dailyMinor)} a day`;
    if (a.dailyMinor === 0) return `Resume · ${m(a.lifetimeMinor)} lifetime budget`;
    return `Resume · ${m(a.confirmMinor)} (${m(a.dailyMinor)} a day plus ${m(a.lifetimeMinor)} lifetime)`;
  },
  body: (a: ReturnType<typeof resumeAmounts>, currency: string): string => {
    const m = (n: number) => formatMoney(n, currency);
    const check = "We check it against your spending limits first.";
    if (a.lifetimeMinor === 0) return `It starts showing again and can spend up to ${m(a.dailyMinor)} a day. ${check}`;
    if (a.dailyMinor === 0) return `It starts showing again and spends its lifetime budget of ${m(a.lifetimeMinor)} over the rest of the run. ${check}`;
    return `It starts showing again and can spend up to ${m(a.dailyMinor)} a day, plus its lifetime budget of ${m(a.lifetimeMinor)}. ${check}`;
  },
  /** Under the cost line, or in its place when there is no daily budget: the lifetime part isn't a daily amount. */
  lifetime: (amount: string) => `It also has a lifetime budget of ${amount}, which Meta spends over the whole run.`,
  lifetimeOnly: (amount: string) => `This has a lifetime budget of ${amount}, which Meta spends over the whole run.`,
} as const;

/** Whole days left until the end (at least 2, at most 90, as the cost line counts runs), or null without an end date. */
export function daysLeft(endsAt: string | Date | null | undefined, now: Date): number | null {
  const end = toDate(endsAt);
  if (!end) return null;
  const days = Math.ceil((end.getTime() - now.getTime()) / 86_400_000);
  return Math.min(90, Math.max(2, days));
}

export type FairTestLite = { mode?: string | null; status?: string | null; winnerAdSetId?: string | null } | null | undefined;

/** A fair test still running (3.8): its budget edits keep the split, every version at the same share. */
export function runningFairTest(test: FairTestLite, adSets: readonly { metaAdSetId: string | null; variantKey?: string | null }[]): boolean {
  if (!test || test.mode !== "fair_split" || test.winnerAdSetId || !["draft", "running"].includes(String(test.status))) return false;
  return adSets.filter((s) => s.metaAdSetId && s.variantKey).length > 1;
}

/** "Fair test: ₹300 a day split equally, ₹150 for each version. …", with the share rounded down to a whole unit. */
export function fairSplitLine(totalMinor: number, versions: number, currency: string): string {
  const split = splitDaily(BigInt(Math.max(0, Math.trunc(totalMinor))), versions, currency);
  return promoteText("version.split", { total: { minor: split.confirmedTotalMinor, currency }, share: { minor: split.shareMinor, currency } });
}

// =====================================================================================================================
// Results (3.10)
// =====================================================================================================================

export type ResultTabId = "overview" | "placement" | "creative" | "who" | "leads";
export const RESULT_TABS: readonly { id: ResultTabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "placement", label: "Where it worked" },
  { id: "creative", label: "Which version worked" },
  { id: "who", label: "Who saw it" },
  { id: "leads", label: "Leads" },
];

export const RESULTS_TEXT = {
  heading: "Results",
  /** D24: boosted posts show paid results only. */
  organicNote: promoteText("boost.paid_only"),
  spend: "Spent",
  results: "Results",
  reach: "People reached",
  ctr: promoteText("results.ctr"),
  cpm: promoteText("results.cost_per_1000"),
  notYet: "Not yet",
  loading: "Loading results",
  failed: "These results didn't load. Check your connection and try again.",
  retry: "Try again",
  ageGender: "Age and gender",
  region: "Region",
  assets: "Each part of the ad",
  empty: "No results yet. They show here a few hours after your ad starts.",
} as const;

/** The days the Results tabs read, inclusive, as ad-account-local "YYYY-MM-DD" (the insights rows are stored that way). */
export type ResultsRange = { from: string; to: string };

/** The insights routes take at most 366 days (lib/reports/range MAX_RANGE_DAYS). */
export const RESULTS_MAX_DAYS = 366;

/**
 * The run's days for the Results tabs: from the run's start (startsAt, else when it was launched, else when it was made) to
 * today, or to the end date when that is earlier, both in the ad account's zone (D30; Asia/Kolkata when unknown). A start
 * after the end of the range is moved to it, and the span is kept within 366 days (the latest days), so the route never
 * refuses the range.
 */
export function resultsRange(
  c: { startsAt?: string | Date | null; launchedAt?: string | Date | null; createdAt?: string | Date | null; endsAt?: string | Date | null },
  timeZone: string | null | undefined,
  now: Date,
): ResultsRange {
  const tz = resolveTimeZone(timeZone);
  const today = dayKey(now, tz);
  const end = toDate(c.endsAt);
  const endDay = end ? dayKey(end, tz) : null;
  const to = endDay !== null && endDay < today ? endDay : today;
  const start = toDate(c.startsAt) ?? toDate(c.launchedAt) ?? toDate(c.createdAt);
  let from = start ? dayKey(start, tz) : to;
  if (from > to) from = to;
  const earliest = addDays(to, -(RESULTS_MAX_DAYS - 1));
  if (from < earliest) from = earliest;
  return { from, to };
}

/** GET /api/ads/insights/dimensions for one tab over the run's days (the route refuses a request without from and to). */
export function resultsPath(campaignId: string, dimension: "overview" | "placement" | "creative" | "age_gender" | "region" | "leads", range: ResultsRange): string {
  return `/api/ads/insights/dimensions?campaignId=${encodeURIComponent(campaignId)}&dimension=${dimension}&from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
}

/** "Instagram Reels" for a known place; an unknown one shows its raw key: "Facebook: biz_disco_feed" (4.2). */
export const placementLabel = (dimKey: string): string => placementName(dimKey);

/** One results row as the dimensions route answers it (ResultRowView). */
export type ResultRowLite = {
  key: string;
  label?: string | null;
  text?: string | null;
  results: number;
  spendMinor: string;
  costPerResultMinor: string | null;
  costPerResult?: string | null;
  counted?: boolean;
};

export type BarRow = { key: string; label: string; text: string; percent: number };

const bigOf = (v: string | null | undefined): bigint | null => (typeof v === "string" && /^-?\d{1,30}$/.test(v) ? BigInt(v) : null);

/** Cheapest per result first; rows without a cost last, the biggest spend first among them. Exact (bigint). */
export function byCostPerResult<T extends Pick<ResultRowLite, "costPerResultMinor" | "spendMinor" | "results">>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const [x, y] = [bigOf(a.costPerResultMinor), bigOf(b.costPerResultMinor)];
    if (x !== null && y !== null && x !== y) return x < y ? -1 : 1;
    if (x === null && y !== null) return 1;
    if (x !== null && y === null) return -1;
    if (a.results !== b.results) return b.results - a.results;
    const [sa, sb] = [bigOf(a.spendMinor) ?? 0n, bigOf(b.spendMinor) ?? 0n];
    return sa > sb ? -1 : sa < sb ? 1 : 0;
  });
}

/**
 * The bars of "Where it worked" (and the other breakdown tabs): sorted by cost per result, each with its text value
 * ("Instagram Reels: 46 chats, ₹31 each"), so colour and length are never the only signal. The bar length is the share of
 * the largest result count. Placement keys without a label get the catalogue's name, or the raw key when Meta's is unknown.
 */
export function resultBars(rows: readonly ResultRowLite[], opts: { placements?: boolean } = {}): BarRow[] {
  const sorted = byCostPerResult(rows);
  const max = Math.max(0, ...sorted.map((r) => (r.counted === false ? 0 : r.results)));
  return sorted.map((r) => {
    const label = r.label?.trim() || (opts.placements ? placementLabel(r.key) : r.key);
    const cost = r.costPerResult ?? null;
    const text = r.text?.trim() || (cost ? `${label}: ${formatCount(r.results)} results, ${cost} each` : `${label}: no results yet`);
    const count = r.counted === false ? 0 : r.results;
    return { key: r.key, label, text, percent: max > 0 ? Math.round((count / max) * 100) : 0 };
  });
}

/** The Overview's figures (OverviewView). */
export type OverviewLite = {
  spend: string;
  resultsText: string;
  costPerResult: string | null;
  costPerResultLabel: string;
  reach: number | null;
  reachLabel: string;
  ctr: number | null;
  cpm: string | null;
};

export type OverviewTile = { key: "spend" | "results" | "cost" | "reach" | "ctr" | "cpm"; label: string; value: string };

/**
 * People reached as the Overview shows it: the run's own total (R3a) or that one day's, as the server gives it. Daily rows are
 * never added up, because daily reach counts the same person once per day (3.10); without the run total it says so.
 */
export function reachShown(overview: Pick<OverviewLite, "reach" | "reachLabel">, _dailyRows?: readonly { reach?: number | null }[]): { value: string; label: string } {
  return { value: overview.reach === null ? RESULTS_TEXT.notYet : formatCount(overview.reach), label: overview.reachLabel };
}

/** The Overview tiles: spend, results, cost per result, the run's reach, and CTR and CPM in plain words. */
export function overviewTiles(o: OverviewLite): OverviewTile[] {
  const reach = reachShown(o);
  return [
    { key: "spend", label: RESULTS_TEXT.spend, value: o.spend },
    { key: "results", label: RESULTS_TEXT.results, value: o.resultsText },
    { key: "cost", label: o.costPerResultLabel, value: o.costPerResult ?? RESULTS_TEXT.notYet },
    { key: "reach", label: reach.label, value: reach.value },
    { key: "ctr", label: RESULTS_TEXT.ctr, value: o.ctr === null ? RESULTS_TEXT.notYet : o.ctr.toFixed(2) },
    { key: "cpm", label: RESULTS_TEXT.cpm, value: o.cpm ?? RESULTS_TEXT.notYet },
  ];
}

export type LeadsLite = { total: number; instagram: number; facebook: number; source: "leads" | "meta_report"; platformNote?: string | null };

/**
 * "Leads from this ad: 23 (Instagram 17, Facebook 6)". While Meta doesn't say each lead's app, the split is Meta's own count,
 * labelled "From Meta's report", and the list says "Instagram or Facebook: not reported by Meta" (3.10).
 */
export function leadsLine(l: LeadsLite): { text: string; note: string | null; platformNote: string | null } {
  return {
    text: promoteText("results.leads_from_ad", { total: l.total, instagram: l.instagram, facebook: l.facebook }),
    note: l.source === "meta_report" ? promoteText("results.from_meta_report") : null,
    platformNote: l.platformNote ?? null,
  };
}

// =====================================================================================================================
// Compare versions (3.8)
// =====================================================================================================================

export type VerdictLite = {
  state: "too_early" | "likely_winner";
  winner: { adSetId: string; key: string; costPerResult: string } | null;
  runnerUp: { key: string; costPerResult: string } | null;
  hint?: string | null;
};

/** "Version B gets chats at ₹38 vs ₹55: likely winner." or "Too early to tell." */
export function verdictText(v: VerdictLite, noun: string): string {
  if (v.state === "likely_winner" && v.winner && v.runnerUp) {
    return promoteText("version.winner", { winner: v.winner.key, results: noun, winnerCost: v.winner.costPerResult, otherCost: v.runnerUp.costPerResult });
  }
  return promoteText("version.too_early");
}

/** "Keep B, pause the others". */
export const keepLabel = (key: string): string => promoteText("version.keep", { winner: key });

export const COMPARE_TEXT = {
  heading: "Compare versions",
  kept: (key: string) => `Kept version ${key}. The others are paused.`,
  undoTitle: "Turn the other versions back on?",
  undoBody: "Turning a version back on spends again, so it's checked against your limits first.",
  undoConfirm: "Turn them back on",
  undone: "The other versions are back on.",
  failed: "The comparison didn't load. Try again.",
} as const;

/** The version [Keep …] offers: the likely winner while the test still runs, else none. */
export function keepCandidate(c: { canPickWinner: boolean; verdict: VerdictLite }): { adSetId: string; key: string } | null {
  if (!c.canPickWinner || c.verdict.state !== "likely_winner" || !c.verdict.winner) return null;
  return { adSetId: c.verdict.winner.adSetId, key: c.verdict.winner.key };
}

// =====================================================================================================================
// Audiences (3.7, D17)
// =====================================================================================================================

/**
 * What each PROMOTE_AUDIENCES level offers (the same table as lib/promote/audiences KINDS_BY_LEVEL, which the server enforces;
 * a test keeps the two equal): off saved only; engagement adds people who engaged, website visitors and lookalikes; all adds
 * customer lists (in production only with LEGAL_DPDP_AUDIENCES_OK=1, which the server's level already reflects).
 */
export const AUDIENCE_KINDS_BY_LEVEL: Readonly<Record<PromoteAudiences, readonly AudienceKind[]>> = Object.freeze({
  off: ["saved"],
  engagement: ["saved", "engagement_instagram", "engagement_page", "engagement_lead_form", "website", "lookalike"],
  all: ["saved", "customer_list", "engagement_instagram", "engagement_page", "engagement_lead_form", "website", "lookalike"],
});

/** The kinds to offer: the level's, narrowed to the server's own list when it sent one. */
export function audienceKindsFor(level: PromoteAudiences | null | undefined, serverKinds?: readonly string[] | null): AudienceKind[] {
  const kinds = AUDIENCE_KINDS_BY_LEVEL[level ?? "off"] ?? AUDIENCE_KINDS_BY_LEVEL.off;
  return serverKinds ? kinds.filter((k) => serverKinds.includes(k)) : [...kinds];
}

export const AUDIENCE_KIND_TEXT: Readonly<Record<AudienceKind, { title: string; body: string }>> = Object.freeze({
  saved: { title: "Saved audience", body: "A name and who to show your ads to. Kept in Edwyz." },
  customer_list: { title: "Past customers", body: "Contacts who agreed to get marketing messages from you." },
  engagement_instagram: { title: "People who engaged on Instagram", body: "People who liked, saved, messaged or visited your Instagram account." },
  engagement_page: { title: "People who engaged with your Page", body: "People who liked, commented on or messaged your Facebook Page." },
  engagement_lead_form: { title: "People who opened your form", body: "People who opened or sent one of your lead forms." },
  website: { title: "Website visitors", body: "People who visited your website, from your pixel." },
  lookalike: { title: "People like your customers", body: "New people in India who are like an audience you already have." },
});

export const AUDIENCE_EVENT_TEXT: Readonly<Record<string, string>> = Object.freeze({
  ig_all: "Everyone who engaged",
  ig_messaged: "People who messaged you",
  page_engaged: "Everyone who engaged",
  page_messaged: "People who messaged you",
  lead_opened: "Opened the form",
  lead_submitted: "Sent the form",
  website_all: "All visitors",
  website_url: "Visitors of pages whose address contains a word",
});

/** The status chip (3.7): Getting ready, Ready, Too small, Problem, with a tone (the word is always shown). */
export function audienceChipView(chip: AudienceChip): { label: string; tone: Tone } {
  const tone: Record<AudienceChip, Tone> = { getting_ready: "info", ready: "good", too_small: "warn", problem: "bad" };
  return { label: promoteText(`audience.status.${chip}` as PromoteCopyKey), tone: tone[chip] };
}

/** The size range ("About 1.2–1.8 lakh people"); saved audiences have none, and an unknown size says so. */
export function audienceSizeText(a: { kind: string; sizeLine?: string | null }): string {
  if (a.sizeLine) return a.sizeLine;
  return a.kind === "saved" ? "Kept in Edwyz. Meta sizes it when your ad starts." : promoteText("audience.size_unknown");
}

/** Days to look back for an engagement or website audience: the default, and the most allowed. */
export const retentionFor = (kind: AudienceEventKind): { defaultDays: number; maxDays: number } => retentionBounds(kind);

export const LOOKALIKE_RANGE = { min: LOOKALIKE.minPercent, max: LOOKALIKE.maxPercent, note: promoteText("audience.lookalike_note") } as const;

export const AUDIENCE_TEXT = {
  heading: "Audiences",
  intro: "Groups of people you can show your ads to. Pick one under People I choose when you make an ad.",
  create: "Make an audience",
  kindLabel: "What kind of audience",
  name: "Name",
  nameHint: "Only you see this name.",
  refresh: "Refresh",
  delete: "Delete",
  empty: "No audiences yet. Make one to reuse it in your ads.",
  loadFailed: "Your audiences didn't load. Check your connection and try again.",
  /** The lawful basis line (11.1a decision 3): only consented contacts, and the server records `marketing_opt_in`. */
  lawfulBasis: "Only contacts who agreed to get marketing messages and haven't opted out are included. That consent is the reason we may share them.",
  shareTitle: "Share contacts with Meta?",
  shareConfirm: (count: number) => `Share ${formatCount(count)} contacts`,
  refreshTitle: "Share the list with Meta again?",
  refreshConfirm: "Share again",
  deleteTitle: (name: string) => `Delete "${name}"?`,
  deleteBody: "It's deleted on Meta too. If an ad or a lookalike still uses it, remove it there first.",
  deleteConfirm: "Delete audience",
  deleted: (name: string) => `Deleted "${name}".`,
  created: (name: string) => `Made "${name}". Meta takes a few minutes to get it ready.`,
  saved: (name: string) => `Saved "${name}".`,
  refreshed: (name: string) => `Asked Meta for the latest about "${name}".`,
  termsMissing: promoteText("error.custom_audience_tos"),
  segment: "Segment",
  allContacts: "All contacts",
  tag: "Tag",
  tagHint: "Optional. Only contacts with this tag.",
  checkCount: "Check how many can be included",
  source: "Where people engaged",
  event: "What people did",
  days: "Days to look back",
  daysHint: (max: number) => `From 1 to ${max} days.`,
  urlWord: "Pages whose address contains",
  urlWordHint: "Optional. Leave empty for all visitors.",
  seed: "Find people like",
  percent: "How similar",
  percentHint: (min: number, max: number) => `From ${min}% to ${max}%. ${promoteText("audience.lookalike_note")}.`,
  country: "Country",
  ageMin: "Youngest age",
  ageMax: "Oldest age",
  gender: "Gender",
  anyGender: "Everyone",
  women: "Women",
  men: "Men",
  noSources: "Connect your Facebook Page or Instagram account first.",
  noSeeds: "Make another audience first, and wait until it shows Ready.",
  save: "Save audience",
  make: "Make audience",
  cancel: "Cancel",
  agentsOnly: "Audiences are for owners and admins. Ask one of them for help.",
} as const;

/**
 * The customer-list confirm card (3.7): "Share 1,240 contacts with Meta to find them on Facebook and Instagram. Phone numbers
 * and emails are scrambled (hashed) before they leave Edwyz.", the lawful basis, and "1,240 of 1,610 contacts can be
 * included." Under 100 people it says "Too small: Meta needs at least 100 people." and offers nothing to share.
 */
export function customerListConfirm(count: { included: number; total: number }): { title: string; lines: string[]; canShare: boolean; confirmLabel: string | null } {
  const included = Math.max(0, Math.floor(count.included));
  const total = Math.max(included, Math.floor(count.total));
  const countLine = promoteText("audience.can_include", { included, total });
  if (included < MIN_AUDIENCE_PEOPLE) return { title: AUDIENCE_TEXT.shareTitle, lines: [countLine, promoteText("audience.too_small")], canShare: false, confirmLabel: null };
  return { title: AUDIENCE_TEXT.shareTitle, lines: [promoteText("audience.upload", { count: included }), AUDIENCE_TEXT.lawfulBasis, countLine], canShare: true, confirmLabel: AUDIENCE_TEXT.shareConfirm(included) };
}

/** What the create form holds, as typed. */
export type AudienceForm = {
  name: string;
  segmentId: string;
  tag: string;
  sourceId: string;
  event: string;
  days: string;
  urlContains: string;
  seedAudienceId: string;
  percent: string;
  country: string;
  ageMin: string;
  ageMax: string;
  gender: "" | "female" | "male";
};

export const emptyAudienceForm = (): AudienceForm => ({
  name: "",
  segmentId: "",
  tag: "",
  sourceId: "",
  event: "",
  days: "",
  urlContains: "",
  seedAudienceId: "",
  percent: String(LOOKALIKE.minPercent),
  country: "IN",
  ageMin: "18",
  ageMax: "65",
  gender: "",
});

const EVENT_KIND: Partial<Record<AudienceKind, AudienceEventKind>> = {
  engagement_instagram: "engagement_instagram",
  engagement_page: "engagement_page",
  engagement_lead_form: "engagement_lead_form",
  website: "website",
};

const wholeNumber = (s: string): number | null => (/^\s*\d{1,4}\s*$/.test(s) ? Number(s) : null);

/**
 * The POST /api/promote/audiences body for a kind, or the first problem in plain words. The server checks the same rules
 * (and more); this only stops a request that can't succeed.
 */
export function audienceBody(kind: AudienceKind, f: AudienceForm): { ok: true; body: Record<string, unknown> } | { ok: false; problem: string } {
  const name = f.name.trim();
  if (name.length > 100) return { ok: false, problem: "Give the audience a name of up to 100 characters." };
  const body: Record<string, unknown> = { kind, ...(name ? { name } : {}) };
  const eventKind = EVENT_KIND[kind];
  if (eventKind) {
    const { defaultDays, maxDays } = retentionBounds(eventKind);
    const days = f.days.trim() === "" ? defaultDays : wholeNumber(f.days);
    if (days === null || days < 1 || days > maxDays) return { ok: false, problem: `Choose between 1 and ${maxDays} days.` };
    body.retentionDays = days;
  }
  switch (kind) {
    case "saved": {
      const country = f.country.trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(country)) return { ok: false, problem: "Enter a 2-letter country code, like IN." };
      const [min, max] = [wholeNumber(f.ageMin), wholeNumber(f.ageMax)];
      if (min === null || max === null || min < 13 || max > 65) return { ok: false, problem: "Ages must be between 13 and 65." };
      if (min > max) return { ok: false, problem: "The youngest age can't be higher than the oldest." };
      body.targeting = { geo: { countries: [country], cities: [] }, ageMin: min, ageMax: max, genders: f.gender ? [f.gender] : [], interests: [], placements: [] };
      return { ok: true, body };
    }
    case "customer_list":
      if (f.segmentId) body.segmentId = f.segmentId;
      if (f.tag.trim()) body.tag = f.tag.trim();
      return { ok: true, body };
    case "website":
      if (f.urlContains.trim()) body.urlContains = f.urlContains.trim();
      return { ok: true, body };
    case "lookalike": {
      if (!f.seedAudienceId) return { ok: false, problem: "Choose the audience to find people like." };
      const percent = wholeNumber(f.percent);
      if (percent === null || percent < LOOKALIKE.minPercent || percent > LOOKALIKE.maxPercent) return { ok: false, problem: `Pick ${LOOKALIKE.minPercent}% to ${LOOKALIKE.maxPercent}%.` };
      body.seedAudienceId = f.seedAudienceId;
      body.percent = percent;
      return { ok: true, body };
    }
    default:
      if (!f.sourceId) return { ok: false, problem: "Choose where people engaged." };
      body.sourceId = f.sourceId;
      if (f.event) body.event = f.event;
      return { ok: true, body };
  }
}

/** The customer-list preview path (GET, the database only: nothing goes to Meta). */
export function customerPreviewPath(selection: { segmentId?: string | null; tag?: string | null }): string {
  const p = new URLSearchParams({ preview: "customer_list" });
  if (selection.segmentId) p.set("segmentId", selection.segmentId);
  if (selection.tag?.trim()) p.set("tag", selection.tag.trim());
  return `/api/promote/audiences?${p.toString()}`;
}

/** An amount for a button or a line, in the ad account's currency. */
export const money = (minor: number | bigint, currency: string): string => formatMoney(minor, currency);
