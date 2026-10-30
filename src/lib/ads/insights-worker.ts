import type { WorkerModule } from "@/worker/registry";
import { SYNC_QUEUE, runInsightsSync, syncTenant } from "./insights-sync";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/*
 * Runs every 6 hours rather than once a day so that a run stopped by a Meta rate limit resumes soon.
 * Each run refreshes the last 3 days; an account's first run backfills 30 days.
 */
export const worker: WorkerModule = {
  queues: {
    [SYNC_QUEUE]: async (payload) => {
      const tenantId = (payload as { tenantId?: unknown } | null)?.tenantId;
      if (typeof tenantId !== "string" || !tenantId) throw new Error("Missing tenantId");
      await syncTenant(tenantId);
    },
  },
  periodic: [{ name: "ads.insights.daily", everyMs: SIX_HOURS_MS, run: () => runInsightsSync() }],
};
