/**
 * Ads commitments: what running and reserved ads could still spend (docs/SPEND-CONTROLS-SPEC.md 4.5, 4.6, invariants I3, I4).
 *
 * A SpendCommitment row holds one budget-holding Meta object (an ad set, or a campaign with a campaign budget) while it is
 * `reserved`, `live` or `unconfirmed`. It counts at its WORST CASE, never at the nominal budget:
 * - dayRisk = max(0, ceil175(peakToday) - spentToday), because Meta may spend 75% over a daily budget and its rule uses the
 *   day's highest budget (so a mid-day cut does not lower today's worst case);
 * - remainingMonth walks the account-time-zone days from today to the end date or month end with the 1.75x day cap and the
 *   7x (Sunday to Saturday) week cap, minus what was already spent, capped by what is left of a lifetime budget;
 * - a lifetime-only commitment can spend its whole remainder today; budget sharing uses 2.1x and 8.4x.
 *
 * This module also loads the ads side of the book for one workspace: the open commitments, synthetic commitments for DB-active
 * campaigns that have none (orphans: a late backfill, a crash between the DB write and the commitment write), SpendDaily
 * spend, Meta's limit and data freshness, and turns them into the headroom figures of 4.6. Reads only; the writers are book.ts
 * and reconcile.ts. No network.
 *
 * The worst-case maths itself lives in worstcase.ts (pure, property-tested). It is re-exported here so the book, the
 * reconciler and the tests keep one import, and there is exactly one copy of the rules.
 */
import { prisma } from "@/lib/db";
import { getControl, type SpendControlState, type SpendDb } from "./control";
import { spendCapMode } from "./flags";
import { isCurrencyCode } from "./money";
import { addDays, compareDays, dateToDayKey, dayKey, dayKeyToDate, resolveTimeZone, weekStartOfDay } from "./periods";
import type { MetaSpendLimitMode } from "./types";
import { dayRisk, externalRisk, hasEnded, remainingMonth, type CommitmentMath, type CommitmentSpend } from "./worstcase";

export {
  ceil175,
  ceil210,
  dayCap,
  dayRisk,
  ENDED_GRACE_MS,
  externalRisk,
  hasEnded,
  remainingMonth,
  weekCap,
  withBudgetChange,
  type CommitmentMath,
  type CommitmentSpend,
} from "./worstcase";

type Env = Record<string, string | undefined>;

/** No fast sync for this long: today's spend of each commitment is treated as unknown (4.6, 4.16). */
export const STALE_SYNC_MS = 60 * 60_000;
/** Open commitment statuses: they count. */
export const OPEN_STATUSES = ["reserved", "live", "unconfirmed"] as const;
export type CommitmentStatus = (typeof OPEN_STATUSES)[number] | "stopped";

const max0 = (x: bigint): bigint => (x < 0n ? 0n : x);
const maxB = (a: bigint, b: bigint): bigint => (a > b ? a : b);

// =====================================================================================================================
// Rows
// =====================================================================================================================

/** One commitment as the book reasons about it: a stored row, or a synthetic one (an orphan, or a new one being simulated). */
export type BookCommitment = {
  id: string | null;
  /** Not stored yet: an orphan DB-active campaign (4.6), or a commitment a simulation adds. */
  synthetic: boolean;
  tenantId: string;
  adAccountAssetId: string;
  campaignId: string;
  adSetId: string | null;
  metaObjectId: string;
  objectLevel: "campaign" | "adset";
  origin: string;
  assistantKey: string | null;
  currency: string;
  timezone: string;
  dailyBudgetMinor: bigint | null;
  lifetimeBudgetMinor: bigint | null;
  pendingFromMinor: bigint | null;
  dayKey: string | null;
  dayStartBudgetMinor: bigint | null;
  peakDailyBudgetMinor: bigint;
  weekStart: string | null;
  weekPeakDailyBudgetMinor: bigint;
  startsAt: Date | null;
  endsAt: Date | null;
  status: CommitmentStatus;
  reservedUntil: Date | null;
  correlationId: string | null;
  sandbox: boolean;
  version: number;
  updatedAt: Date | null;
  sharing?: boolean;
};

const big = (v: unknown): bigint | null => (v === null || v === undefined ? null : typeof v === "bigint" ? v : BigInt(v as number | string));
const date = (v: unknown): Date | null => (v instanceof Date ? v : v ? new Date(String(v)) : null);
const dayOf = (v: unknown): string | null => {
  const d = date(v);
  return d && !Number.isNaN(d.getTime()) ? dateToDayKey(d) : null;
};

export function toBookCommitment(raw: Record<string, unknown>): BookCommitment {
  const status = String(raw.status);
  return {
    id: String(raw.id),
    synthetic: false,
    tenantId: String(raw.tenantId),
    adAccountAssetId: String(raw.adAccountAssetId),
    campaignId: String(raw.campaignId),
    adSetId: (raw.adSetId as string | null) ?? null,
    metaObjectId: String(raw.metaObjectId),
    objectLevel: raw.objectLevel === "campaign" ? "campaign" : "adset",
    origin: String(raw.origin ?? "human"),
    assistantKey: (raw.assistantKey as string | null) ?? null,
    currency: String(raw.currency),
    timezone: resolveTimeZone(raw.timezone as string | null),
    dailyBudgetMinor: big(raw.dailyBudgetMinor),
    lifetimeBudgetMinor: big(raw.lifetimeBudgetMinor),
    pendingFromMinor: big(raw.pendingFromMinor),
    dayKey: dayOf(raw.dayKey),
    dayStartBudgetMinor: big(raw.dayStartBudgetMinor),
    peakDailyBudgetMinor: big(raw.peakDailyBudgetMinor) ?? 0n,
    weekStart: dayOf(raw.weekStart),
    weekPeakDailyBudgetMinor: big(raw.weekPeakDailyBudgetMinor) ?? 0n,
    startsAt: date(raw.startsAt),
    endsAt: date(raw.endsAt),
    status: (["reserved", "live", "unconfirmed", "stopped"].includes(status) ? status : "live") as CommitmentStatus,
    reservedUntil: date(raw.reservedUntil),
    correlationId: (raw.correlationId as string | null) ?? null,
    sandbox: raw.sandbox === true,
    version: Number(raw.version ?? 1),
    updatedAt: date(raw.updatedAt),
  };
}

/** Peaks rolled to the account day and week of `now`: a new day starts at the current budget, so does a new week. */
export function rolledPeaks(c: Pick<BookCommitment, "dailyBudgetMinor" | "dayKey" | "peakDailyBudgetMinor" | "weekStart" | "weekPeakDailyBudgetMinor" | "timezone">, now: Date): { today: string; week: string; peakToday: bigint; weekPeak: bigint } {
  const today = dayKey(now, c.timezone);
  const week = weekStartOfDay(today);
  const d = c.dailyBudgetMinor ?? 0n;
  const peakToday = c.dayKey === today ? maxB(c.peakDailyBudgetMinor, d) : d;
  const weekPeak = c.weekStart === week ? maxB(c.weekPeakDailyBudgetMinor, d) : d;
  return { today, week, peakToday, weekPeak };
}

export function toMath(c: BookCommitment, now: Date): CommitmentMath {
  const p = rolledPeaks(c, now);
  return { dailyBudgetMinor: c.dailyBudgetMinor, lifetimeBudgetMinor: c.lifetimeBudgetMinor, peakToday: p.peakToday, weekPeak: p.weekPeak, endsAt: c.endsAt, sharing: c.sharing };
}

// =====================================================================================================================
// Meta's limit: what "managed" means (5.1)
// =====================================================================================================================

export type MetaLimitRow = {
  adAccountAssetId: string;
  tenantId: string;
  accountExternalId: string;
  mode: MetaSpendLimitMode;
  unitMode: string;
  semantics: string;
  managedCapMinor: bigint | null;
  lastReadCapMinor: bigint | null;
  lastReadAmountSpentMinor: bigint | null;
  lastReadAt: Date | null;
  lastWriteAt: Date | null;
  lastError: string | null;
  currency: string | null;
  timezone: string | null;
};

export function toMetaLimitRow(raw: Record<string, unknown>): MetaLimitRow {
  return {
    adAccountAssetId: String(raw.adAccountAssetId),
    tenantId: String(raw.tenantId),
    accountExternalId: String(raw.accountExternalId ?? ""),
    mode: String(raw.mode ?? "off") as MetaSpendLimitMode,
    unitMode: String(raw.unitMode ?? "unverified"),
    semantics: String(raw.semantics ?? "unverified"),
    managedCapMinor: big(raw.managedCapMinor),
    lastReadCapMinor: big(raw.lastReadCapMinor),
    lastReadAmountSpentMinor: big(raw.lastReadAmountSpentMinor),
    lastReadAt: date(raw.lastReadAt),
    lastWriteAt: date(raw.lastWriteAt),
    lastError: (raw.lastError as string | null) ?? null,
    currency: (raw.currency as string | null) ?? null,
    timezone: (raw.timezone as string | null) ?? null,
  };
}

/**
 * Managed in the 5.1 sense: mode `managed`, SPEND_CAP_MODE=enforce, a verified unit mode, and a last write that was read back
 * (a read at or after the last write, with no error since). Only then is outside spend counted, the Meta-room check run and
 * an assistant's raise eligible for automatic approval.
 */
export function isMetaLimitManaged(row: MetaLimitRow | null | undefined, env: Env = process.env): boolean {
  if (!row || row.mode !== "managed") return false;
  if (spendCapMode(env) !== "enforce") return false;
  if (row.unitMode === "unverified") return false;
  if (!row.lastWriteAt || !row.lastReadAt || row.lastReadAt.getTime() < row.lastWriteAt.getTime()) return false;
  return row.lastError === null && row.managedCapMinor !== null;
}

// =====================================================================================================================
// Loading the ads book of one workspace
// =====================================================================================================================

export type AdAccountInfo = {
  assetId: string;
  externalId: string;
  name: string | null;
  currency: string | null;
  timezone: string;
  sandbox: boolean;
  active: boolean;
  demo: boolean;
};

export type SpendDailyRow = { scopeType: string; scopeId: string; day: string; currency: string; amountMinor: bigint; origin: string; source: string; syncedAt: Date | null };

export type CampaignLite = {
  id: string;
  adAccountAssetId: string;
  metaCampaignId: string | null;
  name: string;
  status: string;
  dailyBudgetMinor: bigint;
  lifetimeBudgetMinor: bigint | null;
  currency: string;
  startsAt: Date | null;
  endsAt: Date | null;
  origin: string;
  assistantKey: string | null;
  sandbox: boolean;
  /** When the campaign row last changed (activation sets it). Null when unknown. */
  updatedAt?: Date | null;
};

/**
 * A stopped commitment of a DB-active campaign: Edwyz paused that ad set (or campaign) itself, or the reconciler read it as
 * stopped on Meta. While it is newer than the campaign's last change, the object is known not to run, so the orphan rule
 * leaves it out. A later change to the campaign (for example turning it on again) makes it count again until a commitment
 * or a fresh read says otherwise, which errs on the safe side.
 */
export type StoppedMark = { campaignId: string; adSetId: string | null; metaObjectId: string; objectLevel: "campaign" | "adset"; updatedAt: Date | null };
export type AdSetLite = { id: string; campaignId: string; metaAdSetId: string | null; status: string; dailyBudgetMinor: bigint | null; lifetimeBudgetMinor: bigint | null };

export type AdsBookState = {
  tenantId: string;
  now: Date;
  control: SpendControlState;
  accounts: AdAccountInfo[];
  spendingAccount: AdAccountInfo | null;
  /** Stored open commitments (reserved, live, unconfirmed), in every currency. */
  commitments: BookCommitment[];
  /** Stopped commitments of DB-active campaigns (see StoppedMark). */
  stoppedMarks: StoppedMark[];
  /** Synthetic live commitments for DB-active campaigns and ad sets with no open commitment (4.6). */
  orphans: BookCommitment[];
  daily: SpendDailyRow[];
  metaLimits: MetaLimitRow[];
  /** The newest SpendDaily sync of the workspace's ads rows. */
  lastSyncAt: Date | null;
  /** No fast sync for 60 minutes (or none at all): today's spend of each commitment is unknown. */
  stale: boolean;
  /** Meta ids of the objects on managed accounts (their platform rows are inside the account row, so never added twice). */
  managedObjectIds: Set<string>;
};

export type LoadAdsBookOptions = { db?: SpendDb; now?: Date; env?: Env; control?: SpendControlState };

function accountTimezone(meta: unknown, fallback: string): string {
  const tz = meta && typeof meta === "object" ? (meta as { timezone?: unknown }).timezone : undefined;
  return typeof tz === "string" ? resolveTimeZone(tz) : resolveTimeZone(fallback);
}

function accountCurrency(meta: unknown): string | null {
  const cur = meta && typeof meta === "object" ? (meta as { currency?: unknown }).currency : undefined;
  return isCurrencyCode(cur) ? cur : null;
}

/** The workspace's ad accounts (MetaAsset type ad_account) as the book needs them. */
export async function loadAdAccounts(tenantId: string, control: SpendControlState, db: SpendDb = prisma): Promise<AdAccountInfo[]> {
  const rows = ((await db.metaAsset.findMany({
    where: { tenantId, type: "ad_account" },
    select: { id: true, externalId: true, name: true, meta: true, sandbox: true, status: true },
    take: 50,
  })) ?? []) as { id: string; externalId: string; name: string | null; meta: unknown; sandbox?: boolean; status?: string }[];
  return rows.map((r) => ({
    assetId: r.id,
    externalId: r.externalId,
    name: r.name ?? null,
    currency: accountCurrency(r.meta),
    timezone: accountTimezone(r.meta, control.timezone),
    sandbox: r.sandbox === true,
    active: (r.status ?? "active") === "active",
    demo: !!r.meta && typeof r.meta === "object" && (r.meta as { demo?: unknown }).demo === true,
  }));
}

/** An orphan's Meta id when the DB has none yet (never sent to Meta; it cannot be read, only counted). */
export const syntheticMetaId = (kind: "adset" | "campaign", id: string): string => `db:${kind}:${id}`;
export const isSyntheticMetaId = (metaObjectId: string): boolean => metaObjectId.startsWith("db:");

export const toLiteCampaign = (r: Record<string, unknown>): CampaignLite => ({
  id: String(r.id),
  adAccountAssetId: String(r.adAccountAssetId),
  metaCampaignId: (r.metaCampaignId as string | null) ?? null,
  name: String(r.name ?? ""),
  status: String(r.status),
  dailyBudgetMinor: big(r.dailyBudgetMinor) ?? 0n,
  lifetimeBudgetMinor: big(r.lifetimeBudgetMinor),
  currency: String(r.currency ?? "INR"),
  startsAt: date(r.startsAt),
  endsAt: date(r.endsAt),
  origin: String(r.origin ?? "human"),
  assistantKey: (r.assistantKey as string | null) ?? null,
  sandbox: r.sandbox === true,
  updatedAt: date(r.updatedAt),
});

export const toLiteAdSet = (r: Record<string, unknown>): AdSetLite => ({
  id: String(r.id),
  campaignId: String(r.campaignId),
  metaAdSetId: (r.metaAdSetId as string | null) ?? null,
  status: String(r.status ?? "active"),
  dailyBudgetMinor: big(r.dailyBudgetMinor),
  lifetimeBudgetMinor: big(r.lifetimeBudgetMinor),
});

const DEAD_ADSET_STATUSES = new Set(["archived", "deleted"]);

/** A live commitment built from DB values (orphans, the backfill, the reconciler's fallback). */
export function commitmentFromDb(
  c: CampaignLite,
  set: AdSetLite | null,
  account: Pick<AdAccountInfo, "timezone" | "sandbox"> | null,
  now: Date,
  fallbackTimezone: string,
): BookCommitment {
  const tz = resolveTimeZone(account?.timezone ?? fallbackTimezone);
  const today = dayKey(now, tz);
  // The ad set's own budget, else the campaign's (as today's caps.ts reads it).
  // An ad set with its own lifetime budget and no daily budget is lifetime-only (its whole remainder can land today, 4.5).
  const lifetime = set ? (set.lifetimeBudgetMinor ?? c.lifetimeBudgetMinor) : c.lifetimeBudgetMinor;
  let daily: bigint | null;
  if (set && set.dailyBudgetMinor !== null) daily = set.dailyBudgetMinor;
  else if (set && set.lifetimeBudgetMinor !== null) daily = null;
  else daily = c.dailyBudgetMinor > 0n || lifetime === null ? c.dailyBudgetMinor : null;
  const d = daily ?? 0n;
  const metaObjectId = set ? (set.metaAdSetId ?? syntheticMetaId("adset", set.id)) : (c.metaCampaignId ?? syntheticMetaId("campaign", c.id));
  return {
    id: null,
    synthetic: true,
    tenantId: "",
    adAccountAssetId: c.adAccountAssetId,
    campaignId: c.id,
    adSetId: set?.id ?? null,
    metaObjectId,
    objectLevel: set ? "adset" : "campaign",
    origin: ["human", "assistant", "api"].includes(c.origin) ? c.origin : "human",
    assistantKey: c.assistantKey,
    currency: c.currency,
    timezone: tz,
    dailyBudgetMinor: daily,
    lifetimeBudgetMinor: lifetime,
    pendingFromMinor: null,
    dayKey: today,
    dayStartBudgetMinor: d,
    peakDailyBudgetMinor: d,
    weekStart: weekStartOfDay(today),
    weekPeakDailyBudgetMinor: d,
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    status: "live",
    reservedUntil: null,
    correlationId: null,
    sandbox: c.sandbox || account?.sandbox === true,
    version: 1,
    updatedAt: null,
  };
}

/** DB-active campaigns and their ad sets of one workspace (optionally one campaign). */
export async function loadActiveCampaigns(tenantId: string, db: SpendDb = prisma, filter: { campaignIds?: string[]; adAccountAssetId?: string } = {}): Promise<{ campaigns: CampaignLite[]; adSets: AdSetLite[] }> {
  const where: Record<string, unknown> = { tenantId, status: "active" };
  if (filter.campaignIds) where.id = { in: filter.campaignIds };
  if (filter.adAccountAssetId) where.adAccountAssetId = filter.adAccountAssetId;
  const campaigns = (((await db.adCampaign.findMany({
    where: where as never,
    select: { id: true, adAccountAssetId: true, metaCampaignId: true, name: true, status: true, dailyBudgetMinor: true, lifetimeBudgetMinor: true, currency: true, startsAt: true, endsAt: true, origin: true, assistantKey: true, sandbox: true, updatedAt: true },
    take: 500,
  })) ?? []) as Record<string, unknown>[]).map(toLiteCampaign);
  if (campaigns.length === 0) return { campaigns, adSets: [] };
  const adSets = (((await db.adSet.findMany({
    where: { tenantId, campaignId: { in: campaigns.map((c) => c.id) } },
    select: { id: true, campaignId: true, metaAdSetId: true, status: true, dailyBudgetMinor: true, lifetimeBudgetMinor: true },
  })) ?? []) as Record<string, unknown>[]).map(toLiteAdSet);
  return { campaigns, adSets };
}

/** Stopped commitments of the given campaigns (newest first), for the orphan rule. Bounded: at most 2,000 rows. */
export async function loadStoppedMarks(tenantId: string, campaignIds: string[], db: SpendDb = prisma): Promise<StoppedMark[]> {
  if (campaignIds.length === 0) return [];
  const rows = ((await db.spendCommitment.findMany({
    where: { tenantId, status: "stopped", campaignId: { in: campaignIds } },
    select: { campaignId: true, adSetId: true, metaObjectId: true, objectLevel: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
    take: 2_000,
  })) ?? []) as Record<string, unknown>[];
  return rows.map((r) => ({
    campaignId: String(r.campaignId),
    adSetId: (r.adSetId as string | null) ?? null,
    metaObjectId: String(r.metaObjectId),
    objectLevel: r.objectLevel === "campaign" ? "campaign" : "adset",
    updatedAt: date(r.updatedAt),
  }));
}

/** True when a stopped mark says this object of the campaign is not running since the campaign last changed. */
function knownStopped(c: CampaignLite, set: AdSetLite | null, marks: StoppedMark[]): boolean {
  if (!c.updatedAt) return false;
  const since = c.updatedAt.getTime();
  return marks.some((m) => {
    if (m.campaignId !== c.id || !m.updatedAt || m.updatedAt.getTime() < since) return false;
    if (!set) return m.objectLevel === "campaign" || (!!c.metaCampaignId && m.metaObjectId === c.metaCampaignId);
    return m.adSetId === set.id || (!!set.metaAdSetId && m.metaObjectId === set.metaAdSetId);
  });
}

/**
 * Synthetic live commitments for every DB-active campaign (and every ad set under it that is not archived) that has no open
 * commitment, matched by ad set id, Meta id or campaign (4.6 orphan rule). Ended campaigns can no longer spend and are left
 * out, and so is an object whose commitment was stopped after the campaign last changed (`stopped`, see StoppedMark): an ad
 * set a person or a breaker paused must not come back as an orphan while its campaign keeps running.
 */
export function orphanCommitments(
  campaigns: CampaignLite[],
  adSets: AdSetLite[],
  open: BookCommitment[],
  accounts: AdAccountInfo[],
  now: Date,
  fallbackTimezone: string,
  stopped: StoppedMark[] = [],
): BookCommitment[] {
  const byAdSet = new Set(open.map((c) => c.adSetId).filter((x): x is string => !!x));
  const byMeta = new Set(open.map((c) => c.metaObjectId));
  const byCampaign = new Set(open.map((c) => c.campaignId));
  const out: BookCommitment[] = [];
  for (const c of campaigns) {
    if (hasEnded(c, now)) continue;
    const account = accounts.find((a) => a.assetId === c.adAccountAssetId) ?? null;
    const sets = adSets.filter((s) => s.campaignId === c.id && !DEAD_ADSET_STATUSES.has(s.status));
    if (sets.length === 0) {
      if (byCampaign.has(c.id) || (c.metaCampaignId && byMeta.has(c.metaCampaignId))) continue;
      if (knownStopped(c, null, stopped)) continue;
      out.push(commitmentFromDb(c, null, account, now, fallbackTimezone));
      continue;
    }
    // The whole campaign was stopped (campaign level) since it last changed: none of its ad sets runs.
    if (!byCampaign.has(c.id) && knownStopped(c, null, stopped)) continue;
    for (const s of sets) {
      if (byAdSet.has(s.id) || (s.metaAdSetId && byMeta.has(s.metaAdSetId))) continue;
      // A campaign-level commitment covers its ad sets (campaign budget).
      if (open.some((o) => o.objectLevel === "campaign" && o.campaignId === c.id)) continue;
      if (knownStopped(c, s, stopped)) continue;
      out.push(commitmentFromDb(c, s, account, now, fallbackTimezone));
    }
  }
  return out;
}

/** The orphans of one workspace from the database: active campaigns, their ad sets, open commitments and stopped marks. */
export async function loadOrphans(tenantId: string, open: BookCommitment[], accounts: AdAccountInfo[], control: Pick<SpendControlState, "timezone">, now: Date, db: SpendDb = prisma): Promise<BookCommitment[]> {
  const { campaigns, adSets } = await loadActiveCampaigns(tenantId, db);
  if (campaigns.length === 0) return [];
  const stopped = await loadStoppedMarks(tenantId, campaigns.map((c) => c.id), db);
  return orphanCommitments(campaigns, adSets, open, accounts, now, control.timezone, stopped).map((o) => ({ ...o, tenantId }));
}

const ADS_SPEND_SOURCES_FOR_FRESHNESS = new Set(["fast_sync", "sim"]);

/** Loads the ads side of the book for one workspace (read only). */
export async function loadAdsBook(tenantId: string, opts: LoadAdsBookOptions = {}): Promise<AdsBookState> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const control = opts.control ?? (await getControl(tenantId, { db, prune: false }));
  const accounts = await loadAdAccounts(tenantId, control, db);
  const spendingAccount = accounts.find((a) => a.assetId === control.spendingAdAccountAssetId) ?? null;
  const commitments = (((await db.spendCommitment.findMany({ where: { tenantId, status: { in: [...OPEN_STATUSES] } } })) ?? []) as Record<string, unknown>[]).map(toBookCommitment);
  const { campaigns, adSets } = await loadActiveCampaigns(tenantId, db);
  const stoppedMarks = await loadStoppedMarks(tenantId, campaigns.map((c) => c.id), db);
  const orphans = orphanCommitments(campaigns, adSets, commitments, accounts, now, control.timezone, stoppedMarks).map((o) => ({ ...o, tenantId }));

  // Enough history for the month, the current week (it may start in the previous month) and the 7-day outside-spend peak.
  const zones = new Set([control.timezone, ...accounts.map((a) => a.timezone), ...commitments.map((c) => c.timezone)]);
  let from = dayKey(now, control.timezone);
  for (const tz of zones) {
    const today = dayKey(now, tz);
    for (const d of [`${today.slice(0, 7)}-01`, weekStartOfDay(today), addDays(today, -8)]) if (compareDays(d, from) < 0) from = d;
  }
  const daily = (((await db.spendDaily.findMany({ where: { tenantId, pot: "ads", day: { gte: dayKeyToDate(from) } } })) ?? []) as Record<string, unknown>[]).map(
    (r): SpendDailyRow => ({
      scopeType: String(r.scopeType),
      scopeId: String(r.scopeId),
      day: dayOf(r.day) ?? "",
      currency: String(r.currency ?? ""),
      amountMinor: big(r.amountMinor) ?? 0n,
      origin: String(r.origin),
      source: String(r.source ?? ""),
      syncedAt: date(r.syncedAt),
    }),
  );
  const metaLimits = (((await db.metaSpendLimit.findMany({ where: { tenantId } })) ?? []) as Record<string, unknown>[]).map(toMetaLimitRow);

  let lastSyncAt: Date | null = null;
  for (const r of daily) {
    if (!r.syncedAt || !ADS_SPEND_SOURCES_FOR_FRESHNESS.has(r.source)) continue;
    if (!lastSyncAt || r.syncedAt.getTime() > lastSyncAt.getTime()) lastSyncAt = r.syncedAt;
  }
  const stale = !lastSyncAt || now.getTime() - lastSyncAt.getTime() > STALE_SYNC_MS;

  const managedIds = metaLimits.filter((m) => isMetaLimitManaged(m, env)).map((m) => m.adAccountAssetId);
  const managedObjectIds = new Set<string>();
  if (managedIds.length > 0) {
    for (const c of [...commitments, ...orphans]) if (managedIds.includes(c.adAccountAssetId)) managedObjectIds.add(c.metaObjectId);
    const own = ((await db.adCampaign.findMany({ where: { tenantId, adAccountAssetId: { in: managedIds } }, select: { id: true, metaCampaignId: true } })) ?? []) as { id: string; metaCampaignId: string | null }[];
    for (const c of own) if (c.metaCampaignId) managedObjectIds.add(c.metaCampaignId);
    if (own.length > 0) {
      const sets = ((await db.adSet.findMany({ where: { tenantId, campaignId: { in: own.map((c) => c.id) } }, select: { metaAdSetId: true } })) ?? []) as { metaAdSetId: string | null }[];
      for (const s of sets) if (s.metaAdSetId) managedObjectIds.add(s.metaAdSetId);
    }
  }

  return { tenantId, now, control, accounts, spendingAccount, commitments, stoppedMarks, orphans, daily, metaLimits, lastSyncAt, stale, managedObjectIds };
}

// =====================================================================================================================
// Figures (4.6)
// =====================================================================================================================

export type CommitmentFigure = {
  metaObjectId: string;
  campaignId: string;
  adAccountAssetId: string;
  status: CommitmentStatus;
  synthetic: boolean;
  origin: string;
  assistantKey: string | null;
  dayRisk: bigint;
  remainingMonth: bigint;
  spentToday: bigint | null;
  /** This object's own spend this account month (platform rows). */
  spentMonth: bigint;
};

export type AdsFigures = {
  currency: string;
  spentToday: bigint;
  spentMonth: bigint;
  /** Σ dayRisk (+ outside day risk when counted). */
  committedToday: bigint;
  /** Σ remainingMonth (+ outside month risk when counted). */
  committedMonth: bigint;
  dayUse: bigint;
  monthUse: bigint;
  external: { counted: boolean; spentMonth: bigint; spentToday: bigint; riskMonth: bigint; riskToday: bigint; estimated: true };
  stale: boolean;
  perCommitment: CommitmentFigure[];
  /** Grandfathered commitments in another currency: listed under the pot, never added to it (3.1). */
  otherCurrency: { adAccountAssetId: string; currency: string; couldAddThisMonth: bigint }[];
  /** Per ad account: Meta's limit room and the day risk on that account (the Meta-room check, 4.6 step 8). */
  accounts: { adAccountAssetId: string; managed: boolean; dayRisk: bigint; metaRoom: bigint | null }[];
};

function seriesOf(rows: SpendDailyRow[], predicate: (r: SpendDailyRow) => boolean): Map<string, bigint> {
  const m = new Map<string, bigint>();
  for (const r of rows) if (predicate(r)) m.set(r.day, (m.get(r.day) ?? 0n) + r.amountMinor);
  return m;
}

const sumWhere = (series: ReadonlyMap<string, bigint>, keep: (day: string) => boolean): bigint => {
  let s = 0n;
  for (const [d, v] of series) if (keep(d)) s += v;
  return s;
};

const accountScopeIds = (a: AdAccountInfo): string[] => [a.assetId, a.externalId, a.externalId.replace(/^act_/, ""), `act_${a.externalId.replace(/^act_/, "")}`];

/**
 * The ads figures of 4.6 for the given commitments (stored, orphans and simulated) in the pot currency.
 * - Counted spend: the account row (origin all) on a managed account; otherwise the platform ad set and campaign rows.
 * - committed = Σ remainingMonth + outside risk when counted; dayUse = spentToday + Σ dayRisk (+ outside day risk);
 *   monthUse = spentMonth + committed.
 * - Stale data: each commitment's spend today is unknown, so its day risk is the full ceil175(peakToday).
 */
export function computeAdsFigures(state: AdsBookState, commitments: BookCommitment[], currency: string, env: Env = process.env): AdsFigures {
  const now = state.now;
  const potTz = state.spendingAccount?.timezone ?? state.control.timezone;
  const managed = new Map(state.metaLimits.map((m) => [m.adAccountAssetId, isMetaLimitManaged(m, env)]));
  const isManaged = (assetId: string) => managed.get(assetId) === true;
  const inPot = (c: BookCommitment) => c.currency === currency;

  const perCommitment: CommitmentFigure[] = [];
  const otherCurrency = new Map<string, { adAccountAssetId: string; currency: string; couldAddThisMonth: bigint }>();
  const accountRisk = new Map<string, bigint>();
  let committedToday = 0n;
  let committedMonth = 0n;
  for (const c of commitments) {
    if (c.status === "stopped") continue;
    const tz = c.timezone;
    const today = dayKey(now, tz);
    const byDay = seriesOf(state.daily, (r) => r.origin === "platform" && (r.scopeType === "adset" || r.scopeType === "campaign") && r.scopeId === c.metaObjectId);
    const lifetime = sumWhere(byDay, () => true);
    const spend: CommitmentSpend = { byDay, lifetime, today: state.stale ? null : (byDay.get(today) ?? 0n) };
    const math = toMath(c, now);
    const dr = dayRisk(math, spend, now);
    const rm = remainingMonth(math, now, tz, spend);
    if (!inPot(c)) {
      const key = `${c.adAccountAssetId}:${c.currency}`;
      const prev = otherCurrency.get(key);
      otherCurrency.set(key, { adAccountAssetId: c.adAccountAssetId, currency: c.currency, couldAddThisMonth: (prev?.couldAddThisMonth ?? 0n) + rm });
      continue;
    }
    const ownMonth = sumWhere(byDay, (d) => d.slice(0, 7) === today.slice(0, 7) && compareDays(d, today) <= 0);
    perCommitment.push({
      metaObjectId: c.metaObjectId,
      campaignId: c.campaignId,
      adAccountAssetId: c.adAccountAssetId,
      status: c.status,
      synthetic: c.synthetic,
      origin: c.origin,
      assistantKey: c.assistantKey,
      dayRisk: dr,
      remainingMonth: rm,
      spentToday: spend.today,
      spentMonth: ownMonth,
    });
    committedToday += dr;
    committedMonth += rm;
    accountRisk.set(c.adAccountAssetId, (accountRisk.get(c.adAccountAssetId) ?? 0n) + dr);
  }

  // Counted spend.
  let spentToday = 0n;
  let spentMonth = 0n;
  const potAccounts = state.accounts.filter((a) => (a.currency ?? currency) === currency);
  const managedAccounts = potAccounts.filter((a) => isManaged(a.assetId));
  for (const a of managedAccounts) {
    const ids = accountScopeIds(a);
    const series = seriesOf(state.daily, (r) => r.scopeType === "account" && r.origin === "all" && ids.includes(r.scopeId));
    const today = dayKey(now, a.timezone);
    spentToday += series.get(today) ?? 0n;
    spentMonth += sumWhere(series, (d) => d.slice(0, 7) === today.slice(0, 7) && compareDays(d, today) <= 0);
  }
  const platform = seriesOf(
    state.daily,
    (r) => r.origin === "platform" && (r.scopeType === "adset" || r.scopeType === "campaign") && (r.currency === "" || r.currency === currency) && !state.managedObjectIds.has(r.scopeId),
  );
  const potToday = dayKey(now, potTz);
  spentToday += platform.get(potToday) ?? 0n;
  spentMonth += sumWhere(platform, (d) => d.slice(0, 7) === potToday.slice(0, 7) && compareDays(d, potToday) <= 0);

  // Outside spend: counted only on managed accounts (decision 2.3.4); shown for information otherwise.
  // The figures shown are every pot account's outside spend; only managed accounts' risk is added to committed.
  let extSpentMonth = 0n;
  let extSpentToday = 0n;
  let extRiskMonth = 0n;
  let extRiskToday = 0n;
  const counted = managedAccounts.length > 0;
  for (const a of potAccounts) {
    const ids = accountScopeIds(a);
    const series = seriesOf(state.daily, (r) => r.scopeType === "account" && r.origin === "external" && ids.includes(r.scopeId));
    if (series.size === 0) continue;
    const today = dayKey(now, a.timezone);
    const risk = externalRisk(series, now, a.timezone);
    extSpentMonth += sumWhere(series, (d) => d.slice(0, 7) === today.slice(0, 7) && compareDays(d, today) <= 0);
    extSpentToday += risk.spentToday;
    extRiskMonth += risk.month;
    extRiskToday += risk.day;
    if (isManaged(a.assetId)) {
      committedMonth += risk.month;
      committedToday += risk.day;
      accountRisk.set(a.assetId, (accountRisk.get(a.assetId) ?? 0n) + risk.day);
    }
  }

  const accounts = state.accounts.map((a) => {
    const row = state.metaLimits.find((m) => m.adAccountAssetId === a.assetId) ?? null;
    const room = row && row.lastReadCapMinor !== null && row.lastReadCapMinor > 0n && row.lastReadAmountSpentMinor !== null ? max0(row.lastReadCapMinor - row.lastReadAmountSpentMinor) : null;
    return { adAccountAssetId: a.assetId, managed: isManaged(a.assetId), dayRisk: accountRisk.get(a.assetId) ?? 0n, metaRoom: room };
  });

  return {
    currency,
    spentToday,
    spentMonth,
    committedToday,
    committedMonth,
    dayUse: spentToday + committedToday,
    monthUse: spentMonth + committedMonth,
    external: { counted, spentMonth: extSpentMonth, spentToday: extSpentToday, riskMonth: extRiskMonth, riskToday: extRiskToday, estimated: true },
    stale: state.stale,
    perCommitment,
    otherCurrency: [...otherCurrency.values()],
    accounts,
  };
}

/** Every commitment the book counts now: the stored open ones plus the orphans. */
export function countedCommitments(state: AdsBookState): BookCommitment[] {
  return [...state.commitments, ...state.orphans];
}
