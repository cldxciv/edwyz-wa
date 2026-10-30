import { prisma } from "@/lib/db";
import { getBillingStatus } from "@/lib/billing";

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; ok: boolean }>();

export function resetTenantStateCache(): void {
  cache.clear();
}

/**
 * True when background work (publishing, reminders, AI replies, ad syncs, sequences) may run for this workspace:
 * it exists, is not deleted or suspended, and billing allows writes (not locked or suspended). Cached for 30 seconds.
 * Workers call this before acting for a tenant; request handlers keep using getActor, which enforces the same rules.
 */
export async function tenantMayRunBackground(tenantId: string, now = Date.now()): Promise<boolean> {
  const hit = cache.get(tenantId);
  if (hit && now - hit.at < TTL_MS) return hit.ok;
  let ok = false;
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { status: true, deletedAt: true } });
    if (tenant && tenant.status === "active" && !tenant.deletedAt) {
      const billing = await getBillingStatus(tenantId);
      ok = billing.canWrite;
    }
  } catch {
    ok = false;
  }
  cache.set(tenantId, { at: now, ok });
  if (cache.size > 5000) cache.clear();
  return ok;
}
