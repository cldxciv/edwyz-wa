/**
 * Ledger and counter checks of the spend controls (docs/SPEND-CONTROLS-SPEC.md 9.1, 4.16).
 *
 * - spend.counters.verify (every 15 min): rebuilds SpendCounter.reservedMinor from the open rows (held reservations, minus
 *   what messages already consumed, plus messages still `reserved`). It is ONE statement that applies the drift found as a
 *   delta (reservedMinor - drift), so a lock-free reservation that commits at the same moment is never overwritten.
 * - spend.reservations.expire (every 5 min): releases holds and AI-call reservations past expiresAt (readers already ignore
 *   them, 4.16).
 * - spend.ledger.crosscheck (nightly): flags requests with no outcome after 1 hour as orphans (standalone rows are skipped),
 *   and rebuilds this month's spentMinor from the settled rows to compare it with the counters; a drift over 1% is an alert
 *   (stored for the admin panel and logged). It does not overwrite spentMinor: settlement deltas belong to the senders.
 */
import { prisma } from "@/lib/db";
import { describeError } from "@/lib/safe-error";
import type { JobHandler } from "@/lib/queue";
import type { PeriodicTask } from "@/worker/registry";
import type { SpendDb } from "../control";
import { expireReservations } from "../reservations";
import { dayKeyToDate, monthEndDay, monthStartDay } from "../periods";

const HOUR = 3_600_000;
export const ORPHAN_AFTER_MS = HOUR;
/** Requests are crosschecked this far back. */
export const ORPHAN_WINDOW_MS = 7 * 24 * HOUR;
export const ORPHANS_KEY = "spend:ledger:orphans";
export const DRIFT_KEY = "spend:counters:drift";
/** Drift above this share of the rebuilt figure is an alert (9.1). */
export const DRIFT_ALERT_PCT = 1;

/** The verify statement: one snapshot for counters and open rows; the correction is a delta. */
export const VERIFY_RESERVED_SQL = `/* spend.counters.verify */
WITH open_rows AS (
  SELECT "tenantId", "pot", 'day' AS kind, "dayKey" AS key, ("amountMinor" - "consumedMinor") AS amt FROM "SpendReservation" WHERE "status" = 'held'
  UNION ALL
  SELECT "tenantId", "pot", 'month', "monthKey", ("amountMinor" - "consumedMinor") FROM "SpendReservation" WHERE "status" = 'held'
  UNION ALL
  SELECT "tenantId", 'messaging', 'day', to_char("spendDay", 'YYYY-MM-DD'), COALESCE("estCostMinor", 0) FROM "Message" WHERE "spendState" = 'reserved' AND "spendDay" IS NOT NULL
  UNION ALL
  SELECT "tenantId", 'messaging', 'month', to_char("spendDay", 'YYYY-MM'), COALESCE("estCostMinor", 0) FROM "Message" WHERE "spendState" = 'reserved' AND "spendDay" IS NOT NULL
), expected AS (
  SELECT "tenantId", "pot", kind, key, SUM(amt)::bigint AS amt FROM open_rows GROUP BY 1, 2, 3, 4
), drift AS (
  SELECT c."tenantId", c."pot", c."periodKind", c."periodKey", (c."reservedMinor" - COALESCE(e.amt, 0))::bigint AS drift
  FROM "SpendCounter" c
  LEFT JOIN expected e ON e."tenantId" = c."tenantId" AND e."pot" = c."pot" AND e.kind = c."periodKind" AND e.key = c."periodKey"
  WHERE c."reservedMinor" <> COALESCE(e.amt, 0)
)
UPDATE "SpendCounter" c
SET "reservedMinor" = GREATEST(0, c."reservedMinor" - d.drift), "reconciledAt" = now(), "updatedAt" = now()
FROM drift d
WHERE c."tenantId" = d."tenantId" AND c."pot" = d."pot" AND c."periodKind" = d."periodKind" AND c."periodKey" = d."periodKey"
RETURNING c."tenantId", c."pot", c."periodKind", c."periodKey", d.drift::text AS drift`;

type RawDb = Pick<SpendDb, "$queryRawUnsafe">;

export type VerifyResult = { corrected: number; rows: { tenantId: string; pot: string; periodKind: string; periodKey: string; drift: bigint }[] };

/** Rebuilds reservedMinor from the open rows (9.1). Logs ids, pots, keys and amounts only. */
export async function verifyCounters(db: RawDb = prisma): Promise<VerifyResult> {
  const rows = (((await db.$queryRawUnsafe(VERIFY_RESERVED_SQL)) ?? []) as Record<string, unknown>[]).map((r) => ({
    tenantId: String(r.tenantId),
    pot: String(r.pot),
    periodKind: String(r.periodKind),
    periodKey: String(r.periodKey),
    drift: BigInt(String(r.drift ?? "0")),
  }));
  if (rows.length > 0) console.warn(`[spend] counters.verify corrected ${rows.length} reserved totals`, JSON.stringify(rows.map((r) => ({ ...r, drift: r.drift.toString() }))));
  return { corrected: rows.length, rows };
}

export type OrphanRow = { tenantId: string; correlationId: string; action: string; createdAt: string };

/**
 * Requests older than an hour with no outcome (9.1). Standalone rows (refused, shadow, info, reconciled) have no request and
 * are never orphans. Stored in PlatformSetting spend:ledger:orphans for the admin panel.
 */
export async function crosscheckOrphans(opts: { db?: SpendDb; now?: Date; limit?: number } = {}): Promise<OrphanRow[]> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const requests = ((await db.spendLedger.findMany({
    where: { phase: "requested", createdAt: { lt: new Date(now.getTime() - ORPHAN_AFTER_MS), gte: new Date(now.getTime() - ORPHAN_WINDOW_MS) } },
    select: { tenantId: true, correlationId: true, action: true, createdAt: true },
    orderBy: { seq: "asc" },
    take: 5_000,
  })) ?? []) as { tenantId: string; correlationId: string; action: string; createdAt: Date }[];
  if (requests.length === 0) {
    await storeSetting(db, ORPHANS_KEY, { checkedAt: now.toISOString(), count: 0, items: [] });
    return [];
  }
  const outcomes = ((await db.spendLedger.findMany({
    where: { correlationId: { in: requests.map((r) => r.correlationId) }, phase: { in: ["applied", "failed", "unconfirmed", "refused", "reconciled"] } },
    select: { tenantId: true, correlationId: true },
  })) ?? []) as { tenantId: string; correlationId: string }[];
  const closed = new Set(outcomes.map((o) => `${o.tenantId}:${o.correlationId}`));
  const orphans = requests
    .filter((r) => !closed.has(`${r.tenantId}:${r.correlationId}`))
    .slice(0, opts.limit ?? 200)
    .map((r) => ({ tenantId: r.tenantId, correlationId: r.correlationId, action: r.action, createdAt: r.createdAt.toISOString() }));
  await storeSetting(db, ORPHANS_KEY, { checkedAt: now.toISOString(), count: orphans.length, items: orphans });
  if (orphans.length > 0) console.warn(`[spend] ledger.crosscheck found ${orphans.length} requests with no outcome`);
  return orphans;
}

export type DriftRow = { tenantId: string; pot: "messaging" | "ai"; month: string; counter: bigint; rebuilt: bigint; driftPct: number };

/** |counter - rebuilt| as a whole percent of the rebuilt figure (100 when the rebuilt figure is 0 and the counter is not). */
export function driftPercent(counter: bigint, rebuilt: bigint): number {
  const diff = counter > rebuilt ? counter - rebuilt : rebuilt - counter;
  if (diff === 0n) return 0;
  if (rebuilt === 0n) return 100;
  return Number((diff * 10_000n) / rebuilt) / 100;
}

/**
 * Rebuilds this month's spent figure per workspace and compares it with the month counters (9.1):
 * - WhatsApp: the estimates of settled messages of the month plus the month's settlement deltas (ledger messaging.settlement);
 * - AI: the actual credits of settled AI-call reservations of the month.
 * Returns the rows whose drift is over 1%; they are stored in spend:counters:drift and logged. Nothing is overwritten.
 */
export async function crosscheckMonth(month: string, opts: { db?: SpendDb; now?: Date } = {}): Promise<DriftRow[]> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const counters = ((await db.spendCounter.findMany({ where: { periodKind: "month", periodKey: month }, select: { tenantId: true, pot: true, spentMinor: true } })) ?? []) as { tenantId: string; pot: string; spentMinor: bigint }[];
  if (counters.length === 0) return [];
  const tenantIds = [...new Set(counters.map((c) => c.tenantId))];
  const rebuilt = new Map<string, bigint>();
  const add = (key: string, v: bigint) => rebuilt.set(key, (rebuilt.get(key) ?? 0n) + v);
  const from = dayKeyToDate(monthStartDay(month));
  const to = dayKeyToDate(monthEndDay(month));
  const messages = ((await db.message.findMany({ where: { tenantId: { in: tenantIds }, spendState: "settled", spendDay: { gte: from, lte: to } }, select: { tenantId: true, estCostMinor: true } })) ?? []) as { tenantId: string; estCostMinor: bigint | null }[];
  for (const m of messages) add(`${m.tenantId}:messaging`, BigInt(m.estCostMinor ?? 0n));
  // Settlement rows of this month are written from its first local day (up to a day before UTC) until late pricing arrives.
  const settledFrom = new Date(from.getTime() - 2 * 24 * HOUR);
  const settlements = ((await db.spendLedger.findMany({ where: { tenantId: { in: tenantIds }, action: "messaging.settlement", phase: "reconciled", createdAt: { gte: settledFrom } }, select: { tenantId: true, amountMinor: true, snapshot: true, createdAt: true } })) ?? []) as {
    tenantId: string;
    amountMinor: bigint | null;
    snapshot: unknown;
    createdAt: Date;
  }[];
  for (const s of settlements) {
    const snapMonth = s.snapshot && typeof s.snapshot === "object" ? (s.snapshot as { month?: unknown }).month : undefined;
    const rowMonth = typeof snapMonth === "string" ? snapMonth : s.createdAt.toISOString().slice(0, 7);
    if (rowMonth === month) add(`${s.tenantId}:messaging`, BigInt(s.amountMinor ?? 0n));
  }
  const calls = ((await db.spendReservation.findMany({ where: { tenantId: { in: tenantIds }, subjectType: "ai_call", status: "settled", monthKey: month }, select: { tenantId: true, consumedMinor: true } })) ?? []) as { tenantId: string; consumedMinor: bigint }[];
  for (const c of calls) add(`${c.tenantId}:ai`, BigInt(c.consumedMinor ?? 0n));

  const out: DriftRow[] = [];
  for (const c of counters) {
    if (c.pot !== "messaging" && c.pot !== "ai") continue;
    const r = rebuilt.get(`${c.tenantId}:${c.pot}`) ?? 0n;
    const pct = driftPercent(BigInt(c.spentMinor), r);
    if (pct > DRIFT_ALERT_PCT) out.push({ tenantId: c.tenantId, pot: c.pot, month, counter: BigInt(c.spentMinor), rebuilt: r, driftPct: pct });
  }
  await storeSetting(db, DRIFT_KEY, { checkedAt: now.toISOString(), month, count: out.length, items: out.slice(0, 200).map((d) => ({ ...d, counter: d.counter.toString(), rebuilt: d.rebuilt.toString() })) });
  if (out.length > 0) console.warn(`[spend] counters drift over ${DRIFT_ALERT_PCT}% in ${out.length} workspace pots for ${month}`);
  return out;
}

async function storeSetting(db: SpendDb, key: string, value: Record<string, unknown>): Promise<void> {
  try {
    await db.platformSetting.upsert({ where: { key }, create: { key, value: value as object }, update: { value: value as object } });
  } catch (error) {
    console.error(`[spend] could not store ${key}: ${describeError(error)}`);
  }
}

/** The nightly crosscheck: orphans and this month's rebuild (UTC month; each counter key is the workspace's own month). */
export async function nightlyCrosscheck(now = new Date()): Promise<{ orphans: number; drift: number }> {
  const orphans = await crosscheckOrphans({ now });
  const drift = await crosscheckMonth(now.toISOString().slice(0, 7), { now });
  return { orphans: orphans.length, drift: drift.length };
}

export const queues: Record<string, JobHandler> = {};

export const periodic: PeriodicTask[] = [
  { name: "spend.counters.verify", everyMs: 15 * 60_000, run: () => verifyCounters() },
  { name: "spend.reservations.expire", everyMs: 5 * 60_000, run: () => expireReservations() },
  { name: "spend.ledger.crosscheck", everyMs: 24 * HOUR, run: () => nightlyCrosscheck() },
];
