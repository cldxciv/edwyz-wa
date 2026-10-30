import { prisma } from "@/lib/db";
import { WINDOW_MS, portfolioLimit } from "./throttle";

export type PortfolioPhone = { id: string; messagingLimitTier: string | null; qualityRating: string | null };

/**
 * Every number that shares the messaging limit with this one: the numbers whose WhatsApp Business Account belongs to the
 * same Meta business portfolio. When the portfolio id is unknown, only the numbers of the same account are grouped.
 */
export async function portfolioPhones(tenantId: string, wabaRefId: string): Promise<PortfolioPhone[]> {
  const waba = await prisma.waba.findFirst({ where: { id: wabaRefId, tenantId }, select: { businessId: true } });
  return prisma.phoneNumber.findMany({
    where: { tenantId, waba: waba?.businessId ? { businessId: waba.businessId } : { id: wabaRefId } },
    select: { id: true, messagingLimitTier: true, qualityRating: true },
  });
}

export type WindowUsage = { count: number; oldest: Date | null };

/**
 * Unique people (not messages) that received a business-started template message from any of these numbers in the last
 * 24 hours, whatever sent it: a broadcast, an automation, a chatbot, the API or an agent. Queued messages count because they
 * are about to be sent. This is a safe upper bound: Meta does not count people who wrote to you first inside the 24 hour chat window.
 */
export async function uniqueRecipientsInWindow(tenantId: string, phoneIds: readonly string[], now: Date): Promise<WindowUsage> {
  if (phoneIds.length === 0) return { count: 0, oldest: null };
  const since = new Date(now.getTime() - WINDOW_MS);
  const rows = await prisma.$queryRaw<{ n: bigint | number; oldest: Date | null }[]>`
    SELECT COUNT(DISTINCT c."contactId") AS n, MIN(m."createdAt") AS oldest
    FROM "Message" m
    JOIN "Conversation" c ON c.id = m."conversationId" AND c."tenantId" = m."tenantId"
    WHERE m."tenantId" = ${tenantId}
      AND m."direction" = 'outbound' AND m."type" = 'template' AND m."status" <> 'failed'
      AND m."createdAt" >= ${since}
      AND c."phoneNumberId" = ANY(${[...phoneIds]}::text[])`;
  return { count: Number(rows[0]?.n ?? 0), oldest: rows[0]?.oldest ?? null };
}

export type PortfolioUsage = { limit: number; used: number; oldest: Date | null; phones: PortfolioPhone[] };

export async function portfolioUsage(tenantId: string, wabaRefId: string, now: Date): Promise<PortfolioUsage> {
  const phones = await portfolioPhones(tenantId, wabaRefId);
  const { count, oldest } = await uniqueRecipientsInWindow(
    tenantId,
    phones.map((p) => p.id),
    now,
  );
  return { limit: portfolioLimit(phones.map((p) => p.messagingLimitTier)), used: count, oldest, phones };
}
