/**
 * Ads breakers that enforce a limit or protect Edwyz's own view of spend (docs/SPEND-CONTROLS-SPEC.md 6.2, 4.6 step 9, 4.16).
 *
 * - daily_limit (workspace): counted spend today has reached the effective daily ads limit. Every platform campaign is paused
 *   for the rest of the account day (stopCommitments, actor breaker). At the next account day each object is turned back on
 *   through activateCampaign, so reserveAds checks it again and only what fits starts. Only objects whose most recent lowering
 *   in the ledger is this breaker's own (its correlationId) are resumed: anything a person or another breaker paused, edited
 *   or archived since stays as it is, and nothing is resumed while spending is stopped.
 * - monthly_limit (workspace): spent this month plus today's worst case reaches the monthly limit, or 95% of it is spent.
 *   Every platform campaign is paused; when a pause failed and Edwyz manages Meta's limit on that account, the emergency
 *   write (spend.metacap.p0) is queued. Clears when the limit is raised or the month rolls over; objects stay paused and the
 *   owner is asked whether to resume.
 * - budget_change_quota (ad set): 3 budget changes requested within 60 minutes (Meta allows 4). Raises are refused, and
 *   cuts and breakers pause instead of editing the budget (lowerAdSetSpend). Clears after 60 minutes.
 * - sync_stale (workspace): no successful fast sync for 45 minutes while campaigns are live. Blocks assistant raises (people
 *   are already counted at the worst case after 60 minutes, 4.6). Clears on the next good sync.
 */
import { describeError } from "@/lib/safe-error";
import { isMetaLimitManaged } from "../commitments";
import { formatMinor } from "../money";
import { dayKey, monthKey } from "../periods";
import { SPEND_QUEUES, type SpendActor } from "../types";
import { budgetQuotaOpen } from "../book";
import { clearBreaker, listBreakers, type BreakerRow } from "./state";
import { adsTimezone, mergeDetails, nextAccountMidnight, tripBreaker, type BreakerContext } from "./ads";
import type { StopResult } from "@/lib/ads/stop";

export const SYNC_STALE_MS = 45 * 60_000;
export const BUDGET_CHANGES_LIMIT = 3;
export const BUDGET_WINDOW_MS = 60 * 60_000;
export const MONTHLY_WARN_PCT = 95n;

/** Ledger actions that lower an ads object (the daily_limit resume rule reads the latest one). */
export const LOWERING_ACTIONS = [
  "ads.campaign.pause",
  "ads.campaign.archive",
  "ads.campaign.budget_cut",
  "ads.campaign.end_earlier",
  "ads.adset.pause",
  "ads.adset.archive",
  "ads.adset.budget_cut",
  "ads.adset.end_earlier",
  "ads.ad.pause",
  "ads.ad.archive",
];

const BUDGET_ACTIONS = ["ads.adset.budget_raise", "ads.adset.budget_cut"];

// =====================================================================================================================
// Pure checks
// =====================================================================================================================

/** daily_limit: counted spend today ≥ the effective daily limit (none set: never). */
export function dailyLimitCheck(spentToday: bigint, dailyLimit: bigint | null): boolean {
  return dailyLimit !== null && dailyLimit > 0n && spentToday >= dailyLimit;
}

/** monthly_limit: spentMonth + Σ dayRisk ≥ the monthly limit, or spentMonth ≥ 95% of it. */
export function monthlyLimitCheck(spentMonth: bigint, dayRiskSum: bigint, monthlyLimit: bigint | null): boolean {
  if (monthlyLimit === null || monthlyLimit <= 0n) return false;
  return spentMonth + dayRiskSum >= monthlyLimit || spentMonth * 100n >= MONTHLY_WARN_PCT * monthlyLimit;
}

/** budget_change_quota: 3 or more budget requests within the last 60 minutes; clears when the oldest of the newest 3 ages out. */
export function budgetQuotaCheck(requestedAt: Date[], now: Date): { trip: boolean; autoClearAt: Date | null; count: number } {
  const recent = requestedAt.filter((d) => now.getTime() - d.getTime() < BUDGET_WINDOW_MS).sort((a, b) => b.getTime() - a.getTime());
  if (recent.length < BUDGET_CHANGES_LIMIT) return { trip: false, autoClearAt: null, count: recent.length };
  return { trip: true, autoClearAt: new Date(recent[BUDGET_CHANGES_LIMIT - 1].getTime() + BUDGET_WINDOW_MS), count: recent.length };
}

/** sync_stale: campaigns are live and the last good fast sync is missing or older than 45 minutes. */
export function syncStaleCheck(lastSyncAt: Date | null, liveObjects: number, now: Date): boolean {
  if (liveObjects <= 0) return false;
  return !lastSyncAt || now.getTime() - lastSyncAt.getTime() > SYNC_STALE_MS;
}

// =====================================================================================================================
// "PAUSED is preferred after 3 budget changes" (4.6 step 9)
// =====================================================================================================================

/** Budget change requests on one ad set in the last 60 minutes (ledger requested rows, every actor). */
export async function recentBudgetChanges(ctx: Pick<BreakerContext, "db" | "tenantId" | "now">, metaAdSetId: string): Promise<Date[]> {
  const rows = ((await ctx.db.spendLedger.findMany({
    where: { tenantId: ctx.tenantId, phase: "requested", metaObjectId: metaAdSetId, action: { in: BUDGET_ACTIONS }, createdAt: { gte: new Date(ctx.now.getTime() - BUDGET_WINDOW_MS) } },
    select: { createdAt: true },
  })) ?? []) as { createdAt: Date }[];
  return rows.map((r) => r.createdAt);
}

/** True when a lowering of this ad set should pause it instead of editing its budget (quota used up, or Meta said 613). */
export async function prefersPause(ctx: Pick<BreakerContext, "db" | "tenantId" | "now">, metaAdSetId: string): Promise<boolean> {
  if ((await recentBudgetChanges(ctx, metaAdSetId)).length >= BUDGET_CHANGES_LIMIT) return true;
  return budgetQuotaOpen(ctx.tenantId, metaAdSetId, { db: ctx.db, now: ctx.now });
}

export type LowerSpendPorts = {
  pauseAdSet(tenantId: string, metaAdSetId: string, actor: SpendActor, reason: string): Promise<unknown>;
  cutBudget(tenantId: string, metaAdSetId: string, toMinor: number, actor: SpendActor, reason: string): Promise<unknown>;
};

const defaultLowerPorts: LowerSpendPorts = {
  async pauseAdSet(tenantId, metaAdSetId, actor, reason) {
    const { pauseAdSet } = await import("@/lib/ads/actions");
    return pauseAdSet(tenantId, metaAdSetId, actor, { reason });
  },
  async cutBudget(tenantId, metaAdSetId, toMinor, actor, reason) {
    const { setAdSetBudget } = await import("@/lib/ads/actions");
    return setAdSetBudget(tenantId, metaAdSetId, toMinor, actor, { reason });
  },
};

/**
 * Lowers an ad set's spend: a budget cut normally, but a pause once the ad set has had 3 budget changes in the last hour or
 * Meta refused one (a pause does not use Meta's budget-change quota). Returns what it did.
 */
export async function lowerAdSetSpend(
  ctx: Pick<BreakerContext, "db" | "tenantId" | "now">,
  metaAdSetId: string,
  toMinor: number,
  actor: SpendActor,
  reason: string,
  ports: LowerSpendPorts = defaultLowerPorts,
): Promise<"paused" | "cut"> {
  if (await prefersPause(ctx, metaAdSetId)) {
    await ports.pauseAdSet(ctx.tenantId, metaAdSetId, actor, `${reason} Paused instead of changing the budget, because Meta allows only 4 budget changes an hour.`);
    return "paused";
  }
  await ports.cutBudget(ctx.tenantId, metaAdSetId, toMinor, actor, reason);
  return "cut";
}

// =====================================================================================================================
// Recording a breaker's own lowerings, and the P0 escalation
// =====================================================================================================================

export type OwnLowering = { metaObjectId: string; correlationId: string; level: string; campaignId: string | null };

/** The lowerings this breaker made since `since` (applied rows, actor breaker of this kind). */
async function ownLoweringsSince(ctx: BreakerContext, kind: string, since: Date): Promise<OwnLowering[]> {
  const rows = ((await ctx.db.spendLedger.findMany({
    where: { tenantId: ctx.tenantId, phase: "applied", actorType: "breaker", actorId: kind, action: { in: LOWERING_ACTIONS }, createdAt: { gte: since } },
    orderBy: { seq: "asc" },
    select: { metaObjectId: true, correlationId: true, targetType: true, targetId: true },
  })) ?? []) as { metaObjectId: string | null; correlationId: string; targetType: string | null; targetId: string | null }[];
  return rows.filter((r) => !!r.metaObjectId).map((r) => ({ metaObjectId: r.metaObjectId!, correlationId: r.correlationId, level: r.targetType ?? "campaign", campaignId: r.targetId }));
}

function storedLowerings(b: BreakerRow): OwnLowering[] {
  const d = b.details && typeof b.details === "object" ? (b.details as { lowerings?: unknown }).lowerings : undefined;
  return Array.isArray(d) ? (d as OwnLowering[]).filter((x) => x && typeof x.metaObjectId === "string" && typeof x.correlationId === "string") : [];
}

/** Pauses every platform campaign for a limit breaker and records the lowerings it made (the resume rule needs them). */
async function stopAllFor(ctx: BreakerContext, breaker: BreakerRow, kind: "daily_limit" | "monthly_limit", reason: string): Promise<StopResult> {
  const since = new Date(ctx.now.getTime() - 1_000);
  const r = await ctx.deps.stopCommitments(ctx.tenantId, { origin: "all" }, { type: "breaker", kind }, reason);
  const made = await ownLoweringsSince(ctx, kind, since);
  const known = storedLowerings(breaker);
  const merged = [...known.filter((k) => !made.some((m) => m.metaObjectId === k.metaObjectId)), ...made];
  await mergeDetails(ctx, breaker.id, { lowerings: merged, paused: (Number((breaker.details as { paused?: unknown } | null)?.paused ?? 0) || 0) + r.done, failed: r.failed + r.unreachable });
  return r;
}

/** Where a pause failed or could not reach Meta and Edwyz manages Meta's limit, the emergency write is queued (5.4 P0). */
async function escalateP0(ctx: BreakerContext, breaker: BreakerRow, r: StopResult): Promise<number> {
  const stuck = r.items.filter((i) => i.result === "failed" || i.result === "unreachable");
  let queued = 0;
  for (const assetId of [...new Set(stuck.map((i) => i.adAccountAssetId))]) {
    const row = ctx.detail.state.metaLimits.find((m) => m.adAccountAssetId === assetId);
    if (!row || !isMetaLimitManaged(row, ctx.env)) continue;
    try {
      await ctx.deps.enqueue(SPEND_QUEUES.metacapP0, {
        tenantId: ctx.tenantId,
        adAccountAssetId: assetId,
        reason: "monthly_limit_pause_failed",
        correlationId: `breaker:${breaker.id}`,
        failedObjectIds: stuck.filter((i) => i.adAccountAssetId === assetId).map((i) => i.metaObjectId),
      });
      queued++;
    } catch (error) {
      console.error(`[spend] Meta's emergency limit was not queued: ${describeError(error)}`);
    }
  }
  return queued;
}

const liveObjects = (ctx: BreakerContext) => [...ctx.detail.state.commitments, ...ctx.detail.state.orphans].filter((c) => c.status !== "stopped").length;

// =====================================================================================================================
// daily_limit
// =====================================================================================================================

export async function runDailyLimit(ctx: BreakerContext): Promise<void> {
  const { figures, limits } = ctx.detail;
  const open = (await listBreakers(ctx.tenantId, { db: ctx.db, now: ctx.now, kinds: ["daily_limit"] }))[0] ?? null;
  if (!dailyLimitCheck(figures.spentToday, limits.daily)) return;
  const tz = adsTimezone(ctx);
  const cur = ctx.currency;
  const reason = "Today's ads limit is used up, so this was paused until tomorrow.";
  if (open) {
    // Still open: anything that started running again (for example in Ads Manager) is paused too.
    if (liveObjects(ctx) > 0) await stopAllFor(ctx, open, "daily_limit", reason);
    ctx.log.push({ kind: "daily_limit", scopeId: ctx.tenantId, action: "repeat" });
    return;
  }
  await tripBreaker(ctx, {
    tenantId: ctx.tenantId,
    kind: "daily_limit",
    scopeType: "workspace",
    scopeId: ctx.tenantId,
    effect: "pause_scope",
    reason: `Ads spent ${formatMinor(figures.spentToday, cur)} today, your daily limit of ${formatMinor(limits.daily!, cur)}.`,
    details: { day: dayKey(ctx.now, tz), dailyLimitMinor: limits.daily, spentTodayMinor: figures.spentToday },
    autoClearAt: nextAccountMidnight(ctx.now, tz),
    notice: {
      title: "Today's ads limit is used up",
      body: `Ads spent ${formatMinor(figures.spentToday, cur)} today, your daily limit. We paused your campaigns until tomorrow; they turn back on by themselves if they fit your limits then.`,
    },
    act: async (b) => {
      await stopAllFor(ctx, b, "daily_limit", reason);
    },
  });
}

/**
 * At the next account day: the daily_limit breaker clears, and each campaign whose latest lowering is still the breaker's own
 * is turned back on through activateCampaign (reserveAds, actor breaker), so only what fits starts. Nothing is resumed while
 * spending is stopped; the owner is told what stayed paused.
 */
export async function resumeAfterDailyLimit(ctx: BreakerContext, breaker: BreakerRow): Promise<{ resumed: string[]; kept: { campaignId: string; why: string }[] }> {
  const resumed: string[] = [];
  const kept: { campaignId: string; why: string }[] = [];
  const freeze = ctx.detail.headroom.freeze;
  const lowerings = storedLowerings(breaker);
  if (freeze.effective === "none") {
    for (const l of lowerings) {
      const campaignId = l.campaignId;
      if (!campaignId) continue;
      if (l.level !== "campaign") {
        kept.push({ campaignId, why: "only part of it was paused" });
        continue;
      }
      const latest = (await ctx.db.spendLedger.findFirst({
        where: { tenantId: ctx.tenantId, phase: "requested", metaObjectId: l.metaObjectId, action: { in: LOWERING_ACTIONS } },
        orderBy: { seq: "desc" },
        select: { correlationId: true },
      })) as { correlationId?: string } | null;
      if (latest?.correlationId !== l.correlationId) {
        kept.push({ campaignId, why: "someone changed it since" });
        ctx.log.push({ kind: "daily_limit", scopeId: l.metaObjectId, action: "skipped", detail: "changed_since" });
        continue;
      }
      const camp = (await ctx.db.adCampaign.findFirst({ where: { id: campaignId, tenantId: ctx.tenantId }, select: { status: true } })) as { status?: string } | null;
      if (camp?.status !== "paused") {
        kept.push({ campaignId, why: "it is no longer paused" });
        continue;
      }
      try {
        await ctx.deps.resumeCampaign(ctx.tenantId, campaignId, { type: "breaker", kind: "daily_limit" }, `breaker:${breaker.id}:resume:${campaignId}`);
        resumed.push(campaignId);
        ctx.log.push({ kind: "daily_limit", scopeId: l.metaObjectId, action: "resumed" });
      } catch (error) {
        kept.push({ campaignId, why: error instanceof Error ? error.message : "it did not fit your limits" });
        ctx.log.push({ kind: "daily_limit", scopeId: l.metaObjectId, action: "skipped", detail: "refused" });
      }
    }
  } else {
    for (const l of lowerings) if (l.campaignId) kept.push({ campaignId: l.campaignId, why: "spending is stopped" });
  }
  await clearBreaker({ id: breaker.id }, { now: ctx.now, reason: "A new account day started." });
  ctx.log.push({ kind: "daily_limit", scopeId: ctx.tenantId, action: "cleared" });
  const names = kept.map((k) => ctx.campaigns.get(k.campaignId)?.name).filter((n): n is string => !!n);
  const body =
    freeze.effective !== "none"
      ? "A new day started, but spending is stopped, so your campaigns stay paused. Resume them in Settings > Spending limits when spending is back on."
      : kept.length === 0
        ? `A new day started, so we turned ${resumed.length === 1 ? "1 campaign" : `${resumed.length} campaigns`} back on.`
        : `A new day started. We turned ${resumed.length === 1 ? "1 campaign" : `${resumed.length} campaigns`} back on; ${names.length ? names.map((n) => `'${n}'`).join(", ") : `${kept.length} more`} stayed paused. Resume ${kept.length === 1 ? "it" : "them"} in Settings > Spending limits if you want.`;
  if (lowerings.length > 0) {
    await ctx.deps.notify({ tenantId: ctx.tenantId, kind: "breaker_cleared", severity: kept.length ? "heads_up" : "fyi", audience: "approvers", dedupeKey: `spend-breaker:${breaker.id}:cleared`, title: "Today's ads limit was reset", body, link: "/app/settings/spending" });
  }
  return { resumed, kept };
}

// =====================================================================================================================
// monthly_limit
// =====================================================================================================================

export async function runMonthlyLimit(ctx: BreakerContext): Promise<void> {
  const { figures, limits } = ctx.detail;
  const tz = adsTimezone(ctx);
  const month = monthKey(ctx.now, tz);
  const open = (await listBreakers(ctx.tenantId, { db: ctx.db, now: ctx.now, kinds: ["monthly_limit"] }))[0] ?? null;
  const over = monthlyLimitCheck(figures.spentMonth, figures.committedToday, limits.monthly);
  const cur = ctx.currency;
  if (open) {
    const d = (open.details ?? {}) as { monthKey?: string; monthlyLimitMinor?: string | null };
    const tripLimit = d.monthlyLimitMinor ? BigInt(d.monthlyLimitMinor) : null;
    const raised = limits.monthly === null || (tripLimit !== null && limits.monthly > tripLimit);
    if (d.monthKey !== month || (raised && !over)) {
      await clearBreaker({ id: open.id }, { now: ctx.now, reason: d.monthKey !== month ? "A new month started." : "The monthly limit was raised." });
      ctx.log.push({ kind: "monthly_limit", scopeId: ctx.tenantId, action: "cleared" });
      await ctx.deps.notify({
        tenantId: ctx.tenantId,
        kind: "breaker_cleared",
        severity: "heads_up",
        audience: "approvers",
        dedupeKey: `spend-breaker:${open.id}:cleared`,
        title: "Your ads can run again",
        body: `${d.monthKey !== month ? "A new month started" : "The monthly ads limit was raised"}. Campaigns we paused stay paused. Resume them in Settings > Spending limits?`,
        link: "/app/settings/spending",
      });
      return;
    }
    if (over && liveObjects(ctx) > 0) {
      const r = await stopAllFor(ctx, open, "monthly_limit", "This month's ads limit is nearly used up, so this was paused.");
      await escalateP0(ctx, open, r);
    }
    ctx.log.push({ kind: "monthly_limit", scopeId: ctx.tenantId, action: "repeat" });
    return;
  }
  if (!over) return;
  await tripBreaker(ctx, {
    tenantId: ctx.tenantId,
    kind: "monthly_limit",
    scopeType: "workspace",
    scopeId: ctx.tenantId,
    effect: "pause_scope",
    reason: `Ads have spent ${formatMinor(figures.spentMonth, cur)} of your ${formatMinor(limits.monthly!, cur)} monthly limit, with up to ${formatMinor(figures.committedToday, cur)} more possible today.`,
    details: { monthKey: month, monthlyLimitMinor: limits.monthly, spentMonthMinor: figures.spentMonth },
    notice: {
      title: "This month's ads limit is nearly used up",
      body: `Ads have spent ${formatMinor(figures.spentMonth, cur)} of your ${formatMinor(limits.monthly!, cur)} monthly limit, so we paused your campaigns. Raise the limit in Settings > Spending limits, or resume them next month.`,
    },
    act: async (b) => {
      const r = await stopAllFor(ctx, b, "monthly_limit", "This month's ads limit is nearly used up, so this was paused.");
      const queued = await escalateP0(ctx, b, r);
      return { p0Queued: queued };
    },
  });
}

// =====================================================================================================================
// budget_change_quota
// =====================================================================================================================

export async function runBudgetQuota(ctx: BreakerContext): Promise<void> {
  const rows = ((await ctx.db.spendLedger.findMany({
    where: { tenantId: ctx.tenantId, phase: "requested", action: { in: BUDGET_ACTIONS }, createdAt: { gte: new Date(ctx.now.getTime() - BUDGET_WINDOW_MS) } },
    select: { metaObjectId: true, createdAt: true },
  })) ?? []) as { metaObjectId: string | null; createdAt: Date }[];
  const byObject = new Map<string, Date[]>();
  for (const r of rows) if (r.metaObjectId) byObject.set(r.metaObjectId, [...(byObject.get(r.metaObjectId) ?? []), r.createdAt]);
  for (const [metaAdSetId, times] of byObject) {
    const check = budgetQuotaCheck(times, ctx.now);
    if (!check.trip) continue;
    const name = ctx.adSetNames.get(metaAdSetId) ?? "An ad set";
    await tripBreaker(ctx, {
      tenantId: ctx.tenantId,
      kind: "budget_change_quota",
      scopeType: "adset",
      scopeId: metaAdSetId,
      effect: "block_raises",
      reason: `'${name}' had ${check.count} budget changes in the last hour. Meta allows 4, so we keep one for safety.`,
      details: { count: check.count },
      autoClearAt: check.autoClearAt,
      notice: { title: `Budget changes for '${name}' are on hold for up to an hour`, body: `Meta allows only 4 budget changes an hour for each ad set, and '${name}' had ${check.count}. Until the hour is up, we'll pause it instead of lowering its budget if needed.`, severity: "fyi", audience: "admins" },
    });
  }
}

// =====================================================================================================================
// sync_stale
// =====================================================================================================================

export async function runSyncStale(ctx: BreakerContext): Promise<void> {
  const state = ctx.detail.state;
  if (!state.spendingAccount || state.spendingAccount.demo) return;
  const live = liveObjects(ctx);
  const stale = syncStaleCheck(state.lastSyncAt, live, ctx.now);
  const open = (await listBreakers(ctx.tenantId, { db: ctx.db, now: ctx.now, kinds: ["sync_stale"] }))[0] ?? null;
  if (!stale) {
    if (open) {
      await clearBreaker({ id: open.id }, { now: ctx.now, reason: "Spend figures from Meta arrived again." });
      ctx.log.push({ kind: "sync_stale", scopeId: ctx.tenantId, action: "cleared" });
    }
    return;
  }
  await tripBreaker(ctx, {
    tenantId: ctx.tenantId,
    kind: "sync_stale",
    scopeType: "workspace",
    scopeId: ctx.tenantId,
    effect: "block_raises",
    reason: "No spend figures from Meta for 45 minutes.",
    details: { lastSyncAt: state.lastSyncAt?.toISOString() ?? null },
    notice: {
      title: "We can't see today's ad spend right now",
      body: "Meta hasn't sent spend figures for 45 minutes. Until they arrive, your ad assistant won't raise budgets, and today's spend is counted at its highest possible amount.",
      severity: "fyi",
      audience: "admins",
    },
  });
}
