/**
 * promote.breakdowns, every 6 h (docs/IG-PAGE-ADS-SPEC.md 3.10, 4.2 R3 to R5 and R3a, 4.9, 5.5, PRM-12): results by placement,
 * creative, age and gender, region and the run total of Edwyz's own campaigns into InsightBreakdown. Each dimension of an
 * account backfills 30 days until its reads finish uncut, then refreshes the last 3, at throttle priority 5, with at most
 * 20,000 rows a sync and 100,000 a workspace. A read Meta refuses is logged and the others still run. The worker
 * (../worker.ts) skips it while PROMOTE_ENABLED=off.
 *
 * The work lives in src/lib/ads/insights-sync.ts (runBreakdownSync), which reads Meta only through ads/insights-fetch.ts. It is
 * loaded on the first run, so the worker module itself imports neither the database nor the Graph client. With no launched
 * platform ad it makes one database read and no Meta call.
 */
import type { BreakdownSyncResult } from "@/lib/ads/insights-sync";

export type BreakdownTaskResult = BreakdownSyncResult;

export async function runBreakdownSync(): Promise<BreakdownTaskResult> {
  const sync = await import("@/lib/ads/insights-sync");
  return sync.runBreakdownSync();
}
