/**
 * Error copy of the spend controls (docs/SPEND-CONTROLS-SPEC.md 4.13, plus spend.demo from 8.4), shown verbatim by the API,
 * the UI and Eddy. Pure: no database, no network.
 *
 * Each code renders from parameters. Amounts always go through formatMinor with the currency exponent; with the spec's example
 * figures each line reproduces the 4.13 table word for word (tests/spend-copy.test.ts). A line whose figures are missing drops
 * the sentence that needs them rather than inventing a number. Copy never says "minor units", "spend_cap", "allowance pot",
 * "commitment" or "probation"; the UI says "new-workspace limits".
 */
import { formatMinor, type MinorInput } from "./money";
import { DEFAULT_TIMEZONE, resolveTimeZone } from "./periods";
import { PROBATION_CEILING_DEFAULTS } from "./types";

/** An amount with its currency, as the book computes it. */
export type CopyAmount = { minor: MinorInput; currency: string };

export type SpendCopyParams = {
  /** What is left of the limit (spend.daily_limit, spend.monthly_limit, spend.broadcast). */
  left?: CopyAmount;
  /** What the action could use at worst (spend.daily_limit, spend.monthly_limit). */
  needs?: CopyAmount;
  /** The estimated cost of a bulk send (spend.broadcast). */
  cost?: CopyAmount;
  /** New-workspace ceilings (spend.probation); default to the seeded INR 2,000 / 20,000. */
  daily?: CopyAmount;
  monthly?: CopyAmount;
  /** spend.currency: the ad account's currency and the currency the limits are in. */
  accountCurrency?: string;
  limitCurrency?: string;
  /** spend.meta_rate: when Meta allows the next budget change, shown in `timezone`. */
  retryAt?: Date | string;
  /** spend.messaging_limit, ai_quota: when the used-up period resets, shown in `timezone`. */
  resetsOn?: Date | string;
  /** Which period ran out (spend.messaging_limit, ai_quota) or which period a broadcast is measured against. */
  period?: "month" | "day";
  /** spend.meta_cap_too_low: minutes until a retry is worth it (default 20). */
  minutes?: number;
  timezone?: string;
};

/** Every code of the 4.13 table, plus spend.demo (8.4). */
export const SPEND_COPY_CODES = [
  "spend.daily_limit",
  "spend.monthly_limit",
  "spend.no_limit",
  "spend.frozen",
  "spend.platform_frozen",
  "spend.end_date_required",
  "spend.currency",
  "spend.not_spending_account",
  "spend.probation",
  "spend.meta_cap_too_low",
  "spend.meta_rate",
  "spend.broadcast",
  "spend.messaging_limit",
  "ai_quota",
  "spend.busy",
  "spend.only_owner_raise",
  "spend.version",
  "spend.demo",
] as const;
export type SpendCopyCode = (typeof SPEND_COPY_CODES)[number];

/** Words no spend copy may contain (4.13). */
export const BANNED_COPY_WORDS = ["minor units", "spend_cap", "allowance pot", "commitment", "probation"] as const;

const money = (a: CopyAmount): string => formatMinor(a.minor, a.currency);

function toDate(value: Date | string): Date | null {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "1 Nov" in the given zone. */
export function formatCopyDate(value: Date | string, timezone: string = DEFAULT_TIMEZONE): string | null {
  const d = toDate(value);
  if (!d) return null;
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: resolveTimeZone(timezone) }).format(d);
}

/** "3:40 pm" in the given zone. */
export function formatCopyTime(value: Date | string, timezone: string = DEFAULT_TIMEZONE): string | null {
  const d = toDate(value);
  if (!d) return null;
  return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: resolveTimeZone(timezone) })
    .format(d)
    .replace(/\s?(AM|PM)$/i, (m) => ` ${m.trim().toLowerCase()}`);
}

const join = (...parts: (string | null | false | undefined)[]) => parts.filter(Boolean).join(" ");

const RENDER: Record<SpendCopyCode, (p: SpendCopyParams) => string> = {
  "spend.daily_limit": (p) =>
    join(
      "This would go over your ads limit for today.",
      p.left && `Left today: ${money(p.left)}.`,
      p.needs && `This could spend up to ${money(p.needs)} today, because Meta can spend up to 75% over a daily budget.`,
      "Lower the daily budget or raise your limit.",
    ),
  "spend.monthly_limit": (p) =>
    join(
      "This would go over your ads limit for this month.",
      p.left && `Left this month: ${money(p.left)}.`,
      p.needs && `This campaign could use up to ${money(p.needs)} by its end date.`,
      "Lower the budget, choose an earlier end date, or raise your limit.",
    ),
  "spend.no_limit": () => "Set a daily ads limit in Settings > Spending limits before starting ads.",
  "spend.frozen": () => "Spending is stopped for this workspace. The owner can turn it back on in Settings > Spending limits.",
  // 12.1a decision 2: there is no SMTP, so this never promises an email. Owners hear back in the app and on WhatsApp.
  "spend.platform_frozen": () => "Edwyz has paused new spending for a short while. Running ads are paused. We'll tell you here and on WhatsApp when it's back.",
  "spend.end_date_required": () => "Ads started by an assistant need an end date.",
  "spend.currency": (p) =>
    p.accountCurrency && p.limitCurrency
      ? `This ad account uses ${p.accountCurrency}, but your limits are in ${p.limitCurrency}. Limits for ${p.accountCurrency} aren't set up yet.`
      : "This ad account uses a different currency from your limits. Limits for that currency aren't set up yet.",
  "spend.not_spending_account": () =>
    "Edwyz can spend from one ad account per workspace for now. Choose it in Settings > Spending limits.",
  "spend.probation": (p) => {
    const d = p.daily ?? { minor: PROBATION_CEILING_DEFAULTS.ads.dailyMinor ?? 0n, currency: PROBATION_CEILING_DEFAULTS.ads.currency };
    const m = p.monthly ?? { minor: PROBATION_CEILING_DEFAULTS.ads.monthlyMinor ?? 0n, currency: PROBATION_CEILING_DEFAULTS.ads.currency };
    return `New workspaces can spend up to ${money(d)} a day and ${money(m)} a month on ads for now.`;
  },
  "spend.meta_cap_too_low": (p) =>
    `Meta's spending limit on this ad account is close. We've asked Meta to raise it within your limits; try again in about ${p.minutes ?? 20} minutes.`,
  "spend.meta_rate": (p) => {
    const at = p.retryAt === undefined ? null : formatCopyTime(p.retryAt, p.timezone);
    return join("Meta allows only 4 budget changes an hour for each ad set.", at ? `Try again after ${at}.` : "Try again in an hour.");
  },
  "spend.broadcast": (p) => {
    const when = p.period === "day" ? "today" : "this month";
    if (p.cost && p.left)
      return `This broadcast could cost about ${money(p.cost)}, but only ${money(p.left)} is left in your WhatsApp limit ${when}. Send to fewer people or raise the limit.`;
    return `This broadcast could cost more than is left in your WhatsApp limit ${when}. Send to fewer people or raise the limit.`;
  },
  "spend.messaging_limit": (p) => {
    const day = p.period === "day";
    const date = !day && p.resetsOn !== undefined ? formatCopyDate(p.resetsOn, p.timezone) : null;
    const until = day ? "until it resets tomorrow" : date ? `until it resets on ${date}` : "until it resets";
    return `${day ? "Today's" : "This month's"} WhatsApp limit is used up. Automatic messages will wait ${until}, or raise the limit.`;
  },
  ai_quota: (p) => {
    const day = p.period === "day";
    const date = !day && p.resetsOn !== undefined ? formatCopyDate(p.resetsOn, p.timezone) : null;
    const until = day ? "until tomorrow" : date ? `until ${date}` : "until it resets";
    return `${day ? "Today's" : "This month's"} AI limit is used up. AI replies and suggestions are off ${until}. Your team can still reply.`;
  },
  "spend.busy": () => "Busy checking your limits. Try again in a moment.",
  "spend.only_owner_raise": () => "Only the owner can raise a limit. You can lower it.",
  "spend.version": () => "Someone else changed these limits. Reload to see the latest.",
  "spend.demo": () => "This is a demo workspace, so nothing can be spent.",
};

export function isSpendCopyCode(code: unknown): code is SpendCopyCode {
  return typeof code === "string" && (SPEND_COPY_CODES as readonly string[]).includes(code);
}

/** The plain sentence for a code, in English (Eddy translates the same codes in its own catalogue). */
export function spendCopy(code: SpendCopyCode, params: SpendCopyParams = {}): string {
  return RENDER[code](params);
}

/** True when the text contains one of the banned words (case-insensitive). */
export function containsBannedWord(text: string): string | null {
  const lower = text.toLowerCase();
  return BANNED_COPY_WORDS.find((w) => lower.includes(w)) ?? null;
}
