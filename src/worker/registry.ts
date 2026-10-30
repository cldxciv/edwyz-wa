import type { JobHandler } from "@/lib/queue";

export type PeriodicTask = {
  /** Unique name. Also the key used for the cross-process lease. */
  name: string;
  /** Minimum time between runs, across all worker processes. */
  everyMs: number;
  run: () => Promise<unknown>;
};

/** What a feature module contributes to the worker: job queues it consumes and scheduled tasks it needs. */
export type WorkerModule = {
  queues: Record<string, JobHandler>;
  periodic: PeriodicTask[];
};
