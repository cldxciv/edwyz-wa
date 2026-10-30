import type { WorkerModule } from "@/worker/registry";
import { EVENT_QUEUE } from "./v2/emit";
import { eventJobHandler } from "./v2/event-handler";
import { sendQuotaAlerts } from "./v2/metering";
import { purgeOld, scanNoResponse, scanScheduled, scheduledJobHandler, SCHEDULE_QUEUE } from "./v2/timed";

/**
 * Queues: changes announced by other modules (new contact, tag, detail or status changes) and chunks of scheduled-rule audiences.
 * Periodic: waiting-time checks and schedules every minute, plan quota alerts hourly, log cleanup daily.
 */
export const worker: WorkerModule = {
  queues: { [EVENT_QUEUE]: eventJobHandler, [SCHEDULE_QUEUE]: scheduledJobHandler },
  periodic: [
    { name: "automation-no-response", everyMs: 60_000, run: () => scanNoResponse() },
    { name: "automation-scheduled", everyMs: 60_000, run: () => scanScheduled() },
    { name: "automation-quota-alerts", everyMs: 3_600_000, run: () => sendQuotaAlerts() },
    { name: "automation-purge", everyMs: 24 * 3_600_000, run: () => purgeOld() },
  ],
};
