import { getBillingStatus } from "@/lib/billing";
import { prisma } from "@/lib/db";
import { tenantMayRunBackground } from "@/lib/tenant-state";

export type Blocked = "inactive" | "locked" | null;
export type Gate = "ok" | "blocked" | "unknown";

/**
 * "inactive": suspended or deleted. "locked": billing says it cannot write. null: usable, or a read error (an error is never
 * treated as blocked, so a database blip cannot pause anyone's ads or broadcasts). Not cached: callers use it to confirm.
 */
export async function blockedState(tenantId: string): Promise<Blocked> {
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { status: true, deletedAt: true } });
    if (!tenant || tenant.status !== "active" || tenant.deletedAt) return "inactive";
    return (await getBillingStatus(tenantId)).canWrite ? null : "locked";
  } catch {
    return null;
  }
}

/**
 * Tri-state gate for work that a person would have to undo by hand (pausing a broadcast).
 * "ok": background work may run. "blocked": the workspace is confirmed suspended, deleted or locked.
 * "unknown": tenantMayRunBackground said no, but a fresh read cannot confirm a block (its own read failed and cached a false for
 * 30 seconds, or the workspace has just recovered): callers wait and look again instead of acting on a guess.
 */
export async function backgroundGate(tenantId: string): Promise<Gate> {
  if (await tenantMayRunBackground(tenantId)) return "ok";
  return (await blockedState(tenantId)) ? "blocked" : "unknown";
}
