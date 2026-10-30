import { EMAIL_QUEUE, emailJobHandler } from "@/lib/email";
import type { WorkerModule } from "@/worker/registry";
import { runPaymentFailedNotices, runQualityAlerts, runTrialReminders } from "./notices";
import { runDeletionRequestSweep } from "./deletion-requests";
import { runPersonalDataRetention, runRetention } from "./retention";
import { runTemplateSync } from "./sync";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Queues this area consumes and scheduled tasks it needs. The worker loop runs everything listed here. */
export const worker: WorkerModule = {
  queues: { [EMAIL_QUEUE]: emailJobHandler },
  periodic: [
    { name: "lifecycle.trial-reminders", everyMs: HOUR, run: () => runTrialReminders() },
    { name: "lifecycle.payment-failed", everyMs: HOUR, run: () => runPaymentFailedNotices() },
    { name: "lifecycle.quality-alerts", everyMs: 15 * MINUTE, run: () => runQualityAlerts() },
    { name: "lifecycle.retention", everyMs: 24 * HOUR, run: () => runRetention() },
    { name: "lifecycle.retention-personal-data", everyMs: 24 * HOUR, run: () => runPersonalDataRetention() },
    { name: "lifecycle.deletion-requests", everyMs: 5 * MINUTE, run: () => runDeletionRequestSweep() },
    { name: "lifecycle.template-sync", everyMs: 24 * HOUR, run: () => runTemplateSync() },
  ],
};
