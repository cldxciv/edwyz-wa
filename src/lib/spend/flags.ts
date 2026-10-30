/**
 * Rollout flags of the spend controls (docs/SPEND-CONTROLS-SPEC.md 4.14). Read on every call, so a test or an env change
 * takes effect without a restart. src/lib/env-rules.mjs validates the values at startup; here an unknown value falls back to
 * the default, and the defaults are the train 1 values:
 *   SPEND_ENFORCE=observe, SPEND_TRIPWIRE=report, SPEND_CAP_MODE=off, ASSISTANT_SPEND_ENABLED=false.
 */
import type { EnforceMode, SpendCapMode, TripwireMode } from "./types";

type Env = Record<string, string | undefined>;

const read = (env: Env, key: string): string => (env[key] ?? "").trim().toLowerCase();
const isOn = (value: string): boolean => value === "1" || value === "true" || value === "yes" || value === "on";

/** Human paths only: observe lets a NEW Phase 0 check through and records a would-refuse row (I12). Assistants are always enforced. */
export function spendEnforceMode(env: Env = process.env): EnforceMode {
  return read(env, "SPEND_ENFORCE") === "enforce" ? "enforce" : "observe";
}

/** The transport tripwire (4.7): report logs and audits a bypass; enforce throws before any network I/O. */
export function spendTripwireMode(env: Env = process.env): TripwireMode {
  return read(env, "SPEND_TRIPWIRE") === "enforce" ? "enforce" : "report";
}

/** Wall (a), Meta's own spending limit: off, observe (compute and write info rows, no POST) or enforce (after runbook V1-V9). */
export function spendCapMode(env: Env = process.env): SpendCapMode {
  const v = read(env, "SPEND_CAP_MODE");
  return v === "observe" || v === "enforce" ? v : "off";
}

/** While false, every assistant's effective level is 0 and shadow cannot end (10.5 gate). Only the exact value "true" turns it on. */
export function assistantSpendEnabled(env: Env = process.env): boolean {
  return read(env, "ASSISTANT_SPEND_ENABLED") === "true";
}

/** No Meta writes (fake ids). Never in production: env-rules refuses it there, and this returns false there as a second guard. */
export function spendDryRun(env: Env = process.env): boolean {
  if ((env.NODE_ENV ?? "").trim() === "production") return false;
  return isOn(read(env, "SPEND_DRY_RUN"));
}

/** Synthetic insights for sandbox ad accounts only (10.3). */
export function spendSim(env: Env = process.env): boolean {
  return isOn(read(env, "SPEND_SIM"));
}

let warnedLegacyCap = false;

/**
 * Deprecated MAX_DAILY_BUDGET_MINOR. When set to a positive whole number it is returned as bigint minor units of INR; the
 * ceilings code reads it as an INR platform daily ads ceiling of ceil175(value) (4.4). A one-time warning is logged.
 */
export function legacyMaxDailyBudgetMinor(env: Env = process.env, warn: (message: string) => void = console.warn): bigint | null {
  const raw = (env.MAX_DAILY_BUDGET_MINOR ?? "").trim();
  if (!raw || !/^\d{1,18}$/.test(raw) || BigInt(raw) <= 0n) return null;
  if (!warnedLegacyCap) {
    warnedLegacyCap = true;
    warn("[spend] MAX_DAILY_BUDGET_MINOR is deprecated. It is read as an INR platform daily ads ceiling (1.75 x the value). Set a platform ceiling in /admin/spending/settings instead.");
  }
  return BigInt(raw);
}

export type SpendFlags = {
  enforce: EnforceMode;
  tripwire: TripwireMode;
  capMode: SpendCapMode;
  assistantSpendEnabled: boolean;
  dryRun: boolean;
  sim: boolean;
  legacyMaxDailyBudgetMinor: bigint | null;
};

/** Every flag at once, for health pages and tests. */
export function spendFlags(env: Env = process.env): SpendFlags {
  return {
    enforce: spendEnforceMode(env),
    tripwire: spendTripwireMode(env),
    capMode: spendCapMode(env),
    assistantSpendEnabled: assistantSpendEnabled(env),
    dryRun: spendDryRun(env),
    sim: spendSim(env),
    legacyMaxDailyBudgetMinor: legacyMaxDailyBudgetMinor(env),
  };
}

/** Test hook: lets the deprecation warning fire again. */
export function resetFlagWarningsForTests(): void {
  warnedLegacyCap = false;
}
