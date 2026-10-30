import { siteUrl } from "@/lib/config";
import { prisma } from "@/lib/db";
import { hashToken, newOpaqueToken } from "@/lib/auth/tokens";
import { queueEmail } from "@/lib/email";
import { HttpError } from "@/lib/tenancy";
import { createNonce, isWellFormedToken } from "./guards";
import { clean, HANDLERS, type SubjectSummary } from "./summary";
import { MAX_COMMENT_LENGTH } from "./constants";
import { isDecision, type ApprovalDecision, type ApprovalSubject } from "./types";

export type { ApprovalSubject, ApprovalDecision } from "./types";
import { campaignApprovalKey } from "./summary";
export { isCampaignClientApproved, getOptimizerClientDecision, getOptimizerClientDecisions, repairStuckOptimizerProposals, repairStuckOptimizerProposalsOnce } from "./summary";
export type { OptimizerClientDecision } from "./summary";

export const DEFAULT_EXPIRY_HOURS = 7 * 24;
export const MAX_EXPIRY_HOURS = 30 * 24;
export { MAX_COMMENT_LENGTH };

const approvalUrl = (token: string) => `${siteUrl()}/approve/${token}`;

function expiryDate(hours: number | undefined, now = Date.now()): Date {
  const h = hours === undefined ? DEFAULT_EXPIRY_HOURS : hours;
  if (!Number.isFinite(h) || h < 1) throw new HttpError(400, "The link must stay valid for at least one hour.");
  return new Date(now + Math.min(Math.floor(h), MAX_EXPIRY_HOURS) * 3_600_000);
}

async function audit(tenantId: string, userId: string | null, action: string, target: string, meta: Record<string, unknown>) {
  await prisma.auditLog.create({ data: { tenantId, userId, action, target, meta: meta as object } });
}

const fpKey = (approvalId: string) => `approval:fp:${approvalId}`;

async function storeFingerprint(approvalId: string, fp: string | null, replace = false): Promise<void> {
  if (!fp) return;
  const key = fpKey(approvalId);
  if (!replace) await prisma.platformSetting.create({ data: { key, value: { fp } } });
  else await prisma.platformSetting.upsert({ where: { key }, create: { key, value: { fp } }, update: { value: { fp } } });
}

async function storedFingerprint(approvalId: string): Promise<string | null> {
  const row = await prisma.platformSetting.findUnique({ where: { key: fpKey(approvalId) } });
  const fp = (row?.value as { fp?: unknown } | null | undefined)?.fp;
  return typeof fp === "string" ? fp : null;
}

/** Creates a pending approval and returns the one-time public link (only the token hash is stored). */
export async function createApproval(
  tenantId: string,
  input: { subjectType: ApprovalSubject; subjectId: string; expiresInHours?: number; createdByUserId?: string },
): Promise<{ id: string; url: string }> {
  const handler = HANDLERS[input.subjectType];
  if (!handler || typeof input.subjectId !== "string" || !input.subjectId) throw new HttpError(400, "Choose something to send for approval.");
  const owner = await handler.owner(tenantId, input.subjectId);
  if (!owner) throw new HttpError(404, "That item was not found.");
  const expiresAt = expiryDate(input.expiresInHours);
  const token = newOpaqueToken();
  const fp = await handler.fingerprint(tenantId, input.subjectId);
  const row = await prisma.approvalRequest.create({
    data: { tenantId, subjectType: input.subjectType, subjectId: input.subjectId, tokenHash: hashToken(token), expiresAt },
    select: { id: true },
  });
  try {
    await storeFingerprint(row.id, fp);
  } catch (e) {
    await prisma.approvalRequest.updateMany({ where: { id: row.id, tenantId }, data: { status: "expired", expiresAt: new Date() } });
    throw e;
  }
  await audit(tenantId, input.createdByUserId ?? null, "approval.created", `${input.subjectType}:${input.subjectId}`, { approvalId: row.id });
  return { id: row.id, url: approvalUrl(token) };
}

/** Replaces the link of a still-pending approval (old link stops working). Used to resend, since tokens are never recoverable. */
export async function reissueApproval(tenantId: string, id: string, expiresInHours?: number, userId?: string): Promise<{ id: string; url: string }> {
  const token = newOpaqueToken();
  const current = await prisma.approvalRequest.findFirst({ where: { id, tenantId, status: "pending" }, select: { subjectType: true, subjectId: true } });
  if (!current) throw new HttpError(409, "This approval is already decided or was revoked. Create a new one.");
  const claimed = await prisma.approvalRequest.updateMany({
    where: { id, tenantId, status: "pending" },
    data: { tokenHash: hashToken(token), expiresAt: expiryDate(expiresInHours) },
  });
  if (claimed.count !== 1) throw new HttpError(409, "This approval is already decided or was revoked. Create a new one.");
  await storeFingerprint(id, await HANDLERS[current.subjectType as ApprovalSubject]?.fingerprint(tenantId, current.subjectId).catch(() => null) ?? null, true);
  await audit(tenantId, userId ?? null, "approval.reissued", id, { approvalId: id });
  return { id, url: approvalUrl(token) };
}

export type ApprovalView = { id: string; tenantId: string; subjectType: ApprovalSubject; subjectId: string; status: string; expiresAt: Date };

/** Null for unknown, malformed and expired tokens alike. */
export async function getApprovalByToken(token: string): Promise<ApprovalView | null> {
  if (!isWellFormedToken(token)) return null;
  const row = await prisma.approvalRequest.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!row || row.expiresAt.getTime() <= Date.now()) return null;
  return {
    id: row.id,
    tenantId: row.tenantId,
    subjectType: row.subjectType as ApprovalSubject,
    subjectId: row.subjectId,
    status: row.status,
    expiresAt: row.expiresAt,
  };
}

type RowRef = { id: string; tenantId: string; subjectType: string; subjectId: string };

/**
 * A client must decide on what the link was made for. If the content changed after the link was created (an edit that did not go through
 * expireDecidedApprovals, or one that raced the decision), the request is expired instead of recording a decision on different content.
 * Approvals created before fingerprints existed have no stored value and are accepted as before.
 */
async function checkBinding(row: RowRef, claimedAs?: ApprovalDecision): Promise<{ ok: true; fp: string | null } | { ok: false }> {
  const handler = HANDLERS[row.subjectType as ApprovalSubject];
  if (!handler) return { ok: false };
  const stored = await storedFingerprint(row.id);
  if (!stored) return { ok: true, fp: null };
  const current = await handler.fingerprint(row.tenantId, row.subjectId);
  if (current === stored) return { ok: true, fp: stored };
  await prisma.approvalRequest.updateMany({
    where: { id: row.id, tenantId: row.tenantId, status: claimedAs ?? "pending" },
    data: { status: "expired", expiresAt: new Date() },
  });
  await audit(row.tenantId, null, "approval.stale", `${row.subjectType}:${row.subjectId}`, { approvalId: row.id }).catch(() => undefined);
  return { ok: false };
}

const DECISION_LABEL: Record<ApprovalDecision, string> = { approved: "approved", changes_requested: "asked for changes to", rejected: "rejected" };

async function notifyCreator(tenantId: string, view: ApprovalView, decision: ApprovalDecision, comment: string | null) {
  const owner = await HANDLERS[view.subjectType].owner(tenantId, view.subjectId);
  if (!owner?.createdByUserId) return;
  const user = await prisma.user.findFirst({ where: { id: owner.createdByUserId, memberships: { some: { tenantId } } }, select: { email: true } });
  if (!user?.email) return;
  const note = comment ? `\n\nTheir comment:\n${comment}` : "";
  await queueEmail({
    to: user.email,
    subject: `A client ${DECISION_LABEL[decision]} an item you sent for approval`,
    text: `A client ${DECISION_LABEL[decision]} an item you sent for approval in Edwyz WA.${note}\n\nOpen your workspace to see the details.`,
  });
}

/** Records the client's decision once. Returns ok false for unknown, expired, already decided or invalid input (callers must not say which). */
export async function decideApproval(token: string, decision: ApprovalDecision, comment?: string): Promise<{ ok: boolean }> {
  if (!isWellFormedToken(token) || !isDecision(decision)) return { ok: false };
  const text = clean(comment, MAX_COMMENT_LENGTH) || null;
  if (decision === "changes_requested" && !text) return { ok: false };
  const tokenHash = hashToken(token);
  const now = new Date();
  const before = await prisma.approvalRequest.findUnique({ where: { tokenHash } });
  const bound = before && before.status === "pending" && before.expiresAt > now ? await checkBinding(before) : { ok: true as const, fp: null };
  if (!bound.ok) return { ok: false };
  const claimed = await prisma.approvalRequest.updateMany({
    where: { tokenHash, status: "pending", expiresAt: { gt: now } },
    data: { status: decision, comment: text, decidedAt: now },
  });
  if (claimed.count !== 1) return { ok: false };

  const row = await prisma.approvalRequest.findUnique({ where: { tokenHash } });
  if (!row) return { ok: true };
  const view: ApprovalView = {
    id: row.id,
    tenantId: row.tenantId,
    subjectType: row.subjectType as ApprovalSubject,
    subjectId: row.subjectId,
    status: row.status,
    expiresAt: row.expiresAt,
  };
  const after = await checkBinding(row, decision);
  if (!after.ok) return { ok: false };
  let applied = true;
  try {
    await HANDLERS[view.subjectType].apply(view.tenantId, view.subjectId, decision, after.fp);
  } catch {
    applied = false;
  }
  try {
    await audit(view.tenantId, null, "approval.decided", `${view.subjectType}:${view.subjectId}`, { approvalId: view.id, decision, comment: text, applied });
    await notifyCreator(view.tenantId, view, decision, text);
  } catch {
    console.error("[approvals] follow-up after a decision failed");
  }
  return { ok: true };
}

export type ApprovalPageData =
  | { state: "invalid" }
  | { state: "pending"; summary: SubjectSummary; expiresAt: Date; nonce: string }
  | { state: "decided"; summary: SubjectSummary; decision: string };

/** Everything the public page may show. Unknown, expired and orphaned links all collapse to the same "invalid" state. */
export async function loadApprovalPage(token: string): Promise<ApprovalPageData> {
  const view = await getApprovalByToken(token);
  if (!view) return { state: "invalid" };
  const summary = await HANDLERS[view.subjectType]?.load(view.tenantId, view.subjectId);
  if (!summary) return { state: "invalid" };
  if (view.status === "pending") return { state: "pending", summary, expiresAt: view.expiresAt, nonce: createNonce(hashToken(token)) };
  return { state: "decided", summary, decision: view.status };
}

/**
 * Call when the content behind an item changes. A client approval no longer matches what was approved, so approved requests and links
 * the client has not used yet are expired (a new one must be sent) and, for campaigns, the launch gate flag is cleared. Returns how many
 * approvals were invalidated.
 */
export async function expireDecidedApprovals(tenantId: string, subjectType: ApprovalSubject, subjectId: string, userId?: string): Promise<number> {
  const res = await prisma.approvalRequest.updateMany({
    where: { tenantId, subjectType, subjectId, status: { in: ["pending", "approved"] } },
    data: { status: "expired", expiresAt: new Date() },
  });
  if (subjectType === "ad_campaign") {
    const key = campaignApprovalKey(tenantId, subjectId);
    const value = { approved: false, decision: "expired", at: new Date().toISOString() };
    await prisma.platformSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }
  if (res.count > 0) await audit(tenantId, userId ?? null, "approval.expired_by_edit", `${subjectType}:${subjectId}`, { count: res.count });
  return res.count;
}

export type ApprovalListItem = { id: string; status: string; comment: string | null; expiresAt: Date; decidedAt: Date | null; createdAt: Date };

export async function listApprovals(tenantId: string, subjectType: ApprovalSubject, subjectId: string): Promise<ApprovalListItem[]> {
  const rows = await prisma.approvalRequest.findMany({
    where: { tenantId, subjectType, subjectId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, status: true, comment: true, expiresAt: true, decidedAt: true, createdAt: true },
  });
  const now = Date.now();
  return rows.map((r) => (r.status === "pending" && r.expiresAt.getTime() <= now ? { ...r, status: "expired" } : r));
}

export async function revokeApproval(tenantId: string, id: string, userId: string): Promise<void> {
  const res = await prisma.approvalRequest.updateMany({ where: { id, tenantId, status: "pending" }, data: { status: "expired", expiresAt: new Date() } });
  if (res.count !== 1) throw new HttpError(404, "No pending approval was found.");
  await audit(tenantId, userId, "approval.revoked", id, { approvalId: id });
}
