/**
 * Wall (a), the plan (docs/SPEND-CONTROLS-SPEC.md 5.3, 5.4, 4.17). Pure: no database, no network, no clock of its own.
 *
 * - Target T: A + R under `cumulative` (or `unverified`) semantics, R under `resets_on_write`, where R = max(0, M - S) and
 *   S = this month's spend on the whole account. A customer's own lower cap wins (min). Because A and S grow together, T
 *   stays put while spend is tracked and Meta's room (T - A) shrinks on its own, with no change budget used.
 * - The change budget: Meta allows about 10 spending-limit changes a day. Every `requested` write in the last rolling 24 h
 *   counts (failed attempts too). Emergency writes while fewer than 10 are used, routine writes while fewer than 6 (4 kept
 *   for emergencies), and at most 2 routine raises. Reads never use the budget.
 * - Priorities: P0 stop (a pause failed, so the account itself must stop), P0 restore (the cap was raised or removed outside
 *   Edwyz), P1 lower (2-minute debounce), P2 rollover (the first write of a new account month), P3 raise (10-minute
 *   debounce). A change within the threshold is not worth a write.
 * - Locked and suspended workspaces (4.17): never a raise, P2 rollover waits; lowering and P0 still run.
 */
import { currencyExponent } from "../money";
import type { MetaCapPriority, MetaCapSemantics, MetaCapUnitMode, MetaSpendLimitMode } from "../types";

export const CHANGE_WINDOW_MS = 24 * 3_600_000;
/** Emergency writes are allowed while fewer than this many writes were requested in the rolling 24 h. */
export const EMERGENCY_WRITES_PER_WINDOW = 10;
/** Routine writes stop here, keeping 4 for emergencies. */
export const ROUTINE_WRITES_PER_WINDOW = 6;
/** At most this many routine raises per rolling 24 h. */
export const ROUTINE_RAISES_PER_WINDOW = 2;
export const P1_DEBOUNCE_MS = 2 * 60_000;
export const P3_DEBOUNCE_MS = 10 * 60_000;
/** Managed accounts with open commitments or spend this month are read this often (5.2). */
export const READ_ACTIVE_MS = 15 * 60_000;
/** Other managed accounts. */
export const READ_IDLE_MS = 6 * 3_600_000;
/** A 409 from getAssetAccess is retried this often (5.7). */
export const UNREACHABLE_RETRY_MS = 30 * 60_000;
/** Near the wall: Meta's room under 10% of the monthly limit (5.6). */
export const NEAR_WALL_PCT = 10n;
/** A floor Meta quotes is accepted when it is at most T + 10% of M (5.7). */
export const FLOOR_LOOSENESS_PCT = 10n;
/** While the cap is loose, raises stop once R is at most 15% of M (5.7). */
export const LOOSE_RAISE_STOP_PCT = 15n;
/** The INR equivalent the threshold never goes below (5.4): ₹100. */
export const THRESHOLD_FLOOR_INR_MINOR = 10_000n;

export type WriteClass = "emergency" | "routine" | "routine_raise";

const max0 = (x: bigint): bigint => (x < 0n ? 0n : x);
const maxB = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const minB = (a: bigint, b: bigint): bigint => (a < b ? a : b);

// =====================================================================================================================
// The stored state of one ad account (MetaSpendLimit)
// =====================================================================================================================

export type MetaCapRow = {
  adAccountAssetId: string;
  tenantId: string;
  accountExternalId: string;
  mode: MetaSpendLimitMode;
  consentId: string | null;
  unitMode: MetaCapUnitMode;
  semantics: MetaCapSemantics;
  /** The customer's own cap: at consent, or a lower one adopted since (5.6). On the current counter. */
  customerCapMinor: bigint | null;
  customerAmountSpentMinor: bigint | null;
  /** What Edwyz last wrote or adopted, as Meta read it back. */
  managedCapMinor: bigint | null;
  targetCapMinor: bigint | null;
  pendingTargetMinor: bigint | null;
  lastReadCapMinor: bigint | null;
  lastReadAmountSpentMinor: bigint | null;
  lastReadAt: Date | null;
  monthKey: string | null;
  monthStartAmountSpentMinor: bigint | null;
  spentAtLastWriteMinor: bigint | null;
  loosenessMinor: bigint | null;
  /** Earliest time the pending write may run (debounce or a used-up change budget). */
  deferredUntil: Date | null;
  writesBlockedUntil: Date | null;
  lastWriteAt: Date | null;
  lastError: string | null;
  currency: string | null;
  timezone: string | null;
  accountStatus: number | null;
  isPrepay: boolean | null;
  version: number;
};

const big = (v: unknown): bigint | null => (v === null || v === undefined ? null : typeof v === "bigint" ? v : BigInt(v as number | string));
const date = (v: unknown): Date | null => (v instanceof Date ? v : v ? new Date(String(v)) : null);
const MODES: readonly MetaSpendLimitMode[] = ["off", "pending_owner", "managed", "withdrawn", "unavailable_prepaid", "no_permission", "currency_mismatch", "sandbox", "error", "other_workspace"];

export function toMetaCapRow(raw: Record<string, unknown>): MetaCapRow {
  const mode = String(raw.mode ?? "off") as MetaSpendLimitMode;
  const unit = String(raw.unitMode ?? "unverified");
  const sem = String(raw.semantics ?? "unverified");
  return {
    adAccountAssetId: String(raw.adAccountAssetId),
    tenantId: String(raw.tenantId),
    accountExternalId: String(raw.accountExternalId ?? ""),
    mode: MODES.includes(mode) ? mode : "off",
    consentId: (raw.consentId as string | null) ?? null,
    unitMode: unit === "major_write" || unit === "minor_write" ? unit : "unverified",
    semantics: sem === "cumulative" || sem === "resets_on_write" ? sem : "unverified",
    customerCapMinor: big(raw.customerCapAtConsentMinor),
    customerAmountSpentMinor: big(raw.customerAmountSpentAtConsentMinor),
    managedCapMinor: big(raw.managedCapMinor),
    targetCapMinor: big(raw.targetCapMinor),
    pendingTargetMinor: big(raw.pendingTargetMinor),
    lastReadCapMinor: big(raw.lastReadCapMinor),
    lastReadAmountSpentMinor: big(raw.lastReadAmountSpentMinor),
    lastReadAt: date(raw.lastReadAt),
    monthKey: (raw.monthKey as string | null) ?? null,
    monthStartAmountSpentMinor: big(raw.monthStartAmountSpentMinor),
    spentAtLastWriteMinor: big(raw.spentAtLastWriteMinor),
    loosenessMinor: big(raw.loosenessMinor),
    deferredUntil: date(raw.deferredUntil),
    writesBlockedUntil: date(raw.writesBlockedUntil),
    lastWriteAt: date(raw.lastWriteAt),
    lastError: (raw.lastError as string | null) ?? null,
    currency: (raw.currency as string | null) ?? null,
    timezone: (raw.timezone as string | null) ?? null,
    accountStatus: raw.accountStatus === null || raw.accountStatus === undefined ? null : Number(raw.accountStatus),
    isPrepay: typeof raw.isPrepay === "boolean" ? raw.isPrepay : null,
    version: Number(raw.version ?? 1),
  };
}

// =====================================================================================================================
// Money helpers
// =====================================================================================================================

/** One major unit of the currency in minor units: the margin of a P0 stop (5.4). */
export function oneMajorUnit(currency: string | null | undefined): bigint {
  return 10n ** BigInt(currencyExponent(currency));
}

/** threshold = max(2% of M, half the effective daily ads limit, the INR 100 equivalent) (5.4). */
export function thresholdMinor(input: { monthlyMinor: bigint | null; dailyMinor: bigint | null; floorMinor: bigint }): bigint {
  const fromMonth = input.monthlyMinor !== null ? (input.monthlyMinor * 2n) / 100n : 0n;
  const fromDay = input.dailyMinor !== null ? input.dailyMinor / 2n : 0n;
  return maxB(maxB(fromMonth, fromDay), input.floorMinor);
}

/**
 * S, this month's spend on the whole account (5.3): the larger of the account's month-to-date insights and Meta's counter
 * since the month started. Under `resets_on_write` the counter restarts at every write, so S = spentAtLastWrite + A.
 * Null while S cannot be known yet (consent mid-month before the first fast sync).
 */
export function spentThisMonth(input: {
  semantics: MetaCapSemantics;
  amountSpentMinor: bigint;
  monthStartAmountSpentMinor: bigint | null;
  spentAtLastWriteMinor: bigint | null;
  accountMonthToDateMinor: bigint | null;
}): bigint | null {
  const mtd = input.accountMonthToDateMinor;
  if (input.semantics === "resets_on_write") {
    if (input.spentAtLastWriteMinor === null) return mtd;
    return maxB(mtd ?? 0n, max0(input.spentAtLastWriteMinor + input.amountSpentMinor));
  }
  if (input.monthStartAmountSpentMinor === null) return mtd;
  return maxB(mtd ?? 0n, max0(input.amountSpentMinor - input.monthStartAmountSpentMinor));
}

/** R = max(0, M - S): what is left of the monthly ads limit. */
export function remainingMinor(monthlyMinor: bigint, spentMinor: bigint): bigint {
  return max0(monthlyMinor - spentMinor);
}

/** T (5.3): A + R, or R under resets_on_write; never above the customer's own lower cap. */
export function targetCapMinor(input: { semantics: MetaCapSemantics; amountSpentMinor: bigint; monthlyMinor: bigint; spentMinor: bigint; customerCapMinor: bigint | null }): bigint {
  const r = remainingMinor(input.monthlyMinor, input.spentMinor);
  const t = input.semantics === "resets_on_write" ? r : input.amountSpentMinor + r;
  return input.customerCapMinor !== null && input.customerCapMinor > 0n ? minB(t, input.customerCapMinor) : t;
}

/** The P0 stop value: A + 1 major unit (or the 1 major unit alone under resets_on_write, where the counter restarts). */
export function stopCapMinor(input: { semantics: MetaCapSemantics; amountSpentMinor: bigint; currency: string | null }): bigint {
  const margin = oneMajorUnit(input.currency);
  return input.semantics === "resets_on_write" ? margin : input.amountSpentMinor + margin;
}

/** Mid-month consent (5.3 start values): the counter value at the start of this month, floored at 0. Null without insights. */
export function monthStartAtConsent(amountSpentMinor: bigint | null, accountMonthToDateMinor: bigint | null): bigint | null {
  if (amountSpentMinor === null || accountMonthToDateMinor === null) return null;
  return max0(amountSpentMinor - accountMonthToDateMinor);
}

/**
 * Under resets_on_write a customer cap on the old counter is translated to the new one at each write: what it still
 * allowed (cap - A before the write), floored at 0.
 */
export function translateCustomerCapAfterReset(customerCapMinor: bigint | null, amountSpentBeforeMinor: bigint): bigint | null {
  if (customerCapMinor === null || customerCapMinor <= 0n) return customerCapMinor;
  return max0(customerCapMinor - amountSpentBeforeMinor);
}

/** A floor Meta quotes (5.7): accepted when X ≤ T + 10% of M; otherwise the old cap is kept and marked loose. */
export function acceptFloor(floorMinor: bigint, targetMinor: bigint, monthlyMinor: bigint | null): boolean {
  const slack = monthlyMinor !== null ? (monthlyMinor * FLOOR_LOOSENESS_PCT) / 100n : 0n;
  return floorMinor <= targetMinor + slack;
}

/** Near the wall (5.6): C - A < 10% of M, with a cap set. */
export function nearWall(capMinor: bigint, amountSpentMinor: bigint, monthlyMinor: bigint | null): boolean {
  if (capMinor <= 0n || monthlyMinor === null || monthlyMinor <= 0n) return false;
  return (capMinor - amountSpentMinor) * 100n < monthlyMinor * NEAR_WALL_PCT;
}

/** What Meta still lets the account spend: C - A (null without a cap). */
export function metaRoomMinor(capMinor: bigint | null, amountSpentMinor: bigint | null): bigint | null {
  if (capMinor === null || capMinor <= 0n || amountSpentMinor === null) return null;
  return max0(capMinor - amountSpentMinor);
}

// =====================================================================================================================
// The change budget (5.4)
// =====================================================================================================================

/** One `requested` meta.spend_cap.write row of the last 24 h. */
export type CapWriteRecord = { at: Date; raise: boolean };

export type ChangeBudget = { used: number; raisesUsed: number; routineLeft: number; emergencyLeft: number; raisesLeft: number };

export function changeBudget(writes: readonly CapWriteRecord[], now: Date): ChangeBudget {
  const since = now.getTime() - CHANGE_WINDOW_MS;
  const recent = writes.filter((w) => w.at.getTime() > since);
  const used = recent.length;
  const raisesUsed = recent.filter((w) => w.raise).length;
  return {
    used,
    raisesUsed,
    routineLeft: Math.max(0, ROUTINE_WRITES_PER_WINDOW - used),
    emergencyLeft: Math.max(0, EMERGENCY_WRITES_PER_WINDOW - used),
    raisesLeft: Math.max(0, Math.min(ROUTINE_RAISES_PER_WINDOW - raisesUsed, ROUTINE_WRITES_PER_WINDOW - used)),
  };
}

export function budgetAllows(budget: ChangeBudget, cls: WriteClass): boolean {
  if (cls === "emergency") return budget.emergencyLeft > 0;
  if (cls === "routine") return budget.routineLeft > 0;
  return budget.routineLeft > 0 && budget.raisesLeft > 0;
}

/** When a write of this class becomes allowed again: the moment enough old writes leave the 24 h window. */
export function budgetFreesAt(writes: readonly CapWriteRecord[], cls: WriteClass, now: Date): Date | null {
  const since = now.getTime() - CHANGE_WINDOW_MS;
  const recent = writes.filter((w) => w.at.getTime() > since).sort((a, b) => a.at.getTime() - b.at.getTime());
  const cap = cls === "emergency" ? EMERGENCY_WRITES_PER_WINDOW : ROUTINE_WRITES_PER_WINDOW;
  let at: number | null = null;
  if (recent.length >= cap) at = recent[recent.length - cap].at.getTime() + CHANGE_WINDOW_MS;
  if (cls === "routine_raise") {
    const raises = recent.filter((w) => w.raise);
    if (raises.length >= ROUTINE_RAISES_PER_WINDOW) at = Math.max(at ?? 0, raises[raises.length - ROUTINE_RAISES_PER_WINDOW].at.getTime() + CHANGE_WINDOW_MS);
  }
  return at === null ? null : new Date(at + 1);
}

// =====================================================================================================================
// The decision
// =====================================================================================================================

export type PlanRequest = { kind: "p0_stop" } | { kind: "raise_requested" } | { kind: "external"; change: "raised" | "removed" };

export type PlanInput = {
  now: Date;
  row: MetaCapRow;
  monthlyLimitMinor: bigint | null;
  dailyLimitMinor: bigint | null;
  accountMonthToDateMinor: bigint | null;
  /** Σ dayRisk on the account plus 24 h of the live worst case: the room Meta must leave (P3 trigger). */
  roomNeededMinor: bigint;
  writes: readonly CapWriteRecord[];
  /** False while the workspace is locked, suspended or deleted (4.17). */
  workspaceActive: boolean;
  /** The INR 100 equivalent in the account currency. */
  thresholdFloorMinor: bigint;
  /** The first instant of the current account month (P2 detection). */
  monthStartAt: Date;
  request?: PlanRequest | null;
};

export type PlanDecision =
  | { action: "none"; reason: string; target: bigint | null }
  | { action: "write"; priority: MetaCapPriority; writeClass: WriteClass; target: bigint; raise: boolean; reason: string }
  | { action: "defer"; priority: MetaCapPriority; writeClass: WriteClass; target: bigint; raise: boolean; until: Date | null; reason: "debounce" | "budget" | "blocked" | "paused" };

type Candidate = { priority: MetaCapPriority; writeClass: WriteClass; target: bigint; debounceMs: number; reason: string };

/**
 * Decides what Meta's limit on one account should be now and whether to write it. Pure. The caller has already stored the
 * latest read (C, A), adopted a lower customer cap, and moved monthKey to the current account month.
 */
export function planMetaCap(input: PlanInput): PlanDecision {
  const { row, now } = input;
  if (row.mode !== "managed") return { action: "none", reason: "not_managed", target: null };
  if (row.accountStatus !== null && row.accountStatus !== 1) return { action: "none", reason: "account_status", target: null };
  const c = row.lastReadCapMinor;
  const a = row.lastReadAmountSpentMinor;
  if (c === null || a === null) return { action: "none", reason: "no_read", target: null };
  const m = input.monthlyLimitMinor;
  const req = input.request ?? null;

  let candidate: Candidate | null = null;

  if (req?.kind === "p0_stop") {
    candidate = { priority: "P0_stop", writeClass: "emergency", target: stopCapMinor({ semantics: row.semantics, amountSpentMinor: a, currency: row.currency }), debounceMs: 0, reason: "stop" };
  } else {
    if (m === null) return { action: "none", reason: "no_monthly_limit", target: null };
    const s = spentThisMonth({
      semantics: row.semantics,
      amountSpentMinor: a,
      monthStartAmountSpentMinor: row.monthStartAmountSpentMinor,
      spentAtLastWriteMinor: row.spentAtLastWriteMinor,
      accountMonthToDateMinor: input.accountMonthToDateMinor,
    });
    if (s === null) return { action: "none", reason: "waiting_for_sync", target: null };
    const r = remainingMinor(m, s);
    const t = targetCapMinor({ semantics: row.semantics, amountSpentMinor: a, monthlyMinor: m, spentMinor: s, customerCapMinor: row.customerCapMinor });
    const threshold = thresholdMinor({ monthlyMinor: m, dailyMinor: input.dailyLimitMinor, floorMinor: input.thresholdFloorMinor });

    if (req?.kind === "external") {
      candidate = { priority: "P0_restore", writeClass: "emergency", target: t, debounceMs: 0, reason: `external_${req.change}` };
    } else if (c === 0n || c - t > threshold) {
      // No cap at all (never written yet), or Meta allows more than the plan: lower it.
      const metaAllows = c === 0n ? null : c - a;
      const emergency = metaAllows === null || metaAllows > r + threshold;
      candidate = { priority: "P1_lower", writeClass: emergency ? "emergency" : "routine", target: t, debounceMs: P1_DEBOUNCE_MS, reason: c === 0n ? "no_cap" : "drift_high" };
    } else {
      const room = max0(c - a);
      const tooTight = room < input.roomNeededMinor && t > c;
      const wantsRaise = t - c > threshold || tooTight || (req?.kind === "raise_requested" && t > c);
      if (wantsRaise) {
        const rollover = !row.lastWriteAt || row.lastWriteAt.getTime() < input.monthStartAt.getTime();
        const loose = (row.loosenessMinor ?? 0n) > 0n && r * 100n <= m * LOOSE_RAISE_STOP_PCT;
        if (!input.workspaceActive) {
          return { action: "defer", priority: rollover ? "P2_rollover" : "P3_raise", writeClass: rollover ? "routine" : "routine_raise", target: t, raise: true, until: null, reason: "paused" };
        }
        if (loose) return { action: "none", reason: "loose", target: t };
        candidate = rollover
          ? { priority: "P2_rollover", writeClass: "routine", target: t, debounceMs: 0, reason: "rollover" }
          : { priority: "P3_raise", writeClass: "routine_raise", target: t, debounceMs: P3_DEBOUNCE_MS, reason: tooTight ? "room_too_low" : "limit_raised" };
      } else {
        // Within the threshold (or lower by less than it): not worth one of Meta's few changes a day.
        return { action: "none", reason: "in_range", target: t };
      }
    }
  }

  const raise = candidate.target > c && c !== 0n;
  // Writes Meta refuses until its next midnight (17/1885172).
  if (row.writesBlockedUntil && row.writesBlockedUntil.getTime() > now.getTime()) {
    return { action: "defer", priority: candidate.priority, writeClass: candidate.writeClass, target: candidate.target, raise, until: row.writesBlockedUntil, reason: "blocked" };
  }
  if (raise && !input.workspaceActive) {
    return { action: "defer", priority: candidate.priority, writeClass: candidate.writeClass, target: candidate.target, raise, until: null, reason: "paused" };
  }
  const budget = changeBudget(input.writes, now);
  if (!budgetAllows(budget, candidate.writeClass)) {
    return { action: "defer", priority: candidate.priority, writeClass: candidate.writeClass, target: candidate.target, raise, until: budgetFreesAt(input.writes, candidate.writeClass, now), reason: "budget" };
  }
  if (candidate.debounceMs > 0) {
    const due = row.pendingTargetMinor !== null && row.deferredUntil !== null ? row.deferredUntil : null;
    if (!due) return { action: "defer", priority: candidate.priority, writeClass: candidate.writeClass, target: candidate.target, raise, until: new Date(now.getTime() + candidate.debounceMs), reason: "debounce" };
    if (due.getTime() > now.getTime()) return { action: "defer", priority: candidate.priority, writeClass: candidate.writeClass, target: candidate.target, raise, until: due, reason: "debounce" };
  }
  return { action: "write", priority: candidate.priority, writeClass: candidate.writeClass, target: candidate.target, raise, reason: candidate.reason };
}

/** True when the classes of 5.4 would let a write of this class through now (used by offboarding). */
export function offboardClass(writes: readonly CapWriteRecord[], now: Date): WriteClass | null {
  const budget = changeBudget(writes, now);
  if (budgetAllows(budget, "routine")) return "routine";
  return budgetAllows(budget, "emergency") ? "emergency" : null;
}
