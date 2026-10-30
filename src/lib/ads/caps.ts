import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/tenancy";
import { defaultPotCurrency, getAllowance, setAllowances, type AllowancePatch } from "@/lib/spend/allowances";
import { adsHeadroomDetail } from "@/lib/spend/book";
import { SpendBlockedError } from "@/lib/spend/errors";
import { withSpendLock } from "@/lib/spend/lock";
import { formatMinor as formatMoney } from "@/lib/spend/money";
import type { SpendActor } from "@/lib/spend/types";
import { ceil175, maxDailyBudgetWithin } from "@/lib/spend/worstcase";
import { currencyExponent } from "./insights-money";

/*
 * Shims over the Spend Book (docs/SPEND-CONTROLS-SPEC.md 4.8, WP-06). Phase 1 deletes them.
 *
 * The number these functions speak in keeps its OLD meaning, "the most your daily budgets may add up to" (C). The book stores
 * the worst case instead: the ads daily limit L = ceil175(C), because Meta can spend up to 75% over a daily budget on a busy
 * day. So:
 * - setCaps(C) writes the ads daily limit through allowances.ts (the per-field owner rule, a ledger row) as ceil175(C), and
 *   keeps the legacy `ads:caps:<tenant>` key in step so a rollback to the previous build reads the same number;
 * - getCaps() reads the SpendAllowance ads daily limit and answers floor(4L/7): the largest C with ceil175(C) <= L, so a value
 *   round-trips exactly (PUT C then GET gives C). Before an allowance row exists it falls back to the legacy key;
 * - assertWithinCap() keeps today's single-campaign check and wording; assertWithinWorkspaceCap() asks the book's headroom;
 *   withCapLock() is the book's spend lock.
 */

export type AdCaps = { maxDailyBudgetMinor: number | null; currency: string | null; exponent: number | null };

const capKey = (tenantId: string) => `ads:caps:${tenantId}`;

function envCap(): number | null {
  const n = Number(process.env.MAX_DAILY_BUDGET_MINOR);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const positiveInt = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
export const isCurrencyCode = (v: unknown): v is string => typeof v === "string" && /^[A-Z]{3}$/.test(v);
const toSafeNumber = (v: bigint): number => (v > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(v));

/** The deprecated platform ceiling (MAX_DAILY_BUDGET_MINOR) lowers the number, as before. */
function withEnvCeiling(caps: AdCaps): AdCaps {
  const ceiling = envCap();
  if (caps.maxDailyBudgetMinor === null || ceiling === null) return caps;
  return { ...caps, maxDailyBudgetMinor: Math.min(caps.maxDailyBudgetMinor, ceiling) };
}

/** The pre-0009 cap row, rescaled when the exponent table changed since it was saved. Only read while no allowance row exists. */
async function legacyCaps(tenantId: string): Promise<AdCaps> {
  const row = await prisma.platformSetting.findUnique({ where: { key: capKey(tenantId) } });
  const value = (row?.value ?? {}) as { maxDailyBudgetMinor?: unknown; currency?: unknown; exponent?: unknown };
  const currency = isCurrencyCode(value.currency) ? value.currency : null;
  const exponent = currency ? currencyExponent(currency) : null;
  const stored = typeof value.exponent === "number" && Number.isInteger(value.exponent) && value.exponent >= 0 && value.exponent <= 3 ? value.exponent : null;
  let workspace = positiveInt(value.maxDailyBudgetMinor);
  if (workspace !== null && exponent !== null && stored !== null && stored !== exponent) {
    workspace = Math.floor(workspace * 10 ** (exponent - stored));
    if (workspace <= 0) workspace = null;
  }
  return { maxDailyBudgetMinor: workspace, currency, exponent };
}

/**
 * The most the workspace's daily budgets may add up to (C), in the old meaning: floor(4L/7) of the owner's ads daily limit L,
 * lowered by the deprecated platform ceiling MAX_DAILY_BUDGET_MINOR when that is set. Null when no daily limit is set (nothing
 * can launch). The number has ONE currency per workspace: campaigns in another currency are refused (assertWithinCap) rather
 * than converted. A legacy row without a currency is not a usable cap: an owner must save it again.
 */
export async function getCaps(tenantId: string): Promise<AdCaps> {
  const allowance = await getAllowance(tenantId, "ads");
  if (!allowance) return withEnvCeiling(await legacyCaps(tenantId));
  const currency = isCurrencyCode(allowance.currency) ? allowance.currency : null;
  const exponent = currency ? currencyExponent(currency) : null;
  const max = allowance.dailyLimitMinor === null ? null : toSafeNumber(maxDailyBudgetWithin(allowance.dailyLimitMinor));
  return withEnvCeiling({ maxDailyBudgetMinor: max, currency, exponent });
}

export function parseCapsInput(input: { maxDailyBudgetMinor: unknown; currency: unknown }): { max: number; currency: string } {
  const max = positiveInt(input.maxDailyBudgetMinor);
  if (max === null) throw new HttpError(400, "maxDailyBudgetMinor must be a positive whole number in minor units.");
  if (!isCurrencyCode(input.currency)) throw new HttpError(400, "currency must be a three-letter code such as INR.");
  return { max, currency: input.currency };
}

/**
 * The cap has ONE currency per workspace. Changing it while campaigns in another currency are active would drop their spend out of
 * the sum, so it is refused until those are paused or archived. Also called by the route before it writes its audit row.
 */
export async function assertCapCurrencyChangeable(tenantId: string, currency: string): Promise<void> {
  const other = await prisma.adCampaign.findMany({ where: { tenantId, status: "active", currency: { not: currency } }, select: { id: true } });
  if ((other ?? []).length > 0) {
    throw new HttpError(409, `${other.length} active campaign(s) use a different currency than ${currency}. Pause or archive them before changing the cap currency, otherwise their spend would no longer count against the cap.`);
  }
}

/**
 * Stores C as the ads daily limit ceil175(C), through allowances.ts: the owner rule (only the owner raises), the optimistic
 * version and a ledger row. A currency change clears the monthly limit to Not set, because nothing is converted silently
 * (3.1); the owner sets it again in Settings > Spending limits. The legacy key is written too, so the previous build reads
 * the same number after a rollback.
 */
export async function setCaps(tenantId: string, input: { maxDailyBudgetMinor: unknown; currency: unknown }, actor: SpendActor): Promise<AdCaps> {
  const { max, currency } = parseCapsInput(input);
  await assertCapCurrencyChangeable(tenantId, currency);
  const row = await getAllowance(tenantId, "ads");
  const current = row?.currency ?? (await defaultPotCurrency(tenantId, "ads"));
  const patch: AllowancePatch = { pot: "ads", dailyLimitMinor: ceil175(BigInt(max)), currency };
  if (current !== currency) patch.monthlyLimitMinor = null;
  const reason = `Up to ${formatMoney(BigInt(max), currency)} a day in ad budgets. Meta can spend 75% more on a busy day, so the daily ads limit is ${formatMoney(patch.dailyLimitMinor!, currency)}.`;
  await setAllowances(tenantId, patch, actor, row?.version ?? 0, { reason });
  const value = { maxDailyBudgetMinor: max, currency, exponent: currencyExponent(currency) };
  try {
    await prisma.platformSetting.upsert({ where: { key: capKey(tenantId) }, create: { key: capKey(tenantId), value }, update: { value } });
  } catch {
    // The allowance is the record; the legacy key only serves a rollback.
    console.error("[ads] legacy cap key not updated", tenantId);
  }
  return getCaps(tenantId);
}

export function formatMinor(minor: number, currency: string): string {
  const exp = currencyExponent(currency);
  return `${(minor / 10 ** exp).toFixed(exp)} ${currency}`;
}

/** Throws unless a cap exists with a known currency, the currency matches and the amount is within it. Single-campaign check; use assertWithinWorkspaceCap for anything that starts spending. */
export async function assertWithinCap(tenantId: string, totalDailyMinor: number, currency: string): Promise<AdCaps> {
  if (!Number.isInteger(totalDailyMinor) || totalDailyMinor <= 0) throw new HttpError(400, "The daily budget must be a positive whole number in minor units.");
  const caps = await assertCapApplies(tenantId, currency);
  if (totalDailyMinor > caps.maxDailyBudgetMinor!) {
    throw new HttpError(409, `The daily budget ${formatMinor(totalDailyMinor, currency)} exceeds the cap of ${formatMinor(caps.maxDailyBudgetMinor!, currency)}.`);
  }
  return caps;
}

/** Throws unless a cap exists in this currency (for a campaign with no daily budget, a lifetime budget only). */
export async function assertCapApplies(tenantId: string, currency: string): Promise<AdCaps> {
  const caps = await getCaps(tenantId);
  if (caps.maxDailyBudgetMinor === null) throw new HttpError(409, "No daily budget cap is set. An owner must set a cap in ad settings before anything can launch.");
  if (!caps.currency) throw new HttpError(409, "The budget cap has no currency. An owner must save the cap again in ad settings.");
  if (caps.currency !== currency) throw new HttpError(409, `The budget cap is set in ${caps.currency} but this campaign uses ${currency}.`);
  return caps;
}

/** Meta stops delivering at the schedule end; allow for clock skew before a finished campaign stops counting. */
const ENDED_GRACE_MS = 15 * 60_000;

/**
 * Sum of the daily budgets of every campaign of the workspace in this currency that is marked active and whose schedule has not
 * ended, optionally leaving one out. A nominal figure for display only: the book counts running ads at their worst case.
 */
export async function workspaceActiveBudget(tenantId: string, currency: string | null, excludeCampaignId?: string, now = Date.now()): Promise<number> {
  const rows = await prisma.adCampaign.findMany({
    where: { tenantId, status: "active", ...(currency ? { currency } : {}), ...(excludeCampaignId ? { id: { not: excludeCampaignId } } : {}) },
    select: { id: true, dailyBudgetMinor: true, endsAt: true, adSets: { select: { dailyBudgetMinor: true } } },
  });
  return (rows ?? [])
    .filter((c) => !(c.endsAt instanceof Date && c.endsAt.getTime() + ENDED_GRACE_MS < now))
    .reduce((sum, c) => sum + (c.adSets.length ? c.adSets.reduce((s, a) => s + (a.dailyBudgetMinor ?? c.dailyBudgetMinor), 0) : c.dailyBudgetMinor), 0);
}

/**
 * The book's spend lock for the workspace's ads pot (cross-process, lock_timeout 3 s). Keep the callback to database work:
 * never a Meta call while it is held (I10). Raises no longer need it: reserveAds takes it itself.
 */
export async function withCapLock<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return withSpendLock(tenantId, "ads", () => fn());
}

/**
 * The single-campaign check, then the book's headroom: the campaign's worst case today (1.75x its daily budgets) must fit
 * what is left of today's ads limit. Pass the campaign's own id so its own running worst case is not counted twice. The
 * refusal is the book's copy, with what is left and what the campaign needs.
 */
export async function assertWithinWorkspaceCap(tenantId: string, totalDailyMinor: number, currency: string, campaignId?: string): Promise<AdCaps> {
  const caps = await assertWithinCap(tenantId, totalDailyMinor, currency);
  const { headroom, figures } = await adsHeadroomDetail(tenantId, { currency, fresh: true });
  if (headroom.today.left === null) return caps;
  const own = campaignId ? figures.perCommitment.filter((f) => f.campaignId === campaignId).reduce((s, f) => s + f.dayRisk, 0n) : 0n;
  const left = headroom.today.left + own;
  const needs = ceil175(BigInt(totalDailyMinor));
  if (needs > left) throw new SpendBlockedError("spend.daily_limit", { left: { minor: left, currency }, needs: { minor: needs, currency } });
  return caps;
}
