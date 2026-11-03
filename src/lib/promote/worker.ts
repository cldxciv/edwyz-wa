/**
 * The WorkerModule of Instagram and Facebook Page ads (docs/IG-PAGE-ADS-SPEC.md 5.5, PRM-00). Registered in MODULES
 * (src/worker/loop.ts), so the daemon and the once-a-minute /api/internal/tick fallback run the same tasks.
 *
 * No queues: PRM-11's promote.audience.forget jobs run from a periodic task of the same name, which must not follow
 * PROMOTE_ENABLED either (see ../forget.ts). Every task
 * calls its function in ./tasks. The feature tasks return at once, with no database call, while PROMOTE_ENABLED=off (train P1,
 * dark). The opt-out sweep is the exception: removing people who withdrew consent from customer lists on Meta is a privacy duty,
 * so it runs whatever the master switch says, whenever a customer-list audience exists (one lookup, no Meta call, when none
 * does). The functions are stubs until the package named in each file fills them in.
 */
import type { PeriodicTask, WorkerModule } from "@/worker/registry";
import { promoteEnabled } from "./flags";
import { customerListAudiencesExist } from "./forget";
import { runAudienceForgetQueue, runAudienceOptOutSweep, runAudienceSync, runAudienceUploads } from "./tasks/audiences";
import { runLeadBackfill } from "./tasks/backfill";
import { runBreakdownSync } from "./tasks/breakdowns";
import { runMediaTask } from "./tasks/media";
import { runReviewSweep, runReviewSync } from "./tasks/review";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** What a task returns while the feature is off. */
export const SKIPPED_OFF = Object.freeze({ skipped: "off" as const });
/** What the opt-out sweep returns while no workspace has a customer-list audience. */
export const SKIPPED_NO_CUSTOMER_LISTS = Object.freeze({ skipped: "no_customer_lists" as const });

/** Runs `work` only while PROMOTE_ENABLED is admins or on; read on every run, so turning the flag on needs no restart. */
export function whenEnabled<T>(work: () => Promise<T>): () => Promise<T | typeof SKIPPED_OFF> {
  return async () => (promoteEnabled() === "off" ? SKIPPED_OFF : work());
}

/**
 * Runs `work` whenever a customer-list audience exists, whatever PROMOTE_ENABLED says: a kill switch or a rollback after customer
 * lists were made must never leave people who withdrew consent in an audience on Meta (5.5).
 */
export function whenCustomerListsExist<T>(work: () => Promise<T>): () => Promise<T | typeof SKIPPED_NO_CUSTOMER_LISTS> {
  return async () => ((await customerListAudiencesExist()) ? work() : SKIPPED_NO_CUSTOMER_LISTS);
}

const task = (name: string, everyMs: number, work: () => Promise<unknown>): PeriodicTask => ({ name, everyMs, run: whenEnabled(work) });

export const worker: WorkerModule = {
  queues: {},
  periodic: [
    task("promote.media", MINUTE, () => runMediaTask()),
    task("promote.review", 15 * MINUTE, () => runReviewSync()),
    task("promote.review.sweep", 2 * HOUR, () => runReviewSweep()),
    task("promote.leads.backfill", 30 * MINUTE, () => runLeadBackfill()),
    task("promote.audiences", 6 * HOUR, () => runAudienceSync()),
    { name: "promote.audiences.optout", everyMs: 24 * HOUR, run: whenCustomerListsExist(() => runAudienceOptOutSweep()) },
    task("promote.breakdowns", 6 * HOUR, () => runBreakdownSync()),
    // PRM-11: the promote.audience.forget jobs (A4), never gated (a privacy duty, see ../forget.ts). A periodic task rather than
    // a queue entry, so each run also deletes the done jobs (and any older than 7 days) with their payloads.
    { name: "promote.audience.forget", everyMs: MINUTE, run: () => runAudienceForgetQueue() },
    // PRM-11: customer-list uploads (A2, A3) a create or refresh queued, sent outside the request; at most 30 s of new batches a
    // run, so a run ends before the next may start. Gated like every feature task, and by PROMOTE_AUDIENCES inside.
    task("promote.audiences.uploads", 2 * MINUTE, () => runAudienceUploads()),
  ],
};
