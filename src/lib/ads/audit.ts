import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/tenancy";

export type StrictAuditEntry = {
  tenantId: string;
  userId?: string | null;
  action: string;
  target?: string;
  meta?: Record<string, string | number | boolean | null>;
};

const row = (entry: StrictAuditEntry) => ({ tenantId: entry.tenantId, userId: entry.userId ?? null, action: entry.action, target: entry.target ?? null, meta: entry.meta ?? undefined });

/**
 * Writes an AuditLog row and throws when the write fails. Money actions call this BEFORE touching Meta so a database
 * fault stops the request instead of leaving a spending change with no record (the plain audit() helper swallows errors).
 * It records the REQUEST ("..._requested", "launch_started"); what actually happened is recorded by auditOutcome.
 */
export async function auditStrict(entry: StrictAuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({ data: row(entry) });
  } catch {
    console.error("[audit] strict write failed", entry.action);
    throw new HttpError(500, "The audit log could not be written, so nothing was changed. Try again.");
  }
}

/**
 * Records the outcome of an action whose request row was already written (activated, failed, unconfirmed). The state change has
 * happened by then, so this never throws; it retries once. A missing outcome row next to a request row means "unresolved", never "succeeded".
 */
export async function auditOutcome(entry: StrictAuditEntry): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await prisma.auditLog.create({ data: row(entry) });
      return;
    } catch {
      // retry once, then give up below
    }
  }
  console.error("[audit] outcome write failed", entry.action);
}
