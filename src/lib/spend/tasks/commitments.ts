/** The commitments reconciler as a worker task (docs/SPEND-CONTROLS-SPEC.md 4.6, 4.16): every 2 minutes, from the daemon or tick. */
import type { JobHandler } from "@/lib/queue";
import type { PeriodicTask } from "@/worker/registry";
import { reconcileCommitments, RECONCILE_EVERY_MS } from "../reconcile";

export const queues: Record<string, JobHandler> = {};

export const periodic: PeriodicTask[] = [{ name: "spend.commitments.reconcile", everyMs: RECONCILE_EVERY_MS, run: () => reconcileCommitments() }];
