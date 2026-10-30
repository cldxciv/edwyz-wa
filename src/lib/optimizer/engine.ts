import { prisma } from "@/lib/db";
import { describeError } from "@/lib/safe-error";
import { createProposalApproval } from "@/lib/spend/approvals";
import { assistantContext, type AssistantContext } from "@/lib/spend/mandates";
import { recordShadow } from "@/lib/spend/shadow";
import { tenantMayRunBackground } from "@/lib/tenant-state";
import { getBudgetCap, getOptimizerConfig } from "./config";
import { allProposals, type AdRef, type AdSetRef, type ProposalDraft, type Snap } from "./rules";
import { applyProposalAsAssistant, OPTIMIZER_ASSISTANT, proposalPlan } from "./service";

/*
 * The optimizer's daily run (docs/SPEND-CONTROLS-SPEC.md 7.3). It still creates OptimizerProposal rows from the rules; then each
 * proposal that changes spending goes through the ad assistant's policy (policy.ts decide() with the ads_optimizer mandate):
 * - auto: applied by the assistant through the same service functions (and the Spend Book checks every raise again);
 * - shadow (learning): what it would have done is recorded, and the suggestion still reaches people as a request;
 * - needs_approval: a spending request with the proposal id is created, and approvers are told;
 * - refuse: nothing more (it would not fit the limits; the proposal stays visible).
 * Without a mandate (the default) or while ASSISTANT_SPEND_ENABLED is false, every proposal is a suggestion, as today.
 * Advice (rotate_creative, new_angle) changes no spending and is only listed.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function hookText(creative: unknown): string {
  const c = (creative && typeof creative === "object" ? creative : {}) as { headline?: unknown; message?: unknown };
  return [c.headline, c.message].filter((v): v is string => typeof v === "string").join(". ");
}

const toSnap = (s: { entityMetaId: string; date: Date; spendMinor: number; impressions: number; clicks: number; results: number; frequency: number | null }): Snap => s;

/** Open proposals for the same kind and target block a new one. */
export function dedupe(drafts: ProposalDraft[], open: { kind: string; targetMetaId: string }[]): ProposalDraft[] {
  const seen = new Set(open.map((o) => `${o.kind}:${o.targetMetaId}`));
  return drafts.filter((d) => {
    const key = `${d.kind}:${d.targetMetaId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Suggestions nobody answered expire after `expireHours` (7.3: hours, not days). */
export async function expireOldProposals(tenantId: string, expireHours: number, now: Date): Promise<number> {
  const res = await prisma.optimizerProposal.updateMany({
    where: { tenantId, status: "proposed", createdAt: { lt: new Date(now.getTime() - expireHours * HOUR_MS) } },
    data: { status: "expired" },
  });
  return res.count;
}

export type RoutedProposal = { id: string; verdict: "auto" | "shadow" | "needs_approval" | "refuse" | "advice" | "error"; applied?: boolean };

type CreatedRow = { id: string; kind: string; targetMetaId: string; rationale: string; payload: unknown };

/** One proposal through the policy (7.3). Never throws: a failure leaves the proposal as a plain suggestion. */
export async function routeProposal(tenantId: string, row: CreatedRow, ctx: AssistantContext, currency: string): Promise<RoutedProposal> {
  try {
    const plan = proposalPlan(row, currency, ctx.now);
    if (!plan) return { id: row.id, verdict: "advice" };
    const intent = { ...plan.intent };
    if (plan.raiseTarget && intent.op === "raise_budget") intent.dayStartBudgetMinor = ctx.dayStartBudget(plan.raiseTarget.metaAdSetId) ?? intent.dayStartBudgetMinor ?? null;
    const decision = ctx.decide(intent, plan.delta, plan.scopes);
    const request = {
      tenantId,
      assistantKey: OPTIMIZER_ASSISTANT,
      proposalId: row.id,
      proposalKind: row.kind,
      direction: plan.direction,
      summary: plan.summary,
      reason: row.rationale,
      subject: plan.subject,
      objectIds: plan.objectIds,
      payload: (row.payload && typeof row.payload === "object" ? row.payload : {}) as Record<string, unknown>,
      forecastTodayMinor: plan.forecastTodayMinor,
      forecastMonthMinor: plan.forecastMonthMinor,
      currency,
      policyReason: decision.reason,
      sandbox: ctx.headroom.sandbox === true,
    };
    switch (decision.verdict) {
      case "auto":
        return { id: row.id, verdict: "auto", applied: await applyProposalAsAssistant(tenantId, row.id) };
      case "shadow": {
        const p = request.payload;
        const baselineCpl = typeof p.cprMinor === "number" ? p.cprMinor : typeof p.toCprMinor === "number" ? p.toCprMinor : null;
        await recordShadow({
          tenantId,
          assistantKey: OPTIMIZER_ASSISTANT,
          actionKind: row.kind,
          intent: { kind: "optimizer_proposal", proposalKind: row.kind },
          would: decision.would ?? "needs_approval",
          wouldReason: decision.wouldReason ?? null,
          forecastMonthMinor: plan.forecastMonthMinor,
          currency,
          reason: row.rationale,
          metaObjectIds: plan.objectIds,
          baseline: { cplMinor: baselineCpl === null ? null : String(Math.round(baselineCpl)) },
          proposalId: row.id,
          sandbox: request.sandbox,
        });
        // Learning stops the assistant, never the suggestion: an approver can still accept it as their own action (2.3.10).
        await createProposalApproval(request);
        return { id: row.id, verdict: "shadow" };
      }
      case "needs_approval":
        await createProposalApproval(request);
        return { id: row.id, verdict: "needs_approval" };
      default:
        return { id: row.id, verdict: "refuse" };
    }
  } catch (e) {
    console.error(`[optimizer] a proposal could not go through the assistant's policy: ${describeError(e)}`);
    return { id: row.id, verdict: "error" };
  }
}

/** Creates proposals, then routes each one that changes spending through the ad assistant's policy. */
export async function runForTenant(tenantId: string, now = new Date()): Promise<{ created: number; expired: number; routed?: RoutedProposal[] }> {
  if (!(await tenantMayRunBackground(tenantId))) return { created: 0, expired: 0 };
  const cfg0 = await getOptimizerConfig(tenantId);
  const expired = await expireOldProposals(tenantId, cfg0.expireHours, now);
  if (!cfg0.enabled) return { created: 0, expired };

  const campaigns = await prisma.adCampaign.findMany({
    where: { tenantId, status: "active", metaCampaignId: { not: null } },
    include: {
      adSets: {
        where: { tenantId, status: "active", metaAdSetId: { not: null } },
        include: { ads: { where: { tenantId, status: "active", metaAdId: { not: null } } } },
      },
    },
  });
  const ads: AdRef[] = [];
  const adSets: AdSetRef[] = [];
  for (const c of campaigns) {
    for (const s of c.adSets) {
      adSets.push({ metaId: s.metaAdSetId as string, name: s.name, campaignMetaId: c.metaCampaignId as string, dailyBudgetMinor: s.dailyBudgetMinor });
      for (const a of s.ads) ads.push({ metaId: a.metaAdId as string, name: a.name, adSetMetaId: s.metaAdSetId as string, campaignMetaId: c.metaCampaignId as string, hookText: hookText(a.creative) });
    }
  }
  if (!ads.length && !adSets.length) return { created: 0, expired };
  // Money thresholds and rationale follow the ad account's currency (7.3).
  const currency = (campaigns.find((c) => typeof c.currency === "string" && c.currency)?.currency as string | undefined) ?? "INR";
  const cfg = currency === "INR" ? cfg0 : await getOptimizerConfig(tenantId, { currency, now });

  const since = new Date(now.getTime() - cfg.windowDays * DAY_MS);
  const load = (entityType: "ad" | "adset", ids: string[]) =>
    ids.length
      ? prisma.insightSnapshot.findMany({ where: { tenantId, entityType, entityMetaId: { in: ids }, date: { gte: since } } })
      : Promise.resolve([]);
  const [adRows, adSetRows, cap, open] = await Promise.all([
    load("ad", ads.map((a) => a.metaId)),
    load("adset", adSets.map((a) => a.metaId)),
    getBudgetCap(tenantId),
    prisma.optimizerProposal.findMany({ where: { tenantId, status: "proposed" }, select: { kind: true, targetMetaId: true } }),
  ]);

  const drafts = dedupe(
    allProposals({ ads, adSets, adSnaps: adRows.map(toSnap), adSetSnaps: adSetRows.map(toSnap), cfg, now, limits: { maxDailyBudgetMinor: cap }, currency }),
    open,
  );
  const created: CreatedRow[] = [];
  for (const d of drafts) {
    const row = (await prisma.optimizerProposal.create({
      data: { tenantId, kind: d.kind, targetType: d.targetType, targetMetaId: d.targetMetaId, rationale: d.rationale, payload: d.payload as object },
    })) as Partial<CreatedRow> | null;
    if (row?.id) created.push({ id: row.id, kind: d.kind, targetMetaId: d.targetMetaId, rationale: d.rationale, payload: d.payload });
  }

  // Each proposal that changes spending goes through the ad assistant's policy (one read of the figures for the run).
  const routed: RoutedProposal[] = [];
  const spending = created.filter((r) => proposalPlan(r, currency, now) !== null);
  if (spending.length > 0) {
    let ctx: AssistantContext | null = null;
    try {
      ctx = await assistantContext(tenantId, OPTIMIZER_ASSISTANT, { now });
    } catch (e) {
      console.error(`[optimizer] the ad assistant's policy could not be read; proposals stay as suggestions: ${describeError(e)}`);
    }
    if (ctx) for (const r of spending) routed.push(await routeProposal(tenantId, r, ctx, currency));
  }
  return { created: drafts.length, expired, routed };
}

/** The blocked-workspace sweep lives in tenant-lifecycle (shared with the billing worker); kept here for the optimizer worker. */
export { pauseAdsForBlockedTenants } from "@/lib/tenant-lifecycle";

export async function runAllTenants(now = new Date()): Promise<{ tenants: number; created: number }> {
  const rows = await prisma.adCampaign.findMany({ where: { status: "active" }, distinct: ["tenantId"], select: { tenantId: true } });
  let created = 0;
  for (const { tenantId } of rows) {
    try {
      created += (await runForTenant(tenantId, now)).created;
    } catch {
      console.error("[optimizer] run failed for a tenant");
    }
  }
  return { tenants: rows.length, created };
}
