import { createHash } from "node:crypto";
import { isPlatformAdminEmail } from "@/lib/admin/auth";
import { prisma } from "@/lib/db";
import { disconnect } from "@/lib/meta-connect/service";
import { HttpError } from "@/lib/tenancy";
import { delegateFor, deleteBatched } from "./batch";
import { anonymiseUser } from "./erasure";
import { removeTenantFiles, type FileStore } from "./files";
import { deletableTables } from "./personal-data";

const TENANT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const META_STATE_PREFIX = "meta-connect-state:";

export type WorkspaceErasureResult = {
  /** False when no workspace row existed (a re-run that only swept leftovers). */
  tenantFound: boolean;
  counts: Record<string, number>;
  files: Record<FileStore, number>;
  connectionsRevoked: number;
  connectionsRevokeFailed: number;
  usersAnonymised: number;
};

export type EraseWorkspaceOptions = {
  /** Erase even though a Razorpay subscription is still active or past due. The operator must have cancelled it in Razorpay. */
  allowActiveSubscription?: boolean;
  now?: Date;
};

/** Key of the proof-of-erasure row: a hash of the workspace id and nothing else that identifies the workspace. */
export function tombstoneKey(tenantId: string): string {
  return `erasure:tenant:${createHash("sha256").update(tenantId).digest("hex").slice(0, 32)}`;
}

function assertTenantId(tenantId: string): void {
  if (!TENANT_ID.test(tenantId)) throw new HttpError(400, "Invalid workspace id.");
}

async function assertSubscriptionSettled(tenantId: string, allow: boolean | undefined): Promise<void> {
  const sub = await prisma.subscription.findUnique({ where: { tenantId }, select: { status: true, razorpaySubscriptionId: true } });
  const live = !!sub?.razorpaySubscriptionId && (sub.status === "active" || sub.status === "past_due");
  if (live && !allow) throw new HttpError(409, "This workspace still has an active Razorpay subscription. Cancel it first, or confirm it was cancelled.");
}

/** Best-effort revoke at Meta for every connection that still has a token. Failures never stop the erasure. */
async function revokeConnections(tenantId: string): Promise<{ revoked: number; failed: number }> {
  const connections = await prisma.metaConnection.findMany({ where: { tenantId, status: { not: "revoked" } }, select: { id: true } });
  let revoked = 0;
  let failed = 0;
  for (const c of connections) {
    try {
      await disconnect({ userId: "system", tenantId, role: "owner" }, c.id);
      revoked++;
    } catch {
      failed++;
    }
  }
  return { revoked, failed };
}

async function deleteSettingsRows(tenantId: string): Promise<number> {
  const byKey = await deleteBatched("PlatformSetting", { key: { contains: tenantId } }, "key");
  const state = await deleteBatched("PlatformSetting", { key: { startsWith: META_STATE_PREFIX }, value: { path: ["tenantId"], equals: tenantId } }, "key");
  return byKey + state;
}

async function deleteOrphanWebhookEvents(wabaIds: string[], phoneNumberIds: string[]): Promise<number> {
  let total = 0;
  if (wabaIds.length) total += await deleteBatched("WebhookEvent", { tenantId: null, wabaId: { in: wabaIds } });
  if (phoneNumberIds.length) total += await deleteBatched("WebhookEvent", { tenantId: null, phoneNumberId: { in: phoneNumberIds } });
  return total;
}

/**
 * The GUC the append-only trigger of 0009 checks: DELETE is accepted only while it names the table AND the deleted row's
 * workspace ('<table>:<tenantId>'), in the same transaction.
 */
export const PURGE_GUC = "edwyz.purge";

/** The purge value for one table of one workspace. A row of any other workspace is still refused (42501). */
export function purgeGucValue(table: "SpendLedger" | "SpendConsent", tenantId: string): string {
  return `${table}:${tenantId}`;
}

/**
 * SpendLedger and SpendConsent are append-only by trigger (0009). Erasure is the one exception: inside ONE transaction it sets
 * the transaction-local edwyz.purge to '<table>:<tenantId>' right before deleting that table's rows for this workspace.
 * set_config(..., true) ends with the transaction, so no other connection or later statement can delete anything, and a
 * delete that reached another workspace's row would fail instead of erasing it.
 */
export async function purgeAppendOnly(tenantId: string): Promise<{ SpendLedger: number; SpendConsent: number }> {
  assertTenantId(tenantId);
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('edwyz.purge', ${purgeGucValue("SpendLedger", tenantId)}, true)`;
      const ledger = await tx.spendLedger.deleteMany({ where: { tenantId } });
      await tx.$executeRaw`SELECT set_config('edwyz.purge', ${purgeGucValue("SpendConsent", tenantId)}, true)`;
      const consent = await tx.spendConsent.deleteMany({ where: { tenantId } });
      return { SpendLedger: ledger.count, SpendConsent: consent.count };
    },
    { maxWait: 10_000, timeout: 120_000 },
  );
}

/** Users left with no workspace are anonymised. Platform admins are never touched. */
async function anonymiseOrphanedUsers(userIds: string[]): Promise<number> {
  if (userIds.length === 0) return 0;
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } });
  let done = 0;
  for (const u of users) {
    if (isPlatformAdminEmail(u.email)) continue;
    if ((await prisma.membership.count({ where: { userId: u.id } })) > 0) continue;
    if ((await anonymiseUser(u.id)).found) done++;
  }
  return done;
}

/**
 * Erases everything one workspace owns, in the order set by PERSONAL_DATA (children first), and nothing of any other workspace.
 * Meta tokens are revoked first, sealed secrets are overwritten before their rows go, files are removed inside DATA_DIR only,
 * and a tombstone (hash of the id and the date) is written in the same transaction that deletes the workspace row.
 * Invoices and payment events are kept as tax law requires. Safe to run again after a failure.
 */
export async function eraseWorkspaceData(tenantId: string, options: EraseWorkspaceOptions = {}): Promise<WorkspaceErasureResult> {
  assertTenantId(tenantId);
  const now = options.now ?? new Date();
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, deletedAt: true } });
  await assertSubscriptionSettled(tenantId, options.allowActiveSubscription);

  if (tenant) {
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { status: "suspended", deletedAt: tenant.deletedAt ?? now, suspendedReason: "Erasure in progress" },
    });
  }

  const [members, wabas, numbers] = await Promise.all([
    prisma.membership.findMany({ where: { tenantId }, select: { userId: true } }),
    prisma.waba.findMany({ where: { tenantId }, select: { wabaId: true } }),
    prisma.phoneNumber.findMany({ where: { tenantId }, select: { phoneNumberId: true } }),
  ]);

  // Meta's spending limit first, while the token still works: the owner's close choice, else keep (SPEND 5.8, 3.5).
  await import("@/lib/spend/metacap/offboard").then((m) => m.offboardTenant(tenantId, "erase")).catch(() => undefined);
  // The owners' WhatsApp alerts held in the platform's notifier workspace, before their channel rows go (SPEND 3.5, 7.4).
  await import("@/lib/spend/notify").then((m) => m.eraseOwnerData(tenantId)).catch(() => undefined);
  const revoke = await revokeConnections(tenantId);

  const counts: Record<string, number> = {};
  for (const entry of deletableTables()) {
    const where = { [entry.tenantColumn ?? "tenantId"]: tenantId };
    if (entry.erase.method === "secrets-then-delete") await delegateFor(entry.id).updateMany({ where, data: entry.erase.overwrite });
    counts[entry.id] = await deleteBatched(entry.id, where, entry.primaryKey);
  }
  Object.assign(counts, await purgeAppendOnly(tenantId));
  // SpendCeiling has no tenantId column: the workspace's own overrides are scope 'tenant' rows keyed by its id (SPEND 3.5).
  counts.SpendCeiling = await deleteBatched("SpendCeiling", { scope: "tenant", scopeId: tenantId });
  counts.WebhookEvent += await deleteOrphanWebhookEvents(
    wabas.map((w) => w.wabaId),
    numbers.map((n) => n.phoneNumberId),
  );
  counts.PlatformSetting = await deleteSettingsRows(tenantId);
  counts.Job = await deleteBatched("Job", { payload: { path: ["tenantId"], equals: tenantId } });

  const files = await removeTenantFiles(tenantId);

  await prisma.$transaction([
    prisma.tenant.deleteMany({ where: { id: tenantId } }),
    prisma.platformSetting.upsert({
      where: { key: tombstoneKey(tenantId) },
      create: { key: tombstoneKey(tenantId), value: { erasedAt: now.toISOString() } },
      update: { value: { erasedAt: now.toISOString() } },
    }),
  ]);

  const usersAnonymised = await anonymiseOrphanedUsers([...new Set(members.map((m) => m.userId))]);

  return { tenantFound: !!tenant, counts, files, connectionsRevoked: revoke.revoked, connectionsRevokeFailed: revoke.failed, usersAnonymised };
}
