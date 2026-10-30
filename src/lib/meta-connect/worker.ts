import { audit } from "@/lib/auth/audit";
import { openSecret } from "@/lib/crypto/secrets";
import { prisma } from "@/lib/db";
import { GraphError } from "@/lib/graph";
import { tenantMayRunBackground } from "@/lib/tenant-state";
import type { WorkerModule } from "@/worker/registry";
import { verifyLeadSubscriptions } from "./discovery";
import { debugToken, finishPendingDisconnects, healthStatus } from "./service";

const BATCH = 200;
const VERIFY_BUDGET_MS = 5 * 60_000;

/**
 * Checks every live connection with debug_token and flags those that are expiring or expired. Returns the number whose status changed.
 * For connections that stay usable it also reads back the Pages whose lead-alert subscription has not been confirmed for 24 hours
 * (one shared 5 minute budget per run) and sets the ones Meta no longer lists back to pending.
 */
export async function checkTokenHealth(now = new Date()): Promise<number> {
  const rows = await prisma.metaConnection.findMany({
    where: { status: { in: ["active", "expiring", "error"] } },
    orderBy: { lastCheckedAt: { sort: "asc", nulls: "first" } },
    take: BATCH,
  });
  let changed = 0;
  const verifyDeadline = Date.now() + VERIFY_BUDGET_MS;
  for (const c of rows) {
    if (!(await tenantMayRunBackground(c.tenantId))) {
      // Not checked, but moved to the back of the lastCheckedAt ordering. Otherwise blocked connections stay at the front and,
      // once BATCH of them exist, healthy connections are never health-checked.
      await prisma.metaConnection.updateMany({ where: { id: c.id, tenantId: c.tenantId }, data: { lastCheckedAt: now } }).catch(() => undefined);
      continue;
    }
    try {
      const info = await debugToken(openSecret(c.tenantId, c.tokenEnc));
      const status = healthStatus(info, now.getTime());
      await prisma.metaConnection.updateMany({
        where: { id: c.id, tenantId: c.tenantId },
        data: { status, scopes: info.scopes.length ? info.scopes : c.scopes, tokenExpiresAt: info.expiresAt, lastCheckedAt: now },
      });
      if (status !== c.status) {
        changed++;
        await audit({ tenantId: c.tenantId, action: `meta_connect.${status}`, target: c.id });
      }
      if (status !== "expired" && Date.now() < verifyDeadline) {
        await verifyLeadSubscriptions(c.tenantId, c.id, { deadline: verifyDeadline }).catch(() => undefined);
      }
    } catch (e) {
      if (e instanceof GraphError && e.code === 190) {
        await prisma.metaConnection.updateMany({ where: { id: c.id, tenantId: c.tenantId }, data: { status: "expired", lastCheckedAt: now } });
        changed++;
        await audit({ tenantId: c.tenantId, action: "meta_connect.expired", target: c.id });
      } else {
        await prisma.metaConnection.updateMany({ where: { id: c.id, tenantId: c.tenantId }, data: { lastCheckedAt: now } });
        console.warn("[meta-connect] health check failed for one connection");
      }
    }
  }
  return changed;
}

export const worker: WorkerModule = {
  queues: {},
  periodic: [
    { name: "meta-token-health", everyMs: 6 * 3_600_000, run: () => checkTokenHealth() },
    // Completes disconnects that died between the committed revoke and the deletion of the tokens (Page unsubscribes, user revoke).
    { name: "meta-disconnect-resume", everyMs: 10 * 60_000, run: () => finishPendingDisconnects() },
  ],
};
