import { prisma } from "@/lib/db";
import type { Actor } from "@/lib/tenancy";
import { type Funnel, buildFunnel, mergeCounts } from "./funnel";
import { ownedBroadcast } from "./service";
import { portfolioUsage } from "./portfolio";
import { topTier } from "./throttle";

const num = (rows: { n: bigint | number }[]) => Number(rows[0]?.n ?? 0);

/** Recipients with an inbound message within 24 h after their send time. */
async function repliedForBroadcast(tenantId: string, broadcastId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: bigint | number }[]>`
    SELECT COUNT(DISTINCT r.id) AS n
    FROM "BroadcastRecipient" r
    JOIN "Conversation" c ON c."contactId" = r."contactId" AND c."tenantId" = r."tenantId"
    JOIN "Message" m ON m."conversationId" = c.id AND m."tenantId" = r."tenantId"
    WHERE r."tenantId" = ${tenantId} AND r."broadcastId" = ${broadcastId}
      AND r."sentAt" IS NOT NULL AND m."direction" = 'inbound'
      AND m."createdAt" > r."sentAt" AND m."createdAt" <= r."sentAt" + interval '24 hours'`;
  return num(rows);
}

async function repliedSince(tenantId: string, since: Date): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: bigint | number }[]>`
    SELECT COUNT(DISTINCT r.id) AS n
    FROM "BroadcastRecipient" r
    JOIN "Broadcast" b ON b.id = r."broadcastId" AND b."tenantId" = r."tenantId"
    JOIN "Conversation" c ON c."contactId" = r."contactId" AND c."tenantId" = r."tenantId"
    JOIN "Message" m ON m."conversationId" = c.id AND m."tenantId" = r."tenantId"
    WHERE r."tenantId" = ${tenantId} AND b."startedAt" >= ${since}
      AND r."sentAt" IS NOT NULL AND m."direction" = 'inbound'
      AND m."createdAt" > r."sentAt" AND m."createdAt" <= r."sentAt" + interval '24 hours'`;
  return num(rows);
}

export async function broadcastFunnel(actor: Actor, broadcastId: string): Promise<Funnel> {
  await ownedBroadcast(actor, broadcastId);
  const [groups, replied] = await Promise.all([
    prisma.broadcastRecipient.groupBy({ by: ["status"], where: { tenantId: actor.tenantId, broadcastId }, _count: { _all: true } }),
    repliedForBroadcast(actor.tenantId, broadcastId),
  ]);
  return buildFunnel(mergeCounts(groups), replied);
}

export async function tenantFunnel(actor: Actor, days: number, now = new Date()): Promise<Funnel> {
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const [groups, replied] = await Promise.all([
    prisma.broadcastRecipient.groupBy({ by: ["status"], where: { tenantId: actor.tenantId, broadcast: { startedAt: { gte: since } } }, _count: { _all: true } }),
    repliedSince(actor.tenantId, since),
  ]);
  return buildFunnel(mergeCounts(groups), replied);
}

/**
 * Per number: the stored tier and quality (null when Meta has not reported them), plus the portfolio-wide use of the shared
 * messaging limit: unique people who got a business-started template in the last 24 hours from any number of the portfolio.
 */
export async function numberLimits(actor: Actor, now = new Date()) {
  const phones = await prisma.phoneNumber.findMany({
    where: { tenantId: actor.tenantId },
    orderBy: { createdAt: "asc" },
    select: { id: true, wabaRefId: true, displayPhone: true, verifiedName: true, qualityRating: true, messagingLimitTier: true },
  });
  const usageByWaba = new Map<string, Awaited<ReturnType<typeof portfolioUsage>>>();
  const out = [];
  for (const { wabaRefId, ...p } of phones) {
    let usage = usageByWaba.get(wabaRefId);
    if (!usage) {
      usage = await portfolioUsage(actor.tenantId, wabaRefId, now);
      usageByWaba.set(wabaRefId, usage);
    }
    out.push({ ...p, portfolioTier: topTier(usage.phones), sentLast24h: usage.used });
  }
  return out;
}

export async function campaignOverview(actor: Actor, days = 30) {
  const [phones, funnel] = await Promise.all([numberLimits(actor), tenantFunnel(actor, days)]);
  return { days, phones, funnel };
}
