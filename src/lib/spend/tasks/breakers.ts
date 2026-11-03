/**
 * The ads breakers task (docs/SPEND-CONTROLS-SPEC.md 6.1, 6.2, 4.16, 8.3).
 *
 * - Periodic `spend.breakers`, every 5 minutes, and the queue `spend.breakers.run` (a sync or a limit change asks for a run
 *   of one workspace right away). For each workspace with something running, or with an ads breaker still tripped:
 *   1. day-scoped breakers past their clearing time first: daily_limit resumes what it paused (through reserveAds, only its
 *      own pauses, never while spending is stopped), pacing tells the owner the assistant stays paused, account_spike clears;
 *   2. the limit breakers (daily_limit, monthly_limit, budget_change_quota, sync_stale);
 *   3. the performance breakers (pacing, efficiency, spend_jump, cpm_ctr_anomaly, account_spike).
 *   Breakers past their autoClearAt (budget_change_quota, cpm_ctr_anomaly) are cleared at the end of the pass.
 * - The admin list (/admin/spending) never computes headroom for every workspace on a page load: this task writes each
 *   workspace's row to PlatformSetting `spend:summary:<tenantId>` (AdminSpendRowDTO) every 5 minutes, for the workspaces it
 *   visited plus a rotating batch of the others, so every workspace has a row.
 * The demo workspace runs no ads breakers (8.4); its summary row is labelled Demo and left out of the risk sort.
 */
import { prisma } from "@/lib/db";
import type { JobHandler } from "@/lib/queue";
import { describeError } from "@/lib/safe-error";
import type { PeriodicTask } from "@/worker/registry";
import { pendingApprovalCount } from "../approvals";
import { adsHeadroomDetail, headroom, type AdsHeadroomDetail } from "../book";
import { defaultBreakerDeps, runEfficiency, runPacing, runSpendJump, type BreakerContext, type BreakerDeps, type CampaignInfo, type DailyRow, type SampleRow } from "../breakers/ads";
import { runAccountSpike, runCpmCtrAnomaly } from "../breakers/anomaly";
import { resumeAfterDailyLimit, runBudgetQuota, runDailyLimit, runMonthlyLimit, runSyncStale } from "../breakers/limits";
import { breakerPot, clearBreaker, clearExpiredBreakers, listBreakers } from "../breakers/state";
import { isMetaLimitManaged } from "../commitments";
import type { SpendDb } from "../control";
import { isDemoWorkspace } from "../demo";
import { readFx } from "../fx";
import { formatMinor, percentOf, toMoneyDTO, toMoneyDTOOrNull } from "../money";
import { addDays, dateToDayKey, dayKey, dayKeyToDate } from "../periods";
import { SPEND_QUEUES, type AdminSpendRowDTO, type AdminSpendState, type MetaLimitState } from "../types";
import { tenantsWithLiveAds } from "./adsguard";

type Env = Record<string, string | undefined>;

export const BREAKERS_TASK = "spend.breakers";
export const BREAKERS_EVERY_MS = 5 * 60_000;
/** A pass stops starting new workspaces after this long, so it finishes inside its slot. */
export const BREAKERS_BUDGET_MS = 4 * 60_000;
export const SUMMARY_BATCH = 100;
/** Summary rows built side by side, and how long the rotating batch may take; the cursor carries on next run. */
export const SUMMARY_CONCURRENCY = 4;
export const SUMMARY_BUDGET_MS = 10_000;
export const summaryKey = (tenantId: string) => `spend:summary:${tenantId}`;
const SUMMARY_CURSOR_KEY = "spend:summary:cursor";
const ADS_BREAKER_KINDS = ["pacing", "efficiency", "spend_jump", "cpm_ctr_anomaly", "account_spike", "daily_limit", "monthly_limit", "budget_change_quota", "sync_stale"];

const big = (v: unknown): bigint => (v === null || v === undefined ? 0n : typeof v === "bigint" ? v : BigInt(Math.trunc(Number(v))));

export type RunOptions = { db?: SpendDb; now?: Date; env?: Env; deps?: Partial<BreakerDeps> };

/** Everything one pass over a workspace reads, once. */
export async function buildBreakerContext(tenantId: string, opts: RunOptions = {}): Promise<BreakerContext> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const detail = await adsHeadroomDetail(tenantId, { db, now, env, fresh: true });
  const control = detail.state.control;
  const tz = detail.state.spendingAccount?.timezone ?? control.timezone;
  const from = addDays(dayKey(now, tz), -10);
  const daily: DailyRow[] = (((await db.spendDaily.findMany({ where: { tenantId, pot: "ads", day: { gte: dayKeyToDate(from) } } })) ?? []) as Record<string, unknown>[]).map((r) => ({
    scopeType: String(r.scopeType),
    scopeId: String(r.scopeId),
    day: r.day instanceof Date ? dateToDayKey(r.day) : String(r.day).slice(0, 10),
    origin: String(r.origin),
    amountMinor: big(r.amountMinor),
    results: Number(r.results ?? 0) || 0,
    impressions: big(r.impressions),
    clicks: big(r.clicks),
  }));
  const samples: SampleRow[] = (((await db.intradaySpendSample.findMany({ where: { tenantId, sampledAt: { gte: new Date(now.getTime() - 3 * 3_600_000) } }, orderBy: { sampledAt: "asc" } })) ?? []) as Record<string, unknown>[]).map((r) => ({
    entityType: String(r.entityType),
    entityMetaId: String(r.entityMetaId),
    accountDate: r.accountDate instanceof Date ? dateToDayKey(r.accountDate) : String(r.accountDate).slice(0, 10),
    sampledAt: r.sampledAt instanceof Date ? r.sampledAt : new Date(String(r.sampledAt)),
    spendMinor: big(r.spendMinor),
    impressions: big(r.impressions),
    clicks: big(r.clicks),
    results: Number(r.results ?? 0) || 0,
  }));
  const campaignIds = [...new Set([...detail.state.commitments, ...detail.state.orphans].map((c) => c.campaignId))];
  const campaigns = new Map<string, CampaignInfo>();
  const adSetNames = new Map<string, string>();
  if (campaignIds.length > 0) {
    const rows = ((await db.adCampaign.findMany({ where: { tenantId, id: { in: campaignIds } }, select: { id: true, name: true, origin: true, assistantKey: true, targetCostPerResultMinor: true, status: true } })) ?? []) as Record<string, unknown>[];
    for (const r of rows) {
      campaigns.set(String(r.id), {
        id: String(r.id),
        name: String(r.name ?? ""),
        origin: String(r.origin ?? "human"),
        assistantKey: (r.assistantKey as string | null) ?? null,
        targetCostPerResultMinor: r.targetCostPerResultMinor === null || r.targetCostPerResultMinor === undefined ? null : big(r.targetCostPerResultMinor),
        status: String(r.status ?? ""),
      });
    }
    const sets = ((await db.adSet.findMany({ where: { tenantId, campaignId: { in: campaignIds } }, select: { metaAdSetId: true, name: true } })) ?? []) as { metaAdSetId: string | null; name: string }[];
    for (const s of sets) if (s.metaAdSetId) adSetNames.set(s.metaAdSetId, s.name);
  }
  const mandateTargets = new Map<string, bigint | null>();
  for (const m of ((await db.assistantMandate.findMany({ where: { tenantId }, select: { assistantKey: true, targetCostPerLeadMinor: true } })) ?? []) as { assistantKey: string; targetCostPerLeadMinor: bigint | null }[]) {
    mandateTargets.set(m.assistantKey, m.targetCostPerLeadMinor === null || m.targetCostPerLeadMinor === undefined ? null : big(m.targetCostPerLeadMinor));
  }
  let fx = null;
  try {
    fx = await readFx(db);
  } catch {
    fx = null;
  }
  return { tenantId, now, env, db, control, detail, currency: detail.limits.currency, fx, daily, samples, campaigns, adSetNames, mandateTargets, deps: { ...defaultBreakerDeps, ...(opts.deps ?? {}) }, log: [] };
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.error(`[spend] breaker ${name} failed for a workspace: ${describeError(error)}`);
  }
}

export type BreakerRunResult = { tenantId: string; skipped?: "demo"; log: BreakerContext["log"]; detail?: AdsHeadroomDetail };

/** One pass of every ads breaker over one workspace. Never throws for a single breaker's failure. */
export async function runBreakersForTenant(tenantId: string, opts: RunOptions = {}): Promise<BreakerRunResult> {
  const db = opts.db ?? prisma;
  if (await isDemoWorkspace(tenantId, db)) return { tenantId, skipped: "demo", log: [] };
  const ctx = await buildBreakerContext(tenantId, opts);
  const now = ctx.now;

  // 1. Day-scoped breakers past their clearing time, before anything can trip again on the new day.
  const due = (await listBreakers(tenantId, { db, now, state: "tripped", kinds: ["daily_limit", "pacing", "account_spike"] })).filter((b) => b.autoClearAt && b.autoClearAt.getTime() <= now.getTime());
  for (const b of due) {
    await step(`${b.kind} day roll`, async () => {
      if (b.kind === "daily_limit") {
        await resumeAfterDailyLimit(ctx, b);
        return;
      }
      await clearBreaker({ id: b.id }, { now, reason: "A new account day started." });
      ctx.log.push({ kind: String(b.kind), scopeId: b.scopeId, action: "cleared" });
      if (b.kind === "pacing") {
        await ctx.deps.notify({
          tenantId,
          kind: "breaker_cleared",
          severity: "heads_up",
          audience: "approvers",
          dedupeKey: `spend-breaker:${b.id}:cleared`,
          title: "Your ad assistant is still paused",
          body: "Your ad assistant was paused yesterday for spending too fast. Its ads stay paused. Resume them in Settings > Spending limits?",
          link: "/app/settings/spending",
        });
      }
    });
  }

  // 2. Limits, then 3. performance.
  await step("daily_limit", () => runDailyLimit(ctx));
  await step("monthly_limit", () => runMonthlyLimit(ctx));
  await step("budget_change_quota", () => runBudgetQuota(ctx));
  await step("sync_stale", () => runSyncStale(ctx));
  await step("pacing", () => runPacing(ctx));
  await step("efficiency", () => runEfficiency(ctx));
  await step("spend_jump", () => runSpendJump(ctx));
  await step("cpm_ctr_anomaly", () => runCpmCtrAnomaly(ctx));
  await step("account_spike", () => runAccountSpike(ctx));
  return { tenantId, log: ctx.log, detail: ctx.detail };
}

// =====================================================================================================================
// The admin list's cached row (AdminSpendRowDTO in PlatformSetting spend:summary:<tenantId>)
// =====================================================================================================================

function metaLimitCell(detail: AdsHeadroomDetail, env: Env): { state: MetaLimitState | "no_ad_account"; label: string } {
  const account = detail.state.spendingAccount;
  if (!account) return { state: "no_ad_account", label: detail.state.accounts.length ? "No spending ad account" : "No ad account" };
  if (account.demo) return { state: "demo", label: "Demo" };
  const row = detail.state.metaLimits.find((m) => m.adAccountAssetId === account.assetId) ?? null;
  const cur = account.currency ?? detail.limits.currency;
  if (account.sandbox) return { state: "sandbox", label: "Test account" };
  if (!row) return { state: "off", label: "Off" };
  switch (row.mode) {
    case "managed": {
      if (!isMetaLimitManaged(row, env)) return { state: "ready", label: "Ready" };
      const stale = !row.lastReadAt || detail.headroom.computedAt.getTime() - row.lastReadAt.getTime() > 6 * 3_600_000;
      if (stale) return { state: "error", label: "Out of date" };
      const loose = (row as { loosenessMinor?: bigint | null }).loosenessMinor ?? null;
      if (loose !== null && loose > 0n) return { state: "loose", label: `Loose by ${formatMinor(loose, cur)}` };
      return { state: "managed", label: row.managedCapMinor !== null && row.managedCapMinor !== undefined ? `Managed ${formatMinor(row.managedCapMinor, cur)}` : "Managed" };
    }
    case "pending_owner":
      return { state: "pending_owner", label: "Waiting for owner" };
    case "unavailable_prepaid":
      return { state: "unavailable_prepaid", label: "Prepaid" };
    case "no_permission":
      return { state: "no_permission", label: "No permission" };
    case "currency_mismatch":
      return { state: "currency_mismatch", label: "Currency differs" };
    case "other_workspace":
      return { state: "other_workspace", label: "Managed by another workspace" };
    case "sandbox":
      return { state: "sandbox", label: "Test account" };
    case "error":
      return { state: "error", label: "Out of date" };
    case "withdrawn":
      return { state: "withdrawn", label: "Off" };
    default:
      return { state: "off", label: "Off" };
  }
}

const cell = (spent: bigint, setAside: bigint, limit: bigint | null, currency: string) => ({ spent: toMoneyDTO(spent, currency), setAside: toMoneyDTO(setAside, currency), limit: toMoneyDTOOrNull(limit, currency) });

/** The admin list's row for one workspace, from live figures (the task stores it; the list reads it). */
export async function buildSummaryRow(tenantId: string, opts: { db?: SpendDb; now?: Date; env?: Env; detail?: AdsHeadroomDetail } = {}): Promise<AdminSpendRowDTO> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const tenant = (await db.tenant.findFirst({ where: { id: tenantId }, select: { name: true, slug: true } })) as { name?: string; slug?: string } | null;
  const demo = await isDemoWorkspace(tenantId, db);
  const ads = opts.detail ?? (await adsHeadroomDetail(tenantId, { db, now, env }));
  const messaging = await headroom(tenantId, "messaging", { db, now, env });
  const ai = await headroom(tenantId, "ai", { db, now, env });
  const sub = (await db.subscription.findFirst({ where: { tenantId }, select: { planId: true } })) as { planId?: string } | null;
  const plan = sub?.planId ? ((await db.plan.findFirst({ where: { id: sub.planId }, select: { name: true } })) as { name?: string } | null) : null;
  const breakers = await listBreakers(tenantId, { db, now });
  const waiting = await pendingApprovalCount(tenantId, { db, now });
  const phones = await db.phoneNumber.count({ where: { tenantId } });
  const control = ads.state.control;
  const noAdAccount = !ads.state.spendingAccount;
  const cur = ads.headroom.currency;
  const adsToday = noAdAccount ? null : cell(ads.headroom.today.spent, ads.headroom.today.committed, ads.headroom.limits.daily, cur);
  const adsMonth = noAdAccount ? null : cell(ads.headroom.month.spent, ads.headroom.month.committed, ads.headroom.limits.monthly, cur);
  const whatsappMonth = cell(messaging.month.spent, messaging.month.held, messaging.limits.monthly, messaging.currency);
  const aiUsed = ai.month.spent + ai.month.held;
  const state: AdminSpendState = ads.headroom.freeze.effective === "all" ? "stopped" : ads.headroom.freeze.effective === "assistants" ? "assistants_stopped" : "on";
  const risks = [
    noAdAccount ? null : percentOf(ads.headroom.today.spent + ads.headroom.today.committed, ads.headroom.limits.daily),
    noAdAccount ? null : percentOf(ads.headroom.month.spent + ads.headroom.month.committed, ads.headroom.limits.monthly),
    percentOf(messaging.month.spent + messaging.month.held, messaging.limits.monthly),
    percentOf(aiUsed, ai.limits.monthly),
  ].filter((x): x is number => x !== null);
  return {
    tenantId,
    name: tenant?.name ?? "Workspace",
    slug: tenant?.slug ?? "",
    plan: plan?.name ?? null,
    demo,
    newWorkspaceLimits: control.probation === "forced" ? "forced" : ads.limits.probation.on ? "on" : "lifted",
    adsToday,
    adsMonth,
    whatsappMonth,
    aiMonth: { used: toMoneyDTO(aiUsed, ai.currency), limit: toMoneyDTOOrNull(ai.limits.monthly, ai.currency) },
    metaLimit: metaLimitCell(ads, env),
    breakersOpen: breakers.filter((b) => breakerPot(b.kind) !== "none").length,
    requestsWaiting: waiting,
    state,
    riskPct: demo || risks.length === 0 ? null : Math.max(...risks),
    asOf: now.toISOString(),
    noAdAccount,
    noWhatsApp: phones === 0,
  };
}

/** Builds and stores the cached row. Never throws. */
export async function writeSummary(tenantId: string, opts: { db?: SpendDb; now?: Date; env?: Env; detail?: AdsHeadroomDetail } = {}): Promise<AdminSpendRowDTO | null> {
  const db = opts.db ?? prisma;
  try {
    const row = await buildSummaryRow(tenantId, opts);
    const value = JSON.parse(JSON.stringify(row));
    await db.platformSetting.upsert({ where: { key: summaryKey(tenantId) }, create: { key: summaryKey(tenantId), value }, update: { value } });
    return row;
  } catch (error) {
    console.error(`[spend] spending summary for a workspace not written: ${describeError(error)}`);
    return null;
  }
}

/** The next batch of workspaces for the summary cache, round-robin through every workspace (in cursor order; the caller saves the cursor). */
async function summaryBatch(db: SpendDb): Promise<string[]> {
  const cursorRow = (await db.platformSetting.findUnique({ where: { key: SUMMARY_CURSOR_KEY } })) as { value?: unknown } | null;
  const after = typeof (cursorRow?.value as { after?: unknown } | null)?.after === "string" ? String((cursorRow!.value as { after: string }).after) : "";
  const take = SUMMARY_BATCH;
  let rows = ((await db.tenant.findMany({ where: { deletedAt: null, ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: "asc" }, take, select: { id: true } })) ?? []) as { id: string }[];
  if (rows.length < take && after) {
    const wrap = ((await db.tenant.findMany({ where: { deletedAt: null }, orderBy: { id: "asc" }, take: take - rows.length, select: { id: true } })) ?? []) as { id: string }[];
    rows = [...rows, ...wrap.filter((w) => !rows.some((r) => r.id === w.id))];
  }
  return rows.map((r) => r.id);
}

async function saveSummaryCursor(db: SpendDb, after: string): Promise<void> {
  const value = { after };
  await db.platformSetting.upsert({ where: { key: SUMMARY_CURSOR_KEY }, create: { key: SUMMARY_CURSOR_KEY, value }, update: { value } });
}

/** The 5-minute pass: breakers for every workspace with ads running or a breaker open, then the summary cache. */
export async function runAllBreakers(opts: RunOptions & { deadlineMs?: number } = {}): Promise<{ tenants: number; summaries: number; cleared: number }> {
  const db = opts.db ?? prisma;
  const started = Date.now();
  const budget = opts.deadlineMs ?? BREAKERS_BUDGET_MS;
  const live = await tenantsWithLiveAds(undefined, db);
  const tripped = ((await db.spendBreaker.findMany({ where: { state: "tripped", kind: { in: ADS_BREAKER_KINDS } }, select: { tenantId: true }, take: 2_000 })) ?? []) as { tenantId: string }[];
  const tenants = [...new Set([...live, ...tripped.map((t) => t.tenantId)])];
  const done = new Set<string>();
  let summaries = 0;
  for (const tenantId of tenants) {
    if (Date.now() - started > budget) break;
    try {
      const r = await runBreakersForTenant(tenantId, opts);
      if (await writeSummary(tenantId, { db, now: opts.now, env: opts.env, detail: r.detail })) summaries++;
    } catch (error) {
      console.error(`[spend] breakers pass for a workspace failed: ${describeError(error)}`);
    }
    done.add(tenantId);
  }
  let cleared = 0;
  try {
    cleared = await clearExpiredBreakers({ db: opts.db, now: opts.now });
  } catch (error) {
    console.error(`[spend] expired breakers not cleared: ${describeError(error)}`);
  }
  try {
    // The rest of the workspaces, a few at a time and within the cache's own budget: a cached row is never worth holding the
    // worker pass (or the tick) for. The cursor moves only past rows this run reached, so a short run skips no workspace.
    const batch = await summaryBatch(db);
    const batchStarted = Date.now();
    let reached = 0;
    for (let i = 0; i < batch.length; i += SUMMARY_CONCURRENCY) {
      if (Date.now() - started > budget || (i > 0 && Date.now() - batchStarted > SUMMARY_BUDGET_MS)) break;
      const chunk = batch.slice(i, i + SUMMARY_CONCURRENCY).filter((tenantId) => !done.has(tenantId));
      summaries += (await Promise.all(chunk.map((tenantId) => writeSummary(tenantId, { db, now: opts.now, env: opts.env })))).filter(Boolean).length;
      reached = Math.min(batch.length, i + SUMMARY_CONCURRENCY);
    }
    if (reached > 0) await saveSummaryCursor(db, batch[reached - 1]);
  } catch (error) {
    console.error(`[spend] summary batch failed: ${describeError(error)}`);
  }
  return { tenants: done.size, summaries, cleared };
}

/** spend.breakers.run {tenantId, reason}: one workspace now (after a sync or a limit change). */
export const handleBreakersRun: JobHandler = async (payload) => {
  const p = payload && typeof payload === "object" ? (payload as { tenantId?: unknown }) : null;
  if (!p || typeof p.tenantId !== "string" || !p.tenantId) {
    console.error("[spend] dropped a malformed spend.breakers.run job");
    return;
  }
  const r = await runBreakersForTenant(p.tenantId);
  await writeSummary(p.tenantId, { detail: r.detail });
};

export const queues: Record<string, JobHandler> = { [SPEND_QUEUES.breakersRun]: handleBreakersRun };
export const periodic: PeriodicTask[] = [{ name: BREAKERS_TASK, everyMs: BREAKERS_EVERY_MS, run: () => runAllBreakers() }];
