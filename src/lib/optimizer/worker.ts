import { repairStuckOptimizerProposalsOnce } from "@/lib/approvals";
import type { WorkerModule } from "@/worker/registry";
import { pauseAdsForBlockedTenants, runAllTenants } from "./engine";

const DAY_MS = 24 * 60 * 60 * 1000;
const QUARTER_HOUR_MS = 15 * 60 * 1000;

/** Daily run, after the insights snapshots. Only creates proposals and expires old ones. */
export const worker: WorkerModule = {
  queues: {},
  periodic: [
    { name: "optimizer.daily", everyMs: DAY_MS, run: () => runAllTenants() },
    { name: "ads.pause-blocked", everyMs: QUARTER_HOUR_MS, run: () => pauseAdsForBlockedTenants() },
    { name: "optimizer.repair-stuck-approved", everyMs: DAY_MS, run: () => repairStuckOptimizerProposalsOnce() },
  ],
};
