/**
 * Pure logic of the Boost and New ad flows (docs/IG-PAGE-ADS-SPEC.md 3.1, 3.3 to 3.7, 3.12, 7.1 to 7.3, 7.5, 7.6, D2, D4, D5,
 * D15, D23; PRM-14). No React, no DOM: the components next to this file call these functions, and tests/promote-ui.test.ts
 * pins them.
 *
 * - Steps: Boost is post, goal, who and how much, review (4 screens). A new ad is goal, ad, who and how much, review, with the
 *   form before the ad for lead form ads. "Step 2 of 4" and the step's h2 come from here.
 * - Smart defaults (3.1): the goal from what the workspace has (WhatsApp linked to the Page, forms, a link in the post), ₹300 a
 *   day or the most that fits (maxFittingDaily), and 7 days.
 * - Post picker: the tabs a Page-backed identity can't use are dropped, each tile's accessible name, the keyboard grid.
 * - Autosave: PATCH with expectedUpdatedAt after every step and on blur; a 409 shows "Someone else changed this draft. Showing
 *   the latest." and loads it; a slow or failed network keeps "Not saved yet" and tries again.
 * - The review card: its state's copy and buttons, the amount on the button (D5), the 600 ms guard, the typed figure only above
 *   the threshold, and the one-tap fixes, each mapped to its exact draft change.
 * - More options (3.12): only the positions this goal and format can use, and the "2 extra settings changed · Reset" chip.
 *
 * Every string comes from src/lib/promote/copy (pages render English until PROMOTE_PAGE_LANGS allows more, D23).
 */
import type { Tone } from "@/components/ui";
import type { UntrustedText } from "@/lib/actions/types";
import { availablePlacements } from "@/lib/promote/catalog";
import { CTA_BY_GOAL } from "@/lib/promote/catalog/cta";
import { BOOST_NEEDS_BUTTON, boostCtaProven, goalRow, GOALS, type BoostOptions } from "@/lib/promote/catalog/goals";
import { placementRow, type MetaPlatform } from "@/lib/promote/catalog/placements";
import { formatDay, formatMoney, formatTime, promoteText, type PromoteCopyKey } from "@/lib/promote/copy";
import { budgetStep, defaultDailyMinor, majorUnit, maxFittingDaily, type FromInr } from "@/lib/promote/cost";
import { DEFAULT_RUN_DAYS, localTimeToInstant, MAX_RUN_DAYS, MAX_START_AHEAD_DAYS, MIN_RUN_DAYS, runDates } from "@/lib/promote/dates";
import { chipPathOf, defaultDraft, DRAFT_PATH_LIST, DRAFT_PATHS, hiddenNonDefaults, readPath } from "@/lib/promote/draft-paths";
import type { DefaultFacts, SmartDefaults } from "@/lib/promote/defaults";
import type { PromoteAccess } from "@/lib/promote/flags";
import type { AdMediaView } from "@/lib/promote/media";
import type { BoostableItem, SourceTab, SourcesResult } from "@/lib/promote/sources";
import type { PrereqFix, PrereqRow } from "@/lib/promote/prereqs";
import {
  isGoalKey,
  type AdFormat,
  type CompareMode,
  type DraftMedia,
  type DraftText,
  type FormType,
  type GoalKey,
  type IceBreaker,
  type MetaScreenKey,
  type PlacementKey,
  type PlacementMode,
  type PromoteLang,
  type PromotionDraft,
  type ShopLocation,
  type SourceKind,
  type Tier,
} from "@/lib/promote/types";
import { adStepInUse, emptyVersion, isHttpsUrl, type AdStepSource, type AdStepValue, type AdVersionValue, type CarouselCardValue } from "./creative-helpers";

// =====================================================================================================================
// Steps (3.3, 3.4, 3.5, 7.2, 7.5)
// =====================================================================================================================

export type FlowKind = "boost" | "create";
export const STEP_IDS = ["post", "goal", "form", "ad", "audience", "review"] as const;
export type StepId = (typeof STEP_IDS)[number];
export const isStepId = (v: unknown): v is StepId => typeof v === "string" && (STEP_IDS as readonly string[]).includes(v);

/** The h2 of each step (7.6: focus moves to it). The goal step asks the 3.13 question. */
export const STEP_TITLE_KEYS: Readonly<Record<StepId, PromoteCopyKey>> = {
  post: "flow.step.post",
  goal: "goal.question",
  form: "flow.step.form",
  ad: "flow.step.ad",
  audience: "flow.step.audience",
  review: "flow.step.review",
};

/** data-testid on every step, the primary, the worst-case lines, the fix chips and Opens Meta (7.6). */
export const PROMOTE_TEST_IDS = {
  shell: "promote-shell",
  back: "promote-back",
  saveExit: "promote-save-exit",
  stepCount: "promote-step-count",
  saveState: "promote-save-state",
  primary: "promote-primary",
  secondary: "promote-secondary",
  preview: "promote-preview",
  step: (id: StepId) => `promote-step-${id}`,
  postGrid: "post-picker-grid",
  postTile: "post-tile",
  postMore: "post-picker-more",
  goalCard: "goal-card",
  goalChip: "goal-chip",
  goalLink: "goal-link",
  readiness: "readiness-list",
  readinessRow: "readiness-row",
  welcome: "welcome-editor",
  audienceCards: "audience-cards",
  placePicker: "place-picker",
  sizeLine: "audience-size",
  placements: "placements",
  more: "more-options",
  hiddenChip: "hidden-settings-chip",
  review: "review-card",
  reviewState: "review-state",
  worstCase: "review-worst-case",
  worstCaseMonths: "review-worst-case-months",
  fixChips: "fix-chips",
  fixChip: "fix-chip",
  typedConfirm: "typed-confirm",
  edge: "promote-edge-note",
} as const;

/**
 * The screens of a flow, in order. Boost: pick a post, what people should do, who and how much, review (4). A new ad: goal,
 * ad, who and how much, review; a lead form ad adds its form after the goal (3.5).
 */
export function flowSteps(kind: FlowKind, goal: GoalKey | null | undefined): StepId[] {
  if (kind === "boost") return ["post", "goal", "audience", "review"];
  return goal === "lead_form" ? ["goal", "form", "ad", "audience", "review"] : ["goal", "ad", "audience", "review"];
}

/** The index of a step in the flow; the first step for anything unknown. */
export function stepAt(steps: readonly StepId[], step: unknown): number {
  const i = isStepId(step) ? steps.indexOf(step) : -1;
  return i < 0 ? 0 : i;
}

/** "Step 2 of 4". */
export function stepCountLabel(index: number, total: number, lang: PromoteLang = "en"): string {
  return promoteText("flow.step_of", { n: String(index + 1), total: String(total) }, lang);
}

/**
 * The step a page opens on: the one in the address when the flow has it, else the first. A saved draft opened without a step
 * (a tile, a notification, Content's "Boost this post") resumes after its first screen: the post or the goal is chosen already.
 */
export function resumeStep(steps: readonly StepId[], asked: StepId | null | undefined, hasDraft: boolean): StepId {
  if (asked && steps.includes(asked)) return asked;
  return hasDraft && steps.length > 1 ? steps[1] : steps[0];
}

/**
 * The step to show when there is no draft yet: only the screens before the draft is made (Boost: the post; a new ad: the goal;
 * a lead form ad: the goal and its form). An address that asks for a later step without a draft opens the first one.
 */
export function clampStep(steps: readonly StepId[], step: StepId, hasDraft: boolean): StepId {
  // A draft whose flow has no such step (a boost draft opened at /app/ads/create) resumes after its first screen.
  if (hasDraft) return steps.includes(step) ? step : resumeStep(steps, null, true);
  const before: readonly StepId[] = steps[0] === "post" ? ["post"] : steps.includes("form") ? ["goal", "form"] : ["goal"];
  return before.includes(step) ? step : steps[0];
}

// =====================================================================================================================
// The page's query (7.1): /app/ads/boost?source=&id= and /app/ads/create?goal=&source=&days=&draft=
// =====================================================================================================================

export const BOOST_PATH = "/app/ads/boost";
export const CREATE_PATH = "/app/ads/create";
export const ADS_PATH = "/app/ads";
export const ALL_SETTINGS_PATH = "/app/ads/new";
export const AUDIENCES_PATH = "/app/ads/audiences";
export const SPENDING_PATH = "/app/settings/spending";
export const CONNECTIONS_PATH = "/app/settings/connections";

export type FlowQuery = {
  draft: string | null;
  step: StepId | null;
  goal: GoalKey | null;
  /** Boost: the app the post is on. A new ad: "new" or "post" (Use a post). */
  source: "instagram" | "facebook" | "new" | "post" | null;
  /** Boost: Meta's id of the post to pre-select. */
  id: string | null;
  days: number | null;
};

const ID = /^[A-Za-z0-9_:.-]{1,128}$/;
const one = (v: string | string[] | undefined): string | null => (typeof v === "string" ? v : Array.isArray(v) ? (v[0] ?? null) : null);

/** The query as the page received it, every value checked; anything malformed reads as absent. */
export function parseFlowQuery(sp: Readonly<Record<string, string | string[] | undefined>>): FlowQuery {
  const draft = one(sp.draft);
  const step = one(sp.step);
  const goal = one(sp.goal);
  const source = one(sp.source);
  const id = one(sp.id);
  const days = Number(one(sp.days) ?? "");
  return {
    draft: draft && /^[A-Za-z0-9_-]{1,64}$/.test(draft) ? draft : null,
    step: isStepId(step) ? step : null,
    goal: isGoalKey(goal) ? goal : null,
    source: source === "instagram" || source === "facebook" || source === "new" || source === "post" ? source : null,
    id: id && ID.test(id) ? id : null,
    days: Number.isInteger(days) && days >= 1 && days <= MAX_RUN_DAYS ? days : null,
  };
}

/** The address of a flow screen, so a reload or a notification tap resumes the same draft and step (D28). */
export function flowHref(kind: FlowKind, q: Partial<FlowQuery>): string {
  const p = new URLSearchParams();
  if (q.draft) p.set("draft", q.draft);
  if (q.step) p.set("step", q.step);
  if (!q.draft) {
    if (q.goal) p.set("goal", q.goal);
    if (q.source) p.set("source", q.source);
    if (q.id) p.set("id", q.id);
    if (q.days) p.set("days", String(q.days));
  }
  const s = p.toString();
  return `${kind === "boost" ? BOOST_PATH : CREATE_PATH}${s ? `?${s}` : ""}`;
}

// =====================================================================================================================
// Smart defaults (3.1, D6, D8)
// =====================================================================================================================

/** What the 3.1 defaults read, all of it known on the server before the flow opens. */
export type PlanFacts = {
  offered: readonly GoalKey[];
  /** The workspace's WhatsApp number is linked to the Page. */
  whatsappLinked: boolean;
  hasForms: boolean;
  currency: string;
  tz: string;
  leftTodayMinor: bigint | null;
  leftMonthMinor: bigint | null;
  minDailyMinor: bigint | null;
  fromInr?: FromInr | null;
};

export type BoostPlan = { steps: StepId[]; goal: GoalKey; dailyMinor: bigint; runDays: number; stepMinor: bigint };

/** The goal a new ad opens with (3.1): the one in the address when it is offered, else the smart default among the goal cards. */
export function initialCreateGoal(ctx: Pick<FlowContext, "offered" | "whatsappLinked" | "hasForms" | "query">): GoalKey {
  const cards = GOALS.filter((g) => ctx.offered.includes(g.key) && g.tier !== "all").map((g) => g.key);
  return smartGoal({ asked: ctx.query.goal, whatsappLinked: ctx.whatsappLinked, hasForms: ctx.hasForms, postHasLink: false, allowed: cards.length ? cards : ctx.offered });
}

/** The 3.1 goal: as asked, else WhatsApp chats when the number is linked, else a form, else the website, else engagement. */
export function smartGoal(i: { asked?: GoalKey | null; whatsappLinked: boolean; hasForms: boolean; postHasLink: boolean; allowed: readonly GoalKey[] }): GoalKey {
  const ok = (g: GoalKey) => i.allowed.includes(g);
  if (i.asked && ok(i.asked)) return i.asked;
  if (i.whatsappLinked && ok("whatsapp_chats")) return "whatsapp_chats";
  if (i.hasForms && ok("lead_form")) return "lead_form";
  if (i.postHasLink && ok("website_visits")) return "website_visits";
  if (ok("engagement")) return "engagement";
  return i.allowed[0] ?? "engagement";
}

/** The run length: as asked, else 7; never below 2 (D31) or above 90 (D6). */
export const planDays = (asked: number | null | undefined): number =>
  typeof asked === "number" && Number.isFinite(asked) ? Math.min(MAX_RUN_DAYS, Math.max(MIN_RUN_DAYS, Math.floor(asked))) : DEFAULT_RUN_DAYS;

/** The goals a post can be boosted for now: the goal takes posts, and a goal whose button carries a value is proven (V-P3). */
export function boostableGoals(offered: readonly GoalKey[], source: Exclude<SourceKind, "new">, opts: BoostOptions = {}): GoalKey[] {
  return offered.filter((g) => goalRow(g).sources.includes(source) && (!BOOST_NEEDS_BUTTON.has(g) || boostCtaProven(g, opts)));
}

/**
 * The defaults a boost opens with (3.1, 3.3): 4 screens, the 3.1 goal among the goals this post can use, ₹300 a day or the
 * most that fits today and this month (rounded down to the step, never below Meta's minimum), and 7 days.
 */
export function boostPlan(facts: PlanFacts, post: { source: Exclude<SourceKind, "new">; hasLink: boolean; asked?: GoalKey | null; days?: number | null }, now: Date, opts: BoostOptions = {}): BoostPlan {
  const runDays = planDays(post.days);
  const allowed = boostableGoals(facts.offered, post.source, opts);
  const goal = smartGoal({ asked: post.asked ?? null, whatsappLinked: facts.whatsappLinked, hasForms: facts.hasForms, postHasLink: post.hasLink, allowed: allowed.length ? allowed : facts.offered });
  return { steps: flowSteps("boost", goal), goal, runDays, ...planDaily(facts, runDays, now) };
}

/** ₹300 a day or the most that fits (D8), the same rule as the server's defaultBudget. */
export function planDaily(facts: Pick<PlanFacts, "currency" | "tz" | "leftTodayMinor" | "leftMonthMinor" | "minDailyMinor" | "fromInr">, runDays: number, now: Date): { dailyMinor: bigint; stepMinor: bigint } {
  const stepMinor = budgetStep(facts.currency, facts.fromInr ?? null);
  let maxFitting: bigint | null = null;
  if (facts.leftTodayMinor !== null) {
    const dates = runDates({ runDays, startMode: "now", tz: facts.tz, now });
    maxFitting = maxFittingDaily({ startsAt: dates.startsAt, endsAt: dates.endsAt, tz: facts.tz, now, leftTodayMinor: facts.leftTodayMinor, leftMonthMinor: facts.leftMonthMinor, stepMinor, currency: facts.currency });
  }
  const d = defaultDailyMinor({ currency: facts.currency, fromInr: facts.fromInr ?? null, maxFittingMinor: maxFitting, minDailyMinor: facts.minDailyMinor });
  if (d === null) return { dailyMinor: majorUnit(facts.currency), stepMinor };
  let out = d >= stepMinor ? (d / stepMinor) * stepMinor : d;
  if (facts.minDailyMinor && out < facts.minDailyMinor) out = facts.minDailyMinor;
  return { dailyMinor: out, stepMinor };
}

// =====================================================================================================================
// What the server sends to the page (strings for money: JSON has no bigint)
// =====================================================================================================================

/** The flow's facts, resolved on the server (the page) and passed to the client. Money as decimal strings of minor units. */
export type FlowContext = {
  kind: FlowKind;
  lang: PromoteLang;
  canStart: boolean;
  canWrite: boolean;
  video: boolean;
  previews: "meta" | "local";
  experimental: boolean;
  offered: GoalKey[];
  currency: string;
  tz: string;
  /** The workspace's own zone, for the "Times are in …" note (D30). */
  workspaceTz: string;
  stepMinor: string;
  minDailyMinor: string | null;
  leftTodayMinor: string | null;
  leftMonthMinor: string | null;
  whatsappLinked: boolean;
  hasForms: boolean;
  country: string;
  isOwner: boolean;
  ownerName: string | null;
  hasInstagram: boolean;
  pageName: string | null;
  businessName: string | null;
  whatsappNumber: string | null;
  privacyUrl: string | null;
  /** The saved shop pin, for "People near my shop". */
  shop: ShopLocation | null;
  /** What stops a draft from being made (no spending ad account, no Page), from the 3.1 defaults. */
  chips: { key: string; text: string; href?: string }[];
  /** The Pages a new ad may run from, and the one the 3.1 defaults pick (null: the member chooses one). */
  pages: { assetId: string; name: string | null }[];
  pageAssetId: string | null;
  /** The Instagram account the defaults pick (null: none, or the member chooses). */
  igAssetId: string | null;
  /** Saved lead forms of the workspace's Pages, each with its Page, for "Use a saved form" (3.5 step 2; formsForPage). */
  forms: { id: string; name: string; pageAssetId: string | null }[];
  /** The name the preview shows: the Instagram username or the Page's name. */
  profileName: string | null;
  /** Today in the ad account's zone (YYYY-MM-DD), for a new form's default name. */
  today: string;
  /** The first message chat goals start with: the one saved in Promote settings, else "Hi! I saw your ad and want to know more". */
  welcomeMessage: string;
  query: FlowQuery;
};

/** What the page reads on the server for a flow, already looked up (the page does the reads; this maps them, D3, 3.1, 3.1a). */
export type FlowFacts = {
  facts: Pick<DefaultFacts, "role" | "ownerName" | "spendingAccount" | "pages" | "instagram" | "whatsappNumberId" | "hasForms" | "country" | "headroom" | "welcome">;
  defaults: Pick<SmartDefaults, "adAccount" | "page" | "instagram" | "budget" | "chips">;
  access: Pick<PromoteAccess, "canStart" | "canWrite" | "video" | "previews" | "experimental">;
  offered: readonly GoalKey[];
  phone: { displayPhone: string | null; verifiedName: string | null } | null;
  privacyUrl: string | null;
  shop: ShopLocation | null;
  forms: readonly { id: string; name: string | null; pageAssetId?: string | null }[];
  workspaceTz: string | null;
  now: Date;
};

const DEFAULT_TZ = "Asia/Kolkata";

/** The flow's context from what the page read (money as strings: JSON has no bigint). Pages render English (D23). */
export function flowContextOf(kind: FlowKind, f: FlowFacts, query: FlowQuery): FlowContext {
  const account = f.defaults.adAccount;
  const tz = account?.timezone ?? f.facts.spendingAccount?.timezone ?? DEFAULT_TZ;
  const page = f.defaults.page;
  const ig = f.defaults.instagram;
  const s = (v: bigint | null | undefined) => (typeof v === "bigint" ? v.toString() : null);
  return {
    kind,
    lang: "en",
    canStart: f.access.canStart,
    canWrite: f.access.canWrite,
    video: f.access.video !== "off",
    previews: f.access.previews,
    experimental: f.access.experimental,
    offered: [...f.offered],
    currency: account?.currency ?? f.facts.spendingAccount?.currency ?? "INR",
    tz,
    workspaceTz: f.workspaceTz ?? tz,
    stepMinor: f.defaults.budget.stepMinor.toString(),
    minDailyMinor: s(f.facts.spendingAccount?.minDailyMinor),
    leftTodayMinor: s(f.facts.headroom?.leftTodayMinor),
    leftMonthMinor: s(f.facts.headroom?.leftMonthMinor),
    whatsappLinked: !!page?.whatsappLinked && !!f.facts.whatsappNumberId,
    hasForms: f.facts.hasForms,
    country: f.facts.country,
    isOwner: f.facts.role === "owner",
    ownerName: f.facts.ownerName,
    hasInstagram: !!ig,
    pageName: page?.name ?? null,
    businessName: f.phone?.verifiedName?.trim() || page?.name || null,
    whatsappNumber: f.phone?.displayPhone ?? null,
    privacyUrl: f.privacyUrl,
    shop: f.shop,
    chips: f.defaults.chips.map((c) => ({ key: c.key, text: c.text, ...(c.href ? { href: c.href } : {}) })),
    pages: f.facts.pages.map((p) => ({ assetId: p.assetId, name: p.name })),
    pageAssetId: page?.assetId ?? null,
    igAssetId: ig?.assetId ?? null,
    forms: f.forms.map((x) => ({ id: x.id, name: x.name?.trim() || x.id, pageAssetId: x.pageAssetId ?? null })),
    profileName: ig?.name ?? page?.name ?? null,
    today: localInputValue(f.now, tz).slice(0, 10),
    welcomeMessage: f.facts.welcome.en?.trim() || promoteText("chat.first_message_default"),
    query,
  };
}

/** The context for a member who can only read (agents): nothing is looked up, and the shell says who can make ads. */
export function readOnlyContext(kind: FlowKind, query: FlowQuery, now: Date = new Date()): FlowContext {
  return flowContextOf(
    kind,
    {
      facts: { role: "agent", ownerName: null, spendingAccount: null, pages: [], instagram: [], whatsappNumberId: null, hasForms: false, country: "IN", headroom: null, welcome: {} },
      defaults: { adAccount: null, page: null, instagram: null, budget: { dailyMinor: 0n, stepMinor: 1_000n, known: false }, chips: [] },
      access: { canStart: false, canWrite: false, video: "off", previews: "local", experimental: false },
      offered: [],
      phone: null,
      privacyUrl: null,
      shop: null,
      forms: [],
      workspaceTz: null,
      now,
    },
    query,
  );
}

/** The chips that stop any draft from being made: no spending ad account, or no Page to run from (3.1). */
export const BLOCKING_CHIPS: ReadonlySet<string> = new Set(["choose_spending_account", "ask_owner_spending_account", "connect_page"]);
export const blockingChips = (chips: FlowContext["chips"]): FlowContext["chips"] => chips.filter((c) => BLOCKING_CHIPS.has(c.key));

export const minorOrNull = (v: string | null | undefined): bigint | null => (typeof v === "string" && /^\d{1,18}$/.test(v) ? BigInt(v) : null);
export const minorOf = (v: string | number | bigint | null | undefined, fallback = 0n): bigint =>
  typeof v === "bigint" ? v : typeof v === "number" && Number.isSafeInteger(v) ? BigInt(v) : (minorOrNull(typeof v === "string" ? v : null) ?? fallback);

/** The PlanFacts of a flow context (strings back to bigints). */
export function planFactsOf(ctx: FlowContext): PlanFacts {
  return {
    offered: ctx.offered,
    whatsappLinked: ctx.whatsappLinked,
    hasForms: ctx.hasForms,
    currency: ctx.currency,
    tz: ctx.tz,
    leftTodayMinor: minorOrNull(ctx.leftTodayMinor),
    leftMonthMinor: minorOrNull(ctx.leftMonthMinor),
    minDailyMinor: minorOrNull(ctx.minDailyMinor),
  };
}

/** The draft as GET and PATCH /api/promote/drafts/[id] answer it (service.getPromotionDraft, bigints as strings). */
export type DraftDto = {
  campaignId: string;
  updatedAt: string;
  status: string;
  surface: string;
  editable: boolean;
  discardedAt: string | null;
  currency: string;
  draft: Record<string, unknown>;
  caption: UntrustedText | null;
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** True for a body that looks like a DraftDto. */
export function isDraftDto(v: unknown): v is DraftDto {
  return isObj(v) && typeof v.campaignId === "string" && typeof v.updatedAt === "string" && isObj(v.draft) && isGoalKey(v.draft.goal);
}

/** The draft view from its JSON: bigints back, and every field the JSON left out at its default. */
export function parseDraft(json: Record<string, unknown>): PromotionDraft {
  const goal = isGoalKey(json.goal) ? json.goal : "engagement";
  const base = defaultDraft(goal);
  const out = { ...base, ...(json as Partial<PromotionDraft>) } as PromotionDraft;
  const budget = isObj(json.budget) ? json.budget : {};
  const bid = isObj(json.bid) ? json.bid : {};
  out.budget = { dailyMinor: minorOf(budget.dailyMinor as string, base.budget.dailyMinor), lifetimeMinor: minorOrNull(budget.lifetimeMinor as string | null) };
  out.bid = { strategy: (bid.strategy as PromotionDraft["bid"]["strategy"]) ?? base.bid.strategy, amountMinor: minorOrNull(bid.amountMinor as string | null) };
  for (const k of ["audience", "placements", "run", "compare", "versions", "welcome", "text", "media", "source"] as const) {
    (out as Record<string, unknown>)[k] = { ...(base[k] as object), ...(isObj(json[k]) ? (json[k] as object) : {}) };
  }
  return out;
}

/** A set's values as JSON (bigints as strings of digits, which the draft paths accept). */
export function toJsonSet(set: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const conv = (v: unknown): unknown => (typeof v === "bigint" ? v.toString() : Array.isArray(v) ? v.map(conv) : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, conv(x)])) : v);
  return Object.fromEntries(Object.entries(set).map(([k, v]) => [k, conv(v)]));
}

/** Only draft-paths keys go in a PATCH (the server refuses anything else). */
export const knownPaths = (set: Readonly<Record<string, unknown>>): Record<string, unknown> => Object.fromEntries(Object.entries(set).filter(([k]) => Object.prototype.hasOwnProperty.call(DRAFT_PATHS, k)));

// =====================================================================================================================
// Autosave (7.2): after every step and on blur, PATCH with expectedUpdatedAt
// =====================================================================================================================

export type SaveState = "saved" | "saving" | "unsaved" | "conflict" | "error";
export type SendResult = { status: number; body: unknown };
export type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

/** Waits before each automatic retry on a slow or failed network; then the footer's [Save now] retries. */
export const SAVE_RETRY_MS: readonly number[] = [1_000, 3_000, 10_000];

/** The PATCH body: the version the member saw, the changed paths, and any answer sent with them (categoryAnswer). */
export function patchBody(expectedUpdatedAt: string, set: Readonly<Record<string, unknown>>, lang: PromoteLang = "en", extra: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { expectedUpdatedAt, set: toJsonSet(set), lang, ...extra };
}

/** "Saved" or "Not saved yet" for the footer (7.2). Saving and errors read "Not saved yet" too: it is not saved yet. */
export function saveStateText(state: SaveState, lang: PromoteLang = "en"): string {
  return promoteText(state === "saved" ? "draft.saved" : "draft.not_saved", {}, lang);
}

/** The error sentence of a refused request, or the copy for a key. */
export function errorText(body: unknown, fallback: PromoteCopyKey, lang: PromoteLang = "en"): string {
  return isObj(body) && typeof body.error === "string" && body.error.trim() ? body.error.trim() : promoteText(fallback, {}, lang);
}

export type AutosaveOptions = {
  updatedAt: string;
  send: (body: Record<string, unknown>) => Promise<SendResult>;
  onSaved?: (dto: DraftDto) => void;
  /** A 409: someone else changed the draft. The latest draft and "Someone else changed this draft. Showing the latest." */
  onConflict?: (latest: DraftDto | null, message: string) => void;
  /** Refused for another reason (a value the server won't take, a question to answer): the message and the body. */
  onError?: (message: string, body: unknown) => void;
  onState?: (state: SaveState) => void;
  timers?: Timers;
  retryMs?: readonly number[];
  lang?: PromoteLang;
};

export type Autosaver = {
  /** Adds changes to the next save (later values of a path win). */
  stage: (set: Readonly<Record<string, unknown>>) => void;
  /** Sends what is staged now; resolves when the draft is saved, refused or left for a retry. */
  flush: () => Promise<SaveState>;
  state: () => SaveState;
  pending: () => Record<string, unknown>;
  /** The changes the server refused last (a question to answer, a value it won't take); not sent again by themselves. */
  refused: () => Record<string, unknown>;
  /** Sends the refused changes again with an answer ({categoryAnswer: "none"}), plus anything staged since. */
  resend: (extra: Readonly<Record<string, unknown>>) => Promise<SaveState>;
  version: () => string;
  setVersion: (updatedAt: string) => void;
  dispose: () => void;
};

/**
 * The autosave protocol, without React. One PATCH at a time; changes staged meanwhile go in the next one. 200: the new version.
 * 409 stale: the latest draft is shown with the conflict sentence and the staged changes are dropped (they were made on an
 * older version). That save answers "conflict" (so Continue stays and the member sees the latest), and the saver is then
 * "saved" on the latest version: the next Continue moves on and [Save now] isn't needed. A 409 without the latest draft stays
 * "conflict" until the caller loads the draft again (a new saver). Any other 4xx: refused with its sentence, and kept aside so
 * an answer can send them again (resend). A network failure or a 5xx keeps the changes and tries again.
 */
export function createAutosaver(o: AutosaveOptions): Autosaver {
  const timers = o.timers ?? realTimers;
  const retryMs = o.retryMs ?? SAVE_RETRY_MS;
  const lang = o.lang ?? "en";
  let version = o.updatedAt;
  let staged: Record<string, unknown> = {};
  let refused: Record<string, unknown> = {};
  let extra: Record<string, unknown> = {};
  let state: SaveState = "saved";
  let inflight: Promise<SaveState> | null = null;
  let retryTimer: unknown = null;
  let attempt = 0;
  let disposed = false;
  const empty = (o: Record<string, unknown>) => Object.keys(o).length === 0;

  const setState = (s: SaveState) => {
    state = s;
    o.onState?.(s);
  };
  const clearRetry = () => {
    if (retryTimer !== null) timers.clear(retryTimer);
    retryTimer = null;
  };

  const sendOnce = async (): Promise<SaveState> => {
    const set = staged;
    const answer = extra;
    staged = {};
    extra = {};
    if (empty(set) && empty(answer)) return state === "saving" ? "saved" : state;
    clearRetry();
    setState("saving");
    let res: SendResult;
    try {
      res = await o.send(patchBody(version, set, lang, answer));
    } catch {
      res = { status: 0, body: null };
    }
    if (disposed) return state;
    if (res.status >= 200 && res.status < 300 && isDraftDto(res.body)) {
      attempt = 0;
      refused = {};
      version = res.body.updatedAt;
      o.onSaved?.(res.body);
      setState(empty(staged) ? "saved" : "unsaved");
      return state;
    }
    const body = isObj(res.body) ? res.body : {};
    if (res.status === 409 && body.code === "stale") {
      attempt = 0;
      const latest = isDraftDto(body.latest) ? body.latest : null;
      if (latest) version = latest.updatedAt;
      staged = {};
      refused = {};
      setState("conflict");
      o.onConflict?.(latest, errorText(body, "draft.conflict", lang));
      // The screen now shows the latest saved version: nothing is left to save. Changes staged during onConflict stay unsaved.
      if (latest && state === "conflict") setState(empty(staged) ? "saved" : "unsaved");
      return "conflict";
    }
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
      attempt = 0;
      refused = { ...refused, ...set };
      setState("error");
      o.onError?.(errorText(body, "draft.bad_value", lang), res.body);
      return state;
    }
    // Slow or failed network, or the server had a problem: keep the changes (newer stages win) and try again.
    staged = { ...set, ...staged };
    extra = { ...answer, ...extra };
    setState("unsaved");
    const wait = retryMs[attempt];
    attempt++;
    if (wait !== undefined && !disposed) {
      retryTimer = timers.set(() => {
        retryTimer = null;
        void flush();
      }, wait);
    }
    return state;
  };

  const flush = async (): Promise<SaveState> => {
    if (inflight) await inflight;
    if (empty(staged) && empty(extra)) return state;
    inflight = sendOnce().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  return {
    stage: (set) => {
      if (!Object.keys(set).length) return;
      staged = { ...staged, ...set };
      if (state === "saved" || state === "conflict" || state === "error") setState("unsaved");
    },
    flush,
    state: () => state,
    pending: () => ({ ...staged }),
    refused: () => ({ ...refused }),
    resend: (more) => {
      staged = { ...refused, ...staged };
      refused = {};
      extra = { ...more };
      return flush();
    },
    version: () => version,
    setVersion: (v) => {
      version = v;
    },
    dispose: () => {
      disposed = true;
      clearRetry();
    },
  };
}

// =====================================================================================================================
// Post picker (3.3 step 1, 7.3)
// =====================================================================================================================

export const PICKER_PAGE_SIZE = 25;
/** 3 columns on phones, 5 on desktop (7.3). */
export const PICKER_COLUMNS = { phone: 3, desktop: 5 } as const;

export const TAB_KEYS: Readonly<Record<SourceTab, PromoteCopyKey>> = {
  reels: "picker.tab.reels",
  posts: "picker.tab.posts",
  stories: "picker.tab.stories",
  facebook: "picker.tab.facebook",
};

const INSTAGRAM_TABS: ReadonlySet<SourceTab> = new Set<SourceTab>(["reels", "posts", "stories"]);

/** The tabs to show: Instagram's only with a real Instagram account (a Page-backed identity can't boost posts, 8.3a). */
export function visibleTabs(result: Pick<SourcesResult, "tabs" | "identity">): SourceTab[] {
  const ig = result.identity.instagram;
  const igUsable = !!ig && !ig.pageBacked;
  return result.tabs.filter((t) => igUsable || !INSTAGRAM_TABS.has(t));
}

/** A tab as the sources route's filter. */
export function tabQuery(tab: SourceTab): { source: "instagram" | "facebook"; kind: "reel" | "post" | "story" | null } {
  if (tab === "facebook") return { source: "facebook", kind: null };
  return { source: "instagram", kind: tab === "reels" ? "reel" : tab === "stories" ? "story" : "post" };
}

/** GET /api/promote/sources for a tab, the next page and the chosen Page. */
export function sourcesHref(tab: SourceTab | null, opts: { cursor?: string | null; pageAssetId?: string | null; igAssetId?: string | null } = {}): string {
  const p = new URLSearchParams();
  if (tab) {
    const q = tabQuery(tab);
    p.set("source", q.source);
    if (q.kind) p.set("kind", q.kind);
  }
  if (opts.cursor) p.set("cursor", opts.cursor);
  if (opts.pageAssetId) p.set("pageAssetId", opts.pageAssetId);
  if (opts.igAssetId) p.set("igAssetId", opts.igAssetId);
  p.set("limit", String(PICKER_PAGE_SIZE));
  p.set("lang", "en");
  return `/api/promote/sources?${p.toString()}`;
}

/** The next page appended, without repeating a post already shown. */
export function mergeItems(prev: readonly BoostableItem[], next: readonly BoostableItem[]): BoostableItem[] {
  const seen = new Set(prev.map((i) => `${i.app}:${i.id}`));
  return [...prev, ...next.filter((i) => !seen.has(`${i.app}:${i.id}`))];
}

/** The caption's first line, clipped at a word near 20 characters with "…". */
export function captionSnippet(caption: string | null | undefined, max = 20): string {
  const line = (caption ?? "").split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? "";
  const chars = Array.from(line);
  if (chars.length <= max) return line;
  const head = chars.slice(0, max).join("");
  if (/\s/.test(chars[max] ?? "")) return `${head.trimEnd()}…`;
  const space = head.lastIndexOf(" ");
  return `${(space > max / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

const KIND_KEYS: Readonly<Record<BoostableItem["kind"], PromoteCopyKey>> = { reel: "picker.kind.reel", post: "picker.kind.post", story: "picker.kind.story" };

/** Whether Meta will boost it, in words: "can be boosted", "can't be boosted: it uses licensed music", or Meta decides later. */
export function tileState(item: Pick<BoostableItem, "eligibility" | "reasons">, lang: PromoteLang = "en"): { tone: "ok" | "no" | "unknown"; text: string; reason: string | null } {
  if (item.eligibility === "ok") return { tone: "ok", text: promoteText("boost.can_boost", {}, lang), reason: null };
  if (item.eligibility === "no") {
    const reason = item.reasons[0]?.text ?? promoteText("boost.reason.not_eligible", {}, lang);
    return { tone: "no", text: promoteText("picker.cant_boost", { reason }, lang), reason };
  }
  return { tone: "unknown", text: promoteText("picker.meta_decides", {}, lang), reason: null };
}

/** The tile's accessible name (7.3): "Reel from 21 Oct: 'Diwali offer…', can be boosted". */
export function tileName(item: Pick<BoostableItem, "kind" | "createdAt" | "caption" | "eligibility" | "reasons">, tz: string, lang: PromoteLang = "en"): string {
  const kind = promoteText(KIND_KEYS[item.kind], {}, lang);
  const at = item.createdAt ? new Date(item.createdAt) : null;
  const what = at && !Number.isNaN(at.getTime()) ? promoteText("picker.from_date", { kind, date: formatDay(at, tz, lang) }, lang) : kind;
  const snippet = captionSnippet(item.caption?.text);
  const state = tileState(item, lang).text;
  return snippet ? promoteText("picker.tile", { what, caption: snippet, state }, lang) : promoteText("picker.tile_plain", { what, state }, lang);
}

/** Roving tabindex over the grid: arrows move by one or a row, Home and End to the ends. Null for any other key. */
export function gridMove(index: number, key: string, count: number, columns: number): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  const at = Math.min(Math.max(0, index), last);
  switch (key) {
    case "ArrowRight":
      return Math.min(at + 1, last);
    case "ArrowLeft":
      return Math.max(at - 1, 0);
    case "ArrowDown":
      return at + columns <= last ? at + columns : at;
    case "ArrowUp":
      return at - columns >= 0 ? at - columns : at;
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}

/** What the draft is made from for a post: Meta's id the boost uses (a Facebook post's promotable id when there is one). */
export function postSourceOf(item: BoostableItem): { kind: Exclude<SourceKind, "new">; ref: string; postKind: BoostableItem["kind"]; caption: string | null; hasLink: boolean } {
  const caption = item.caption?.text ?? null;
  return {
    kind: item.app === "instagram" ? "ig_media" : "fb_post",
    ref: item.app === "facebook" ? (item.promotableId ?? item.id) : item.id,
    postKind: item.kind,
    caption,
    hasLink: /https?:\/\/\S/i.test(caption ?? ""),
  };
}

/** POST /api/promote/drafts for a boost: the post, the plan's goal and days, the Page and Instagram account it is from. */
export function boostCreateBody(item: BoostableItem, plan: Pick<BoostPlan, "goal" | "runDays">, identity: SourcesResult["identity"] | null, alsoOtherApp: boolean): Record<string, unknown> {
  const src = postSourceOf(item);
  return {
    goal: plan.goal,
    days: plan.runDays,
    source: { kind: src.kind, ref: src.ref, caption: src.caption, postKind: src.postKind, hasLink: src.hasLink },
    pageAssetId: identity?.page?.assetId ?? null,
    igAssetId: identity?.instagram && !identity.instagram.pageBacked ? identity.instagram.assetId : null,
    set: { alsoOtherApp },
    lang: "en",
  };
}

/** Paths that belong to the goal (its button, chat, form, link and the places it can use): left behind when the goal changes. */
const GOAL_PATHS: ReadonlySet<string> = new Set([
  "goal",
  "ctaType",
  "leadFormId",
  "formType",
  "welcome.message",
  "welcome.iceBreakers",
  "text.link",
  "urlTags",
  "optimizationGoal",
  "destinations",
]);
/** Paths the post sets itself (the server names the draft and sets its format from the post), never carried to another post. */
const POST_PATHS: ReadonlySet<string> = new Set(["name", "format", "alsoOtherApp"]);

/**
 * POST /api/promote/drafts when the member picks a different post for a boost draft (3.3 step 1): everything else stays the
 * same. The goal stays when the new post can take it (boostableGoals); otherwise the 3.1 goal for this post is chosen and the
 * old goal's settings (its button, chat, form, link) are left behind. The places stay only for the same goal on the same app
 * (an Instagram-only place can't run a Facebook post).
 */
export function boostSwitchBody(
  item: BoostableItem,
  draft: PromotionDraft,
  identity: SourcesResult["identity"] | null,
  alsoOtherApp: boolean,
  facts: PlanFacts,
  now: Date,
  opts: BoostOptions = {},
): Record<string, unknown> {
  const src = postSourceOf(item);
  const keep = boostableGoals(facts.offered, src.kind, opts).includes(draft.goal);
  const sameApp = draft.source.kind === src.kind;
  const runDays = draft.run.runDays;
  const goal = keep ? draft.goal : boostPlan(facts, { source: src.kind, hasLink: src.hasLink, days: runDays }, now, opts).goal;
  const carried = Object.fromEntries(
    Object.entries(draftSetOf(draft)).filter(([p]) => !POST_PATHS.has(p) && (keep || !GOAL_PATHS.has(p)) && ((keep && sameApp) || !p.startsWith("placements."))),
  );
  const body = boostCreateBody(item, { goal, runDays }, identity, alsoOtherApp);
  return { ...body, set: toJsonSet({ ...carried, goal, alsoOtherApp }) };
}

/** "Also show on Facebook" (or Instagram) is offered unless Meta said it can't run there; it starts on when it can (3.3). */
export const alsoShowDefault = (item: Pick<BoostableItem, "alsoShowOn">): boolean => item.alsoShowOn.eligible !== false;

// =====================================================================================================================
// Goals (3.3 step 2, 3.4 step 1, D15)
// =====================================================================================================================

export type GoalCard = { key: GoalKey; tier: "simple" | "more"; title: string; outcome: string; note: string | null };

/** The goal cards by tier: the simple tiles, then More goals. All-settings goals stay in the old wizard (PRM-18). */
export function goalCards(offered: readonly GoalKey[], lang: PromoteLang = "en"): { simple: GoalCard[]; more: GoalCard[] } {
  const cards = GOALS.filter((g) => offered.includes(g.key) && g.tier !== "all").map(
    (g): GoalCard => ({
      key: g.key,
      tier: g.tier === "simple" ? "simple" : "more",
      title: promoteText(g.copy.title, {}, lang),
      outcome: promoteText(g.copy.outcome, {}, lang),
      note: goalNote(g.key, lang),
    }),
  );
  return { simple: cards.filter((c) => c.tier === "simple"), more: cards.filter((c) => c.tier === "more") };
}

/** D15 and 3.4: where replies happen for Instagram DMs and Messenger, and the pixel a sales goal needs. */
export function goalNote(goal: GoalKey, lang: PromoteLang = "en"): string | null {
  const note = goalRow(goal).copy.note;
  if (note) return promoteText(note, {}, lang);
  if (goal === "website_sales") return promoteText("goal.sales.needs_pixel", {}, lang);
  return null;
}

/** The boost goal chips of 3.3, in order. */
export const BOOST_GOAL_ORDER: readonly GoalKey[] = ["whatsapp_chats", "profile_visits", "website_visits", "instagram_dms", "engagement"];

export type BoostGoalChip = { key: GoalKey; label: string; usable: boolean; edge: EdgeNote | null };

/**
 * The goal chips for a boosted post: the 3.3 goals this member is offered and the post's app can take. A goal whose button
 * Meta doesn't allow on a post yet (V-P3) stays as a chip, with "Make a new ad for this goal instead" (goalEdge).
 */
export function boostGoalChips(offered: readonly GoalKey[], source: Exclude<SourceKind, "new">, lang: PromoteLang = "en", opts: BoostOptions = {}): BoostGoalChip[] {
  const usable = new Set(boostableGoals(offered, source, opts));
  return BOOST_GOAL_ORDER.filter((g) => offered.includes(g) && goalRow(g).sources.includes(source)).map((g) => ({
    key: g,
    label: promoteText(goalRow(g).copy.chip, {}, lang),
    usable: usable.has(g),
    edge: usable.has(g) ? null : goalEdge(g, lang),
  }));
}

/** The goal needs the member's link (its button opens a website). */
export const needsLink = (goal: GoalKey): boolean => CTA_BY_GOAL[goal].valueFrom === "link" && CTA_BY_GOAL[goal].types.length > 0;
/** The goal has a first message and quick questions (chat goals, 3.6). */
export const needsWelcome = (goal: GoalKey): boolean => CTA_BY_GOAL[goal].welcomeMessage;

/** What is wrong with a link the member typed, or null. Https only, with a real host name. */
export function linkProblem(value: string | null | undefined, lang: PromoteLang = "en"): string | null {
  const v = (value ?? "").trim();
  if (!v) return promoteText("carousel.link_https", {}, lang);
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" || u.username || u.password || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(u.hostname)) return promoteText("carousel.link_https", {}, lang);
  } catch {
    return promoteText("carousel.link_https", {}, lang);
  }
  return null;
}

// =====================================================================================================================
// Edge cases (3.3)
// =====================================================================================================================

export type EdgeNote = {
  code: "cant_boost" | "no_whatsapp_button" | "limits_busy" | "meta_limit_close" | "zone";
  text: string;
  extra: string | null;
  action: { label: string; href: string } | null;
};

/** The review card's warnings that are 3.3 edge cases: Meta's own limit is close, and times are in the ad account's zone. */
export const EDGE_WARNINGS: Readonly<Record<string, EdgeNote["code"]>> = { meta_limit_close: "meta_limit_close", time_zone: "zone" };

/**
 * "Make a new ad instead": a new ad for the same goal. The post's photo or video isn't carried over (the copy says to add it
 * there); copying a post's media into the new ad (?fromPost=, spec 3.3) needs AdStep's media import first.
 */
export const makeNewAdHref = (goal: GoalKey | null, days?: number | null): string => flowHref("create", { goal: goal ?? undefined, source: "new", days: days ?? undefined });

/** A post Meta won't boost: its reason, and the way out (3.3). Licensed music adds that Meta may still refuse it. */
export function postEdge(item: Pick<BoostableItem, "eligibility" | "reasons">, goal: GoalKey | null, lang: PromoteLang = "en"): EdgeNote | null {
  if (item.eligibility !== "no") return null;
  const reason = item.reasons[0]?.text ?? promoteText("boost.reason.not_eligible", {}, lang);
  const music = item.reasons.some((r) => r.code === "licensed_music");
  return {
    code: "cant_boost",
    text: promoteText("ig.state.cant_boost", { reason }, lang),
    extra: music ? promoteText("boost.music_may_refuse", {}, lang) : null,
    action: { label: promoteText("boost.make_new", {}, lang), href: makeNewAdHref(goal) },
  };
}

/** A goal whose button Meta doesn't allow on this kind of post yet (V-P3): a new ad for this goal instead. */
export function goalEdge(goal: GoalKey, lang: PromoteLang = "en"): EdgeNote {
  return {
    code: "no_whatsapp_button",
    text: goal === "whatsapp_chats" ? promoteText("boost.no_whatsapp_button", {}, lang) : promoteText("flow.no_button", { goal: promoteText(goalRow(goal).copy.chip, {}, lang) }, lang),
    extra: null,
    action: { label: promoteText("fix.make_new_ad", {}, lang), href: makeNewAdHref(goal) },
  };
}

// =====================================================================================================================
// Welcome message and quick questions (3.6)
// =====================================================================================================================

export const QUICK_QUESTIONS_MAX = 3;
export const QUICK_QUESTION_TITLE_MAX = 80;
export const QUICK_QUESTION_REPLY_MAX = 300;
export const WELCOME_MESSAGE_MAX = 1_000;

export type WelcomeValue = { message: string; iceBreakers: IceBreaker[] };

/** The preset questions as chips: "Price?", "Do you deliver to my area?", "Timings?". */
export function quickQuestionPresets(lang: PromoteLang = "en"): string[] {
  return (["chat.qq.price", "chat.qq.delivery", "chat.qq.timings"] as const).map((k) => promoteText(k, {}, lang));
}

/** Adds a quick question (at most 3), with the default reply; unchanged at the limit or for a question already there. */
export function addQuickQuestion(list: readonly IceBreaker[], title: string, lang: PromoteLang = "en"): IceBreaker[] {
  const t = title.trim();
  if (list.length >= QUICK_QUESTIONS_MAX || list.some((q) => q.title.trim().toLowerCase() === t.toLowerCase())) return [...list];
  return [...list, { title: t.slice(0, QUICK_QUESTION_TITLE_MAX), response: promoteText("welcome.reply_default", {}, lang) }];
}

export type WelcomeProblems = { message: string | null; questions: { title: string | null; response: string | null }[]; ok: boolean };

/** What stops the welcome from saving: an empty or long first message, a long question, a question without a reply. */
export function welcomeProblems(w: WelcomeValue, lang: PromoteLang = "en"): WelcomeProblems {
  const message = !w.message.trim() ? promoteText("welcome.need_message", {}, lang) : w.message.length > WELCOME_MESSAGE_MAX ? promoteText("welcome.too_long_message", {}, lang) : null;
  const questions = w.iceBreakers.map((q) => ({
    title: !q.title.trim() ? promoteText("welcome.need_question", {}, lang) : q.title.length > QUICK_QUESTION_TITLE_MAX ? promoteText("welcome.too_long_question", {}, lang) : null,
    response: !q.response.trim() ? promoteText("welcome.need_reply", {}, lang) : q.response.length > QUICK_QUESTION_REPLY_MAX ? promoteText("welcome.too_long_reply", {}, lang) : null,
  }));
  const ok = !message && questions.every((q) => !q.title && !q.response) && w.iceBreakers.length <= QUICK_QUESTIONS_MAX;
  return { message, questions, ok };
}

// =====================================================================================================================
// Who and how much (3.7)
// =====================================================================================================================

export const RADIUS_KM = { min: 1, max: 50 } as const;
export const AGE = { min: 18, max: 65 } as const;
export const PINCODE = /^[1-9]\d{5}$/;

export const clampRadius = (km: number): number => (Number.isFinite(km) ? Math.min(RADIUS_KM.max, Math.max(RADIUS_KM.min, Math.round(km))) : 5);

/** The pin from the browser's location: the shop, 5 km around it until the member moves the slider. */
export function placeFromPosition(lat: number, lng: number, label: string, radiusKm = 5): ShopLocation | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5, radiusKm: clampRadius(radiusKm), label: label.slice(0, 120) };
}

/**
 * A searched place as the pin, when the answer carries its map position; null when it can't be pinned. Meta's place search
 * (A7, promote/meta Place) answers keys and names only, never a map position, so today a searched place can't be pinned:
 * PlacePicker says so and points to the shop location or another audience. Targeting a PIN code or city by its Meta key
 * needs "audience.nearShop" (and the server's targeting) to hold that key.
 */
export function placeFromSearch(place: { name: string; region?: string | null; lat?: unknown; lng?: unknown; latitude?: unknown; longitude?: unknown }, radiusKm = 5): ShopLocation | null {
  const lat = typeof place.lat === "number" ? place.lat : typeof place.latitude === "number" ? place.latitude : NaN;
  const lng = typeof place.lng === "number" ? place.lng : typeof place.longitude === "number" ? place.longitude : NaN;
  const label = [place.name, place.region].filter(Boolean).join(", ");
  return placeFromPosition(lat, lng, label, radiusKm);
}

/** The targeting the size route reads (ads/targeting parseTargeting), from the draft's audience. */
export function sizeTargeting(d: Pick<PromotionDraft, "audience">): Record<string, unknown> {
  const a = d.audience;
  const near = a.mode === "near_shop" ? a.nearShop : null;
  const chooses = a.mode === "i_choose";
  return {
    geo: { countries: near ? [] : a.countries, cities: [], ...(near ? { customLocations: [{ lat: near.lat, lng: near.lng, radiusKm: near.radiusKm, label: near.label }] } : {}) },
    ageMin: a.ageMin,
    ageMax: a.ageMax ?? AGE.max,
    genders: chooses ? a.genders : [],
    interests: chooses ? a.interests : [],
    placements: [],
    lookalikeAudienceIds: [],
    customAudienceIds: chooses ? a.customAudienceIds : [],
    excludedAudienceIds: chooses ? a.excludedAudienceIds : [],
    advantageAudience: a.mode === "meta_finds",
  };
}

/** The draft change for an audience card. */
export function audienceModeSet(mode: PromotionDraft["audience"]["mode"], shop: ShopLocation | null): Record<string, unknown> {
  if (mode === "near_shop" && shop) return { "audience.mode": mode, "audience.nearShop": shop };
  return { "audience.mode": mode };
}

// =====================================================================================================================
// Placements and More options (3.4 step 3, 3.12, 7.5)
// =====================================================================================================================

export type PositionGroup = { platform: MetaPlatform; label: string; positions: { key: PlacementKey; label: string }[] };

const PLATFORM_KEYS: Readonly<Record<MetaPlatform, PromoteCopyKey>> = {
  instagram: "results.platform.instagram",
  facebook: "results.platform.facebook",
  messenger: "results.platform.messenger",
  threads: "results.platform.threads",
  whatsapp: "results.platform.whatsapp",
  audience_network: "results.platform.audience_network",
};

/**
 * The [Change] list (3.4, 3.12): only the positions this goal and format can use, up to More options, for rows this member
 * may see (D22). Invalid positions are hidden, not disabled (7.5). Grouped by app.
 */
export function morePositions(goal: GoalKey, format: AdFormat, ctx: { hasInstagramIdentity: boolean; formType?: FormType; experimental: boolean; mediaKind?: "image" | "video" }, lang: PromoteLang = "en"): PositionGroup[] {
  const keys = availablePlacements(goal, format, { hasInstagramIdentity: ctx.hasInstagramIdentity, formType: ctx.formType, mediaKind: ctx.mediaKind, tier: "more", sandboxAccount: ctx.experimental, experimental: ctx.experimental });
  const groups: PositionGroup[] = [];
  for (const key of keys) {
    const row = placementRow(key);
    let g = groups.find((x) => x.platform === row.platform);
    if (!g) {
      g = { platform: row.platform, label: promoteText(PLATFORM_KEYS[row.platform], {}, lang), positions: [] };
      groups.push(g);
    }
    g.positions.push({ key, label: promoteText(row.nameKey, {}, lang) });
  }
  return groups;
}

/** Ticks or unticks a position; no position left means Automatic. */
export function togglePosition(current: readonly PlacementKey[], key: PlacementKey, on: boolean): { "placements.mode": PlacementMode; "placements.positions": PlacementKey[] } {
  const next = on ? [...new Set([...current, key])] : current.filter((k) => k !== key);
  return { "placements.mode": next.length ? "custom" : "auto", "placements.positions": next };
}

/** "Where it shows: Automatic (recommended)", "Instagram only", "Facebook only" or "3 places you chose". */
export function placementSummary(mode: PlacementMode, positions: readonly PlacementKey[], lang: PromoteLang = "en"): string {
  if (mode === "instagram") return promoteText("placement.instagram_only", {}, lang);
  if (mode === "facebook") return promoteText("placement.facebook_only", {}, lang);
  if (mode === "custom" && positions.length) return promoteText("card.where.custom", { count: String(positions.length) }, lang);
  return promoteText("placement.auto", {}, lang);
}

/** The draft's defaults for the hidden chip: the 3.1 defaults with the workspace's country. */
export const flowDefaults = (goal: GoalKey, country: string): PromotionDraft => defaultDraft(goal, { country });

/** What the More options of "Who and how much" holds (3.12): the start, a run over 30 days, URL parameters, enhancements, compare. */
export const AUDIENCE_MORE_PATHS: readonly string[] = ["run.startMode", "run.startsAt", "run.runDays", "urlTags", "enhancementsOptIn", "compare.mode", "compare.variable", "audience.countries"];
/** What "People I choose" holds: hidden while another audience card is picked (age still applies to every card). */
export const AUDIENCE_CHOOSE_PATHS: readonly string[] = [
  "audience.ageMin",
  "audience.ageMax",
  "audience.genders",
  "audience.interests",
  "audience.savedAudienceId",
  "audience.customAudienceIds",
  "audience.excludedAudienceIds",
];

/**
 * The paths the "Who and how much" step hides right now: its More options while closed, and "People I choose" while another card
 * is picked. Values other steps show (quick questions, versions, the button) are theirs and never counted here.
 */
export function audienceHiddenScope(draft: Pick<PromotionDraft, "audience">, moreOpen: boolean): string[] {
  return [...(moreOpen ? [] : AUDIENCE_MORE_PATHS), ...(draft.audience.mode === "i_choose" ? [] : AUDIENCE_CHOOSE_PATHS)];
}

const inScope = (scope: readonly string[] | undefined) => (h: { path: string }) => !scope || scope.includes(h.path);

/**
 * The chip for values a closed More options hides (3.12): "2 extra settings changed · Reset"; null when none. With a scope, only
 * those paths count (the step's own hidden settings, audienceHiddenScope); the tier is what is open (simple while closed).
 */
export function hiddenChip(draft: PromotionDraft, tier: Tier, defaults: PromotionDraft, lang: PromoteLang = "en", scope?: readonly string[]): { count: number; text: string; label: string; paths: string[] } | null {
  const hidden = hiddenNonDefaults(draft, tier, defaults).filter(inScope(scope));
  if (!hidden.length) return null;
  const count = String(hidden.length);
  return { count: hidden.length, text: promoteText("chips.hidden_changed", { count }, lang), label: promoteText("chips.hidden_count", { count }, lang), paths: hidden.map((h) => h.path) };
}

/** The PATCH that puts every hidden non-default value back (the chip's [Reset]), within the scope when one is given. */
export function resetHiddenSet(draft: PromotionDraft, tier: Tier, defaults: PromotionDraft, scope?: readonly string[]): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const { path } of hiddenNonDefaults(draft, tier, defaults).filter(inScope(scope))) set[path] = path.startsWith("versions.") ? null : readPath(defaults, path);
  return set;
}

export const COMPARE_MODES: readonly CompareMode[] = ["fair_split", "meta_picks"];

/** A start date and time typed in the ad account's zone (D30), as the instant to save; null when it can't be read. */
export function startFromLocal(value: string, tz: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  try {
    return localTimeToInstant(m[1], Number(m[2]), Number(m[3]), tz);
  } catch {
    return null;
  }
}

/** The local "YYYY-MM-DDTHH:MM" of an instant in the account zone (a datetime-local input's value). */
export function localInputValue(at: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** The latest start the More options date picker allows (14 days ahead). */
export const latestStart = (now: Date): Date => new Date(now.getTime() + MAX_START_AHEAD_DAYS * 86_400_000);

// =====================================================================================================================
// Readiness (3.2)
// =====================================================================================================================

export type ReadinessRowDto = Pick<PrereqRow, "check" | "status" | "label" | "detail" | "warningOnly" | "blocks"> & { fix: PrereqFix; more: PrereqFix[] };

export const READINESS_STATUS_KEYS: Readonly<Record<PrereqRow["status"], PromoteCopyKey>> = {
  ok: "readiness.status.ok",
  missing: "readiness.status.missing",
  unknown: "readiness.status.unknown",
};

/** What a fix button does on the page. */
export type FixRun =
  | { kind: "opens_meta"; href: string | null; screen: MetaScreenKey }
  | { kind: "reconnect" }
  | { kind: "link"; href: string }
  | { kind: "refresh" }
  | { kind: "facebook_only" }
  | { kind: "create_identity" }
  | { kind: "create_pixel" }
  | { kind: "note"; text: string };

/** The in-app actions a readiness fix runs (3.2): the page does each without leaving Edwyz where Meta allows it. */
export function readinessRun(fix: PrereqFix): FixRun {
  switch (fix.kind) {
    case "opens_meta":
      return { kind: "opens_meta", href: fix.href, screen: fix.key };
    case "reconnect":
      return { kind: "reconnect" };
    case "settings":
      return { kind: "link", href: fix.href };
    case "ask_owner":
      return { kind: "note", text: fix.label };
    case "in_app":
      switch (fix.key) {
        case "facebook_only":
          return { kind: "facebook_only" };
        case "recheck_leadgen_terms":
          return { kind: "refresh" };
        case "create_instagram_identity":
          return { kind: "create_identity" };
        // POST /api/promote/pixel makes the pixel, or reuses the one the account has, and answers its install code.
        case "create_pixel":
        case "pixel_install_code":
          return { kind: "create_pixel" };
        case "choose_instagram":
        case "use_page":
          return { kind: "link", href: CONNECTIONS_PATH };
        // The privacy link is asked on the form step, the shop on "People near my shop": both are on these screens.
        default:
          return { kind: "note", text: fix.label };
      }
  }
}

/** The rows to show: what needs a fix first, then warnings, then what is ready. */
export function orderedRows<T extends Pick<PrereqRow, "status" | "blocks" | "warningOnly">>(rows: readonly T[]): T[] {
  const rank = (r: T) => (r.blocks ? 0 : r.status !== "ok" ? 1 : 2);
  return [...rows].sort((a, b) => rank(a) - rank(b));
}

// =====================================================================================================================
// The review card (6.5, 7.3, D4, D5)
// =====================================================================================================================

export type CardStateDto = "ready" | "running" | "blocked" | "doesnt_fit" | "spend_frozen" | "spend_not_set_up" | "awaiting_approval" | "demo" | "start_closed" | "not_connected";

export type FixDto = { kind: string; label: string; toMinor?: string; days?: number; at?: string };
export type CostDto = {
  currency: string;
  aboutTotalMinor: string;
  atMostMinor: string;
  byMonth: { month: string; minor: string }[];
  worstMonthMinor: string;
  todayMinor: string;
  leftTodayMinor: string | null;
  leftMonthMinor: string | null;
  fits: boolean;
  crossesMonth: boolean;
  typedConfirmRequired: boolean;
  lines: { about: string; atMost: string; byMonth: string; left: string | null; monthCross: string | null; setAside: string | null };
  worstThisMonth: string;
};
export type CardTextDto = { version: string; primary: string; primaryShort: string; clipped: boolean; headline: string; description: string; link: string | null; linkDomain: string | null; button: string | null };

/** review_promotion as the route answers it (service.ReviewCard through jsonSafe). */
export type ReviewCardDto = {
  campaignId: string;
  updatedAt: string;
  status: string;
  state: CardStateDto;
  canStart: boolean;
  title: string;
  primary: string;
  secondary: string;
  facts: { key: string; label: string; value: string; caption?: UntrustedText | null }[];
  text: { versions: CardTextDto[]; firstMessage: string | null; quickQuestions: { title: string; response: string }[]; caption: UntrustedText | null };
  warnings: { code: string; text: string }[];
  cost: CostDto | null;
  fixes: FixDto[];
  readiness: { ready: boolean; rows: ReadinessRowDto[] } | null;
  issues: string[];
  previews: { draftId: string; placements: PlacementKey[]; kind: "meta" | "local" };
  typedConfirmRequired: boolean;
  dailyTotalMinor: string;
  worstCaseMinor: string;
  materialHash: string;
  stateText: string | null;
};

/** start_promotion and save_promotion_paused as the routes answer them (service.StartOutcome through jsonSafe). */
export type StartOutcomeDto =
  | { state: "started"; campaignId: string; message: string; note?: string; formCreated: boolean }
  | { state: "saved"; campaignId: string; message: string; formCreated: boolean }
  | { state: "changed"; message: string; changed: string[]; card: ReviewCardDto }
  | { state: "typed_confirm"; message: string; card: ReviewCardDto }
  | { state: "refused"; code: string; message: string; params?: Record<string, unknown>; fixes: FixDto[]; paused: boolean; formCreated: boolean; note?: string }
  | { state: "awaiting_approval"; message: string }
  | { state: "demo"; message: string }
  | { state: "start_closed"; message: string }
  | { state: "needs_approver"; message: string }
  | { state: "not_ready"; message: string; issues: string[] }
  | { state: "media_not_ready"; message: string; mediaIds: string[] }
  | { state: "unknown"; message: string; formCreated: boolean }
  | { state: "failed"; message: string; paused: boolean; formCreated: boolean };

export const isReviewCard = (v: unknown): v is ReviewCardDto => isObj(v) && typeof v.campaignId === "string" && typeof v.materialHash === "string" && typeof v.state === "string";
export const isStartOutcome = (v: unknown): v is StartOutcomeDto => isObj(v) && typeof v.state === "string" && typeof v.message === "string";

/**
 * What a tap on Start or Save without starting answered. A body that is an outcome is used as it came. A Start whose answer
 * never arrived (the network failed, a 5xx, a timeout) may still have reached Meta, so it is "unknown": the card says it
 * isn't certain whether this went through, Start hides and the card links to the ad's status. A clear refusal (4xx) is
 * "failed" with its sentence, and 403 means Start isn't open here.
 */
export function actOutcome(kind: "start" | "save", res: SendResult, lang: PromoteLang = "en"): StartOutcomeDto {
  if (isStartOutcome(res.body)) return res.body;
  if (kind === "start" && (res.status === 0 || res.status === 408 || res.status >= 500)) return { state: "unknown", message: "", formCreated: false };
  if (res.status === 403) return { state: "start_closed", message: errorText(res.body, "flow.create_failed", lang) };
  return { state: "failed", message: errorText(res.body, "flow.create_failed", lang), paused: false, formCreated: false };
}

/** The states the review card shows (7.3): the card's own, and what a tap on Start or Save without starting answered. */
export type ReviewUiState =
  | "ready"
  | "running"
  | "done"
  | "saved"
  | "failed"
  | "changed"
  | "needs_approver"
  | "spend_frozen"
  | "spend_not_set_up"
  | "demo"
  | "unknown"
  | "awaiting_approval"
  | "doesnt_fit"
  | "blocked"
  | "start_closed"
  | "not_connected"
  | "media_not_ready"
  | "busy";

/** Where the card points next, besides Start and Save without starting. */
export type ReviewLink = "pause" | "campaign" | "spending" | "ask_owner" | "send_for_approval" | "reconnect" | "check_again";

export type ReviewView = {
  state: ReviewUiState;
  tone: Tone;
  text: string | null;
  /** Start: shown only while Start is open (P3) and the state allows it; enabled when nothing stops it. */
  start: { visible: boolean; enabled: boolean };
  /** Save without starting: stays for everyone who may write, except where nothing is left to save. */
  save: { visible: boolean };
  fixes: FixDto[];
  links: ReviewLink[];
};

const SPEND_STOPPED = new Set(["spend.frozen", "spend.platform_frozen"]);

/** The UI state of a review card, or of what Start answered. */
export function reviewState(card: Pick<ReviewCardDto, "state"> | null, outcome: StartOutcomeDto | null): ReviewUiState {
  if (outcome) {
    switch (outcome.state) {
      case "started":
        return "done";
      case "saved":
        return "saved";
      case "changed":
        return "changed";
      case "typed_confirm":
        return "ready";
      case "refused":
        if (SPEND_STOPPED.has(outcome.code)) return "spend_frozen";
        if (outcome.code === "spend.no_limit") return "spend_not_set_up";
        if (outcome.code === "spend.busy") return "busy";
        return "failed";
      case "awaiting_approval":
        return "awaiting_approval";
      case "demo":
        return "demo";
      case "start_closed":
        return "start_closed";
      case "needs_approver":
        return "needs_approver";
      case "not_ready":
        return "blocked";
      case "media_not_ready":
        return "media_not_ready";
      case "unknown":
        return "unknown";
      case "failed":
        return "failed";
    }
  }
  return card?.state ?? "ready";
}

const TONES: Readonly<Record<ReviewUiState, Tone>> = {
  ready: "neutral",
  running: "good",
  done: "good",
  saved: "good",
  failed: "bad",
  changed: "warn",
  needs_approver: "info",
  spend_frozen: "bad",
  spend_not_set_up: "warn",
  demo: "info",
  unknown: "warn",
  awaiting_approval: "info",
  doesnt_fit: "warn",
  blocked: "warn",
  start_closed: "info",
  not_connected: "warn",
  media_not_ready: "info",
  busy: "warn",
};

/** States in which Start may show at all (it is enabled only when nothing stops it). */
const START_STATES: ReadonlySet<ReviewUiState> = new Set<ReviewUiState>(["ready", "changed", "doesnt_fit", "blocked", "failed", "busy", "media_not_ready"]);
/** States with nothing left to save (it is on Meta, or nothing can be sent). */
const NO_SAVE: ReadonlySet<ReviewUiState> = new Set<ReviewUiState>(["running", "done", "saved", "demo", "unknown", "not_connected"]);

/**
 * Each state's copy and buttons (6.5, 7.3, 3.3 edge cases). Start appears only when promoteAccess.canStart (P3); Save without
 * starting stays for writers whenever there is still something to save (spending stopped, no approver, a closed Start).
 */
export function reviewView(i: { card: ReviewCardDto | null; outcome: StartOutcomeDto | null; canStart: boolean; canWrite?: boolean; isOwner: boolean; lang?: PromoteLang }): ReviewView {
  const lang = i.lang ?? "en";
  const { card, outcome } = i;
  const state = reviewState(card, outcome);
  // A blank sentence from the server reads as none, so the state's own copy shows instead.
  const message = outcome && "message" in outcome && typeof outcome.message === "string" && outcome.message.trim() ? outcome.message : null;
  const note = outcome && "note" in outcome && typeof outcome.note === "string" ? outcome.note : null;
  const joined = (a: string | null, b: string | null) => [a, b].filter(Boolean).join(" ") || null;
  let text: string | null = null;
  let fixes: FixDto[] = [];
  const links: ReviewLink[] = [];
  switch (state) {
    case "ready":
      text = outcome?.state === "typed_confirm" ? outcome.message : null;
      break;
    case "running":
      text = promoteText("status.running", {}, lang);
      links.push("campaign");
      break;
    case "done":
      text = joined(message ?? promoteText("card.sent", {}, lang), note);
      links.push("pause", "campaign");
      break;
    case "saved":
      text = message;
      links.push("campaign");
      break;
    case "failed":
      text = joined(message, note);
      fixes = outcome?.state === "refused" ? outcome.fixes : [];
      if (!fixes.length) links.push("check_again");
      break;
    case "busy":
      text = message;
      fixes = outcome?.state === "refused" && outcome.fixes.length ? outcome.fixes : [{ kind: "retry", label: promoteText("fix.retry", {}, lang) }];
      break;
    case "changed":
      text = message ?? promoteText("card.changed", {}, lang);
      break;
    case "needs_approver":
      text = message;
      break;
    case "spend_frozen":
      text = message ?? card?.stateText ?? null;
      break;
    case "spend_not_set_up":
      text = message ?? card?.stateText ?? null;
      links.push(i.isOwner ? "spending" : "ask_owner");
      break;
    case "demo":
      text = promoteText("card.demo", {}, lang);
      break;
    case "unknown":
      text = promoteText("card.unknown", {}, lang);
      links.push("campaign");
      break;
    case "awaiting_approval":
      text = promoteText("card.waiting_client", {}, lang);
      links.push("send_for_approval");
      break;
    case "doesnt_fit":
      text = card?.stateText ?? null;
      fixes = card?.fixes ?? [];
      break;
    case "blocked":
      text = message ?? promoteText("review.blocked", {}, lang);
      links.push("check_again");
      break;
    case "start_closed":
      text = message ?? card?.stateText ?? null;
      break;
    case "not_connected":
      text = card?.stateText ?? null;
      links.push("reconnect");
      break;
    case "media_not_ready":
      text = message ?? promoteText("error.media_not_ready", {}, lang);
      links.push("check_again");
      break;
  }
  const writer = i.canWrite !== false;
  const startVisible = writer && i.canStart && START_STATES.has(state);
  const startEnabled = startVisible && (state === "ready" || state === "changed" || ((state === "failed" || state === "busy") && !fixes.some((f) => f.kind !== "retry")));
  return { state, tone: TONES[state], text, start: { visible: startVisible, enabled: startEnabled }, save: { visible: writer && !NO_SAVE.has(state) }, fixes, links };
}

/** The primary's label with the worst case on it (D5): "Start boost · up to ₹2,625". */
export function startLabel(i: { kind: "boost" | "ads" | "lead"; worstMinor: bigint; currency: string }, lang: PromoteLang = "en"): string {
  const key: PromoteCopyKey = i.kind === "boost" ? "card.boost.start" : i.kind === "lead" ? "card.lead.start" : "card.ads.start";
  return promoteText(key, { amount: formatMoney(i.worstMinor, i.currency) }, lang);
}

/** The card's own label (the server writes it from the same copy), else the label from its worst case. */
export function primaryLabel(card: Pick<ReviewCardDto, "primary" | "worstCaseMinor" | "facts" | "cost">, lang: PromoteLang = "en"): string {
  if (card.primary.trim()) return card.primary;
  const kind = card.facts.some((f) => f.key === "post") ? "boost" : card.facts.some((f) => f.key === "form") ? "lead" : "ads";
  return startLabel({ kind, worstMinor: minorOf(card.worstCaseMinor), currency: card.cost?.currency ?? "INR" }, lang);
}

/** Start is aria-disabled for 600 ms after the card appears (D5, Eddy 6.5). */
export const START_GUARD_MS = 600;
export const startArmed = (shownAt: number, now: number, guardMs = START_GUARD_MS): boolean => now - shownAt >= Math.max(0, guardMs);
/** A tap inside the guard runs nothing and says "Check the card, then tap again." once per card. */
export function guardTap(armed: boolean, alreadyAnnounced: boolean): { run: boolean; announce: boolean } {
  return armed ? { run: true, announce: false } : { run: false, announce: !alreadyAnnounced };
}

/** The typed figure is asked only at 50% or more of what is left this month (D5, 6.1 rule 5). */
export const needsTypedConfirm = (card: Pick<ReviewCardDto, "typedConfirmRequired"> | null): boolean => card?.typedConfirmRequired === true;

/** The typed figure matches the worst case on the button: "₹2,625", "2625" or "2,625.00" (the server checks it again). */
export function typedOk(typed: string, worstMinor: bigint, currency: string): boolean {
  const text = typed.replace(/[^\d.]/g, "");
  if (!/^\d{1,15}(\.\d{1,4})?$/.test(text)) return false;
  const unit = majorUnit(currency);
  const exp = unit.toString().length - 1;
  const [whole, frac = ""] = text.split(".");
  if (frac.length > exp) return false;
  const typedMinor = BigInt(whole) * unit + (frac ? BigInt(frac.padEnd(exp, "0")) : 0n);
  if (typedMinor === worstMinor) return true;
  if (frac) return false;
  const floor = (worstMinor / unit) * unit;
  const ceil = worstMinor % unit === 0n ? floor : floor + unit;
  return typedMinor === floor || typedMinor === ceil;
}

/** The Start body: the total and worst case the card showed, its material hash, and the typed figure when asked (D5). */
export function startBody(card: Pick<ReviewCardDto, "dailyTotalMinor" | "worstCaseMinor" | "materialHash">, typed?: string | null): Record<string, unknown> {
  return { confirmedTotalMinor: card.dailyTotalMinor, confirmedWorstCaseMinor: card.worstCaseMinor, materialHash: card.materialHash, ...(typed ? { typedWorstCase: typed } : {}), lang: "en" };
}

/** What a fix chip does (3.3, 6.2): the exact draft change, a retry, a wait, the limits page, or the sentence to ask the owner. */
export type FixAction =
  | { kind: "set"; set: Record<string, unknown> }
  | { kind: "retry" }
  | { kind: "wait"; until: Date }
  | { kind: "link"; href: string }
  | { kind: "note"; text: string };

/** The exact draft change of a fix, or null for fixes that change nothing in the draft. fewer_days never goes below 2 (D31). */
export function fixDraftChange(fix: Pick<FixDto, "kind" | "toMinor" | "days">): Record<string, unknown> | null {
  if ((fix.kind === "lower_daily" || fix.kind === "raise_to_min") && fix.toMinor !== undefined) {
    const to = minorOrNull(String(fix.toMinor));
    return to !== null && to > 0n ? { "budget.dailyMinor": to } : null;
  }
  if (fix.kind === "fewer_days" && typeof fix.days === "number" && Number.isFinite(fix.days)) return { "run.runDays": Math.min(MAX_RUN_DAYS, Math.max(MIN_RUN_DAYS, Math.floor(fix.days))) };
  return null;
}

export function fixAction(fix: FixDto, ctx: { isOwner: boolean; owner: string | null; lang?: PromoteLang }): FixAction {
  const lang = ctx.lang ?? "en";
  const set = fixDraftChange(fix);
  if (set) return { kind: "set", set };
  switch (fix.kind) {
    case "retry_at": {
      const until = fix.at ? new Date(fix.at) : null;
      return until && !Number.isNaN(until.getTime()) ? { kind: "wait", until } : { kind: "retry" };
    }
    case "ask_owner":
      return ctx.isOwner ? { kind: "link", href: SPENDING_PATH } : { kind: "note", text: promoteText("review.ask_owner_note", { owner: ownerLabel(ctx.owner, lang) }, lang) };
    default:
      return { kind: "retry" };
  }
}

/** The owner's name for "Ask {owner} …", or "the owner". */
export const ownerLabel = (owner: string | null | undefined, lang: PromoteLang = "en"): string => owner?.trim() || promoteText("flow.the_owner", {}, lang);

/** A Try again at {time} chip waits until then. */
export const fixWaiting = (action: FixAction, now: number): boolean => action.kind === "wait" && action.until.getTime() > now;

/** "You can try again at 3:40 pm." */
export const waitText = (until: Date, tz: string, lang: PromoteLang = "en"): string => promoteText("review.retry_at_wait", { time: formatTime(until, tz) }, lang);

/**
 * Whether Start can run now (D5): the state allows it, and the typed figure matches when the card asks for one. The 600 ms guard
 * is separate (aria-disabled, guardTap), so a tap inside it is answered instead of silently ignored.
 */
export function startReady(view: Pick<ReviewView, "start">, card: Pick<ReviewCardDto, "typedConfirmRequired" | "worstCaseMinor" | "cost"> | null, typed: string): boolean {
  if (!view.start.visible || !view.start.enabled || !card) return false;
  return !needsTypedConfirm(card) || typedOk(typed, minorOf(card.worstCaseMinor), card.cost?.currency ?? "INR");
}

// =====================================================================================================================
// "Your ad" in the draft (3.4 step 2, 3.8): AdStep's value as draft paths, and back
// =====================================================================================================================

const noMedia = (): DraftMedia => ({ feed: null, vertical: null, square: null, video: null });

/**
 * The draft change for AdStep's value: what applies (adStepInUse) as the draft's format, text, media ids, cards, button and
 * versions B and C. A video's own file goes in media.video and its tall version in media.vertical. Every version shares the
 * goal step's link. Versions turn the fair test on (3.8); removing the last one turns it off. Card links that aren't https are
 * left out (the review asks for them), so a half-typed link never blocks the save.
 */
export function adStepSet(value: AdStepValue, opts: { link: string | null; compareMode: CompareMode }): Record<string, unknown> {
  const use = adStepInUse(value);
  const carousel = use.source === "carousel";
  const link = opts.link && isHttpsUrl(opts.link) ? opts.link.trim() : null;
  const mediaOf = (v: AdVersionValue): DraftMedia =>
    carousel
      ? noMedia()
      : use.source === "video"
        ? { feed: null, vertical: v.vertical?.id ?? null, square: null, video: v.feed?.id ?? null }
        : { feed: v.feed?.id ?? null, vertical: v.vertical?.id ?? null, square: null, video: null };
  const textOf = (v: AdVersionValue): DraftText => ({ primary: v.text.primary, headline: v.text.headline, description: v.text.description ?? "", link });
  const a = use.versions[0] ?? emptyVersion();
  const [b, c] = carousel ? [] : use.versions.slice(1);
  const media = mediaOf(a);
  const set: Record<string, unknown> = {
    format: use.format,
    "text.primary": a.text.primary,
    "text.headline": a.text.headline,
    "text.description": a.text.description ?? "",
    "media.feed": media.feed,
    "media.vertical": media.vertical,
    "media.square": null,
    "media.video": media.video,
    cards: carousel
      ? use.cards
          .filter((k): k is CarouselCardValue & { media: AdMediaView } => !!k.media)
          .map((k) => ({ mediaId: k.media.id, headline: k.headline.slice(0, 255), description: "", link: isHttpsUrl(k.link.trim()) ? k.link.trim() : null }))
      : [],
    ctaType: value.ctaType,
    "versions.B": b ? { text: textOf(b), media: mediaOf(b) } : null,
    "versions.C": c ? { text: textOf(c), media: mediaOf(c) } : null,
  };
  if (b && opts.compareMode === "single") set["compare.mode"] = "fair_split";
  if (!b && opts.compareMode !== "single") set["compare.mode"] = "single";
  return set;
}

/** Every media id the draft's ad uses (version A, B and C, and the carousel cards), once each. */
export function draftMediaIds(d: Pick<PromotionDraft, "media" | "versions" | "cards">): string[] {
  const out = new Set<string>();
  const add = (m: DraftMedia | null | undefined) => {
    for (const id of [m?.feed, m?.vertical, m?.square, m?.video]) if (id) out.add(id);
  };
  add(d.media);
  add(d.versions.B?.media);
  add(d.versions.C?.media);
  for (const k of d.cards) if (k.mediaId) out.add(k.mediaId);
  return [...out];
}

/**
 * AdStep's value for a saved draft (a reload, a fix copy, a notification tap), with each media id looked up (GET
 * /api/promote/media/[id]). A missing file reads as not chosen. A carousel always has at least its 2 cards.
 */
export function adStepFromDraft(d: Pick<PromotionDraft, "format" | "text" | "media" | "versions" | "cards" | "ctaType">, lookup: (id: string | null) => AdMediaView | null): AdStepValue {
  const source: AdStepSource = d.format === "single_video" ? "video" : d.format === "carousel" ? "carousel" : "image";
  const version = (text: DraftText, media: DraftMedia): AdVersionValue => ({
    feed: lookup(source === "video" ? media.video : (media.feed ?? media.square)),
    vertical: lookup(media.vertical),
    text: { primary: text.primary, headline: text.headline, description: text.description },
  });
  const versions = [version(d.text, d.media)];
  for (const k of ["B", "C"] as const) {
    const v = d.versions[k];
    if (v) versions.push(version(v.text, v.media));
  }
  const cards: CarouselCardValue[] = d.cards.map((k, i) => ({ id: `card-saved-${i}`, media: lookup(k.mediaId), headline: k.headline, link: k.link ?? "" }));
  while (cards.length < 2) cards.push({ id: `card-new-${cards.length}`, media: null, headline: "", link: "" });
  return { source, versions, cards, ctaType: d.ctaType };
}

// =====================================================================================================================
// What each step needs before Continue (3.3, 3.4, 3.5, 3.6)
// =====================================================================================================================

export type StepCheck = {
  step: StepId;
  /** post: the picked post. */
  pick?: Pick<BoostableItem, "eligibility" | "reasons"> | null;
  /** goal: the goal, and whether Meta allows its button on the picked post (a boost chip). */
  goal?: GoalKey | null;
  goalUsable?: boolean;
  /** goal (a boost): the goals the post's app can take (boostGoalChips); a goal outside them can't be boosted. */
  goalChoices?: readonly GoalKey[];
  link?: string;
  welcome?: WelcomeValue;
  /** form: a saved form, or a new one and whether the builder found problems. */
  form?: { choice: "new" | "saved"; savedId: string | null; problems: number };
  ad?: AdStepValue | null;
  audience?: PromotionDraft["audience"] | null;
};

/**
 * Whether Continue may move on after the step's save: saved; or an earlier refusal that was already shown and put back on screen
 * (nothing new was refused just now), unless it is the special-category question, which must be answered first.
 */
export function savedEnough(state: SaveState, refusedJustNow: boolean, refusal: unknown): boolean {
  if (state === "saved") return true;
  return state === "error" && !refusedJustNow && !isCategoryQuestion(refusal);
}

/** The sentence that stops Continue on a step, or null. The fields themselves show their own errors. */
export function stepProblem(c: StepCheck, lang: PromoteLang = "en"): string | null {
  const t = (k: PromoteCopyKey, v: Record<string, string> = {}) => promoteText(k, v, lang);
  switch (c.step) {
    case "post":
      if (!c.pick) return t("flow.pick_post");
      if (c.pick.eligibility === "no") return postEdge(c.pick, null, lang)?.text ?? t("flow.pick_post");
      return null;
    case "goal": {
      if (!c.goal) return t("flow.fix_fields");
      if (c.goalChoices && !c.goalChoices.includes(c.goal)) return t("flow.goal_not_for_post");
      if (c.goalUsable === false) return goalEdge(c.goal, lang).text;
      if (needsLink(c.goal) && linkProblem(c.link ?? "", lang)) return t("flow.fix_fields");
      if (needsWelcome(c.goal) && c.welcome && !welcomeProblems(c.welcome, lang).ok) return t("flow.fix_fields");
      return null;
    }
    case "form":
      if (!c.form) return null;
      if (c.form.choice === "saved") return c.form.savedId ? null : t("flow.form.need_one");
      return c.form.problems > 0 ? t("flow.fix_fields") : null;
    case "ad": {
      if (!c.ad) return t("flow.need_media");
      const use = adStepInUse(c.ad);
      if (use.source === "carousel") return use.cards.filter((k) => k.media).length >= 2 ? null : t("carousel.cards");
      return use.versions.every((v) => v.feed) ? null : t("flow.need_media");
    }
    case "audience":
      return c.audience?.mode === "near_shop" && !c.audience.nearShop ? t("flow.need_place") : null;
    case "review":
      return null;
  }
}

/**
 * The step a page opened with ?draft=&step= resumes at, once the draft (and so its goal and steps) has loaded (D28): a lead
 * form ad reloaded on its form step opens there, not on the ad step of the default goal's flow.
 */
export function draftStep(kind: FlowKind, goal: GoalKey, asked: StepId | null | undefined): StepId {
  const steps = flowSteps(kind, goal);
  return clampStep(steps, resumeStep(steps, asked, true), true);
}

/**
 * Leaving the flow (Save and exit, or Back on the first screen) after its save: go when the draft is saved, or when there is
 * no draft yet; otherwise ask "Leave without saving?" first, so staged changes are never dropped without a word.
 */
export function exitAction(hasDraft: boolean, savedOk: boolean): "leave" | "ask" {
  return hasDraft && !savedOk ? "ask" : "leave";
}

/** The saved forms of the Page the ad runs from ("Use a saved form", 3.5): Meta refuses a form of another Page. */
export function formsForPage(forms: FlowContext["forms"], pageAssetId: string | null): FlowContext["forms"] {
  return pageAssetId ? forms.filter((f) => f.pageAssetId === pageAssetId) : [];
}

/**
 * Whether the form step shows "Your form is saved with this ad" instead of the builder: a lead form draft with its own new
 * form whose questions weren't built on this page (a reload, a notification tap). The server keeps that form's spec and the
 * page can't read it back, so a fresh builder would show other questions; Continue keeps the saved form, and [Make a new form]
 * opens the builder to replace it.
 */
export function formKept(i: { goal: GoalKey | null | undefined; leadFormId: string | null | undefined; builtHere: boolean }): boolean {
  return i.goal === "lead_form" && !i.leadFormId && !i.builtHere;
}

/** The draft change for the goal step's link: the link once it is https (or null when cleared); nothing while half-typed. */
export function linkSet(link: string): Record<string, unknown> {
  const v = link.trim();
  if (!v) return { "text.link": null };
  return linkProblem(v) ? {} : { "text.link": v };
}

/** The draft change for the first message and quick questions: each part once it is valid, so typing never blocks a save. */
export function welcomeSet(w: WelcomeValue): Record<string, unknown> {
  const p = welcomeProblems(w);
  const set: Record<string, unknown> = {};
  if (!p.message) set["welcome.message"] = w.message;
  if (w.iceBreakers.length <= QUICK_QUESTIONS_MAX && p.questions.every((q) => !q.title && !q.response)) set["welcome.iceBreakers"] = w.iceBreakers.map((q) => ({ title: q.title.trim(), response: q.response.trim() }));
  return set;
}

/** The goal change, with the first message a chat goal needs when the draft has none yet (3.6 default, in the page's language). */
export function goalSet(goal: GoalKey, current: Pick<PromotionDraft, "welcome">, lang: PromoteLang = "en"): Record<string, unknown> {
  const set: Record<string, unknown> = { goal };
  if (needsWelcome(goal) && !current.welcome.message.trim()) set["welcome.message"] = promoteText("chat.first_message_default", {}, lang);
  return set;
}

// =====================================================================================================================
// Making the draft (POST /api/promote/drafts) and an edited copy of it
// =====================================================================================================================

/**
 * POST /api/promote/drafts for a new ad: the goal and days, the Page (when the member chose one), the goal step's link and
 * first message, and a lead form's spec (3.5: Start creates the form from it). The server fills every other 3.1 default.
 */
export function createDraftBody(i: {
  goal: GoalKey;
  days: number;
  pageAssetId: string | null;
  igAssetId?: string | null;
  set?: Readonly<Record<string, unknown>>;
  form?: unknown;
  categoryAnswer?: string | null;
}): Record<string, unknown> {
  return {
    goal: i.goal,
    days: i.days,
    source: { kind: "new" },
    ...(i.pageAssetId ? { pageAssetId: i.pageAssetId } : {}),
    ...(i.igAssetId ? { igAssetId: i.igAssetId } : {}),
    set: toJsonSet(knownPaths(i.set ?? {})),
    ...(i.form !== undefined && i.form !== null ? { form: i.form } : {}),
    ...(i.categoryAnswer ? { categoryAnswer: i.categoryAnswer } : {}),
    lang: "en",
  };
}

/** Paths the server sets from the request itself (the post and the special-category answer), never copied into an edited copy. */
const NOT_COPIED = new Set(["source.kind", "source.ref", "specialAdCategory"]);

/**
 * Every value of a draft as draft paths, for an edited copy made with POST (a lead form's spec can only be given when a draft
 * is made, so a changed form makes a new draft with everything else the same). A compared version is copied whole.
 */
export function draftSetOf(d: PromotionDraft): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const path of DRAFT_PATH_LIST) {
    if (chipPathOf(path) !== path || NOT_COPIED.has(path)) continue;
    const v = readPath(d, path);
    if (v !== undefined) set[path] = v;
  }
  return set;
}

// =====================================================================================================================
// The special-category question (3.1: "Is this ad about jobs, housing, loans or credit?")
// =====================================================================================================================

const CATEGORY_KEYS: Readonly<Record<string, PromoteCopyKey>> = {
  housing: "category.housing",
  employment: "category.employment",
  credit: "category.credit",
  social_issues: "category.social_issues",
};

/** A save or create the server answered with the question (400 category_question). */
export const isCategoryQuestion = (body: unknown): body is { error?: string; code: "category_question"; categories?: string[] } => isObj(body) && body.code === "category_question";

/** The answers: "No, it's about something else", then "Yes: housing" and so on for the categories the text suggests. */
export function categoryChoices(asked: readonly string[] | null | undefined, lang: PromoteLang = "en"): { value: string; label: string }[] {
  const cats = (asked?.length ? asked : Object.keys(CATEGORY_KEYS)).filter((k) => Object.prototype.hasOwnProperty.call(CATEGORY_KEYS, k));
  return [
    { value: "none", label: promoteText("flow.category.no", {}, lang) },
    ...[...new Set(cats)].map((k) => ({ value: k, label: promoteText("flow.category.yes", { category: promoteText(CATEGORY_KEYS[k], {}, lang) }, lang) })),
  ];
}

// =====================================================================================================================
// The preview column (7.2 desktop, 7.4)
// =====================================================================================================================

const APP_TABS: Readonly<Record<"instagram" | "facebook", PlacementKey[]>> = {
  instagram: ["instagram_feed", "instagram_stories", "instagram_reels"],
  facebook: ["facebook_feed", "facebook_stories", "facebook_reels"],
};

/** The preview tabs' positions: the chosen ones, one app's three, or [] for Automatic (PlacementPreview shows all six). */
export function previewPositions(d: Pick<PromotionDraft, "placements">): PlacementKey[] {
  const m = d.placements.mode;
  if (m === "custom") return [...d.placements.positions];
  if (m === "instagram" || m === "facebook") return [...APP_TABS[m]];
  return [];
}

/** A short key that changes only when what the preview shows changes (each new key may ask Meta for up to 6 previews, D18). */
export function previewKey(d: Pick<PromotionDraft, "goal" | "source" | "format" | "text" | "media" | "cards" | "ctaType" | "placements" | "welcome">): string {
  const s = JSON.stringify([d.goal, d.source, d.format, d.text, d.media, d.cards, d.ctaType, d.placements.mode, d.placements.positions, d.welcome.message]);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

// =====================================================================================================================
// Strings that must come from promote/copy (the grep test, acceptance 2)
// =====================================================================================================================

/**
 * Copy keys whose English text this package shows. tests/promote-ui.test.ts checks that no file of the package carries one
 * of these texts as a literal: each one is looked up through promoteText, never typed again.
 */
export const COPY_GUARD_KEYS: readonly PromoteCopyKey[] = [
  "flow.back",
  "flow.save_exit",
  "flow.continue",
  "flow.boost_title",
  "flow.create_title",
  "flow.step.post",
  "flow.step.form",
  "flow.step.ad",
  "flow.step.audience",
  "flow.step.review",
  "goal.question",
  "goal.more",
  "draft.saved",
  "draft.not_saved",
  "draft.conflict",
  "card.save_paused",
  "card.demo",
  "card.waiting_client",
  "card.send_for_approval",
  "card.sent",
  "card.unknown",
  "card.changed",
  "card.pause",
  "card.see_previews",
  "card.goes_to_meta",
  "card.meta_reviews",
  "audience.meta_finds",
  "audience.meta_finds_note",
  "audience.near_shop",
  "audience.i_choose",
  "audience.size_unknown",
  "placement.auto",
  "placement.change",
  "more.title",
  "more.improve_my_ad",
  "more.url_params",
  "chips.reset",
  "boost.can_boost",
  "boost.made_in_edwyz",
  "boost.make_new",
  "boost.no_whatsapp_button",
  "picker.tab.reels",
  "picker.tab.posts",
  "picker.tab.stories",
  "picker.more",
  "place.use_location",
  "chat.first_message",
  "chat.quick_questions",
  "readiness.reconnect",
  "fix.spending_limits",
  "fix.retry",
  "review.check_first",
  "review.what_people_see",
  "review.check_again",
  "review.loading",
  "opens_meta.label",
  "flow.save_now",
  "flow.back_to_ads",
  "flow.see_campaign",
  "flow.writers_only",
  "flow.not_editable",
  "flow.discarded",
  "flow.pick_post",
  "flow.need_media",
  "flow.need_place",
  "flow.preview_note",
  "flow.form.new",
  "flow.form.saved",
  "flow.form.which",
  "flow.category.no",
  "flow.category.save",
  "goal.setup",
  "goal.link_label",
  "place.search",
  "readiness.all_ok",
  "flow.leave_question",
  "flow.leave_body",
  "flow.leave_unsaved",
  "flow.stay",
  "flow.goal_not_for_post",
  "flow.form.kept",
  "flow.form.replace",
];
