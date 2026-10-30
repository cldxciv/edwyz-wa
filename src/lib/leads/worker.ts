import { audit } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { enqueue } from "@/lib/queue";
import { describeError } from "@/lib/safe-error";
import { tenantMayRunBackground } from "@/lib/tenant-state";
import type { WorkerModule } from "@/worker/registry";
import { ingestForTenant, LEAD_QUEUE, parseLeadJob } from "./ingest";
import { runDueSequences } from "./runner";

/** A blocked workspace's lead is re-checked every 15 minutes for up to 7 days; Meta does not redeliver the webhook. */
export const LEAD_DEFER_MS = 15 * 60_000;
export const MAX_LEAD_DEFERRALS = (7 * 86_400_000) / LEAD_DEFER_MS;

type Deferral = { deferrals: number; only: string[] | null };

function readDeferral(payload: unknown): Deferral {
  const p = (payload ?? {}) as { deferrals?: unknown; deferredFor?: unknown };
  const n = typeof p.deferrals === "number" && Number.isFinite(p.deferrals) ? Math.max(0, Math.floor(p.deferrals)) : 0;
  const only = Array.isArray(p.deferredFor) ? p.deferredFor.filter((t): t is string => typeof t === "string") : null;
  return { deferrals: n, only };
}

/**
 * Same fan-out as handleLeadJob, but a workspace that is suspended, deleted or locked is not ingested now. It is not dropped:
 * the job is re-queued for that workspace only (Meta will not send the webhook again), so the lead is ingested once the workspace
 * recovers. After 7 days the lead is given up on and the give-up is audited. Scheduling does not depend on the attempt number:
 * every attempt (including a retry after a crash, a reclaimed job or an error while queueing) schedules the next deferral
 * unless an identical one is already queued, so a lead is never lost between attempts and a retry does not start a second chain.
 */
export async function handleLeadJobForActiveTenants(payload: unknown): Promise<void> {
  const job = parseLeadJob(payload);
  if (!job) return;
  const { deferrals, only } = readDeferral(payload);
  const found = await prisma.metaAsset.findMany({ where: { type: "page", externalId: job.pageId, status: "active" }, select: { id: true, tenantId: true } });
  const assets = only ? found.filter((a) => only.includes(a.tenantId)) : found;
  let failed: unknown = null;
  const blocked: string[] = [];
  for (const asset of assets) {
    if (!(await tenantMayRunBackground(asset.tenantId))) {
      blocked.push(asset.tenantId);
      continue;
    }
    try {
      await ingestForTenant(asset.tenantId, asset.id, job);
    } catch (e) {
      console.error("[leads] ingest failed:", describeError(e));
      failed = e;
    }
  }
  if (blocked.length) await deferBlocked(job, blocked, deferrals);
  if (failed) throw failed;
}

async function deferBlocked(job: { leadgenId: string; pageId: string; formId?: string }, tenantIds: string[], deferrals: number): Promise<void> {
  if (deferrals >= MAX_LEAD_DEFERRALS) {
    for (const tenantId of tenantIds) await audit({ tenantId, action: "leads.fetch_given_up", target: job.leadgenId, meta: { reason: "workspace_inactive" } }).catch(() => undefined);
    return;
  }
  const deferredFor = [...tenantIds].sort();
  if (await alreadyQueued(job.leadgenId, deferrals + 1, deferredFor)) return;
  await enqueue(LEAD_QUEUE, { ...job, deferrals: deferrals + 1, deferredFor }, { runAt: new Date(Date.now() + LEAD_DEFER_MS) });
}

/** True when this very deferral (same lead, same step of the chain, same workspaces) is already waiting or running. A lookup that fails counts as "not queued": a duplicate is harmless because ingesting is idempotent per workspace. */
async function alreadyQueued(leadgenId: string, deferrals: number, deferredFor: string[]): Promise<boolean> {
  try {
    const found = await prisma.job.findFirst({
      where: {
        queue: LEAD_QUEUE,
        status: { in: ["queued", "running"] },
        AND: [{ payload: { path: ["leadgenId"], equals: leadgenId } }, { payload: { path: ["deferrals"], equals: deferrals } }, { payload: { path: ["deferredFor"], equals: deferredFor } }],
      },
      select: { id: true },
    });
    return Boolean(found);
  } catch {
    return false;
  }
}

export const worker: WorkerModule = {
  queues: { [LEAD_QUEUE]: (payload) => handleLeadJobForActiveTenants(payload) },
  periodic: [{ name: "leads.sequences", everyMs: 30_000, run: () => runDueSequences() }],
};
