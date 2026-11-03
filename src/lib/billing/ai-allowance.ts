/**
 * AI replies per hour by plan (owner decision 3, 2026-10-31): the pure rules, with no imports, so the admin plan form (a client
 * component) and the server share them.
 *
 * - Plan.features.aiRepliesPerHour (a whole number, 1 or more) is the plan's own value and always wins.
 * - Without it, the plan's code, then its name, decides: Starter 60, Growth 200, Agency 600 (and the trial allowance 60).
 * - A trial without a trial plan value, and a workspace with no plan, get 60 (src/lib/billing/ai-hourly.ts).
 * - AI_MAX_REPLIES_PER_HOUR is only the fallback when no plan value can be found (a plan with another code and no value, or the
 *   plan could not be read).
 *
 * 0 is never a plan value: an allowance of 0 would switch the AI agent off for a plan, and every module is on every plan
 * (owner decision 6). A 0, a fraction or text in the JSON is ignored and the defaults apply.
 */

export const AI_REPLIES_PER_HOUR_FEATURE = "aiRepliesPerHour";

/** The defaults by plan code or name. */
export const AI_REPLIES_PER_HOUR_BY_PLAN: Readonly<Record<"starter" | "growth" | "agency" | "trial", number>> = Object.freeze({
  starter: 60,
  growth: 200,
  agency: 600,
  trial: 60,
});

/** What a trial and a workspace with no plan get. */
export const BASE_AI_REPLIES_PER_HOUR = 60;

/** The highest value the admin form accepts. */
export const MAX_AI_REPLIES_PER_HOUR = 100_000;

/** A whole number from 1 to MAX_AI_REPLIES_PER_HOUR, or null. */
export function validRepliesPerHour(raw: unknown): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= MAX_AI_REPLIES_PER_HOUR ? raw : null;
}

/** Plan.features.aiRepliesPerHour when it is a usable value, otherwise null. */
export function featureRepliesPerHour(features: unknown): number | null {
  if (!features || typeof features !== "object" || Array.isArray(features)) return null;
  return validRepliesPerHour((features as Record<string, unknown>)[AI_REPLIES_PER_HOUR_FEATURE]);
}

const hasWord = (text: string, word: string) => new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(text.toLowerCase());

/** The default for a plan from its code, then its name ("starter-v2" and "Growth (copy)" count), or null for another plan. */
export function defaultRepliesPerHourFor(plan: { code?: string | null; name?: string | null }): number | null {
  for (const text of [plan.code, plan.name]) {
    if (!text) continue;
    for (const [word, value] of Object.entries(AI_REPLIES_PER_HOUR_BY_PLAN)) if (hasWord(text, word)) return value;
  }
  return null;
}

export type PlanRepliesPerHour = { value: number; from: "plan" | "plan_default" };

/** The plan's own value, else its code or name default, else null (then the platform fallback applies). */
export function planRepliesPerHour(plan: { code?: string | null; name?: string | null; features?: unknown } | null | undefined): PlanRepliesPerHour | null {
  if (!plan) return null;
  const own = featureRepliesPerHour(plan.features);
  if (own !== null) return { value: own, from: "plan" };
  const byName = defaultRepliesPerHourFor(plan);
  return byName !== null ? { value: byName, from: "plan_default" } : null;
}

/** What the admin form prefills: the plan's value, its code or name default, or 60. */
export function prefillRepliesPerHour(plan: { code?: string | null; name?: string | null; features?: unknown }): number {
  return planRepliesPerHour(plan)?.value ?? BASE_AI_REPLIES_PER_HOUR;
}

/** The features object without aiRepliesPerHour: the admin form shows that value in its own field. */
export function withoutRepliesPerHour(features: unknown): Record<string, unknown> {
  if (!features || typeof features !== "object" || Array.isArray(features)) return {};
  const { [AI_REPLIES_PER_HOUR_FEATURE]: _omit, ...rest } = features as Record<string, unknown>;
  void _omit;
  return rest;
}

/** The admin form's text for the field: "" is fine (the default applies), otherwise a whole number from 1 to 100,000. */
export function repliesPerHourProblem(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  return /^\d+$/.test(text) && validRepliesPerHour(Number(text)) !== null ? null : `Enter a whole number from 1 to ${MAX_AI_REPLIES_PER_HOUR.toLocaleString("en-IN")}, or leave empty for the plan's default.`;
}
