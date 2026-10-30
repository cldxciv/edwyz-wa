/**
 * The commitments reconciler (docs/SPEND-CONTROLS-SPEC.md 4.6 "Reconciler", I3; task spend.commitments.reconcile every 2 min).
 *
 * 1. Commitments still `reserved` past reservedUntil (a crash between reserveAds and settleAds) and `unconfirmed` ones older
 *    than 5 minutes (an ambiguous Meta answer) are read from Meta:
 *      GET <metaObjectId>?fields=effective_status,status,daily_budget,lifetime_budget,end_time
 *    ACTIVE with budget X: the commitment becomes live at X. PAUSED, ARCHIVED or DELETED (or a paused parent): stopped. The
 *    ledger records `reconciled` (the request's outcome, or the third row after `unconfirmed`). Until a read succeeds the row
 *    stays counted, which is the safe direction.
 * 2. DB `AdCampaign.status = 'active'` campaigns that Meta shows paused are corrected (edits made in Ads Manager).
 * 3. Orphans (DB-active campaigns and ad sets with no open commitment, which the book already counts as synthetic) become
 *    real rows at the budget Meta reports, or at the DB budget when Meta cannot be read, and are ledgered as
 *    `ads.commitment.reconciled`. An orphan ad set that Meta shows not running under a running campaign is stored as a
 *    `stopped` row instead (a StoppedMark, commitments.ts), so the book stops counting it.
 * Reads need no permit (they never raise spend). The Meta reads happen before the spend lock; only the database bookkeeping
 * runs under it (I10), and each write there is re-checked against what changed since the read. Demo assets are never read (8.4).
 */
import { graphFetchAs } from "@/lib/graph";
import { getAssetAccess } from "@/lib/meta-connect";
import { prisma } from "@/lib/db";
import { describeError } from "@/lib/safe-error";
import { isSyntheticMetaId, loadAdAccounts, loadOrphans, OPEN_STATUSES, rolledPeaks, toBookCommitment, type AdAccountInfo, type BookCommitment } from "./commitments";
import { getControl, type SpendDb } from "./control";
import { appendOutcome, appendStandalone, type LedgerDb } from "./ledger";
import { withSpendLock, type SpendLockClient } from "./lock";
import { dayKeyToDate } from "./periods";
import type { SpendActor } from "./types";

/** The read-only field list of a reconcile read (bypass rule B10 allows these names here). */
export const RECONCILE_FIELDS = "effective_status,status,daily_budget,lifetime_budget,end_time";
/** An unconfirmed commitment is read once it is this old. */
export const UNCONFIRMED_AFTER_MS = 5 * 60_000;
export const RECONCILE_EVERY_MS = 2 * 60_000;

const STOPPED_STATUSES = new Set(["PAUSED", "ARCHIVED", "DELETED"]);
const STOPPED_EFFECTIVE = new Set(["PAUSED", "ARCHIVED", "DELETED", "CAMPAIGN_PAUSED", "ADSET_PAUSED"]);
const SYSTEM: SpendActor = { type: "system", job: "spend.commitments.reconcile" };
const EXTERNAL: SpendActor = { type: "external", source: "meta_ads_manager" };

export type MetaObjectRead = { status: string | null; effectiveStatus: string | null; dailyBudgetMinor: bigint | null; lifetimeBudgetMinor: bigint | null; endsAt: Date | null };
export type Observation = { state: "live" | "stopped"; read: MetaObjectRead; parentPaused: boolean };

export type ReconcileDeps = {
  db?: SpendDb & Partial<SpendLockClient>;
  now?: Date;
  /** The ad account's token (defaults to getAssetAccess). */
  access?: (tenantId: string, adAccountAssetId: string) => Promise<{ token: string }>;
  /** One Graph GET (defaults to graphFetchAs). */
  read?: (token: string, metaObjectId: string, fields: string) => Promise<Record<string, unknown>>;
  /** Commitments checked per run (default 200). */
  limit?: number;
  /** Workspaces scanned for orphans per run (default 20). */
  orphanTenants?: number;
};

export type ReconcileResult = {
  checked: number;
  live: number;
  stopped: number;
  unreachable: number;
  skipped: number;
  /** Orphans stored as live commitments. */
  orphansAdopted: number;
  /** Orphan ad sets Meta shows not running, stored as stopped (so they are no longer counted). */
  orphansStopped: number;
  campaignsCorrected: number;
  errors: number;
};

const big = (v: unknown): bigint | null => (v === null || v === undefined || v === "" ? null : typeof v === "bigint" ? v : /^\d+$/.test(String(v)) ? BigInt(String(v)) : null);

/** Parses a Graph object read. Budgets are read as minor units (Meta's documented read unit). */
export function parseObjectRead(body: Record<string, unknown>): MetaObjectRead {
  const end = typeof body.end_time === "string" && body.end_time ? new Date(body.end_time) : null;
  return {
    status: typeof body.status === "string" ? body.status : null,
    effectiveStatus: typeof body.effective_status === "string" ? body.effective_status : null,
    dailyBudgetMinor: big(body.daily_budget),
    lifetimeBudgetMinor: big(body.lifetime_budget),
    endsAt: end && !Number.isNaN(end.getTime()) ? end : null,
  };
}

/** ACTIVE counts as live (also while Meta is still reviewing); a paused, archived or deleted object or parent is stopped. */
export function observe(read: MetaObjectRead): Observation {
  const parentPaused = read.effectiveStatus === "CAMPAIGN_PAUSED";
  const stopped = (read.status !== null && STOPPED_STATUSES.has(read.status)) || (read.effectiveStatus !== null && STOPPED_EFFECTIVE.has(read.effectiveStatus));
  return { state: stopped ? "stopped" : read.status === "ACTIVE" || read.status === null ? "live" : "stopped", read, parentPaused };
}

const defaultRead = (token: string, metaObjectId: string, fields: string) => graphFetchAs<Record<string, unknown>>(token, { path: metaObjectId, method: "GET", query: { fields } });
const defaultAccess = async (tenantId: string, assetId: string) => ({ token: (await getAssetAccess(tenantId, assetId)).token });
const lockOpts = (db: ReconcileDeps["db"]) => (db && typeof db.$transaction === "function" ? { db: db as unknown as SpendLockClient } : {});
const ledgerDb = (db: SpendDb): LedgerDb => db as unknown as LedgerDb;

type Reader = (tenantId: string, adAccountAssetId: string, metaObjectId: string) => Promise<Observation | "unreachable" | "skip">;

/** Reads through one token per ad account; a token that cannot be had makes the whole account unreachable for this run. */
function makeReader(deps: ReconcileDeps, accounts: Map<string, AdAccountInfo>): Reader {
  const tokens = new Map<string, Promise<string | null>>();
  const access = deps.access ?? defaultAccess;
  const read = deps.read ?? defaultRead;
  return async (tenantId, assetId, metaObjectId) => {
    if (isSyntheticMetaId(metaObjectId)) return "skip";
    const account = accounts.get(assetId);
    if (account?.demo) return "skip";
    let token = tokens.get(assetId);
    if (!token) {
      token = access(tenantId, assetId).then(
        (a) => a.token,
        () => null,
      );
      tokens.set(assetId, token);
    }
    const t = await token;
    if (!t) return "unreachable";
    try {
      return observe(parseObjectRead(await read(t, metaObjectId, RECONCILE_FIELDS)));
    } catch {
      return "unreachable";
    }
  };
}

function liveData(c: BookCommitment, read: MetaObjectRead, now: Date) {
  const daily = read.dailyBudgetMinor ?? (read.lifetimeBudgetMinor !== null ? null : c.dailyBudgetMinor);
  const lifetime = read.lifetimeBudgetMinor ?? (read.dailyBudgetMinor !== null ? null : c.lifetimeBudgetMinor);
  const p = rolledPeaks({ ...c, dailyBudgetMinor: daily ?? c.dailyBudgetMinor }, now);
  const d = daily ?? 0n;
  const keepEnd = c.origin === "assistant" && !read.endsAt && lifetime === null ? c.endsAt : read.endsAt;
  return {
    status: "live",
    dailyBudgetMinor: daily === null && lifetime === null ? (c.dailyBudgetMinor ?? 0n) : daily,
    lifetimeBudgetMinor: lifetime,
    endsAt: keepEnd,
    dayKey: dayKeyToDate(p.today),
    peakDailyBudgetMinor: p.peakToday > d ? p.peakToday : d,
    weekStart: dayKeyToDate(p.week),
    weekPeakDailyBudgetMinor: p.weekPeak > d ? p.weekPeak : d,
    reservedUntil: null,
    pendingFromMinor: null,
  };
}

/** The row an orphan is stored as: live (counted) or stopped (a StoppedMark). */
function orphanRow(tenantId: string, c: BookCommitment, status: "live" | "stopped") {
  return {
    tenantId,
    adAccountAssetId: c.adAccountAssetId,
    campaignId: c.campaignId,
    adSetId: c.adSetId,
    metaObjectId: c.metaObjectId,
    objectLevel: c.objectLevel,
    origin: c.origin,
    assistantKey: c.assistantKey,
    currency: c.currency,
    timezone: c.timezone,
    dailyBudgetMinor: c.dailyBudgetMinor,
    lifetimeBudgetMinor: c.lifetimeBudgetMinor,
    dayKey: c.dayKey ? dayKeyToDate(c.dayKey) : null,
    dayStartBudgetMinor: c.dayStartBudgetMinor,
    peakDailyBudgetMinor: c.peakDailyBudgetMinor,
    weekStart: c.weekStart ? dayKeyToDate(c.weekStart) : null,
    weekPeakDailyBudgetMinor: c.weekPeakDailyBudgetMinor,
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    status,
    sandbox: c.sandbox,
  };
}

async function correctCampaign(db: SpendDb, tenantId: string, campaignId: string, status: "paused" | "archived", metaObjectId: string): Promise<boolean> {
  const { count } = await db.adCampaign.updateMany({ where: { id: campaignId, tenantId, status: "active" }, data: { status } });
  if (count === 0) return false;
  await appendStandalone(
    {
      tenantId,
      pot: "ads",
      action: "ads.external_change",
      phase: "reconciled",
      actor: EXTERNAL,
      reason: `This campaign is ${status} on Meta, so Edwyz now shows it as ${status} too.`,
      reasonCodes: ["campaign_status"],
      targetType: "campaign",
      targetId: campaignId,
      metaObjectId,
      before: { status: "active" },
      after: { status },
    },
    { db: ledgerDb(db) },
  );
  return true;
}

let orphanCursor = 0;

/** Test hook: restarts the orphan scan at the first workspace. */
export function resetReconcileCursor(): void {
  orphanCursor = 0;
}

/** One reconciler run over every workspace. Never throws for one bad row; returns counts. */
export async function reconcileCommitments(deps: ReconcileDeps = {}): Promise<ReconcileResult> {
  const db = deps.db ?? prisma;
  const now = deps.now ?? new Date();
  const result: ReconcileResult = { checked: 0, live: 0, stopped: 0, unreachable: 0, skipped: 0, orphansAdopted: 0, orphansStopped: 0, campaignsCorrected: 0, errors: 0 };
  const due = (((await db.spendCommitment.findMany({
    where: { OR: [{ status: "reserved", reservedUntil: { lt: now } }, { status: "unconfirmed", updatedAt: { lt: new Date(now.getTime() - UNCONFIRMED_AFTER_MS) } }] },
    orderBy: { updatedAt: "asc" },
    take: Math.min(Math.max(1, deps.limit ?? 200), 1_000),
  })) ?? []) as Record<string, unknown>[]).map(toBookCommitment);

  const byTenant = new Map<string, BookCommitment[]>();
  for (const c of due) byTenant.set(c.tenantId, [...(byTenant.get(c.tenantId) ?? []), c]);
  for (const [tenantId, rows] of byTenant) {
    try {
      await reconcileTenantRows(tenantId, rows, deps, db, now, result);
    } catch (error) {
      result.errors++;
      console.error(`[spend] reconcile failed for one workspace: ${describeError(error)}`);
    }
  }

  // Orphans: workspaces with DB-active campaigns.
  const tenants = ((await db.adCampaign.findMany({ where: { status: "active" }, select: { tenantId: true }, take: 2_000 })) ?? []) as { tenantId: string }[];
  // A rotating window, so every workspace is looked at in turn (the book already counts orphans meanwhile).
  const all = [...new Set(tenants.map((t) => t.tenantId))].sort();
  const take = Math.max(0, deps.orphanTenants ?? 20);
  if (orphanCursor >= all.length) orphanCursor = 0;
  const unique = all.slice(orphanCursor, orphanCursor + take);
  orphanCursor += take;
  for (const tenantId of unique) {
    try {
      await adoptOrphans(tenantId, deps, db, now, result);
    } catch (error) {
      result.errors++;
      console.error(`[spend] orphan adoption failed for one workspace: ${describeError(error)}`);
    }
  }
  return result;
}

async function reconcileTenantRows(tenantId: string, rows: BookCommitment[], deps: ReconcileDeps, db: SpendDb & Partial<SpendLockClient>, now: Date, result: ReconcileResult): Promise<void> {
  const control = await getControl(tenantId, { db, prune: false });
  const accounts = new Map((await loadAdAccounts(tenantId, control, db)).map((a) => [a.assetId, a]));
  const reader = makeReader(deps, accounts);
  // Reads first, with no lock held (I10).
  const seen: { row: BookCommitment; obs: Observation }[] = [];
  for (const row of rows) {
    result.checked++;
    const obs = await reader(tenantId, row.adAccountAssetId, row.metaObjectId);
    if (obs === "skip") result.skipped++;
    else if (obs === "unreachable") result.unreachable++;
    else seen.push({ row, obs });
  }
  if (seen.length === 0) return;
  // Bookkeeping under the lock, each update conditional on the row being unchanged since it was read.
  const applied = await withSpendLock(
    tenantId,
    "ads",
    async (tx) => {
      const out: { row: BookCommitment; obs: Observation }[] = [];
      for (const s of seen) {
        const data = s.obs.state === "live" ? liveData(s.row, s.obs.read, now) : { status: "stopped", reservedUntil: null, pendingFromMinor: null };
        const { count } = await tx.spendCommitment.updateMany({ where: { id: s.row.id!, version: s.row.version, status: { in: ["reserved", "unconfirmed"] } }, data: { ...data, version: { increment: 1 } } });
        if (count === 1) out.push(s);
      }
      return out;
    },
    lockOpts(db),
  );
  for (const { row, obs } of applied) {
    if (obs.state === "live") result.live++;
    else result.stopped++;
    const reason = obs.state === "live" ? "Checked on Meta: it is running, so it stays counted at its budget." : "Checked on Meta: it is not running, so it no longer counts against your limits.";
    const ledgerRow = {
      tenantId,
      pot: "ads" as const,
      actor: SYSTEM,
      reason,
      reasonCodes: [obs.state, row.status],
      targetType: row.objectLevel,
      targetId: row.adSetId ?? row.campaignId,
      metaObjectId: row.metaObjectId,
      currency: row.currency,
      before: { status: row.status, dailyBudgetMinor: row.dailyBudgetMinor, endsAt: row.endsAt },
      after: { status: obs.state, dailyBudgetMinor: obs.read.dailyBudgetMinor, lifetimeBudgetMinor: obs.read.lifetimeBudgetMinor, endsAt: obs.read.endsAt, effectiveStatus: obs.read.effectiveStatus },
      sandbox: row.sandbox,
    };
    if (row.correlationId) {
      const request = (await db.spendLedger.findFirst({ where: { tenantId, correlationId: row.correlationId, phase: "requested" }, select: { action: true } })) as { action?: string } | null;
      await appendOutcome(row.correlationId, { ...ledgerRow, action: request?.action ?? "ads.commitment.reconciled", phase: "reconciled" }, { db: ledgerDb(db) });
    } else {
      await appendStandalone({ ...ledgerRow, action: "ads.commitment.reconciled", phase: "reconciled" }, { db: ledgerDb(db) });
    }
    if (obs.parentPaused || (row.objectLevel === "campaign" && obs.state === "stopped")) {
      const status = obs.read.status === "ARCHIVED" || obs.read.effectiveStatus === "ARCHIVED" ? "archived" : "paused";
      if (await correctCampaign(db, tenantId, row.campaignId, status, row.metaObjectId)) result.campaignsCorrected++;
    }
  }
}

type OrphanFrom = "meta" | "db" | "stopped";

const ORPHAN_REASON: Record<OrphanFrom, string> = {
  meta: "A running campaign had no amount set aside for it; it now counts at the budget Meta reports.",
  db: "A running campaign had no amount set aside for it; it now counts at its budget in Edwyz.",
  stopped: "Checked on Meta: this ad set is not running, so it no longer counts against your limits.",
};

async function adoptOrphans(tenantId: string, deps: ReconcileDeps, db: SpendDb & Partial<SpendLockClient>, now: Date, result: ReconcileResult): Promise<void> {
  const control = await getControl(tenantId, { db, prune: false });
  const accountsList = await loadAdAccounts(tenantId, control, db);
  const open = (((await db.spendCommitment.findMany({ where: { tenantId, status: { in: [...OPEN_STATUSES] } } })) ?? []) as Record<string, unknown>[]).map(toBookCommitment);
  const orphans = await loadOrphans(tenantId, open, accountsList, control, now, db);
  if (orphans.length === 0) return;
  const reader = makeReader(deps, new Map(accountsList.map((a) => [a.assetId, a])));
  const toStore: { c: BookCommitment; from: OrphanFrom }[] = [];
  const pausedCampaigns = new Map<string, { status: "paused" | "archived"; metaObjectId: string }>();
  for (const orphan of orphans) {
    const obs = await reader(tenantId, orphan.adAccountAssetId, orphan.metaObjectId);
    if (obs === "skip" || obs === "unreachable") {
      // Cannot read Meta: store it at the DB budget, so it stays counted even after the DB changes (4.6).
      toStore.push({ c: orphan, from: "db" });
    } else if (obs.state === "live") {
      const data = liveData(orphan, obs.read, now);
      const c = { ...orphan, dailyBudgetMinor: data.dailyBudgetMinor, lifetimeBudgetMinor: data.lifetimeBudgetMinor, endsAt: data.endsAt, peakDailyBudgetMinor: data.peakDailyBudgetMinor, weekPeakDailyBudgetMinor: data.weekPeakDailyBudgetMinor };
      toStore.push({ c, from: "meta" });
    } else if (obs.parentPaused || orphan.objectLevel === "campaign") {
      pausedCampaigns.set(orphan.campaignId, { status: obs.read.status === "ARCHIVED" || obs.read.effectiveStatus === "ARCHIVED" ? "archived" : "paused", metaObjectId: orphan.metaObjectId });
    } else {
      // An ad set that is not running under a running campaign: a stopped row records that, so it is no longer an orphan.
      toStore.push({ c: { ...orphan, status: "stopped" }, from: "stopped" });
    }
  }
  const created =
    toStore.length === 0
      ? []
      : await withSpendLock(
          tenantId,
          "ads",
          async (tx) => {
            const out: { c: BookCommitment; from: OrphanFrom }[] = [];
            for (const s of toStore) {
              // Re-checked under the lock: a reservation made since the read already covers this object.
              const covered = await tx.spendCommitment.findFirst({ where: { tenantId, metaObjectId: s.c.metaObjectId, status: { in: [...OPEN_STATUSES] } }, select: { id: true } });
              if (covered) continue;
              const { count } = await tx.spendCommitment.createMany({ data: [orphanRow(tenantId, s.c, s.from === "stopped" ? "stopped" : "live")], skipDuplicates: true });
              if (count === 1) out.push(s);
            }
            return out;
          },
          lockOpts(db),
        );
  for (const { c, from } of created) {
    if (from === "stopped") result.orphansStopped++;
    else result.orphansAdopted++;
    await appendStandalone(
      {
        tenantId,
        pot: "ads",
        action: "ads.commitment.reconciled",
        phase: "reconciled",
        actor: SYSTEM,
        reason: ORPHAN_REASON[from],
        reasonCodes: ["orphan", from],
        targetType: c.objectLevel,
        targetId: c.adSetId ?? c.campaignId,
        metaObjectId: c.metaObjectId,
        currency: c.currency,
        after: { status: from === "stopped" ? "stopped" : "live", dailyBudgetMinor: c.dailyBudgetMinor, lifetimeBudgetMinor: c.lifetimeBudgetMinor, endsAt: c.endsAt },
        sandbox: c.sandbox,
      },
      { db: ledgerDb(db) },
    );
  }
  for (const [campaignId, p] of pausedCampaigns) if (await correctCampaign(db, tenantId, campaignId, p.status, p.metaObjectId)) result.campaignsCorrected++;
}
