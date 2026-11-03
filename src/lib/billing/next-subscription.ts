/**
 * The light part of a planned plan change (plan-change.ts has the rest): where it is stored, and the one fact the paywall
 * (status.ts, read on every request) needs from it. Kept apart so the paywall does not load the Razorpay and invoice code.
 */
import { prisma } from "@/lib/db";

/** PlatformSetting `billing:plan-change:<tenantId>`: the key holds the workspace id, so workspace erasure removes it. */
export const PLAN_CHANGE_PREFIX = "billing:plan-change:";
export const planChangeKey = (tenantId: string) => `${PLAN_CHANGE_PREFIX}${tenantId}`;

/**
 * Days a workspace keeps access after its plan ended while the approved new plan that starts that day waits for its first
 * payment. A card is charged within minutes, but UPI AutoPay sends a notice a day before the debit and a bank mandate can take a
 * few working days. The platform's payment grace applies when it is longer.
 */
export const NEXT_START_GRACE_DAYS = 5;

/**
 * When the approved new subscription (kind next_subscription, authorized) is set to start, or null when there is none.
 * Never throws: when it cannot be read, the workspace is treated as having none (the paywall then applies as before).
 */
export async function approvedNextStart(tenantId: string): Promise<Date | null> {
  try {
    const row = await prisma.platformSetting.findUnique({ where: { key: planChangeKey(tenantId) } });
    const v = row?.value;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const state = v as Record<string, unknown>;
    if (state.kind !== "next_subscription" || state.authorized !== true || typeof state.at !== "string") return null;
    const at = new Date(state.at);
    return Number.isNaN(at.getTime()) ? null : at;
  } catch {
    return null;
  }
}
