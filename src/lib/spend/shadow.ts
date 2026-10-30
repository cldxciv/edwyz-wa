/**
 * Shadow mode, the assistants' learning period (R6; docs/SPEND-CONTROLS-SPEC.md 2.3.10, 7.5, 10.5).
 *
 * - While a mandate's shadowUntil is in the future, an assistant executes nothing on its own authority: the book answers
 *   `shadow` (and mints no permit), and the optimizer's daily run records its proposals here instead of applying them. Each
 *   AssistantShadowRecord keeps the intent, what the configured level would have done, the worst-case forecast, the reason and
 *   a baseline.
 * - The suggestion still reaches people. When an approver accepts it, it runs as that person's action (actor user, with the
 *   assistantKey and approvalId on the ledger), and noteHumanDecision() stores the person's decision next to the assistant's
 *   would-have verdict: the "what it would have done against what happened" comparison R6 asks for.
 * - spend.shadow.evaluate (hourly, tasks/approvals.ts) fills the 24 h and 72 h outcomes: for a pause or cut, whether the
 *   target's cost per lead stayed above target (the pause would have helped) or not (it would have hurt); for a raise, the
 *   target's results against the workspace average; otherwise unknown.
 * - shadowSummary() is the Spending page's line: "Learning: suggests only until 11 Nov. So far it would have made 12 changes
 *   (9 cuts, 3 raises worth up to ₹4,200)."
 * - endShadowEarly(): only a platform admin, only for a sandbox ad account or a verified workspace, never while
 *   ASSISTANT_SPEND_ENABLED is off (4.14), and ledgered.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/tenancy";
import { applyLedgered, getControl, requireReason, type SpendDb } from "./control";
import { formatCopyDate } from "./copy";
import { assistantSpendEnabled } from "./flags";
import { jsonSafe } from "./http";
import { appendStandalone, type LedgerDb } from "./ledger";
import type { MandateState } from "./mandates";
import { formatMinor, toMoneyDTOOrNull } from "./money";
import { dayKey, dayKeyToDate } from "./periods";
import { isLoweringOp } from "./registry";
import type { ShadowDecision, ShadowSummaryDTO, SpendActor } from "./types";

type Env = Record<string, string | undefined>;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Reasons a would-have verdict counts as "would have gone over your limits" (the 10.5 gate counts these). */
const OVER_LIMIT_REASONS = new Set(["over_daily_limit", "over_monthly_limit", "mandate_daily", "mandate_monthly", "no_monthly_limit"]);
const LOWERING_KINDS = new Set(["pause_ad", "pause", "archive", "cut_budget", "end_earlier", "pause_broadcast", "cancel_broadcast", "release_hold"]);

/** True for a shadow record about lowering spend ("cuts" on the Spending page). */
export function isLoweringKind(kind: string): boolean {
  return LOWERING_KINDS.has(kind) || isLoweringOp(kind);
}

const json = (v: unknown): Prisma.InputJsonValue => jsonSafe(v ?? null) as Prisma.InputJsonValue;
const big = (v: unknown): bigint | null => (v === null || v === undefined ? null : typeof v === "bigint" ? v : BigInt(v as number | string));
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The ledger action a shadow row is filed under. */
function shadowAction(kind: string): string {
  switch (kind) {
    case "pause_ad":
      return "ads.ad.pause";
    case "shift_budget":
    case "raise_budget":
      return "ads.adset.budget_raise";
    case "cut_budget":
      return "ads.adset.budget_cut";
    case "resume_ad":
      return "ads.ad.resume";
    default:
      return `assistant.${kind}`;
  }
}

export type ShadowRecordInput = {
  tenantId: string;
  assistantKey: string;
  /** The proposal kind or the intent's op. */
  actionKind: string;
  /** Stored as given (ids and amounts only). */
  intent: Record<string, unknown>;
  would: ShadowDecision;
  wouldReason?: string | null;
  forecastMonthMinor?: bigint | null;
  currency?: string | null;
  /** The assistant's plain-language why. */
  reason: string;
  /** The objects the action is about (Meta ids), for the 24 h and 72 h evaluation. */
  metaObjectIds?: string[];
  /** What the target looked like before (cost per lead, spend), for the evaluation. */
  baseline?: Record<string, unknown>;
  proposalId?: string | null;
  sandbox?: boolean;
};

async function findByProposal(db: SpendDb, tenantId: string, proposalId: string): Promise<Record<string, unknown>[]> {
  const rows = ((await db.assistantShadowRecord.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 500 })) ?? []) as Record<string, unknown>[];
  return rows.filter((r) => rec(r.intent).proposalId === proposalId);
}

/**
 * Records what an assistant would have done during its learning period (the optimizer's proposals; reserveAds writes its own
 * records for assistant intents). One record per proposal: a retried run returns the first one. Writes a standalone `shadow`
 * ledger row. Never applies anything.
 */
export async function recordShadow(input: ShadowRecordInput, opts: { db?: SpendDb } = {}): Promise<{ id: string; created: boolean }> {
  const db = opts.db ?? prisma;
  if (input.proposalId) {
    const existing = await findByProposal(db, input.tenantId, input.proposalId);
    if (existing.length > 0) return { id: String(existing[0].id), created: false };
  }
  const intent = { ...input.intent, ...(input.proposalId ? { proposalId: input.proposalId } : {}), metaObjectIds: input.metaObjectIds ?? [] };
  const row = (await db.assistantShadowRecord.create({
    data: {
      tenantId: input.tenantId,
      assistantKey: input.assistantKey,
      actionKind: input.actionKind,
      intent: json(intent),
      wouldDecision: input.would,
      forecastMonthMinor: input.forecastMonthMinor ?? null,
      currency: input.currency ?? null,
      reason: input.reason,
      baseline: json({ ...(input.baseline ?? {}), wouldReason: input.wouldReason ?? null }),
    },
    select: { id: true },
  })) as { id: string };
  await appendStandalone(
    {
      tenantId: input.tenantId,
      pot: "ads",
      action: shadowAction(input.actionKind),
      phase: "shadow",
      actor: { type: "assistant", assistantKey: input.assistantKey },
      reason: input.reason,
      reasonCodes: ["learning", `would_${input.would}`, ...(input.wouldReason ? [input.wouldReason] : [])],
      targetType: input.proposalId ? "optimizer_proposal" : null,
      targetId: input.proposalId ?? null,
      metaObjectId: input.metaObjectIds?.[0] ?? null,
      currency: input.currency ?? null,
      forecastMonthMinor: input.forecastMonthMinor ?? null,
      snapshot: { shadowRecordId: row.id },
      sandbox: input.sandbox === true,
      idempotencyKey: input.proposalId ? `shadow:${input.proposalId}` : null,
    },
    { db: db as unknown as LedgerDb },
  );
  return { id: String(row.id), created: true };
}

export type HumanDecision = "approved" | "declined" | "expired";

/**
 * Stores a person's decision on a suggestion next to the assistant's would-have verdict (7.5). Matches the records of the
 * proposal (or approval) given. Never throws: the comparison is a report, the decision itself stands.
 */
export async function noteHumanDecision(tenantId: string, ref: { proposalId?: string | null; approvalId?: string | null }, decision: HumanDecision, byUserId: string | null, opts: { db?: SpendDb; now?: Date } = {}): Promise<number> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  try {
    const rows = ((await db.assistantShadowRecord.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 500 })) ?? []) as Record<string, unknown>[];
    const hit = rows.filter((r) => {
      const i = rec(r.intent);
      return (!!ref.proposalId && i.proposalId === ref.proposalId) || (!!ref.approvalId && i.approvalId === ref.approvalId);
    });
    let n = 0;
    for (const r of hit) {
      const outcome = { ...rec(r.outcome), human: { decision, byUserId, at: now.toISOString() } };
      n += (await db.assistantShadowRecord.updateMany({ where: { id: String(r.id) }, data: { outcome: json(outcome) } })).count;
    }
    return n;
  } catch (error) {
    console.error("[spend] the person's decision was not stored next to the learning record:", error instanceof Error ? error.message : "unknown");
    return 0;
  }
}

// =====================================================================================================================
// The Spending page's learning line (ShadowSummaryDTO)
// =====================================================================================================================

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The learning summary of one assistant for the Spending page. */
export async function shadowSummary(tenantId: string, mandate: Pick<MandateState, "assistantKey" | "shadowUntil" | "shadowStartedAt" | "currency">, opts: { db?: SpendDb; now?: Date; timezone?: string } = {}): Promise<ShadowSummaryDTO> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const learning = !!mandate.shadowUntil && mandate.shadowUntil.getTime() > now.getTime();
  const where: Record<string, unknown> = { tenantId, assistantKey: mandate.assistantKey };
  if (mandate.shadowStartedAt) where.createdAt = { gte: mandate.shadowStartedAt };
  const rows = ((await db.assistantShadowRecord.findMany({ where, orderBy: { createdAt: "desc" }, take: 2_000 })) ?? []) as Record<string, unknown>[];
  let cuts = 0;
  let raises = 0;
  let raisesWorth = 0n;
  let over = 0;
  let agreed = 0;
  let decided = 0;
  let currency: string | null = mandate.currency;
  for (const r of rows) {
    const would = String(r.wouldDecision);
    const wouldReason = String(rec(r.baseline).wouldReason ?? "");
    if (would === "refuse") {
      if (OVER_LIMIT_REASONS.has(wouldReason)) over++;
    } else if (isLoweringKind(String(r.actionKind))) {
      cuts++;
    } else {
      raises++;
      raisesWorth += big(r.forecastMonthMinor) ?? 0n;
      if (!currency && typeof r.currency === "string") currency = r.currency;
    }
    const human = rec(rec(r.outcome).human);
    if (human.decision === "approved" || human.decision === "declined") {
      decided++;
      if (human.decision === "approved") agreed++;
    }
  }
  const made = cuts + raises;
  const cur = currency ?? "INR";
  let text: string | null = null;
  if (learning && mandate.shadowUntil) {
    let tz = opts.timezone;
    if (!tz) {
      try {
        tz = (await getControl(tenantId, { db, prune: false })).timezone;
      } catch {
        tz = undefined;
      }
    }
    const until = formatCopyDate(mandate.shadowUntil, tz);
    const head = `Learning: suggests only until ${until}.`;
    if (made === 0) text = `${head} It hasn't suggested any changes yet.`;
    else {
      const parts = [cuts > 0 ? plural(cuts, "cut", "cuts") : null, raises > 0 ? `${plural(raises, "raise", "raises")}${raisesWorth > 0n ? ` worth up to ${formatMinor(raisesWorth, cur)}` : ""}` : null].filter(Boolean);
      text = `${head} So far it would have made ${plural(made, "change", "changes")} (${parts.join(", ")}).`;
    }
  }
  return {
    learning,
    until: mandate.shadowUntil ? mandate.shadowUntil.toISOString() : null,
    text,
    wouldHaveMade: made,
    cuts,
    raises,
    raisesWorthUpTo: raises > 0 ? toMoneyDTOOrNull(raisesWorth, cur) : null,
    wouldExceedAllowance: over,
    agreedPct: decided > 0 ? Math.floor((agreed * 100) / decided) : null,
  };
}

// =====================================================================================================================
// Evaluation (spend.shadow.evaluate, hourly)
// =====================================================================================================================

export type ShadowVerdict = "would_have_helped" | "would_have_hurt" | "neutral" | "unknown";
export type ShadowWindow = { spendMinor: string; results: number; cplMinor: string | null; compareMinor: string | null; verdict: ShadowVerdict };

type Series = { spend: bigint; results: number };

/** Cost per lead in minor units, rounded down; null with no spend; Infinity-like (null with spend) is handled by the caller. */
function cpl(s: Series): bigint | null {
  if (s.results <= 0) return null;
  return s.spend / BigInt(s.results);
}

/**
 * The verdict of one window (pure).
 * - Lowering (pause, cut): the target kept running in the learning period, so if its cost per lead stayed above the target
 *   (or it spent with no leads) the pause would have helped; at or below the target it would have hurt.
 * - Raise or launch: the target's cost per lead against the workspace average in the same window.
 * - Not enough data: unknown.
 */
export function shadowVerdict(kind: string, target: Series, compare: { targetCplMinor: bigint | null; workspace: Series }): { verdict: ShadowVerdict; compareMinor: bigint | null } {
  if (target.spend <= 0n) return { verdict: "unknown", compareMinor: null };
  const own = cpl(target);
  if (isLoweringKind(kind)) {
    const goal = compare.targetCplMinor;
    if (goal === null || goal <= 0n) return { verdict: "unknown", compareMinor: null };
    if (own === null) return { verdict: "would_have_helped", compareMinor: goal };
    return { verdict: own > goal ? "would_have_helped" : "would_have_hurt", compareMinor: goal };
  }
  const avg = cpl(compare.workspace);
  if (avg === null) return { verdict: "unknown", compareMinor: null };
  if (own === null) return { verdict: "would_have_hurt", compareMinor: avg };
  if (own === avg) return { verdict: "neutral", compareMinor: avg };
  return { verdict: own < avg ? "would_have_helped" : "would_have_hurt", compareMinor: avg };
}

async function windowSeries(db: SpendDb, tenantId: string, ids: string[], from: string, to: string): Promise<{ target: Series; workspace: Series }> {
  const daily = ((await db.spendDaily.findMany({ where: { tenantId, pot: "ads", origin: "platform", day: { gte: dayKeyToDate(from), lte: dayKeyToDate(to) } } })) ?? []) as Record<string, unknown>[];
  const target: Series = { spend: 0n, results: 0 };
  const workspace: Series = { spend: 0n, results: 0 };
  for (const r of daily) {
    if (r.scopeType !== "adset") continue;
    const s = big(r.amountMinor) ?? 0n;
    const n = Number(r.results ?? 0) || 0;
    workspace.spend += s;
    workspace.results += n;
    if (ids.includes(String(r.scopeId))) {
      target.spend += s;
      target.results += n;
    }
  }
  if (target.spend === 0n && ids.length > 0) {
    // Ads have no SpendDaily rows of their own: their daily insights snapshots stand in.
    const snaps = ((await db.insightSnapshot.findMany({ where: { tenantId, entityType: "ad", entityMetaId: { in: ids }, date: { gte: dayKeyToDate(from), lte: dayKeyToDate(to) } } })) ?? []) as Record<string, unknown>[];
    for (const s of snaps) {
      target.spend += BigInt(Math.max(0, Math.round(Number(s.spendMinor ?? 0))));
      target.results += Number(s.results ?? 0) || 0;
    }
  }
  return { target, workspace };
}

export type EvaluateShadowOptions = { db?: SpendDb; now?: Date; limit?: number };

/** Fills the 24 h and 72 h outcomes of learning records whose windows have passed. Idempotent; returns how many it updated. */
export async function evaluateShadow(opts: EvaluateShadowOptions = {}): Promise<{ evaluated: number }> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const rows = ((await db.assistantShadowRecord.findMany({
    where: { createdAt: { lte: new Date(now.getTime() - DAY_MS), gte: new Date(now.getTime() - 30 * DAY_MS) } },
    orderBy: { createdAt: "asc" },
    take: Math.min(opts.limit ?? 500, 2_000),
  })) ?? []) as Record<string, unknown>[];
  const controls = new Map<string, { timezone: string; target: bigint | null }>();
  let evaluated = 0;
  for (const r of rows) {
    const outcome = rec(r.outcome);
    const created = r.createdAt instanceof Date ? r.createdAt : new Date(String(r.createdAt));
    const need24 = !outcome.h24;
    const need72 = !outcome.h72 && created.getTime() <= now.getTime() - 3 * DAY_MS;
    if (!need24 && !need72) continue;
    const tenantId = String(r.tenantId);
    try {
      let control = controls.get(tenantId);
      if (!control) {
        const c = await getControl(tenantId, { db, prune: false });
        control = { timezone: c.timezone, target: c.targetCostPerLeadMinor };
        controls.set(tenantId, control);
      }
      const mandateRow = (await db.assistantMandate.findFirst({ where: { tenantId, assistantKey: String(r.assistantKey) }, select: { targetCostPerLeadMinor: true } })) as { targetCostPerLeadMinor?: bigint | null } | null;
      const baselineCpl = big(rec(r.baseline).cplMinor);
      const targetCpl = big(mandateRow?.targetCostPerLeadMinor) ?? control.target ?? baselineCpl;
      const ids = (Array.isArray(rec(r.intent).metaObjectIds) ? (rec(r.intent).metaObjectIds as unknown[]) : []).filter((x): x is string => typeof x === "string");
      const from = dayKey(created, control.timezone);
      const next = { ...outcome };
      for (const [key, hours, needed] of [["h24", 24, need24], ["h72", 72, need72]] as const) {
        if (!needed) continue;
        const to = dayKey(new Date(created.getTime() + hours * HOUR_MS), control.timezone);
        const s = await windowSeries(db, tenantId, ids, from, to < from ? from : to);
        const v = shadowVerdict(String(r.actionKind), s.target, { targetCplMinor: targetCpl, workspace: s.workspace });
        const own = cpl(s.target);
        const w: ShadowWindow = { spendMinor: s.target.spend.toString(), results: s.target.results, cplMinor: own === null ? null : own.toString(), compareMinor: v.compareMinor === null ? null : v.compareMinor.toString(), verdict: v.verdict };
        next[key] = w;
      }
      next.verdict = (rec(next.h72).verdict as ShadowVerdict | undefined) ?? (rec(next.h24).verdict as ShadowVerdict | undefined) ?? "unknown";
      evaluated += (await db.assistantShadowRecord.updateMany({ where: { id: String(r.id) }, data: { outcome: json(next), evaluatedAt: now } })).count;
    } catch (error) {
      console.error("[spend] a learning record could not be evaluated:", error instanceof Error ? error.message : "unknown");
    }
  }
  return { evaluated };
}

// =====================================================================================================================
// Ending the learning period early (platform admin; sandbox or verified workspaces only)
// =====================================================================================================================

export const END_LEARNING_NOT_ELIGIBLE = "Learning can end early only for a test ad account or a verified workspace.";
export const END_LEARNING_ASSISTANTS_OFF = "Assistants only make suggestions for now, so their learning period can't end early.";

/** Ends an assistant's learning period now (8.3 `end_learning`). Ledgered as mandate.change with reason code end_learning. */
export async function endShadowEarly(tenantId: string, assistantKey: string, actor: SpendActor, reason: string, opts: { db?: SpendDb; now?: Date; env?: Env } = {}): Promise<{ shadowUntil: Date }> {
  if (actor.type !== "platform_admin") throw new HttpError(403, "Only Edwyz support can end an assistant's learning period early.");
  const why = requireReason(reason);
  const now = opts.now ?? new Date();
  if (!assistantSpendEnabled(opts.env ?? process.env)) throw new HttpError(409, END_LEARNING_ASSISTANTS_OFF);
  await applyLedgered(opts.db, async (tx) => {
    const control = await getControl(tenantId, { db: tx, prune: false });
    let sandbox = false;
    if (control.spendingAdAccountAssetId) {
      const asset = (await tx.metaAsset.findFirst({ where: { id: control.spendingAdAccountAssetId, tenantId }, select: { sandbox: true } })) as { sandbox?: boolean } | null;
      sandbox = asset?.sandbox === true;
    }
    if (!control.verifiedAt && !sandbox) throw new HttpError(409, END_LEARNING_NOT_ELIGIBLE);
    const row = (await tx.assistantMandate.findFirst({ where: { tenantId, assistantKey } })) as Record<string, unknown> | null;
    const until = row?.shadowUntil instanceof Date ? row.shadowUntil : row?.shadowUntil ? new Date(String(row.shadowUntil)) : null;
    if (!row || !until || until.getTime() <= now.getTime()) throw new HttpError(409, "This assistant isn't in its learning period.");
    const { count } = await tx.assistantMandate.updateMany({ where: { tenantId, assistantKey, version: Number(row.version ?? 1) }, data: { shadowUntil: now, version: { increment: 1 } } });
    if (count !== 1) throw new HttpError(409, "Someone else changed this assistant's settings. Reload to see the latest.");
    return {
      result: null,
      row: {
        tenantId,
        pot: "ads",
        action: "mandate.change",
        actor,
        reason: why,
        reasonCodes: ["end_learning", sandbox ? "sandbox" : "verified"],
        targetType: "assistant",
        targetId: assistantKey,
        before: { shadowUntil: until },
        after: { shadowUntil: now },
        undo: { action: "set_mandate", assistantKey, shadowUntil: until.toISOString() },
        sandbox,
      },
    };
  });
  return { shadowUntil: now };
}
