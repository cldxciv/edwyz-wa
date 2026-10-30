/**
 * The ads data feeds of the spend controls (docs/SPEND-CONTROLS-SPEC.md 6.1, 4.6.1, 4.16). Run by the worker daemon, and
 * by /api/internal/tick when the daemon is down.
 *
 * - spend.sync.fast, every 15 minutes: account and ad set spend (SpendDaily, IntradaySpendSample, outside spend) for
 *   workspaces with an open commitment or a managed Meta limit, then the structure sync of the same accounts, then
 *   spend.breakers.run for each workspace (sync/fast-insights.ts).
 * - spend.sync.structure, every 2 hours: the structure sync for workspaces with platform campaigns but no open commitment
 *   (sync/structure.ts). Reads only; nothing is written to Meta.
 */
import type { JobHandler } from "@/lib/queue";
import type { PeriodicTask } from "@/worker/registry";
import { FAST_SYNC_EVERY_MS, runFastSync } from "../sync/fast-insights";
import { runStructureSync, STRUCTURE_EVERY_MS } from "../sync/structure";

export const queues: Record<string, JobHandler> = {};

export const periodic: PeriodicTask[] = [
  { name: "spend.sync.fast", everyMs: FAST_SYNC_EVERY_MS, run: () => runFastSync() },
  { name: "spend.sync.structure", everyMs: STRUCTURE_EVERY_MS, run: () => runStructureSync() },
];
