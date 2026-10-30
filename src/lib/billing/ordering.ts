import { prisma } from "@/lib/db";

/**
 * Razorpay can deliver webhooks late or out of order, so an old "pending" may arrive after a newer "charged". Each event carries a
 * created_at (unix seconds). The newest one applied per workspace is remembered, and an event older than it is not allowed to move the
 * local status. The key holds the workspace id, so workspace erasure removes it with the other settings.
 */
export const orderKey = (tenantId: string) => `billing:last-event:${tenantId}`;

export async function lastAppliedAt(tenantId: string): Promise<number | null> {
  try {
    const row = await prisma.platformSetting.findUnique({ where: { key: orderKey(tenantId) } });
    const at = (row?.value as { at?: unknown } | null | undefined)?.at;
    return typeof at === "number" ? at : null;
  } catch {
    return null;
  }
}

/** An event with no created_at cannot be ordered and is always applied. */
export async function isStaleEvent(tenantId: string, createdAt: number | null): Promise<boolean> {
  if (createdAt === null) return false;
  const last = await lastAppliedAt(tenantId);
  return last !== null && createdAt < last;
}

export async function markApplied(tenantId: string, at: number | null): Promise<void> {
  if (at === null) return;
  try {
    const last = await lastAppliedAt(tenantId);
    if (last !== null && last >= at) return;
    await prisma.platformSetting.upsert({ where: { key: orderKey(tenantId) }, create: { key: orderKey(tenantId), value: { at } }, update: { value: { at } } });
  } catch {
    console.warn("[billing] could not record the webhook order");
  }
}
