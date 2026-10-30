import type { WorkerModule } from "@/worker/registry";
import { runSnapshots } from "./snapshot";

const HOUR_MS = 60 * 60 * 1000;

/** Queues this area consumes and scheduled tasks it needs. The worker loop runs everything listed here. */
export const worker: WorkerModule = {
  queues: {},
  periodic: [{ name: "reports.daily-metrics", everyMs: HOUR_MS, run: () => runSnapshots() }],
};
