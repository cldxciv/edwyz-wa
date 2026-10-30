import type { Prisma } from "@/generated/prisma/client";
import { audit } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";

const MAX_CONNECTIONS = 200;

export type DeauthorizeResult = { connections: number; workspaces: number };

/**
 * Meta's Deauthorize callback: the Facebook user removed the app, so every token we hold for that user is already dead at Meta.
 * Every MetaConnection of that Meta user (any workspace) is marked revoked and its sealed tokens are wiped, the same end state the
 * normal disconnect reaches (connection token and expiry cleared, assets inactive with their Page tokens removed, lead-alert
 * subscription flags cleared), but without the calls to Meta that disconnect makes: they would only fail with an invalid-token error
 * and delay the answer Meta is waiting for. Idempotent; a connection that is already revoked and empty is left alone.
 * Only the workspace id and the connection id reach the audit log, never the Meta user id or the request payload.
 */
export async function deauthorizeMetaUser(metaUserId: string): Promise<DeauthorizeResult> {
  const rows = await prisma.metaConnection.findMany({
    where: { metaUserId, OR: [{ status: { not: "revoked" } }, { tokenEnc: { not: "" } }] },
    select: { id: true, tenantId: true },
    take: MAX_CONNECTIONS,
  });
  const workspaces = new Set<string>();
  for (const { id, tenantId } of rows) {
    const pages = (await prisma.metaAsset.findMany({ where: { tenantId, connectionId: id, type: "page" }, select: { id: true, meta: true } })) ?? [];
    await prisma.metaConnection.updateMany({ where: { id, tenantId }, data: { status: "revoked", tokenEnc: "", tokenExpiresAt: null } });
    await prisma.metaAsset.updateMany({ where: { tenantId, connectionId: id }, data: { status: "inactive", tokenEnc: null } });
    for (const page of pages) {
      const meta = (page.meta ?? {}) as Record<string, unknown>;
      if (!("leadgenSubscription" in meta)) continue;
      const { leadgenSubscription: _removed, ...rest } = meta;
      await prisma.metaAsset.updateMany({ where: { id: page.id, tenantId }, data: { meta: rest as Prisma.InputJsonObject } });
    }
    workspaces.add(tenantId);
    await audit({ tenantId, action: "meta_connect.deauthorized", target: id, meta: { source: "meta_deauthorize_callback" } });
  }
  if (rows.length === 0) await audit({ action: "meta_connect.deauthorize_received", meta: { connections: 0 } });
  return { connections: rows.length, workspaces: workspaces.size };
}
