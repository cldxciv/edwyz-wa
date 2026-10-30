/**
 * The one gate every outbound WhatsApp message passes (docs/SPEND-CONTROLS-SPEC.md 4.9, invariant I9). processSendJob calls
 * messagingGate() after tenantMayRunBackground() and before the POST. The answer is one of:
 *   { action: 'send', permit, spend, run }   run(fn) executes the Graph call inside permitStore.run(permit) (msg_send permit,
 *                                            path <phoneNumberId>/messages, 1 use, 2 minutes), so the transport tripwire
 *                                            passes it; finishSend() then settles (sent, ambiguous) or releases (failed).
 *   { action: 'hold', reason, retryAt }      the caller re-queues the job (holdBlockedSend: every 15 minutes, free-form
 *                                            messages expire after 24 hours and templates after 7 days).
 *   { action: 'fail', code, handoff }        the message ends as failed with that errorCode.
 *
 * Checks, in order:
 * 1. Freezes, read through spendState() (cached at most 5 s), applied per origin class (the 4.9 table).
 * 2. Template status, re-read at send time and scoped by the sending number's WABA: paused, disabled or rejected fail every
 *    origin with template_blocked; flagged holds MARKETING broadcasts and assistant sends.
 * 3. Number and WABA breakers (wa_quality_yellow, wa_quality_red, wa_restricted, waba_disabled) by their effect, and a number
 *    that Meta no longer lets send.
 * 4. Cost: with job.reservationId the message's estimate is consumed from that bulk hold; otherwise (or when the hold is used
 *    up) a lock-free per-message reservation is made on the SpendCounter day and month rows (counters.ts). Origins never
 *    blocked by cost (human, approval, consent, system_notify, eddy) are counted without the limit conditions and flagged
 *    over_limit when that takes the counter past the limit. When the pot is exhausted: automated and API sends are held until
 *    the next workspace day or month (re-checked every 15 minutes, so a raised limit releases them), chatbot and AI agent
 *    replies fail with messaging_limit and hand the chat to the team (decision 2.3.12), an admin test fails at once, and an
 *    assistant is refused. Under SPEND_ENFORCE=observe the pot check (new in Phase 0, I12) only counts and records a
 *    would-refuse row, except for assistants, which are always enforced.
 * 5. The permit is minted.
 *
 * Bypass rule B8: this is the only messaging file that imports permit.ts.
 */
import { getRateCard, type RateCardData } from "@/lib/admin/ratecard";
import { prisma } from "@/lib/db";
import { isWithinServiceWindow } from "@/lib/inbox/window";
import { describeError } from "@/lib/safe-error";
import { effectiveLimits } from "../allowances";
import { blockingBreakers, listBreakers, type BreakerRow } from "../breakers/state";
import { getControl, type SpendDb } from "../control";
import { counterKeys, releaseCounter, reserveCounter, reserveCounterUnconditional, settleCounter, type CounterKeys } from "../counters";
import { spendEnforceMode } from "../flags";
import { spendState } from "../kill";
import { appendStandalone, type LedgerDb } from "../ledger";
import { mintPermit, permitStore } from "../permit";
import { dateToDayKey, dayKeyToDate, monthKeyOfDay, nextLocalMidnight, nextLocalMonthStart } from "../periods";
import { consumeStatement, toReservationRow } from "../reservations";
import { PERMIT_TTL_MS, type BreakerEffect, type FreezeLevel, type MsgPermit } from "../types";
import { estimateMessage, isFreeEntryPoint } from "./estimate";
import { HAND_OFF_ON_LIMIT, NEVER_BLOCKED_BY_COST, normalizeCategory, originClass, parseOrigin, FREE_FORM_CATEGORY, type OriginClass, type PricingCategory, type SendOrigin } from "./origin";

export const GATE_RETRY_MS = 15 * 60_000;
/** Freeze, limits, rate card and breaker reads are cached this long (the send gate may be at most 5 s behind, 4.11). */
export const GATE_CACHE_MS = 5_000;

export type HoldReason =
  | "spending_stopped"
  | "template_flagged"
  | "number_quality"
  | "number_restricted"
  | "waba_disabled"
  | "number_not_connected"
  | "messaging_limit";
export type FailCode = "template_blocked" | "messaging_limit";

/** Plain words for each hold, for logs and the ledger. */
export const HOLD_COPY: Readonly<Record<HoldReason, string>> = Object.freeze({
  spending_stopped: "Spending is stopped, so automatic WhatsApp messages are waiting.",
  template_flagged: "Meta flagged this template, so marketing broadcasts and assistants can't use it for now.",
  number_quality: "This WhatsApp number's quality rating dropped, so automatic messages from it are waiting.",
  number_restricted: "Meta restricted this WhatsApp account, so template messages outside an open chat are waiting.",
  waba_disabled: "Meta disabled this WhatsApp account, so automatic messages are waiting.",
  number_not_connected: "This WhatsApp number is not connected, so automatic messages from it are waiting.",
  messaging_limit: "The WhatsApp limit is used up, so automatic messages are waiting until it resets.",
});

// ===== Pure decisions (the 4.9 table, one function per column) =====

type Outcome = { action: "send" } | { action: "hold"; reason: HoldReason } | { action: "fail"; code: FailCode };
const SEND: Outcome = { action: "send" };

/** Column "Freeze assistants / Freeze all". */
export function freezeOutcome(origin: SendOrigin, freeze: { workspace: FreezeLevel; platform: FreezeLevel }): Outcome {
  const cls = originClass(origin);
  const all = freeze.workspace === "all" || freeze.platform === "all";
  const any = freeze.workspace !== "none" || freeze.platform !== "none";
  switch (cls) {
    case "human":
    case "compliance":
    case "eddy":
      return SEND;
    case "platform":
      // The notifier always sends; a platform admin's test message waits only for a platform-wide stop.
      return origin === "admin_test" && freeze.platform === "all" ? { action: "hold", reason: "spending_stopped" } : SEND;
    case "api":
    case "automated":
      return all ? { action: "hold", reason: "spending_stopped" } : SEND;
    case "assistant":
      return any ? { action: "hold", reason: "spending_stopped" } : SEND;
  }
}

const BLOCKED_TEMPLATE = new Set(["paused", "disabled", "rejected"]);

/** Step 2: the template's status at send time. */
export function templateOutcome(origin: SendOrigin, category: PricingCategory, status: string | null | undefined): Outcome {
  const s = String(status ?? "").toLowerCase();
  if (BLOCKED_TEMPLATE.has(s)) return { action: "fail", code: "template_blocked" };
  if (s === "flagged" && (origin === "assistant" || (origin === "broadcast" && category === "MARKETING"))) return { action: "hold", reason: "template_flagged" };
  return SEND;
}

export type BreakerHit = { kind: string; effect: BreakerEffect };
/** Meta number statuses that cannot send (the quality poll keeps PhoneNumber.status). */
const NOT_SENDABLE = new Set(["disconnected", "banned", "deleted"]);

export function numberSendable(status: string | null | undefined): boolean {
  return !NOT_SENDABLE.has(String(status ?? "").toLowerCase());
}

/** Column "Quality YELLOW / Quality RED, restricted, WABA disabled", plus a number that is not connected. */
export function breakerOutcome(
  origin: SendOrigin,
  input: { marketing: boolean; isTemplate: boolean; windowOpen: boolean; breakers: BreakerHit[]; sendable: boolean },
): Outcome {
  const cls: OriginClass = originClass(origin);
  if (cls === "human" || cls === "compliance" || cls === "eddy") return SEND; // people's own messages go out (Meta may reject)
  const gated = cls === "api" || cls === "automated" || cls === "assistant";
  for (const b of input.breakers) {
    if (b.kind === "wa_restricted") {
      // Only template sends outside an open window are restricted by Meta.
      if (input.isTemplate && !input.windowOpen) return { action: "hold", reason: "number_restricted" };
      continue;
    }
    if (b.effect === "block_automated" || b.effect === "block_all_outbound") return { action: "hold", reason: b.kind === "waba_disabled" ? "waba_disabled" : "number_quality" };
    if (b.effect === "block_marketing" && gated && input.marketing) return { action: "hold", reason: "number_quality" };
  }
  if (!input.sendable && gated) return { action: "hold", reason: "number_not_connected" };
  return SEND;
}

/** Column "Pot exhausted", for origins the cost can block. */
export function exhaustedOutcome(origin: SendOrigin): { action: "hold"; reason: "messaging_limit" } | { action: "fail"; code: "messaging_limit"; handoff: boolean } {
  if (HAND_OFF_ON_LIMIT.has(origin)) return { action: "fail", code: "messaging_limit", handoff: true };
  const cls = originClass(origin);
  // An assistant is refused; a platform admin's test message says so at once instead of waiting until the limit resets.
  if (cls === "assistant" || origin === "admin_test") return { action: "fail", code: "messaging_limit", handoff: false };
  return { action: "hold", reason: "messaging_limit" };
}

// ===== Types of the decision =====

/** What a message holds on the counters (settled on success, released on failure). */
export type SpendHold = {
  tenantId: string;
  messageId: string;
  /** none: nothing on the counters (free or unpriced); counter: a per-message reservation; bulk: taken from a bulk hold. */
  mode: "none" | "counter" | "bulk";
  estimateMinor: bigint;
  keys: CounterKeys;
  reservationId: string | null;
  currency: string | null;
};

type DecisionBase = { origin: SendOrigin; category: PricingCategory };
export type GateSend = DecisionBase & {
  action: "send";
  permit: MsgPermit;
  spend: SpendHold;
  /** The send was counted past the limit (never-blocked origins, or observe mode). */
  overLimit: boolean;
  /** Observe mode let through a send the pot would have refused. */
  observed: boolean;
  /** Runs the Graph call inside the permit. */
  run<T>(fn: () => Promise<T>): Promise<T>;
};
export type GateHold = DecisionBase & { action: "hold"; reason: HoldReason; retryAt: Date; released: boolean };
export type GateFail = DecisionBase & { action: "fail"; code: FailCode; handoff: boolean; period: "day" | "month" | null; released: boolean };
export type GateDecision = GateSend | GateHold | GateFail;

/** The message as processSendJob loaded it (conversation with contact and phone number). */
export type GateMessage = {
  id: string;
  type: string;
  conversationId: string;
  origin?: string | null;
  pricingCategory?: string | null;
  estCostMinor?: bigint | number | null;
  spendState?: string | null;
  spendDay?: Date | null;
  reservationId?: string | null;
  conversation: {
    lastInboundAt?: Date | null;
    referral?: unknown;
    createdAt?: Date | null;
    contact?: { phone?: string | null; bsuid?: string | null } | null;
    phoneNumber: { id?: string; phoneNumberId: string; wabaRefId?: string | null; status?: string | null };
  };
};

export type GateOptions = { now?: Date; db?: SpendDb };

// ===== Short-lived reads =====

type MessagingContext = { timezone: string; limits: Awaited<ReturnType<typeof effectiveLimits>> | null; breakers: BreakerRow[] };
type Cached<T> = { at: number; value: T };
const contexts = new Map<string, Cached<MessagingContext>>();
let cardCache: Cached<RateCardData | null> | null = null;
const blockedNoted = new Map<string, number>();

/** Test hook: forget every cached read. */
export function resetGateCaches(): void {
  contexts.clear();
  cardCache = null;
  blockedNoted.clear();
}

async function rateCard(now: number): Promise<RateCardData | null> {
  if (cardCache && now - cardCache.at < GATE_CACHE_MS) return cardCache.value;
  const value = await getRateCard();
  cardCache = { at: now, value };
  return value;
}

async function messagingContext(tenantId: string, currency: string | null, db: SpendDb, now: number): Promise<MessagingContext> {
  const key = `${tenantId}:${currency ?? "-"}`;
  const hit = contexts.get(key);
  if (hit && now - hit.at < GATE_CACHE_MS) return hit.value;
  const control = await getControl(tenantId, { db, prune: false });
  const limits = currency ? await effectiveLimits(tenantId, "messaging", currency, db, { control }) : null;
  const breakers = await listBreakers(tenantId, { db, state: "tripped" });
  const value: MessagingContext = { timezone: control.timezone, limits, breakers };
  if (contexts.size > 5_000) for (const [k, v] of contexts) if (now - v.at >= GATE_CACHE_MS) contexts.delete(k);
  contexts.set(key, { at: now, value });
  return value;
}

/** One `messaging.blocked` ledger row per workspace, reason and hour (9.1), written at most once per process and hour. */
async function noteBlocked(tenantId: string, reason: string, now: Date, opts: { observe?: boolean; detail?: string; db?: SpendDb } = {}): Promise<void> {
  const hour = now.toISOString().slice(0, 13);
  const key = `messaging.blocked:${opts.observe ? "observe:" : ""}${reason}:${hour}`;
  const memo = `${tenantId}|${key}`;
  if (blockedNoted.has(memo)) return;
  if (blockedNoted.size > 10_000) blockedNoted.clear();
  blockedNoted.set(memo, now.getTime());
  await appendStandalone(
    {
      tenantId,
      pot: "messaging",
      action: "messaging.blocked",
      phase: "refused",
      actor: { type: "system", job: "spend.messaging.gate" },
      reason: opts.observe ? `Would have waited: ${opts.detail ?? reason}` : (opts.detail ?? reason),
      reasonCodes: [reason],
      observe: opts.observe ?? false,
      idempotencyKey: key,
    },
    opts.db ? { db: opts.db as unknown as LedgerDb } : {},
  );
}

// ===== The gate =====

const big = (v: unknown): bigint => (typeof v === "bigint" ? v : v === null || v === undefined ? 0n : BigInt(v as number | string));

/** The spend fields of a Message row, as processSendJob and holdBlockedSend read them. */
export type MessageSpendFields = Pick<GateMessage, "id" | "estCostMinor" | "spendState" | "spendDay" | "reservationId">;

/** The spend a message already holds from an earlier attempt of the same job (a queue retry never reserves twice). */
function existingHold(tenantId: string, message: MessageSpendFields, currency: string | null): SpendHold | null {
  if (message.spendState !== "reserved" || !(message.spendDay instanceof Date)) return null;
  const day = dateToDayKey(message.spendDay);
  const estimateMinor = big(message.estCostMinor);
  const mode: SpendHold["mode"] = estimateMinor === 0n ? "none" : message.reservationId ? "bulk" : "counter";
  return { tenantId, messageId: message.id, mode, estimateMinor, keys: { day, month: monthKeyOfDay(day) }, reservationId: message.reservationId ?? null, currency };
}

/** The category the message is priced at: the template's current one (a category change re-estimates), else the stamp. */
async function resolveTemplate(tenantId: string, job: Record<string, unknown>, message: GateMessage, db: SpendDb): Promise<{ status: string | null; category: PricingCategory }> {
  const stamped = job.category ?? message.pricingCategory;
  if (message.type !== "template") return { status: null, category: FREE_FORM_CATEGORY };
  const t = (job.template && typeof job.template === "object" ? job.template : {}) as { name?: unknown; language?: unknown };
  const name = typeof t.name === "string" ? t.name : "";
  const language = typeof t.language === "string" ? t.language : "";
  const wabaRefId = message.conversation.phoneNumber.wabaRefId ?? (typeof job.wabaRefId === "string" ? job.wabaRefId : null);
  if (!name || !language) return { status: null, category: normalizeCategory(stamped) };
  const row = (await db.template.findFirst({ where: { tenantId, name, language, ...(wabaRefId ? { wabaRefId } : {}) }, select: { status: true, category: true } })) as { status?: unknown; category?: unknown } | null;
  return { status: row ? String(row.status ?? "") : null, category: normalizeCategory(row?.category ?? stamped) };
}

/** Gives back what a message holds (a hold or fail after an earlier attempt reserved). Never throws. */
export async function releaseHold(spend: SpendHold, db: SpendDb = prisma): Promise<void> {
  try {
    if (spend.mode === "none" || spend.estimateMinor <= 0n) return;
    if (spend.mode === "bulk" && spend.reservationId) {
      // Back into the bulk hold when it is still open, so the rest of the broadcast can use it.
      const rows = (await db.$queryRawUnsafe(unconsumeStatement().text, spend.reservationId, spend.estimateMinor)) as unknown[];
      if (Array.isArray(rows) && rows.length === 1) return;
    }
    await releaseCounter({ tenantId: spend.tenantId, pot: "messaging", keys: spend.keys, amountMinor: spend.estimateMinor }, db);
  } catch (error) {
    console.error("[spend] a message reservation could not be released:", describeError(error));
  }
}

/** Gives a failed message's estimate back to its still-open bulk hold. Values: $1 reservation id, $2 amount. */
export function unconsumeStatement(): { text: string } {
  return {
    text: `/* spend.reservation.unconsume */
UPDATE "SpendReservation" SET "consumedMinor" = "consumedMinor" - $2::bigint
WHERE "id" = $1 AND "status" = 'held' AND "consumedMinor" >= $2::bigint
RETURNING "id"`,
  };
}

async function markReleased(tenantId: string, messageId: string, db: SpendDb): Promise<void> {
  await db.message.updateMany({ where: { id: messageId, tenantId, spendState: "reserved" }, data: { spendState: "released" } });
}

/**
 * A queued message that ends without reaching the gate again gives back what an earlier attempt reserved: it expired while held
 * (the workspace stayed blocked), or a check before the gate failed it on a retry (the contact sent STOP in between). Without
 * this, a message left `reserved` would keep its estimate counted for good, because the 15-minute verify task counts reserved
 * messages as open. Returns true when the message held something. Never throws.
 */
export async function releaseMessageSpend(tenantId: string, message: MessageSpendFields, db: SpendDb = prisma): Promise<boolean> {
  const prior = existingHold(tenantId, message, null);
  if (!prior) return false;
  await releaseHold(prior, db);
  try {
    await markReleased(tenantId, message.id, db);
  } catch (error) {
    console.error("[spend] a released message could not be marked:", describeError(error));
  }
  return true;
}

/**
 * Decides whether one queued message may be sent now (4.9). `message` is the row processSendJob loaded. A hold or a fail
 * releases anything an earlier attempt of the same job had reserved.
 */
export async function messagingGate(tenantId: string, job: Record<string, unknown>, message: GateMessage, opts: GateOptions = {}): Promise<GateDecision> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const origin = parseOrigin(job.origin ?? message.origin);
  const phone = message.conversation.phoneNumber;
  const card = await rateCard(now.getTime());
  const currency = card?.currency ?? null;
  const prior = existingHold(tenantId, message, currency);

  const { status: templateStatus, category } = await resolveTemplate(tenantId, job, message, db);
  const base: DecisionBase = { origin, category };
  const stop = async (outcome: Exclude<Outcome, { action: "send" }>, extra: { retryAt?: Date; handoff?: boolean; period?: "day" | "month" | null } = {}): Promise<GateDecision> => {
    if (prior) {
      await releaseHold(prior, db);
      await markReleased(tenantId, message.id, db);
    }
    if (outcome.action === "hold") {
      await noteBlocked(tenantId, outcome.reason, now, { detail: HOLD_COPY[outcome.reason], db: opts.db });
      return { ...base, action: "hold", reason: outcome.reason, retryAt: extra.retryAt ?? new Date(now.getTime() + GATE_RETRY_MS), released: !!prior };
    }
    await noteBlocked(tenantId, outcome.code, now, { detail: outcome.code === "template_blocked" ? "Meta paused, disabled or rejected this template." : HOLD_COPY.messaging_limit, db: opts.db });
    return { ...base, action: "fail", code: outcome.code, handoff: extra.handoff ?? false, period: extra.period ?? null, released: !!prior };
  };

  // 1. Freezes (cached at most 5 s).
  const freeze = await spendState(tenantId, { db: opts.db, now: now.getTime() });
  const frozen = freezeOutcome(origin, freeze);
  if (frozen.action !== "send") return stop(frozen);

  // 2. Template status, scoped by the sending number's WABA.
  if (message.type === "template") {
    const t = templateOutcome(origin, category, templateStatus);
    if (t.action !== "send") return stop(t);
  }

  // 3. Number and WABA breakers.
  const ctx = await messagingContext(tenantId, currency, db, now.getTime());
  const scopes = [
    ...(phone.id ? [{ scopeType: "phone" as const, scopeId: phone.id }] : []),
    { scopeType: "phone" as const, scopeId: phone.phoneNumberId },
    ...(phone.wabaRefId ? [{ scopeType: "waba" as const, scopeId: phone.wabaRefId }] : []),
  ];
  const hits = blockingBreakers(ctx.breakers, scopes, ["block_marketing", "block_automated", "block_all_outbound"], { now }).map((b) => ({ kind: String(b.kind), effect: b.effect }));
  const windowOpen = isWithinServiceWindow(message.conversation.lastInboundAt ?? null, now);
  const broken = breakerOutcome(origin, { marketing: category === "MARKETING", isTemplate: message.type === "template", windowOpen, breakers: hits, sendable: numberSendable(phone.status) });
  if (broken.action !== "send") return stop(broken);

  // 4. Cost.
  let spend: SpendHold;
  let overLimit = false;
  let observed = false;
  if (prior) {
    spend = prior;
  } else {
    const estimate = estimateMessage({ card, category, contact: message.conversation.contact ?? null, freeEntryPoint: isFreeEntryPoint(message.conversation, now) });
    const est = estimate.minor;
    const todayKeys = counterKeys(now, ctx.timezone);
    const limits = ctx.limits;
    const neverBlocked = NEVER_BLOCKED_BY_COST.has(origin);
    const enforce = origin === "assistant" || spendEnforceMode() === "enforce";
    spend = { tenantId, messageId: message.id, mode: "none", estimateMinor: est, keys: todayKeys, reservationId: null, currency };

    // An assistant is refused before any maths when the limits are Not set or their ceiling is unknown (4.4).
    if (origin === "assistant" && (!limits || limits.rules.assistantRefusal)) return stop({ action: "fail", code: "messaging_limit" });

    if (est > 0n) {
      let reserved = false;
      if (typeof job.reservationId === "string" && job.reservationId) {
        // A bulk send: take this message's estimate from its hold, lock-free. A used-up, closed or expired hold falls back below.
        const stmt = consumeStatement(job.reservationId, est, now);
        const rows = ((await db.$queryRawUnsafe(stmt.text, ...stmt.values)) ?? []) as Record<string, unknown>[];
        if (Array.isArray(rows) && rows.length === 1) {
          const r = toReservationRow(rows[0]);
          spend = { ...spend, mode: "bulk", keys: { day: r.dayKey, month: r.monthKey }, reservationId: r.id };
          reserved = true;
        }
      }
      if (!reserved) {
        const daily = limits?.daily ?? null;
        const monthly = limits?.monthly ?? null;
        const counterInput = { tenantId, pot: "messaging" as const, amountMinor: est, currency: currency ?? undefined, keys: todayKeys };
        if (neverBlocked) {
          const r = await reserveCounterUnconditional({ ...counterInput, dayLimitMinor: daily, monthLimitMinor: monthly }, db);
          overLimit = r.overLimit;
          spend = { ...spend, mode: "counter" };
        } else {
          // A person on new-workspace limits whose ceiling is unknown is refused raises (4.4); for automatic sends that is an
          // exhausted pot.
          const refused = !!limits?.rules.humanRefusal;
          const r = refused ? null : await reserveCounter({ ...counterInput, dayLimitMinor: daily, monthLimitMinor: monthly }, db);
          if (r && r.ok) spend = { ...spend, mode: "counter" };
          else {
            const period: "day" | "month" = r && !r.ok && r.exhausted === "day" ? "day" : "month";
            if (!enforce) {
              // Observe (I12): the new pot check only records what it would have done; the cost is still counted.
              await reserveCounterUnconditional({ ...counterInput, dayLimitMinor: daily, monthLimitMinor: monthly }, db);
              await noteBlocked(tenantId, "messaging_limit", now, { observe: true, detail: HOLD_COPY.messaging_limit, db: opts.db });
              spend = { ...spend, mode: "counter" };
              overLimit = true;
              observed = true;
            } else {
              const out = exhaustedOutcome(origin);
              if (out.action === "fail") return stop(out, { handoff: out.handoff, period });
              const reset = period === "day" ? nextLocalMidnight(now, ctx.timezone) : nextLocalMonthStart(now, ctx.timezone);
              return stop(out, { retryAt: new Date(Math.min(reset.getTime(), now.getTime() + GATE_RETRY_MS)) });
            }
          }
        }
      }
    }
    await db.message.updateMany({
      where: { id: message.id, tenantId },
      data: {
        origin,
        pricingCategory: category,
        estCostMinor: est,
        spendState: "reserved",
        spendDay: dayKeyToDate(spend.keys.day),
        reservationId: spend.reservationId,
      },
    });
  }

  // 5. The permit (the transport tripwire checks it). It names the edge processSendJob POSTs to; the POST itself stays in
  // inbox/send.ts (bypass rule B4).
  const issuedAt = new Date();
  const permit = mintPermit({
    type: "msg",
    tenantId,
    correlationId: `msg:${message.id}`,
    paths: [[phone.phoneNumberId, "messages"].join("/")],
    maxUses: 1,
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + PERMIT_TTL_MS.msg),
    phoneNumberId: phone.phoneNumberId,
    messageId: message.id,
    ...(spend.reservationId ? { reservationId: spend.reservationId } : {}),
  });
  return { ...base, action: "send", permit, spend, overLimit, observed, run: <T>(fn: () => Promise<T>) => permitStore.run(permit, fn) };
}

export type SendResult = "sent" | "failed" | "ambiguous";

/**
 * After the POST (processSendJob writes Message.spendState first, then calls this): a sent message moves its estimate from
 * reserved to spent; an ambiguous one (Meta may have delivered it) is settled at its estimate too, never released; a failed
 * one gives the estimate back. Never throws: counters are a cache the 15-minute verify task rebuilds, and an accepted send
 * must never turn into a failed one here.
 */
export async function finishSend(spend: SpendHold, result: SendResult, db: SpendDb = prisma): Promise<void> {
  if (spend.mode === "none" || spend.estimateMinor <= 0n) return;
  if (result === "failed") return releaseHold(spend, db);
  try {
    await settleCounter({ tenantId: spend.tenantId, pot: "messaging", keys: spend.keys, reservedMinor: spend.estimateMinor, actualMinor: spend.estimateMinor }, db);
  } catch (error) {
    console.error("[spend] a message reservation could not be settled:", describeError(error));
  }
}
