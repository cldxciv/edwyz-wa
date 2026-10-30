/**
 * New-workspace limits ("probation" in code only; the UI says "new-workspace limits"), docs/SPEND-CONTROLS-SPEC.md 2.2, 4.4,
 * and 12.1a decision 3 (all three pots are capped through the seeded probation SpendCeiling rows).
 *
 * Computed on read, never stored as a result:
 * - `forced` (platform admin): on.
 * - `lifted` (platform admin's lift_probation): off.
 * - `auto`: off when the workspace is billing-exempt, OR has at least 2 invoices with status `paid`, a `paidAt` and a total
 *   above 0, OR a platform admin set `verifiedAt`. Otherwise on. A void or refunded invoice stops counting on the next read
 *   and a revoked exemption brings it back, so the state is never sticky.
 */
import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/tenancy";
import { applyLedgered, getControl, requirePlatformAdmin, requireReason, type SpendControlState, type SpendDb } from "./control";
import type { ProbationSetting, SpendActor } from "./types";

/** Paid invoices that lift the new-workspace limits (12.1a decision 4). */
export const PAID_INVOICES_TO_LIFT = 2;

export type ProbationReason = "forced" | "lifted" | "billing_exempt" | "paid_invoices" | "verified" | "new_workspace";

export type ProbationState = {
  /** The new-workspace limits apply now. */
  on: boolean;
  setting: ProbationSetting;
  reason: ProbationReason;
  paidInvoices: number;
  verifiedAt: Date | null;
  billingExempt: boolean;
  /** Plain words for the page and the admin panel. Never says "probation". */
  why: string;
};

export type ProbationInput = { setting: ProbationSetting; verifiedAt: Date | null; billingExempt: boolean; paidInvoices: number };

const WHY: Record<ProbationReason, string> = {
  forced: "Edwyz support turned the new-workspace limits on for this workspace.",
  lifted: "Edwyz support lifted the new-workspace limits for this workspace.",
  billing_exempt: "This workspace has complimentary billing, so the new-workspace limits don't apply.",
  paid_invoices: "Your first two payments are done, so the new-workspace limits no longer apply.",
  verified: "Edwyz has verified this workspace, so the new-workspace limits no longer apply.",
  new_workspace: "Your workspace is new, so lower limits apply for now. They go up after your first two payments, or ask support.",
};

/** The pure rule. */
export function computeProbation(input: ProbationInput): ProbationState {
  const base = { setting: input.setting, paidInvoices: input.paidInvoices, verifiedAt: input.verifiedAt, billingExempt: input.billingExempt };
  const make = (on: boolean, reason: ProbationReason): ProbationState => ({ ...base, on, reason, why: WHY[reason] });
  if (input.setting === "forced") return make(true, "forced");
  if (input.setting === "lifted") return make(false, "lifted");
  if (input.billingExempt) return make(false, "billing_exempt");
  if (input.paidInvoices >= PAID_INVOICES_TO_LIFT) return make(false, "paid_invoices");
  if (input.verifiedAt) return make(false, "verified");
  return make(true, "new_workspace");
}

/** Invoices that count: status paid, paidAt set, total above 0. Void and zero invoices never count. */
export async function countPaidInvoices(tenantId: string, db: SpendDb = prisma): Promise<number> {
  return db.invoice.count({ where: { tenantId, status: "paid", paidAt: { not: null }, totalPaise: { gt: 0 } } });
}

export async function probationState(tenantId: string, opts: { db?: SpendDb; control?: SpendControlState } = {}): Promise<ProbationState> {
  const db = opts.db ?? prisma;
  const control = opts.control ?? (await getControl(tenantId, { db, prune: false }));
  // Read only what can lift it; forced and lifted need nothing else.
  if (control.probation !== "auto") {
    return computeProbation({ setting: control.probation, verifiedAt: control.verifiedAt, billingExempt: false, paidInvoices: 0 });
  }
  const tenant = (await db.tenant.findUnique({ where: { id: tenantId }, select: { billingExempt: true } })) as { billingExempt?: boolean } | null;
  const billingExempt = tenant?.billingExempt === true;
  const paidInvoices = billingExempt || control.verifiedAt ? 0 : await countPaidInvoices(tenantId, db);
  return computeProbation({ setting: "auto", verifiedAt: control.verifiedAt, billingExempt, paidInvoices });
}

const SETTINGS: readonly ProbationSetting[] = ["auto", "lifted", "forced"];

/**
 * Platform admin: lift_probation (`lifted`), set_probation (`forced`) or back to automatic (`auto`). Ledgered as
 * `probation.change` on the workspace's ledger with the previous setting as the undo recipe.
 */
export async function setProbation(tenantId: string, setting: ProbationSetting, actor: SpendActor, reason: string, opts: { db?: SpendDb } = {}): Promise<SpendControlState> {
  requirePlatformAdmin(actor);
  if (!SETTINGS.includes(setting)) throw new HttpError(400, "Choose automatic, lifted or forced.");
  const why = requireReason(reason);
  const { result } = await applyLedgered(opts.db, async (tx) => {
    const before = await getControl(tenantId, { db: tx, prune: false });
    if (before.probation === setting) return { result: before, row: null };
    await tx.spendControl.update({
      where: { tenantId },
      data: { probation: setting, probationReason: why, probationChangedByUserId: actor.userId, version: { increment: 1 } },
    });
    const after = await getControl(tenantId, { db: tx, prune: false });
    return {
      result: after,
      row: {
        tenantId,
        pot: "none",
        action: "probation.change",
        actor,
        reason: why,
        reasonCodes: [`probation_${setting}`],
        before: { probation: before.probation },
        after: { probation: setting },
        undo: { action: "set_probation", setting: before.probation },
      },
    };
  });
  return result;
}

/** Platform admin: verify_workspace sets verifiedAt (which lifts automatic new-workspace limits); `false` clears it. */
export async function setWorkspaceVerified(tenantId: string, verified: boolean, actor: SpendActor, reason: string, opts: { db?: SpendDb; now?: Date } = {}): Promise<SpendControlState> {
  requirePlatformAdmin(actor);
  const why = requireReason(reason);
  const now = opts.now ?? new Date();
  const { result } = await applyLedgered(opts.db, async (tx) => {
    const before = await getControl(tenantId, { db: tx, prune: false });
    if (Boolean(before.verifiedAt) === verified) return { result: before, row: null };
    await tx.spendControl.update({ where: { tenantId }, data: { verifiedAt: verified ? now : null, probationChangedByUserId: actor.userId, version: { increment: 1 } } });
    const after = await getControl(tenantId, { db: tx, prune: false });
    return {
      result: after,
      row: {
        tenantId,
        pot: "none",
        action: "probation.change",
        actor,
        reason: why,
        reasonCodes: [verified ? "verified" : "unverified"],
        before: { verifiedAt: before.verifiedAt },
        after: { verifiedAt: after.verifiedAt },
        undo: { action: "set_verified", verified: !verified },
      },
    };
  });
  return result;
}
