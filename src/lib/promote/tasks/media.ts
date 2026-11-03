/**
 * promote.media, every 60 s (docs/IG-PAGE-ADS-SPEC.md 5.5, PRM-06): sends prepared library media to the spending ad account
 * when a send is due, and checks videos Meta is still processing. The worker (../worker.ts) skips it while PROMOTE_ENABLED=off.
 *
 * - Sends: pending rows (a throttle's wait is over), errors whose retry is due, and sends that never finished (a crashed
 *   process, after the lease). ../media.ts sendAdMedia does the send, counts the attempt and stores a failure in plain words;
 *   the row stops at MAX_ATTEMPTS.
 * - Checks (M3): a processing video whose next check is due (every 30 s, nextCheckAt) is claimed for the next 30 s and read.
 *   Ready: Meta's preferred thumbnail goes up through M1 and its hash is stored, and the row is ready. Meta's error: a final
 *   error (the file needs a person). Still processing 30 minutes after Meta got it (updatedAt, which checks keep): an error with
 *   a retry, while attempts are left. A dry-run video (a fake id) becomes ready with a fake thumbnail hash and no Meta call.
 * - A throttle (Meta busy) moves the next check to the end of the cooldown and uses no attempt.
 * - A run never holds the worker's pass (src/worker/loop.ts runs one pass at a time, the WhatsApp queues included): it takes at
 *   most MEDIA_TASK_BATCH rows, oldest due first, and takes no new row once MEDIA_TASK_BUDGET_MS have passed; what is left waits
 *   for the next run. A resumable video upload (PROMOTE_VIDEO=resumable: minutes of bytes) never runs inside the pass: the run
 *   claims the row, whose lease (UPLOAD_LEASE_MS) outlasts the upload, and the send goes on beside the passes, at most
 *   MAX_BACKGROUND_UPLOADS at once per process. If the process stops, the lease ends and a later run takes the send over.
 *
 * Database and Meta access go through ../media.ts, which owns AdMedia; this file decides what each check means. ../media.ts and
 * ../throttle.ts are loaded on the first run, so the worker module itself imports neither the database nor the Graph client.
 */
import type { AdMedia } from "@/generated/prisma/client";
import { log } from "@/lib/log";
import { promoteVideo } from "../flags";
import type { MediaDeps } from "../media";

export type MediaTaskResult = { uploaded: number; polled: number; failed: number };

/** Rows (sends and checks together) handled per run at most. */
export const MEDIA_TASK_BATCH = 10;
/** A run takes no new row after this long (the same idea as the worker's PERIODIC_PASS_BUDGET_MS, 15 s for the whole pass). */
export const MEDIA_TASK_BUDGET_MS = 10_000;
/** Resumable video uploads running beside the passes, per process, at most. */
export const MAX_BACKGROUND_UPLOADS = 1;

const background = new Set<Promise<void>>();

/** Resumable video uploads still running beside the passes in this process. */
export const backgroundUploads = (): number => background.size;

/** Waits until the resumable uploads started by earlier runs have ended (tests, and a clean shutdown). */
export async function settleBackgroundUploads(): Promise<void> {
  while (background.size > 0) await Promise.allSettled([...background]);
}

type CheckResult = "skipped" | "processing" | "ready" | "failed";

/** One check of a processing video (M3), and what follows from it. */
export async function checkAdVideo(row: AdMedia, d: MediaDeps): Promise<CheckResult> {
  const m = await import("../media");
  const { PromoteThrottledError } = await import("../throttle");
  const now = d.now();
  // Claim this check: the next one is due in 30 s. The processing clock (updatedAt) stays where it is.
  const claimed = await m.saveAdMedia(row, { nextCheckAt: new Date(now + m.POLL_EVERY_MS) }, d, { keepClock: true, where: { status: "processing", nextCheckAt: row.nextCheckAt } });
  if (!claimed) return "skipped";
  const overdue = now - claimed.updatedAt.getTime() >= m.PROCESSING_TIMEOUT_MS;
  const videoId = claimed.metaVideoId;
  if (!videoId) {
    await m.failVideo(claimed, "gone", d);
    return "failed";
  }
  if (m.isFakeMetaId(videoId)) {
    await m.saveAdMedia(claimed, { status: "ready", metaThumbHash: m.fakeThumbHash(videoId), error: null, nextCheckAt: null }, d, { where: { status: "processing" } });
    return "ready";
  }

  const waitFor = (until: Date) => m.saveAdMedia(claimed, { nextCheckAt: until }, d, { keepClock: true, where: { status: "processing" } });
  let status: Awaited<ReturnType<MediaDeps["meta"]["getAdVideoStatus"]>>;
  try {
    status = await d.meta.getAdVideoStatus({ tenantId: claimed.tenantId, adAccountAssetId: claimed.adAccountAssetId }, videoId);
  } catch (e) {
    if (e instanceof PromoteThrottledError) {
      await waitFor(e.until);
      return "processing";
    }
    if (m.isMissingMetaObject(e)) {
      // The video is gone from the ad account: send it again.
      await m.failVideo(claimed, "gone", d);
      return "failed";
    }
    if (overdue) {
      await m.failVideo(claimed, "timeout", d);
      return "failed";
    }
    return "processing";
  }

  if (status.state === "ready") {
    try {
      const hash = await m.thumbnailHash(claimed, status.thumbnailUrl, d);
      await m.saveAdMedia(claimed, { status: "ready", metaThumbHash: hash, error: null, nextCheckAt: null }, d, { where: { status: "processing" } });
      return "ready";
    } catch (e) {
      // The video is done but its cover picture is not: check again in 30 s, until the time limit.
      if (e instanceof PromoteThrottledError) await waitFor(e.until);
      if (!overdue) return "processing";
      await m.failVideo(claimed, "thumbnail", d);
      return "failed";
    }
  }
  if (status.state === "error") {
    await m.failVideo(claimed, "failed", d);
    return "failed";
  }
  if (overdue) {
    await m.failVideo(claimed, "timeout", d);
    return "failed";
  }
  return "processing";
}

type Media = typeof import("../media");

/** Starts the send of a claimed resumable video beside the passes; its outcome is stored on the row (and logged when it fails). */
function sendInBackground(m: Media, claimed: AdMedia, d: MediaDeps): void {
  const run: Promise<void> = m
    .sendClaimedAdMedia(claimed, { deps: d })
    .then(
      (after) => {
        if (after.status === "error") log.warn("promote.media.background_send_failed", { mediaId: claimed.id, tenantId: claimed.tenantId, error: after.error });
      },
      (err: unknown) => log.warn("promote.media.background_send_failed", { err, mediaId: claimed.id, tenantId: claimed.tenantId }),
    )
    .finally(() => void background.delete(run));
  background.add(run);
}

const dueAt = (row: AdMedia) => (row.nextCheckAt instanceof Date ? row.nextCheckAt.getTime() : 0);

export async function runMediaTask(options: { deps?: Partial<MediaDeps>; batch?: number; budgetMs?: number } = {}): Promise<MediaTaskResult> {
  const m = await import("../media");
  const d = m.mediaDeps(options.deps);
  const started = d.now();
  const budget = options.budgetMs ?? MEDIA_TASK_BUDGET_MS;
  const batch = options.batch ?? MEDIA_TASK_BATCH;
  const out: MediaTaskResult = { uploaded: 0, polled: 0, failed: 0 };
  const { sends, checks } = await m.dueAdMedia(started, batch);
  // Oldest due first, sends and checks together, so neither waits behind the other.
  const work = [...sends.map((row) => ({ row, send: true })), ...checks.map((row) => ({ row, send: false }))].sort((a, b) => dueAt(a.row) - dueAt(b.row)).slice(0, batch);

  for (const { row, send } of work) {
    if (d.now() - started >= budget) break;
    if (!send) {
      try {
        const result = await checkAdVideo(row, d);
        if (result === "skipped") continue;
        out.polled++;
        if (result === "failed") out.failed++;
      } catch (err) {
        out.failed++;
        log.warn("promote.media.task_check_failed", { err, mediaId: row.id, tenantId: row.tenantId });
      }
      continue;
    }
    try {
      if (row.kind === "video" && promoteVideo(d.env) === "resumable") {
        // Minutes of bytes: never inside the pass. Claimed here (its lease outlasts the upload), sent beside the passes.
        if (background.size >= MAX_BACKGROUND_UPLOADS) continue;
        const { claimed, row: after } = await m.claimAdMedia(row, { deps: d });
        if (claimed) sendInBackground(m, claimed, d);
        else if (after !== row && after.status === "error") out.failed++;
        continue;
      }
      const after = await m.sendAdMedia(row, { deps: d });
      if (after === row) continue;
      if (after.status === "ready" || after.status === "processing") out.uploaded++;
      else if (after.status === "error") out.failed++;
    } catch (err) {
      out.failed++;
      log.warn("promote.media.task_send_failed", { err, mediaId: row.id, tenantId: row.tenantId });
    }
  }
  return out;
}
