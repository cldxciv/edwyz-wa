/**
 * Wall (a), keeping Meta's limit in line (docs/SPEND-CONTROLS-SPEC.md 5.2, 5.3, 5.4, 5.6, 5.7, 4.17, 8.4).
 *
 * - Reads every 15 minutes for managed accounts with open commitments or spend this month, every 6 hours for the others,
 *   right before every write and right after it (client.ts), and before reserveAds takes its lock (ensureFreshRead, I10).
 * - Each read is stored. A lower amount_spent with no Edwyz write is used only when the next read agrees (read_drift). The
 *   account's time zone and currency are checked; prepaid accounts and currency mismatches stop the writes.
 * - Changes made outside Edwyz (5.6): a lower cap is adopted and never raised back automatically; a higher or removed cap is
 *   restored by P0. Near the wall the owner is told once a day. Counter and insights drift is flagged after 3 reads.
 * - Then the plan (plan.ts) runs and its write goes through client.ts. A rollover (new account month) resets the month's
 *   start values first. A write that reveals resets_on_write is followed at once by the P1 rewrite of R.
 * - A 409 from getAssetAccess opens meta_cap_unreachable while commitments are live and retries every 30 minutes. Demo
 *   assets are never read (8.4); sandbox accounts are mode `sandbox` and never written.
 */
import { prisma } from "@/lib/db";
import { enqueue as enqueueJob } from "@/lib/queue";
import { describeError } from "@/lib/safe-error";
import { tenantMayRunBackground } from "@/lib/tenant-state";
import { effectiveLimits } from "../allowances";
import { clearBreaker, openBreaker } from "../breakers/state";
import { ceil175, computeAdsFigures, countedCommitments, loadAdsBook } from "../commitments";
import { getControl } from "../control";
import { isDemoAsset } from "../demo";
import { spendCapMode } from "../flags";
import { convertFromInr, readFx } from "../fx";
import { appendStandalone, type LedgerDb } from "../ledger";
import { heldSpendLocks } from "../lock";
import { formatMinor, isCurrencyCode } from "../money";
import { notifySpend } from "../notify";
import { dayKey, dayKeyToDate, monthKey, monthStartDay, resolveTimeZone, startOfLocalMonth } from "../periods";
import { SPEND_QUEUES, type SpendActor, type SpendNotice } from "../types";
import {
  actPath,
  assetToken,
  loadAccountState,
  loadCapWrites,
  readCap,
  saveAccountState,
  settleUnconfirmed,
  writeCap,
  type AccountState,
  type CapRead,
  type CapWriteResult,
  type MetaCapDb,
  type MetaCapIo,
} from "./client";
import { offboardTenant } from "./offboard";
import { spendState } from "../kill";
import {
  budgetAllows,
  budgetFreesAt,
  changeBudget,
  nearWall,
  oneMajorUnit,
  planMetaCap,
  READ_ACTIVE_MS,
  READ_IDLE_MS,
  remainingMinor,
  spentThisMonth,
  THRESHOLD_FLOOR_INR_MINOR,
  thresholdMinor,
  toMetaCapRow,
  UNREACHABLE_RETRY_MS,
  type MetaCapRow,
  type PlanDecision,
  type PlanRequest,
} from "./plan";

const SYSTEM: SpendActor = { type: "system", job: "metacap" };
const EXTERNAL: SpendActor = { type: "external", source: "meta_spend_cap" };
const max0 = (x: bigint): bigint => (x < 0n ? 0n : x);
const abs = (x: bigint): bigint => (x < 0n ? -x : x);

export type SyncOptions = MetaCapIo & {
  request?: PlanRequest | null;
  /** Overrides the locked/suspended check (tests and callers that already know). */
  workspaceActive?: boolean;
  actor?: SpendActor;
};

export type SyncResult = {
  status: "skipped" | "read" | "planned" | "deferred" | "written" | "observed" | "failed" | "unreachable";
  reason?: string;
  decision?: PlanDecision;
  write?: CapWriteResult;
};

type Asset = { id: string; externalId: string; name: string | null; meta: unknown; sandbox?: boolean; status?: string };

function dbOf(io: MetaCapIo): MetaCapDb {
  return io.db ?? (prisma as unknown as MetaCapDb);
}

async function updateRow(db: MetaCapDb, adAccountAssetId: string, data: Record<string, unknown>): Promise<void> {
  await db.metaSpendLimit.update({ where: { adAccountAssetId }, data: { ...data, version: { increment: 1 } } as never });
}

async function loadRow(db: MetaCapDb, tenantId: string, adAccountAssetId: string): Promise<MetaCapRow | null> {
  const raw = (await db.metaSpendLimit.findUnique({ where: { adAccountAssetId } })) as Record<string, unknown> | null;
  return raw && String(raw.tenantId) === tenantId ? toMetaCapRow(raw) : null;
}

async function loadAsset(db: MetaCapDb, tenantId: string, adAccountAssetId: string): Promise<Asset | null> {
  return (await db.metaAsset.findFirst({ where: { id: adAccountAssetId, tenantId, type: "ad_account" } })) as Asset | null;
}

const assetTimezone = (asset: Asset | null, row: MetaCapRow | null, fallback: string): string => {
  const tz = asset?.meta && typeof asset.meta === "object" ? (asset.meta as { timezone?: unknown }).timezone : null;
  return resolveTimeZone((typeof tz === "string" ? tz : null) ?? row?.timezone ?? fallback);
};

const scopeIds = (assetId: string, externalId: string): string[] => {
  const bare = externalId.replace(/^act_/, "");
  return [assetId, externalId, bare, `act_${bare}`];
};

/** The account's month-to-date spend from the fast sync (SpendDaily account rows, origin all). Null before the first sync. */
export async function accountMonthToDate(db: MetaCapDb, tenantId: string, adAccountAssetId: string, externalId: string, now: Date, timezone: string): Promise<bigint | null> {
  const month = monthKey(now, timezone);
  const rows = ((await db.spendDaily.findMany({
    where: { tenantId, pot: "ads", scopeType: "account", origin: "all", scopeId: { in: scopeIds(adAccountAssetId, externalId) }, day: { gte: dayKeyToDate(monthStartDay(month)) } },
    select: { amountMinor: true, day: true },
  })) ?? []) as { amountMinor: bigint | number; day: Date }[];
  const inMonth = rows.filter((r) => (r.day instanceof Date ? r.day.toISOString().slice(0, 7) : String(r.day).slice(0, 7)) === month);
  if (inMonth.length === 0) return null;
  return inMonth.reduce((s, r) => s + BigInt(r.amountMinor), 0n);
}

/** The INR 100 equivalent in the account's currency (fresh FX rate, else 100 major units). */
async function thresholdFloor(db: MetaCapDb, currency: string, now: Date): Promise<bigint> {
  if (currency === "INR") return THRESHOLD_FLOOR_INR_MINOR;
  try {
    const converted = convertFromInr(THRESHOLD_FLOOR_INR_MINOR, currency, await readFx(db), now);
    if (converted !== null && converted > 0n) return converted;
  } catch {
    // fall through
  }
  return 100n * oneMajorUnit(currency);
}

const notifyOf = (io: MetaCapIo) => io.notify ?? ((n: SpendNotice) => notifySpend(n));

// =====================================================================================================================
// Reading and storing (5.2)
// =====================================================================================================================

type StoredRead = { row: MetaCapRow; blocked: "mismatch" | "prepaid" | null };

/**
 * Stores one read: Meta's cap, amount_spent (a lower value without a write only after a second agreeing read), status,
 * prepaid, time zone and currency. Clears meta_cap_unreachable. Never calls Meta.
 */
async function storeRead(io: MetaCapIo, tenantId: string, row: MetaCapRow, read: CapRead, potCurrency: string | null, state: AccountState, now: Date): Promise<StoredRead> {
  const db = dbOf(io);
  const ledger = { db: db as unknown as LedgerDb };
  const subject = { tenantId, pot: "ads" as const, targetType: "ad_account", targetId: row.adAccountAssetId, metaObjectId: actPath(row.accountExternalId) };
  const data: Record<string, unknown> = { lastReadCapMinor: read.capMinor, lastReadAt: now, accountStatus: read.accountStatus, isPrepay: read.isPrepay };
  if (read.currency) data.currency = read.currency;

  if (read.timezone && row.timezone && read.timezone !== row.timezone) {
    await appendStandalone({ ...subject, action: "ads.account.timezone_changed", phase: "info", actor: EXTERNAL, reason: `Meta now reports this ad account in ${read.timezone} (was ${row.timezone}). Ads days follow it from the next account day.`, reasonCodes: ["account_timezone_changed"], before: { timezone: row.timezone }, after: { timezone: read.timezone } }, ledger);
  }
  if (read.timezone) data.timezone = read.timezone;

  // A lower counter with no write since the last read: used only when two consecutive reads agree (3.1).
  let amount = read.amountSpentMinor;
  const stored = row.lastReadAmountSpentMinor;
  const wroteSince = row.lastWriteAt && (!row.lastReadAt || row.lastWriteAt.getTime() > row.lastReadAt.getTime());
  if (stored !== null && !wroteSince && amount + 1n < stored) {
    const seen = state.readDrift ? BigInt(state.readDrift.amountSpentMinor) : null;
    if (seen !== null && abs(seen - amount) <= 1n) {
      delete state.readDrift;
      await appendStandalone({ ...subject, action: "meta.spend_cap.read_drift", phase: "info", actor: EXTERNAL, currency: row.currency, reason: "Meta's spend counter went down on two reads in a row, so we use the lower figure now.", reasonCodes: ["accepted"], before: { amount_spent: stored }, after: { amount_spent: amount } }, ledger);
    } else {
      state.readDrift = { amountSpentMinor: amount.toString(), at: now.toISOString() };
      await appendStandalone({ ...subject, action: "meta.spend_cap.read_drift", phase: "info", actor: EXTERNAL, currency: row.currency, reason: "Meta's spend counter went down without a change from Edwyz. We'll use the lower figure only if the next read agrees.", reasonCodes: ["first_read"], before: { amount_spent: stored }, after: { amount_spent: amount } }, ledger);
      amount = stored;
    }
  } else if (state.readDrift) {
    delete state.readDrift;
  }
  data.lastReadAmountSpentMinor = amount;

  let blocked: StoredRead["blocked"] = null;
  if (read.isPrepay === true && row.mode === "managed") {
    data.mode = "unavailable_prepaid";
    blocked = "prepaid";
  } else if (read.currency && potCurrency && read.currency !== potCurrency && row.mode === "managed") {
    data.mode = "currency_mismatch";
    blocked = "mismatch";
  }
  await updateRow(db, row.adAccountAssetId, data);
  if (state.unreachableSince) {
    delete state.unreachableSince;
    delete state.lastUnreachableTryAt;
  }
  await clearBreaker({ tenantId, kind: "meta_cap_unreachable", scopeType: "ad_account", scopeId: row.adAccountAssetId }, { db, now, reason: "Edwyz can reach Meta for this ad account again." }).catch(() => undefined);
  return { row: (await loadRow(db, tenantId, row.adAccountAssetId)) ?? row, blocked };
}

/** Open commitments on one ad account (live or reserved spend that Meta's limit must leave room for). */
async function openCommitmentCount(db: MetaCapDb, tenantId: string, adAccountAssetId: string): Promise<number> {
  return Number(await db.spendCommitment.count({ where: { tenantId, adAccountAssetId, status: { in: ["reserved", "live", "unconfirmed"] } } }));
}

async function handleUnreachable(io: MetaCapIo, tenantId: string, row: MetaCapRow, asset: Asset, state: AccountState, now: Date): Promise<SyncResult> {
  const db = dbOf(io);
  state.unreachableSince ??= now.toISOString();
  state.lastUnreachableTryAt = now.toISOString();
  await saveAccountState(tenantId, row.adAccountAssetId, state, db).catch(() => undefined);
  if ((await openCommitmentCount(db, tenantId, row.adAccountAssetId)) > 0) {
    const name = asset.name?.trim() || actPath(row.accountExternalId);
    const cap = row.lastReadCapMinor ?? row.managedCapMinor;
    const currency = row.currency ?? "INR";
    await openBreaker(
      { tenantId, kind: "meta_cap_unreachable", scopeType: "ad_account", scopeId: row.adAccountAssetId, effect: "block_raises", reason: "Edwyz can't reach Meta for this ad account, so assistants can't raise anything on it until it is connected again.", details: { since: state.unreachableSince } },
      { db, now },
    ).catch((e: unknown) => console.error(`[spend] meta_cap_unreachable not opened: ${describeError(e)}`));
    const capText = cap !== null && cap > 0n ? `Meta's last spending limit (${formatMinor(cap, currency)}) still protects this month.` : "Your Edwyz limits still apply.";
    await notifyOf(io)({ tenantId, kind: "meta_limit", severity: "action_needed", audience: "owner", dedupeKey: `metacap:unreachable:${row.adAccountAssetId}:${dayKey(now, "UTC")}`, title: "Connect Meta again", body: `We can't reach Meta for ${name} because its connection expired or was removed. ${capText} Connect again in Settings > Connections.`, link: "/app/settings/connections", subjectType: "ad_account", subjectId: row.adAccountAssetId }).catch(() => undefined);
  }
  return { status: "unreachable", reason: "asset_access" };
}

/**
 * Reads Meta's limit of one managed account again when the stored read is older than `maxAgeMs`, and stores it. For the
 * Spend Book's pre-read (4.6 step 8, I10): it must run with no spend lock held, and it never throws.
 */
export async function ensureFreshRead(tenantId: string, adAccountAssetId: string, maxAgeMs: number, io: MetaCapIo = {}): Promise<void> {
  try {
    if (heldSpendLocks().length > 0) return;
    const env = io.env ?? process.env;
    if (spendCapMode(env) === "off") return;
    const db = dbOf(io);
    const now = io.now ?? new Date();
    const row = await loadRow(db, tenantId, adAccountAssetId);
    if (!row || row.mode !== "managed") return;
    if (row.lastReadAt && now.getTime() - row.lastReadAt.getTime() <= maxAgeMs) return;
    const asset = await loadAsset(db, tenantId, adAccountAssetId);
    if (!asset || isDemoAsset(asset) || asset.sandbox === true) return;
    let token: string;
    try {
      token = (await assetToken(io, tenantId, adAccountAssetId)).token;
    } catch {
      return;
    }
    const read = await readCap(token, row.accountExternalId);
    const state = await loadAccountState(tenantId, adAccountAssetId, db).catch(() => ({}) as AccountState);
    await storeRead(io, tenantId, row, read, row.currency, state, now);
    await saveAccountState(tenantId, adAccountAssetId, state, db).catch(() => undefined);
  } catch (error) {
    console.error(`[spend] Meta limit fresh read failed; the stored read is used: ${describeError(error)}`);
  }
}

// =====================================================================================================================
// One account
// =====================================================================================================================

/**
 * Reads one managed account, adopts or restores outside changes, and writes Meta's limit when the plan says so. Never
 * throws for Meta's answers.
 */
export async function syncMetaCap(tenantId: string, adAccountAssetId: string, opts: SyncOptions = {}): Promise<SyncResult> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const db = dbOf(opts);
  const io: MetaCapIo = { ...opts, db, env, now };
  const notify = notifyOf(opts);
  if (spendCapMode(env) === "off") return { status: "skipped", reason: "cap_mode_off" };
  let row = await loadRow(db, tenantId, adAccountAssetId);
  if (!row) return { status: "skipped", reason: "no_row" };
  if (row.mode !== "managed" && row.mode !== "sandbox") return { status: "skipped", reason: `mode_${row.mode}` };
  const asset = await loadAsset(db, tenantId, adAccountAssetId);
  if (!asset) return { status: "skipped", reason: "no_asset" };
  // Demo assets never reach Meta (8.4).
  if (isDemoAsset(asset)) return { status: "skipped", reason: "demo" };
  const state = await loadAccountState(tenantId, adAccountAssetId, db).catch(() => ({}) as AccountState);
  if (asset.sandbox === true) {
    if (row.mode !== "sandbox") await updateRow(db, adAccountAssetId, { mode: "sandbox", pendingTargetMinor: null, deferredUntil: null });
    if (!state.sandboxNotedAt) {
      state.sandboxNotedAt = now.toISOString();
      await appendStandalone({ tenantId, pot: "ads", action: "meta.spend_cap.observe", phase: "info", actor: SYSTEM, reason: "This is a Meta test ad account, so Meta's limit is never written on it.", reasonCodes: ["sandbox"], targetType: "ad_account", targetId: adAccountAssetId, metaObjectId: actPath(row.accountExternalId), sandbox: true }, { db: db as unknown as LedgerDb });
      await saveAccountState(tenantId, adAccountAssetId, state, db).catch(() => undefined);
    }
    return { status: "skipped", reason: "sandbox" };
  }
  if (row.mode !== "managed") return { status: "skipped", reason: `mode_${row.mode}` };

  const control = await getControl(tenantId, { db, prune: false });
  const tz = assetTimezone(asset, row, control.timezone);
  const metaCurrency = asset.meta && typeof asset.meta === "object" ? (asset.meta as { currency?: unknown }).currency : null;
  const accountCurrency = row.currency ?? (isCurrencyCode(metaCurrency) ? metaCurrency : null);
  const limits = await effectiveLimits(tenantId, "ads", accountCurrency ?? undefined, db, { now, env, control });
  const potCurrency = limits.currencyMatches ? limits.currency : (limits.allowance?.currency ?? limits.currency);

  let token: string;
  try {
    token = (await assetToken(io, tenantId, adAccountAssetId)).token;
  } catch (error) {
    if ((error as { status?: unknown })?.status === 409) return handleUnreachable(io, tenantId, row, asset, state, now);
    return { status: "skipped", reason: "no_access" };
  }

  let read: CapRead;
  try {
    read = await readCap(token, row.accountExternalId);
  } catch (error) {
    await updateRow(db, adAccountAssetId, { lastError: `read_failed: ${describeError(error).slice(0, 150)}` }).catch(() => undefined);
    return { status: "failed", reason: "read_failed" };
  }
  const stored = await storeRead(io, tenantId, row, read, potCurrency, state, now);
  row = stored.row;
  if (stored.blocked) {
    await saveAccountState(tenantId, adAccountAssetId, state, db).catch(() => undefined);
    return { status: "read", reason: stored.blocked };
  }

  // An ambiguous write is settled before anything else is written.
  if (state.unconfirmed) {
    const settled = await settleUnconfirmed({ ...io, tenantId, row, state, read: { ...read, amountSpentMinor: row.lastReadAmountSpentMinor ?? read.amountSpentMinor }, actor: opts.actor ?? SYSTEM, currency: row.currency ?? "INR" });
    if (settled === "waiting") {
      await saveAccountState(tenantId, adAccountAssetId, state, db).catch(() => undefined);
      return { status: "read", reason: "waiting_for_unconfirmed" };
    }
    row = (await loadRow(db, tenantId, adAccountAssetId)) ?? row;
  }

  const a = row.lastReadAmountSpentMinor ?? read.amountSpentMinor;
  const c = row.lastReadCapMinor ?? read.capMinor;
  const currency = row.currency ?? limits.currency;
  const m = limits.monthly;
  const accountMtd = await accountMonthToDate(db, tenantId, adAccountAssetId, row.accountExternalId, now, tz);

  // Rollover bookkeeping (P2): the first read of a new account month restarts the month's counter values.
  const currentMonth = monthKey(now, tz);
  if (row.monthKey !== currentMonth) {
    const firstMonth = row.monthKey === null;
    const data: Record<string, unknown> = { monthKey: currentMonth };
    if (!firstMonth) {
      data.monthStartAmountSpentMinor = a;
      if (row.semantics === "resets_on_write") data.spentAtLastWriteMinor = -a;
    } else if (row.monthStartAmountSpentMinor === null && accountMtd !== null) {
      data.monthStartAmountSpentMinor = max0(a - accountMtd);
    }
    await updateRow(db, adAccountAssetId, data);
    row = (await loadRow(db, tenantId, adAccountAssetId)) ?? row;
  } else if (row.monthStartAmountSpentMinor === null && accountMtd !== null && row.semantics !== "resets_on_write") {
    // Mid-month consent before the first fast sync: the start value is set as soon as the month-to-date is known (5.3).
    await updateRow(db, adAccountAssetId, { monthStartAmountSpentMinor: max0(a - accountMtd) });
    row = (await loadRow(db, tenantId, adAccountAssetId)) ?? row;
  }

  const name = asset.name?.trim() || actPath(row.accountExternalId);
  let request: PlanRequest | null = opts.request ?? null;

  // Changes made outside Edwyz (5.6).
  if (row.managedCapMinor !== null && request?.kind !== "p0_stop") {
    const managed = row.managedCapMinor;
    if ((c === 0n && managed > 0n) || c > managed + 1n) {
      request = { kind: "external", change: c === 0n ? "removed" : "raised" };
      await appendStandalone({ tenantId, pot: "ads", action: "meta.spend_cap.external_change", phase: "reconciled", actor: EXTERNAL, reason: c === 0n ? "Meta's spending limit was removed outside Edwyz." : "Meta's spending limit was raised outside Edwyz.", reasonCodes: [c === 0n ? "removed" : "raised"], targetType: "ad_account", targetId: adAccountAssetId, metaObjectId: actPath(row.accountExternalId), currency, before: { cap: managed }, after: { cap: c } }, { db: db as unknown as LedgerDb });
      await notify({ tenantId, kind: "meta_limit", severity: "heads_up", audience: "owner", dedupeKey: `metacap:raised:${adAccountAssetId}:${c.toString()}`, title: "Meta's limit was set back", body: `Meta's spending limit on ${name} was raised outside Edwyz, so we set it back to match your monthly ads limit.`, link: "/app/settings/spending", subjectType: "ad_account", subjectId: adAccountAssetId }).catch(() => undefined);
    } else if (c < managed - 1n) {
      // The customer lowered it: adopt it, and never raise it back automatically ("Use my Edwyz limit" is the owner's raise).
      await updateRow(db, adAccountAssetId, { customerCapAtConsentMinor: c, customerAmountSpentAtConsentMinor: a, managedCapMinor: c, pendingTargetMinor: null, deferredUntil: null });
      await appendStandalone({ tenantId, pot: "ads", action: "meta.spend_cap.external_change", phase: "reconciled", actor: EXTERNAL, reason: "Meta's spending limit was lowered outside Edwyz. We keep it.", reasonCodes: ["lowered"], targetType: "ad_account", targetId: adAccountAssetId, metaObjectId: actPath(row.accountExternalId), currency, before: { cap: managed }, after: { cap: c } }, { db: db as unknown as LedgerDb });
      await notify({ tenantId, kind: "meta_limit", severity: "fyi", audience: "owner", dedupeKey: `metacap:lower:${adAccountAssetId}:${c.toString()}`, title: "We kept your lower Meta limit", body: `We noticed a lower Meta spending limit on ${name}. We'll keep it.`, link: "/app/settings/spending", subjectType: "ad_account", subjectId: adAccountAssetId }).catch(() => undefined);
      row = (await loadRow(db, tenantId, adAccountAssetId)) ?? row;
    }
  }

  // Near the wall (5.6), once a day.
  if (nearWall(c, a, m)) {
    await notify({ tenantId, kind: "meta_limit", severity: "heads_up", audience: "owner", dedupeKey: `metacap:nearwall:${adAccountAssetId}:${dayKey(now, tz)}`, title: "Meta's limit is close", body: `Meta will stop all ads on ${name} after ${formatMinor(max0(c - a), currency)} more this month.`, link: "/app/settings/spending", subjectType: "ad_account", subjectId: adAccountAssetId }).catch(() => undefined);
  }

  // Drift between Meta's counter and insights (5.6): flagged after 3 consecutive reads.
  const s = spentThisMonth({ semantics: row.semantics, amountSpentMinor: a, monthStartAmountSpentMinor: row.monthStartAmountSpentMinor, spentAtLastWriteMinor: row.spentAtLastWriteMinor, accountMonthToDateMinor: accountMtd });
  await trackDrift(io, tenantId, row, state, a, accountMtd);
  await saveAccountState(tenantId, adAccountAssetId, state, db).catch(() => undefined);

  // The plan.
  const book = await roomNeeded(io, tenantId, adAccountAssetId, currency, control).catch(() => 0n);
  const writes = await loadCapWrites(tenantId, adAccountAssetId, now, db);
  // A stop (freeze `all`, the workspace's or Edwyz's) never sees Meta's limit raised: that would undo a P0 stop while ads that
  // could not be paused may still run. Locked and suspended workspaces never raise either (4.17).
  const frozen = (await spendState(tenantId, { db, fresh: true }).catch(() => null))?.effective === "all";
  const workspaceActive = (opts.workspaceActive ?? (await tenantMayRunBackground(tenantId).catch(() => false))) && !frozen;
  const floor = await thresholdFloor(db, currency, now);
  const decision = planMetaCap({
    now,
    row,
    monthlyLimitMinor: m,
    dailyLimitMinor: limits.daily,
    accountMonthToDateMinor: accountMtd,
    roomNeededMinor: book,
    writes,
    workspaceActive,
    thresholdFloorMinor: floor,
    monthStartAt: startOfLocalMonth(now, tz),
    request,
  });

  if (decision.action === "none") {
    if (decision.reason === "in_range") await clearStaleHigh(db, tenantId, adAccountAssetId, now);
    const data: Record<string, unknown> = {};
    if (row.pendingTargetMinor !== null || row.deferredUntil !== null) Object.assign(data, { pendingTargetMinor: null, deferredUntil: null });
    if (decision.target !== null) data.targetCapMinor = decision.target;
    // A cap already within the plan (the customer's own) is tracked for outside changes, though Edwyz never wrote it.
    if (row.managedCapMinor === null && c > 0n && decision.reason === "in_range") data.managedCapMinor = c;
    if (Object.keys(data).length) await updateRow(db, adAccountAssetId, data);
    return { status: "planned", reason: decision.reason, decision };
  }
  if (decision.action === "defer") {
    await updateRow(db, adAccountAssetId, { pendingTargetMinor: decision.target, deferredUntil: decision.until, targetCapMinor: decision.target });
    if (decision.until) {
      await (opts.enqueue ?? enqueueJob)(SPEND_QUEUES.metacapReplan, { tenantId, adAccountAssetId, reason: `deferred_${decision.reason}` }, { runAt: decision.until }).catch(() => undefined);
    }
    return { status: "deferred", reason: decision.reason, decision };
  }

  const write = await writeCap({
    ...io,
    tenantId,
    row,
    token,
    target: decision.target,
    priority: decision.priority,
    writeClass: decision.writeClass,
    actor: opts.actor ?? SYSTEM,
    reason: writeReason(decision, currency),
    before: { ...read, amountSpentMinor: a },
    monthlyLimitMinor: m,
    spentBeforeMinor: s,
  });
  if (write.outcome === "observed") return { status: "observed", decision, write };
  if (write.outcome !== "applied") return { status: write.outcome === "skipped" ? "deferred" : "failed", reason: write.outcome, decision, write };
  if (write.read.capMinor <= decision.target + thresholdMinor({ monthlyMinor: m, dailyMinor: limits.daily, floorMinor: floor })) await clearStaleHigh(db, tenantId, adAccountAssetId, now);

  // (iii) The write reset Meta's counter: rewrite T = R at once (P1, no debounce), so the cap is not loose by A.
  if (write.resetDetected && m !== null && s !== null) {
    const fresh = (await loadRow(db, tenantId, adAccountAssetId)) ?? row;
    const r = remainingMinor(m, s);
    const threshold = thresholdMinor({ monthlyMinor: m, dailyMinor: limits.daily, floorMinor: floor });
    const capNow = write.read.capMinor;
    if (capNow - r > threshold) {
      const emergency = capNow - write.read.amountSpentMinor > r + threshold;
      const cls = emergency ? "emergency" : "routine";
      // Still inside Meta's change budget: otherwise it waits like any other write.
      const used = await loadCapWrites(tenantId, adAccountAssetId, now, db);
      if (!budgetAllows(changeBudget(used, now), cls)) {
        await updateRow(db, adAccountAssetId, { pendingTargetMinor: r, deferredUntil: budgetFreesAt(used, cls, now) });
        return { status: "deferred", reason: "budget", decision, write };
      }
      const again = await writeCap({
        ...io,
        tenantId,
        row: fresh,
        token,
        target: r,
        priority: "P1_lower",
        writeClass: cls,
        actor: opts.actor ?? SYSTEM,
        reason: "Meta resets its spend counter when the limit changes, so we set the limit to what is left of your monthly ads limit.",
        before: write.read,
        monthlyLimitMinor: m,
        spentBeforeMinor: s,
      });
      return { status: "written", reason: "resets_on_write", decision, write: again };
    }
  }
  return { status: "written", reason: decision.reason, decision, write };
}

/** meta_cap_stale_high clears once Meta's limit is back within the plan (5.7 "when resolved"). */
async function clearStaleHigh(db: MetaCapDb, tenantId: string, adAccountAssetId: string, now: Date): Promise<void> {
  await clearBreaker({ tenantId, kind: "meta_cap_stale_high", scopeType: "ad_account", scopeId: adAccountAssetId }, { db, now, reason: "Meta's spending limit is back in line with your limits." }).catch(() => undefined);
}

function writeReason(decision: Extract<PlanDecision, { action: "write" }>, currency: string): string {
  const amount = formatMinor(decision.target, currency);
  switch (decision.priority) {
    case "P0_stop":
      return `Sets Meta's spending limit to ${amount} so the ad account stops, because some ads could not be paused.`;
    case "P0_restore":
      return `Sets Meta's spending limit back to ${amount}, because it was changed outside Edwyz.`;
    case "P2_rollover":
      return `Sets Meta's spending limit to ${amount} for the new month.`;
    case "P3_raise":
      return `Raises Meta's spending limit to ${amount}, within your monthly ads limit.`;
    default:
      return `Sets Meta's spending limit to ${amount}, to match your monthly ads limit.`;
  }
}

/** Σ dayRisk on the account plus 24 hours of the live worst case: the room Meta must leave (P3). */
async function roomNeeded(io: MetaCapIo, tenantId: string, adAccountAssetId: string, currency: string, control: Awaited<ReturnType<typeof getControl>>): Promise<bigint> {
  const db = dbOf(io);
  const now = io.now ?? new Date();
  const state = await loadAdsBook(tenantId, { db, now, env: io.env, control });
  const counted = countedCommitments(state);
  const figures = computeAdsFigures(state, counted, currency, io.env);
  const today = figures.accounts.find((x) => x.adAccountAssetId === adAccountAssetId)?.dayRisk ?? 0n;
  let tomorrow = 0n;
  for (const cm of counted) if (cm.adAccountAssetId === adAccountAssetId && cm.status !== "stopped" && cm.currency === currency) tomorrow += ceil175(cm.dailyBudgetMinor ?? 0n);
  return today + tomorrow;
}

/** |ΔA - ΔS| > 10% of ΔS on 3 consecutive reads flags `drift` (tax or accrual lag) for the admin panel. */
async function trackDrift(io: MetaCapIo, tenantId: string, row: MetaCapRow, state: AccountState, a: bigint, mtd: bigint | null): Promise<void> {
  if (mtd === null) return;
  const prev = state.drift;
  const wrote = row.lastWriteAt && prev && row.semantics === "resets_on_write";
  if (!prev || wrote) {
    state.drift = { a: a.toString(), s: mtd.toString(), strikes: 0, flagged: prev?.flagged ?? false };
    return;
  }
  const dA = a - BigInt(prev.a);
  const dS = mtd - BigInt(prev.s);
  let strikes = prev.strikes;
  if (dS > 0n) strikes = abs(dA - dS) * 10n > dS ? strikes + 1 : 0;
  let flagged = prev.flagged;
  if (strikes >= 3 && !flagged) {
    flagged = true;
    await appendStandalone(
      { tenantId, pot: "ads", action: "meta.spend_cap.read_drift", phase: "info", actor: SYSTEM, reason: "Meta's spend counter and the ad reports disagree by more than 10% (often tax or delayed charges). We use the larger figure.", reasonCodes: ["drift"], targetType: "ad_account", targetId: row.adAccountAssetId, metaObjectId: actPath(row.accountExternalId), currency: row.currency, before: { a: prev.a, s: prev.s }, after: { a, s: mtd } },
      { db: dbOf(io) as unknown as LedgerDb },
    );
  }
  if (strikes === 0) flagged = false;
  state.drift = { a: a.toString(), s: mtd.toString(), strikes, flagged };
}

/** P0 (5.4): a stop could not pause everything, so Meta's limit is set to stop the account now. */
export async function p0Stop(tenantId: string, adAccountAssetId: string, reason: string, opts: SyncOptions = {}): Promise<SyncResult> {
  return syncMetaCap(tenantId, adAccountAssetId, { ...opts, request: { kind: "p0_stop" }, actor: opts.actor ?? { type: "system", job: `metacap.p0:${reason}`.slice(0, 60) } });
}

// =====================================================================================================================
// The scheduled pass
// =====================================================================================================================

/** Whether a managed account is due for a read now (5.2 cadence, a deferred write, a 409 retry, a new month). */
export function readDue(row: MetaCapRow, active: boolean, state: AccountState, now: Date, currentMonth: string | null): boolean {
  if (row.pendingTargetMinor !== null && row.deferredUntil && row.deferredUntil.getTime() <= now.getTime()) return true;
  if (state.unconfirmed) return true;
  if (state.unreachableSince) {
    const last = state.lastUnreachableTryAt ? Date.parse(state.lastUnreachableTryAt) : 0;
    return now.getTime() - last >= UNREACHABLE_RETRY_MS;
  }
  if (!row.lastReadAt) return true;
  if (currentMonth !== null && row.monthKey !== currentMonth) return true;
  return now.getTime() - row.lastReadAt.getTime() >= (active ? READ_ACTIVE_MS : READ_IDLE_MS);
}

export const METACAP_PASS_MS = 5 * 60_000;
const PASS_BUDGET_MS = 4 * 60_000;

export type PassResult = { accounts: number; synced: number; offboarded: number; errors: number };

/**
 * Every managed account that is due: read, adopt or restore, plan, write. Workspaces deleted meanwhile get their stored
 * offboarding choice (default keep) once. Never throws.
 */
export async function runMetacapPass(io: MetaCapIo = {}): Promise<PassResult> {
  const env = io.env ?? process.env;
  const result: PassResult = { accounts: 0, synced: 0, offboarded: 0, errors: 0 };
  if (spendCapMode(env) === "off") return result;
  const db = dbOf(io);
  const started = Date.now();
  let rows: MetaCapRow[] = [];
  try {
    rows = (((await db.metaSpendLimit.findMany({ where: { mode: "managed" }, take: 500 })) ?? []) as Record<string, unknown>[]).map(toMetaCapRow);
  } catch (error) {
    console.error(`[spend] metacap pass: ${describeError(error)}`);
    return result;
  }
  result.accounts = rows.length;
  const tenants = new Map<string, { deletedAt: Date | null } | null>();
  for (const row of rows) {
    if (Date.now() - started > PASS_BUDGET_MS) break;
    const now = io.now ?? new Date();
    try {
      if (!tenants.has(row.tenantId)) tenants.set(row.tenantId, (await db.tenant.findUnique({ where: { id: row.tenantId }, select: { deletedAt: true } })) as { deletedAt: Date | null } | null);
      const tenant = tenants.get(row.tenantId);
      if (!tenant || tenant.deletedAt) {
        // A soft-deleted workspace: its stored choice (default keep) is applied once, while the token may still work (5.8).
        result.offboarded += (await offboardTenant(row.tenantId, "soft_delete", io)).length;
        continue;
      }
      const state = await loadAccountState(row.tenantId, row.adAccountAssetId, db).catch(() => ({}) as AccountState);
      const tz = resolveTimeZone(row.timezone);
      const open = await openCommitmentCount(db, row.tenantId, row.adAccountAssetId);
      const mtd = open > 0 ? null : await accountMonthToDate(db, row.tenantId, row.adAccountAssetId, row.accountExternalId, now, tz).catch(() => null);
      const active = open > 0 || (mtd !== null && mtd > 0n);
      if (!readDue(row, active, state, now, monthKey(now, tz))) continue;
      await syncMetaCap(row.tenantId, row.adAccountAssetId, io);
      result.synced++;
    } catch (error) {
      result.errors++;
      console.error(`[spend] metacap sync of ${row.adAccountAssetId} failed: ${describeError(error)}`);
    }
  }
  return result;
}

/** Every managed account of one workspace now (a limit change, META_CAP_TOO_LOW, the 60-second re-check). */
export async function replanTenant(tenantId: string, adAccountAssetId: string | undefined, opts: SyncOptions = {}): Promise<SyncResult[]> {
  const db = dbOf(opts);
  const ids = adAccountAssetId
    ? [adAccountAssetId]
    : (((await db.metaSpendLimit.findMany({ where: { tenantId, mode: { in: ["managed", "sandbox"] } }, select: { adAccountAssetId: true } })) ?? []) as { adAccountAssetId: string }[]).map((r) => r.adAccountAssetId);
  const out: SyncResult[] = [];
  for (const id of ids) out.push(await syncMetaCap(tenantId, id, opts));
  return out;
}
