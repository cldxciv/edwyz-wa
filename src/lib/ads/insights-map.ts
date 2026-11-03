/*
 * What counts as a result. VERIFY every entry against the current Marketing API actions reference: Meta renames action types
 * and attribution windows (the _7d suffix in particular). The first entry in a list with a non-zero value wins, so one
 * conversion is never counted twice.
 *
 * RESULT_ACTIONS is keyed two ways:
 * - by campaign objective (OUTCOME_*), for the level snapshots, whose rows carry Meta's objective;
 * - by goal (docs/IG-PAGE-ADS-SPEC.md 4.4: whatsapp_chats, lead_form, ...), for the results by placement, creative, audience
 *   and region (PRM-12), where Edwyz knows the goal the campaign was made for. Two goal entries are row metrics rather than
 *   action types: `reach` (awareness) and `video_thruplay_watched_actions` (video views); pickRowResults reads them.
 */
export const CHAT_STARTED = "onsite_conversion.messaging_conversation_started_7d";
/** The row's reach counts as the result (awareness). Never summed across days for a whole run: see the run total (R3a). */
export const REACH_RESULT = "reach";
/** ThruPlays, Meta's `video_thruplay_watched_actions` field, count as the result (video views). */
export const THRUPLAY_RESULT = "video_thruplay_watched_actions";
/** Meta's own lead count on an insights row (instant forms). */
export const LEAD_ACTIONS: readonly string[] = ["lead", "onsite_conversion.lead_grouped"];

export const RESULT_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  // By objective (Phase 0's level snapshots).
  OUTCOME_LEADS: ["lead", "onsite_conversion.lead_grouped", CHAT_STARTED],
  OUTCOME_ENGAGEMENT: [CHAT_STARTED, "post_engagement"],
  OUTCOME_TRAFFIC: ["landing_page_view", "link_click"],
  OUTCOME_SALES: ["offsite_conversion.fb_pixel_purchase", "purchase", "omni_purchase"],
  OUTCOME_APP_PROMOTION: ["mobile_app_install"],
  OUTCOME_AWARENESS: [],
  // By goal (4.4). The three chat goals, and chats on any app, count conversations started.
  whatsapp_chats: [CHAT_STARTED],
  instagram_dms: [CHAT_STARTED],
  messenger_chats: [CHAT_STARTED],
  any_chat: [CHAT_STARTED],
  lead_form: LEAD_ACTIONS,
  // Landing page views need a pixel; without one the ad set optimises for link clicks. The ad set's optimisation picks one of
  // the two (resultActionsForOptimization); this list is only for rows whose optimisation is unknown.
  website_visits: ["landing_page_view", "link_click"],
  website_sales: ["offsite_conversion.fb_pixel_purchase", "purchase", "omni_purchase"],
  engagement: ["post_engagement"],
  video_views: [THRUPLAY_RESULT],
  awareness: [REACH_RESULT],
  page_likes: ["like"],
  // VERIFY V-P17: Meta's action type for Instagram profile visits is not documented (the goal catalog keeps its resultAction
  // null), so no action is counted until the runbook records it.
  profile_visits: [],
};
export const FALLBACK_ACTIONS: readonly string[] = ["lead", CHAT_STARTED, "link_click"];

export type ActionValue = { action_type?: string; value?: string };

export function parseCount(value: unknown): number {
  const n = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 2_147_483_647) : 0;
}

/** The list for an objective or a goal, or the fallback. Own keys only, so "constructor" is never a list. */
export function resultActionsFor(key: string | null | undefined): readonly string[] {
  return key && Object.prototype.hasOwnProperty.call(RESULT_ACTIONS, key) ? RESULT_ACTIONS[key] : FALLBACK_ACTIONS;
}

/** The count of one action type in Meta's `actions` list (0 when absent). */
export function actionCount(actions: readonly ActionValue[] | undefined, type: string): number {
  return parseCount(actions?.find((a) => a?.action_type === type)?.value);
}

/** The sum of a list of action values, such as `video_thruplay_watched_actions` (one entry per action type). Clamped like parseCount. */
export function sumActions(actions: readonly ActionValue[] | undefined): number {
  let total = 0;
  for (const a of actions ?? []) total += parseCount(a?.value);
  return Math.min(total, 2_147_483_647);
}

/** Meta's own lead count on a row: `lead`, else the grouped lead action. */
export function leadCount(actions: readonly ActionValue[] | undefined): number {
  for (const type of LEAD_ACTIONS) {
    const n = actionCount(actions, type);
    if (n > 0) return n;
  }
  return 0;
}

export function pickResults(objective: string | undefined, actions: ActionValue[] | undefined): { results: number; actionType: string | null } {
  for (const type of resultActionsFor(objective)) {
    const n = actionCount(actions, type);
    if (n > 0) return { results: n, actionType: type };
  }
  return { results: 0, actionType: null };
}

/**
 * Optimisation goals that decide what a result is (src/lib/promote/catalog/goals.ts resultActionFor). A website-visits ad set
 * optimised for landing page views counts landing page views only, and one optimised for link clicks counts link clicks only,
 * so a row with no page view never counts its clicks as visits.
 */
export const OPTIMIZATION_RESULT_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  LANDING_PAGE_VIEWS: ["landing_page_view"],
  LINK_CLICKS: ["link_click"],
};

/**
 * The result actions of a goal (or objective) for an ad set's optimisation: the one action the optimisation picks from the
 * goal's list (website visits: landing page views or link clicks), else the goal's own list. An unknown optimisation keeps the
 * list.
 */
export function resultActionsForOptimization(key: string | null | undefined, optimizationGoal: string | null | undefined): readonly string[] {
  const list = resultActionsFor(key);
  const fixed = optimizationGoal && Object.prototype.hasOwnProperty.call(OPTIMIZATION_RESULT_ACTIONS, optimizationGoal) ? OPTIMIZATION_RESULT_ACTIONS[optimizationGoal] : null;
  return fixed && list.length > 1 && fixed.every((a) => list.includes(a)) ? fixed : list;
}

/** The parts of an insights row a result can come from. */
export type ResultRow = { actions?: ActionValue[]; reach?: string | number; video_thruplay_watched_actions?: ActionValue[] };

/**
 * Results of one row for a goal (or an objective): like pickResults, but `reach` and ThruPlays are read from the row's own
 * fields. A day's reach is a result only for that day; a run's reach comes from the run total, never a sum of days. `actions`,
 * when given, is the list to count instead of the goal's (resultActionsForOptimization).
 */
export function pickRowResults(key: string | null | undefined, row: ResultRow, actions?: readonly string[] | null): { results: number; actionType: string | null } {
  for (const type of actions ?? resultActionsFor(key)) {
    const n = type === REACH_RESULT ? parseCount(row.reach) : type === THRUPLAY_RESULT ? sumActions(row.video_thruplay_watched_actions) : actionCount(row.actions, type);
    if (n > 0) return { results: n, actionType: type };
  }
  return { results: 0, actionType: null };
}

/** Meta returns values like ABOVE_AVERAGE, BELOW_AVERAGE_20 and UNKNOWN. Stored lower case; UNKNOWN becomes null. */
export function normalizeRanking(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase().slice(0, 40);
  return v === "" || v === "unknown" ? null : v;
}

export const isLowQuality = (ranking: string | null | undefined) => !!ranking && ranking.startsWith("below_average");
