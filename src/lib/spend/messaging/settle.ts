/**
 * WhatsApp cost settlement (docs/SPEND-CONTROLS-SPEC.md 4.9 "Actual cost"). The send gate counts each message at its
 * conservative estimate; this replaces the estimate with what Meta charged, once per message. The bulk-senders package
 * schedules runSettlement() as `spend.messaging.settle` every 5 minutes.
 *
 * A message is settled (spendState 'settled', pricingSettledAt NULL; index Message_pricing_unsettled_idx of 0010) when:
 * - Meta's status carried pricing (webhooks/processor.ts stores billable and the category): actual = billable ? the card's
 *   price for that category : 0, so a free entry point or any message Meta did not bill gives its estimate back;
 * - it failed after Meta accepted it (status failed with a wamid): actual = 0, because Meta charges only on delivery;
 * - 7 days passed without pricing: the estimate is kept (conservative). An ambiguous send (no wamid, send_unconfirmed) ends
 *   here unless pricing arrives.
 * Each message is claimed with a conditional update on pricingSettledAt, so two runs never apply it twice. Per workspace the
 * deltas Σ(actual - estimate) are applied to the counters of each message's OWN spendDay and month, never today's (a refund
 * for 31 Oct settled on 1 Nov frees October's room), in the same transaction as the claims. One `messaging.settlement` ledger
 * row (phase reconciled) is written per workspace and run, and the SpendDaily `phone` rows of the touched days are rewritten
 * (SET, never added to) for the dashboard.
 */
import { getRateCard, type RateCardData } from "@/lib/admin/ratecard";
import { prisma } from "@/lib/db";
import { describeError } from "@/lib/safe-error";
import { inSpendTransaction, type SpendDb } from "../control";
import { adjustSpent } from "../counters";
import { appendStandalone, type LedgerDb } from "../ledger";
import { formatMinor } from "../money";
import { dateToDayKey, dayKeyToDate, monthKeyOfDay } from "../periods";
import { actualCostMinor } from "./estimate";

/** Without pricing after this long, a message keeps its estimate. */
export const PRICING_WAIT_MS = 7 * 86_400_000;
export const SETTLEMENT_BATCH = 500;

type Row = {
  id: string;
  tenantId: string;
  conversationId: string;
  status: string;
  wamid: string | null;
  createdAt: Date;
  estCostMinor: bigint | number | null;
  billable: boolean | null;
  pricingCategory: string | null;
  spendDay: Date | null;
};

export type SettlementVerdict = { actualMinor: bigint; basis: "priced" | "not_billed" | "failed_after_accept" | "kept_estimate" } | null;

const big = (v: unknown): bigint => (typeof v === "bigint" ? v : v === null || v === undefined ? 0n : BigInt(v as number | string));

/** What one message settles at, or null while it should still wait for Meta's pricing (pure). */
export function settlementFor(
  m: Pick<Row, "status" | "wamid" | "createdAt" | "estCostMinor" | "billable" | "pricingCategory">,
  input: { card: RateCardData | null; contact?: { phone?: string | null; bsuid?: string | null } | null; now: Date },
): SettlementVerdict {
  const estimate = big(m.estCostMinor);
  if (m.billable === true) {
    const actual = actualCostMinor({ card: input.card, billable: true, category: m.pricingCategory, contact: input.contact });
    return actual === null ? { actualMinor: estimate, basis: "kept_estimate" } : { actualMinor: actual, basis: "priced" };
  }
  if (String(m.status) === "failed" && m.wamid) return { actualMinor: 0n, basis: "failed_after_accept" };
  if (m.billable === false) return { actualMinor: 0n, basis: "not_billed" };
  if (input.now.getTime() - m.createdAt.getTime() >= PRICING_WAIT_MS) return { actualMinor: estimate, basis: "kept_estimate" };
  return null;
}

/** The settled cost of one phone number on one day, for the SpendDaily `phone` row. Values: $1 tenant, $2 PhoneNumber.id, $3 day. */
export function phoneDayStatement(): { text: string } {
  return {
    text: `/* spend.messaging.phone_day */
SELECT COALESCE(SUM(m."costMinor"), 0)::text AS total
FROM "Message" m JOIN "Conversation" c ON c."id" = m."conversationId"
WHERE m."tenantId" = $1 AND c."phoneNumberId" = $2 AND m."spendDay" = $3::date AND m."pricingSettledAt" IS NOT NULL`,
  };
}

export type SettlementOptions = { now?: Date; db?: SpendDb; limit?: number; card?: RateCardData | null };
export type TenantSettlement = { tenantId: string; settled: number; deltaMinor: bigint; days: Record<string, bigint>; currency: string | null };
/** `waiting`: read but not ready to settle. Normally 0, because the query reads only messages that are ready. */
export type SettlementResult = { scanned: number; settled: number; waiting: number; tenants: TenantSettlement[] };

/** Applies Meta's pricing to settled messages (see the module comment). Safe to run concurrently and repeatedly. */
export async function runSettlement(opts: SettlementOptions = {}): Promise<SettlementResult> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const card = opts.card !== undefined ? opts.card : await getRateCard();
  const currency = card?.currency ?? null;
  // Only messages that can settle now: with Meta's pricing, failed after Meta accepted them, or past the 7-day wait. Messages
  // still waiting for pricing are never read, so a backlog of them can never fill the batch and starve newer priced ones.
  const rows = ((await db.message.findMany({
    where: {
      direction: "outbound",
      spendState: "settled",
      pricingSettledAt: null,
      OR: [{ billable: { not: null } }, { status: "failed", wamid: { not: null } }, { createdAt: { lte: new Date(now.getTime() - PRICING_WAIT_MS) } }],
    },
    orderBy: { createdAt: "asc" },
    take: Math.min(Math.max(1, opts.limit ?? SETTLEMENT_BATCH), 2_000),
    select: { id: true, tenantId: true, conversationId: true, status: true, wamid: true, createdAt: true, estCostMinor: true, billable: true, pricingCategory: true, spendDay: true },
  })) ?? []) as unknown as Row[];
  if (rows.length === 0) return { scanned: 0, settled: 0, waiting: 0, tenants: [] };

  // The recipients' countries and the sending numbers, in two reads for the whole batch.
  const conversations = ((await db.conversation.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.conversationId))] } },
    select: { id: true, contactId: true, phoneNumberId: true },
  })) ?? []) as { id: string; contactId: string; phoneNumberId: string }[];
  const contacts = ((await db.contact.findMany({
    where: { id: { in: [...new Set(conversations.map((c) => c.contactId))] } },
    select: { id: true, phone: true, bsuid: true },
  })) ?? []) as { id: string; phone: string | null; bsuid: string | null }[];
  const conversationOf = new Map(conversations.map((c) => [c.id, c]));
  const contactOf = new Map(contacts.map((c) => [c.id, c]));

  type Item = { row: Row; actual: bigint; delta: bigint; day: string | null; phoneNumberId: string | null };
  const byTenant = new Map<string, Item[]>();
  let waiting = 0;
  for (const row of rows) {
    const conversation = conversationOf.get(row.conversationId);
    const verdict = settlementFor(row, { card, contact: conversation ? contactOf.get(conversation.contactId) : null, now });
    if (!verdict) {
      waiting++;
      continue;
    }
    const item: Item = {
      row,
      actual: verdict.actualMinor,
      delta: verdict.actualMinor - big(row.estCostMinor),
      day: row.spendDay instanceof Date ? dateToDayKey(row.spendDay) : null,
      phoneNumberId: conversation?.phoneNumberId ?? null,
    };
    byTenant.set(row.tenantId, [...(byTenant.get(row.tenantId) ?? []), item]);
  }

  const tenants: TenantSettlement[] = [];
  let settled = 0;
  for (const [tenantId, items] of byTenant) {
    try {
      const applied = await inSpendTransaction(opts.db, async (tx) => {
        const days: Record<string, bigint> = {};
        const claimed: Item[] = [];
        for (const item of items) {
          const { count } = await tx.message.updateMany({
            where: { id: item.row.id, tenantId, spendState: "settled", pricingSettledAt: null },
            data: { pricingSettledAt: now, costMinor: item.actual },
          });
          if (count !== 1) continue; // another run got it first
          claimed.push(item);
          if (item.day) days[item.day] = (days[item.day] ?? 0n) + item.delta;
        }
        for (const [day, delta] of Object.entries(days)) {
          if (delta !== 0n) await adjustSpent({ tenantId, pot: "messaging", keys: { day, month: monthKeyOfDay(day) }, deltaMinor: delta }, tx);
        }
        return { claimed, days };
      });
      if (applied.claimed.length === 0) continue;
      const deltaMinor = Object.values(applied.days).reduce((a, b) => a + b, 0n);
      settled += applied.claimed.length;
      tenants.push({ tenantId, settled: applied.claimed.length, deltaMinor, days: applied.days, currency });
      await appendStandalone(
        {
          tenantId,
          pot: "messaging",
          action: "messaging.settlement",
          phase: "reconciled",
          actor: { type: "system", job: "spend.messaging.settle" },
          reason: settlementReason(applied.claimed.length, deltaMinor, currency),
          currency,
          amountMinor: deltaMinor,
          snapshot: { messages: applied.claimed.length, days: applied.days, refunds: applied.claimed.filter((i) => i.delta < 0n).length },
          idempotencyKey: `messaging.settlement:${now.toISOString()}:${applied.claimed[0].row.id}`,
        },
        opts.db ? { db: opts.db as unknown as LedgerDb } : {},
      );
      await writePhoneDays(tenantId, applied.claimed, currency, now, db);
    } catch (error) {
      console.error(`[spend] WhatsApp settlement failed for a workspace:`, describeError(error));
    }
  }
  return { scanned: rows.length, settled, waiting, tenants };
}

function settlementReason(count: number, delta: bigint, currency: string | null): string {
  const what = `${count} WhatsApp message${count === 1 ? "" : "s"} settled with Meta's prices`;
  if (delta === 0n || !currency) return `${what}.`;
  const amount = formatMinor(delta < 0n ? -delta : delta, currency);
  return delta < 0n ? `${what}: ${amount} went back to your WhatsApp limit.` : `${what}: ${amount} more than estimated.`;
}

/** Rewrites (SET) the SpendDaily phone rows of the days these messages belong to. Best effort: the dashboard only. */
async function writePhoneDays(tenantId: string, items: { day: string | null; phoneNumberId: string | null }[], currency: string | null, now: Date, db: SpendDb): Promise<void> {
  if (!currency) return;
  const pairs = new Map<string, { phone: string; day: string }>();
  for (const i of items) if (i.day && i.phoneNumberId) pairs.set(`${i.phoneNumberId}|${i.day}`, { phone: i.phoneNumberId, day: i.day });
  for (const { phone, day } of pairs.values()) {
    try {
      const rows = (await db.$queryRawUnsafe(phoneDayStatement().text, tenantId, phone, day)) as { total?: string | number | bigint | null }[];
      const amountMinor = big(rows?.[0]?.total ?? 0);
      const key = { tenantId, pot: "messaging", scopeType: "phone", scopeId: phone, day: dayKeyToDate(day), origin: "platform" };
      await db.spendDaily.upsert({
        where: { tenantId_pot_scopeType_scopeId_day_origin: key },
        create: { ...key, currency, amountMinor, source: "pricing", syncedAt: now },
        update: { amountMinor, currency, source: "pricing", syncedAt: now },
      });
    } catch (error) {
      console.error("[spend] a WhatsApp daily cost row could not be written:", describeError(error));
    }
  }
}
