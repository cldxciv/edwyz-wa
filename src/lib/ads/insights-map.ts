/*
 * Primary result action per campaign objective. VERIFY every entry against the current Marketing API
 * actions reference: Meta renames action types and attribution windows (the _7d suffix in particular).
 * The first action type in a list with a non-zero value wins, so one conversion is never counted twice.
 */
export const RESULT_ACTIONS: Record<string, string[]> = {
  OUTCOME_LEADS: ["lead", "onsite_conversion.lead_grouped", "onsite_conversion.messaging_conversation_started_7d"],
  OUTCOME_ENGAGEMENT: ["onsite_conversion.messaging_conversation_started_7d", "post_engagement"],
  OUTCOME_TRAFFIC: ["landing_page_view", "link_click"],
  OUTCOME_SALES: ["offsite_conversion.fb_pixel_purchase", "purchase", "omni_purchase"],
  OUTCOME_APP_PROMOTION: ["mobile_app_install"],
  OUTCOME_AWARENESS: [],
};
export const FALLBACK_ACTIONS = ["lead", "onsite_conversion.messaging_conversation_started_7d", "link_click"];

export type ActionValue = { action_type?: string; value?: string };

export function parseCount(value: unknown): number {
  const n = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 2_147_483_647) : 0;
}

export function pickResults(objective: string | undefined, actions: ActionValue[] | undefined): { results: number; actionType: string | null } {
  const list = objective && objective in RESULT_ACTIONS ? RESULT_ACTIONS[objective] : FALLBACK_ACTIONS;
  for (const type of list) {
    const found = actions?.find((a) => a.action_type === type);
    const n = parseCount(found?.value);
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
