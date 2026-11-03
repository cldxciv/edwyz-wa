/*
 * Meta's ad review, as Edwyz keeps it (no schema change): the structure sync (src/lib/spend/sync/structure.ts) reads
 * act_X/ads?fields=id,effective_status,ad_review_feedback for the workspace's own campaigns and stores the result on the Ad
 * row, under creative.metaReview. Pure and client-safe: the campaign page reads the same shape to say "Meta is reviewing"
 * or "Not approved: <reason>".
 */

export type AdReviewState = "in_review" | "approved" | "rejected" | "issues" | "billing" | "removed" | "paused";

export type AdReview = {
  state: AdReviewState;
  /** Meta's effective_status as it was read, upper case. */
  metaStatus: string;
  /** Meta's own words for a rejection or a problem, at most three. */
  reasons: string[];
  /** When this state was first seen. */
  checkedAt: string;
};

export type MetaAdRead = { id: string; campaign_id?: string; effective_status?: string; ad_review_feedback?: unknown };

/** The fields the structure sync asks for. VERIFY: ad_review_feedback is { global: {...}, placement_specific: {...} }. */
export const AD_REVIEW_FIELDS = "id,campaign_id,effective_status,ad_review_feedback";

const STATE: Record<string, AdReviewState> = {
  PENDING_REVIEW: "in_review",
  IN_PROCESS: "in_review",
  DISAPPROVED: "rejected",
  WITH_ISSUES: "issues",
  PENDING_BILLING_INFO: "billing",
  DELETED: "removed",
  ARCHIVED: "removed",
  ACTIVE: "approved",
  PREAPPROVED: "approved",
  PAUSED: "paused",
  CAMPAIGN_PAUSED: "paused",
  ADSET_PAUSED: "paused",
};

const MAX_REASONS = 3;
const MAX_REASON_LENGTH = 300;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]+/g;

/** Every text value in Meta's feedback object (global and per placement), cleaned, without repeats. */
export function feedbackReasons(feedback: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown, depth: number) => {
    if (out.length >= MAX_REASONS || depth > 3) return;
    if (typeof v === "string") {
      const text = v.replace(CONTROL, " ").trim().slice(0, MAX_REASON_LENGTH);
      if (text && !out.includes(text)) out.push(text);
      return;
    }
    if (v && typeof v === "object" && !Array.isArray(v)) for (const value of Object.values(v as Record<string, unknown>)) visit(value, depth + 1);
  };
  visit(feedback, 0);
  return out;
}

/** Meta's answer for one ad in Edwyz's terms, or null when the status is unknown. */
export function reviewFromMeta(read: Pick<MetaAdRead, "effective_status" | "ad_review_feedback">, now: Date): AdReview | null {
  const metaStatus = typeof read.effective_status === "string" ? read.effective_status.trim().toUpperCase() : "";
  const state = STATE[metaStatus];
  if (!state) return null;
  const reasons = state === "rejected" || state === "issues" ? feedbackReasons(read.ad_review_feedback) : [];
  return { state, metaStatus, reasons, checkedAt: now.toISOString() };
}

/** The review stored on an Ad row's creative JSON, or null when none was read yet. */
export function readAdReview(creative: unknown): AdReview | null {
  const r = creative && typeof creative === "object" ? (creative as { metaReview?: unknown }).metaReview : null;
  if (!r || typeof r !== "object") return null;
  const v = r as Partial<AdReview>;
  if (typeof v.state !== "string" || !Object.values(STATE).includes(v.state as AdReviewState)) return null;
  return {
    state: v.state as AdReviewState,
    metaStatus: typeof v.metaStatus === "string" ? v.metaStatus : "",
    reasons: Array.isArray(v.reasons) ? v.reasons.filter((x): x is string => typeof x === "string").slice(0, MAX_REASONS) : [],
    checkedAt: typeof v.checkedAt === "string" ? v.checkedAt : "",
  };
}

/** True when the stored review says something different from a new read (the time it was read does not count). */
export function reviewChanged(before: AdReview | null, after: AdReview): boolean {
  return !before || before.state !== after.state || before.metaStatus !== after.metaStatus || before.reasons.join("\n") !== after.reasons.join("\n");
}

/** Meta's reason as a sentence that ends with a full stop. */
const sentence = (text: string) => text.replace(/[.!?]*$/, ".");

export type ReviewView = { label: string; tone: "good" | "warn" | "bad" | "info" | "neutral"; detail: string };

/** What the campaign page says about an ad's review. Null when there is nothing to say (paused, or not read yet). */
export function reviewView(review: AdReview | null): ReviewView | null {
  if (!review) return null;
  switch (review.state) {
    case "in_review":
      return { label: "Meta is reviewing", tone: "info", detail: "Meta checks every new or changed ad, usually within a day. It starts showing once it is approved." };
    case "rejected":
      return { label: "Not approved", tone: "bad", detail: `Not approved: ${review.reasons[0] ? sentence(review.reasons[0]) : "Meta did not give a reason."} Change the ad and create it again, or ask Meta for another review in Ads Manager.` };
    case "issues":
      return { label: "Has a problem", tone: "warn", detail: `Meta found a problem: ${review.reasons[0] ? sentence(review.reasons[0]) : "open the ad in Ads Manager to see it."}` };
    case "billing":
      return { label: "Waiting for payment details", tone: "warn", detail: "Add a payment method to the ad account in Meta Ads Manager. The ad starts once Meta can charge it." };
    case "approved":
      return { label: "Approved by Meta", tone: "good", detail: "Meta approved this ad." };
    case "removed":
      return { label: "Removed on Meta", tone: "neutral", detail: "This ad was deleted or archived on Meta." };
    default:
      return null;
  }
}
