import { prisma } from "@/lib/db";
import { getAssetAccess } from "@/lib/meta-connect";
import { enqueue } from "@/lib/queue";
import { sanitizeMessage } from "@/lib/safe-error";
import { tenantMayRunBackground } from "@/lib/tenant-state";
import { mediaKind } from "./limits";
import { mediaExists, mediaPublicUrl } from "./media";
import { PublishError, publishFacebook, publishInstagram, publishThreads, type PublishMedia } from "./publishers";

export const PUBLISH_QUEUE = "content.publish";
export const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [60_000, 300_000];
const SCAN_FACTOR = 5;
const MAX_OVERDUE_MS = 24 * 3_600_000;
const WAITING = ["pending", "retry", "container"];
const TERMINAL = ["published", "failed"];

type PostRow = { id: string; tenantId: string; body: string; mediaKeys: string[]; scheduledAt: Date };
type TargetRow = { id: string; tenantId: string; assetId: string; channel: string; status: string; externalId: string | null; error: string | null };
type Result =
  | { state: "published"; externalId: string }
  | { state: "wait"; ms: number; message: string; status: "pending" | "container" }
  | { state: "retry"; message: string }
  | { state: "fail"; message: string };

/** Attempt count is kept in the error text as "#n|message" because PostTarget has no attempts column. */
export const attemptsOf = (error: string | null) => Number(error?.match(/^#(\d+)\|/)?.[1] ?? 0);
export const displayError = (error: string | null) => (error ? error.replace(/^#\d+\|/, "") : null);

const MAX_SCAN_ROUNDS = 10;
const STALE_BATCH = 200;

const MISSED_WINDOW_ERROR = "missed_window: the scheduled time passed more than 24 hours ago, so the post was not published. Schedule it again.";

/**
 * Where overdue scheduled posts are handled (the only place; the UI and the API never publish):
 *  1. claimDue calls this first on every worker tick, then claims what is due now. A post that is late by up to 24 hours (a short
 *     outage, a workspace that was locked briefly) is still claimed and published normally.
 *  2. Here, a post still "scheduled" more than 24 hours after its time is NOT published when the workspace recovers, because that
 *     would post stale content in a burst. The post and its waiting targets are marked "failed" with a reason starting
 *     "missed_window" (PostTarget.error is where the owner reads it), and nothing is sent to Meta.
 *  3. For a post already being published, attempt() gives up an Instagram container wait that runs past the same 24 hours.
 * Runs for every workspace, blocked or not: a blocked workspace's late posts must not wait around to be published later either.
 */
export async function expireStalePosts(now = new Date()): Promise<number> {
  const stale = await prisma.scheduledPost.findMany({
    where: { status: "scheduled", scheduledAt: { lt: new Date(now.getTime() - MAX_OVERDUE_MS) } },
    select: { id: true, tenantId: true },
    orderBy: { scheduledAt: "asc" },
    take: STALE_BATCH,
  });
  const byTenant = new Map<string, string[]>();
  for (const post of stale) byTenant.set(post.tenantId, [...(byTenant.get(post.tenantId) ?? []), post.id]);
  let failed = 0;
  for (const [tenantId, ids] of byTenant) {
    const won = await prisma.scheduledPost.updateMany({ where: { id: { in: ids }, tenantId, status: "scheduled" }, data: { status: "failed" } });
    if (won.count === 0) continue;
    // Only the posts this call actually moved: one that claimDue moved to "publishing" in between keeps its targets. Anything still
    // "scheduled" in the scan was either won here or by a concurrent expiry (same outcome), so "failed" identifies them.
    const lost = won.count === ids.length ? [] : await prisma.scheduledPost.findMany({ where: { id: { in: ids }, tenantId, status: { not: "failed" } }, select: { id: true } });
    const skip = new Set(lost.map((p) => p.id));
    const expired = ids.filter((id) => !skip.has(id));
    if (expired.length) await prisma.postTarget.updateMany({ where: { tenantId, postId: { in: expired }, status: { in: WAITING } }, data: { status: "failed", error: MISSED_WINDOW_ERROR } });
    failed += won.count;
  }
  return failed;
}

/**
 * Atomically moves due scheduled posts to "publishing". Each post is won by exactly one caller through a compare-and-set on status.
 * Posts of a workspace that is suspended, deleted or locked are left as "scheduled" and picked up again if the workspace recovers
 * (unless they become more than 24 hours late: then they are failed as missed_window, see expireStalePosts). Blocked workspaces are excluded from the next scan once seen,
 * so a pile of their oldest posts cannot starve the healthy workspaces.
 */
export async function claimDue(now = new Date(), limit = 20): Promise<{ id: string; tenantId: string }[]> {
  await expireStalePosts(now);
  const claimed: { id: string; tenantId: string }[] = [];
  const blocked = new Set<string>();
  const take = limit * SCAN_FACTOR;
  for (let round = 0; round < MAX_SCAN_ROUNDS && claimed.length < limit; round++) {
    const due = await prisma.scheduledPost.findMany({
      where: { status: "scheduled", scheduledAt: { lte: now }, ...(blocked.size ? { tenantId: { notIn: [...blocked] } } : {}) },
      select: { id: true, tenantId: true },
      orderBy: { scheduledAt: "asc" },
      take,
    });
    const before = blocked.size;
    for (const post of due) {
      if (claimed.length >= limit) break;
      if (blocked.has(post.tenantId)) continue;
      if (!(await tenantMayRunBackground(post.tenantId))) {
        blocked.add(post.tenantId);
        continue;
      }
      const won = await prisma.scheduledPost.updateMany({ where: { id: post.id, tenantId: post.tenantId, status: "scheduled" }, data: { status: "publishing" } });
      if (won.count === 1) claimed.push(post);
    }
    // A short batch was read completely; with nothing new to exclude, another scan would return the same rows.
    if (due.length < take || blocked.size === before) break;
  }
  return claimed;
}

export async function claimAndEnqueue(now = new Date()): Promise<number> {
  const claimed = await claimDue(now);
  for (const post of claimed) await enqueue(PUBLISH_QUEUE, { tenantId: post.tenantId, postId: post.id });
  return claimed.length;
}

async function loadMedia(post: PostRow): Promise<PublishMedia> {
  const key = post.mediaKeys[0];
  if (!key) return null;
  if (!(await mediaExists(post.tenantId, key))) throw new PublishError("The attached media file is missing.");
  return { url: mediaPublicUrl(post.tenantId, key), kind: mediaKind(key) };
}

async function attempt(post: PostRow, target: TargetRow, now: Date, sleep?: (ms: number) => Promise<void>): Promise<Result> {
  let container = target.channel === "instagram" ? target.externalId : null;
  try {
    if (target.channel === "threads") await publishThreads();
    const asset = await getAssetAccess(post.tenantId, target.assetId);
    const media = await loadMedia(post);
    if (target.channel === "facebook") return { state: "published", ...(await publishFacebook(asset, post.body, media)) };
    if (target.channel !== "instagram") throw new PublishError("Unknown channel.");
    const res = await publishInstagram(asset, post.body, media, {
      containerId: container,
      sleep,
      saveContainer: async (id) => {
        container = id;
        await prisma.postTarget.updateMany({ where: { id: target.id, tenantId: post.tenantId }, data: { externalId: id } });
      },
    });
    if ("defer" in res) {
      if (now.getTime() - post.scheduledAt.getTime() > MAX_OVERDUE_MS) return { state: "fail", message: "Gave up waiting: the post is more than 24 hours late." };
      return { state: "wait", ms: res.defer.ms, message: res.defer.message, status: container ? "container" : "pending" };
    }
    return { state: "published", externalId: res.externalId };
  } catch (e) {
    if (e instanceof PublishError) return e.retry ? { state: "retry", message: e.message } : { state: "fail", message: e.message };
    const status = (e as { status?: number } | null)?.status;
    if (typeof status === "number") return { state: "fail", message: sanitizeMessage((e as Error).message, 250) };
    return { state: "fail", message: "The post could not be published." };
  }
}

async function apply(target: TargetRow, result: Result, now: Date): Promise<number | null> {
  const where = { id: target.id, tenantId: target.tenantId };
  if (result.state === "published") {
    await prisma.postTarget.updateMany({ where, data: { status: "published", externalId: result.externalId, publishedAt: now, error: null } });
    return null;
  }
  if (result.state === "wait") {
    await prisma.postTarget.updateMany({ where, data: { status: result.status, error: result.message } });
    return result.ms;
  }
  if (result.state === "retry") {
    const n = attemptsOf(target.error) + 1;
    if (n < MAX_ATTEMPTS) {
      await prisma.postTarget.updateMany({ where, data: { status: "retry", error: `#${n}|${result.message}` } });
      return BACKOFF_MS[n - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
    }
  }
  await prisma.postTarget.updateMany({ where, data: { status: "failed", error: result.message } });
  return null;
}

async function finalize(tenantId: string, postId: string, nextMs: number | null): Promise<void> {
  const targets = await prisma.postTarget.findMany({ where: { tenantId, postId }, select: { status: true } });
  if (targets.some((t) => !TERMINAL.includes(t.status))) {
    await enqueue(PUBLISH_QUEUE, { tenantId, postId }, { runAt: new Date(Date.now() + (nextMs ?? 60_000)) });
    return;
  }
  const published = targets.filter((t) => t.status === "published").length;
  const status = targets.length > 0 && published === targets.length ? "published" : published === 0 ? "failed" : "partial";
  await prisma.scheduledPost.updateMany({ where: { id: postId, tenantId, status: "publishing" }, data: { status } });
}

/**
 * Publishes every waiting target of a claimed post independently. A target is moved to "processing" with a compare-and-set before
 * any Meta call and to "published" with its externalId right after success, so a repeated run never posts twice. A target found in
 * "processing" at the start of a run was interrupted with an unknown outcome and is failed rather than retried.
 */
export async function processPost(tenantId: string, postId: string, opts: { now?: Date; sleep?: (ms: number) => Promise<void> } = {}): Promise<void> {
  const now = opts.now ?? new Date();
  if (!(await tenantMayRunBackground(tenantId))) {
    await prisma.scheduledPost.updateMany({ where: { id: postId, tenantId, status: "publishing" }, data: { status: "scheduled" } });
    return;
  }
  const post = await prisma.scheduledPost.findFirst({ where: { id: postId, tenantId } });
  if (!post || post.status !== "publishing") return;
  const targets = await prisma.postTarget.findMany({ where: { tenantId, postId }, orderBy: { id: "asc" } });
  let nextMs: number | null = null;
  for (const target of targets) {
    if (target.status === "processing") {
      await prisma.postTarget.updateMany({
        where: { id: target.id, tenantId, status: "processing" },
        data: { status: "failed", error: "Publishing was interrupted and the outcome is unknown. Check the account before trying again." },
      });
      continue;
    }
    if (!WAITING.includes(target.status)) continue;
    const won = await prisma.postTarget.updateMany({ where: { id: target.id, tenantId, status: target.status }, data: { status: "processing" } });
    if (won.count !== 1) continue;
    const ms = await apply(target, await attempt(post, target, now, opts.sleep), now);
    if (ms !== null) nextMs = nextMs === null ? ms : Math.min(nextMs, ms);
  }
  await finalize(tenantId, postId, nextMs);
}
