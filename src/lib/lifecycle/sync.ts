import { prisma } from "@/lib/db";
import { syncTemplates } from "@/lib/templates/service";
import { readState, writeState } from "./state";

export const SYNC_PER_RUN = 20;
const CURSOR_KEY = "lifecycle:templatesync:cursor";

/** Syncs templates for up to 20 connected workspaces per run, continuing after the last one next time. */
export async function runTemplateSync(): Promise<{ synced: number; failed: number }> {
  const cursor = (await readState<{ after: string | null }>(CURSOR_KEY))?.after ?? null;
  const tenants = await prisma.tenant.findMany({
    where: { deletedAt: null, status: "active", wabas: { some: {} }, ...(cursor ? { id: { gt: cursor } } : {}) },
    select: { id: true },
    orderBy: { id: "asc" },
    take: SYNC_PER_RUN,
  });
  let synced = 0;
  let failed = 0;
  for (const t of tenants) {
    try {
      await syncTemplates({ userId: "system", tenantId: t.id, role: "owner" });
      synced++;
    } catch {
      failed++;
    }
  }
  const finished = tenants.length < SYNC_PER_RUN;
  await writeState(CURSOR_KEY, { after: finished ? null : tenants[tenants.length - 1].id });
  return { synced, failed };
}
