/**
 * What bulk WhatsApp sends may cost, and the gate in front of them (docs/SPEND-CONTROLS-SPEC.md 4.9 "Bulk gates", WP-10).
 *
 * Estimates. estimateBreakdown() is the CONSERVATIVE estimate of spend/messaging/estimate.ts, in the JSON-safe shape the
 * broadcast screen reads: an unpriced country is priced at the highest card rate for the category, an unknown category counts
 * as MARKETING, +1 and +7 numbers at the highest of the countries sharing the code, free entry point recipients at 0, and
 * SERVICE at the SERVICE rate (UTILITY while SERVICE is missing). With no rate card nothing can be priced: "not configured",
 * never an invented figure, and no hold is taken (the per-message gate then counts 0 too).
 *
 * The gate. A bulk send takes ONE hold for its whole estimate before anything is queued (reserveBulk in spend/reservations.ts,
 * under the spend lock), so it either fits the WhatsApp limit or is refused with 409 and nothing is queued:
 * - broadcasts (startBroadcast, and a scheduled broadcast when it becomes due): 7 days;
 * - a scheduled automation run (automation/v2/timed.ts): per run, before chunking;
 * - API batches (compat messageTemplates/send per call, a v1 or MCP template send as a batch of one).
 * The messages of the send then consume their estimate from the hold at send time (the job carries reservationId); a used-up,
 * closed or expired hold falls back to the per-message reservation, so nothing is ever sent unreserved. The unspent part goes
 * back on completion or cancel (a lowering: no lock, never refused).
 *
 * Observe mode (SPEND_ENFORCE=observe, I12): the WhatsApp limit is new in Phase 0, so a bulk send that would not fit still goes
 * ahead without a hold and a `refused` row with observe=true is written; its messages are then counted one by one by the gate.
 *
 * Free-form API sends cannot carry a hold (the inbox's free-form path has no reservation), so they are refused at enqueue with
 * 409 spend.messaging_limit when the pot cannot pay for the message (assertApiSendFits); the gate holds them at send otherwise.
 */
import { randomUUID } from "node:crypto";
import { getRateCard, type RateCardData } from "@/lib/admin/ratecard";
import { prisma } from "@/lib/db";
import { describeError } from "@/lib/safe-error";
import { effectiveLimits } from "@/lib/spend/allowances";
import { getControl } from "@/lib/spend/control";
import { counterKeys, readCounters } from "@/lib/spend/counters";
import { SpendBlockedError } from "@/lib/spend/errors";
import { spendEnforceMode } from "@/lib/spend/flags";
import { appendStandalone } from "@/lib/spend/ledger";
import { maxBig } from "@/lib/spend/money";
import { nextLocalMidnight, nextLocalMonthStart } from "@/lib/spend/periods";
import { openReservationFor, releaseUnspent, reserveBulk } from "@/lib/spend/reservations";
import { estimateBreakdown as conservativeBreakdown, estimateMessage, FREE_ENTRY_POINT_MS, isFreeEntryPoint, recipientCountry } from "@/lib/spend/messaging/estimate";
import { normalizeCategory } from "@/lib/spend/messaging/origin";
import type { BulkSubjectType, SpendActor } from "@/lib/spend/types";
import { countryOfPhone } from "./country";

export type RateCard = Record<string, Partial<Record<string, number>>>;

// Deliberately empty. The real price list is entered by a super admin (PlatformSetting "ratecard", see lib/admin/ratecard.ts)
// from Meta's current pricing page. Never put guessed values here.
export const RATE_CARD: RateCard = {};

export type CostEstimate =
  | { configured: false }
  | { configured: true; perMessagePaise: number; totalPaise: number; currency: "INR" };

/** Single-country estimate against an explicit card. With no card passed it uses the empty built-in card, so it reports not configured. */
export function estimateCost(input: { category: string; country: string; count: number; rateCard?: RateCard }): CostEstimate {
  const rate = (input.rateCard ?? RATE_CARD)[input.country.toUpperCase()]?.[input.category.toUpperCase()];
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) return { configured: false };
  return { configured: true, perMessagePaise: rate, totalPaise: Math.round(rate * input.count), currency: "INR" };
}

export type CostLine = { country: string | null; count: number; perMessageMinor: number | null; totalMinor: number | null };
export type CostBreakdown =
  | { configured: false; lines: CostLine[]; count: number }
  | {
      configured: true;
      currency: string;
      totalMinor: number;
      /** Always 0 now: a country without a price is priced at the card's highest rate instead of being left out. */
      unpricedCount: number;
      /** Recipients priced at the highest rate because their country has no price of its own. */
      highestRateCount: number;
      /** Recipients in a free entry point window (priced at 0). */
      freeCount: number;
      /** SERVICE was priced at the UTILITY rate because the card has no SERVICE price. */
      serviceFallback: boolean;
      lines: CostLine[];
      count: number;
    };

/** Groups phone numbers by country calling code: country (null when unknown) to how many. */
export function countByCountry(phones: readonly string[]): Map<string | null, number> {
  const out = new Map<string | null, number>();
  for (const phone of phones) {
    const country = countryOfPhone(phone);
    out.set(country, (out.get(country) ?? 0) + 1);
  }
  return out;
}

const lineOf = (l: { country: string | null; count: number; perMessageMinor: number | null; totalMinor: number | null }): CostLine => ({
  country: l.country,
  count: l.count,
  perMessageMinor: l.perMessageMinor,
  totalMinor: l.totalMinor,
});

/**
 * The conservative cost for a template category across the recipients' countries, from the admin-entered rate card (4.9). This
 * is the figure a bulk hold reserves, so it is never a lower bound: unpriced countries are priced at the highest rate.
 */
export function estimateBreakdown(input: { category: string; countries: Map<string | null, number>; card: RateCardData | null; free?: number }): CostBreakdown {
  const c = conservativeBreakdown(input);
  const lines = c.lines.filter((l) => l.basis !== "free").map(lineOf);
  if (!c.configured) return { configured: false, lines, count: c.count };
  return {
    configured: true,
    currency: c.currency,
    totalMinor: c.totalMinor,
    unpricedCount: 0,
    highestRateCount: c.highestRateCount,
    freeCount: c.freeCount,
    serviceFallback: c.serviceFallback,
    lines,
    count: c.count,
  };
}

/** The hold amount of a conservative breakdown, in exact minor units (bigint), or null when nothing can be priced. */
export function bulkEstimateMinor(input: { category: string; countries: Map<string | null, number>; card: RateCardData | null; free?: number }): bigint | null {
  const c = conservativeBreakdown(input);
  return c.configured ? c.totalMinorBig : null;
}

// ===== The WhatsApp limit's room right now =====

export const BROADCAST_HOLD_TTL_MS = 7 * 86_400_000;
/** A scheduled automation run normally finishes in minutes; a day covers a slow worker. The rest goes back when it ends. */
export const AUTOMATION_HOLD_TTL_MS = 24 * 3_600_000;
/** An API call's messages are sent within seconds; whatever they did not use goes back after an hour at the latest. */
export const API_HOLD_TTL_MS = 60 * 60_000;

export type MessagingRoom = {
  currency: string;
  timezone: string;
  daily: bigint | null;
  monthly: bigint | null;
  /** What is left today and this month (null: no limit for that period). */
  leftDay: bigint | null;
  leftMonth: bigint | null;
  /** On new-workspace limits with an unknown ceiling: nothing new may start (4.4). */
  refused: boolean;
};

/** The WhatsApp limit and what is left of it now, in the workspace's own day and month (4.9). */
export async function messagingRoom(tenantId: string, currency: string, now: Date = new Date()): Promise<MessagingRoom> {
  const control = await getControl(tenantId, { prune: false });
  const limits = await effectiveLimits(tenantId, "messaging", currency, undefined, { control, now });
  const keys = counterKeys(now, control.timezone);
  const used = await readCounters(tenantId, "messaging", keys);
  const left = (limit: bigint | null, usedMinor: bigint) => (limit === null ? null : maxBig(0n, limit - usedMinor));
  return {
    currency: currency.toUpperCase(),
    timezone: control.timezone,
    daily: limits.daily,
    monthly: limits.monthly,
    leftDay: left(limits.daily, used.day.used),
    leftMonth: left(limits.monthly, used.month.used),
    refused: !!limits.rules?.humanRefusal,
  };
}

export type RoomFit = { fits: boolean; period: "day" | "month" | null; left: bigint | null };

/** Whether `amount` fits (pure). The month is named first, as in the 409 copy; a send that fits the month but not today says "today". */
export function fitsRoom(room: Pick<MessagingRoom, "leftDay" | "leftMonth" | "refused">, amountMinor: bigint): RoomFit {
  if (room.refused) return { fits: false, period: room.leftMonth !== null || room.leftDay === null ? "month" : "day", left: 0n };
  if (room.leftMonth !== null && amountMinor > room.leftMonth) return { fits: false, period: "month", left: room.leftMonth };
  if (room.leftDay !== null && amountMinor > room.leftDay) return { fits: false, period: "day", left: room.leftDay };
  const lefts = [room.leftDay, room.leftMonth].filter((v): v is bigint => v !== null);
  return { fits: true, period: null, left: lefts.length ? lefts.reduce((a, b) => (a < b ? a : b)) : null };
}

/** "Today's WhatsApp limit is used up..." with the reset date in the workspace's zone (4.13 spend.messaging_limit). */
export function messagingLimitError(period: "day" | "month", room: Pick<MessagingRoom, "timezone">, now: Date = new Date()): SpendBlockedError {
  const resetsOn = period === "day" ? nextLocalMidnight(now, room.timezone) : nextLocalMonthStart(now, room.timezone);
  return new SpendBlockedError("spend.messaging_limit", { period, resetsOn, timezone: room.timezone });
}

/** "This broadcast could cost about ₹4,300, but only ₹1,200 is left in your WhatsApp limit today..." (4.13 spend.broadcast). */
export function broadcastLimitError(estimateMinor: bigint, fit: RoomFit, currency: string): SpendBlockedError {
  return new SpendBlockedError("spend.broadcast", { cost: { minor: estimateMinor, currency }, left: { minor: fit.left ?? 0n, currency }, period: fit.period ?? "month" });
}

/** The scheduler's dry-run warning (4.9 critic): the hold is taken when the broadcast is due, so it can only warn now. */
export const SCHEDULE_WARNING = "At today's figures this broadcast won't fit your WhatsApp limit. It will pause when it's due unless the limit allows it.";

// ===== Bulk holds =====

export type BulkHold = {
  /** The SpendReservation the messages consume from; null when nothing was held (free, no rate card, or observe mode). */
  reservationId: string | null;
  estimateMinor: bigint;
  currency: string | null;
  /** Observe mode let a send through that the limit would have refused. */
  observed: boolean;
  /** A new hold (false when the subject already had one open, for example on resume). */
  created: boolean;
};

const NO_HOLD = (estimateMinor = 0n, currency: string | null = null): BulkHold => ({ reservationId: null, estimateMinor, currency, observed: false, created: false });

export type HoldInput = {
  tenantId: string;
  subject: { type: BulkSubjectType; id: string };
  estimateMinor: bigint;
  currency: string;
  ttlMs: number;
  actor: SpendActor;
  /** Plain words for the ledger row ("Broadcast Diwali offer"). */
  reason: string;
  /**
   * Which sentence a refusal uses (4.13): a broadcast always names its cost (spend.broadcast); an API batch names its cost
   * unless nothing is left at all (spend.messaging_limit); a single API message says the limit is used up.
   */
  refusal?: "broadcast" | "batch" | "message";
  now?: Date;
};

function refusalError(input: HoldInput, fit: RoomFit, room: MessagingRoom, now: Date): SpendBlockedError {
  const kind = input.refusal ?? "broadcast";
  const period = fit.period ?? "month";
  if (kind === "message" || (kind === "batch" && (fit.left ?? 0n) === 0n)) return messagingLimitError(period, room, now);
  return broadcastLimitError(input.estimateMinor, fit, input.currency);
}

/** Observe mode's would-refuse row (4.14: `refused` with observe=true). One per subject. Never throws. */
async function noteObserved(input: HoldInput, fit: RoomFit, error: SpendBlockedError): Promise<void> {
  await appendStandalone({
    tenantId: input.tenantId,
    pot: "messaging",
    action: "messaging.bulk_hold",
    phase: "refused",
    actor: input.actor,
    reason: `Would have stopped: ${error.message}`,
    reasonCodes: [error.code],
    targetType: input.subject.type,
    targetId: input.subject.id,
    currency: input.currency,
    amountMinor: input.estimateMinor,
    forecastTodayMinor: input.estimateMinor,
    forecastMonthMinor: input.estimateMinor,
    snapshot: { period: fit.period, left: fit.left },
    observe: true,
    idempotencyKey: `bulk_observe:${input.subject.type}:${input.subject.id}`,
  });
}

const observedHold = (input: HoldInput): BulkHold => ({ ...NO_HOLD(input.estimateMinor, input.currency), observed: true });

/**
 * Runs a bulk-gate step. A refusal (SpendBlockedError) always passes through. Any other failure (the spend tables cannot be
 * read) fails closed in enforce mode (I8: raises fail closed when state cannot be read) and, in observe mode, lets the send go
 * ahead without a hold (R3: nothing new may block anyone before enforce; the send gate still counts every message).
 */
export async function bulkGateStep<T>(what: string, fn: () => Promise<T>, observeFallback: T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof SpendBlockedError || spendEnforceMode() === "enforce") throw error;
    console.warn(`[spend] ${what} could not be checked against the WhatsApp limit; going ahead (observe mode): ${describeError(error)}`);
    return observeFallback;
  }
}

/**
 * Holds a bulk send's estimate, or refuses it (409, nothing held). Returns the existing hold when the subject already has one
 * (a resumed broadcast). The read of the room only words the refusal and serves observe mode; in enforce mode reserveBulk
 * decides under the spend lock.
 */
export async function holdForBulk(input: HoldInput): Promise<BulkHold> {
  if (input.estimateMinor <= 0n) return NO_HOLD(0n, input.currency);
  const now = input.now ?? new Date();
  // A subject that still holds money keeps that hold (a resumed broadcast); its own hold already counts in the room below.
  const existing = await openReservationFor(input.tenantId, input.subject, { now });
  if (existing) return { reservationId: existing.id, estimateMinor: existing.amountMinor - existing.consumedMinor, currency: existing.currency, observed: false, created: false };
  const enforce = spendEnforceMode() === "enforce";
  const room = await messagingRoom(input.tenantId, input.currency, now);
  const fit = fitsRoom(room, input.estimateMinor);
  if (!fit.fits && (!enforce || room.refused)) {
    const error = refusalError(input, fit, room, now);
    if (!enforce) {
      await noteObserved(input, fit, error);
      return observedHold(input);
    }
    // New-workspace limits with an unknown ceiling: the limits passed to reserveBulk would look open, so refuse here.
    await appendStandalone({
      tenantId: input.tenantId,
      pot: "messaging",
      action: "messaging.bulk_hold",
      phase: "refused",
      actor: input.actor,
      reason: error.message,
      reasonCodes: [error.code, "unknown_ceiling"],
      targetType: input.subject.type,
      targetId: input.subject.id,
      currency: input.currency,
      amountMinor: input.estimateMinor,
    });
    throw error;
  }
  try {
    const out = await reserveBulk(input.tenantId, "messaging", input.estimateMinor, input.subject, input.ttlMs, {
      currency: input.currency,
      limits: { daily: room.daily, monthly: room.monthly },
      actor: input.actor,
      reason: input.reason,
      timezone: room.timezone,
      at: now,
    });
    return { reservationId: out.reservation?.id ?? null, estimateMinor: input.estimateMinor, currency: input.currency, observed: false, created: out.created };
  } catch (error) {
    if (!(error instanceof SpendBlockedError)) throw error;
    // Observe mode, and someone used the room between the read and the lock: go ahead without a hold.
    if (!enforce) return observedHold(input);
    if ((input.refusal ?? "broadcast") === "broadcast") throw error;
    const left = error.params.left?.minor;
    throw refusalError(input, { fits: false, period: error.params.period ?? "month", left: left === undefined ? 0n : BigInt(left) }, room, now);
  }
}

/** Gives back what a bulk send did not use (completion, cancel, nothing queued). A lowering: never refused. Never throws. */
export async function releaseBulkHold(reservationId: string | null | undefined, reason: string, actor: SpendActor = { type: "system", job: "messaging.bulk_release" }): Promise<bigint> {
  if (!reservationId) return 0n;
  try {
    const out = await releaseUnspent(reservationId, { actor, reason });
    return out.releasedMinor;
  } catch (error) {
    console.error("[spend] a bulk WhatsApp hold could not be released:", describeError(error));
    return 0n;
  }
}

/** Releases the open hold of a subject, if any. Never throws. */
export async function releaseBulkFor(tenantId: string, subject: { type: BulkSubjectType; id: string }, reason: string, actor?: SpendActor): Promise<bigint> {
  try {
    const open = await openReservationFor(tenantId, subject);
    return open ? releaseBulkHold(open.id, reason, actor) : 0n;
  } catch (error) {
    console.error("[spend] the open bulk WhatsApp hold could not be read:", describeError(error));
    return 0n;
  }
}

/** The open hold of a subject, or null (also when it cannot be read: the messages then reserve one by one). */
export async function openBulkHold(tenantId: string, subject: { type: BulkSubjectType; id: string }): Promise<string | null> {
  try {
    return (await openReservationFor(tenantId, subject))?.id ?? null;
  } catch {
    return null;
  }
}

// ===== Broadcast audiences =====

/** At most this many recipients are read for the country split; the rest are priced at the card's highest rate. */
export const ESTIMATE_RECIPIENT_CAP = 200_000;

type EstimateRef = { id: string; tenantId: string; phoneNumberId: string; template: { category?: string | null } };

/**
 * The conservative hold for the broadcast's recipients that are still pending (on resume, only those not reached yet). Null
 * when nothing can be priced (no rate card). Free entry point recipients (a click-to-WhatsApp chat on the sending number opened
 * less than 72 hours ago) are priced at 0.
 */
export async function estimateBroadcastHold(b: EstimateRef, card: RateCardData | null, now: Date = new Date()): Promise<{ estimateMinor: bigint; count: number; currency: string } | null> {
  if (!card) return null;
  const where = { tenantId: b.tenantId, broadcastId: b.id, status: "pending" as const };
  const count = await prisma.broadcastRecipient.count({ where });
  if (count === 0) return { estimateMinor: 0n, count: 0, currency: card.currency };
  const contacts = await prisma.contact.findMany({
    where: { tenantId: b.tenantId, broadcastRecipients: { some: where } },
    select: { id: true, phone: true, bsuid: true },
    take: ESTIMATE_RECIPIENT_CAP,
  });
  // Free entry points only lower the estimate, so a failed lookup prices everyone (the conservative direction).
  const recent = await prisma.conversation
    .findMany({
      where: { tenantId: b.tenantId, phoneNumberId: b.phoneNumberId, createdAt: { gt: new Date(now.getTime() - FREE_ENTRY_POINT_MS) } },
      select: { contactId: true, referral: true, createdAt: true },
      take: 50_000,
    })
    .catch(() => [] as { contactId: string; referral: unknown; createdAt: Date }[]);
  const free = new Set(recent.filter((c) => isFreeEntryPoint(c, now)).map((c) => c.contactId));
  const countries = new Map<string | null, number>();
  let freeCount = 0;
  for (const c of contacts) {
    if (free.has(c.id)) {
      freeCount++;
      continue;
    }
    const country = recipientCountry(c);
    countries.set(country, (countries.get(country) ?? 0) + 1);
  }
  // Recipients past the read cap (or missing their contact row) are priced as an unknown country: the highest rate.
  const unread = Math.max(0, count - contacts.length);
  if (unread > 0) countries.set(null, (countries.get(null) ?? 0) + unread);
  const estimateMinor = bulkEstimateMinor({ category: normalizeCategory(b.template.category), countries, card, free: freeCount });
  return estimateMinor === null ? null : { estimateMinor, count, currency: card.currency };
}

/**
 * A broadcast's bulk hold (4.9): 7 days for everyone still pending, taken when it starts sending (startBroadcast, or a
 * scheduled broadcast when it is due). Null when nothing can be priced. Throws 409 spend.broadcast when it does not fit.
 */
export async function holdBroadcastFor(b: EstimateRef & { name: string }, actor: SpendActor, now: Date = new Date()): Promise<BulkHold | null> {
  return bulkGateStep(
    "a broadcast",
    async () => {
      const card = await getRateCard();
      const est = await estimateBroadcastHold(b, card, now);
      if (!est) return null;
      return holdForBulk({
        tenantId: b.tenantId,
        subject: { type: "broadcast", id: b.id },
        estimateMinor: est.estimateMinor,
        currency: est.currency,
        ttlMs: BROADCAST_HOLD_TTL_MS,
        actor,
        reason: `Broadcast "${b.name}" to ${est.count.toLocaleString("en-IN")} ${est.count === 1 ? "person" : "people"}.`,
        refusal: "broadcast",
        now,
      });
    },
    null,
  );
}

// ===== Single API sends =====

export type ApiSendInput = {
  tenantId: string;
  actor: SpendActor;
  origin: "api" | "mcp";
  category: string | null | undefined;
  contact: { phone?: string | null; bsuid?: string | null } | null;
  conversation?: { referral?: unknown; createdAt?: Date | null } | null;
  now?: Date;
};

/**
 * A v1 or MCP template send: a per-call api_batch hold of one message (4.9), so an exhausted pot answers a synchronous 409
 * (spend.messaging_limit) and nothing is queued. Returns the hold for sendTemplateMessage's reservationId.
 */
export async function holdForApiSend(input: ApiSendInput): Promise<BulkHold> {
  const card = await getRateCard();
  if (!card) return NO_HOLD();
  const now = input.now ?? new Date();
  const est = estimateMessage({ card, category: normalizeCategory(input.category), contact: input.contact, freeEntryPoint: isFreeEntryPoint(input.conversation, now) });
  return bulkGateStep(
    "an API message",
    () =>
      holdForBulk({
        tenantId: input.tenantId,
        subject: { type: "api_batch", id: `${input.origin}:${randomUUID()}` },
        estimateMinor: est.minor,
        currency: card.currency,
        ttlMs: API_HOLD_TTL_MS,
        actor: input.actor,
        reason: input.origin === "mcp" ? "A template message sent through the MCP connection." : "A template message sent through the API.",
        refusal: "message",
        now,
      }),
    NO_HOLD(est.minor, card.currency),
  );
}

/**
 * A v1, compat or MCP free-form send (a reply inside the 24-hour window). It cannot carry a hold, so it is refused at enqueue
 * with 409 spend.messaging_limit when the WhatsApp limit cannot pay for it; in observe mode only a would-refuse row is written.
 */
export async function assertApiSendFits(input: Omit<ApiSendInput, "category">): Promise<void> {
  const card = await getRateCard();
  if (!card) return;
  const now = input.now ?? new Date();
  const est = estimateMessage({ card, category: "SERVICE", contact: input.contact, freeEntryPoint: isFreeEntryPoint(input.conversation, now) });
  if (est.minor <= 0n) return;
  const room = await bulkGateStep("an API message", () => messagingRoom(input.tenantId, card.currency, now), null);
  if (!room) return;
  const fit = fitsRoom(room, est.minor);
  if (fit.fits) return;
  const error = messagingLimitError(fit.period ?? "month", room, now);
  await appendStandalone({
    tenantId: input.tenantId,
    pot: "messaging",
    action: "messaging.blocked",
    phase: "refused",
    actor: input.actor,
    reason: spendEnforceMode() === "enforce" ? error.message : `Would have stopped: ${error.message}`,
    reasonCodes: [error.code],
    targetType: input.origin,
    currency: card.currency,
    amountMinor: est.minor,
    observe: spendEnforceMode() !== "enforce",
    idempotencyKey: `messaging.blocked:${input.origin}:${now.toISOString().slice(0, 13)}`,
  });
  if (spendEnforceMode() === "enforce") throw error;
}
