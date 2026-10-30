/**
 * spend.sync.structure (docs/SPEND-CONTROLS-SPEC.md 4.6.1): edits made in Meta Ads Manager to Edwyz's own campaigns.
 *
 * Runs with every fast sync (6.1) and every 2 hours for workspaces with platform campaigns but no open commitment. Two reads
 * per ad account (more only past 50 campaigns), reads only, so no permit:
 *   GET act_X/campaigns?filtering=[{field:'id',operator:'IN',value:[...]}]&fields=id,status,effective_status,daily_budget,
 *       lifetime_budget,stop_time,is_adset_budget_sharing_enabled
 *   GET act_X/adsets?filtering=[{field:'campaign.id',operator:'IN',value:[...]}]&fields=id,campaign_id,status,
 *       effective_status,daily_budget,lifetime_budget,end_time
 * The ids are every platform campaign that is not archived, or was archived within 35 days.
 *
 * Rule: adopt the truth, never fight the customer. Every difference is adopted into the book (under the ads spend lock, after
 * the reads, I10) and ledgered as ads.external_change (actor external, phase reconciled, before and after):
 * - ACTIVE on Meta with no open commitment: a live commitment at the observed budget, AdCampaign.status = 'active', notice;
 * - a higher budget: D, peakToday and weekPeak raised, notice; a lower budget, paused, archived or deleted: lowered or
 *   stopped as recordLowering would (today's peak stays), no notice;
 * - an ad set Edwyz did not create: a live commitment, origin human, in the budget notice;
 * - budget moved to campaign level, or budget sharing on: the ad set commitments stop and one campaign-level commitment takes
 *   over (sharing counts 2.1x: its daily figure is stored as ceil(1.2 D), so 1.75x of it is 2.1 D and 7x is 8.4 D), notice;
 * - an end date removed or moved later: a person's campaign takes the new end (or none); an assistant's keeps a counting
 *   horizon of the account month end (rolled each month, so the CHECK constraints hold) and gets an external_edit breaker
 *   (block_raises, assistants only) until an end date is set again or it is archived, notice.
 * Limits still win: the daily_limit and monthly_limit breakers pause on their next run. Campaigns created in Ads Manager are
 * not structure-synced. Demo and sandbox accounts are skipped (8.4).
 */
import { prisma } from "@/lib/db";
import { graphFetchAs } from "@/lib/graph";
import { describeError } from "@/lib/safe-error";
import { clearBreaker, openBreaker } from "../breakers/state";
import { rolledPeaks, toBookCommitment, type BookCommitment } from "../commitments";
import { getControl, type SpendDb } from "../control";
import { isDemoAsset } from "../demo";
import { appendStandalone, newCorrelationId, type LedgerDb } from "../ledger";
import { withSpendLock, type SpendLockClient } from "../lock";
import { formatMinor, isCurrencyCode } from "../money";
import { notifySpend } from "../notify";
import { dayKey, dayKeyToDate, nextLocalMonthStart, resolveTimeZone, weekStartOfDay } from "../periods";
import type { LedgerRowInput, SpendActor, SpendNotice } from "../types";

export const STRUCTURE_EVERY_MS = 2 * 3_600_000;
export const STRUCTURE_IDS_PER_REQUEST = 50;
export const ARCHIVED_LOOKBACK_MS = 35 * 86_400_000;
export const CAMPAIGN_FIELDS = "id,name,status,effective_status,daily_budget,lifetime_budget,stop_time,is_adset_budget_sharing_enabled";
export const ADSET_FIELDS = "id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,end_time";

const EXTERNAL: SpendActor = { type: "external", source: "meta_ads_manager" };
const OPEN = ["reserved", "live", "unconfirmed"];
const DEAD = new Set(["DELETED", "ARCHIVED"]);
const MAX_PAGES = 10;

export type StructureIo = {
  db?: SpendDb;
  env?: Record<string, string | undefined>;
  now?: Date;
  access?: (tenantId: string, adAccountAssetId: string) => Promise<{ token: string; externalId: string }>;
  notify?: (notice: SpendNotice) => Promise<unknown>;
  /** Already resolved by the fast sync. */
  token?: string;
  asset?: Asset;
};

export type Asset = { id: string; externalId: string; name: string | null; meta: unknown; sandbox?: boolean; status?: string };

export type MetaCampaignRead = { id: string; name?: string; status?: string; effective_status?: string; daily_budget?: string | number; lifetime_budget?: string | number; stop_time?: string; is_adset_budget_sharing_enabled?: boolean | string };
export type MetaAdSetRead = { id: string; name?: string; campaign_id?: string; status?: string; effective_status?: string; daily_budget?: string | number; lifetime_budget?: string | number; end_time?: string };

export type StructureChange = { kind: "turned_on" | "budget_up" | "budget_down" | "stopped" | "new_adset" | "budget_level" | "end_removed" | "end_later" | "end_earlier" | "campaign_status"; campaignId: string; metaObjectId: string };
export type StructureResult = { status: "synced" | "skipped"; reason?: string; reads: number; changes: StructureChange[] };

const dbOf = (io: StructureIo): SpendDb => io.db ?? prisma;
const act = (externalId: string): string => `act_${externalId.replace(/^act_/, "")}`;
const upper = (v: unknown): string => String(v ?? "").trim().toUpperCase();
const runningOf = (o: { status?: string; effective_status?: string }): boolean => (o.effective_status ? upper(o.effective_status) === "ACTIVE" : upper(o.status) === "ACTIVE");
const deadOf = (o: { status?: string; effective_status?: string }): boolean => DEAD.has(upper(o.status)) || DEAD.has(upper(o.effective_status));
const budget = (v: unknown): bigint | null => {
  if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) return BigInt(v);
  if (typeof v === "string" && /^\d{1,19}$/.test(v.trim()) && BigInt(v.trim()) > 0n) return BigInt(v.trim());
  return null;
};
const time = (v: unknown): Date | null => {
  if (typeof v !== "string" || !v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) || d.getTime() <= 0 ? null : d;
};
const sharingOn = (v: unknown): boolean => v === true || v === "true";
/** Budget sharing lets an ad set spend 2.1x (4.5): its daily figure is stored as ceil(1.2 D), so ceil175 of it is ceil210(D). */
export const sharedDaily = (d: bigint): bigint => (6n * d + 4n) / 5n;
const earliest = (...ds: (Date | null)[]): Date | null => ds.filter((d): d is Date => d !== null).reduce<Date | null>((a, b) => (a === null || b.getTime() < a.getTime() ? b : a), null);

export async function structureToken(io: StructureIo, tenantId: string, adAccountAssetId: string): Promise<string> {
  if (io.token) return io.token;
  if (io.access) return (await io.access(tenantId, adAccountAssetId)).token;
  const { getAssetAccess } = await import("@/lib/meta-connect");
  return (await getAssetAccess(tenantId, adAccountAssetId)).token;
}

async function readEdge<T>(token: string, accountExternalId: string, edge: "campaigns" | "adsets", field: "id" | "campaign.id", ids: string[], fields: string): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await graphFetchAs<{ data?: T[]; paging?: { cursors?: { after?: string }; next?: string } }>(token, {
      path: `${act(accountExternalId)}/${edge}`,
      method: "GET",
      query: { fields, filtering: JSON.stringify([{ field, operator: "IN", value: ids }]), limit: "200", ...(after ? { after } : {}) },
    });
    out.push(...(res?.data ?? []));
    after = res?.paging?.next ? res.paging.cursors?.after : undefined;
    if (!after) break;
  }
  return out;
}

type DbCampaign = { id: string; name: string; metaCampaignId: string | null; status: string; origin: string; assistantKey: string | null; currency: string; endsAt: Date | null; lifetimeBudgetMinor: bigint | number | null; startsAt: Date | null; sandbox?: boolean; updatedAt?: Date };
type DbAdSet = { id: string; campaignId: string; metaAdSetId: string | null; status: string; dailyBudgetMinor: number | null };

/** The account month end (a counting horizon for an assistant campaign whose end date was removed). */
export function monthEndHorizon(now: Date, timezone: string): Date {
  return new Date(nextLocalMonthStart(now, timezone).getTime() - 1_000);
}

type Pending = { ledger: LedgerRowInput[]; notices: SpendNotice[]; changes: StructureChange[]; breakers: { open: { campaignId: string; name: string; why: "removed" | "later" }[]; clear: string[] } };

/**
 * Reads the account's platform campaigns and ad sets on Meta and adopts every difference. Never writes to Meta.
 */
export async function syncStructure(tenantId: string, adAccountAssetId: string, io: StructureIo = {}): Promise<StructureResult> {
  const db = dbOf(io);
  const now = io.now ?? new Date();
  const asset = io.asset ?? ((await db.metaAsset.findFirst({ where: { id: adAccountAssetId, tenantId, type: "ad_account" } })) as Asset | null);
  if (!asset) return { status: "skipped", reason: "no_asset", reads: 0, changes: [] };
  if (isDemoAsset(asset)) return { status: "skipped", reason: "demo", reads: 0, changes: [] };
  if (asset.sandbox === true) return { status: "skipped", reason: "sandbox", reads: 0, changes: [] };
  const since = new Date(now.getTime() - ARCHIVED_LOOKBACK_MS);
  const campaigns = (((await db.adCampaign.findMany({
    where: { tenantId, adAccountAssetId, metaCampaignId: { not: null } },
    select: { id: true, name: true, metaCampaignId: true, status: true, origin: true, assistantKey: true, currency: true, endsAt: true, lifetimeBudgetMinor: true, startsAt: true, sandbox: true, updatedAt: true },
    take: 1_000,
  })) ?? []) as DbCampaign[]).filter((c) => c.status !== "archived" || (c.updatedAt && c.updatedAt.getTime() >= since.getTime()));
  if (campaigns.length === 0) return { status: "skipped", reason: "no_campaigns", reads: 0, changes: [] };

  let token: string;
  try {
    token = await structureToken(io, tenantId, adAccountAssetId);
  } catch (error) {
    if ((error as { status?: unknown })?.status === 409) return { status: "skipped", reason: "unreachable", reads: 0, changes: [] };
    throw error;
  }
  const metaCampaigns: MetaCampaignRead[] = [];
  const metaSets: MetaAdSetRead[] = [];
  let reads = 0;
  const ids = campaigns.map((c) => c.metaCampaignId!).filter(Boolean);
  for (let i = 0; i < ids.length; i += STRUCTURE_IDS_PER_REQUEST) {
    const part = ids.slice(i, i + STRUCTURE_IDS_PER_REQUEST);
    metaCampaigns.push(...(await readEdge<MetaCampaignRead>(token, asset.externalId, "campaigns", "id", part, CAMPAIGN_FIELDS)));
    metaSets.push(...(await readEdge<MetaAdSetRead>(token, asset.externalId, "adsets", "campaign.id", part, ADSET_FIELDS)));
    reads += 2;
  }

  const control = await getControl(tenantId, { db, prune: false });
  const metaTz = asset.meta && typeof asset.meta === "object" ? (asset.meta as { timezone?: unknown }).timezone : null;
  const tz = resolveTimeZone(typeof metaTz === "string" ? metaTz : control.timezone);
  const metaCurrency = asset.meta && typeof asset.meta === "object" ? (asset.meta as { currency?: unknown }).currency : null;
  const pending: Pending = { ledger: [], notices: [], changes: [], breakers: { open: [], clear: [] } };

  // No Meta call from here on: the book changes under the ads spend lock (I10).
  const lockDb = typeof (db as { $transaction?: unknown }).$transaction === "function" ? { db: db as unknown as SpendLockClient } : {};
  await withSpendLock(tenantId, "ads", (tx) => adopt(tx, { tenantId, asset, campaigns, metaCampaigns, metaSets, now, tz, currencyOf: (c) => (isCurrencyCode(metaCurrency) ? metaCurrency : c.currency), pending }), lockDb);

  const ledgerDb = { db: db as unknown as LedgerDb };
  for (const row of pending.ledger) await appendStandalone({ ...row, phase: "reconciled" }, ledgerDb);
  for (const b of pending.breakers.open) {
    await openBreaker(
      {
        tenantId,
        kind: "external_edit",
        scopeType: "campaign",
        scopeId: b.campaignId,
        effect: "block_raises",
        reason: b.why === "removed" ? `${b.name} no longer has an end date. Your ad assistant won't change it until you set one.` : `The end date of ${b.name} was moved later in Meta Ads Manager. Your ad assistant won't change it until you set the end date again.`,
        details: { why: b.why },
      },
      { db, now },
    ).catch((e: unknown) => console.error(`[spend] external_edit not opened: ${describeError(e)}`));
  }
  for (const campaignId of pending.breakers.clear) {
    await clearBreaker({ tenantId, kind: "external_edit", scopeType: "campaign", scopeId: campaignId }, { db, now, reason: "The campaign has an end date again, or was archived." }).catch(() => undefined);
  }
  const notify = io.notify ?? ((n: SpendNotice) => notifySpend(n));
  for (const n of pending.notices) await notify(n).catch(() => undefined);
  return { status: "synced", reads, changes: pending.changes };
}

type AdoptInput = {
  tenantId: string;
  asset: Asset;
  campaigns: DbCampaign[];
  metaCampaigns: MetaCampaignRead[];
  metaSets: MetaAdSetRead[];
  now: Date;
  tz: string;
  currencyOf: (c: DbCampaign) => string;
  pending: Pending;
};

async function adopt(tx: SpendDb, input: AdoptInput): Promise<void> {
  const { tenantId, asset, now, tz, pending } = input;
  const open = (((await tx.spendCommitment.findMany({ where: { tenantId, adAccountAssetId: asset.id, status: { in: OPEN } } })) ?? []) as Record<string, unknown>[]).map(toBookCommitment);
  const dbSets = (((await tx.adSet.findMany({ where: { tenantId, campaignId: { in: input.campaigns.map((c) => c.id) } }, select: { id: true, campaignId: true, metaAdSetId: true, status: true, dailyBudgetMinor: true } })) ?? []) as DbAdSet[]);
  const today = dayKey(now, tz);
  const week = weekStartOfDay(today);
  const horizon = monthEndHorizon(now, tz);

  const fmt = (minor: bigint | null, currency: string) => (minor === null ? "no daily budget" : formatMinor(minor, currency));
  const record = (dc: DbCampaign, kind: StructureChange["kind"], metaObjectId: string, targetType: "campaign" | "adset", reason: string, before: unknown, after: unknown, currency: string) => {
    pending.changes.push({ kind, campaignId: dc.id, metaObjectId });
    pending.ledger.push({ tenantId, pot: "ads", action: "ads.external_change", actor: EXTERNAL, reason, reasonCodes: [kind], targetType, targetId: targetType === "campaign" ? dc.id : metaObjectId, metaObjectId, currency, before, after, sandbox: asset.sandbox === true, correlationId: newCorrelationId() });
  };
  const notice = (dc: DbCampaign, key: string, title: string, body: string) =>
    pending.notices.push({ tenantId, kind: "breaker_tripped", severity: "heads_up", audience: "owner", dedupeKey: `ads-external:${dc.id}:${key}`, title, body, link: "/app/ads", subjectType: "campaign", subjectId: dc.id });

  const createLive = async (dc: DbCampaign, spec: { adSetId: string | null; metaObjectId: string; objectLevel: "campaign" | "adset"; origin: string; daily: bigint | null; lifetime: bigint | null; endsAt: Date | null; currency: string }) => {
    const d = spec.daily ?? 0n;
    await tx.spendCommitment.createMany({
      data: [
        {
          tenantId,
          adAccountAssetId: asset.id,
          campaignId: dc.id,
          adSetId: spec.adSetId,
          metaObjectId: spec.metaObjectId,
          objectLevel: spec.objectLevel,
          origin: spec.origin,
          assistantKey: spec.origin === "assistant" ? dc.assistantKey : null,
          currency: spec.currency,
          timezone: tz,
          dailyBudgetMinor: spec.daily,
          lifetimeBudgetMinor: spec.lifetime,
          dayKey: dayKeyToDate(today),
          dayStartBudgetMinor: d,
          peakDailyBudgetMinor: d,
          weekStart: dayKeyToDate(week),
          weekPeakDailyBudgetMinor: d,
          startsAt: dc.startsAt,
          endsAt: spec.endsAt,
          status: "live",
          sandbox: asset.sandbox === true || dc.sandbox === true,
        },
      ],
      skipDuplicates: true,
    });
  };
  const setBudget = async (c: BookCommitment, daily: bigint | null, lifetime: bigint | null) => {
    const p = rolledPeaks(c, now);
    const d = daily ?? 0n;
    const raising = d > (c.dailyBudgetMinor ?? 0n);
    await tx.spendCommitment.update({
      where: { id: c.id! },
      data: {
        dailyBudgetMinor: daily,
        lifetimeBudgetMinor: lifetime,
        dayKey: dayKeyToDate(p.today),
        dayStartBudgetMinor: c.dayKey === p.today ? c.dayStartBudgetMinor : (c.dailyBudgetMinor ?? 0n),
        // A raise lifts today's and the week's peaks; a cut keeps them (Meta's 175% rule uses the day's highest budget).
        peakDailyBudgetMinor: raising ? (d > p.peakToday ? d : p.peakToday) : p.peakToday,
        weekStart: dayKeyToDate(p.week),
        weekPeakDailyBudgetMinor: raising ? (d > p.weekPeak ? d : p.weekPeak) : p.weekPeak,
        version: { increment: 1 },
      } as never,
    });
  };
  const stop = async (c: BookCommitment) => {
    await tx.spendCommitment.update({ where: { id: c.id! }, data: { status: "stopped", reservedUntil: null, version: { increment: 1 } } as never });
  };
  const setEnd = async (c: BookCommitment, endsAt: Date | null) => {
    await tx.spendCommitment.update({ where: { id: c.id! }, data: { endsAt, version: { increment: 1 } } as never });
  };
  const setCampaign = async (dc: DbCampaign, data: Record<string, unknown>) => {
    await tx.adCampaign.updateMany({ where: { id: dc.id, tenantId }, data: data as never });
  };

  for (const dc of input.campaigns) {
    const mc = input.metaCampaigns.find((m) => m.id === dc.metaCampaignId);
    // Not returned at all: nothing is adopted (the commitment stays counted, the safe direction).
    if (!mc) continue;
    const currency = input.currencyOf(dc);
    const assistant = dc.origin === "assistant";
    const sets = input.metaSets.filter((s) => s.campaign_id === mc.id);
    const mine = open.filter((c) => c.campaignId === dc.id);
    const campaignRunning = runningOf(mc) && !deadOf(mc);
    const campaignBudget = budget(mc.daily_budget) !== null || budget(mc.lifetime_budget) !== null;
    const sharing = !campaignBudget && sharingOn(mc.is_adset_budget_sharing_enabled);
    const campaignEnd = time(mc.stop_time);
    let turnedOn = false;

    if (campaignBudget || sharing) {
      // Budget at campaign level (or shared): one campaign-level commitment; the ad set ones stop.
      const setLevel = mine.filter((c) => c.objectLevel === "adset" && c.status === "live");
      for (const c of setLevel) await stop(c);
      const runningSets = sets.filter((s) => runningOf(s) && !deadOf(s));
      const rawDaily = campaignBudget ? budget(mc.daily_budget) : runningSets.reduce<bigint>((s, x) => s + (budget(x.daily_budget) ?? 0n), 0n);
      const daily = rawDaily !== null && rawDaily > 0n ? (sharing ? sharedDaily(rawDaily) : rawDaily) : null;
      const lifetime = campaignBudget ? budget(mc.lifetime_budget) : null;
      const running = campaignRunning && (sets.length === 0 || runningSets.length > 0);
      const cc = mine.find((c) => c.objectLevel === "campaign");
      const endsAt = campaignEnd ?? (assistant && lifetime === null ? horizon : null);
      if (setLevel.length > 0 && !cc) {
        record(dc, "budget_level", mc.id, "campaign", `The budget of ${dc.name} was moved to the campaign or shared between ad sets in Meta Ads Manager.`, { level: "adset", objects: setLevel.map((c) => c.metaObjectId) }, { level: "campaign", sharing }, currency);
        notice(dc, `level:${sharing ? "shared" : "campaign"}`, "Budget settings changed in Meta Ads Manager", `Budget settings of ${dc.name} were changed in Meta Ads Manager.`);
      }
      if (running && (daily !== null || lifetime !== null)) {
        if (!cc) {
          await createLive(dc, { adSetId: null, metaObjectId: mc.id, objectLevel: "campaign", origin: ["human", "assistant", "api"].includes(dc.origin) ? dc.origin : "human", daily, lifetime, endsAt, currency });
          if (setLevel.length === 0) {
            turnedOn = true;
            record(dc, "turned_on", mc.id, "campaign", `${dc.name} was turned on in Meta Ads Manager.`, { status: "stopped" }, { status: "live", dailyBudgetMinor: daily }, currency);
          }
        } else if (cc.status === "live") {
          const before = cc.dailyBudgetMinor;
          if ((daily ?? 0n) !== (before ?? 0n) || (lifetime ?? null) !== (cc.lifetimeBudgetMinor ?? null)) {
            await setBudget(cc, daily, lifetime);
            const up = (daily ?? 0n) > (before ?? 0n);
            record(dc, up ? "budget_up" : "budget_down", mc.id, "campaign", `The budget of ${dc.name} was changed in Meta Ads Manager.`, { dailyBudgetMinor: before }, { dailyBudgetMinor: daily }, currency);
            if (up) notice(dc, `budget:${mc.id}:${String(daily)}`, "Budget changed in Meta Ads Manager", `The daily budget of ${dc.name} was changed in Meta Ads Manager from ${fmt(before, currency)} to ${fmt(daily, currency)}.`);
          }
        }
      } else if (cc && cc.status === "live") {
        await stop(cc);
        record(dc, "stopped", mc.id, "campaign", `${dc.name} was paused or removed in Meta Ads Manager.`, { status: "live" }, { status: "stopped" }, currency);
      }
    } else {
      // Ad set budgets. A campaign-level commitment left from earlier stops (the budget moved back to the ad sets).
      for (const c of mine.filter((x) => x.objectLevel === "campaign" && x.status === "live")) {
        await stop(c);
        record(dc, "budget_level", c.metaObjectId, "campaign", `The budget of ${dc.name} was moved back to its ad sets in Meta Ads Manager.`, { level: "campaign" }, { level: "adset" }, currency);
      }
      for (const s of sets) {
        const c = mine.find((x) => x.metaObjectId === s.id);
        const dbSet = dbSets.find((x) => x.metaAdSetId === s.id) ?? null;
        const running = campaignRunning && runningOf(s) && !deadOf(s);
        const daily = budget(s.daily_budget);
        const lifetime = budget(s.lifetime_budget);
        if (running) {
          if (daily === null && lifetime === null) continue;
          if (!c) {
            const origin = dbSet ? (["human", "assistant", "api"].includes(dc.origin) ? dc.origin : "human") : "human";
            const end = earliest(time(s.end_time), campaignEnd);
            await createLive(dc, { adSetId: dbSet?.id ?? null, metaObjectId: s.id, objectLevel: "adset", origin, daily, lifetime, endsAt: end ?? (origin === "assistant" && lifetime === null ? horizon : null), currency });
            if (dbSet) {
              turnedOn = true;
              record(dc, "turned_on", s.id, "adset", `${dc.name} was turned on in Meta Ads Manager.`, { status: "stopped" }, { status: "live", dailyBudgetMinor: daily }, currency);
            } else {
              record(dc, "new_adset", s.id, "adset", `An ad set was added to ${dc.name} in Meta Ads Manager.`, null, { status: "live", dailyBudgetMinor: daily, origin: "human" }, currency);
              notice(dc, `newset:${s.id}`, "New ad set in Meta Ads Manager", `${dc.name} got a new ad set in Meta Ads Manager with a daily budget of ${fmt(daily, currency)}. It now counts against your limits.`);
            }
          } else if (c.status === "live" || c.status === "unconfirmed") {
            const before = c.dailyBudgetMinor;
            const changed = (daily ?? null) !== (before ?? null) || (lifetime ?? null) !== (c.lifetimeBudgetMinor ?? null);
            if (changed && c.status === "live") {
              await setBudget(c, daily, lifetime);
              const up = (daily ?? 0n) > (before ?? 0n) || (lifetime ?? 0n) > (c.lifetimeBudgetMinor ?? 0n);
              record(dc, up ? "budget_up" : "budget_down", s.id, "adset", `The budget of an ad set of ${dc.name} was changed in Meta Ads Manager.`, { dailyBudgetMinor: before, lifetimeBudgetMinor: c.lifetimeBudgetMinor }, { dailyBudgetMinor: daily, lifetimeBudgetMinor: lifetime }, currency);
              if (up) notice(dc, `budget:${s.id}:${String(daily)}:${String(lifetime)}`, "Budget changed in Meta Ads Manager", `The daily budget of ${dc.name} was changed in Meta Ads Manager from ${fmt(before, currency)} to ${fmt(daily, currency)}.`);
            }
          }
        } else if (c && c.status === "live") {
          // Paused, archived or deleted on Meta: stopped, as recordLowering would.
          await stop(c);
          record(dc, "stopped", s.id, "adset", `An ad set of ${dc.name} was paused or removed in Meta Ads Manager.`, { status: "live" }, { status: "stopped", meta: upper(s.effective_status || s.status) }, currency);
        }
      }
    }

    // End dates (removed, moved later or earlier). The open external_edit breaker marks a removal already handled, so a
    // month-end horizon that rolls forward is not reported again.
    const fresh = (((await tx.spendCommitment.findMany({ where: { tenantId, campaignId: dc.id, status: { in: ["live", "unconfirmed"] } } })) ?? []) as Record<string, unknown>[]).map(toBookCommitment);
    const edit = (await tx.spendBreaker.findFirst({ where: { tenantId, kind: "external_edit", scopeType: "campaign", scopeId: dc.id, state: "tripped" } })) as { details?: unknown } | null;
    const editWhy = edit?.details && typeof edit.details === "object" ? (edit.details as { why?: unknown }).why : null;
    let removed = false;
    let later = false;
    let earlier = false;
    let allHaveEnd = fresh.length > 0;
    for (const c of fresh) {
      const s = c.objectLevel === "adset" ? sets.find((x) => x.id === c.metaObjectId) : undefined;
      if (c.objectLevel === "adset" && !s) continue;
      const observed = c.objectLevel === "adset" ? earliest(time(s!.end_time), campaignEnd) : campaignEnd;
      const current = c.endsAt;
      if (observed === null) {
        allHaveEnd = false;
        if (c.origin === "assistant" && c.lifetimeBudgetMinor === null) {
          // An assistant's commitment always keeps a counting horizon (the CHECK constraint): the account month end.
          if (current === null || current.getTime() !== horizon.getTime()) await setEnd(c, horizon);
          if (!edit) {
            removed = true;
            record(dc, "end_removed", c.metaObjectId, c.objectLevel, `${dc.name} no longer has an end date.`, { endsAt: current }, { endsAt: horizon, horizon: true }, currency);
          }
        } else if (current !== null) {
          await setEnd(c, null);
          record(dc, "end_removed", c.metaObjectId, c.objectLevel, `${dc.name} no longer has an end date.`, { endsAt: current }, { endsAt: null }, currency);
        }
      } else if (current === null || observed.getTime() !== current.getTime()) {
        const isLater = current === null || observed.getTime() > current.getTime();
        // A horizon Edwyz set (no end on Meta before) being replaced by a real end is the owner setting one again.
        const fromHorizon = current !== null && isMonthHorizon(current, tz);
        await setEnd(c, observed);
        record(dc, isLater ? "end_later" : "end_earlier", c.metaObjectId, c.objectLevel, isLater ? `The end date of ${dc.name} was moved later in Meta Ads Manager.` : `The end date of ${dc.name} was moved earlier in Meta Ads Manager.`, { endsAt: current }, { endsAt: observed }, currency);
        if (isLater && !fromHorizon && current !== null && c.origin === "assistant") later = true;
        if (!isLater) earlier = true;
      }
    }
    if (assistant) {
      if ((removed || later) && !edit) {
        pending.breakers.open.push({ campaignId: dc.id, name: dc.name, why: removed ? "removed" : "later" });
        notice(
          dc,
          `edit:${removed ? "removed" : "later"}:${today}`,
          removed ? "End date removed in Meta Ads Manager" : "End date moved in Meta Ads Manager",
          removed ? `${dc.name} no longer has an end date. Your ad assistant won't change it until you set one.` : `The end date of ${dc.name} was moved later in Meta Ads Manager. Your ad assistant won't change it until you set the end date again.`,
        );
      } else if (edit && ((editWhy !== "later" && allHaveEnd) || (editWhy === "later" && earlier))) {
        pending.breakers.clear.push(dc.id);
      }
      // The DB campaign keeps an end too (its CHECK: an end date or a lifetime budget).
      const allMetaEnds = campaignEnd !== null || (sets.length > 0 && sets.every((s) => time(s.end_time) !== null));
      if (!allMetaEnds && dc.lifetimeBudgetMinor === null && fresh.length > 0 && (!dc.endsAt || dc.endsAt.getTime() !== horizon.getTime()) && (removed || edit)) await setCampaign(dc, { endsAt: horizon });
    } else if (fresh.length > 0 && campaignEnd === null && sets.length > 0 && sets.every((s) => time(s.end_time) === null) && dc.endsAt) {
      await setCampaign(dc, { endsAt: null });
    }

    // The DB campaign's status follows Meta.
    if (deadOf(mc)) {
      if (dc.status !== "archived") await setCampaign(dc, { status: "archived" });
      if (assistant) pending.breakers.clear.push(dc.id);
    } else if (campaignRunning && (sets.length === 0 || sets.some((s) => runningOf(s))) && dc.status !== "active" && fresh.length > 0) {
      await setCampaign(dc, { status: "active" });
      record(dc, "campaign_status", mc.id, "campaign", `${dc.name} was turned on in Meta Ads Manager.`, { status: dc.status }, { status: "active" }, currency);
      turnedOn = true;
    } else if (!campaignRunning && upper(mc.status) === "PAUSED" && dc.status === "active") {
      await setCampaign(dc, { status: "paused" });
    }
    if (turnedOn) notice(dc, `on:${today}`, "Campaign turned on in Meta Ads Manager", `${dc.name} was turned on in Meta Ads Manager. It now counts against your limits.`);
  }
}

/** True for an instant that is a month-end counting horizon (one second before the next account month starts). */
function isMonthHorizon(at: Date, timezone: string): boolean {
  return monthEndHorizon(at, timezone).getTime() === at.getTime();
}

/** Workspaces with platform campaigns but no open commitment get the structure sync every 2 hours. Never throws. */
export async function runStructureSync(io: StructureIo = {}): Promise<StructureResult[]> {
  const db = dbOf(io);
  const out: StructureResult[] = [];
  try {
    const campaigns = ((await db.adCampaign.findMany({ where: { metaCampaignId: { not: null }, status: { in: ["active", "paused"] } }, select: { tenantId: true, adAccountAssetId: true }, take: 5_000 })) ?? []) as { tenantId: string; adAccountAssetId: string }[];
    const busy = new Set((((await db.spendCommitment.findMany({ where: { status: { in: OPEN } }, select: { tenantId: true }, take: 5_000 })) ?? []) as { tenantId: string }[]).map((r) => r.tenantId));
    const pairs = new Map<string, { tenantId: string; adAccountAssetId: string }>();
    for (const c of campaigns) if (!busy.has(c.tenantId)) pairs.set(`${c.tenantId}:${c.adAccountAssetId}`, c);
    for (const p of pairs.values()) {
      try {
        out.push(await syncStructure(p.tenantId, p.adAccountAssetId, io));
      } catch (error) {
        console.error(`[spend] structure sync of ${p.adAccountAssetId} failed: ${describeError(error)}`);
      }
    }
  } catch (error) {
    console.error(`[spend] structure sync: ${describeError(error)}`);
  }
  return out;
}
