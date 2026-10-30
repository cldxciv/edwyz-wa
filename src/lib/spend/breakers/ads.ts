/**
 * Ads breakers that react to performance (docs/SPEND-CONTROLS-SPEC.md 6, 6.2; decision 2.3.5), plus what every ads breaker
 * shares: the run context, the trip helper and INR-equivalent floors.
 *
 * - pacing (workspace): today's spend on assistant-launched ad sets above 1.20 x the sum of their highest daily budgets today
 *   pauses every assistant-launched campaign and blocks assistant raises until the next account day (a warning comes first
 *   when spend runs ahead of the day's prorated plan).
 * - efficiency (ad set): over the last 3 account days, spend of at least max(3 x target, INR 500 equivalent) and a cost per
 *   lead above 2 x target (no leads counts as infinite).
 * - spend_jump (ad set): between two consecutive samples, spend grew by more than max(0.25 x D, 4 x D x Δt / 24 h).
 * Performance breakers pause only campaigns an assistant launched (origin `assistant`); a campaign your team made gets a
 * notification instead, unless the owner turned on "Let safety stops pause campaigns my team made". They act only through
 * lowering paths (pauseAdSet, stopCommitments), notify once per trip, and are idempotent: the open-row unique index makes a
 * second trip of the same breaker a no-op.
 */
import { prisma } from "@/lib/db";
import { describeError } from "@/lib/safe-error";
import type { StopFilter, StopResult } from "@/lib/ads/stop";
import type { AdsHeadroomDetail } from "../book";
import { isSyntheticMetaId, rolledPeaks, type BookCommitment } from "../commitments";
import type { SpendControlState, SpendDb } from "../control";
import { convertFromInr, type FxTable } from "../fx";
import { currencyExponent, formatMinor } from "../money";
import { notifySpend } from "../notify";
import { addDays, dayKey, startOfLocalDay } from "../periods";
import type { SpendActor, SpendNotice, SpendNoticeSeverity } from "../types";
import { openBreaker, type BreakerRow, type OpenBreakerInput } from "./state";

type Env = Record<string, string | undefined>;

export const DAY_MS = 86_400_000;
/** pacing: trip above 120% of the day's highest budgets; warn above 120% of the prorated plan. */
export const PACING_TRIP_PCT = 120n;
export const PACING_WARN_MIN_ELAPSED_MS = 2 * 3_600_000;
/** efficiency: the INR floor of the minimum spend (INR 500), and the multiples of the target. */
export const EFFICIENCY_FLOOR_INR_MINOR = 50_000n;
/** spend_jump: 25% of the day's highest budget, or 4 x its pro-rata share of the interval. */
export const SPEND_JUMP_DAY_SHARE_PCT = 25n;

// =====================================================================================================================
// Shared: currency floors, the run context, tripping
// =====================================================================================================================

/**
 * An INR amount in another currency (minor units): through a fresh admin FX rate, rounded down; without one, the same number
 * of major units rescaled to the currency's exponent. Floors only decide when a breaker may trip, never what may be spent.
 */
export function inrEquivalentMinor(inrMinor: bigint, currency: string, fx: FxTable | null, now: Date = new Date()): bigint {
  const cur = (currency || "INR").toUpperCase();
  if (cur === "INR") return inrMinor;
  if (fx) {
    const converted = convertFromInr(inrMinor, cur, fx, now);
    if (converted !== null) return converted;
  }
  const from = currencyExponent("INR");
  const to = currencyExponent(cur);
  return to >= from ? inrMinor * 10n ** BigInt(to - from) : inrMinor / 10n ** BigInt(from - to);
}

export type DailyRow = { scopeType: string; scopeId: string; day: string; origin: string; amountMinor: bigint; results: number; impressions: bigint; clicks: bigint };
export type SampleRow = { entityType: string; entityMetaId: string; accountDate: string; sampledAt: Date; spendMinor: bigint; impressions: bigint; clicks: bigint; results: number };
export type CampaignInfo = { id: string; name: string; origin: string; assistantKey: string | null; targetCostPerResultMinor: bigint | null; status: string };

/** What breakers do to the world; the defaults are the real ads lowering paths (tests swap them). */
export type BreakerDeps = {
  stopCommitments(tenantId: string, filter: StopFilter, actor: SpendActor, reason: string): Promise<StopResult>;
  pauseAdSet(tenantId: string, metaAdSetId: string, actor: SpendActor, reason: string): Promise<void>;
  /** Turns a paused campaign back on through activateCampaign (reserveAds inside): the daily_limit auto-resume. */
  resumeCampaign(tenantId: string, campaignId: string, actor: SpendActor, idempotencyKey: string): Promise<void>;
  enqueue(queue: string, payload: unknown): Promise<unknown>;
  notify(notice: SpendNotice): Promise<unknown>;
};

/** The audit user id the daily_limit auto-resume is recorded under (no person is involved). */
export const BREAKER_AUDIT_USER = "spend-breaker";

export const defaultBreakerDeps: BreakerDeps = {
  async stopCommitments(tenantId, filter, actor, reason) {
    const { stopCommitments } = await import("@/lib/ads/stop");
    return stopCommitments(tenantId, filter, actor, reason, { retryFailedAfterMs: 15 * 60_000 });
  },
  async pauseAdSet(tenantId, metaAdSetId, actor, reason) {
    const { pauseAdSet } = await import("@/lib/ads/actions");
    await pauseAdSet(tenantId, metaAdSetId, actor, { reason });
  },
  async resumeCampaign(tenantId, campaignId, actor, idempotencyKey) {
    const { activateCampaign, getCampaign } = await import("@/lib/ads/service");
    const c = await getCampaign(tenantId, campaignId);
    await activateCampaign({ userId: BREAKER_AUDIT_USER, tenantId, role: "admin" }, campaignId, { confirm: true, confirmedTotalMinor: c.confirmTotalMinor }, "resume", { spendActor: actor, idempotencyKey });
  },
  async enqueue(queue, payload) {
    const { enqueue } = await import("@/lib/queue");
    return enqueue(queue, payload);
  },
  notify: (notice) => notifySpend(notice),
};

export type BreakerContext = {
  tenantId: string;
  now: Date;
  env: Env;
  db: SpendDb;
  control: SpendControlState;
  detail: AdsHeadroomDetail;
  currency: string;
  fx: FxTable | null;
  /** SpendDaily ads rows of the last 10 days, with results, impressions and clicks. */
  daily: DailyRow[];
  /** IntradaySpendSample rows of the last 3 hours. */
  samples: SampleRow[];
  campaigns: Map<string, CampaignInfo>;
  /** Meta ad set id -> name. */
  adSetNames: Map<string, string>;
  /** The mandates' target cost per lead, by assistant key. */
  mandateTargets: Map<string, bigint | null>;
  deps: BreakerDeps;
  /** What this run did (for the result and tests). */
  log: { kind: string; scopeId: string; action: "tripped" | "repeat" | "cleared" | "warned" | "resumed" | "skipped"; detail?: string }[];
};

/** The account time zone of the ads pot (the spending ad account's, else the workspace's). */
export function adsTimezone(ctx: Pick<BreakerContext, "detail" | "control">): string {
  return ctx.detail.state.spendingAccount?.timezone ?? ctx.control.timezone;
}

export type TripInput = OpenBreakerInput & {
  notice: { title: string; body: string; severity?: SpendNoticeSeverity; audience?: SpendNotice["audience"]; link?: string };
  /** The lowering this breaker does on its first trip; its result is merged into the breaker's details. */
  act?: (breaker: BreakerRow) => Promise<Record<string, unknown> | void>;
};

/**
 * Opens a breaker (idempotent: an open one of the same kind and scope is returned, and nothing runs again), then on a new
 * trip does its lowering and notifies once (dedupeKey spend-breaker:<id>; notifiedAt set).
 */
export async function tripBreaker(ctx: BreakerContext, input: TripInput): Promise<{ breaker: BreakerRow; created: boolean }> {
  const { notice, act, ...open } = input;
  const res = await openBreaker(open, { now: ctx.now, ...(ctx.db !== prisma ? { db: ctx.db } : {}) });
  if (!res.created) {
    ctx.log.push({ kind: String(input.kind), scopeId: input.scopeId, action: "repeat" });
    return res;
  }
  ctx.log.push({ kind: String(input.kind), scopeId: input.scopeId, action: "tripped" });
  if (act) {
    try {
      const extra = await act(res.breaker);
      if (extra && Object.keys(extra).length > 0) await mergeDetails(ctx, res.breaker.id, extra);
    } catch (error) {
      console.error(`[spend] breaker ${String(input.kind)} could not finish its pause; the next run tries again: ${describeError(error)}`);
      await mergeDetails(ctx, res.breaker.id, { actFailed: true });
    }
  }
  await notifyOnce(ctx, res.breaker, notice);
  return res;
}

/** Merges JSON into a breaker's details (bigint-safe). */
export async function mergeDetails(ctx: Pick<BreakerContext, "db">, breakerId: string, extra: Record<string, unknown>): Promise<void> {
  const row = (await ctx.db.spendBreaker.findFirst({ where: { id: breakerId }, select: { details: true } })) as { details?: unknown } | null;
  const base = row?.details && typeof row.details === "object" && !Array.isArray(row.details) ? (row.details as Record<string, unknown>) : {};
  const next = JSON.parse(JSON.stringify({ ...base, ...extra }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  await ctx.db.spendBreaker.updateMany({ where: { id: breakerId }, data: { details: next } });
}

async function notifyOnce(ctx: BreakerContext, breaker: BreakerRow, notice: TripInput["notice"]): Promise<void> {
  try {
    await ctx.deps.notify({
      tenantId: ctx.tenantId,
      kind: "breaker_tripped",
      severity: notice.severity ?? "action_needed",
      audience: notice.audience ?? "approvers",
      dedupeKey: `spend-breaker:${breaker.id}`,
      title: notice.title,
      body: notice.body,
      link: notice.link ?? "/app/settings/spending",
      subjectType: "spend_breaker",
      subjectId: breaker.id,
    });
    await ctx.db.spendBreaker.updateMany({ where: { id: breaker.id, notifiedAt: null }, data: { notifiedAt: ctx.now } });
  } catch (error) {
    console.error(`[spend] breaker notice not sent: ${describeError(error)}`);
  }
}

const quote = (name: string) => `'${name}'`;

/** The open ad set commitments the performance breakers watch (real Meta ids, not orphans' placeholders). */
export function watchedAdSets(ctx: BreakerContext): BookCommitment[] {
  const all = [...ctx.detail.state.commitments, ...ctx.detail.state.orphans];
  const seen = new Set<string>();
  return all.filter((c) => {
    if (c.status === "stopped" || c.objectLevel !== "adset" || isSyntheticMetaId(c.metaObjectId) || seen.has(c.metaObjectId)) return false;
    seen.add(c.metaObjectId);
    return true;
  });
}

function nameOf(ctx: BreakerContext, c: BookCommitment): string {
  return ctx.adSetNames.get(c.metaObjectId) ?? ctx.campaigns.get(c.campaignId)?.name ?? "An ad set";
}

/** Assistant-managed: campaign origin `assistant` (6.2 note). Others are your team's and only get a notice, unless the toggle is on. */
export function mayPause(ctx: BreakerContext, c: BookCommitment): boolean {
  const origin = ctx.campaigns.get(c.campaignId)?.origin ?? c.origin;
  return origin === "assistant" || ctx.control.breakersMayPauseHumanCampaigns;
}

// =====================================================================================================================
// pacing
// =====================================================================================================================

/** pacing (pure): trip above 1.20 x Σ highest budgets today; warn above 1.20 x the prorated plan after 2 h and 10% of Σ D. */
export function pacingCheck(input: { spendToday: bigint; peakSum: bigint; dailySum: bigint; elapsedMs: number; dayMs?: number }): { trip: boolean; warn: boolean } {
  const { spendToday, peakSum, dailySum } = input;
  const trip = peakSum > 0n && spendToday * 100n > peakSum * PACING_TRIP_PCT;
  const dayMs = BigInt(input.dayMs ?? DAY_MS);
  const elapsed = BigInt(Math.max(0, Math.floor(input.elapsedMs)));
  const warn =
    !trip &&
    dailySum > 0n &&
    input.elapsedMs >= PACING_WARN_MIN_ELAPSED_MS &&
    spendToday * 10n > dailySum &&
    spendToday * 100n * dayMs > PACING_TRIP_PCT * dailySum * elapsed;
  return { trip, warn };
}

function spendOn(ctx: BreakerContext, metaObjectId: string, day: string): bigint {
  return ctx.daily.filter((r) => r.origin === "platform" && r.scopeType === "adset" && r.scopeId === metaObjectId && r.day === day).reduce((s, r) => s + r.amountMinor, 0n);
}

/** Runs the pacing breaker for the workspace's assistant-launched ad sets. */
export async function runPacing(ctx: BreakerContext): Promise<void> {
  const tz = adsTimezone(ctx);
  const today = dayKey(ctx.now, tz);
  const assistantSets = watchedAdSets(ctx).filter((c) => (ctx.campaigns.get(c.campaignId)?.origin ?? c.origin) === "assistant");
  if (assistantSets.length === 0) return;
  let spendToday = 0n;
  let peakSum = 0n;
  let dailySum = 0n;
  for (const c of assistantSets) {
    spendToday += spendOn(ctx, c.metaObjectId, today);
    peakSum += rolledPeaks(c, ctx.now).peakToday;
    dailySum += c.dailyBudgetMinor ?? 0n;
  }
  const elapsedMs = ctx.now.getTime() - startOfLocalDay(today, tz).getTime();
  const check = pacingCheck({ spendToday, peakSum, dailySum, elapsedMs });
  const cur = ctx.currency;
  if (check.trip) {
    await tripBreaker(ctx, {
      tenantId: ctx.tenantId,
      kind: "pacing",
      scopeType: "workspace",
      scopeId: ctx.tenantId,
      effect: "pause_scope",
      reason: `Your ad assistant's ads spent ${formatMinor(spendToday, cur)} today against ${formatMinor(peakSum, cur)} of daily budgets.`,
      details: { day: today, spendTodayMinor: spendToday, peakSumMinor: peakSum },
      autoClearAt: nextAccountMidnight(ctx.now, tz),
      notice: {
        title: "Your ad assistant was paused for spending too fast",
        body: `Its ads spent ${formatMinor(spendToday, cur)} today against ${formatMinor(peakSum, cur)} of daily budgets, so we paused them for today. You can turn them back on in Settings > Spending limits.`,
      },
      act: async () => {
        const r = await ctx.deps.stopCommitments(ctx.tenantId, { origin: "assistant" }, { type: "breaker", kind: "pacing" }, "Paused for spending too fast today.");
        return { paused: r.done, failed: r.failed + r.unreachable };
      },
    });
    return;
  }
  if (check.warn) {
    ctx.log.push({ kind: "pacing", scopeId: ctx.tenantId, action: "warned" });
    await ctx.deps.notify({
      tenantId: ctx.tenantId,
      kind: "breaker_tripped",
      severity: "heads_up",
      audience: "approvers",
      dedupeKey: `spend-pacing-warning:${ctx.tenantId}:${today}`,
      title: "Your ad assistant is spending faster than planned",
      body: `Its ads have spent ${formatMinor(spendToday, cur)} so far today, ahead of plan for ${formatMinor(dailySum, cur)} of daily budgets. We'll pause them if they pass ${formatMinor((peakSum * PACING_TRIP_PCT) / 100n, cur)}.`,
      link: "/app/settings/spending",
    });
  }
}

/** The next local midnight of the account day (when day-scoped breakers clear). */
export function nextAccountMidnight(now: Date, timezone: string): Date {
  return startOfLocalDay(addDays(dayKey(now, timezone), 1), timezone);
}

// =====================================================================================================================
// efficiency
// =====================================================================================================================

/** efficiency (pure): spend ≥ max(3 x target, floor) and cost per lead > 2 x target; zero leads counts as infinite. Off without a target. */
export function efficiencyCheck(input: { spendMinor: bigint; leads: number; targetMinor: bigint | null; floorMinor: bigint }): { trip: boolean; minSpendMinor: bigint | null; cplMinor: bigint | null } {
  const t = input.targetMinor;
  const cplMinor = input.leads > 0 ? input.spendMinor / BigInt(input.leads) : null;
  if (t === null || t <= 0n) return { trip: false, minSpendMinor: null, cplMinor };
  const min = 3n * t > input.floorMinor ? 3n * t : input.floorMinor;
  const trip = input.spendMinor >= min && (input.leads <= 0 || input.spendMinor > 2n * t * BigInt(input.leads));
  return { trip, minSpendMinor: min, cplMinor };
}

/** The target cost per lead: the campaign's, then the assistant mandate's, then the workspace's (6.2). Null turns efficiency off. */
export function targetFor(ctx: BreakerContext, c: BookCommitment): bigint | null {
  const camp = ctx.campaigns.get(c.campaignId);
  if (camp?.targetCostPerResultMinor) return camp.targetCostPerResultMinor;
  const key = camp?.assistantKey ?? c.assistantKey ?? "ads_optimizer";
  return ctx.mandateTargets.get(key) ?? ctx.mandateTargets.get("ads_optimizer") ?? ctx.control.targetCostPerLeadMinor ?? null;
}

export async function runEfficiency(ctx: BreakerContext): Promise<void> {
  const tz = adsTimezone(ctx);
  const today = dayKey(ctx.now, tz);
  const days = new Set([addDays(today, -2), addDays(today, -1), today]);
  const floor = inrEquivalentMinor(EFFICIENCY_FLOOR_INR_MINOR, ctx.currency, ctx.fx, ctx.now);
  const cur = ctx.currency;
  for (const c of watchedAdSets(ctx)) {
    const rows = ctx.daily.filter((r) => r.origin === "platform" && r.scopeType === "adset" && r.scopeId === c.metaObjectId && days.has(r.day));
    const spend = rows.reduce((s, r) => s + r.amountMinor, 0n);
    const leads = rows.reduce((s, r) => s + r.results, 0);
    const target = targetFor(ctx, c);
    const check = efficiencyCheck({ spendMinor: spend, leads, targetMinor: target, floorMinor: floor });
    if (!check.trip || target === null) continue;
    const name = nameOf(ctx, c);
    const pause = mayPause(ctx, c);
    const per = leads > 0 ? `${formatMinor(check.cplMinor ?? 0n, cur)} a lead` : "no leads";
    const facts = `${quote(name)} spent ${formatMinor(spend, cur)} in the last 3 days for ${leads === 1 ? "1 lead" : `${leads} leads`} (${per}, against your ${formatMinor(target, cur)} target).`;
    await tripBreaker(ctx, {
      tenantId: ctx.tenantId,
      kind: "efficiency",
      scopeType: "adset",
      scopeId: c.metaObjectId,
      effect: pause ? "pause_scope" : "notify_only",
      reason: facts,
      details: { spendMinor: spend, leads, targetMinor: target, campaignId: c.campaignId, paused: pause },
      notice: {
        title: pause ? `${quote(name)} was paused: it costs too much per lead` : `${quote(name)} costs too much per lead`,
        body: pause ? `${facts} We paused it. Turn it back on in Settings > Spending limits when you're ready.` : `${facts} Pause it on the Ads page, or change the target in Settings > Spending limits.`,
        severity: pause ? "action_needed" : "heads_up",
      },
      act: pause ? async () => void (await ctx.deps.pauseAdSet(ctx.tenantId, c.metaObjectId, { type: "breaker", kind: "efficiency" }, "Paused: it costs too much per lead.")) : undefined,
    });
  }
}

// =====================================================================================================================
// spend_jump
// =====================================================================================================================

/** spend_jump (pure): Δspend > max(0.25 x D, 4 x D x Δt / 24 h) between two samples of the same account day. */
export function spendJumpCheck(prev: Pick<SampleRow, "sampledAt" | "spendMinor" | "accountDate">, cur: Pick<SampleRow, "sampledAt" | "spendMinor" | "accountDate">, peakDailyMinor: bigint): { trip: boolean; deltaMinor: bigint } {
  const delta = cur.spendMinor - prev.spendMinor;
  const dt = cur.sampledAt.getTime() - prev.sampledAt.getTime();
  if (peakDailyMinor <= 0n || dt <= 0 || cur.accountDate !== prev.accountDate || delta <= 0n) return { trip: false, deltaMinor: delta };
  const overShare = delta * 100n > peakDailyMinor * SPEND_JUMP_DAY_SHARE_PCT;
  const overRate = delta * BigInt(DAY_MS) > 4n * peakDailyMinor * BigInt(dt);
  return { trip: overShare && overRate, deltaMinor: delta };
}

export async function runSpendJump(ctx: BreakerContext): Promise<void> {
  const cur = ctx.currency;
  for (const c of watchedAdSets(ctx)) {
    const s = ctx.samples.filter((x) => x.entityType === "adset" && x.entityMetaId === c.metaObjectId).sort((a, b) => a.sampledAt.getTime() - b.sampledAt.getTime());
    if (s.length < 2) continue;
    const [prev, last] = [s[s.length - 2], s[s.length - 1]];
    const peak = rolledPeaks(c, ctx.now).peakToday;
    const check = spendJumpCheck(prev, last, peak);
    if (!check.trip) continue;
    const name = nameOf(ctx, c);
    const pause = mayPause(ctx, c);
    const minutes = Math.max(1, Math.round((last.sampledAt.getTime() - prev.sampledAt.getTime()) / 60_000));
    const facts = `${quote(name)} spent ${formatMinor(check.deltaMinor, cur)} in ${minutes} minutes on a ${formatMinor(peak, cur)} daily budget.`;
    await tripBreaker(ctx, {
      tenantId: ctx.tenantId,
      kind: "spend_jump",
      scopeType: "adset",
      scopeId: c.metaObjectId,
      effect: pause ? "pause_scope" : "notify_only",
      reason: facts,
      details: { deltaMinor: check.deltaMinor, minutes, peakDailyMinor: peak, campaignId: c.campaignId, paused: pause },
      notice: {
        title: pause ? `${quote(name)} was paused: spending jumped` : `${quote(name)} is spending much faster than usual`,
        body: pause ? `${facts} We paused it. Turn it back on in Settings > Spending limits when you're ready.` : `${facts} Check it on the Ads page and pause it if this isn't expected.`,
        severity: pause ? "action_needed" : "heads_up",
      },
      act: pause ? async () => void (await ctx.deps.pauseAdSet(ctx.tenantId, c.metaObjectId, { type: "breaker", kind: "spend_jump" }, "Paused: spending jumped suddenly.")) : undefined,
    });
  }
}
