import { createApproval, expireDecidedApprovals, listApprovals } from "@/lib/approvals";
import { audit } from "@/lib/auth/audit";
import { assertChannelsAllowed, assertWithinLimit } from "@/lib/billing/limits";
import { prisma } from "@/lib/db";
import { listAssets } from "@/lib/meta-connect";
import { enqueue } from "@/lib/queue";
import { HttpError, type Actor } from "@/lib/tenancy";
import { ASSET_CHANNEL, MEDIA_KEY_PATTERN, channelProblems, type Channel } from "./limits";
import { mediaExists } from "./media";
import { PUBLISH_QUEUE, displayError } from "./publish";
import { assertSchedulable, parseDate, parseRange } from "./schedule";

const EDITABLE = ["draft", "scheduled"];
const DELETABLE = ["draft", "canceled", "failed", "published", "partial"];
const MAX_ASSETS = 10;
const MAX_BODY = 63_206;

type TargetRow = { id: string; assetId: string; channel: string; status: string; externalId: string | null; error: string | null; publishedAt: Date | null };
type PostRow = { id: string; body: string; mediaKeys: string[]; scheduledAt: Date; status: string; createdAt: Date; targets?: TargetRow[] };

export function toDto(p: PostRow) {
  return {
    id: p.id,
    body: p.body,
    mediaKeys: p.mediaKeys,
    scheduledAt: p.scheduledAt.toISOString(),
    status: p.status,
    createdAt: p.createdAt.toISOString(),
    targets: (p.targets ?? []).map((t) => ({
      id: t.id,
      assetId: t.assetId,
      channel: t.channel,
      status: t.status,
      externalId: t.externalId && t.status === "published" ? t.externalId : null,
      error: displayError(t.error),
      publishedAt: t.publishedAt?.toISOString() ?? null,
    })),
  };
}

export type PostInput = { body?: string; mediaKeys?: string[]; assetIds?: string[]; scheduledAt?: string; draft?: boolean; requireApproval?: boolean };

export function parsePostInput(raw: Record<string, unknown>): PostInput {
  const out: PostInput = {};
  if (raw.body !== undefined) {
    if (typeof raw.body !== "string" || raw.body.length > MAX_BODY) throw new HttpError(400, "body must be text.");
    out.body = raw.body;
  }
  if (raw.mediaKeys !== undefined) {
    const keys = raw.mediaKeys;
    if (!Array.isArray(keys) || keys.length > 1 || keys.some((k) => typeof k !== "string" || !MEDIA_KEY_PATTERN.test(k))) throw new HttpError(400, "Attach at most one valid media file.");
    out.mediaKeys = keys as string[];
  }
  if (raw.assetIds !== undefined) {
    const ids = raw.assetIds;
    if (!Array.isArray(ids) || ids.length > MAX_ASSETS || ids.some((i) => typeof i !== "string" || !i || i.length > 64)) throw new HttpError(400, "assetIds must list up to 10 connected accounts.");
    out.assetIds = [...new Set(ids as string[])];
  }
  if (raw.scheduledAt !== undefined) out.scheduledAt = parseDate(raw.scheduledAt, "scheduledAt").toISOString();
  if (raw.draft !== undefined) out.draft = raw.draft === true;
  if (raw.requireApproval !== undefined) out.requireApproval = raw.requireApproval === true;
  return out;
}

async function resolveTargets(tenantId: string, assetIds: string[]): Promise<{ assetId: string; channel: Channel }[]> {
  const assets = await listAssets(tenantId);
  const byId = new Map(assets.filter((a) => a.type in ASSET_CHANNEL && a.status === "active").map((a) => [a.id, a]));
  return assetIds.map((id) => {
    const asset = byId.get(id);
    if (!asset) throw new HttpError(400, "One of the selected accounts is not connected to this workspace.");
    return { assetId: id, channel: ASSET_CHANNEL[asset.type] };
  });
}

async function assertMedia(tenantId: string, keys: string[]): Promise<void> {
  for (const key of keys) if (!(await mediaExists(tenantId, key))) throw new HttpError(400, "An attached media file was not found.");
}

function assertContent(targets: { channel: Channel }[], body: string, mediaKeys: string[]): void {
  if (targets.length === 0) throw new HttpError(400, "Choose at least one account to post to.");
  const problems = [...new Set(targets.flatMap((t) => channelProblems(t.channel, body, mediaKeys)))];
  if (problems.length) throw new HttpError(400, problems[0]);
}

export async function createPost(actor: Actor, input: PostInput, now = new Date()) {
  const body = input.body ?? "";
  const mediaKeys = input.mediaKeys ?? [];
  const draft = input.draft === true || input.requireApproval === true;
  if (!draft && !input.scheduledAt) throw new HttpError(400, "scheduledAt is required.");
  const at = input.scheduledAt ? new Date(input.scheduledAt) : now;
  if (!draft) assertSchedulable(at, now);
  const targets = await resolveTargets(actor.tenantId, input.assetIds ?? []);
  assertContent(targets, body, mediaKeys);
  await assertMedia(actor.tenantId, mediaKeys);
  await assertWithinLimit(actor.tenantId, "scheduledPosts");
  await assertChannelsAllowed(actor.tenantId, targets.map((t) => t.assetId));
  const post = await prisma.scheduledPost.create({
    data: {
      tenantId: actor.tenantId,
      body,
      mediaKeys,
      scheduledAt: at,
      status: draft ? "draft" : "scheduled",
      createdByUserId: actor.userId,
      targets: { create: targets.map((t) => ({ tenantId: actor.tenantId, assetId: t.assetId, channel: t.channel })) },
    },
    include: { targets: true },
  });
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "content.post.create", target: post.id });
  const approvalUrl = input.requireApproval ? await requestApproval(actor.tenantId, post.id) : null;
  return { post: toDto(post), approvalUrl };
}

async function requestApproval(tenantId: string, postId: string): Promise<string> {
  try {
    return (await createApproval(tenantId, { subjectType: "scheduled_post", subjectId: postId })).url;
  } catch {
    throw new HttpError(503, "The post was saved as a draft, but approval links are not available yet.");
  }
}

/** "pending" is a link the client has not used yet, "approved" is a decision that already covers the current content. */
async function approvalState(tenantId: string, postId: string): Promise<"pending" | "approved" | "none"> {
  const list = await listApprovals(tenantId, "scheduled_post", postId);
  if (list.some((a) => a.status === "pending")) return "pending";
  return list.some((a) => a.status === "approved") ? "approved" : "none";
}

async function loadOwned(tenantId: string, id: string) {
  const post = await prisma.scheduledPost.findFirst({ where: { id, tenantId }, include: { targets: true } });
  if (!post) throw new HttpError(404, "Post not found.");
  return post;
}

export async function getPost(actor: Actor, id: string) {
  return toDto(await loadOwned(actor.tenantId, id));
}

export async function listPosts(actor: Actor, opts: { status?: string; limit?: number }) {
  const rows = await prisma.scheduledPost.findMany({
    where: { tenantId: actor.tenantId, ...(opts.status ? { status: opts.status } : {}) },
    include: { targets: true },
    orderBy: { scheduledAt: "desc" },
    take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
  });
  return rows.map(toDto);
}

export async function updatePost(actor: Actor, id: string, input: PostInput, now = new Date()) {
  const current = await loadOwned(actor.tenantId, id);
  if (!EDITABLE.includes(current.status)) throw new HttpError(409, "Only drafts and scheduled posts can be edited.");
  const body = input.body ?? current.body;
  const mediaKeys = input.mediaKeys ?? current.mediaKeys;
  const targets = input.assetIds ? await resolveTargets(actor.tenantId, input.assetIds) : current.targets.map((t) => ({ assetId: t.assetId, channel: t.channel as Channel }));
  assertContent(targets, body, mediaKeys);
  await assertMedia(actor.tenantId, mediaKeys);
  if (input.assetIds) await assertChannelsAllowed(actor.tenantId, targets.map((t) => t.assetId), { excludePostId: id });
  const at = input.scheduledAt ? new Date(input.scheduledAt) : current.scheduledAt;
  const wanted = input.draft === true ? "draft" : input.draft === false || current.status === "scheduled" ? "scheduled" : "draft";
  if (wanted === "scheduled") assertSchedulable(at, now);
  const covered = (await approvalState(actor.tenantId, id)) !== "none";
  const status = covered ? "draft" : wanted;
  const won = await prisma.scheduledPost.updateMany({ where: { id, tenantId: actor.tenantId, status: { in: EDITABLE } }, data: { body, mediaKeys, scheduledAt: at, status } });
  if (won.count !== 1) throw new HttpError(409, "The post changed while you were editing it.");
  if (covered) await expireDecidedApprovals(actor.tenantId, "scheduled_post", id, actor.userId);
  if (input.assetIds) {
    await prisma.postTarget.deleteMany({ where: { tenantId: actor.tenantId, postId: id } });
    await prisma.postTarget.createMany({ data: targets.map((t) => ({ tenantId: actor.tenantId, postId: id, assetId: t.assetId, channel: t.channel })) });
  }
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "content.post.update", target: id });
  return toDto(await loadOwned(actor.tenantId, id));
}

/** True when a draft, scheduled or publishing post still uses the media file, so deleting it would break that post. */
export async function mediaInUse(tenantId: string, key: string): Promise<boolean> {
  const hit = await prisma.scheduledPost.findFirst({ where: { tenantId, mediaKeys: { has: key }, status: { in: ["draft", "scheduled", "publishing"] } }, select: { id: true } });
  return Boolean(hit);
}

export async function reschedulePost(actor: Actor, id: string, scheduledAt: string, now = new Date()) {
  const at = parseDate(scheduledAt, "scheduledAt");
  assertSchedulable(at, now);
  await loadOwned(actor.tenantId, id);
  const covered = (await approvalState(actor.tenantId, id)) !== "none";
  const won = await prisma.scheduledPost.updateMany({ where: { id, tenantId: actor.tenantId, status: { in: EDITABLE } }, data: { scheduledAt: at, status: covered ? "draft" : "scheduled" } });
  if (won.count !== 1) throw new HttpError(409, "Only drafts and scheduled posts can be rescheduled.");
  if (covered) await expireDecidedApprovals(actor.tenantId, "scheduled_post", id, actor.userId);
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "content.post.reschedule", target: id });
  return toDto(await loadOwned(actor.tenantId, id));
}

export async function cancelPost(actor: Actor, id: string) {
  await loadOwned(actor.tenantId, id);
  const won = await prisma.scheduledPost.updateMany({ where: { id, tenantId: actor.tenantId, status: { in: EDITABLE } }, data: { status: "canceled" } });
  if (won.count !== 1) throw new HttpError(409, "This post can no longer be canceled.");
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "content.post.cancel", target: id });
  return toDto(await loadOwned(actor.tenantId, id));
}

export async function deletePost(actor: Actor, id: string) {
  await loadOwned(actor.tenantId, id);
  const gone = await prisma.scheduledPost.deleteMany({ where: { id, tenantId: actor.tenantId, status: { in: DELETABLE } } });
  if (gone.count !== 1) throw new HttpError(409, "Cancel the post before deleting it.");
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "content.post.delete", target: id });
}

export async function publishNow(actor: Actor, id: string, now = new Date()) {
  const post = await loadOwned(actor.tenantId, id);
  if (post.status === "draft" && (await approvalState(actor.tenantId, id)) === "pending") {
    throw new HttpError(409, "This post is waiting for client approval. Revoke the approval link first if you want to publish it now.");
  }
  assertContent(post.targets.map((t) => ({ channel: t.channel as Channel })), post.body, post.mediaKeys);
  const won = await prisma.scheduledPost.updateMany({ where: { id, tenantId: actor.tenantId, status: { in: EDITABLE } }, data: { status: "publishing", scheduledAt: now } });
  if (won.count !== 1) throw new HttpError(409, "This post can no longer be published.");
  await enqueue(PUBLISH_QUEUE, { tenantId: actor.tenantId, postId: id });
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "content.post.publish_now", target: id });
  return toDto(await loadOwned(actor.tenantId, id));
}

/** Called by the approvals module when a reviewer decides on a scheduled_post subject. */
export async function onPostApprovalDecided(tenantId: string, postId: string, decision: "approved" | "changes_requested" | "rejected", now = new Date()): Promise<void> {
  if (decision === "approved") {
    const post = await prisma.scheduledPost.findFirst({ where: { id: postId, tenantId, status: "draft" } });
    if (post && post.scheduledAt > now) await prisma.scheduledPost.updateMany({ where: { id: postId, tenantId, status: "draft" }, data: { status: "scheduled" } });
  } else if (decision === "rejected") {
    await prisma.scheduledPost.updateMany({ where: { id: postId, tenantId, status: "draft" }, data: { status: "canceled" } });
  }
}

export async function calendarRange(actor: Actor, fromRaw: unknown, toRaw: unknown) {
  const { from, to } = parseRange(fromRaw, toRaw);
  const rows = await prisma.scheduledPost.findMany({
    where: { tenantId: actor.tenantId, scheduledAt: { gte: from, lt: to } },
    include: { targets: { select: { channel: true } } },
    orderBy: { scheduledAt: "asc" },
    take: 500,
  });
  return rows.map((p) => ({ id: p.id, name: p.body.slice(0, 80) || "(media post)", status: p.status, at: p.scheduledAt.toISOString(), channels: [...new Set(p.targets.map((t) => t.channel))] }));
}

export async function listTargets(actor: Actor) {
  const assets = await listAssets(actor.tenantId);
  return assets
    .filter((a) => a.type in ASSET_CHANNEL)
    .map((a) => ({ id: a.id, name: a.name, channel: ASSET_CHANNEL[a.type], status: a.status, available: a.status === "active" && ASSET_CHANNEL[a.type] !== "threads" }));
}
