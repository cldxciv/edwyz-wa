/**
 * Audience events and retention bounds (docs/IG-PAGE-ADS-SPEC.md 3.7, 4.2 A1, D17). Pure data plus clamping helpers;
 * promote/audiences (PRM-11) builds the Meta rule. Event names are VERIFY V-P8.
 */
import type { VerifyState } from "../types";
import { verifyStateOf } from "./verified";

export type AudienceEventKind = "engagement_instagram" | "engagement_page" | "engagement_lead_form" | "website";
export type EventSourceType = "ig_business" | "page" | "lead" | "pixel";

export type AudienceEventRow = {
  /** Catalog id, also the verified.ts key suffix. */
  id: string;
  kind: AudienceEventKind;
  sourceType: EventSourceType;
  /** Meta's filter value for `field: 'event'`; null for website rules, which filter on the URL. */
  event: string | null;
  defaultDays: number;
  maxDays: number;
  /** The rule is built with prefill: 1 (people from before the audience existed are included). */
  prefill: boolean;
  verify: VerifyState;
};

const row = (id: string, kind: AudienceEventKind, sourceType: EventSourceType, event: string | null, defaultDays: number, maxDays: number): AudienceEventRow => ({
  id,
  kind,
  sourceType,
  event,
  defaultDays,
  maxDays,
  prefill: true,
  verify: verifyStateOf(`audience_event.${id}`),
});

/** People who engaged (365 days by default, up to 730), lead forms (up to 90), website visitors (30 by default, up to 180). */
export const AUDIENCE_EVENTS: readonly AudienceEventRow[] = [
  row("ig_all", "engagement_instagram", "ig_business", "ig_business_profile_all", 365, 730),
  row("ig_messaged", "engagement_instagram", "ig_business", "ig_user_messaged_business", 365, 730),
  row("page_engaged", "engagement_page", "page", "page_engaged", 365, 730),
  row("page_messaged", "engagement_page", "page", "page_messaged", 365, 730),
  row("lead_opened", "engagement_lead_form", "lead", "lead_generation_opened", 90, 90),
  row("lead_submitted", "engagement_lead_form", "lead", "lead_generation_submitted", 90, 90),
  row("website_all", "website", "pixel", null, 30, 180),
  row("website_url", "website", "pixel", null, 30, 180),
];

export const DAY_SECONDS = 86_400;

/** Customer lists and lookalike seeds need at least 100 people; uploads go at most 10,000 rows a request (D17, A2). */
export const MIN_AUDIENCE_PEOPLE = 100;
export const MAX_UPLOAD_ROWS = 10_000;
/** At most 50 customer-list audiences per workspace (5.5). */
export const MAX_CUSTOMER_LISTS = 50;

/** Lookalikes: India, 1% to 10% (1% = most similar), seed at least 100, never for special categories (3.7). */
export const LOOKALIKE = Object.freeze({ country: "IN", minPercent: 1, maxPercent: 10, minSeed: MIN_AUDIENCE_PEOPLE });

/** The bounds of a kind of audience event, in days. */
export function retentionBounds(kind: AudienceEventKind): { defaultDays: number; maxDays: number } {
  const r = AUDIENCE_EVENTS.find((e) => e.kind === kind)!;
  return { defaultDays: r.defaultDays, maxDays: r.maxDays };
}

/** retention_seconds for a kind: the default when unset, refused (RangeError) outside 1 day .. the maximum. */
export function retentionSeconds(kind: AudienceEventKind, days?: number | null): number {
  const { defaultDays, maxDays } = retentionBounds(kind);
  const d = days ?? defaultDays;
  if (!Number.isInteger(d) || d < 1 || d > maxDays) throw new RangeError(`Retention must be 1 to ${maxDays} days.`);
  return d * DAY_SECONDS;
}

/** Lookalike ratio for a whole percent (1..10): 0.01 .. 0.1. */
export function lookalikeRatio(percent: number): number {
  if (!Number.isInteger(percent) || percent < LOOKALIKE.minPercent || percent > LOOKALIKE.maxPercent) throw new RangeError("Pick 1% to 10%.");
  return percent / 100;
}
