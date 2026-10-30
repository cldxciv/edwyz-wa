import * as adsActions from "@/lib/ads/actions";
import { pauseAd, setAdSetBudget } from "@/lib/ads/actions";
import { createApproval, getOptimizerClientDecisions, type OptimizerClientDecision } from "@/lib/approvals";
import { audit } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { describeError } from "@/lib/safe-error";
import { approverStatus, createProposalApproval, decideApproval, pendingApprovalForProposal } from "@/lib/spend/approvals";
import type { BreakerScopeRef } from "@/lib/spend/breakers/state";
import { formatMinor } from "@/lib/spend/money";
import type { PolicyDelta, PolicyIntent } from "@/lib/spend/policy";
import { noteHumanDecision } from "@/lib/spend/shadow";
import type { SpendActor, SpendRole } from "@/lib/spend/types";
import { ceil175 } from "@/lib/spend/worstcase";
import { HttpError, type Actor } from "@/lib/tenancy";
import { getBudgetCap, getOptimizerConfig } from "./config";

/*
 * Optimizer proposals: listing, approving, rejecting and reverting (docs/SPEND-CONTROLS-SPEC.md 4.8, 7.2, 7.3, 2.3.10).
 *
 * - The optimizer is the `ads_optimizer` assistant. A suggestion a person accepts runs as that person's action (actor user,
 *   with assistantKey ads_optimizer and the approvalId when a spending request exists), through the ads actions, which go
 *   through the Spend Book.
 * - Approving a raising kind (raise_budget, resume, or a shift whose raise is bigger than its cut) needs the owner or an admin
 *   the owner named as an approver; a net-zero shift and a pause may be decided by any admin. The same rule holds for
 *   reverting: reverting a pause or a cut is a raise, reverting a raise is a lowering.
 * - When a spending request is waiting for the proposal, approving or rejecting it from the optimizer page decides that
 *   request, so the one conditional update in spend/approvals.ts applies it once, whichever surface the tap came from.
 * - Suggestions expire after `expireHours` (default 12, like a spending request).
 */

export type ProposalStatus = "proposed" | "approved" | "applied" | "rejected" | "expired" | "failed" | "reverting" | "reverted";

const TRANSITIONS: Record<ProposalStatus, ProposalStatus[]> = {
  proposed: ["approved", "rejected", "expired"],
  approved: ["applied", "failed", "rejected"],
  applied: ["reverting"],
  reverting: ["reverted", "applied"],
  rejected: [],
  expired: [],
  failed: [],
  reverted: [],
};

export const canTransition = (from: string, to: string) => (TRANSITIONS[from as ProposalStatus] ?? []).includes(to as ProposalStatus);

export const OPTIMIZER_ASSISTANT = "ads_optimizer";
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const STATUSES = Object.keys(TRANSITIONS);
const KINDS = ["pause_ad", "shift_budget", "rotate_creative", "new_angle", "raise_budget"];
export const APPROVER_ONLY_PROPOSAL = "Only the owner, or an admin the owner named as an approver, can approve this change because it raises spending. Ask the owner to approve it.";
export const APPROVER_ONLY_REVERT = "Undoing this turns spending back up, so only the owner, or an admin the owner named as an approver, can do it.";

type Row = NonNullable<Awaited<ReturnType<typeof prisma.optimizerProposal.findFirst>>>;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

async function transition(tenantId: string, id: string, from: ProposalStatus, to: ProposalStatus, data: Record<string, unknown> = {}): Promise<boolean> {
  if (!canTransition(from, to)) throw new Error(`Invalid proposal transition ${from} to ${to}.`);
  const res = await prisma.optimizerProposal.updateMany({ where: { id, tenantId, status: from }, data: { ...data, status: to } });
  return res.count === 1;
}

export async function listProposals(actor: Actor, filter: { status?: string; kind?: string; limit?: number; cursor?: string }) {
  const statuses = filter.status ? filter.status.split(",") : [];
  if (statuses.length > STATUSES.length || statuses.some((st) => !STATUSES.includes(st))) throw new HttpError(400, "Unknown status.");
  if (filter.kind && !KINDS.includes(filter.kind)) throw new HttpError(400, "Unknown kind.");
  const take = Math.min(Math.max(filter.limit ?? 50, 1), 100);
  const rows = await prisma.optimizerProposal.findMany({
    where: { tenantId: actor.tenantId, ...(statuses.length === 1 ? { status: statuses[0] } : statuses.length > 1 ? { status: { in: statuses } } : {}), ...(filter.kind ? { kind: filter.kind } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, take);
  const decisions = await getOptimizerClientDecisions(actor.tenantId, page.map((r) => r.id));
  return { proposals: page.map((r) => ({ ...r, clientDecision: decisions.get(r.id) ?? null })), nextCursor: rows.length > take ? page[page.length - 1].id : null };
}

export async function getProposal(actor: Actor, id: string): Promise<Row> {
  return loadProposal(actor.tenantId, id);
}

async function loadProposal(tenantId: string, id: string): Promise<Row> {
  const row = await prisma.optimizerProposal.findFirst({ where: { id, tenantId } });
  if (!row) throw new HttpError(404, "Proposal not found.");
  return row;
}

export type { OptimizerClientDecision };

type Applied = { revertPayload: Record<string, unknown> | null };
type Person = { userId: string; role: SpendRole };

/**
 * The person who decided, as the Spend Book records them (4.8, 2.3.10): their own action, with the assistant whose suggestion
 * it was and the spending request behind it.
 */
const decider = (who: Person, approvalId?: string): SpendActor => ({ type: "user", userId: who.userId, role: who.role, assistantKey: OPTIMIZER_ASSISTANT, ...(approvalId ? { approvalId } : {}) });
const assistantActor: SpendActor = { type: "assistant", assistantKey: OPTIMIZER_ASSISTANT };

// =====================================================================================================================
// What a proposal does to spending
// =====================================================================================================================

/** True when applying the proposal can raise spending: a raise, a resume, or a shift whose raise is bigger than its cut. */
export function isRaisingProposal(kind: string, payload: unknown): boolean {
  if (kind === "raise_budget" || kind === "resume_ad") return true;
  if (kind !== "shift_budget") return false;
  const p = rec(payload);
  const cut = num(p.fromBudgetBefore) - num(p.fromBudgetAfter);
  const raise = num(p.toBudgetAfter) - num(p.toBudgetBefore);
  if (Number.isNaN(cut) || Number.isNaN(raise)) return true;
  return raise > cut;
}

/**
 * Undoing an applied proposal raises spending when it turns a paused ad back on. Undoing a raise is a cut, and undoing a
 * zero-sum shift restores both budgets (its restoring raise names the cut made just before it, so the book counts it freed).
 */
export function isRaisingRevert(kind: string, revert: unknown): boolean {
  return kind === "pause_ad" || rec(revert).kind === "pause_ad";
}

async function assertApprover(tenantId: string, who: Person, message: string): Promise<void> {
  if (!(await approverStatus(tenantId, who.userId)).approver) throw new HttpError(403, message);
}

/** Ad set names live only in the server's sentence: Ad set "A" costs ... for "B" ... */
function shiftNames(rationale: string): { from: string; to: string } | null {
  const m = /Ad set "(.+?)" costs .* for "(.+?)" over/.exec(rationale);
  return m ? { from: m[1], to: m[2] } : null;
}

export type ProposalPlan = {
  direction: "raise" | "lower";
  summary: string;
  /** "adset:<metaId>" / "ad:<metaId>": a newer request on it replaces an older one. */
  subject: string;
  objectIds: string[];
  intent: PolicyIntent;
  delta: PolicyDelta;
  scopes: BreakerScopeRef[];
  forecastTodayMinor: bigint | null;
  forecastMonthMinor: bigint | null;
  /** raise_budget and shift: the ad set whose budget goes up, and its budget before. */
  raiseTarget: { metaAdSetId: string; budgetBefore: number } | null;
};

/** Days left in the month after today (inclusive of today), in UTC: only for the policy's first look; the book recomputes. */
const daysLeftInMonth = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate() - now.getUTCDate() + 1;

/** What a proposal does to spending, for the policy and for a spending request. Null for advice that changes nothing. */
export function proposalPlan(row: { kind: string; targetMetaId: string; rationale: string; payload: unknown }, currency = "INR", now: Date = new Date()): ProposalPlan | null {
  const p = rec(row.payload);
  const money = (minor: number) => formatMinor(BigInt(Math.max(0, Math.round(minor))), currency);
  if (row.kind === "pause_ad") {
    const name = typeof p.adName === "string" && p.adName ? p.adName : "an ad";
    return {
      direction: "lower",
      summary: `Pause the ad '${name}'`,
      subject: `ad:${row.targetMetaId}`,
      objectIds: [row.targetMetaId],
      intent: { op: "pause", kind: "lowering" },
      delta: { todayMinor: 0n, monthMinor: 0n },
      scopes: [],
      forecastTodayMinor: null,
      forecastMonthMinor: null,
      raiseTarget: null,
    };
  }
  if (row.kind === "shift_budget") {
    const from = String(p.fromAdSetMetaId ?? "");
    const to = String(p.toAdSetMetaId ?? "");
    const names = shiftNames(row.rationale);
    const raising = isRaisingProposal(row.kind, p);
    const amount = num(p.toBudgetAfter) - num(p.toBudgetBefore);
    const extra = raising && !Number.isNaN(amount) ? Math.max(0, amount - (num(p.fromBudgetBefore) - num(p.fromBudgetAfter))) : 0;
    const today = ceil175(BigInt(Math.round(extra)));
    return {
      direction: raising ? "raise" : "lower",
      summary: `Move ${Number.isNaN(amount) ? "some" : money(amount)} a day from '${names?.from ?? "one ad set"}' to '${names?.to ?? "another"}'`,
      subject: `adset:${to}`,
      objectIds: [from, to],
      intent: { op: "raise_budget", kind: "raise", toMinor: Number.isNaN(num(p.toBudgetAfter)) ? null : BigInt(num(p.toBudgetAfter)), dayStartBudgetMinor: Number.isNaN(num(p.toBudgetBefore)) ? null : BigInt(num(p.toBudgetBefore)) },
      delta: { todayMinor: today, monthMinor: today * BigInt(daysLeftInMonth(now)) },
      scopes: [
        { scopeType: "adset", scopeId: to },
        { scopeType: "adset", scopeId: from },
      ],
      forecastTodayMinor: raising ? today : null,
      forecastMonthMinor: raising ? today * BigInt(daysLeftInMonth(now)) : null,
      raiseTarget: { metaAdSetId: to, budgetBefore: num(p.toBudgetBefore) },
    };
  }
  if (row.kind === "raise_budget") {
    const id = String(p.adSetMetaId ?? row.targetMetaId);
    const before = num(p.budgetBefore);
    const after = num(p.budgetAfter);
    const name = typeof p.adSetName === "string" && p.adSetName ? p.adSetName : "an ad set";
    const rise = Number.isNaN(before) || Number.isNaN(after) ? 0 : Math.max(0, after - before);
    const today = ceil175(BigInt(Math.round(rise)));
    return {
      direction: "raise",
      summary: `Raise the daily budget of '${name}' from ${money(before)} to ${money(after)}`,
      subject: `adset:${id}`,
      objectIds: [id],
      intent: { op: "raise_budget", kind: "raise", toMinor: Number.isNaN(after) ? null : BigInt(after), dayStartBudgetMinor: Number.isNaN(before) ? null : BigInt(before) },
      delta: { todayMinor: today, monthMinor: today * BigInt(daysLeftInMonth(now)) },
      scopes: [{ scopeType: "adset", scopeId: id }],
      forecastTodayMinor: today,
      forecastMonthMinor: today * BigInt(daysLeftInMonth(now)),
      raiseTarget: { metaAdSetId: id, budgetBefore: before },
    };
  }
  return null;
}

// =====================================================================================================================
// Applying
// =====================================================================================================================

async function applyPause(row: Row, by: SpendActor): Promise<Applied> {
  const res = await pauseAd(row.tenantId, row.targetMetaId, by, { reason: "Applied an approved suggestion: pause an ad that costs too much per result." });
  return { revertPayload: { kind: "pause_ad", adMetaId: row.targetMetaId, native: res.revertPayload } };
}

async function checkedShift(row: Row) {
  const p = rec(row.payload);
  const [fromId, toId] = [String(p.fromAdSetMetaId ?? ""), String(p.toAdSetMetaId ?? "")];
  const [fromBefore, fromAfter, toBefore, toAfter] = [num(p.fromBudgetBefore), num(p.fromBudgetAfter), num(p.toBudgetBefore), num(p.toBudgetAfter)];
  if (!fromId || !toId || fromId === toId || [fromBefore, fromAfter, toBefore, toAfter].some(Number.isNaN)) throw new HttpError(409, "The proposal data is not valid.");
  const cfg = await getOptimizerConfig(row.tenantId);
  const cap = await getBudgetCap(row.tenantId);
  const moved = fromBefore - fromAfter;
  if (cap === null) throw new HttpError(409, "Set a daily budget cap in your ad settings before budget changes can be applied.");
  if (moved <= 0 || toAfter - toBefore !== moved) throw new HttpError(409, "The proposal data is not valid.");
  if (moved > Math.floor((fromBefore * Math.min(cfg.maxShiftPct, 20)) / 100)) throw new HttpError(409, "The change is larger than the allowed share of the budget.");
  if (toAfter > cap) throw new HttpError(409, "The change would exceed your daily budget cap.");
  if (fromAfter < cfg.minAdSetBudgetMinor) throw new HttpError(409, "The change would take the budget below the allowed minimum.");
  const sets = await prisma.adSet.findMany({ where: { tenantId: row.tenantId, metaAdSetId: { in: [fromId, toId] } }, select: { metaAdSetId: true, dailyBudgetMinor: true } });
  const live = (id: string) => sets.find((s) => s.metaAdSetId === id)?.dailyBudgetMinor;
  if (live(fromId) !== fromBefore || live(toId) !== toBefore) throw new HttpError(409, "The budgets changed since this was proposed. Wait for the next run.");
  return { fromId, toId, fromBefore, fromAfter, toBefore, toAfter };
}

/**
 * A shift is zero-sum (checkedShift guarantees to-raise equals from-cut). The cut goes first (a lowering, never refused); the
 * raise names that cut (shiftFromAdSetId), so the Spend Book counts the freed budget when it checks the raise against the
 * limits at Meta's worst case. If the raise is refused, the cut is undone and the proposal fails: it is never left half applied.
 */
async function applyShift(row: Row, by: SpendActor): Promise<Applied> {
  const c = await checkedShift(row);
  const reason = "Applied an approved suggestion: move budget to the ad set with better results.";
  const first = await setAdSetBudget(row.tenantId, c.fromId, c.fromAfter, by, { reason });
  let second: Awaited<ReturnType<typeof setAdSetBudget>>;
  try {
    second = await setAdSetBudget(row.tenantId, c.toId, c.toAfter, by, { reason, shiftFromAdSetId: c.fromId });
    if (second.clamped === true) {
      await setAdSetBudget(row.tenantId, c.toId, c.toBefore, by, { reason }).catch(() => undefined);
      throw new HttpError(409, "The workspace daily budget cap left no room for the full change. Nothing was changed.");
    }
  } catch (e) {
    await setAdSetBudget(row.tenantId, c.fromId, c.fromBefore, by, { reason: "Undid the first half of a budget move that could not finish." }).catch(() => undefined);
    throw e;
  }
  return {
    revertPayload: {
      kind: "shift_budget",
      steps: [
        { adSetMetaId: c.toId, budgetBefore: c.toBefore, native: second.revertPayload },
        { adSetMetaId: c.fromId, budgetBefore: c.fromBefore, native: first.revertPayload },
      ],
    },
  };
}

/** A raise of one ad set's budget (a raising kind: it goes through reserveAds and can be refused). */
async function applyRaise(row: Row, by: SpendActor): Promise<Applied> {
  const p = rec(row.payload);
  const id = String(p.adSetMetaId ?? row.targetMetaId);
  const before = num(p.budgetBefore);
  const after = num(p.budgetAfter);
  if (!id || Number.isNaN(before) || Number.isNaN(after) || after <= before || !Number.isInteger(after)) throw new HttpError(409, "The proposal data is not valid.");
  const set = await prisma.adSet.findFirst({ where: { tenantId: row.tenantId, metaAdSetId: id }, select: { dailyBudgetMinor: true } });
  if (set?.dailyBudgetMinor !== before) throw new HttpError(409, "The budget changed since this was proposed. Wait for the next run.");
  await setAdSetBudget(row.tenantId, id, after, by, { reason: "Applied an approved suggestion: raise a budget that gets leads cheaply." });
  return { revertPayload: { kind: "raise_budget", adSetMetaId: id, budgetBefore: before } };
}

async function applyKind(row: Row, by: SpendActor): Promise<Applied> {
  if (row.kind === "pause_ad") return applyPause(row, by);
  if (row.kind === "shift_budget") return applyShift(row, by);
  if (row.kind === "raise_budget") return applyRaise(row, by);
  return { revertPayload: null };
}

/** How long an "approved" row counts as being applied by a request that is still running. appliedAt doubles as this claim stamp until the row is applied. */
export const APPLY_CLAIM_MS = 5 * 60_000;

/** Takes the right to apply an already approved row. Exactly one concurrent confirm wins; a claim that is older than APPLY_CLAIM_MS is treated as a crashed attempt and can be taken over. */
async function claimApply(tenantId: string, id: string): Promise<boolean> {
  const now = Date.now();
  const res = await prisma.optimizerProposal.updateMany({
    where: { id, tenantId, status: "approved", OR: [{ appliedAt: null }, { appliedAt: { lt: new Date(now - APPLY_CLAIM_MS) } }] },
    data: { appliedAt: new Date(now) },
  });
  return res.count === 1;
}

async function assertNotExpired(tenantId: string, row: Row): Promise<void> {
  const cfg = await getOptimizerConfig(tenantId);
  if (Date.now() - row.createdAt.getTime() > cfg.expireHours * HOUR_MS) {
    if (row.status === "proposed") await transition(tenantId, row.id, "proposed", "expired");
    throw new HttpError(409, "This proposal has expired.");
  }
}

/**
 * Claims the proposal (proposed -> approved, or a repeat confirm of an approved one) and applies it as `by`. Marks it applied
 * or failed. Throws an HttpError with the reason when it could not be applied.
 */
async function applyCore(tenantId: string, row: Row, who: Person | null, by: SpendActor): Promise<void> {
  const id = row.id;
  const userId = who?.userId ?? null;
  // "approved" without an applied change is a decision that was recorded but never carried out (a crash between the two steps): confirming again finishes it.
  // The approving request holds the apply claim from the start (appliedAt is stamped with the approval); a repeat confirm has to win claimApply first, so two confirms never both apply the change.
  if (row.status === "proposed") {
    if (!(await transition(tenantId, id, "proposed", "approved", { decidedByUserId: userId, appliedAt: new Date() }))) throw new HttpError(409, "This proposal was already decided.");
  } else if (!(await claimApply(tenantId, id))) {
    throw new HttpError(409, "This change is already being applied.");
  }
  await audit({ tenantId, userId, action: who ? "optimizer.proposal_approved" : "optimizer.proposal_auto_approved", target: id, meta: { kind: row.kind } });
  try {
    const applied = await applyKind(row, by);
    const done = { appliedAt: new Date(), revertPayload: (applied.revertPayload ?? undefined) as object | undefined };
    if (!(await transition(tenantId, id, "approved", "applied", done))) {
      // The row left "approved" while the change was being applied (a reject got in). The change is live on Meta, so the record must say so: it is never left as "rejected".
      const late = await prisma.optimizerProposal.updateMany({ where: { id, tenantId, status: "rejected" }, data: { status: "applied", ...done } });
      if (late.count !== 1) console.error("[optimizer] the applied change could not be recorded for proposal", id);
    }
    await audit({ tenantId, userId, action: "optimizer.proposal_applied", target: id, meta: { kind: row.kind } });
  } catch (e) {
    const message = e instanceof HttpError ? e.message : describeError(e).slice(0, 200);
    await transition(tenantId, id, "approved", "failed", { payload: { ...rec(row.payload), error: message } as object });
    await audit({ tenantId, userId, action: "optimizer.proposal_failed", target: id, meta: { kind: row.kind } });
    throw e instanceof HttpError ? e : new HttpError(502, "The change could not be applied. Nothing was changed.");
  }
}

export async function approveProposal(actor: Actor, id: string, confirm: unknown): Promise<Row> {
  if (confirm !== true) throw new HttpError(400, "Confirmation is required to approve a change.");
  const row = await getProposal(actor, id);
  if (row.status !== "proposed" && row.status !== "approved") throw new HttpError(409, `This proposal is ${row.status}.`);
  const who: Person = { userId: actor.userId, role: actor.role };
  if (isRaisingProposal(row.kind, row.payload)) await assertApprover(actor.tenantId, who, APPROVER_ONLY_PROPOSAL);
  await assertNotExpired(actor.tenantId, row);
  // A spending request is waiting for this proposal: deciding it applies the proposal once, from any surface (7.3).
  if (row.status === "proposed") {
    const pending = await pendingApprovalForProposal(actor.tenantId, id);
    if (pending) {
      const res = await decideApproval(actor.tenantId, pending.id, "approve", "app", { type: "user", userId: actor.userId, role: actor.role });
      if (res.status !== "applied") throw new HttpError(409, res.text);
      return getProposal(actor, id);
    }
  }
  await applyCore(actor.tenantId, row, who, decider(who));
  await noteHumanDecision(actor.tenantId, { proposalId: id }, "approved", actor.userId);
  return getProposal(actor, id);
}

/**
 * Applies the proposal of an approved spending request (called by spend/approvals.ts once the request's conditional update
 * succeeded). Runs as the approver, with the request's id on the ledger. Throws with the reason when it cannot be applied.
 */
export async function applyProposalForApproval(tenantId: string, proposalId: string, approver: Person, approvalId: string): Promise<void> {
  const row = await loadProposal(tenantId, proposalId);
  if (row.status !== "proposed" && row.status !== "approved") throw new HttpError(409, `This suggestion is ${row.status}.`);
  if (isRaisingProposal(row.kind, row.payload)) await assertApprover(tenantId, approver, APPROVER_ONLY_PROPOSAL);
  await assertNotExpired(tenantId, row);
  await applyCore(tenantId, row, approver, decider(approver, approvalId));
}

/**
 * The ad assistant applies its own proposal (the policy said `auto`: Level 1 or 2, not learning, ASSISTANT_SPEND_ENABLED).
 * The book checks every raise again. Returns whether it was applied.
 */
export async function applyProposalAsAssistant(tenantId: string, proposalId: string): Promise<boolean> {
  const row = await loadProposal(tenantId, proposalId);
  if (row.status !== "proposed") return false;
  try {
    await applyCore(tenantId, row, null, assistantActor);
    return true;
  } catch (e) {
    console.error(`[optimizer] the ad assistant could not apply its proposal: ${e instanceof HttpError ? e.message : describeError(e)}`);
    return false;
  }
}

/** The spending request of a proposal was declined or expired (spend/approvals.ts): the proposal follows. */
export async function proposalRequestClosed(tenantId: string, proposalId: string, how: "declined" | "expired", userId: string | null): Promise<void> {
  if (how === "declined") {
    const res = await prisma.optimizerProposal.updateMany({ where: { id: proposalId, tenantId, status: "proposed" }, data: { status: "rejected", decidedByUserId: userId } });
    if (res.count === 1) await audit({ tenantId, userId, action: "optimizer.proposal_rejected", target: proposalId, meta: { via: "spending_request" } });
    return;
  }
  await prisma.optimizerProposal.updateMany({ where: { id: proposalId, tenantId, status: "proposed" }, data: { status: "expired" } });
}

export async function rejectProposal(actor: Actor, id: string): Promise<Row> {
  const row = await getProposal(actor, id);
  if (row.status === "proposed") {
    const pending = await pendingApprovalForProposal(actor.tenantId, id);
    if (pending) {
      await decideApproval(actor.tenantId, pending.id, "decline", "app", { type: "user", userId: actor.userId, role: actor.role });
      return getProposal(actor, id);
    }
  }
  if (row.status === "approved") {
    // An approved row whose apply step is still running (fresh claim) cannot be rejected: the change may already be live.
    const res = await prisma.optimizerProposal.updateMany({
      where: { id, tenantId: actor.tenantId, status: "approved", OR: [{ appliedAt: null }, { appliedAt: { lt: new Date(Date.now() - APPLY_CLAIM_MS) } }] },
      data: { status: "rejected", decidedByUserId: actor.userId },
    });
    if (res.count !== 1) throw new HttpError(409, "This change is being applied right now. Wait a moment and check its result.");
  } else if (!(await transition(actor.tenantId, id, "proposed", "rejected", { decidedByUserId: actor.userId }))) {
    throw new HttpError(409, `This proposal is ${row.status}.`);
  }
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "optimizer.proposal_rejected", target: id, meta: { kind: row.kind } });
  await noteHumanDecision(actor.tenantId, { proposalId: id }, "declined", actor.userId);
  return getProposal(actor, id);
}

type Resume = (tenantId: string, metaAdId: string, revertPayload: Record<string, unknown>, actor: SpendActor) => Promise<unknown>;
function resumeAdFn(): Resume | null {
  try {
    const fn = (adsActions as Record<string, unknown>).resumeAd;
    return typeof fn === "function" ? (fn as Resume) : null;
  } catch {
    return null;
  }
}

/**
 * Replays the saved undo as the person reverting. Turning an ad back on, or restoring a budget that was cut, is a raise: it goes
 * through the Spend Book and can be refused. A restoring raise names the cut made just before it (shiftFromAdSetId), so a
 * zero-sum undo counts the budget it freed. Undoing a raise is a cut: it pauses instead once the ad set used up Meta's budget
 * changes for the hour.
 */
async function undo(row: Row, revert: Record<string, unknown>, by: SpendActor): Promise<void> {
  if (revert.kind === "pause_ad") {
    const resume = resumeAdFn();
    if (!resume) throw new HttpError(501, "Reverting a paused ad is not available yet. Turn the ad back on in Meta Ads Manager.");
    await resume(row.tenantId, String(revert.adMetaId), rec(revert.native), by);
    return;
  }
  if (revert.kind === "raise_budget") {
    const before = num(revert.budgetBefore);
    if (Number.isNaN(before) || before <= 0) throw new HttpError(409, "The saved undo data is not valid.");
    const { lowerAdSetSpend } = await import("@/lib/spend/breakers/limits");
    await lowerAdSetSpend({ db: prisma, tenantId: row.tenantId, now: new Date() }, String(revert.adSetMetaId), before, by, "Undid an applied suggestion.");
    return;
  }
  if (revert.kind === "shift_budget" && Array.isArray(revert.steps)) {
    const steps = revert.steps.map(rec);
    if (steps.some((s) => Number.isNaN(num(s.budgetBefore)) || num(s.budgetBefore) <= 0)) throw new HttpError(409, "The saved undo data is not valid.");
    let cutBefore: string | undefined;
    for (const step of steps) {
      const before = num(step.budgetBefore);
      const id = String(step.adSetMetaId);
      const res = await setAdSetBudget(row.tenantId, id, before, by, { reason: "Undid an applied suggestion.", ...(cutBefore ? { shiftFromAdSetId: cutBefore } : {}) });
      if (res.clamped === true) {
        throw new HttpError(409, "The workspace daily budget cap left no room to restore every budget. Part of the change may already be undone; check the ad sets, then try again.");
      }
      const previous = num(rec(res.revertPayload).dailyBudgetMinor);
      cutBefore = !Number.isNaN(previous) && previous > before ? id : undefined;
    }
    return;
  }
  throw new HttpError(409, "This change cannot be reverted.");
}

export async function revertProposal(actor: Actor, id: string): Promise<Row> {
  const row = await getProposal(actor, id);
  if (row.status !== "applied") throw new HttpError(409, `This proposal is ${row.status}.`);
  const revert = row.revertPayload ? rec(row.revertPayload) : null;
  if (!revert || !row.appliedAt) throw new HttpError(409, "This change has nothing to revert.");
  const cfg = await getOptimizerConfig(actor.tenantId);
  if (Date.now() - row.appliedAt.getTime() > cfg.revertDays * DAY_MS) throw new HttpError(409, `Changes can only be reverted within ${cfg.revertDays} days.`);
  const who: Person = { userId: actor.userId, role: actor.role };
  // Reverting a pause or a cut is a raise (an approver); reverting a raise is a lowering (any admin).
  if (isRaisingRevert(row.kind, revert)) await assertApprover(actor.tenantId, who, APPROVER_ONLY_REVERT);
  if (!(await transition(actor.tenantId, id, "applied", "reverting"))) throw new HttpError(409, "This change is already being reverted.");
  try {
    await undo(row, revert, decider(who));
  } catch (e) {
    await transition(actor.tenantId, id, "reverting", "applied");
    throw e instanceof HttpError ? e : new HttpError(502, "The change could not be reverted. Nothing was changed.");
  }
  await transition(actor.tenantId, id, "reverting", "reverted");
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "optimizer.proposal_reverted", target: id, meta: { kind: row.kind } });
  return getProposal(actor, id);
}

/** Creates a client approval link for a proposal. The link only records the client's view; applying still needs an owner or admin click. */
export async function requestClientApproval(actor: Actor, id: string): Promise<{ id: string; url: string }> {
  const row = await getProposal(actor, id);
  if (row.status !== "proposed") throw new HttpError(409, `This proposal is ${row.status}.`);
  const link = await createApproval(actor.tenantId, { subjectType: "optimizer_proposal", subjectId: id });
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "optimizer.approval_requested", target: id });
  return link;
}

/** The ad account currency of a proposal's campaign (for money in its summary), INR when unknown. */
async function proposalCurrency(tenantId: string, row: Row): Promise<string> {
  const p = rec(row.payload);
  const metaCampaignId = typeof p.campaignMetaId === "string" ? p.campaignMetaId : null;
  const c = metaCampaignId ? await prisma.adCampaign.findFirst({ where: { tenantId, metaCampaignId }, select: { currency: true } }) : null;
  return c?.currency ?? "INR";
}

/**
 * An admin who may not approve a raising suggestion asks an approver to (POST /api/spend/approvals): a spending request is
 * created for the proposal (or the waiting one is returned) and the approvers are notified.
 */
export async function requestApproverForProposal(actor: Actor, proposalId: string): Promise<{ approvalId: string; expiresAt: Date; created: boolean }> {
  if (actor.role !== "owner" && actor.role !== "admin") throw new HttpError(403, "Only the owner or an admin can ask for approval.");
  const row = await getProposal(actor, proposalId);
  if (row.status !== "proposed") throw new HttpError(409, `This proposal is ${row.status}.`);
  const currency = await proposalCurrency(actor.tenantId, row);
  const plan = proposalPlan(row, currency);
  if (!plan) throw new HttpError(409, "This suggestion doesn't change spending, so it needs no approval.");
  const made = await createProposalApproval({
    tenantId: actor.tenantId,
    assistantKey: OPTIMIZER_ASSISTANT,
    proposalId,
    proposalKind: row.kind,
    direction: plan.direction,
    summary: plan.summary,
    reason: row.rationale,
    subject: plan.subject,
    objectIds: plan.objectIds,
    payload: rec(row.payload),
    forecastTodayMinor: plan.forecastTodayMinor,
    forecastMonthMinor: plan.forecastMonthMinor,
    currency,
    actor: { type: "user", userId: actor.userId, role: actor.role },
    policyReason: "asked_by_admin",
  });
  return { approvalId: made.approvalId, expiresAt: made.expiresAt, created: made.created };
}
