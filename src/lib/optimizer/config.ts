import { getCaps } from "@/lib/ads/caps";
import { prisma } from "@/lib/db";
import { inrEquivalentMinor } from "@/lib/spend/breakers/ads";
import { readFx, type FxTable } from "@/lib/spend/fx";
import { HttpError } from "@/lib/tenancy";

export type OptimizerConfig = {
  enabled: boolean;
  windowDays: number;
  /** Ads with less spend than this in the window are never judged (in the account currency's smallest unit). */
  minSpendMinor: number;
  /** Pause when cost per result exceeds the campaign average by this multiple. */
  cprMultiple: number;
  /** Pause when an ad spent at least this much with zero results (in the account currency's smallest unit). */
  zeroResultSpendMinor: number;
  /** Largest share of an ad set's daily budget a single proposal may move. */
  maxShiftPct: number;
  /** The worst ad set must cost at least this multiple of the best before budget moves. */
  shiftCprRatio: number;
  /** No ad set budget may be reduced below this (in the account currency's smallest unit). */
  minAdSetBudgetMinor: number;
  frequencyThreshold: number;
  /** Relative CTR fall (percent) between the earlier and recent half of the window. */
  ctrDropPct: number;
  minImpressions: number;
  /** An ad is a winner when its cost per result is at most this fraction of the campaign average. */
  winnerCprRatio: number;
  minWinners: number;
  /**
   * Kept so the settings form keeps working; suggestions now expire after `expireHours` (docs/SPEND-CONTROLS-SPEC.md 7.3:
   * "expiry moves from days to hours"), the same clock as a spending request.
   */
  expireDays: number;
  /** A suggestion nobody answered expires after this many hours (1-48, default 12, like a spending request). */
  expireHours: number;
  revertDays: number;
};

/** The defaults, in INR (paise). Other currencies get them converted (defaultsFor). */
export const DEFAULT_OPTIMIZER_CONFIG: OptimizerConfig = {
  enabled: true,
  windowDays: 7,
  minSpendMinor: 50_000,
  cprMultiple: 2,
  zeroResultSpendMinor: 100_000,
  maxShiftPct: 20,
  shiftCprRatio: 1.5,
  minAdSetBudgetMinor: 10_000,
  frequencyThreshold: 3,
  ctrDropPct: 20,
  minImpressions: 500,
  winnerCprRatio: 0.8,
  minWinners: 2,
  expireDays: 7,
  expireHours: 12,
  revertDays: 14,
};

type Bound = { min: number; max: number; int?: boolean };
const BOUNDS: Record<Exclude<keyof OptimizerConfig, "enabled">, Bound> = {
  windowDays: { min: 3, max: 30, int: true },
  minSpendMinor: { min: 0, max: 100_000_000, int: true },
  cprMultiple: { min: 1.1, max: 20 },
  zeroResultSpendMinor: { min: 0, max: 100_000_000, int: true },
  maxShiftPct: { min: 1, max: 20 },
  shiftCprRatio: { min: 1.1, max: 20 },
  minAdSetBudgetMinor: { min: 0, max: 100_000_000, int: true },
  frequencyThreshold: { min: 1, max: 20 },
  ctrDropPct: { min: 1, max: 95 },
  minImpressions: { min: 0, max: 10_000_000, int: true },
  winnerCprRatio: { min: 0.1, max: 1 },
  minWinners: { min: 1, max: 20, int: true },
  expireDays: { min: 1, max: 30, int: true },
  expireHours: { min: 1, max: 48, int: true },
  revertDays: { min: 1, max: 60, int: true },
};

/** The money thresholds that are amounts (converted per currency); the others are ratios and counts. */
const MONEY_KEYS = ["minSpendMinor", "zeroResultSpendMinor", "minAdSetBudgetMinor"] as const;

export const settingsKey = (tenantId: string) => `optimizer:${tenantId}`;

/**
 * The defaults in the ad account's currency (7.3: "thresholds in config.ts become currency-aware"): the INR amounts are
 * converted with the admin's fresh exchange rate, else rescaled to the currency's exponent (same number of whole units).
 */
export function defaultsFor(currency: string | null | undefined, fx: FxTable | null = null, now: Date = new Date()): OptimizerConfig {
  const cur = (currency ?? "INR").toUpperCase();
  if (cur === "INR") return { ...DEFAULT_OPTIMIZER_CONFIG };
  const out: OptimizerConfig = { ...DEFAULT_OPTIMIZER_CONFIG };
  for (const key of MONEY_KEYS) {
    const v = inrEquivalentMinor(BigInt(DEFAULT_OPTIMIZER_CONFIG[key]), cur, fx, now);
    out[key] = Number(v > BigInt(BOUNDS[key].max) ? BigInt(BOUNDS[key].max) : v);
  }
  return out;
}

/** Merges untrusted overrides over the defaults; unknown or invalid keys are dropped. maxShiftPct can never exceed 20. */
export function sanitizeConfig(raw: unknown, defaults: OptimizerConfig = DEFAULT_OPTIMIZER_CONFIG): OptimizerConfig {
  const out: OptimizerConfig = { ...defaults };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const src = raw as Record<string, unknown>;
  if (typeof src.enabled === "boolean") out.enabled = src.enabled;
  for (const [key, b] of Object.entries(BOUNDS)) {
    const v = src[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < b.min || v > b.max || (b.int && !Number.isInteger(v))) continue;
    (out as Record<string, number | boolean>)[key] = v;
  }
  return out;
}

/** Strict version for the settings API: rejects bad values instead of dropping them. */
export function parseConfigInput(raw: Record<string, unknown>): Partial<OptimizerConfig> {
  const out: Partial<OptimizerConfig> = {};
  for (const [key, v] of Object.entries(raw)) {
    if (key === "enabled") {
      if (typeof v !== "boolean") throw new HttpError(400, "enabled must be true or false.");
      out.enabled = v;
      continue;
    }
    const b = BOUNDS[key as keyof typeof BOUNDS];
    if (!b) throw new HttpError(400, `Unknown setting ${key.slice(0, 40)}.`);
    if (typeof v !== "number" || !Number.isFinite(v) || v < b.min || v > b.max || (b.int && !Number.isInteger(v))) {
      throw new HttpError(400, `${key} must be ${b.int ? "a whole number" : "a number"} between ${b.min} and ${b.max}.`);
    }
    (out as Record<string, number>)[key] = v;
  }
  return out;
}

/**
 * The workspace's optimizer settings. With `currency` (the ad account's), the defaults it has not overridden are converted
 * from INR; without one they stay in INR, as before.
 */
export async function getOptimizerConfig(tenantId: string, opts: { currency?: string | null; now?: Date } = {}): Promise<OptimizerConfig> {
  const row = await prisma.platformSetting.findUnique({ where: { key: settingsKey(tenantId) } });
  const cur = (opts.currency ?? "INR").toUpperCase();
  let defaults = DEFAULT_OPTIMIZER_CONFIG;
  if (cur !== "INR") {
    let fx: FxTable | null = null;
    try {
      fx = await readFx();
    } catch {
      fx = null;
    }
    defaults = defaultsFor(cur, fx, opts.now);
  }
  return sanitizeConfig(row?.value, defaults);
}

export async function saveOptimizerConfig(tenantId: string, patch: Partial<OptimizerConfig>): Promise<OptimizerConfig> {
  const next = sanitizeConfig({ ...(await getOptimizerConfig(tenantId)), ...patch });
  await prisma.platformSetting.upsert({
    where: { key: settingsKey(tenantId) },
    create: { key: settingsKey(tenantId), value: next },
    update: { value: next },
  });
  return next;
}

/**
 * The workspace daily budget cap (ads:caps:<tenantId>, lowered by the platform ceiling), in the account currency's smallest
 * unit. It limits the SUM of all active campaigns, not one ad set. Null means unconfigured: nothing may be applied.
 */
export async function getBudgetCap(tenantId: string): Promise<number | null> {
  return (await getCaps(tenantId)).maxDailyBudgetMinor;
}
