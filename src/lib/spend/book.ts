/**
 * The Spend Book, ads half (docs/SPEND-CONTROLS-SPEC.md 4.1 I1-I12, 4.5, 4.6, 7.2, 7.3, 7.5). The only code that decides
 * whether an ads raise may happen.
 *
 * - headroom(tenant, pot): the figures every surface shows. Ads from SpendDaily and the commitments (worst case, never the
 *   nominal budget); WhatsApp and AI from SpendCounter.
 * - reserveAds(): steps 1-13 of 4.6 inside withSpendLock(tenant, 'ads'), then a minted AdsPermit. No network inside the lock:
 *   the fresh Meta-limit read (metacap.ensureFreshRead by default, 15 minutes, only for an account managed in the 5.1 sense)
 *   runs before the lock, and step 8 uses the
 *   stored read. Refusals are standalone `refused` ledger rows written after the locked transaction, then SpendBlockedError
 *   with the 4.13 copy carrying `left` and `needs`. With SPEND_ENFORCE=observe a person's action that fails one of the checks
 *   NEW in Phase 0 goes on (I12): the would-refusal is a standalone refused row with observe=true and snapshot.continuedAs, and
 *   the action gets its normal requested row. Checks enforced today stay enforced: a daily limit must exist, the owner's daily
 *   limit, the currency, and objects are only created PAUSED. Assistants go through policy.ts decide() at step 10:
 *   needs_approval writes a SpendApproval (token hash and fingerprint from approval-token.ts) in the same transaction and
 *   throws NeedsApprovalError; shadow writes an AssistantShadowRecord and throws ShadowOnlyError. Applying an approved
 *   request (opts.approvalId) re-runs every check except that step (7.3). The demo workspace is refused (spend.demo).
 * - assertPermitValid() right before the HTTP call, settleAds() right after (exactly one outcome row).
 * - recordLowering(): never waits, never refused, works while frozen; the Meta call runs with no lock held, and only the
 *   bookkeeping waits for the lock afterwards (a timeout leaves the commitment over-counted for the reconciler).
 * - permitForPausedCreate(): neutral; refused only under a freeze `all`.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { enqueue as enqueueJob } from "@/lib/queue";
import { describeError } from "@/lib/safe-error";
import { HttpError } from "@/lib/tenancy";
import { effectiveLimits, type ResolvedLimits } from "./allowances";
import { approvalFingerprint, newApprovalToken, type FingerprintObject } from "./approval-token";
import { breakerPot, isBlocked, isOpen, listBreakers, openBreaker, toOpenRef, type BreakerScopeRef } from "./breakers/state";
import {
  computeAdsFigures,
  countedCommitments,
  isMetaLimitManaged,
  loadActiveCampaigns,
  loadAdAccounts,
  loadAdsBook,
  OPEN_STATUSES,
  orphanCommitments,
  rolledPeaks,
  toBookCommitment,
  toMetaLimitRow,
  type AdAccountInfo,
  type AdsBookState,
  type AdsFigures,
  type BookCommitment,
} from "./commitments";
import { getControl, type SpendControlState, type SpendDb } from "./control";
import type { SpendCopyCode, SpendCopyParams } from "./copy";
import { counterKeys, readCounters } from "./counters";
import { isDemoWorkspace } from "./demo";
import { NeedsApprovalError, ShadowOnlyError, SpendBlockedError, SpendGuardBypassError } from "./errors";
import { assistantSpendEnabled, spendEnforceMode } from "./flags";
import { jsonSafe } from "./http";
import { freezeRefusal, spendState } from "./kill";
import { appendOutcome, appendRequest, appendStandalone, newCorrelationId, type LedgerDb } from "./ledger";
import { heldSpendLocks, withSpendLock, type SpendLockClient } from "./lock";
import { formatMinor, isCurrencyCode } from "./money";
import { notifySpend } from "./notify";
import { isMintedPermit, mintPermit, runWithPermit } from "./permit";
import { dateToDayKey, dayKey, dayKeyToDate } from "./periods";
import { decide, policyReasonText, type PolicyDecision, type PolicyDelta, type PolicyHeadroom, type PolicyIntent, type PolicyMandate } from "./policy";
import { SANDBOX_REASON_CODE } from "./sandbox";
import {
  PERMIT_TTL_MS,
  SPEND_QUEUES,
  type AdsActivateSet,
  type AdsLoweringIntent,
  type AdsPermit,
  type AdsPermitObject,
  type AdsRaiseIntent,
  type AutonomyLevel,
  type CreatePermit,
  type Headroom,
  type LedgerRowInput,
  type LoweringPermit,
  type PeriodFigures,
  type Pot,
  type SpendActor,
  type UndoRecipe,
} from "./types";

type Env = Record<string, string | undefined>;

/** A Prisma client (with $transaction for the lock) or a transaction client. */
export type BookDb = SpendDb & Partial<SpendLockClient>;

export type BookOptions = {
  db?: BookDb;
  now?: Date;
  env?: Env;
  /** Job queue for the metacap re-plan (META_CAP_TOO_LOW). Defaults to the app queue. */
  enqueue?: (queue: string, payload: unknown) => Promise<unknown>;
};

/**
 * Reads Meta's limit of one ad account again and stores it in MetaSpendLimit (the Meta-limit package registers it with
 * setMetaCapPreRead). reserveAds calls it BEFORE taking the spend lock, never inside it (I10), and only for a managed account
 * whose stored read is older than 15 minutes. It must not throw for a failed read: the stored values are used then.
 */
export type MetaCapPreRead = (tenantId: string, adAccountAssetId: string, maxAgeMs: number) => Promise<void>;

/**
 * The default pre-read: metacap.ensureFreshRead (src/lib/spend/metacap/sync.ts), loaded lazily so the book never imports
 * the Meta client at load time. It reads only when the stored read is older than `maxAgeMs` and never throws.
 */
export const defaultMetaCapPreRead: MetaCapPreRead = async (tenantId, adAccountAssetId, maxAgeMs) => {
  const { ensureFreshRead } = await import("./metacap/sync");
  await ensureFreshRead(tenantId, adAccountAssetId, maxAgeMs);
};

/** undefined: the default (metacap.ensureFreshRead); null: no pre-read; a function: that one (tests). */
let metaCapPreRead: MetaCapPreRead | null | undefined = undefined;

/** Registers the fresh Meta-limit read reserveAds runs before the lock (undefined restores the default). Returns the previous one. */
export function setMetaCapPreRead(fn: MetaCapPreRead | null | undefined): MetaCapPreRead | null | undefined {
  const previous = metaCapPreRead;
  metaCapPreRead = fn;
  return previous;
}

/** The pre-read reserveAds uses: the call's own, else the registered one, else the default. */
function activePreRead(fromCall: MetaCapPreRead | null | undefined): MetaCapPreRead | null {
  if (fromCall !== undefined) return fromCall;
  return metaCapPreRead === undefined ? defaultMetaCapPreRead : metaCapPreRead;
}

/** reservedUntil of a fresh reservation (4.6 step 11). */
export const RESERVATION_TTL_MS = 10 * 60_000;
/** Meta allows 4 budget changes an hour per ad set; the book keeps one for safety (4.6 step 9). */
export const BUDGET_CHANGES_PER_HOUR = 3;
export const BUDGET_QUOTA_WINDOW_MS = 60 * 60_000;
/** The stored Meta limit read may be used inside the lock while it is younger than this (4.6 step 8). */
export const META_READ_MAX_AGE_MS = 6 * 3_600_000;
/** Before the lock, a managed account's Meta limit is read again when the stored read is older than this (4.6 step 8). */
export const META_READ_FRESH_MS = 15 * 60_000;
/** Meta's own error when an ad set had too many budget changes. */
export const META_BUDGET_QUOTA_ERROR = { code: 613, subcode: 1487632 } as const;

const ACTION_OF: Record<AdsRaiseIntent["kind"], string> = {
  activate: "ads.campaign.activate",
  raise_budget: "ads.adset.budget_raise",
  resume_ad: "ads.ad.resume",
  resume_adset: "ads.adset.resume",
  extend_end: "ads.campaign.extend_end",
  create_live: "ads.campaign.create_live",
};
const BUDGET_ACTIONS = ["ads.adset.budget_raise", "ads.adset.budget_cut"];

const max0 = (x: bigint): bigint => (x < 0n ? 0n : x);
const big = (v: unknown): bigint | null => (v === null || v === undefined ? null : typeof v === "bigint" ? v : BigInt(v as number | string));
const isAssistant = (actor: SpendActor): actor is Extract<SpendActor, { type: "assistant" }> => actor.type === "assistant";
const json = (v: unknown): Prisma.InputJsonValue => jsonSafe(v ?? null) as Prisma.InputJsonValue;
const ledgerDb = (db: unknown): LedgerDb => db as LedgerDb;
const lockOpts = (db: BookDb | undefined) => (db && typeof db.$transaction === "function" ? { db: db as unknown as SpendLockClient } : {});

// =====================================================================================================================
// Errors the book adds (the shared ones are in errors.ts)
// =====================================================================================================================

/** An open safety stop (breaker) covers the object, its campaign, the ad account or the workspace (4.6 step 3). */
export class SpendBreakerError extends HttpError {
  readonly code = "spend.breaker" as const;
  readonly breakers: { id: string; kind: string; scopeType: string; scopeId: string }[];
  constructor(breakers: { id: string; kind: string; scopeType: string; scopeId: string }[]) {
    super(409, "A safety stop is on for this campaign, so it can't be turned up or back on yet. See Settings > Spending limits.");
    this.name = "SpendBreakerError";
    this.breakers = breakers;
  }
}

/** The reservation behind a permit expired or was settled before the Meta call. Nothing was sent. */
export class SpendPermitExpiredError extends HttpError {
  readonly code = "spend.permit_expired" as const;
  constructor() {
    super(409, "This took too long, so nothing was changed on Meta. Try again.");
    this.name = "SpendPermitExpiredError";
  }
}

/** A NeedsApprovalError that also carries the one-tap token for the notifier. The token is not enumerable (never serialised). */
export class AdsNeedsApprovalError extends NeedsApprovalError {
  declare readonly token: string;
  readonly summary: string;
  constructor(approvalId: string, expiresAt: Date, token: string, summary: string) {
    super(approvalId, expiresAt);
    Object.defineProperty(this, "token", { value: token, enumerable: false });
    this.summary = summary;
  }
}

// =====================================================================================================================
// Headroom (4.6)
// =====================================================================================================================

export type HeadroomOptions = BookOptions & { fresh?: boolean; currency?: string };

const period = (spent: bigint, committed: bigint, held: bigint, limit: bigint | null): PeriodFigures => ({
  spent,
  committed,
  held,
  left: limit === null ? null : max0(limit - spent - committed - held),
});

export type AdsHeadroomDetail = { headroom: Headroom; figures: AdsFigures; state: AdsBookState; limits: ResolvedLimits };

/** Ads headroom plus the detail behind it (per commitment, other currencies, per account). */
export async function adsHeadroomDetail(tenantId: string, opts: HeadroomOptions = {}): Promise<AdsHeadroomDetail> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const control = await getControl(tenantId, { db, prune: false });
  const state = await loadAdsBook(tenantId, { db, now, env, control });
  const limits = await effectiveLimits(tenantId, "ads", opts.currency ?? state.spendingAccount?.currency ?? undefined, db, { now, env, control });
  const figures = computeAdsFigures(state, countedCommitments(state), limits.currency, env);
  const freeze = await spendState(tenantId, { fresh: opts.fresh === true, db });
  const breakers = (await listBreakers(tenantId, { db, now })).filter((b) => breakerPot(b.kind) !== "messaging").map(toOpenRef);
  const spending = state.spendingAccount;
  const metaRow = spending ? (state.metaLimits.find((m) => m.adAccountAssetId === spending.assetId) ?? null) : null;
  const account = spending ? figures.accounts.find((a) => a.adAccountAssetId === spending.assetId) : undefined;
  const headroom: Headroom = {
    tenantId,
    pot: "ads",
    currency: limits.currency,
    limits,
    month: period(figures.spentMonth, figures.committedMonth, 0n, limits.monthly),
    today: period(figures.spentToday, figures.committedToday, 0n, limits.daily),
    external: { counted: figures.external.counted, spentMonth: figures.external.spentMonth, riskMonth: figures.external.riskMonth, estimated: true },
    freeze,
    breakers,
    probation: limits.probation.on,
    metaLimit: spending ? { managed: isMetaLimitManaged(metaRow, env), mode: metaRow?.mode ?? null, roomMinor: account?.metaRoom ?? null } : null,
    stale: figures.stale,
    computedAt: now,
  };
  return { headroom, figures, state, limits };
}

/** What is spent, set aside and left for one pot, today and this month (4.6). */
export async function headroom(tenantId: string, pot: Pot, opts: HeadroomOptions = {}): Promise<Headroom> {
  if (pot === "ads") return (await adsHeadroomDetail(tenantId, opts)).headroom;
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const control = await getControl(tenantId, { db, prune: false });
  const limits = await effectiveLimits(tenantId, pot, opts.currency, db, { now, env, control });
  const counters = await readCounters(tenantId, pot, counterKeys(now, control.timezone), db);
  const freeze = await spendState(tenantId, { fresh: opts.fresh === true, db });
  const breakers = (await listBreakers(tenantId, { db, now })).filter((b) => breakerPot(b.kind) === pot).map(toOpenRef);
  return {
    tenantId,
    pot,
    currency: limits.currency,
    limits,
    month: period(counters.month.spent, 0n, counters.month.reserved, limits.monthly),
    today: period(counters.day.spent, 0n, counters.day.reserved, limits.daily),
    external: { counted: false, spentMonth: 0n, riskMonth: 0n, estimated: true },
    freeze,
    breakers,
    probation: limits.probation.on,
    metaLimit: null,
    stale: false,
    computedAt: now,
  };
}

// =====================================================================================================================
// Assistant policy (7.2): reserveAds step 10 asks policy.ts decide(). Tests can swap it through setAdsPolicy().
// =====================================================================================================================

/** The mandate as the book reads it (an AssistantMandate row). */
export type MandateLite = PolicyMandate & { allowedOps: string[]; sandboxOnly: boolean };

/** Everything step 10 hands to the policy. The book has already refused freezes, blocking breakers and missed limits. */
export type AdsPolicyInput = {
  actor: Extract<SpendActor, { type: "assistant" }>;
  intent: PolicyIntent;
  delta: PolicyDelta;
  mandate: MandateLite | null;
  headroom: PolicyHeadroom;
  assistantSpendEnabled: boolean;
  now: Date;
};

export type AdsPolicy = (input: AdsPolicyInput) => PolicyDecision | Promise<PolicyDecision>;

/** policy.ts decide() with the inputs the book gathered (7.2 order: freezes, learning, the flag, the mandate, the fit, the matrix). */
export const defaultAdsPolicy: AdsPolicy = (input) =>
  decide(input.actor, input.intent, input.delta, input.mandate, input.headroom, input.now, { assistantSpendEnabled: input.assistantSpendEnabled });

let activePolicy: AdsPolicy = defaultAdsPolicy;

/** Replaces the assistant policy (tests). Returns the previous one. */
export function setAdsPolicy(policy: AdsPolicy): AdsPolicy {
  const previous = activePolicy;
  activePolicy = policy;
  return previous;
}

/** The refusal a policy `refuse` gives, with the room it needed and what is left (4.13 copy). */
function policyRefusal(decision: PolicyDecision, currency: string, fallback: { left: bigint; needs: bigint }): { refusal: Refusal | null; error?: Error; reasonCode?: string } {
  const money = (minor: bigint | undefined, alt: bigint) => ({ minor: minor ?? alt, currency });
  const reasonCode = `policy_${decision.reason}`;
  switch (decision.reason) {
    case "platform_frozen":
      return { refusal: { code: "spend.platform_frozen", params: {}, reasonCode, isNew: false } };
    case "frozen":
    case "assistants_frozen":
      return { refusal: { code: "spend.frozen", params: {}, reasonCode, isNew: false } };
    case "breaker":
      return { refusal: null, error: new SpendBreakerError([]), reasonCode };
    case "end_date_required":
      return { refusal: { code: "spend.end_date_required", params: {}, reasonCode, isNew: false } };
    case "over_daily_limit":
    case "mandate_daily":
      return { refusal: { code: "spend.daily_limit", params: { left: money(decision.leftMinor, fallback.left), needs: money(decision.needsMinor, fallback.needs) }, reasonCode, isNew: false } };
    case "over_monthly_limit":
    case "mandate_monthly":
    case "no_monthly_limit":
      return { refusal: { code: "spend.monthly_limit", params: { left: money(decision.leftMinor, fallback.left), needs: money(decision.needsMinor, fallback.needs) }, reasonCode, isNew: false } };
    default:
      return { refusal: null, error: new HttpError(409, policyReasonText(decision.reason)), reasonCode };
  }
}

// =====================================================================================================================
// Resolving an intent against the database
// =====================================================================================================================

type CampaignRow = {
  id: string;
  name: string;
  adAccountAssetId: string;
  metaCampaignId: string | null;
  status: string;
  dailyBudgetMinor: bigint;
  lifetimeBudgetMinor: bigint | null;
  currency: string;
  endsAt: Date | null;
  origin: string;
  assistantKey: string | null;
  sandbox: boolean;
};
type AdSetRow = { id: string; name: string; campaignId: string; metaAdSetId: string | null; status: string; dailyBudgetMinor: bigint | null; lifetimeBudgetMinor: bigint | null };

/** One commitment the intent sets (or keeps) at reserved. */
type Change = {
  campaign: CampaignRow;
  adSetId: string | null;
  metaObjectId: string;
  objectLevel: "campaign" | "adset";
  /** undefined = keep the current value. */
  dailyBudgetMinor?: bigint | null;
  lifetimeBudgetMinor?: bigint | null;
  endsAt?: Date | null;
  raise: boolean;
};

type Resolved = {
  adAccountAssetId: string;
  campaign: CampaignRow;
  targetType: "campaign" | "adset" | "ad";
  targetId: string;
  metaObjectId: string | null;
  objects: Record<string, AdsPermitObject>;
  changes: Change[];
  /** Simulation only: the paired, already applied cut of a budget shift counts as freed. */
  shiftFromAdSetId: string | null;
  summary: string;
  undo: UndoRecipe | null;
  amountMinor: bigint | null;
  hasEndDate: boolean;
};

const toCampaignRow = (r: Record<string, unknown>): CampaignRow => ({
  id: String(r.id),
  name: String(r.name ?? ""),
  adAccountAssetId: String(r.adAccountAssetId),
  metaCampaignId: (r.metaCampaignId as string | null) ?? null,
  status: String(r.status ?? ""),
  dailyBudgetMinor: big(r.dailyBudgetMinor) ?? 0n,
  lifetimeBudgetMinor: big(r.lifetimeBudgetMinor),
  currency: String(r.currency ?? "INR"),
  endsAt: r.endsAt instanceof Date ? r.endsAt : r.endsAt ? new Date(String(r.endsAt)) : null,
  origin: String(r.origin ?? "human"),
  assistantKey: (r.assistantKey as string | null) ?? null,
  sandbox: r.sandbox === true,
});
const toAdSetRow = (r: Record<string, unknown>): AdSetRow => ({
  id: String(r.id),
  name: String(r.name ?? ""),
  campaignId: String(r.campaignId),
  metaAdSetId: (r.metaAdSetId as string | null) ?? null,
  status: String(r.status ?? ""),
  dailyBudgetMinor: big(r.dailyBudgetMinor),
  lifetimeBudgetMinor: big(r.lifetimeBudgetMinor),
});

const notFound = (what: string) => new HttpError(404, `${what} not found.`);

async function campaignById(db: SpendDb, tenantId: string, id: string): Promise<CampaignRow> {
  const row = (await db.adCampaign.findFirst({ where: { id, tenantId } })) as Record<string, unknown> | null;
  if (!row) throw notFound("Campaign");
  return toCampaignRow(row);
}

async function adSetsOf(db: SpendDb, tenantId: string, campaignId: string): Promise<AdSetRow[]> {
  return (((await db.adSet.findMany({ where: { tenantId, campaignId } })) ?? []) as Record<string, unknown>[]).map(toAdSetRow);
}

async function adSetById(db: SpendDb, tenantId: string, id: string): Promise<AdSetRow> {
  const row = (await db.adSet.findFirst({ where: { id, tenantId } })) as Record<string, unknown> | null;
  if (!row) throw notFound("Ad set");
  return toAdSetRow(row);
}

const quote = (name: string) => `'${name}'`;

function setBudget(set: AdSetRow, campaign: CampaignRow): { daily: bigint | null; lifetime: bigint | null } {
  // The ad set's own budget, else the campaign's; an ad set with only a lifetime budget is lifetime-only (4.5).
  const lifetime = set.lifetimeBudgetMinor ?? campaign.lifetimeBudgetMinor;
  if (set.dailyBudgetMinor !== null) return { daily: set.dailyBudgetMinor, lifetime };
  if (set.lifetimeBudgetMinor !== null) return { daily: null, lifetime };
  return { daily: campaign.dailyBudgetMinor > 0n || lifetime === null ? campaign.dailyBudgetMinor : null, lifetime };
}

async function resolveIntent(db: SpendDb, tenantId: string, intent: AdsRaiseIntent): Promise<Resolved> {
  switch (intent.kind) {
    case "activate": {
      const campaign = await campaignById(db, tenantId, intent.campaignId);
      const sets = await adSetsOf(db, tenantId, campaign.id);
      const objects: Record<string, AdsPermitObject> = {};
      if (campaign.metaCampaignId) objects[campaign.metaCampaignId] = { status: "ACTIVE" };
      const changes: Change[] = [];
      const wanted: AdsActivateSet[] = intent.sets.length > 0 ? intent.sets : sets.filter((s) => s.metaAdSetId).map((s) => ({ adSetId: s.id, metaAdSetId: s.metaAdSetId! }));
      for (const s of wanted) {
        const row = sets.find((x) => x.id === s.adSetId || (x.metaAdSetId !== null && x.metaAdSetId === s.metaAdSetId));
        const db_ = row ? setBudget(row, campaign) : { daily: campaign.dailyBudgetMinor, lifetime: campaign.lifetimeBudgetMinor };
        const daily = s.dailyBudgetMinor !== undefined ? s.dailyBudgetMinor : db_.daily;
        const lifetime = s.lifetimeBudgetMinor !== undefined ? s.lifetimeBudgetMinor : db_.lifetime;
        const endsAt = s.endsAt ?? campaign.endsAt;
        changes.push({ campaign, adSetId: row?.id ?? s.adSetId, metaObjectId: s.metaAdSetId, objectLevel: "adset", dailyBudgetMinor: daily, lifetimeBudgetMinor: lifetime, endsAt, raise: true });
        objects[s.metaAdSetId] = {
          status: "ACTIVE",
          ...(daily !== null ? { maxDailyMinor: daily } : {}),
          ...(lifetime !== null ? { maxLifetimeMinor: lifetime } : {}),
          ...(endsAt ? { endsAt } : {}),
        };
      }
      if (changes.length === 0) {
        if (!campaign.metaCampaignId) throw new HttpError(409, "This campaign has not been created on Meta yet. Launch it first.");
        changes.push({ campaign, adSetId: null, metaObjectId: campaign.metaCampaignId, objectLevel: "campaign", dailyBudgetMinor: campaign.dailyBudgetMinor, lifetimeBudgetMinor: campaign.lifetimeBudgetMinor, endsAt: campaign.endsAt, raise: true });
      }
      const setIds = sets.map((s) => s.id);
      if (setIds.length > 0) {
        const ads = ((await db.ad.findMany({ where: { tenantId, adSetId: { in: setIds } }, select: { metaAdId: true, status: true } })) ?? []) as { metaAdId: string | null; status?: string }[];
        for (const ad of ads) if (ad.metaAdId && ad.status !== "archived") objects[ad.metaAdId] = { status: "ACTIVE" };
      }
      return {
        adAccountAssetId: campaign.adAccountAssetId,
        campaign,
        targetType: "campaign",
        targetId: campaign.id,
        metaObjectId: campaign.metaCampaignId,
        objects,
        changes,
        shiftFromAdSetId: null,
        summary: `Turn on ${quote(campaign.name)}`,
        undo: { action: "pause_campaign", campaignId: campaign.id },
        amountMinor: changes.reduce((s, c) => s + (c.dailyBudgetMinor ?? 0n), 0n),
        hasEndDate: changes.every((c) => !!c.endsAt || (c.lifetimeBudgetMinor ?? null) !== null),
      };
    }
    case "raise_budget": {
      const set = await adSetById(db, tenantId, intent.adSetId);
      const campaign = await campaignById(db, tenantId, set.campaignId);
      const from = setBudget(set, campaign).daily;
      const money = (minor: bigint) => formatMinor(minor, campaign.currency);
      return {
        adAccountAssetId: campaign.adAccountAssetId,
        campaign,
        targetType: "adset",
        targetId: set.id,
        metaObjectId: intent.metaAdSetId,
        objects: { [intent.metaAdSetId]: { maxDailyMinor: intent.toMinor } },
        changes: [{ campaign, adSetId: set.id, metaObjectId: intent.metaAdSetId, objectLevel: "adset", dailyBudgetMinor: intent.toMinor, raise: true }],
        shiftFromAdSetId: intent.shiftFromAdSetId ?? null,
        summary: from !== null ? `Raise the daily budget of ${quote(set.name || campaign.name)} from ${money(from)} to ${money(intent.toMinor)}` : `Set the daily budget of ${quote(set.name || campaign.name)} to ${money(intent.toMinor)}`,
        undo: from !== null ? { action: "set_adset_budget", adSetId: set.id, metaAdSetId: intent.metaAdSetId, dailyBudgetMinor: from.toString() } : null,
        amountMinor: intent.toMinor,
        hasEndDate: !!campaign.endsAt || setBudget(set, campaign).lifetime !== null,
      };
    }
    case "resume_adset": {
      const set = await adSetById(db, tenantId, intent.adSetId);
      const campaign = await campaignById(db, tenantId, set.campaignId);
      const b = setBudget(set, campaign);
      return {
        adAccountAssetId: campaign.adAccountAssetId,
        campaign,
        targetType: "adset",
        targetId: set.id,
        metaObjectId: intent.metaAdSetId,
        objects: { [intent.metaAdSetId]: { status: "ACTIVE", ...(b.daily !== null ? { maxDailyMinor: b.daily } : {}) } },
        changes: [{ campaign, adSetId: set.id, metaObjectId: intent.metaAdSetId, objectLevel: "adset", dailyBudgetMinor: b.daily, lifetimeBudgetMinor: b.lifetime, endsAt: campaign.endsAt, raise: false }],
        shiftFromAdSetId: null,
        summary: `Turn ${quote(set.name || campaign.name)} back on`,
        undo: { action: "pause_adset", adSetId: set.id, metaAdSetId: intent.metaAdSetId },
        amountMinor: b.daily,
        hasEndDate: !!campaign.endsAt || b.lifetime !== null,
      };
    }
    case "resume_ad": {
      const ad = (await db.ad.findFirst({ where: { id: intent.adId, tenantId }, select: { id: true, adSetId: true, name: true } })) as { id: string; adSetId: string; name?: string } | null;
      if (!ad) throw notFound("Ad");
      const set = await adSetById(db, tenantId, ad.adSetId);
      const campaign = await campaignById(db, tenantId, set.campaignId);
      const b = setBudget(set, campaign);
      const metaObjectId = set.metaAdSetId ?? campaign.metaCampaignId;
      if (!metaObjectId) throw new HttpError(409, "This ad has not been created on Meta yet. Launch it first.");
      return {
        adAccountAssetId: campaign.adAccountAssetId,
        campaign,
        targetType: "ad",
        targetId: ad.id,
        metaObjectId: intent.metaAdId,
        objects: { [intent.metaAdId]: { status: "ACTIVE" } },
        changes: [{ campaign, adSetId: set.metaAdSetId ? set.id : null, metaObjectId, objectLevel: set.metaAdSetId ? "adset" : "campaign", dailyBudgetMinor: b.daily, lifetimeBudgetMinor: b.lifetime, endsAt: campaign.endsAt, raise: false }],
        shiftFromAdSetId: null,
        summary: `Turn an ad in ${quote(campaign.name)} back on`,
        undo: { action: "pause_ad", adId: ad.id, metaAdId: intent.metaAdId },
        amountMinor: null,
        hasEndDate: !!campaign.endsAt || b.lifetime !== null,
      };
    }
    case "extend_end": {
      const campaign = await campaignById(db, tenantId, intent.campaignId);
      const sets = (await adSetsOf(db, tenantId, campaign.id)).filter((s) => s.metaAdSetId);
      const changes: Change[] = sets.map((s) => ({ campaign, adSetId: s.id, metaObjectId: s.metaAdSetId!, objectLevel: "adset", ...setBudgetChange(s, campaign), endsAt: intent.endsAt, raise: true }));
      if (changes.length === 0 && campaign.metaCampaignId) changes.push({ campaign, adSetId: null, metaObjectId: campaign.metaCampaignId, objectLevel: "campaign", dailyBudgetMinor: campaign.dailyBudgetMinor, lifetimeBudgetMinor: campaign.lifetimeBudgetMinor, endsAt: intent.endsAt, raise: true });
      if (changes.length === 0) throw new HttpError(409, "This campaign has not been created on Meta yet. Launch it first.");
      const objects: Record<string, AdsPermitObject> = {};
      for (const c of changes) objects[c.metaObjectId] = { endsAt: intent.endsAt };
      return {
        adAccountAssetId: campaign.adAccountAssetId,
        campaign,
        targetType: "campaign",
        targetId: campaign.id,
        metaObjectId: campaign.metaCampaignId,
        objects,
        changes,
        shiftFromAdSetId: null,
        summary: `Move the end date of ${quote(campaign.name)} later`,
        undo: { action: "set_campaign_end", campaignId: campaign.id, endsAt: campaign.endsAt ? campaign.endsAt.toISOString() : null },
        amountMinor: null,
        hasEndDate: true,
      };
    }
    case "create_live":
      throw new HttpError(400, "New ads are always created paused, then turned on with your limits checked.");
  }
}

function setBudgetChange(set: AdSetRow, campaign: CampaignRow): { dailyBudgetMinor: bigint | null; lifetimeBudgetMinor: bigint | null } {
  const b = setBudget(set, campaign);
  return { dailyBudgetMinor: b.daily, lifetimeBudgetMinor: b.lifetime };
}

// =====================================================================================================================
// Simulation (4.6 step 6)
// =====================================================================================================================

type Simulated = { after: BookCommitment[]; touched: BookCommitment[]; previous: (BookCommitment | null)[] };

function findOpen(list: BookCommitment[], change: Pick<Change, "metaObjectId" | "adSetId" | "objectLevel" | "campaign">): BookCommitment | null {
  return (
    list.find((c) => c.metaObjectId === change.metaObjectId) ??
    (change.adSetId ? list.find((c) => c.adSetId === change.adSetId) : undefined) ??
    (change.objectLevel === "campaign" ? list.find((c) => c.objectLevel === "campaign" && c.campaignId === change.campaign.id) : undefined) ??
    null
  );
}

function simulate(base: BookCommitment[], resolved: Resolved, account: AdAccountInfo | null, tenantId: string, now: Date, actor: SpendActor, correlationId: string): Simulated {
  const after = [...base];
  const touched: BookCommitment[] = [];
  const previous: (BookCommitment | null)[] = [];
  for (const change of resolved.changes) {
    const existing = findOpen(after, change);
    const tz = existing?.timezone ?? account?.timezone ?? "Asia/Kolkata";
    const daily = change.dailyBudgetMinor !== undefined ? change.dailyBudgetMinor : (existing?.dailyBudgetMinor ?? null);
    const lifetime = change.lifetimeBudgetMinor !== undefined ? change.lifetimeBudgetMinor : (existing?.lifetimeBudgetMinor ?? null);
    const rolled = existing ? rolledPeaks(existing, now) : rolledPeaks({ dailyBudgetMinor: daily, dayKey: null, peakDailyBudgetMinor: 0n, weekStart: null, weekPeakDailyBudgetMinor: 0n, timezone: tz }, now);
    const d = daily ?? 0n;
    const sameDay = existing?.dayKey === rolled.today;
    const next: BookCommitment = {
      id: existing && !existing.synthetic ? existing.id : null,
      synthetic: !existing || existing.synthetic,
      tenantId,
      adAccountAssetId: change.campaign.adAccountAssetId,
      campaignId: change.campaign.id,
      adSetId: change.adSetId,
      metaObjectId: change.metaObjectId,
      objectLevel: change.objectLevel,
      origin: existing?.origin ?? (["human", "assistant", "api"].includes(change.campaign.origin) ? change.campaign.origin : actor.type === "assistant" ? "assistant" : "human"),
      assistantKey: existing?.assistantKey ?? change.campaign.assistantKey,
      currency: change.campaign.currency,
      timezone: tz,
      dailyBudgetMinor: daily,
      lifetimeBudgetMinor: lifetime,
      pendingFromMinor: change.raise && existing ? existing.dailyBudgetMinor : null,
      dayKey: rolled.today,
      dayStartBudgetMinor: existing ? (sameDay ? (existing.dayStartBudgetMinor ?? existing.dailyBudgetMinor) : existing.dailyBudgetMinor) : daily,
      peakDailyBudgetMinor: rolled.peakToday > d ? rolled.peakToday : d,
      weekStart: rolled.week,
      weekPeakDailyBudgetMinor: rolled.weekPeak > d ? rolled.weekPeak : d,
      startsAt: existing?.startsAt ?? null,
      endsAt: change.endsAt !== undefined ? change.endsAt : (existing?.endsAt ?? change.campaign.endsAt),
      status: "reserved",
      reservedUntil: new Date(now.getTime() + RESERVATION_TTL_MS),
      correlationId,
      sandbox: (existing?.sandbox ?? false) || change.campaign.sandbox || account?.sandbox === true,
      version: (existing?.version ?? 0) + 1,
      updatedAt: now,
    };
    if (existing) after.splice(after.indexOf(existing), 1, next);
    else after.push(next);
    touched.push(next);
    previous.push(existing);
  }
  if (resolved.shiftFromAdSetId) {
    // The paired cut is already applied; for this check it counts as freed (its peak back to its budget). Never stored.
    const from = after.find((c) => c.adSetId === resolved.shiftFromAdSetId);
    if (from && !touched.includes(from)) {
      const d = from.dailyBudgetMinor ?? 0n;
      after.splice(after.indexOf(from), 1, { ...from, dayKey: dayKey(now, from.timezone), peakDailyBudgetMinor: d, weekPeakDailyBudgetMinor: d });
    }
  }
  return { after, touched, previous };
}

// =====================================================================================================================
// reserveAds (4.6 steps 1-13)
// =====================================================================================================================

export type ReserveAdsOptions = BookOptions & {
  idempotencyKey: string;
  reason: string;
  /** An approved SpendApproval being applied: every check runs again except the autonomy step (7.3). */
  approvalId?: string;
  /** The optimizer proposal behind an assistant action (stored on a SpendApproval). */
  proposalId?: string;
  /** A breaker resuming after its own daily_limit clear passes only its own breaker (4.6 step 3). */
  exemptBreakerId?: string;
  reasonCodes?: string[];
  policy?: AdsPolicy;
  /** Overrides the registered Meta pre-read (setMetaCapPreRead); null turns it off for this call. */
  metaPreRead?: MetaCapPreRead | null;
};

/** The ad account an ads intent touches (one small read chain, no lock). Null when it cannot be found. */
async function adAccountOfIntent(db: SpendDb, tenantId: string, intent: AdsRaiseIntent): Promise<string | null> {
  const campaignAccount = async (campaignId: string | null | undefined) => {
    if (!campaignId) return null;
    const c = (await db.adCampaign.findFirst({ where: { id: campaignId, tenantId }, select: { adAccountAssetId: true } })) as { adAccountAssetId?: string } | null;
    return c?.adAccountAssetId ?? null;
  };
  const setCampaign = async (adSetId: string | null | undefined) => {
    if (!adSetId) return null;
    const s = (await db.adSet.findFirst({ where: { id: adSetId, tenantId }, select: { campaignId: true } })) as { campaignId?: string } | null;
    return s?.campaignId ?? null;
  };
  switch (intent.kind) {
    case "activate":
    case "extend_end":
      return campaignAccount(intent.campaignId);
    case "raise_budget":
    case "resume_adset":
      return campaignAccount(await setCampaign(intent.adSetId));
    case "resume_ad": {
      const ad = (await db.ad.findFirst({ where: { id: intent.adId, tenantId }, select: { adSetId: true } })) as { adSetId?: string } | null;
      return campaignAccount(await setCampaign(ad?.adSetId));
    }
    default:
      return null;
  }
}

/**
 * Before the lock: when the intent's ad account has a managed Meta limit whose stored read is older than 15 minutes, the
 * registered pre-read reads it again. Never inside a spend lock, never throws: a failed read leaves the stored values, which
 * step 8 uses while they are under 6 hours old.
 */
async function freshenMetaRead(db: SpendDb, tenantId: string, intent: AdsRaiseIntent, env: Env, now: Date, preRead: MetaCapPreRead | null): Promise<void> {
  if (!preRead || heldSpendLocks().length > 0) return;
  try {
    const assetId = await adAccountOfIntent(db, tenantId, intent);
    if (!assetId) return;
    const raw = (await db.metaSpendLimit.findFirst({ where: { adAccountAssetId: assetId, tenantId } })) as Record<string, unknown> | null;
    if (!raw) return;
    const row = toMetaLimitRow(raw);
    if (!isMetaLimitManaged(row, env)) return;
    if (row.lastReadAt && now.getTime() - row.lastReadAt.getTime() <= META_READ_FRESH_MS) return;
    await preRead(tenantId, assetId, META_READ_FRESH_MS);
  } catch (error) {
    console.error(`[spend] Meta limit pre-read failed; the stored read is used: ${describeError(error)}`);
  }
}

type Refusal = { code: SpendCopyCode; params: SpendCopyParams; reasonCode: string; isNew: boolean };
type LockOutcome =
  | { kind: "permit"; permit: AdsPermit; queueReplan?: { adAccountAssetId: string } }
  | { kind: "refused"; refusal: Refusal | null; error?: Error; reasonCode?: string; snapshot: unknown; queueReplan?: { adAccountAssetId: string } }
  | { kind: "approval"; approvalId: string; expiresAt: Date; token: string; summary: string; notice: { assistantKey: string } }
  | { kind: "shadow"; shadowRecordId: string };

const PERMITS = new Map<string, AdsPermit>();
const PERMIT_ACTORS = new WeakMap<object, SpendActor>();

function rememberPermit(permit: AdsPermit, actor: SpendActor): void {
  const nowMs = Date.now();
  for (const [k, p] of PERMITS) if (p.expiresAt.getTime() <= nowMs) PERMITS.delete(k);
  PERMITS.set(`${permit.tenantId}:${permit.correlationId}`, permit);
  PERMIT_ACTORS.set(permit, actor);
}

/** Test hook: forgets the in-process permit cache. */
export function resetBookForTests(): void {
  PERMITS.clear();
  activePolicy = defaultAdsPolicy;
  metaCapPreRead = null;
}

type SavedPermit = { kind: AdsRaiseIntent["kind"]; adAccountAssetId: string; accountExternalId: string; objects: Record<string, { maxDailyMinor?: string; maxLifetimeMinor?: string; status?: "ACTIVE"; endsAt?: string }>; paths: string[]; maxUses: number; issuedAt: string; expiresAt: string };

// Built field by field instead of casting jsonSafe()'s output: rule B8 forbids `as …Permit` anywhere in src/lib/spend,
// and the explicit copy also lets the compiler check that every saved field is a plain JSON value.
function permitSnapshot(p: { kind: AdsRaiseIntent["kind"]; adAccountAssetId: string; accountExternalId: string; objects: Record<string, AdsPermitObject>; paths: string[]; maxUses: number; issuedAt: Date; expiresAt: Date }): SavedPermit {
  const objects: SavedPermit["objects"] = {};
  for (const [id, o] of Object.entries(p.objects)) {
    objects[id] = {
      ...(o.maxDailyMinor !== undefined ? { maxDailyMinor: o.maxDailyMinor.toString() } : {}),
      ...(o.maxLifetimeMinor !== undefined ? { maxLifetimeMinor: o.maxLifetimeMinor.toString() } : {}),
      ...(o.status ? { status: o.status } : {}),
      ...(o.endsAt ? { endsAt: o.endsAt.toISOString() } : {}),
    };
  }
  return {
    kind: p.kind,
    adAccountAssetId: p.adAccountAssetId,
    accountExternalId: p.accountExternalId,
    objects,
    paths: [...p.paths],
    maxUses: p.maxUses,
    issuedAt: p.issuedAt.toISOString(),
    expiresAt: p.expiresAt.toISOString(),
  };
}

function permitFromSnapshot(tenantId: string, correlationId: string, s: SavedPermit): AdsPermit {
  const objects: Record<string, AdsPermitObject> = {};
  for (const [id, o] of Object.entries(s.objects ?? {})) {
    objects[id] = {
      ...(o.maxDailyMinor !== undefined ? { maxDailyMinor: BigInt(o.maxDailyMinor) } : {}),
      ...(o.maxLifetimeMinor !== undefined ? { maxLifetimeMinor: BigInt(o.maxLifetimeMinor) } : {}),
      ...(o.status ? { status: o.status } : {}),
      ...(o.endsAt ? { endsAt: new Date(o.endsAt) } : {}),
    };
  }
  return mintPermit({ type: "ads", correlationId, tenantId, kind: s.kind, adAccountAssetId: s.adAccountAssetId, accountExternalId: s.accountExternalId, objects, paths: s.paths, maxUses: s.maxUses, issuedAt: new Date(s.issuedAt), expiresAt: new Date(s.expiresAt) });
}

/**
 * Breakers that stop assistants only (6.2): `pacing` and `sync_stale` block assistant raises (for people, stale data already
 * counts today at the worst case), `external_edit` blocks the assistant on a campaign edited in Ads Manager, and
 * `meta_cap_units` / `meta_cap_unreachable` freeze assistants on the ad account. A person's raise is not refused by them.
 */
export const ASSISTANT_ONLY_BREAKER_KINDS: ReadonlySet<string> = new Set(["pacing", "sync_stale", "external_edit", "meta_cap_units", "meta_cap_unreachable"]);

/** The blocking breakers that apply to this actor. */
function blockingFor<T extends { kind: string }>(actor: SpendActor, result: { blocked: boolean; breakers: T[] }): { blocked: boolean; breakers: T[] } {
  if (isAssistant(actor)) return result;
  const breakers = result.breakers.filter((b) => !ASSISTANT_ONLY_BREAKER_KINDS.has(b.kind));
  return { blocked: breakers.length > 0, breakers };
}

/** The plain sentence a refused row carries. */
function refusalReason(code: SpendCopyCode, params: SpendCopyParams): string {
  return new SpendBlockedError(code, params).message;
}

function breakerScopes(resolved: Resolved, account: AdAccountInfo | null, actor: SpendActor): BreakerScopeRef[] {
  const scopes: BreakerScopeRef[] = [
    { scopeType: "ad_account", scopeId: resolved.adAccountAssetId },
    { scopeType: "campaign", scopeId: resolved.campaign.id },
  ];
  if (account?.externalId) scopes.push({ scopeType: "ad_account", scopeId: account.externalId });
  if (resolved.campaign.metaCampaignId) scopes.push({ scopeType: "campaign", scopeId: resolved.campaign.metaCampaignId });
  for (const c of resolved.changes) {
    if (c.objectLevel === "adset") {
      scopes.push({ scopeType: "adset", scopeId: c.metaObjectId });
      if (c.adSetId) scopes.push({ scopeType: "adset", scopeId: c.adSetId });
    }
  }
  if (actor.type === "assistant") scopes.push({ scopeType: "assistant", scopeId: actor.assistantKey });
  return scopes;
}

function figuresSnapshot(limits: ResolvedLimits | null, f: AdsFigures | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...(limits ? { limits: { daily: limits.daily, monthly: limits.monthly, binding: limits.binding, owner: limits.owner, currency: limits.currency }, ceiling: limits.ceiling, probation: limits.probation.on } : {}),
    ...(f ? { spent: { today: f.spentToday, month: f.spentMonth }, committed: { today: f.committedToday, month: f.committedMonth }, external: { counted: f.external.counted }, stale: f.stale } : {}),
    ...extra,
  };
}

/**
 * Reserves room for an ads raise and returns the permit the Meta call must carry (4.6). Throws SpendBlockedError (refused,
 * with left and needs), SpendBreakerError, SpendBusyError, NeedsApprovalError (an assistant's request now waits for an
 * approver) or ShadowOnlyError (an assistant still learning: recorded, nothing ran).
 */
export async function reserveAds(tenantId: string, intent: AdsRaiseIntent, actor: SpendActor, opts: ReserveAdsOptions): Promise<AdsPermit> {
  if (!tenantId) throw new RangeError("reserveAds needs a workspace.");
  if (!opts?.idempotencyKey) throw new RangeError("reserveAds needs an idempotency key.");
  const reason = (opts.reason ?? "").trim();
  if (!reason) throw new RangeError("reserveAds needs a plain-language reason.");
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const action = ACTION_OF[intent.kind] ?? "ads.raise";
  const policy = opts.policy ?? activePolicy;
  const observeHumans = spendEnforceMode(env) === "observe" && !isAssistant(actor);

  const refuseNow = async (code: SpendCopyCode, params: SpendCopyParams, reasonCode: string, error?: Error): Promise<never> => {
    await appendStandalone(
      { tenantId, pot: "ads", action, phase: "refused", actor, reason: error?.message ?? refusalReason(code, params), reasonCodes: [reasonCode, ...(opts.reasonCodes ?? [])], approvalId: opts.approvalId ?? null, snapshot: { intent } },
      { db: ledgerDb(db) },
    );
    throw error ?? new SpendBlockedError(code, params);
  };

  // The demo workspace never spends (8.4); create_live never exists in Phase 0 (objects are created PAUSED, I12).
  if (await isDemoWorkspace(tenantId, db)) return refuseNow("spend.demo", {}, "demo");
  if (intent.kind === "create_live") return refuseNow("spend.no_limit", {}, "create_live", new HttpError(400, "New ads are always created paused, then turned on with your limits checked."));

  // 8 (first half). A fresh read of Meta's limit happens here, before the lock: never a Meta call while it is held (I10).
  await freshenMetaRead(db, tenantId, intent, env, now, activePreRead(opts.metaPreRead));

  const outcome = await withSpendLock(
    tenantId,
    "ads",
    async (tx): Promise<LockOutcome> => {
      // 1. Idempotency: a request with this key whose permit is still valid is returned as it is.
      const prior = (await tx.spendLedger.findFirst({ where: { tenantId, idempotencyKey: opts.idempotencyKey, phase: "requested" } })) as Record<string, unknown> | null;
      if (prior) {
        const correlationId = String(prior.correlationId);
        const closed = await tx.spendLedger.findFirst({ where: { tenantId, correlationId, phase: { in: ["applied", "failed", "unconfirmed", "refused", "reconciled"] } }, select: { phase: true } });
        const rows = (await tx.spendCommitment.findMany({ where: { tenantId, correlationId } })) as Record<string, unknown>[];
        const valid = !closed && rows.length > 0 && rows.every((r) => r.status === "reserved" && r.reservedUntil instanceof Date && r.reservedUntil.getTime() > now.getTime());
        const snap = (prior.snapshot as { permit?: SavedPermit } | null)?.permit;
        if (valid && snap && new Date(snap.expiresAt).getTime() > now.getTime()) {
          const cached = PERMITS.get(`${tenantId}:${correlationId}`);
          const permit = cached ?? permitFromSnapshot(tenantId, correlationId, snap);
          if (!cached) rememberPermit(permit, actor);
          return { kind: "permit", permit };
        }
        return { kind: "refused", refusal: null, error: new HttpError(409, closed ? "This change was already handled. Reload to see the latest." : "This change took too long and was not made. Try again."), reasonCode: closed ? "already_handled" : "request_expired", snapshot: { idempotencyKey: opts.idempotencyKey, correlationId } };
      }

      // 2. Freezes, read fresh.
      const freeze = await spendState(tenantId, { fresh: true, db: tx });
      const frozen = freezeRefusal(freeze, actor);
      if (frozen) return { kind: "refused", refusal: { code: frozen, params: {}, reasonCode: "frozen", isNew: false }, snapshot: { freeze: freeze.effective } };

      const control = await getControl(tenantId, { db: tx, prune: false });
      const state = await loadAdsBook(tenantId, { db: tx, now, env, control });
      const resolved = await resolveIntent(tx, tenantId, intent);
      const account = state.accounts.find((a) => a.assetId === resolved.adAccountAssetId) ?? null;
      // The account's currency from discovery; an account without one falls back to the campaign's (today's check compares that).
      const accountCurrency = account?.currency ?? (isCurrencyCode(resolved.campaign.currency) ? resolved.campaign.currency : null);

      // 3. Blocking breakers on the object, its campaign, the ad account or the workspace.
      const blocked = blockingFor(
        actor,
        await isBlocked(tenantId, breakerScopes(resolved, account, actor), ["pause_scope", "block_raises"], {
          db: tx,
          now,
          exemptBreakerId: actor.type === "breaker" ? opts.exemptBreakerId : undefined,
        }),
      );
      if (blocked.blocked) {
        const quota = blocked.breakers.find((b) => b.kind === "budget_change_quota");
        if (quota) {
          const row = (await tx.spendBreaker.findFirst({ where: { id: quota.id }, select: { autoClearAt: true } })) as { autoClearAt?: Date | null } | null;
          return { kind: "refused", refusal: { code: "spend.meta_rate", params: { retryAt: row?.autoClearAt ?? new Date(now.getTime() + BUDGET_QUOTA_WINDOW_MS), timezone: account?.timezone }, reasonCode: "budget_change_quota", isNew: false }, snapshot: { breakers: blocked.breakers } };
        }
        return { kind: "refused", refusal: null, error: new SpendBreakerError(blocked.breakers), reasonCode: "breaker", snapshot: { breakers: blocked.breakers } };
      }

      // 4. Limits.
      const limits = await effectiveLimits(tenantId, "ads", accountCurrency ?? undefined, tx, { now, env, control });
      const currency = limits.currency;
      const would: Refusal[] = [];
      /** A refusal: always for assistants and for today's checks; a would-refusal for a person when the check is new (I12). */
      const check = (r: Refusal): LockOutcome | null => {
        if (r.isNew && observeHumans) {
          would.push(r);
          return null;
        }
        return { kind: "refused", refusal: r, snapshot: figuresSnapshot(limits, null) };
      };
      // A currency mismatch reads the owner's limits as Not set, so it is named first: it is the reason, not the missing limit.
      if (!accountCurrency || !limits.currencyMatches || accountCurrency !== currency) {
        return { kind: "refused", refusal: { code: "spend.currency", params: { accountCurrency: accountCurrency ?? undefined, limitCurrency: limits.allowance?.currency ?? currency }, reasonCode: "currency", isNew: false }, snapshot: figuresSnapshot(limits, null) };
      }
      if (limits.daily === null) return { kind: "refused", refusal: { code: "spend.no_limit", params: {}, reasonCode: "no_daily_limit", isNew: false }, snapshot: figuresSnapshot(limits, null) };
      if (limits.monthly === null && isAssistant(actor)) return { kind: "refused", refusal: { code: "spend.monthly_limit", params: { left: { minor: 0n, currency } }, reasonCode: "no_monthly_limit", isNew: false }, snapshot: figuresSnapshot(limits, null) };
      if (limits.unknownCeiling && (isAssistant(actor) || limits.probation.on)) {
        const out = check({ code: "spend.currency", params: { accountCurrency, limitCurrency: "INR" }, reasonCode: "unknown_ceiling", isNew: true });
        if (out) return out;
      }
      if (control.spendingAdAccountAssetId !== resolved.adAccountAssetId) {
        const out = check({ code: "spend.not_spending_account", params: {}, reasonCode: "not_spending_account", isNew: true });
        if (out) return out;
      }
      const correlationId = newCorrelationId();
      if (isAssistant(actor) && resolved.changes.some((c) => c.raise && !c.endsAt && (c.lifetimeBudgetMinor ?? null) === null) && (intent.kind === "activate" || resolved.campaign.origin === "assistant")) {
        return { kind: "refused", refusal: { code: "spend.end_date_required", params: {}, reasonCode: "end_date_required", isNew: false }, snapshot: figuresSnapshot(limits, null) };
      }

      // 5-6. The book and the simulation.
      const base = countedCommitments(state);
      const before = computeAdsFigures(state, base, currency, env);
      const sim = simulate(base, resolved, account, tenantId, now, actor, correlationId);
      const after = computeAdsFigures(state, sim.after, currency, env);
      const deltaDay = max0(after.dayUse - before.dayUse);
      const deltaMonth = max0(after.monthUse - before.monthUse);

      // 7. The limits. The owner's own daily limit is today's check (I12); a ceiling below it is new.
      const ownerDaily = limits.owner.daily;
      if (after.dayUse > limits.daily) {
        const overOwner = ownerDaily !== null && after.dayUse > ownerDaily;
        const probationBinds = limits.dailyBinding === "probation" && !overOwner;
        const left = { minor: max0(limits.daily - before.dayUse), currency };
        const needs = { minor: deltaDay, currency };
        const out = probationBinds
          ? check({ code: "spend.probation", params: probationParams(limits), reasonCode: "probation_daily", isNew: true })
          : check({ code: "spend.daily_limit", params: { left, needs }, reasonCode: "daily_limit", isNew: !overOwner });
        if (out) return { ...out, snapshot: figuresSnapshot(limits, after) } as LockOutcome;
      }
      if (limits.monthly !== null && after.monthUse > limits.monthly) {
        const left = { minor: max0(limits.monthly - before.monthUse), currency };
        const needs = { minor: deltaMonth, currency };
        const out =
          limits.monthlyBinding === "probation"
            ? check({ code: "spend.probation", params: probationParams(limits), reasonCode: "probation_monthly", isNew: true })
            : check({ code: "spend.monthly_limit", params: { left, needs }, reasonCode: "monthly_limit", isNew: true });
        if (out) return { ...out, snapshot: figuresSnapshot(limits, after) } as LockOutcome;
      }

      // 8. Meta's room on a managed account, from the stored read (the fresh pre-read happens before the lock).
      let replan: { adAccountAssetId: string } | undefined;
      const metaRow = state.metaLimits.find((m) => m.adAccountAssetId === resolved.adAccountAssetId) ?? null;
      if (isMetaLimitManaged(metaRow, env)) {
        const acc = after.accounts.find((a) => a.adAccountAssetId === resolved.adAccountAssetId);
        const fresh = metaRow!.lastReadAt && now.getTime() - metaRow!.lastReadAt.getTime() <= META_READ_MAX_AGE_MS;
        const capSet = metaRow!.lastReadCapMinor !== null && metaRow!.lastReadCapMinor > 0n;
        // 5.7: while Meta's limit is loose (a pending-charges floor above the target), raises stop once R ≤ 15% of M.
        let loose = false;
        if (limits.monthly !== null && limits.monthly > 0n) {
          const looseRow = (await tx.metaSpendLimit.findFirst({ where: { adAccountAssetId: resolved.adAccountAssetId, tenantId }, select: { loosenessMinor: true } })) as { loosenessMinor?: bigint | number | null } | null;
          const looseness = looseRow?.loosenessMinor === null || looseRow?.loosenessMinor === undefined ? 0n : BigInt(looseRow.loosenessMinor);
          loose = looseness > 0n && max0(limits.monthly - before.spentMonth) * 100n <= limits.monthly * 15n;
        }
        if (!fresh || loose || (capSet && (acc?.metaRoom ?? 0n) < (acc?.dayRisk ?? 0n))) {
          const r: Refusal = { code: "spend.meta_cap_too_low", params: {}, reasonCode: !fresh ? "meta_read_stale" : loose ? "meta_cap_loose" : "meta_cap_too_low", isNew: true };
          if (!observeHumans) return { kind: "refused", refusal: r, snapshot: figuresSnapshot(limits, after, { metaRoom: acc?.metaRoom ?? null }), queueReplan: { adAccountAssetId: resolved.adAccountAssetId } };
          // Observe mode lets the person's action through; Meta's limit is still asked to make room for it.
          replan = { adAccountAssetId: resolved.adAccountAssetId };
          would.push(r);
        }
      }

      // 9. Meta's budget-change quota: at most 3 budget requests per ad set in 60 minutes (Meta allows 4).
      if (intent.kind === "raise_budget" && actor.type !== "breaker") {
        const since = new Date(now.getTime() - BUDGET_QUOTA_WINDOW_MS);
        const recent = ((await tx.spendLedger.findMany({ where: { tenantId, phase: "requested", metaObjectId: intent.metaAdSetId, action: { in: BUDGET_ACTIONS }, createdAt: { gte: since } }, orderBy: { createdAt: "asc" }, select: { createdAt: true } })) ?? []) as { createdAt: Date }[];
        if (recent.length >= BUDGET_CHANGES_PER_HOUR) {
          const retryAt = new Date(recent[0].createdAt.getTime() + BUDGET_QUOTA_WINDOW_MS);
          const out = check({ code: "spend.meta_rate", params: { retryAt, timezone: account?.timezone }, reasonCode: "budget_change_quota", isNew: true });
          if (out) return out;
        }
      }

      // 10. Assistants go through the policy (not when an approval is being applied).
      let autonomyLevel: AutonomyLevel | null = null;
      if (isAssistant(actor) && !opts.approvalId) {
        const mandateRaw = (await tx.assistantMandate.findUnique({ where: { tenantId_assistantKey: { tenantId, assistantKey: actor.assistantKey } } })) as Record<string, unknown> | null;
        const mandate = mandateRaw ? toMandate(mandateRaw) : null;
        const touched = sim.touched[0];
        const autoRaises = mandate?.enabled && mandate.level === 2 ? await autoRaisesLast24h(tx, tenantId, actor.assistantKey, now) : 0n;
        // This assistant's own use (its campaigns' spend plus worst case), for the mandate's ceilings.
        let ownToday = 0n;
        let ownMonth = 0n;
        for (const f of before.perCommitment) {
          if (f.assistantKey !== actor.assistantKey) continue;
          ownToday += (f.spentToday ?? 0n) + f.dayRisk;
          ownMonth += f.spentMonth + f.remainingMonth;
        }
        // Any open breaker on the scope, blocking or not: a Level 1 automatic raise needs none (7.2).
        const scopes = breakerScopes(resolved, account, actor);
        const onScope = (await listBreakers(tenantId, { db: tx, now })).some((b) => isOpen(b, now) && (b.scopeType === "workspace" || scopes.some((s) => s.scopeType === b.scopeType && s.scopeId === b.scopeId)));
        const decision = await policy({
          actor,
          intent: { op: intent.kind, dayStartBudgetMinor: touched?.dayStartBudgetMinor ?? null, toMinor: intent.kind === "raise_budget" ? intent.toMinor : null, hasEndDate: resolved.hasEndDate },
          delta: { todayMinor: deltaDay, monthMinor: deltaMonth },
          mandate,
          headroom: {
            freeze: { workspace: freeze.workspace, platform: freeze.platform },
            blockingBreaker: false,
            breakerOnScope: onScope,
            dailyLimitMinor: limits.daily,
            monthlyLimitMinor: limits.monthly,
            dayLeftMinor: limits.daily - before.dayUse,
            monthLeftMinor: limits.monthly === null ? null : limits.monthly - before.monthUse,
            metaLimitManaged: isMetaLimitManaged(metaRow, env),
            sandbox: account?.sandbox === true,
            targetCostPerLeadMinor: control.targetCostPerLeadMinor,
            autoRaisesLast24hMinor: autoRaises,
            assistantTodayMinor: ownToday,
            assistantMonthMinor: ownMonth,
          },
          assistantSpendEnabled: assistantSpendEnabled(env),
          now,
        });
        autonomyLevel = decision.level;
        if (decision.verdict === "refuse") {
          const left = limits.monthly === null ? 0n : max0(limits.monthly - before.monthUse);
          const mapped = policyRefusal(decision, currency, { left, needs: deltaMonth });
          return { kind: "refused", refusal: mapped.refusal, error: mapped.error, reasonCode: mapped.reasonCode, snapshot: figuresSnapshot(limits, after, { policy: decision.reason }) };
        }
        if (decision.verdict === "shadow") {
          const would = decision.would ?? "needs_approval";
          const record = await tx.assistantShadowRecord.create({
            data: {
              tenantId,
              assistantKey: actor.assistantKey,
              actionKind: intent.kind,
              intent: json(intent),
              wouldDecision: would,
              forecastMonthMinor: deltaMonth,
              currency,
              reason,
              baseline: json({ before: figuresSnapshot(null, before), objectIds: Object.keys(resolved.objects), wouldReason: decision.wouldReason ?? null, level: mandate?.level ?? 0 }),
            },
            select: { id: true },
          });
          await appendStandalone(
            { tenantId, pot: "ads", action, phase: "shadow", actor, reason, reasonCodes: ["learning", `would_${would}`, ...(decision.wouldReason ? [decision.wouldReason] : [])], targetType: resolved.targetType, targetId: resolved.targetId, metaObjectId: resolved.metaObjectId, currency, forecastTodayMinor: deltaDay, forecastMonthMinor: deltaMonth, snapshot: { ...figuresSnapshot(limits, before), shadowRecordId: record.id }, sandbox: account?.sandbox === true },
            { tx: ledgerDb(tx) },
          );
          return { kind: "shadow", shadowRecordId: String(record.id) };
        }
        if (decision.verdict === "needs_approval") {
          const { token, tokenHash } = newApprovalToken();
          const expiresAt = new Date(now.getTime() + control.approvalTtlHours * 3_600_000);
          const fingerprint = approvalFingerprint({ intent, objects: fingerprintObjects(sim.previous, resolved), allowanceVersion: limits.allowance?.version ?? 0 });
          const approvalCorrelation = newCorrelationId();
          // A newer request about the same object replaces an older one still waiting (7.3 supersede).
          await supersedeOlderApprovals(tx, tenantId, actor, intent, now);
          const approval = await tx.spendApproval.create({
            data: {
              tenantId,
              assistantKey: actor.assistantKey,
              pot: "ads",
              actionKind: intent.kind,
              direction: "raise",
              intent: json(intent),
              fingerprint,
              summary: resolved.summary,
              reason,
              forecastTodayMinor: deltaDay,
              forecastMonthMinor: deltaMonth,
              currency,
              status: "pending",
              tokenHash,
              expiresAt,
              proposalId: opts.proposalId ?? null,
              correlationId: approvalCorrelation,
            },
            select: { id: true },
          });
          await appendStandalone(
            { tenantId, pot: "ads", action: "approval.create", phase: "info", actor, reason, reasonCodes: [decision.reason, ...(decision.suggestion ? ["suggestion"] : [])], approvalId: String(approval.id), targetType: resolved.targetType, targetId: resolved.targetId, metaObjectId: resolved.metaObjectId, currency, forecastTodayMinor: deltaDay, forecastMonthMinor: deltaMonth, correlationId: approvalCorrelation, snapshot: figuresSnapshot(limits, after), sandbox: account?.sandbox === true },
            { tx: ledgerDb(tx) },
          );
          return { kind: "approval", approvalId: String(approval.id), expiresAt, token, summary: resolved.summary, notice: { assistantKey: actor.assistantKey } };
        }
      }

      // Observe mode: one standalone would-refusal row, pointing at the request that goes ahead.
      if (would.length > 0) {
        await appendStandalone(
          { tenantId, pot: "ads", action, phase: "refused", actor, reason: refusalReason(would[0].code, would[0].params), reasonCodes: would.map((w) => w.reasonCode), observe: true, targetType: resolved.targetType, targetId: resolved.targetId, metaObjectId: resolved.metaObjectId, currency, snapshot: { ...figuresSnapshot(limits, after), continuedAs: correlationId }, sandbox: account?.sandbox === true },
          { tx: ledgerDb(tx) },
        );
      }

      // 11. Commitments to reserved, with peaks, day start and week peak.
      for (const c of sim.touched) await storeCommitment(tx, c);

      // 12-13. The requested row, then the permit.
      const accountExternalId = account?.externalId ?? "";
      const issuedAt = now;
      const expiresAt = new Date(now.getTime() + PERMIT_TTL_MS.ads);
      const paths = Object.keys(resolved.objects);
      const maxUses = paths.length + 2;
      const permitData = { kind: intent.kind, adAccountAssetId: resolved.adAccountAssetId, accountExternalId, objects: resolved.objects, paths, maxUses, issuedAt, expiresAt };
      const row: LedgerRowInput = {
        tenantId,
        pot: "ads",
        action,
        actor,
        reason,
        reasonCodes: [...(opts.reasonCodes ?? []), ...(account?.sandbox ? [SANDBOX_REASON_CODE] : [])],
        autonomyLevel,
        targetType: resolved.targetType,
        targetId: resolved.targetId,
        metaObjectId: resolved.metaObjectId,
        currency,
        amountMinor: resolved.amountMinor,
        forecastTodayMinor: deltaDay,
        forecastMonthMinor: deltaMonth,
        before: sim.touched.map((c, i) => beforeOf(c.metaObjectId, sim.previous[i])),
        after: sim.touched.map((c) => ({ metaObjectId: c.metaObjectId, status: c.status, dailyBudgetMinor: c.dailyBudgetMinor, lifetimeBudgetMinor: c.lifetimeBudgetMinor, endsAt: c.endsAt, peakDailyBudgetMinor: c.peakDailyBudgetMinor })),
        snapshot: { ...figuresSnapshot(limits, before), freeze: freeze.effective, breakers: [], after: { dayUse: after.dayUse, monthUse: after.monthUse }, permit: permitSnapshot(permitData), intent, observe: would.length > 0 ? would.map((w) => w.reasonCode) : undefined },
        approvalId: opts.approvalId ?? null,
        undo: resolved.undo,
        correlationId,
        idempotencyKey: opts.idempotencyKey,
        sandbox: account?.sandbox === true,
      };
      await appendRequest(ledgerDb(tx), row);
      const permit = mintPermit({ type: "ads", correlationId, tenantId, ...permitData });
      rememberPermit(permit, actor);
      return { kind: "permit", permit, queueReplan: replan };
    },
    lockOpts(db),
  );

  switch (outcome.kind) {
    case "permit":
      if (outcome.queueReplan) await queueMetaReplan(opts, tenantId, outcome.queueReplan.adAccountAssetId);
      return outcome.permit;
    case "shadow":
      throw new ShadowOnlyError(outcome.shadowRecordId);
    case "approval": {
      await notifySpend({
        tenantId,
        kind: "approval_waiting",
        severity: "action_needed",
        audience: "approvers",
        dedupeKey: `spend-approval:${outcome.approvalId}`,
        title: "1 spending request is waiting",
        body: `${outcome.summary}. Approve or decline it in Settings > Spending limits.`,
        link: "/app/settings/spending",
        approvalId: outcome.approvalId,
        subjectType: "spend_approval",
        subjectId: outcome.approvalId,
      });
      throw new AdsNeedsApprovalError(outcome.approvalId, outcome.expiresAt, outcome.token, outcome.summary);
    }
    case "refused": {
      if (outcome.queueReplan) await queueMetaReplan(opts, tenantId, outcome.queueReplan.adAccountAssetId);
      const r = outcome.refusal;
      await appendStandalone(
        { tenantId, pot: "ads", action, phase: "refused", actor, reason: outcome.error?.message ?? (r ? refusalReason(r.code, r.params) : "Refused."), reasonCodes: [r?.reasonCode ?? outcome.reasonCode ?? "refused", ...(opts.reasonCodes ?? [])], approvalId: opts.approvalId ?? null, snapshot: { ...(outcome.snapshot as Record<string, unknown>), intent } },
        { db: ledgerDb(db) },
      );
      if (outcome.error) throw outcome.error;
      throw new SpendBlockedError(r!.code, r!.params);
    }
  }
}

/** Asks the Meta-limit task to make room on the account (a P3 raise, 5.4). Never throws. */
async function queueMetaReplan(opts: BookOptions, tenantId: string, adAccountAssetId: string): Promise<void> {
  const enqueue = opts.enqueue ?? ((q: string, p: unknown) => enqueueJob(q, p));
  await enqueue(SPEND_QUEUES.metacapReplan, { tenantId, adAccountAssetId, reason: "meta_cap_too_low" }).catch((e: unknown) => console.error(`[spend] metacap re-plan not queued: ${describeError(e)}`));
}

/**
 * The fingerprint an approval of this intent would carry now (7.3): the canonical intent, the current budget and status of
 * every object it touches, and the allowance version. approvals.ts recomputes it at decision time; a mismatch fails the
 * approval with "The ad set changed since this was asked." Intents read back from JSON (amounts as strings) give the same.
 */
export async function currentAdsFingerprint(tenantId: string, intent: AdsRaiseIntent, opts: BookOptions = {}): Promise<string> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const control = await getControl(tenantId, { db, prune: false });
  const state = await loadAdsBook(tenantId, { db, now, env, control });
  const resolved = await resolveIntent(db, tenantId, intent);
  const counted = countedCommitments(state);
  const previous = resolved.changes.map((c) => findOpen(counted, c));
  const limits = await effectiveLimits(tenantId, "ads", undefined, db, { now, env, control });
  return approvalFingerprint({ intent, objects: fingerprintObjects(previous, resolved), allowanceVersion: limits.allowance?.version ?? 0 });
}

function probationParams(limits: ResolvedLimits): SpendCopyParams {
  const c = limits.ceilingDetail;
  const currency = limits.currency;
  return {
    ...(c.daily !== null ? { daily: { minor: c.daily, currency } } : {}),
    ...(c.monthly !== null ? { monthly: { minor: c.monthly, currency } } : {}),
  };
}

function toMandate(r: Record<string, unknown>): MandateLite {
  const level = Number(r.level ?? 0);
  return {
    enabled: r.enabled === true,
    level: (level === 1 || level === 2 ? level : 0) as AutonomyLevel,
    allowedOps: Array.isArray(r.allowedOps) ? (r.allowedOps as string[]) : [],
    maxDailyMinor: big(r.maxDailyMinor),
    maxMonthlyMinor: big(r.maxMonthlyMinor),
    targetCostPerLeadMinor: big(r.targetCostPerLeadMinor),
    raiseStepPct: Number(r.raiseStepPct ?? 20),
    approvalSharePct: Number(r.approvalSharePct ?? 25),
    shadowUntil: r.shadowUntil instanceof Date ? r.shadowUntil : r.shadowUntil ? new Date(String(r.shadowUntil)) : null,
    sandboxOnly: r.sandboxOnly === true,
  };
}

/** The object an ads intent is about: the same subject means a newer request replaces an older one. */
export function intentSubject(intent: unknown): string | null {
  const i = intent && typeof intent === "object" ? (intent as Record<string, unknown>) : {};
  switch (i.kind) {
    case "activate":
    case "extend_end":
      return typeof i.campaignId === "string" ? `campaign:${i.campaignId}` : null;
    case "raise_budget":
    case "resume_adset":
      return typeof i.adSetId === "string" ? `adset:${i.adSetId}` : null;
    case "resume_ad":
      return typeof i.adId === "string" ? `ad:${i.adId}` : null;
    default:
      return null;
  }
}

/**
 * Marks this assistant's older pending requests about the same object `superseded` (7.3), inside the reservation
 * transaction, each with an `approval.supersede` row. Only pending rows change (a decision already made stands).
 */
async function supersedeOlderApprovals(tx: SpendDb, tenantId: string, actor: Extract<SpendActor, { type: "assistant" }>, intent: AdsRaiseIntent, now: Date): Promise<string[]> {
  const subject = intentSubject(intent);
  if (!subject) return [];
  const pending = ((await tx.spendApproval.findMany({ where: { tenantId, assistantKey: actor.assistantKey, pot: "ads", status: "pending" }, select: { id: true, intent: true, correlationId: true }, take: 200 })) ?? []) as {
    id: string;
    intent: unknown;
    correlationId: string;
  }[];
  const same = pending.filter((p) => intentSubject(p.intent) === subject);
  if (same.length === 0) return [];
  const ids = same.map((p) => p.id);
  await tx.spendApproval.updateMany({ where: { id: { in: ids }, status: "pending" }, data: { status: "superseded", decidedVia: "system", decidedAt: now } });
  for (const p of same) {
    await appendStandalone(
      { tenantId, pot: "ads", action: "approval.supersede", phase: "info", actor, reason: "A newer request about the same campaign replaced this one.", reasonCodes: ["superseded"], approvalId: p.id },
      { tx: ledgerDb(tx) },
    );
  }
  return ids;
}

/** Σ forecastMonth of this assistant's raises that ran without an approval in the last 24 h (anti-splitting, 2.3.9). */
async function autoRaisesLast24h(tx: SpendDb, tenantId: string, assistantKey: string, now: Date): Promise<bigint> {
  const rows = ((await tx.spendLedger.findMany({
    where: { tenantId, phase: "requested", actorType: "assistant", assistantKey, approvalId: null, pot: "ads", createdAt: { gte: new Date(now.getTime() - 24 * 3_600_000) } },
    select: { forecastMonthMinor: true },
  })) ?? []) as { forecastMonthMinor: bigint | null }[];
  return rows.reduce((s, r) => s + (big(r.forecastMonthMinor) ?? 0n), 0n);
}

function fingerprintObjects(previous: (BookCommitment | null)[], resolved: Resolved): FingerprintObject[] {
  return resolved.changes.map((c, i) => ({
    metaObjectId: c.metaObjectId,
    status: previous[i]?.status ?? null,
    dailyBudgetMinor: previous[i]?.dailyBudgetMinor ?? null,
    lifetimeBudgetMinor: previous[i]?.lifetimeBudgetMinor ?? null,
    endsAt: previous[i]?.endsAt ?? null,
  }));
}

type BeforeState = { metaObjectId: string; stored: boolean; counted: boolean; id: string | null; status: string | null; dailyBudgetMinor: bigint | null; lifetimeBudgetMinor: bigint | null; endsAt: Date | null };

function beforeOf(metaObjectId: string, prev: BookCommitment | null): BeforeState {
  return {
    metaObjectId,
    stored: !!prev && !prev.synthetic,
    counted: !!prev,
    id: prev && !prev.synthetic ? prev.id : null,
    status: prev?.status ?? null,
    dailyBudgetMinor: prev?.dailyBudgetMinor ?? null,
    lifetimeBudgetMinor: prev?.lifetimeBudgetMinor ?? null,
    endsAt: prev?.endsAt ?? null,
  };
}

function commitmentData(c: BookCommitment) {
  return {
    tenantId: c.tenantId,
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
    pendingFromMinor: c.pendingFromMinor,
    dayKey: c.dayKey ? dayKeyToDate(c.dayKey) : null,
    dayStartBudgetMinor: c.dayStartBudgetMinor,
    peakDailyBudgetMinor: c.peakDailyBudgetMinor,
    weekStart: c.weekStart ? dayKeyToDate(c.weekStart) : null,
    weekPeakDailyBudgetMinor: c.weekPeakDailyBudgetMinor,
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    status: c.status,
    reservedUntil: c.reservedUntil,
    correlationId: c.correlationId,
    sandbox: c.sandbox,
    version: c.version,
  };
}

async function storeCommitment(tx: SpendDb, c: BookCommitment): Promise<void> {
  const data = commitmentData(c);
  if (c.id) await tx.spendCommitment.update({ where: { id: c.id }, data });
  else await tx.spendCommitment.create({ data });
}

// =====================================================================================================================
// assertPermitValid and settleAds (4.6)
// =====================================================================================================================

/**
 * Right before the HTTP call: the permit must be minted, cover the object and be unexpired; its commitments must still be
 * `reserved` with reservedUntil in the future; and no freeze and no blocking breaker may have appeared since. Otherwise it
 * throws, and no HTTP call is made.
 */
export async function assertPermitValid(permit: AdsPermit, metaObjectId: string, opts: BookOptions = {}): Promise<void> {
  if (!isMintedPermit(permit) || permit.type !== "ads") throw new SpendGuardBypassError("not_minted");
  if (!Object.prototype.hasOwnProperty.call(permit.objects, metaObjectId)) throw new SpendGuardBypassError("object_not_in_permit");
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  if (permit.expiresAt.getTime() <= now.getTime()) throw new SpendPermitExpiredError();
  const rows = ((await db.spendCommitment.findMany({ where: { tenantId: permit.tenantId, correlationId: permit.correlationId }, select: { status: true, reservedUntil: true, campaignId: true, adSetId: true, metaObjectId: true } })) ?? []) as {
    status: string;
    reservedUntil: Date | null;
    campaignId: string;
    adSetId: string | null;
    metaObjectId: string;
  }[];
  if (rows.length === 0 || !rows.every((r) => r.status === "reserved" && r.reservedUntil && r.reservedUntil.getTime() > now.getTime())) throw new SpendPermitExpiredError();
  const actor = PERMIT_ACTORS.get(permit) ?? ({ type: "system", job: "permit" } as SpendActor);
  const freeze = await spendState(permit.tenantId, { fresh: true, db });
  const frozen = freezeRefusal(freeze, actor);
  if (frozen) throw new SpendBlockedError(frozen);
  const scopes: BreakerScopeRef[] = [{ scopeType: "ad_account", scopeId: permit.adAccountAssetId }];
  if (permit.accountExternalId) scopes.push({ scopeType: "ad_account", scopeId: permit.accountExternalId });
  for (const r of rows) {
    scopes.push({ scopeType: "campaign", scopeId: r.campaignId });
    if (r.adSetId) scopes.push({ scopeType: "adset", scopeId: r.adSetId });
    scopes.push({ scopeType: "adset", scopeId: r.metaObjectId });
  }
  for (const id of Object.keys(permit.objects)) scopes.push({ scopeType: "campaign", scopeId: id }, { scopeType: "adset", scopeId: id });
  if (actor.type === "assistant") scopes.push({ scopeType: "assistant", scopeId: actor.assistantKey });
  const blocked = blockingFor(actor, await isBlocked(permit.tenantId, scopes, ["pause_scope", "block_raises"], { db, now }));
  if (blocked.blocked) throw new SpendBreakerError(blocked.breakers);
}

export type SettleOutcome = "applied" | "failed" | "unconfirmed";

/**
 * After the Meta call. applied: reserved -> live. failed: an activation is stopped, a raise goes back to the budget before
 * it (the peak stays). unconfirmed: stays counted until the reconciler reads the truth. Always writes exactly one outcome
 * row, and never throws for a bookkeeping failure (the reconciler corrects the row within minutes).
 */
export async function settleAds(permit: AdsPermit, outcome: SettleOutcome, detail?: { error?: string; reason?: string } & Record<string, unknown>, opts: BookOptions = {}): Promise<{ updated: number }> {
  if (!isMintedPermit(permit) || permit.type !== "ads") throw new SpendGuardBypassError("not_minted");
  const db = opts.db ?? prisma;
  const tenantId = permit.tenantId;
  const correlationId = permit.correlationId;
  let updated = 0;
  let request: Record<string, unknown> | null = null;
  try {
    request = (await db.spendLedger.findFirst({ where: { tenantId, correlationId, phase: "requested" } })) as Record<string, unknown> | null;
    const open = { tenantId, correlationId, status: { in: ["reserved", "unconfirmed"] } };
    if (outcome === "applied" && (permit.kind === "raise_budget" || permit.kind === "extend_end")) {
      // A new budget or end date on an object that was not running does not start it: once applied it no longer counts.
      const before = (Array.isArray(request?.before) ? request!.before : []) as Record<string, unknown>[];
      const rows = ((await db.spendCommitment.findMany({ where: open })) ?? []) as Record<string, unknown>[];
      for (const r of rows) {
        const prev = before.find((b) => b.metaObjectId === r.metaObjectId);
        const status = prev && prev.counted === false ? "stopped" : "live";
        updated += (await db.spendCommitment.updateMany({ where: { id: String(r.id), status: { in: ["reserved", "unconfirmed"] } }, data: { status, reservedUntil: null, pendingFromMinor: null, version: { increment: 1 } } })).count;
      }
    } else if (outcome === "applied") {
      updated = (await db.spendCommitment.updateMany({ where: open, data: { status: "live", reservedUntil: null, pendingFromMinor: null, version: { increment: 1 } } })).count;
    } else if (outcome === "unconfirmed") {
      updated = (await db.spendCommitment.updateMany({ where: { tenantId, correlationId, status: "reserved" }, data: { status: "unconfirmed", version: { increment: 1 } } })).count;
    } else {
      const before = (Array.isArray(request?.before) ? request!.before : []) as Record<string, unknown>[];
      const rows = ((await db.spendCommitment.findMany({ where: open })) ?? []) as Record<string, unknown>[];
      for (const r of rows) {
        const prev = before.find((b) => b.metaObjectId === r.metaObjectId);
        const data =
          prev && prev.counted
            ? {
                status: ["live", "unconfirmed"].includes(String(prev.status)) ? String(prev.status) : "live",
                dailyBudgetMinor: big(r.pendingFromMinor) ?? big(prev.dailyBudgetMinor),
                lifetimeBudgetMinor: big(prev.lifetimeBudgetMinor),
                endsAt: prev.endsAt ? new Date(String(prev.endsAt)) : null,
                reservedUntil: null,
                pendingFromMinor: null,
                version: { increment: 1 },
              }
            : { status: "stopped", reservedUntil: null, pendingFromMinor: null, version: { increment: 1 } };
        updated += (await db.spendCommitment.updateMany({ where: { id: String(r.id), status: { in: ["reserved", "unconfirmed"] } }, data })).count;
      }
    }
  } catch (error) {
    console.error(`[spend] settle ${outcome} for ${correlationId} not stored (the reconciler will correct it): ${describeError(error)}`);
  }
  const actor = PERMIT_ACTORS.get(permit) ?? ({ type: "system", job: "settle" } as SpendActor);
  await appendOutcome(
    correlationId,
    {
      tenantId,
      pot: "ads",
      action: String(request?.action ?? ACTION_OF[permit.kind] ?? "ads.raise"),
      phase: outcome,
      actor,
      reason: detail?.reason ?? (outcome === "applied" ? "Meta applied the change." : outcome === "failed" ? "Meta did not apply the change." : "Meta's answer was unclear; the change is counted until it is checked."),
      reasonCodes: detail?.error ? [String(detail.error).slice(0, 80)] : [],
      targetType: (request?.targetType as string | null) ?? null,
      targetId: (request?.targetId as string | null) ?? null,
      metaObjectId: (request?.metaObjectId as string | null) ?? null,
      currency: (request?.currency as string | null) ?? null,
      after: { outcome, updated, ...(detail ? { detail } : {}) },
      approvalId: (request?.approvalId as string | null) ?? null,
      sandbox: request?.sandbox === true,
    },
    { db: ledgerDb(db) },
  );
  return { updated };
}

// =====================================================================================================================
// recordLowering (I2)
// =====================================================================================================================

export type ObjectLevel = "campaign" | "adset" | "ad";

const LOWERING_ACTION: Record<AdsLoweringIntent["kind"], Record<ObjectLevel, string>> = {
  pause: { campaign: "ads.campaign.pause", adset: "ads.adset.pause", ad: "ads.ad.pause" },
  archive: { campaign: "ads.campaign.archive", adset: "ads.adset.archive", ad: "ads.ad.archive" },
  cut_budget: { campaign: "ads.campaign.budget_cut", adset: "ads.adset.budget_cut", ad: "ads.adset.budget_cut" },
  end_earlier: { campaign: "ads.campaign.end_earlier", adset: "ads.adset.end_earlier", ad: "ads.campaign.end_earlier" },
};

export type RecordLoweringOptions = BookOptions & { objectLevel?: ObjectLevel; idempotencyKey?: string; reasonCodes?: string[] };

async function objectLevelOf(db: SpendDb, tenantId: string, metaObjectId: string): Promise<{ level: ObjectLevel; campaignId: string | null; dailyBudgetMinor?: bigint | null; endsAt?: Date | null }> {
  const c = (await db.spendCommitment.findFirst({ where: { tenantId, metaObjectId, status: { not: "stopped" } }, select: { objectLevel: true, campaignId: true, dailyBudgetMinor: true, endsAt: true } })) as {
    objectLevel: string;
    campaignId: string;
    dailyBudgetMinor?: bigint | number | null;
    endsAt?: Date | null;
  } | null;
  if (c) return { level: c.objectLevel === "campaign" ? "campaign" : "adset", campaignId: c.campaignId, dailyBudgetMinor: big(c.dailyBudgetMinor), endsAt: c.endsAt instanceof Date ? c.endsAt : null };
  const campaign = (await db.adCampaign.findFirst({ where: { tenantId, metaCampaignId: metaObjectId }, select: { id: true } })) as { id: string } | null;
  if (campaign) return { level: "campaign", campaignId: campaign.id };
  const set = (await db.adSet.findFirst({ where: { tenantId, metaAdSetId: metaObjectId }, select: { campaignId: true } })) as { campaignId: string } | null;
  if (set) return { level: "adset", campaignId: set.campaignId };
  return { level: "ad", campaignId: null };
}

/**
 * Pause, archive, cut a budget or end earlier (I2). 1: the requested row (no lock, no checks). 2: a lowering permit valid for
 * 2 minutes. 3: run(permit), the Meta call, with no lock held. 4: under the lock, the commitment is stopped or lowered; the
 * day's peak stays, because Meta's 175% rule uses the day's highest budget. If the lock is busy, the commitment stays
 * over-counted and the reconciler corrects it. 5: the outcome row. A failed run gives `failed` and the error is rethrown.
 */
export async function recordLowering(
  tenantId: string,
  intent: AdsLoweringIntent,
  actor: SpendActor,
  reason: string,
  run: (permit: LoweringPermit) => Promise<void>,
  opts: RecordLoweringOptions = {},
): Promise<{ correlationId: string; bookkeeping: "done" | "deferred" }> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const text = (reason ?? "").trim() || "Lowered spending.";
  let level: ObjectLevel = opts.objectLevel ?? "adset";
  let campaignId: string | null = null;
  let found: Awaited<ReturnType<typeof objectLevelOf>> | null = null;
  try {
    found = await objectLevelOf(db, tenantId, intent.metaObjectId);
    level = opts.objectLevel ?? found.level;
    campaignId = found.campaignId;
  } catch {
    // Lowering never waits on bookkeeping reads.
  }
  // A "cut" above what the book counts, or an "end earlier" after the counted end, is a raise in disguise: it goes through
  // reserveAds instead. Only a value the book can see is checked (an unreadable book never stops a real lowering).
  if (intent.kind === "cut_budget" && intent.toMinor !== undefined && typeof found?.dailyBudgetMinor === "bigint" && intent.toMinor > found.dailyBudgetMinor) {
    throw new HttpError(409, "That budget is higher than the one running now, so it is a raise, not a cut. Raise it through the budget change that checks your limits.");
  }
  if (intent.kind === "end_earlier" && intent.endsAt && found?.endsAt instanceof Date && intent.endsAt.getTime() > found.endsAt.getTime()) {
    throw new HttpError(409, "That end date is later than the one running now, so it extends spending. Extend it through the change that checks your limits.");
  }
  const action = LOWERING_ACTION[intent.kind][level];
  const row: LedgerRowInput = {
    tenantId,
    pot: "ads",
    action,
    actor,
    reason: text,
    reasonCodes: opts.reasonCodes ?? [],
    targetType: level,
    targetId: campaignId,
    metaObjectId: intent.metaObjectId,
    amountMinor: intent.toMinor ?? null,
    after: { kind: intent.kind, toMinor: intent.toMinor ?? null, endsAt: intent.endsAt ?? null },
    undo: loweringUndo(intent, level),
    idempotencyKey: opts.idempotencyKey ?? null,
  };
  // 1. The requested row. A failure to write it never stops a lowering.
  let correlationId = newCorrelationId();
  try {
    correlationId = (await appendRequest(ledgerDb(db), { ...row, correlationId })).record.correlationId;
  } catch (error) {
    console.error(`[spend] lowering requested row not written (${intent.kind}): ${describeError(error)}`);
  }
  // 2. The lowering permit.
  // The permit carries the value it was minted for, so the transport refuses a budget above the cut or an end after it.
  const permit = mintPermit({
    type: "lowering",
    kind: intent.kind,
    correlationId,
    tenantId,
    metaObjectIds: [intent.metaObjectId],
    paths: [intent.metaObjectId],
    maxUses: 3,
    issuedAt: now,
    expiresAt: new Date(now.getTime() + PERMIT_TTL_MS.lowering),
    ...(intent.kind === "cut_budget" && intent.toMinor !== undefined ? { maxBudgetMinor: intent.toMinor } : {}),
    ...(intent.kind === "end_earlier" && intent.endsAt ? { endsAt: intent.endsAt } : {}),
  });
  // 3. The call, with no lock held.
  try {
    await run(permit);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    await appendOutcome(
      correlationId,
      { ...row, phase: "failed", reason: "The change did not reach Meta, so nothing changed. Try again.", reasonCodes: [...(row.reasonCodes ?? []), `meta_error${code !== undefined ? `:${String(code).slice(0, 20)}` : ""}`], idempotencyKey: null },
      { db: ledgerDb(db) },
    );
    throw error;
  }
  // 4. Bookkeeping under the lock.
  let bookkeeping: "done" | "deferred" = "done";
  try {
    await withSpendLock(tenantId, "ads", (tx) => lowerCommitments(tx, tenantId, intent, level, campaignId, now), lockOpts(db));
  } catch (error) {
    bookkeeping = "deferred";
    console.error(`[spend] lowering bookkeeping deferred to the reconciler (${intent.kind}): ${describeError(error)}`);
  }
  // 5. The outcome.
  await appendOutcome(correlationId, { ...row, phase: "applied", reasonCodes: [...(row.reasonCodes ?? []), ...(bookkeeping === "deferred" ? ["bookkeeping_deferred"] : [])], idempotencyKey: null }, { db: ledgerDb(db) });
  return { correlationId, bookkeeping };
}

function loweringUndo(intent: AdsLoweringIntent, level: ObjectLevel): UndoRecipe | null {
  if (intent.kind === "pause") return { action: level === "campaign" ? "resume_campaign" : level === "adset" ? "resume_adset" : "resume_ad", metaObjectId: intent.metaObjectId };
  if (intent.kind === "cut_budget") return { action: "restore_budget", metaObjectId: intent.metaObjectId };
  if (intent.kind === "end_earlier") return { action: "restore_end", metaObjectId: intent.metaObjectId };
  return null;
}

async function lowerCommitments(tx: SpendDb, tenantId: string, intent: AdsLoweringIntent, level: ObjectLevel, campaignId: string | null, now: Date): Promise<number> {
  if (level === "ad") return 0;
  const open = { in: ["reserved", "live", "unconfirmed"] };
  const where = level === "campaign" && campaignId ? { tenantId, status: open, OR: [{ campaignId }, { metaObjectId: intent.metaObjectId }] } : { tenantId, status: open, metaObjectId: intent.metaObjectId };
  const rows = ((await tx.spendCommitment.findMany({ where })) ?? []) as Record<string, unknown>[];
  let n = 0;
  for (const raw of rows) {
    const id = String(raw.id);
    if (intent.kind === "pause" || intent.kind === "archive") {
      n += (await tx.spendCommitment.updateMany({ where: { id }, data: { status: "stopped", reservedUntil: null, pendingFromMinor: null, version: { increment: 1 } } })).count;
    } else if (intent.kind === "cut_budget" && intent.toMinor !== undefined) {
      // The peak stays: roll it to today first with the budget the object ran at until now.
      const current = big(raw.dailyBudgetMinor) ?? 0n;
      const tz = String(raw.timezone ?? "Asia/Kolkata");
      const p = rolledPeaks({ dailyBudgetMinor: current, dayKey: raw.dayKey instanceof Date ? dateToDayKey(raw.dayKey) : null, peakDailyBudgetMinor: big(raw.peakDailyBudgetMinor) ?? 0n, weekStart: raw.weekStart instanceof Date ? dateToDayKey(raw.weekStart) : null, weekPeakDailyBudgetMinor: big(raw.weekPeakDailyBudgetMinor) ?? 0n, timezone: tz }, now);
      n += (
        await tx.spendCommitment.updateMany({
          where: { id },
          data: { dailyBudgetMinor: intent.toMinor < current ? intent.toMinor : current, dayKey: dayKeyToDate(p.today), peakDailyBudgetMinor: p.peakToday, weekStart: dayKeyToDate(p.week), weekPeakDailyBudgetMinor: p.weekPeak, pendingFromMinor: null, version: { increment: 1 } },
        })
      ).count;
    } else if (intent.kind === "end_earlier" && intent.endsAt) {
      const ends = raw.endsAt instanceof Date ? raw.endsAt : null;
      if (!ends || intent.endsAt.getTime() < ends.getTime()) n += (await tx.spendCommitment.updateMany({ where: { id }, data: { endsAt: intent.endsAt, version: { increment: 1 } } })).count;
    }
  }
  if (rows.length === 0 && (intent.kind === "pause" || intent.kind === "archive") && campaignId) n += await markOrphansStopped(tx, tenantId, intent.metaObjectId, level, campaignId, now);
  return n;
}

/**
 * A pause or archive of an object the book counts only as an orphan (its campaign is DB-active but it has no open
 * commitment): a `stopped` row is written for it, so the orphan rule leaves it out from now on (StoppedMark). Without it, an
 * ad set paused under a running campaign would be counted at its full worst case until the reconciler read it.
 */
async function markOrphansStopped(tx: SpendDb, tenantId: string, metaObjectId: string, level: "campaign" | "adset", campaignId: string, now: Date): Promise<number> {
  const { campaigns, adSets } = await loadActiveCampaigns(tenantId, tx, { campaignIds: [campaignId] });
  if (campaigns.length === 0) return 0;
  const control = await getControl(tenantId, { db: tx, prune: false });
  const accounts = await loadAdAccounts(tenantId, control, tx);
  const open = (((await tx.spendCommitment.findMany({ where: { tenantId, campaignId, status: { in: [...OPEN_STATUSES] } } })) ?? []) as Record<string, unknown>[]).map(toBookCommitment);
  const orphans = orphanCommitments(campaigns, adSets, open, accounts, now, control.timezone);
  const targets = level === "campaign" ? orphans : orphans.filter((o) => o.metaObjectId === metaObjectId);
  for (const o of targets) await tx.spendCommitment.create({ data: commitmentData({ ...o, tenantId, status: "stopped", reservedUntil: null, version: 1 }) });
  return targets.length;
}

// =====================================================================================================================
// permitForPausedCreate (4.6) and the 613 breaker (4.6 step 9)
// =====================================================================================================================

/**
 * A neutral permit to create PAUSED objects on an ad account: paths act_X/{campaigns,adsets,adcreatives,ads}, objectCount + 2
 * uses, valid 10 minutes. Refused only under a workspace or platform freeze `all`. The tripwire still requires status PAUSED
 * on every campaign, ad set and ad body (ad creatives carry no status, 12.1b).
 */
export async function permitForPausedCreate(tenantId: string, adAccountExternalId: string, objectCount: number, actor: SpendActor, opts: BookOptions = {}): Promise<CreatePermit> {
  if (!tenantId || !adAccountExternalId) throw new RangeError("permitForPausedCreate needs a workspace and an ad account.");
  if (!Number.isInteger(objectCount) || objectCount < 1) throw new RangeError("permitForPausedCreate needs the number of objects to create.");
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const freeze = await spendState(tenantId, { fresh: true, db });
  const code: SpendCopyCode | null = freeze.platform === "all" ? "spend.platform_frozen" : freeze.workspace === "all" ? "spend.frozen" : null;
  const act = `act_${adAccountExternalId.replace(/^act_/, "")}`;
  if (code) {
    await appendStandalone({ tenantId, pot: "ads", action: "ads.campaign.create_paused", phase: "refused", actor, reason: refusalReason(code, {}), reasonCodes: ["frozen"], targetType: "ad_account", targetId: act }, { db: ledgerDb(db) });
    throw new SpendBlockedError(code);
  }
  const correlationId = newCorrelationId();
  const permit = mintPermit({
    type: "create",
    correlationId,
    tenantId,
    adAccountExternalId: act,
    objectCount,
    paths: [`${act}/campaigns`, `${act}/adsets`, `${act}/adcreatives`, `${act}/ads`],
    maxUses: objectCount + 2,
    issuedAt: now,
    expiresAt: new Date(now.getTime() + PERMIT_TTL_MS.create),
  });
  await appendStandalone(
    { tenantId, pot: "ads", action: "ads.campaign.create_paused", phase: "info", actor, reason: "Created paused ads; nothing can spend until they are turned on.", targetType: "ad_account", targetId: act, snapshot: { objectCount }, correlationId },
    { db: ledgerDb(db) },
  );
  return permit;
}

/** True for Meta's "too many budget changes to this ad set" answer (613 / 1487632). */
export function isMetaBudgetQuotaError(error: unknown): boolean {
  const e = error as { code?: unknown; subcode?: unknown; error_subcode?: unknown } | null;
  return !!e && e.code === META_BUDGET_QUOTA_ERROR.code && (e.subcode === META_BUDGET_QUOTA_ERROR.subcode || e.error_subcode === META_BUDGET_QUOTA_ERROR.subcode);
}

/**
 * Meta answered a budget write with 613/1487632 (edits in Ads Manager count too): the ad set gets an open
 * `budget_change_quota` breaker for 60 minutes. Until then raises are refused with spend.meta_rate and breakers and cuts use
 * PAUSED instead of budget edits. Returns true when the error was that one.
 */
export async function noteBudgetWriteError(tenantId: string, metaAdSetId: string, error: unknown, opts: BookOptions = {}): Promise<boolean> {
  if (!isMetaBudgetQuotaError(error)) return false;
  const now = opts.now ?? new Date();
  await openBreaker(
    {
      tenantId,
      kind: "budget_change_quota",
      scopeType: "adset",
      scopeId: metaAdSetId,
      effect: "block_raises",
      reason: "Meta allows only 4 budget changes an hour for each ad set. Budget changes wait until the hour is up.",
      details: { code: META_BUDGET_QUOTA_ERROR.code, subcode: META_BUDGET_QUOTA_ERROR.subcode },
      autoClearAt: new Date(now.getTime() + BUDGET_QUOTA_WINDOW_MS),
    },
    { db: opts.db, now },
  );
  return true;
}

/** True when an open budget_change_quota breaker covers the ad set: breakers and cuts should pause instead of editing the budget. */
export async function budgetQuotaOpen(tenantId: string, metaAdSetId: string, opts: BookOptions = {}): Promise<boolean> {
  const rows = await listBreakers(tenantId, { db: opts.db, now: opts.now, kinds: ["budget_change_quota"] });
  return rows.some((r) => r.scopeType === "adset" && r.scopeId === metaAdSetId);
}

/**
 * Runs one Graph call inside a minted permit's async context, so the transport tripwire (4.7) finds it. The guarded ads
 * client (src/lib/ads/client.ts) calls this: bypass rule B8 keeps permit.ts imports to the book, the send gate, metacap and
 * the tripwire, so the client asks the book instead of importing the permit store. Refuses anything mintPermit() did not make.
 */
export function runUnderPermit<T>(permit: AdsPermit | CreatePermit | LoweringPermit, fn: () => Promise<T>): Promise<T> {
  return runWithPermit(permit, fn);
}

/** The control row, for callers that only have the book (re-exported to keep one import). */
export type { SpendControlState };
