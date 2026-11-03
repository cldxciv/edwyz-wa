/**
 * Audiences (docs/IG-PAGE-ADS-SPEC.md 3.7, 5.5, PRM-11). The work lives in ../audiences.ts and ../forget.ts and is loaded on
 * the first run, so the worker module itself imports neither the database nor the Graph client.
 * - promote.audiences, every 6 h: each Meta-backed audience not read for 5 hours: A5 maps its status (draft, populating, ready,
 *   too_small or error) and size range. It sends no customers. An audience whose read fails is stamped and tried on the next
 *   run, behind the healthy ones; an ad account Meta calls busy waits without holding up the others. The worker
 *   (../worker.ts) skips it while PROMOTE_ENABLED=off.
 * - promote.audiences.uploads, every 2 minutes: sends the open customer-list uploads (A2, A3) that a create or a refresh queued,
 *   for at most 30 seconds of new batches a run, resuming each at its next batch_seq. With customer lists switched off
 *   (PROMOTE_AUDIENCES below all, or production without LEGAL_DPDP_AUDIENCES_OK=1) it closes them and sends nothing. Skipped
 *   while PROMOTE_ENABLED=off, like every feature task.
 * - promote.audiences.optout, daily: contacts whose marketing opt-in was withdrawn (at least the last 26 hours, or since the
 *   stored cursor `promote:optout-cursor` when that is older, so a sweep that was paused, failed or ran late catches up; the
 *   first run starts at the oldest customer list), in workspaces with customer-list audiences, go through the same forget path
 *   as an erased contact. The worker runs it whenever a customer-list audience exists, even while PROMOTE_ENABLED=off: a
 *   privacy duty, not a feature.
 * - promote.audience.forget, every minute: the forget jobs (A4), then every done job, and any older than 7 days, is deleted.
 *   Never gated by a switch, for the same reason.
 */
export type AudienceTaskResult = { audiences: number; updated: number; failed: number };
export type AudienceUploadResult = { uploads: number; done: number; waiting: number; failed: number };
export type AudienceOptOutResult = { contacts: number; queued: number };
export type AudienceForgetResult = { sent: number; purged: number };

export async function runAudienceSync(): Promise<AudienceTaskResult> {
  const { syncAudiences } = await import("../audiences");
  return syncAudiences();
}

export async function runAudienceUploads(): Promise<AudienceUploadResult> {
  const { sendQueuedUploads } = await import("../audiences");
  return sendQueuedUploads();
}

export async function runAudienceOptOutSweep(): Promise<AudienceOptOutResult> {
  const { sweepOptOuts } = await import("../forget");
  return sweepOptOuts();
}

export async function runAudienceForgetQueue(): Promise<AudienceForgetResult> {
  const { runForgetQueue } = await import("../forget");
  return runForgetQueue();
}
