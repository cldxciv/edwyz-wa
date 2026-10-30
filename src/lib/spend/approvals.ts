/**
 * Spending approvals (docs/SPEND-CONTROLS-SPEC.md 2.3.2, 2.3.6, 2.3.10, 7.3, 7.4, 4.16, 4.17).
 *
 * Two kinds of SpendApproval rows exist:
 * - an assistant's ads intent the book could not run on its own (reserveAds step 10 wrote the row, with the exact intent and
 *   its fingerprint); approving it re-runs reserveAds with {type:'assistant', approvalId}, which skips only the autonomy step,
 *   through the normal ads actions (ads/actions.ts, ads/service.ts);
 * - an optimizer suggestion (`intent.kind = optimizer_proposal`, created here by the daily run); approving it runs the
 *   proposal as the approver's own action (actor user, with assistantKey and approvalId on the ledger, decision 2.3.10).
 *
 * Deciding:
 * - ONE conditional UPDATE ... WHERE status = 'pending' AND "expiresAt" > now: two taps (app and link, or two approvers) can
 *   never both apply, and a request past expiresAt cannot be approved even when the expiry task has not run (it is then
 *   expired on the spot: "Declined automatically").
 * - Approving a raise needs a signed-in approver, checked again at decision time: still a member, and the owner or an admin
 *   in approverUserIds (pruned to current admins). A lowering suggestion may be approved by any admin. Declining needs only
 *   an admin, the link's token, or the verified WhatsApp quick reply.
 * - A fingerprint mismatch fails with "The ad set changed since this was asked."; a request that no longer fits fails with
 *   "No longer fits your limits: ₹Y left, needs ₹X".
 * - A new request about the same object, a changed fingerprint, or a stop of all spending (kill.ts) supersedes older pending
 *   requests. Every step is ledgered (approval.create | approve | decline | expire | supersede | apply).
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { describeError } from "@/lib/safe-error";
import { HttpError } from "@/lib/tenancy";
import { getAllowance } from "./allowances";
import { approvalFingerprint, hashApprovalToken, isApprovalTokenShape, newApprovalToken, type FingerprintObject } from "./approval-token";
import { currentAdsFingerprint, intentSubject } from "./book";
import { getControl, inSpendTransaction, type SpendDb } from "./control";
import { SpendBlockedError } from "./errors";
import { jsonSafe } from "./http";
import { appendStandalone, newCorrelationId, type LedgerDb } from "./ledger";
import { formatMinor, toMinor, toMoneyDTOOrNull } from "./money";
import { notifySpend } from "./notify";
import { assistantLabel } from "./registry";
import { noteHumanDecision } from "./shadow";
import type { AdsActivateSet, AdsRaiseIntent, ApprovalDirection, ApprovalDTO, LedgerPot, Pot, SpendActor, SpendApprovalStatus, SpendApprovalVia, SpendRole } from "./types";

type Env = Record<string, string | undefined>;

const HOUR_MS = 3_600_000;
const json = (v: unknown): Prisma.InputJsonValue => jsonSafe(v ?? null) as Prisma.InputJsonValue;
const big = (v: unknown): bigint | null => (v === null || v === undefined ? null : typeof v === "bigint" ? v : BigInt(v as number | string));
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const date = (v: unknown): Date | null => (v instanceof Date ? v : v ? new Date(String(v)) : null);
const ledgerOf = (db: SpendDb) => db as unknown as LedgerDb;
const POTS = new Set(["ads", "messaging", "ai"]);

// =====================================================================================================================
// Copy
// =====================================================================================================================

export const APPROVER_ONLY = "Only the owner, or an admin the owner named as an approver, can approve spending.";
export const ADMIN_ONLY_DECIDE = "Only the owner or an admin can decide spending requests.";
export const NOT_A_MEMBER = "You are no longer a member of this workspace, so you can't decide this request.";
export const CHANGED_SINCE_ASKED = "The ad set changed since this was asked.";
export const STALE_REQUEST = "This request was already handled. Reload to see the latest.";
export const LINK_NOT_VALID = "This link isn't valid any more.";
export const SIGN_IN_TO_APPROVE = "Sign in to approve this request. You can decline it without signing in.";

/** "No longer fits your limits: ₹Y left, needs ₹X" (7.3). */
export function noLongerFitsText(left: { minor: bigint | number | string; currency: string }, needs: { minor: bigint | number | string; currency: string }): string {
  return `No longer fits your limits: ${formatMinor(left.minor, left.currency)} left, needs ${formatMinor(needs.minor, needs.currency)}`;
}

function ttlHoursOf(row: ApprovalRow): number {
  return Math.max(1, Math.round((row.expiresAt.getTime() - row.createdAt.getTime()) / HOUR_MS));
}

/** "Declined automatically (no answer in 12 hours)." (7.3) */
export function expiredText(ttlHours: number): string {
  return `Declined automatically (no answer in ${ttlHours} ${ttlHours === 1 ? "hour" : "hours"}).`;
}

/** The status line of a request: time left while pending, otherwise what happened. */
export function statusLine(row: ApprovalRow, now: Date): string {
  const status = displayStatus(row, now);
  switch (status) {
    case "pending": {
      const ms = row.expiresAt.getTime() - now.getTime();
      const hours = Math.floor(ms / HOUR_MS);
      if (hours >= 1) return `Declined automatically in ${hours} ${hours === 1 ? "hour" : "hours"}`;
      const minutes = Math.max(1, Math.ceil(ms / 60_000));
      return `Declined automatically in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
    }
    case "expired":
      return expiredText(ttlHoursOf(row));
    case "approved":
      return "Approved. Applying it now.";
    case "applied":
      return "Approved and applied.";
    case "declined":
      return "Declined. Nothing was changed.";
    case "failed":
      return `Approved, but not applied: ${row.failureReason ?? "it could not be applied."}`;
    case "superseded":
      return row.failureReason ?? "Replaced by a newer request.";
  }
}

// =====================================================================================================================
// Rows
// =====================================================================================================================

export type ApprovalRow = {
  id: string;
  tenantId: string;
  assistantKey: string;
  pot: Pot;
  actionKind: string;
  direction: ApprovalDirection;
  intent: unknown;
  fingerprint: string;
  summary: string;
  reason: string;
  forecastTodayMinor: bigint | null;
  forecastMonthMinor: bigint | null;
  currency: string | null;
  status: SpendApprovalStatus;
  tokenHash: string;
  expiresAt: Date;
  decidedByUserId: string | null;
  decidedVia: SpendApprovalVia | null;
  decidedAt: Date | null;
  appliedAt: Date | null;
  failureReason: string | null;
  proposalId: string | null;
  correlationId: string;
  createdAt: Date;
};

const STATUSES: readonly SpendApprovalStatus[] = ["pending", "approved", "declined", "expired", "applied", "failed", "superseded"];

export function toApprovalRow(raw: Record<string, unknown>): ApprovalRow {
  return {
    id: String(raw.id),
    tenantId: String(raw.tenantId),
    assistantKey: String(raw.assistantKey ?? ""),
    pot: (POTS.has(String(raw.pot)) ? raw.pot : "ads") as Pot,
    actionKind: String(raw.actionKind ?? ""),
    direction: raw.direction === "lower" ? "lower" : "raise",
    intent: raw.intent ?? null,
    fingerprint: String(raw.fingerprint ?? ""),
    summary: String(raw.summary ?? ""),
    reason: String(raw.reason ?? ""),
    forecastTodayMinor: big(raw.forecastTodayMinor),
    forecastMonthMinor: big(raw.forecastMonthMinor),
    currency: typeof raw.currency === "string" ? raw.currency : null,
    status: (STATUSES.includes(raw.status as SpendApprovalStatus) ? raw.status : "pending") as SpendApprovalStatus,
    tokenHash: String(raw.tokenHash ?? ""),
    expiresAt: date(raw.expiresAt) ?? new Date(0),
    decidedByUserId: (raw.decidedByUserId as string | null) ?? null,
    decidedVia: (raw.decidedVia as SpendApprovalVia | null) ?? null,
    decidedAt: date(raw.decidedAt),
    appliedAt: date(raw.appliedAt),
    failureReason: (raw.failureReason as string | null) ?? null,
    proposalId: (raw.proposalId as string | null) ?? null,
    correlationId: String(raw.correlationId ?? ""),
    createdAt: date(raw.createdAt) ?? new Date(0),
  };
}

/** A pending request past expiresAt counts as expired (declined) even before the expiry task runs (4.16). */
export function displayStatus(row: Pick<ApprovalRow, "status" | "expiresAt">, now: Date): SpendApprovalStatus {
  return row.status === "pending" && row.expiresAt.getTime() <= now.getTime() ? "expired" : row.status;
}

/** Whether the request is an optimizer suggestion (created by the daily run) rather than an assistant's ads intent. */
export function isProposalIntent(intent: unknown): boolean {
  return rec(intent).kind === "optimizer_proposal";
}

// =====================================================================================================================
// Who decides (7.3): re-checked at decision time
// =====================================================================================================================

export type ApproverCheck = { member: boolean; role: SpendRole | null; approver: boolean };

/** Still a member; the owner, or an admin listed in approverUserIds (pruned to current admins). */
export async function approverStatus(tenantId: string, userId: string, db: SpendDb = prisma): Promise<ApproverCheck> {
  const m = (await db.membership.findFirst({ where: { tenantId, userId }, select: { role: true } })) as { role?: string } | null;
  const role = m?.role === "owner" || m?.role === "admin" || m?.role === "agent" ? (m.role as SpendRole) : null;
  if (!role) return { member: false, role: null, approver: false };
  if (role === "owner") return { member: true, role, approver: true };
  if (role !== "admin") return { member: true, role, approver: false };
  const control = await getControl(tenantId, { db });
  return { member: true, role, approver: control.approverUserIds.includes(userId) };
}

/** True when the person may approve raises now. */
export async function isApprover(tenantId: string, userId: string, db: SpendDb = prisma): Promise<boolean> {
  return (await approverStatus(tenantId, userId, db)).approver;
}

// =====================================================================================================================
// DTOs (types.ts ApprovalDTO)
// =====================================================================================================================

export type ApprovalViewer = { userId: string; role: SpendRole; approver: boolean } | null;

/** The DTO the Spending page and the one-tap page show (pure). */
export function toApprovalDTO(row: ApprovalRow, ctx: { now: Date; viewer: ApprovalViewer; names?: ReadonlyMap<string, string> }): ApprovalDTO {
  const status = displayStatus(row, ctx.now);
  const currency = row.currency ?? "INR";
  const open = status === "pending";
  const admin = ctx.viewer?.role === "owner" || ctx.viewer?.role === "admin";
  const month = row.forecastMonthMinor;
  const reason = row.reason.trim();
  return {
    id: row.id,
    assistantKey: row.assistantKey,
    assistantLabel: assistantLabel(row.assistantKey),
    pot: row.pot,
    actionKind: row.actionKind,
    direction: row.direction,
    summary: row.summary,
    reason: reason ? (/^why:/i.test(reason) ? reason : `Why: ${reason}`) : "",
    forecastToday: toMoneyDTOOrNull(row.forecastTodayMinor, currency),
    forecastMonth: toMoneyDTOOrNull(row.forecastMonthMinor, currency),
    forecastText: month !== null && month > 0n ? `Could add up to ${formatMinor(month, currency)} this month (worst case)` : null,
    status,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    expiryText: statusLine(row, ctx.now),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedByName: row.decidedByUserId ? (ctx.names?.get(row.decidedByUserId) ?? null) : row.decidedVia === "system" ? "Edwyz" : null,
    decidedVia: row.decidedVia,
    failureReason: row.failureReason,
    canApprove: open && !!ctx.viewer && (row.direction === "lower" ? admin : ctx.viewer.approver),
    canDecline: open && admin,
  };
}

async function namesOf(db: SpendDb, ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (wanted.length === 0) return new Map();
  const users = ((await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true } })) ?? []) as { id: string; name?: string }[];
  return new Map(users.map((u) => [u.id, (u.name ?? "").trim().split(/\s+/)[0] || "A teammate"]));
}

export type ListApprovalsOptions = { status?: "pending" | "recent"; limit?: number; db?: SpendDb; now?: Date };

/** The workspace's requests for the "Waiting for you" card (pending, not expired) or the recent ones (14 days). */
export async function listApprovals(tenantId: string, viewer: { userId: string; role: SpendRole }, opts: ListApprovalsOptions = {}): Promise<ApprovalDTO[]> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const take = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const where = opts.status === "recent" ? { tenantId, createdAt: { gte: new Date(now.getTime() - 14 * 24 * HOUR_MS) } } : { tenantId, status: "pending", expiresAt: { gt: now } };
  const rows = (((await db.spendApproval.findMany({ where, orderBy: { createdAt: "desc" }, take })) ?? []) as Record<string, unknown>[]).map(toApprovalRow);
  const check = await approverStatus(tenantId, viewer.userId, db);
  const names = await namesOf(db, rows.map((r) => r.decidedByUserId));
  return rows.map((r) => toApprovalDTO(r, { now, viewer: { userId: viewer.userId, role: check.role ?? viewer.role, approver: check.approver }, names }));
}

/** How many requests are waiting (the banner, 8.2 item 4). */
export async function pendingApprovalCount(tenantId: string, opts: { db?: SpendDb; now?: Date } = {}): Promise<number> {
  const db = opts.db ?? prisma;
  return db.spendApproval.count({ where: { tenantId, status: "pending", expiresAt: { gt: opts.now ?? new Date() } } });
}

/** The pending request for an optimizer proposal, if any. */
export async function pendingApprovalForProposal(tenantId: string, proposalId: string, opts: { db?: SpendDb; now?: Date } = {}): Promise<ApprovalRow | null> {
  const db = opts.db ?? prisma;
  const raw = (await db.spendApproval.findFirst({ where: { tenantId, proposalId, status: "pending", expiresAt: { gt: opts.now ?? new Date() } }, orderBy: { createdAt: "desc" } })) as Record<string, unknown> | null;
  return raw ? toApprovalRow(raw) : null;
}

// =====================================================================================================================
// Creating a request for an optimizer suggestion (7.3 optimizer integration)
// =====================================================================================================================

export type ProposalIntent = {
  kind: "optimizer_proposal";
  proposalId: string;
  proposalKind: string;
  /** The object the request is about ("adset:<metaId>", "ad:<metaId>"); a newer request on it supersedes this one. */
  subject: string;
  /** Meta ids whose budget and status the fingerprint covers. */
  objectIds: string[];
  payload: Record<string, unknown>;
};

/** The current state of the objects an optimizer request touches, for its fingerprint. */
async function proposalObjects(db: SpendDb, tenantId: string, ids: string[]): Promise<FingerprintObject[]> {
  const out: FingerprintObject[] = [];
  for (const id of ids) {
    const set = (await db.adSet.findFirst({ where: { tenantId, metaAdSetId: id }, select: { status: true, dailyBudgetMinor: true, lifetimeBudgetMinor: true } })) as Record<string, unknown> | null;
    if (set) {
      out.push({ metaObjectId: id, status: (set.status as string) ?? null, dailyBudgetMinor: big(set.dailyBudgetMinor), lifetimeBudgetMinor: big(set.lifetimeBudgetMinor) });
      continue;
    }
    const ad = (await db.ad.findFirst({ where: { tenantId, metaAdId: id }, select: { status: true } })) as { status?: string } | null;
    out.push({ metaObjectId: id, status: ad?.status ?? null, dailyBudgetMinor: null });
  }
  return out;
}

/** The fingerprint of an optimizer request now: the proposal, its objects' budgets and statuses, and the ads limit version. */
export async function proposalFingerprint(tenantId: string, intent: ProposalIntent, db: SpendDb = prisma): Promise<string> {
  const allowance = await getAllowance(tenantId, "ads", db);
  return approvalFingerprint({
    intent: { kind: intent.kind, proposalId: intent.proposalId, proposalKind: intent.proposalKind, payload: intent.payload },
    objects: await proposalObjects(db, tenantId, intent.objectIds),
    allowanceVersion: allowance?.version ?? 0,
  });
}

/** The fingerprint a pending request would have now (either kind). Null when it cannot be computed. */
export async function currentFingerprint(row: ApprovalRow, opts: { db?: SpendDb; now?: Date; env?: Env } = {}): Promise<string | null> {
  const db = opts.db ?? prisma;
  if (isProposalIntent(row.intent)) return proposalFingerprint(row.tenantId, toProposalIntent(row.intent), db);
  const intent = parseAdsIntent(row.intent);
  if (!intent) return null;
  return currentAdsFingerprint(row.tenantId, intent, { db, now: opts.now, env: opts.env });
}

function toProposalIntent(raw: unknown): ProposalIntent {
  const i = rec(raw);
  return {
    kind: "optimizer_proposal",
    proposalId: String(i.proposalId ?? ""),
    proposalKind: String(i.proposalKind ?? ""),
    subject: String(i.subject ?? ""),
    objectIds: Array.isArray(i.objectIds) ? (i.objectIds as unknown[]).filter((x): x is string => typeof x === "string") : [],
    payload: rec(i.payload),
  };
}

export type ProposalApprovalInput = {
  tenantId: string;
  assistantKey: string;
  proposalId: string;
  proposalKind: string;
  direction: ApprovalDirection;
  /** "Raise the daily budget of 'Diwali leads - Delhi' from ₹800 to ₹1,000". */
  summary: string;
  /** The assistant's plain-language why (the rationale). */
  reason: string;
  subject: string;
  objectIds: string[];
  payload: Record<string, unknown>;
  forecastTodayMinor?: bigint | null;
  forecastMonthMinor?: bigint | null;
  currency?: string | null;
  /** Who asked: the assistant by default; an admin who escalates a suggestion to an approver (POST /api/spend/approvals). */
  actor?: SpendActor;
  /** The policy reason behind the request, for the ledger. */
  policyReason?: string;
  sandbox?: boolean;
};

export type CreatedApproval = { approvalId: string; expiresAt: Date; created: boolean; token: string | null };

async function supersedeSubject(tx: SpendDb, tenantId: string, subject: string, actor: SpendActor, now: Date, keepProposalId: string): Promise<string[]> {
  const pending = (((await tx.spendApproval.findMany({ where: { tenantId, status: "pending" }, take: 500 })) ?? []) as Record<string, unknown>[]).map(toApprovalRow);
  const same = pending.filter((p) => p.proposalId !== keepProposalId && (isProposalIntent(p.intent) ? toProposalIntent(p.intent).subject : intentSubjectOf(p.intent)) === subject);
  const done: string[] = [];
  for (const p of same) {
    const { count } = await tx.spendApproval.updateMany({ where: { id: p.id, status: "pending" }, data: { status: "superseded", decidedVia: "system", decidedAt: now, failureReason: "A newer request about the same ads replaced this one." } });
    if (count !== 1) continue;
    done.push(p.id);
    await appendStandalone(
      { tenantId, pot: p.pot, action: "approval.supersede", phase: "info", actor, reason: "A newer request about the same ads replaced this one.", reasonCodes: ["new_intent"], approvalId: p.id, targetType: "approval", targetId: p.id, idempotencyKey: `approval:${p.id}:supersede` },
      { tx: ledgerOf(tx) },
    );
  }
  return done;
}

/** The ads object an assistant's intent is about, in the same "adset:<id>" vocabulary as optimizer requests. */
function intentSubjectOf(intent: unknown): string | null {
  const i = rec(intent);
  if (i.kind === "raise_budget" || i.kind === "resume_adset") return typeof i.metaAdSetId === "string" ? `adset:${i.metaAdSetId}` : intentSubject(intent);
  if (i.kind === "resume_ad") return typeof i.metaAdId === "string" ? `ad:${i.metaAdId}` : intentSubject(intent);
  return intentSubject(intent);
}

/**
 * Creates the request for an optimizer suggestion that needs a person (policy needs_approval), with the proposal id. A
 * pending request for the same proposal is returned instead (a re-run never asks twice); an older pending request about the
 * same ads is superseded. Notifies approvers (raises) or admins (lowering suggestions) through the notify port.
 */
export async function createProposalApproval(input: ProposalApprovalInput, opts: { db?: SpendDb; now?: Date } = {}): Promise<CreatedApproval> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const actor: SpendActor = input.actor ?? { type: "assistant", assistantKey: input.assistantKey };
  const intent: ProposalIntent = { kind: "optimizer_proposal", proposalId: input.proposalId, proposalKind: input.proposalKind, subject: input.subject, objectIds: input.objectIds, payload: input.payload };
  const made = await inSpendTransaction(db, async (tx) => {
    const existing = (await tx.spendApproval.findFirst({ where: { tenantId: input.tenantId, proposalId: input.proposalId, status: "pending", expiresAt: { gt: now } } })) as Record<string, unknown> | null;
    if (existing) {
      const row = toApprovalRow(existing);
      return { approvalId: row.id, expiresAt: row.expiresAt, created: false, token: null };
    }
    await supersedeSubject(tx, input.tenantId, input.subject, actor, now, input.proposalId);
    const control = await getControl(input.tenantId, { db: tx, prune: false });
    const { token, tokenHash } = newApprovalToken();
    const expiresAt = new Date(now.getTime() + control.approvalTtlHours * HOUR_MS);
    const correlationId = newCorrelationId();
    const fingerprint = await proposalFingerprint(input.tenantId, intent, tx);
    const created = (await tx.spendApproval.create({
      data: {
        tenantId: input.tenantId,
        assistantKey: input.assistantKey,
        pot: "ads",
        actionKind: input.proposalKind,
        direction: input.direction,
        intent: json(intent),
        fingerprint,
        summary: input.summary,
        reason: input.reason,
        forecastTodayMinor: input.forecastTodayMinor ?? null,
        forecastMonthMinor: input.forecastMonthMinor ?? null,
        currency: input.currency ?? null,
        status: "pending",
        tokenHash,
        expiresAt,
        proposalId: input.proposalId,
        correlationId,
      },
      select: { id: true },
    })) as { id: string };
    await appendStandalone(
      {
        tenantId: input.tenantId,
        pot: "ads",
        action: "approval.create",
        phase: "info",
        actor,
        reason: input.reason || input.summary,
        reasonCodes: [input.direction, ...(input.policyReason ? [input.policyReason] : [])],
        approvalId: String(created.id),
        targetType: "optimizer_proposal",
        targetId: input.proposalId,
        metaObjectId: input.objectIds[0] ?? null,
        currency: input.currency ?? null,
        forecastTodayMinor: input.forecastTodayMinor ?? null,
        forecastMonthMinor: input.forecastMonthMinor ?? null,
        correlationId,
        sandbox: input.sandbox === true,
      },
      { tx: ledgerOf(tx) },
    );
    return { approvalId: String(created.id), expiresAt, created: true, token };
  });
  if (made.created) {
    const raise = input.direction === "raise";
    await notifySpend({
      tenantId: input.tenantId,
      kind: "approval_waiting",
      severity: raise ? "action_needed" : "heads_up",
      audience: raise ? "approvers" : "admins",
      dedupeKey: `spend-approval:${made.approvalId}`,
      title: "1 spending request is waiting",
      body: `${input.summary}. ${raise ? "Approve or decline it" : "Accept or decline it"} in Settings > Spending limits.`,
      link: "/app/settings/spending",
      approvalId: made.approvalId,
      subjectType: "spend_approval",
      subjectId: made.approvalId,
    });
  }
  return made;
}

// =====================================================================================================================
// Deciding
// =====================================================================================================================

export type ApprovalDecision = "approve" | "decline";

/** Who decides: a signed-in person, the holder of the link's token (decline only), the verified WhatsApp reply, or Edwyz. */
export type ApprovalDecider = { type: "user"; userId: string; role: SpendRole; reasonCodes?: readonly string[] } | { type: "token" } | { type: "whatsapp"; userId?: string } | { type: "system" };

export type DecideOptions = { db?: SpendDb; now?: Date; env?: Env };
export type DecideResult = { approval: ApprovalDTO; status: SpendApprovalStatus; text: string };

function deciderActor(d: ApprovalDecider): SpendActor {
  // A decision confirmed in Eddy keeps its via_eddy code on the ledger row (Phase 0 4.15, Eddy 7.7).
  if (d.type === "user") return { type: "user", userId: d.userId, role: d.role, ...(d.reasonCodes?.length ? { reasonCodes: [...d.reasonCodes] } : {}) };
  if (d.type === "token") return { type: "system", job: "approval_link" };
  if (d.type === "whatsapp") return { type: "system", job: "whatsapp_reply" };
  return { type: "system", job: "spend.approvals" };
}

async function loadRow(db: SpendDb, tenantId: string, id: string): Promise<ApprovalRow> {
  const raw = (await db.spendApproval.findFirst({ where: { id, tenantId } })) as Record<string, unknown> | null;
  if (!raw) throw new HttpError(404, "This request was not found.");
  return toApprovalRow(raw);
}

/** Marks one pending request past expiresAt as expired (declined), once, with its ledger row. */
async function expireRow(db: SpendDb, row: ApprovalRow, now: Date): Promise<boolean> {
  const { count } = await db.spendApproval.updateMany({ where: { id: row.id, status: "pending", expiresAt: { lte: now } }, data: { status: "expired", decidedVia: "system", decidedAt: now } });
  if (count !== 1) return false;
  await appendStandalone(
    { tenantId: row.tenantId, pot: row.pot as LedgerPot, action: "approval.expire", phase: "info", actor: { type: "system", job: "spend.approvals.expire" }, reason: expiredText(ttlHoursOf(row)), reasonCodes: ["expired"], approvalId: row.id, targetType: "approval", targetId: row.id, idempotencyKey: `approval:${row.id}:expire` },
    { db: ledgerOf(db) },
  );
  if (row.proposalId) {
    await noteHumanDecision(row.tenantId, { proposalId: row.proposalId, approvalId: row.id }, "expired", null, { db, now });
    await proposalHook("expired", row, null).catch(() => undefined);
  }
  return true;
}

function closedText(row: ApprovalRow, now: Date): string {
  const s = displayStatus(row, now);
  if (s === "expired") return `This request expired. ${expiredText(ttlHoursOf(row))}`;
  if (s === "superseded") return `This request was replaced. ${row.failureReason ?? ""}`.trim();
  if (s === "declined") return "This request was already declined.";
  if (s === "approved" || s === "applied") return "This request was already approved.";
  if (s === "failed") return `This request was already approved, but it could not be applied: ${row.failureReason ?? ""}`.trim();
  return STALE_REQUEST;
}

/** Permissions at decision time (7.3). Throws the 403 to show. */
async function assertMayDecide(db: SpendDb, row: ApprovalRow, decision: ApprovalDecision, decider: ApprovalDecider): Promise<void> {
  if (decision === "approve" && decider.type !== "user") throw new HttpError(401, SIGN_IN_TO_APPROVE);
  if (decider.type !== "user") return;
  const check = await approverStatus(row.tenantId, decider.userId, db);
  if (!check.member) throw new HttpError(403, NOT_A_MEMBER);
  const admin = check.role === "owner" || check.role === "admin";
  if (decision === "decline" || row.direction === "lower") {
    if (!admin) throw new HttpError(403, ADMIN_ONLY_DECIDE);
    return;
  }
  if (!check.approver) throw new HttpError(403, APPROVER_ONLY);
}

/**
 * Approves or declines one request (the app, the one-tap link, the WhatsApp quick reply). Approving applies it at once; the
 * result says whether it was applied, and the request ends `applied` or `failed` with the reason.
 */
export async function decideApproval(tenantId: string, approvalId: string, decision: ApprovalDecision, via: SpendApprovalVia, decider: ApprovalDecider, opts: DecideOptions = {}): Promise<DecideResult> {
  if (decision !== "approve" && decision !== "decline") throw new HttpError(400, "Choose approve or decline.");
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const row = await loadRow(db, tenantId, approvalId);
  await assertMayDecide(db, row, decision, decider);
  const actor = deciderActor(decider);
  const userId = decider.type === "user" ? decider.userId : decider.type === "whatsapp" ? (decider.userId ?? null) : null;

  // The one conditional UPDATE (7.3): only a pending request that has not expired changes.
  const { count } = await db.spendApproval.updateMany({
    where: { id: row.id, tenantId, status: "pending", expiresAt: { gt: now } },
    data: { status: decision === "approve" ? "approved" : "declined", decidedByUserId: userId, decidedVia: via, decidedAt: now },
  });
  if (count !== 1) {
    const fresh = await loadRow(db, tenantId, approvalId);
    if (fresh.status === "pending" && fresh.expiresAt.getTime() <= now.getTime()) {
      await expireRow(db, fresh, now);
      throw new HttpError(410, `This request expired. ${expiredText(ttlHoursOf(fresh))}`);
    }
    throw new HttpError(409, closedText(fresh, now));
  }
  await appendStandalone(
    {
      tenantId,
      pot: row.pot as LedgerPot,
      action: decision === "approve" ? "approval.approve" : "approval.decline",
      phase: "info",
      actor,
      reason: decision === "approve" ? `Approved: ${row.summary}` : `Declined: ${row.summary}`,
      reasonCodes: [via],
      approvalId: row.id,
      targetType: "approval",
      targetId: row.id,
      currency: row.currency,
      forecastTodayMinor: row.forecastTodayMinor,
      forecastMonthMinor: row.forecastMonthMinor,
      idempotencyKey: `approval:${row.id}:${decision}`,
    },
    { db: ledgerOf(db) },
  );
  if (row.proposalId) await noteHumanDecision(tenantId, { proposalId: row.proposalId, approvalId: row.id }, decision === "approve" ? "approved" : "declined", userId, { db, now });

  if (decision === "decline") {
    if (row.proposalId) await proposalHook("declined", row, userId).catch((e) => console.error(`[spend] declined proposal not updated: ${describeError(e)}`));
    const after = await loadRow(db, tenantId, approvalId);
    return { approval: await dtoFor(db, after, decider, now), status: after.status, text: "Declined. Nothing was changed." };
  }

  // Approve: apply it now, as 7.3 says (every check of the book again, except the autonomy step).
  let text = "Approved and applied.";
  try {
    await applyApproved(db, row, decider as Extract<ApprovalDecider, { type: "user" }>, now, opts.env);
    await db.spendApproval.updateMany({ where: { id: row.id, status: "approved" }, data: { status: "applied", appliedAt: new Date() } });
    await appendStandalone(
      { tenantId, pot: row.pot as LedgerPot, action: "approval.apply", phase: "info", actor, reason: `Applied: ${row.summary}`, reasonCodes: ["applied"], approvalId: row.id, targetType: "approval", targetId: row.id, idempotencyKey: `approval:${row.id}:apply` },
      { db: ledgerOf(db) },
    );
  } catch (error) {
    text = failureText(error);
    await db.spendApproval.updateMany({ where: { id: row.id, status: "approved" }, data: { status: "failed", failureReason: text.slice(0, 500) } });
    await appendStandalone(
      { tenantId, pot: row.pot as LedgerPot, action: "approval.apply", phase: "info", actor, reason: text, reasonCodes: ["failed", errorCode(error)], approvalId: row.id, targetType: "approval", targetId: row.id, idempotencyKey: `approval:${row.id}:apply` },
      { db: ledgerOf(db) },
    );
  }
  const after = await loadRow(db, tenantId, approvalId);
  return { approval: await dtoFor(db, after, decider, now), status: after.status, text: after.status === "applied" ? "Approved and applied." : text };
}

async function dtoFor(db: SpendDb, row: ApprovalRow, decider: ApprovalDecider, now: Date): Promise<ApprovalDTO> {
  const viewer: ApprovalViewer = decider.type === "user" ? { userId: decider.userId, role: decider.role, approver: (await approverStatus(row.tenantId, decider.userId, db)).approver } : null;
  return toApprovalDTO(row, { now, viewer, names: await namesOf(db, [row.decidedByUserId]) });
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" ? code.slice(0, 60) : error instanceof HttpError ? `http_${error.status}` : "error";
}

class ApprovalChangedError extends HttpError {
  constructor() {
    super(409, CHANGED_SINCE_ASKED);
    this.name = "ApprovalChangedError";
  }
}

/** The plain sentence a failed apply is stored with (7.3). */
export function failureText(error: unknown): string {
  if (error instanceof SpendBlockedError && error.params.left && error.params.needs) return noLongerFitsText(error.params.left, error.params.needs);
  if (error instanceof SpendBlockedError) return error.message;
  if (error instanceof HttpError) return error.message;
  console.error(`[spend] an approved request could not be applied: ${describeError(error)}`);
  return "It could not be applied, so nothing was changed. Try again later.";
}

/** An ads intent read back from the stored JSON (amounts as strings, dates as ISO strings). Null for anything else. */
export function parseAdsIntent(raw: unknown): AdsRaiseIntent | null {
  const i = rec(raw);
  const s = (v: unknown) => (typeof v === "string" && v ? v : null);
  try {
    switch (i.kind) {
      case "raise_budget": {
        const adSetId = s(i.adSetId);
        const metaAdSetId = s(i.metaAdSetId);
        if (!adSetId || !metaAdSetId || i.toMinor === undefined || i.toMinor === null) return null;
        return { kind: "raise_budget", adSetId, metaAdSetId, toMinor: toMinor(i.toMinor as string), ...(s(i.shiftFromAdSetId) ? { shiftFromAdSetId: s(i.shiftFromAdSetId)! } : {}) };
      }
      case "resume_ad": {
        const adId = s(i.adId);
        const metaAdId = s(i.metaAdId);
        return adId && metaAdId ? { kind: "resume_ad", adId, metaAdId } : null;
      }
      case "resume_adset": {
        const adSetId = s(i.adSetId);
        const metaAdSetId = s(i.metaAdSetId);
        return adSetId && metaAdSetId ? { kind: "resume_adset", adSetId, metaAdSetId } : null;
      }
      case "extend_end": {
        const campaignId = s(i.campaignId);
        const endsAt = date(i.endsAt);
        return campaignId && endsAt ? { kind: "extend_end", campaignId, endsAt } : null;
      }
      case "activate": {
        const campaignId = s(i.campaignId);
        if (!campaignId || !Array.isArray(i.sets)) return null;
        const sets: AdsActivateSet[] = [];
        for (const raw of i.sets as unknown[]) {
          const x = rec(raw);
          const adSetId = s(x.adSetId);
          const metaAdSetId = s(x.metaAdSetId);
          if (!adSetId || !metaAdSetId) return null;
          sets.push({
            adSetId,
            metaAdSetId,
            ...(x.dailyBudgetMinor !== undefined && x.dailyBudgetMinor !== null ? { dailyBudgetMinor: toMinor(x.dailyBudgetMinor as string) } : {}),
            ...(x.lifetimeBudgetMinor !== undefined && x.lifetimeBudgetMinor !== null ? { lifetimeBudgetMinor: toMinor(x.lifetimeBudgetMinor as string) } : {}),
            ...(date(x.endsAt) ? { endsAt: date(x.endsAt)! } : {}),
          });
        }
        return { kind: "activate", campaignId, sets };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Runs an approved request. Throws with the reason when it cannot be applied. */
async function applyApproved(db: SpendDb, row: ApprovalRow, approver: Extract<ApprovalDecider, { type: "user" }>, now: Date, env?: Env): Promise<void> {
  if (isProposalIntent(row.intent)) {
    const intent = toProposalIntent(row.intent);
    if ((await proposalFingerprint(row.tenantId, intent, db)) !== row.fingerprint) throw new ApprovalChangedError();
    const { applyProposalForApproval } = await import("@/lib/optimizer/service");
    await applyProposalForApproval(row.tenantId, intent.proposalId, { userId: approver.userId, role: approver.role }, row.id);
    return;
  }
  const intent = parseAdsIntent(row.intent);
  if (!intent) throw new HttpError(409, "This request can't be read any more, so nothing was changed.");
  if ((await currentAdsFingerprint(row.tenantId, intent, { db, now, env })) !== row.fingerprint) throw new ApprovalChangedError();
  // The assistant's own request, now approved: every check of the book runs again except the autonomy step (7.3).
  const actor: SpendActor = { type: "assistant", assistantKey: row.assistantKey, approvalId: row.id };
  const common = { approvalId: row.id, idempotencyKey: `approval:${row.id}`, reason: row.reason || row.summary };
  switch (intent.kind) {
    case "raise_budget": {
      const to = intent.toMinor;
      if (to > BigInt(Number.MAX_SAFE_INTEGER)) throw new HttpError(400, "That budget is too large.");
      const { setAdSetBudget } = await import("@/lib/ads/actions");
      await setAdSetBudget(row.tenantId, intent.metaAdSetId, Number(to), actor, { ...common, ...(intent.shiftFromAdSetId ? { shiftFromAdSetId: intent.shiftFromAdSetId } : {}) });
      return;
    }
    case "resume_ad": {
      const { resumeAd } = await import("@/lib/ads/actions");
      await resumeAd(row.tenantId, intent.metaAdId, { action: "resume_ad", metaAdId: intent.metaAdId, previousStatus: "active" }, actor, common);
      return;
    }
    case "activate": {
      const { activateCampaign, getCampaign } = await import("@/lib/ads/service");
      const c = await getCampaign(row.tenantId, intent.campaignId);
      await activateCampaign({ userId: approver.userId, tenantId: row.tenantId, role: approver.role }, intent.campaignId, { confirm: true, confirmedTotalMinor: c.confirmTotalMinor }, "activate", { spendActor: actor, approvalId: row.id, idempotencyKey: common.idempotencyKey });
      return;
    }
    default:
      throw new HttpError(409, "This kind of request can't be applied from here yet, so nothing was changed. Make the change on the Ads page.");
  }
}

/** Tells the optimizer that its proposal's request was declined or expired (it owns the proposal's state). */
async function proposalHook(how: "declined" | "expired", row: ApprovalRow, userId: string | null): Promise<void> {
  if (!row.proposalId) return;
  const { proposalRequestClosed } = await import("@/lib/optimizer/service");
  await proposalRequestClosed(row.tenantId, row.proposalId, how, userId);
}

// =====================================================================================================================
// The one-tap link (7.4): /s/<token>
// =====================================================================================================================

async function rowByToken(db: SpendDb, token: string): Promise<ApprovalRow | null> {
  if (!isApprovalTokenShape(token)) return null;
  const raw = (await db.spendApproval.findFirst({ where: { tokenHash: hashApprovalToken(token) } })) as Record<string, unknown> | null;
  return raw ? toApprovalRow(raw) : null;
}

export type SessionLike = { userId: string; tenantId: string; role: SpendRole } | null;

export type TokenView = {
  approval: ApprovalDTO;
  workspaceName: string;
  signedIn: boolean;
  /** Signed in to the workspace the request is for. */
  sameWorkspace: boolean;
  /** The approve button sends a signed-in approver to sign in first, then back here (7.4). */
  needsSignInToApprove: boolean;
};

/** What the one-tap page shows for a token. Null for a token that does not exist (the page shows one plain message). */
export async function viewByToken(token: string, session: SessionLike, opts: { db?: SpendDb; now?: Date } = {}): Promise<TokenView | null> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const row = await rowByToken(db, token);
  if (!row) return null;
  const same = !!session && session.tenantId === row.tenantId;
  const check = same ? await approverStatus(row.tenantId, session!.userId, db) : null;
  const viewer: ApprovalViewer = same && check?.role ? { userId: session!.userId, role: check.role, approver: check.approver } : null;
  const dto = toApprovalDTO(row, { now, viewer, names: await namesOf(db, [row.decidedByUserId]) });
  // Decline works with the token alone (it only lowers risk).
  const open = dto.status === "pending";
  const tenant = (await db.tenant.findFirst({ where: { id: row.tenantId }, select: { name: true } })) as { name?: string } | null;
  return {
    approval: { ...dto, canDecline: open },
    workspaceName: tenant?.name ?? "your workspace",
    signedIn: !!session,
    sameWorkspace: same,
    needsSignInToApprove: open && !same,
  };
}

/** A decision from the one-tap page: decline with the token alone; approve only with a signed-in approver of that workspace. */
export async function decideByToken(token: string, decision: ApprovalDecision, session: SessionLike, opts: DecideOptions = {}): Promise<DecideResult & { tenantId: string }> {
  const db = opts.db ?? prisma;
  const row = await rowByToken(db, token);
  if (!row) throw new HttpError(404, LINK_NOT_VALID);
  if (decision === "decline") {
    const decider: ApprovalDecider = session && session.tenantId === row.tenantId ? { type: "user", userId: session.userId, role: session.role } : { type: "token" };
    // A signed-in member who is not an admin still declines with the token, like anyone holding the link.
    const asUser = decider.type === "user" && (session!.role === "owner" || session!.role === "admin");
    const out = await decideApproval(row.tenantId, row.id, "decline", "link", asUser ? decider : { type: "token" }, opts);
    return { ...out, tenantId: row.tenantId };
  }
  if (!session) throw new HttpError(401, SIGN_IN_TO_APPROVE);
  if (session.tenantId !== row.tenantId) throw new HttpError(403, "Switch to the workspace this request is for, then approve it.");
  const out = await decideApproval(row.tenantId, row.id, "approve", "link", { type: "user", userId: session.userId, role: session.role }, opts);
  return { ...out, tenantId: row.tenantId };
}

/** The tenant of a token, for the route's paywall check before approving a raise. Null when unknown. */
export async function approvalForToken(token: string, opts: { db?: SpendDb } = {}): Promise<ApprovalRow | null> {
  return rowByToken(opts.db ?? prisma, token);
}

/** One request of a workspace (the routes' paywall check). */
export async function getApproval(tenantId: string, approvalId: string, opts: { db?: SpendDb } = {}): Promise<ApprovalRow> {
  return loadRow(opts.db ?? prisma, tenantId, approvalId);
}

// =====================================================================================================================
// Background: expiry (every 5 min) and fingerprint supersede
// =====================================================================================================================

export type SweepOptions = { db?: SpendDb; now?: Date; limit?: number; env?: Env };

/** spend.approvals.expire: every pending request past expiresAt becomes `expired` (declined), each ledgered once. */
export async function expireApprovals(opts: SweepOptions = {}): Promise<{ expired: number }> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const rows = (((await db.spendApproval.findMany({ where: { status: "pending", expiresAt: { lte: now } }, orderBy: { expiresAt: "asc" }, take: Math.min(opts.limit ?? 500, 2_000) })) ?? []) as Record<string, unknown>[]).map(toApprovalRow);
  let expired = 0;
  for (const row of rows) {
    try {
      if (await expireRow(db, row, now)) expired++;
    } catch (error) {
      console.error(`[spend] a request could not be expired: ${describeError(error)}`);
    }
  }
  return { expired };
}

/**
 * A pending request whose objects or limits changed since it was asked is superseded (7.3): "The ad set changed since this
 * was asked." Approving it would fail anyway; this keeps the "Waiting for you" card honest.
 */
export async function supersedeChangedApprovals(opts: SweepOptions = {}): Promise<{ superseded: number }> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const rows = (((await db.spendApproval.findMany({ where: { status: "pending", expiresAt: { gt: now } }, orderBy: { createdAt: "asc" }, take: Math.min(opts.limit ?? 50, 500) })) ?? []) as Record<string, unknown>[]).map(toApprovalRow);
  let superseded = 0;
  for (const row of rows) {
    try {
      const fp = await currentFingerprint(row, { db, now, env: opts.env });
      if (fp === null || fp === row.fingerprint) continue;
      const { count } = await db.spendApproval.updateMany({ where: { id: row.id, status: "pending" }, data: { status: "superseded", decidedVia: "system", decidedAt: now, failureReason: CHANGED_SINCE_ASKED } });
      if (count !== 1) continue;
      superseded++;
      await appendStandalone(
        { tenantId: row.tenantId, pot: row.pot as LedgerPot, action: "approval.supersede", phase: "info", actor: { type: "system", job: "spend.approvals.expire" }, reason: CHANGED_SINCE_ASKED, reasonCodes: ["fingerprint_changed"], approvalId: row.id, targetType: "approval", targetId: row.id, idempotencyKey: `approval:${row.id}:supersede` },
        { db: ledgerOf(db) },
      );
    } catch (error) {
      console.error(`[spend] a request's fingerprint could not be checked: ${describeError(error)}`);
    }
  }
  return { superseded };
}
