import type { WorkerModule } from "@/worker/registry";
import { processDelivery } from "./deliver";
import { DELIVERY_QUEUE } from "./events";

/** Queues this area consumes and scheduled tasks it needs. The worker loop runs everything listed here. */
export const worker: WorkerModule = {
  queues: { [DELIVERY_QUEUE]: (payload, context) => processDelivery(payload, context) },
  periodic: [],
};
