/**
 * The kill switches' ads side as worker tasks (docs/SPEND-CONTROLS-SPEC.md 4.11, 4.16).
 *
 * - Queue `spend.stop`: a toggle (workspace or platform) enqueues it after its inline pass. The job pauses what the freeze
 *   that applies NOW covers, through stopCommitments: everything for `all`, assistant-launched campaigns for `assistants`,
 *   nothing when spending was turned back on meanwhile. For the platform job (tenantId "*") workspaces go in order of money
 *   at risk. When a pause failed or an object was unreachable, the owner is told which campaigns may still be running, and
 *   where Edwyz manages Meta's spending limit the emergency write (metacap P0) is queued.
 * - Periodic `spend.kill.sweep`, every minute: the safety net. It finds frozen workspaces (or every workspace under a platform
 *   freeze) that still have something running and pauses it. A pause that failed is tried again after 15 minutes, not every
 *   minute, so a Meta outage does not fill the ledger.
 * Both run in the worker daemon, and from the once-a-minute /api/internal/tick when the daemon is down (the spend
 * WorkerModule is in MODULES). A toggle never waits for either: the freeze route pauses inline first (stopInline).
 *
 * markUnpaused() is the bookkeeping for an object stopCommitments could not pause: its live commitments become
 * `unconfirmed`, so they stay counted and the reconciler reads them again once a token is back.
 *
 * src/lib/ads/stop.ts is imported lazily (it imports markUnpaused from here).
 */
import { prisma } from "@/lib/db";
import { enqueue as enqueueJob, type JobHandler } from "@/lib/queue";
import { describeError } from "@/lib/safe-error";
import type { StopFilter, StopResult } from "@/lib/ads/stop";
import type { PeriodicTask } from "@/worker/registry";
import { isMetaLimitManaged, toMetaLimitRow } from "../commitments";
import type { SpendDb } from "../control";
import { isFreezeLevel, readPlatformFreeze, spendState, type StopInline } from "../kill";
import { notifySpend } from "../notify";
import { SPEND_QUEUES, type FreezeLevel, type SpendActor, type SpendStopJob } from "../types";

type Env = Record<string, string | undefined>;

export const KILL_SWEEP_TASK = "spend.kill.sweep";
export const KILL_SWEEP_EVERY_MS = 60_000;
/** A failed pause is retried by the sweep after this long. */
export const RETRY_FAILED_PAUSE_MS = 15 * 60_000;
/** The sweep stops starting new pauses after this long, so it finishes inside its 1-minute slot. */
export const SWEEP_BUDGET_MS = 45_000;
/** Workspaces one platform job or sweep visits; the next run takes the rest. */
export const MAX_TENANTS_PER_RUN = 200;

const OPEN_STATUSES = ["reserved", "live", "unconfirmed"];
const SWEEP_REASON = "Spending is stopped, so this was paused.";
const SWEEP_ACTOR: SpendActor = { type: "system", job: KILL_SWEEP_TASK };

// =====================================================================================================================
// Bookkeeping for objects that could not be paused
// =====================================================================================================================

/**
 * Marks the live commitments of a campaign (or of the given Meta objects) `unconfirmed`: they keep counting at their worst
 * case, and the reconciler reads them again. Commitments still `reserved` belong to an action in flight, which settles them
 * itself. Never throws. Returns how many rows changed.
 */
export async function markUnpaused(tenantId: string, target: { campaignId?: string; metaObjectIds?: readonly string[] }, db: SpendDb = prisma): Promise<number> {
  const or = [...(target.campaignId ? [{ campaignId: target.campaignId }] : []), ...(target.metaObjectIds?.length ? [{ metaObjectId: { in: [...target.metaObjectIds] } }] : [])];
  if (!tenantId || or.length === 0) return 0;
  try {
    const { count } = await db.spendCommitment.updateMany({ where: { tenantId, status: "live", OR: or }, data: { status: "unconfirmed", version: { increment: 1 } } });
    return count;
  } catch (error) {
    console.error(`[spend] could not mark an unpaused object as unconfirmed: ${describeError(error)}`);
    return 0;
  }
}

// =====================================================================================================================
// The stop job and the inline stop
// =====================================================================================================================

export type StopRun = { tenants: number; done: number; failed: number; unreachable: number; skipped: number; total: number };

export type StopRunOptions = {
  /** Epoch ms after which no new pause starts. */
  deadline?: number;
  retryFailedAfterMs?: number;
  /** Tell the owner about campaigns that may still be running, and queue Meta's emergency limit where it is managed. */
  escalate?: boolean;
  /** Workspaces a platform run visits (the admin's inline platform stop uses 25). */
  maxTenants?: number;
  env?: Env;
  enqueue?: (queue: string, payload: unknown) => Promise<unknown>;
};

const emptyRun = (): StopRun => ({ tenants: 0, done: 0, failed: 0, unreachable: 0, skipped: 0, total: 0 });

/** What the freeze in force covers: everything, assistant-launched campaigns, or nothing. */
export function stopOriginFor(level: FreezeLevel): StopFilter["origin"] | null {
  return level === "all" ? "all" : level === "assistants" ? "assistant" : null;
}

/** Workspaces with something that can spend (an active campaign or an open commitment), most money at risk first. */
export async function tenantsWithLiveAds(only?: readonly string[], db: SpendDb = prisma): Promise<string[]> {
  if (only && only.length === 0) return [];
  const scope = only ? { tenantId: { in: [...only] } } : {};
  const campaigns = ((await db.adCampaign.findMany({ where: { ...scope, status: "active", metaCampaignId: { not: null } }, select: { tenantId: true, dailyBudgetMinor: true }, take: 10_000 })) ?? []) as { tenantId: string; dailyBudgetMinor: number | null }[];
  const open = ((await db.spendCommitment.findMany({ where: { ...scope, status: { in: OPEN_STATUSES } }, select: { tenantId: true, dailyBudgetMinor: true }, take: 20_000 })) ?? []) as { tenantId: string; dailyBudgetMinor: bigint | number | null }[];
  const risk = new Map<string, number>();
  for (const c of campaigns) risk.set(c.tenantId, (risk.get(c.tenantId) ?? 0) + Number(c.dailyBudgetMinor ?? 0));
  for (const o of open) risk.set(o.tenantId, (risk.get(o.tenantId) ?? 0) + Number(o.dailyBudgetMinor ?? 0));
  return [...risk.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
}

async function escalate(tenantId: string, r: StopResult, job: Pick<SpendStopJob, "correlationId" | "reason">, opts: StopRunOptions): Promise<void> {
  const stuck = r.items.filter((i) => i.result === "failed" || i.result === "unreachable");
  if (stuck.length === 0) return;
  const env = opts.env ?? process.env;
  const enqueue = opts.enqueue ?? ((q: string, p: unknown) => enqueueJob(q, p));
  for (const assetId of [...new Set(stuck.map((i) => i.adAccountAssetId))]) {
    try {
      const raw = (await prisma.metaSpendLimit.findFirst({ where: { tenantId, adAccountAssetId: assetId } })) as Record<string, unknown> | null;
      if (!raw || !isMetaLimitManaged(toMetaLimitRow(raw), env)) continue;
      await enqueue(SPEND_QUEUES.metacapP0, {
        tenantId,
        adAccountAssetId: assetId,
        reason: "pause_failed",
        correlationId: job.correlationId ?? `stop:${tenantId}:${assetId}`,
        failedObjectIds: stuck.filter((i) => i.adAccountAssetId === assetId).map((i) => i.metaObjectId),
      });
    } catch (error) {
      console.error(`[spend] Meta's emergency limit was not queued: ${describeError(error)}`);
    }
  }
  const names = [...new Set(stuck.map((i) => i.campaignName).filter(Boolean))];
  const shown = names.slice(0, 3);
  const more = names.length - shown.length;
  const who = shown.length ? `${shown.map((n) => `'${n}'`).join(", ")}${more > 0 ? ` and ${more} more` : ""}` : stuck.length === 1 ? "One campaign" : `${stuck.length} campaigns`;
  await notifySpend({
    tenantId,
    kind: "spending_stopped",
    severity: "action_needed",
    audience: "owner",
    dedupeKey: `spend-unpaused:${tenantId}:${stuck.map((i) => i.metaObjectId).sort().join(",")}`.slice(0, 200),
    title: stuck.length === 1 ? "1 campaign could not be paused" : `${stuck.length} campaigns could not be paused`,
    body: `${who} may still be running. Pause ${stuck.length === 1 ? "it" : "them"} in Meta Ads Manager, or reconnect Meta in Settings > Connections and we'll try again.`,
    link: "/app/ads",
  });
}

/**
 * Pauses what the freeze in force covers, for one workspace or (tenantId "*") for every workspace with something running.
 * Never throws for a single workspace's failure; the counts say what happened.
 */
export async function runStop(job: SpendStopJob, opts: StopRunOptions = {}): Promise<StopRun> {
  const { stopCommitments } = await import("@/lib/ads/stop");
  const out = emptyRun();
  const tenants = job.tenantId === "*" ? (await tenantsWithLiveAds()).slice(0, opts.maxTenants ?? MAX_TENANTS_PER_RUN) : [job.tenantId];
  const actor = job.actor ?? ({ type: "system", job: SPEND_QUEUES.stop } as SpendActor);
  for (const tenantId of tenants) {
    if (job.tenantId === "*" && opts.deadline !== undefined && Date.now() >= opts.deadline) break;
    try {
      const state = await spendState(tenantId, { fresh: true });
      const origin = stopOriginFor(state.effective);
      if (!origin) continue;
      const filter: StopFilter = { origin, ...(job.adAccountAssetId ? { adAccountAssetId: job.adAccountAssetId } : {}) };
      const r = await stopCommitments(tenantId, filter, actor, job.reason, { deadline: opts.deadline, retryFailedAfterMs: opts.retryFailedAfterMs, env: opts.env });
      out.tenants++;
      out.done += r.done;
      out.failed += r.failed;
      out.unreachable += r.unreachable;
      out.skipped += r.skipped;
      out.total += r.total;
      if (opts.escalate !== false) await escalate(tenantId, r, job, opts);
    } catch (error) {
      console.error(`[spend] stop for a workspace failed; the sweep tries again: ${describeError(error)}`);
    }
  }
  return out;
}

/**
 * The freeze route's inline pass (kill.ts FreezeOptions.inline): pauses within the time budget and reports
 * {paused, total, failed} for "Paused 6 of 6 campaigns" or "Paused 4 of 6; the rest will follow within a minute".
 */
export const stopInline: StopInline = async (job, budgetMs) => {
  const r = await runStop(job, { deadline: Date.now() + Math.max(0, budgetMs - 1_000), escalate: true, maxTenants: 25 });
  return { paused: r.done, total: r.total, failed: r.failed + r.unreachable };
};

const ACTOR_TYPES = new Set(["user", "assistant", "system", "breaker", "platform_admin", "api", "external"]);

/** A spend.stop payload, or null when it is not one (ids and codes only; a malformed job is dropped, not retried). */
export function parseStopJob(payload: unknown): SpendStopJob | null {
  const p = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  if (!p || typeof p.tenantId !== "string" || !p.tenantId) return null;
  if (!isFreezeLevel(p.level) || p.level === "none") return null;
  const actor = p.actor && typeof p.actor === "object" && ACTOR_TYPES.has(String((p.actor as { type?: unknown }).type)) ? (p.actor as SpendActor) : ({ type: "system", job: SPEND_QUEUES.stop } as SpendActor);
  return {
    tenantId: p.tenantId,
    level: p.level,
    origin: p.origin === "assistant" ? "assistant" : "all",
    ...(typeof p.adAccountAssetId === "string" && p.adAccountAssetId ? { adAccountAssetId: p.adAccountAssetId } : {}),
    reason: typeof p.reason === "string" && p.reason.trim() ? p.reason.trim().slice(0, 300) : "Spending was stopped.",
    actor,
    ...(typeof p.correlationId === "string" ? { correlationId: p.correlationId } : {}),
  };
}

export const handleStopJob: JobHandler = async (payload) => {
  const job = parseStopJob(payload);
  if (!job) {
    console.error("[spend] dropped a malformed spend.stop job");
    return;
  }
  await runStop(job, { escalate: true });
};

// =====================================================================================================================
// The 1-minute sweep
// =====================================================================================================================

/** Frozen workspaces (every workspace under a platform freeze) that still have something running get it paused. */
export async function killSweep(opts: StopRunOptions = {}): Promise<StopRun & { candidates: number }> {
  const deadline = opts.deadline ?? Date.now() + SWEEP_BUDGET_MS;
  const platform = await readPlatformFreeze();
  let only: string[] | undefined;
  if (platform.freeze === "none") {
    const rows = ((await prisma.spendControl.findMany({ where: { freeze: { in: ["assistants", "all"] } }, select: { tenantId: true }, take: 5_000 })) ?? []) as { tenantId: string }[];
    only = rows.map((r) => r.tenantId);
    if (only.length === 0) return { ...emptyRun(), candidates: 0 };
  }
  const tenants = (await tenantsWithLiveAds(only)).slice(0, opts.maxTenants ?? MAX_TENANTS_PER_RUN);
  const { stopCommitments } = await import("@/lib/ads/stop");
  const out = { ...emptyRun(), candidates: tenants.length };
  for (const tenantId of tenants) {
    if (Date.now() >= deadline) break;
    try {
      const state = await spendState(tenantId, { fresh: true });
      const origin = stopOriginFor(state.effective);
      if (!origin) continue;
      const r = await stopCommitments(tenantId, { origin }, SWEEP_ACTOR, SWEEP_REASON, { deadline, retryFailedAfterMs: opts.retryFailedAfterMs ?? RETRY_FAILED_PAUSE_MS, env: opts.env });
      out.tenants++;
      out.done += r.done;
      out.failed += r.failed;
      out.unreachable += r.unreachable;
      out.skipped += r.skipped;
      out.total += r.total;
    } catch (error) {
      console.error(`[spend] kill sweep for a workspace failed: ${describeError(error)}`);
    }
  }
  return out;
}

export const queues: Record<string, JobHandler> = { [SPEND_QUEUES.stop]: handleStopJob };
export const periodic: PeriodicTask[] = [{ name: KILL_SWEEP_TASK, everyMs: KILL_SWEEP_EVERY_MS, run: () => killSweep() }];
