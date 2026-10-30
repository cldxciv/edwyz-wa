import { prisma } from "@/lib/db";
import { addDays } from "./range";

export const TENANTS_PER_RUN = 50;
export const FINAL_PASS_DAYS_AGO = 4;
export const PLATFORM_SCOPE = "platform";

/** Marker keys start with an underscore and are excluded from platform totals. */
const DONE = "_done";
const FINAL = "_final";

export const tenantScope = (tenantId: string) => `tenant:${tenantId}`;

export type DayCounters = {
  messages_in: number;
  messages_out: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  conversations_opened: number;
  broadcast_recipients_sent: number;
};

const bounds = (day: string) => ({ start: new Date(`${day}T00:00:00.000Z`), end: new Date(`${addDays(day, 1)}T00:00:00.000Z`) });

/** Counters for one UTC day of one tenant. Pure reads with tenantId and date filters. */
export async function computeTenantDay(tenantId: string, day: string): Promise<DayCounters> {
  const { start, end } = bounds(day);
  const [msg, conv, recipients] = await Promise.all([
    prisma.$queryRaw<Record<string, bigint>[]>`
      SELECT
        count(*) FILTER (WHERE direction = 'inbound') AS messages_in,
        count(*) FILTER (WHERE direction = 'outbound') AS messages_out,
        count(*) FILTER (WHERE direction = 'outbound' AND status IN ('sent', 'delivered', 'read')) AS sent,
        count(*) FILTER (WHERE direction = 'outbound' AND status IN ('delivered', 'read')) AS delivered,
        count(*) FILTER (WHERE direction = 'outbound' AND status = 'read') AS read,
        count(*) FILTER (WHERE direction = 'outbound' AND status = 'failed') AS failed
      FROM "Message" WHERE "tenantId" = ${tenantId} AND "createdAt" >= ${start} AND "createdAt" < ${end}`,
    prisma.conversation.count({ where: { tenantId, createdAt: { gte: start, lt: end } } }),
    prisma.broadcastRecipient.count({ where: { tenantId, status: { in: ["sent", "delivered", "read"] }, sentAt: { gte: start, lt: end } } }),
  ]);
  const m = msg[0] ?? {};
  const n = (k: string) => Number(m[k] ?? 0);
  return {
    messages_in: n("messages_in"),
    messages_out: n("messages_out"),
    sent: n("sent"),
    delivered: n("delivered"),
    read: n("read"),
    failed: n("failed"),
    conversations_opened: conv,
    broadcast_recipients_sent: recipients,
  };
}

async function setMetric(scope: string, day: string, key: string, value: number) {
  await prisma.dailyMetric.upsert({
    where: { scope_day_key: { scope, day, key } },
    create: { scope, day, key, value },
    update: { value },
  });
}

async function pendingTenants(day: string, marker: string, limit: number): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT t.id FROM "Tenant" t
    WHERE NOT EXISTS (
      SELECT 1 FROM "DailyMetric" d WHERE d.scope = 'tenant:' || t.id AND d.day = ${day} AND d.key = ${marker}
    )
    ORDER BY t.id LIMIT ${limit}`;
  return rows.map((r) => r.id);
}

/** Sums finished tenant rows into scope "platform" for the admin agent. */
export async function rollupPlatform(day: string) {
  const rows = await prisma.$queryRaw<{ key: string; total: bigint }[]>`
    SELECT key, sum(value) AS total FROM "DailyMetric"
    WHERE scope LIKE 'tenant:%' AND day = ${day} AND key NOT LIKE '\\_%'
    GROUP BY key`;
  for (const row of rows) await setMetric(PLATFORM_SCOPE, day, row.key, Number(row.total));
  const tenants = await prisma.$queryRaw<{ c: bigint }[]>`
    SELECT count(*) AS c FROM "DailyMetric" WHERE scope LIKE 'tenant:%' AND day = ${day} AND key = ${DONE}`;
  await setMetric(PLATFORM_SCOPE, day, "tenants_counted", Number(tenants[0]?.c ?? 0));
}

async function missingRollup(day: string) {
  const row = await prisma.dailyMetric.findFirst({ where: { scope: PLATFORM_SCOPE, day, key: "tenants_counted" }, select: { id: true } });
  return !row;
}

async function runPass(day: string, marker: string, budget: number): Promise<{ processed: number; complete: boolean }> {
  const ids = await pendingTenants(day, marker, budget);
  for (const id of ids) {
    const counters = await computeTenantDay(id, day);
    for (const [key, value] of Object.entries(counters)) await setMetric(tenantScope(id), day, key, value);
    await setMetric(tenantScope(id), day, marker, 1);
    if (marker === FINAL) await setMetric(tenantScope(id), day, DONE, 1);
  }
  return { processed: ids.length, complete: ids.length < budget };
}

/**
 * Hourly and idempotent. Pass 1 snapshots yesterday (UTC). Pass 2 re-snapshots the day that is about to start being read
 * from snapshots, so late delivery receipts are included. At most 50 tenants per run; tenants without a marker are
 * picked up on the next run, which acts as the cursor.
 */
export async function runSnapshots(now = new Date(), limit = TENANTS_PER_RUN) {
  const today = now.toISOString().slice(0, 10);
  const yesterday = addDays(today, -1);
  const finalDay = addDays(today, -FINAL_PASS_DAYS_AGO);
  const first = await runPass(yesterday, DONE, limit);
  const second = await runPass(finalDay, FINAL, limit - first.processed);
  if (first.complete && (first.processed > 0 || (await missingRollup(yesterday)))) await rollupPlatform(yesterday);
  if (second.complete && (second.processed > 0 || (await missingRollup(finalDay)))) await rollupPlatform(finalDay);
  return { yesterday: first.processed, final: second.processed };
}
