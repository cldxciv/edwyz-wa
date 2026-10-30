import { prisma } from "@/lib/db";

export type Meter = "ai_credits" | "ad_accounts" | "posts";

export function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Credits consumed this calendar month (UTC). */
export async function usedThisMonth(tenantId: string, meter: Meter, now = new Date()): Promise<number> {
  const rows = await prisma.usageLedger.aggregate({ where: { tenantId, meter, createdAt: { gte: monthStart(now) } }, _sum: { amount: true } });
  return rows._sum.amount ?? 0;
}

/**
 * What the AI gateway knows about the call behind a usage row (docs/SPEND-CONTROLS-SPEC.md 4.10 step 4): its tokens and
 * model, and whether the gateway has already moved the AI counters (`counted`). Rows without `counted` are a caller that
 * held its credits with reserveCredits() and records them here, so the credits are added to the AI counter as well.
 */
export type UsageDetail = { inputTokens?: number | null; outputTokens?: number | null; model?: string | null; counted?: boolean };

const INT_MAX = 2_147_483_647;
const tokens = (n: number | null | undefined): number | null => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.min(INT_MAX, Math.floor(n)) : null);

/** Records usage. Plan-limit enforcement for AI credits is the AI gateway's (src/lib/spend/exec/ai.ts); callers only record. */
export async function recordUsage(tenantId: string, meter: Meter, amount: number, ref?: { type: string; id: string }, detail?: UsageDetail): Promise<void> {
  if (!Number.isInteger(amount) || amount <= 0) return;
  const inputTokens = tokens(detail?.inputTokens);
  const outputTokens = tokens(detail?.outputTokens);
  const model = typeof detail?.model === "string" && detail.model ? detail.model.slice(0, 100) : null;
  await prisma.usageLedger.create({
    data: {
      tenantId,
      meter,
      amount,
      refType: ref?.type ?? null,
      refId: ref?.id ?? null,
      ...(inputTokens !== null ? { inputTokens } : {}),
      ...(outputTokens !== null ? { outputTokens } : {}),
      ...(model ? { model } : {}),
    },
  });
  if (meter === "ai_credits" && !detail?.counted) {
    // Loaded on use so that importing this module does not pull in the spend controls. Never throws: the row is written.
    try {
      const { countLegacyAiUsage } = await import("@/lib/spend/exec/ai");
      await countLegacyAiUsage(tenantId, amount);
    } catch (error) {
      console.warn(`[usage] AI credits recorded but not counted: ${error instanceof Error ? error.name : "error"}`);
    }
  }
}

/** AI credit prices, in credits. One text reply = 1, one image = 5, one short video = 25. Tune here only. */
export const CREDIT_COST = { text: 1, image: 5, video: 25 } as const;
