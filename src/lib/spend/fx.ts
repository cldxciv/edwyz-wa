/**
 * Exchange rates for limits (docs/SPEND-CONTROLS-SPEC.md 3.1, 3.4, 4.4, 8.3). PlatformSetting 'spend:fx' holds INR-per-unit
 * rates a platform admin enters:
 *   {base: 'INR', rates: {USD: '84.10', ...}, rateUpdatedAt: {USD: '<iso>'}, updatedAt: '<iso>', byUserId}
 * (rateUpdatedAt is optional; without it a rate is as old as the table's updatedAt, the shape the spec shows).
 *
 * A ceiling in currency X is used in this order: a SpendCeiling row in X; the INR row converted at a rate no older than 35
 * days, rounded DOWN; otherwise UNKNOWN. A rate older than 35 days counts as missing. All maths is exact integer arithmetic.
 */
import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/tenancy";
import { applyLedgered, PLATFORM_LEDGER_TENANT, requirePlatformAdmin, requireReason, type SpendDb } from "./control";
import { CRD, currencyExponent, isCurrencyCode } from "./money";
import type { SpendActor } from "./types";

export const FX_KEY = "spend:fx";
export const FX_BASE = "INR";
/** A rate older than this counts as missing (2.2). Exactly 35 days old is still fresh. */
export const FX_MAX_AGE_DAYS = 35;
const DAY_MS = 86_400_000;

export type FxRate = { currency: string; rate: string; updatedAt: Date | null };
export type FxTable = { base: "INR"; rates: Record<string, FxRate>; updatedAt: Date | null; byUserId: string | null };

const RATE = /^\d{1,12}(?:\.\d{1,10})?$/;

function toDate(v: unknown): Date | null {
  if (typeof v !== "string" && !(v instanceof Date)) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Parses a positive decimal rate ("84.10") into numerator and decimal scale (8410n, 2). Null for anything else or zero. */
export function parseRate(text: unknown): { num: bigint; scale: number } | null {
  if (typeof text !== "string" && typeof text !== "number") return null;
  const s = String(text).trim();
  if (!RATE.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const num = BigInt(whole + frac);
  return num > 0n ? { num, scale: frac.length } : null;
}

/** Reads the stored value leniently: unknown currencies, bad rates and bad dates are dropped, never guessed. */
export function parseFxTable(value: unknown): FxTable {
  const v = (value && typeof value === "object" ? value : {}) as { rates?: unknown; rateUpdatedAt?: unknown; updatedAt?: unknown; byUserId?: unknown };
  const tableAt = toDate(v.updatedAt);
  const perRate = (v.rateUpdatedAt && typeof v.rateUpdatedAt === "object" ? v.rateUpdatedAt : {}) as Record<string, unknown>;
  const rates: Record<string, FxRate> = {};
  if (v.rates && typeof v.rates === "object") {
    for (const [currency, raw] of Object.entries(v.rates as Record<string, unknown>)) {
      if (!isCurrencyCode(currency) || currency === FX_BASE || currency === CRD) continue;
      // Also accepts {rate, updatedAt} per currency.
      const entry = raw && typeof raw === "object" ? (raw as { rate?: unknown; updatedAt?: unknown }) : { rate: raw };
      if (!parseRate(entry.rate)) continue;
      rates[currency] = { currency, rate: String(entry.rate).trim(), updatedAt: toDate(entry.updatedAt) ?? toDate(perRate[currency]) ?? tableAt };
    }
  }
  return { base: "INR", rates, updatedAt: tableAt, byUserId: typeof v.byUserId === "string" ? v.byUserId : null };
}

export async function readFx(db: SpendDb = prisma): Promise<FxTable> {
  const row = (await db.platformSetting.findUnique({ where: { key: FX_KEY } })) as { value?: unknown } | null;
  return parseFxTable(row?.value);
}

/** True when the rate was updated at most 35 days before `now`. A rate with no date is never fresh. */
export function isRateFresh(updatedAt: Date | null, now: Date = new Date()): boolean {
  if (!updatedAt) return false;
  return now.getTime() - updatedAt.getTime() <= FX_MAX_AGE_DAYS * DAY_MS;
}

/** The fresh INR-per-unit rate for the currency, or null when it is missing or out of date. */
export function freshRate(table: FxTable, currency: string, now: Date = new Date()): FxRate | null {
  const rate = table.rates[currency.toUpperCase()];
  return rate && isRateFresh(rate.updatedAt, now) ? rate : null;
}

/**
 * Converts INR minor units (paise) into minor units of `currency`, rounded DOWN (a ceiling never grows by conversion).
 * INR is returned unchanged. Null when there is no fresh rate, and always for CRD (credits have no exchange rate).
 *   minorX = floor(paise x 10^expX x 10^scale / (10^expINR x rateNum))
 */
export function convertFromInr(inrMinor: bigint, currency: string, table: FxTable, now: Date = new Date()): bigint | null {
  const code = currency.toUpperCase();
  if (code === FX_BASE) return inrMinor;
  if (code === CRD || !isCurrencyCode(code)) return null;
  const rate = freshRate(table, code, now);
  const parsed = rate ? parseRate(rate.rate) : null;
  if (!parsed) return null;
  const numerator = inrMinor * 10n ** BigInt(currencyExponent(code)) * 10n ** BigInt(parsed.scale);
  const denominator = 10n ** BigInt(currencyExponent(FX_BASE)) * parsed.num;
  if (numerator <= 0n) return numerator === 0n ? 0n : -((-numerator + denominator - 1n) / denominator);
  return numerator / denominator;
}

/** Every rate with its freshness, for the admin form ("Out of date" when older than 35 days). */
export function listFxRates(table: FxTable, now: Date = new Date()): (FxRate & { fresh: boolean })[] {
  return Object.values(table.rates)
    .sort((a, b) => a.currency.localeCompare(b.currency))
    .map((r) => ({ ...r, fresh: isRateFresh(r.updatedAt, now) }));
}

export type FxPatch = Record<string, string | null>;

/**
 * Platform admin: sets or removes rates (null removes one). Every written rate gets today's date. Ledgered as `fx.change`
 * on the platform ledger, with the previous rates as the undo recipe.
 */
export async function setFxRates(patch: FxPatch, actor: SpendActor, reason: string, opts: { db?: SpendDb; now?: Date } = {}): Promise<FxTable> {
  requirePlatformAdmin(actor);
  const why = requireReason(reason);
  const now = opts.now ?? new Date();
  const entries = Object.entries(patch ?? {});
  if (entries.length === 0) throw new HttpError(400, "Enter at least one exchange rate.");
  for (const [currency, rate] of entries) {
    if (!isCurrencyCode(currency) || currency === FX_BASE || currency === CRD) throw new HttpError(400, "Use a three-letter currency code other than INR, such as USD.");
    if (rate !== null && !parseRate(rate)) throw new HttpError(400, `Enter the ${currency} rate as INR for one ${currency}, for example 84.10.`);
  }
  const { result } = await applyLedgered(opts.db, async (tx) => {
    const before = await readFx(tx);
    const rates: Record<string, string> = {};
    const rateUpdatedAt: Record<string, string> = {};
    for (const r of Object.values(before.rates)) {
      rates[r.currency] = r.rate;
      if (r.updatedAt) rateUpdatedAt[r.currency] = r.updatedAt.toISOString();
    }
    for (const [currency, rate] of entries) {
      if (rate === null) {
        delete rates[currency];
        delete rateUpdatedAt[currency];
      } else {
        rates[currency] = rate.trim();
        rateUpdatedAt[currency] = now.toISOString();
      }
    }
    const value = { base: FX_BASE, rates, rateUpdatedAt, updatedAt: now.toISOString(), byUserId: actor.userId };
    await tx.platformSetting.upsert({ where: { key: FX_KEY }, create: { key: FX_KEY, value }, update: { value } });
    const previous = Object.fromEntries(Object.values(before.rates).map((r) => [r.currency, r.rate]));
    return {
      result: parseFxTable(value),
      row: {
        tenantId: PLATFORM_LEDGER_TENANT,
        pot: "none",
        action: "fx.change",
        actor,
        reason: why,
        before: { rates: previous },
        after: { rates: Object.fromEntries(entries) },
        undo: { action: "set_fx_rates", rates: Object.fromEntries(entries.map(([c]) => [c, previous[c] ?? null])) },
      },
    };
  });
  return result;
}
