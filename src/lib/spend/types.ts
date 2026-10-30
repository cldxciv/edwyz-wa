/**
 * Shared contracts of the Phase 0 spend controls (docs/SPEND-CONTROLS-SPEC.md). Types and constants only: no database, no
 * network, no runtime imports. Every package of the spend controls and of Eddy builds against these names, so they are
 * stable: later packages add their own local types instead of changing these.
 *
 * Money inside the book is bigint minor units of an explicit currency. Money in a DTO is a decimal string of minor units plus
 * the formatted text (MoneyDTO). "Not set" is always null, never 0.
 */
import type { MoneyDTO } from "./money";

export type { MoneyDTO };

// ===== Basics =====

/** The three pots (3.2). AI is counted in CRD credits. */
export type Pot = "ads" | "messaging" | "ai";
export const POTS: readonly Pot[] = ["ads", "messaging", "ai"];
/** A ledger row may also be about no pot at all (a consent, a notification). */
export type LedgerPot = Pot | "none";

/** Same members as the Prisma `Role` enum; restated here so this file needs no database import. */
export type SpendRole = "owner" | "admin" | "agent";

export type FreezeLevel = "none" | "assistants" | "all";
export type FrozenByKind = "owner" | "admin" | "platform_admin" | "breaker";
export type ProbationSetting = "auto" | "lifted" | "forced";
export type EnforceMode = "observe" | "enforce";
export type TripwireMode = "report" | "enforce";
export type SpendCapMode = "off" | "observe" | "enforce";

/** The registered assistants (7.1). The registry itself is src/lib/spend/registry.ts. */
export type KnownAssistantKey = "ads_optimizer" | "ads_launcher" | "broadcast_planner" | "lead_followup";
export type AutonomyLevel = 0 | 1 | 2;

// ===== Actors (4.6) =====

/**
 * Who asks for a money decision. A `user` actor with reasonCodes ['via_eddy'] is a member who confirmed an Eddy card
 * (4.15); only src/lib/actions/invoke.ts may build that (bypass rule B14). `external` is a change Edwyz detected but did
 * not make (Meta Ads Manager edits, the customer's own spend_cap change).
 * A `user` actor may also name the assistant whose suggestion the person accepted and the approval behind it (decision
 * 2.3.10): the action is the person's own, and the ledger row carries that assistantKey and approvalId.
 */
export type SpendActor =
  | { type: "user"; userId: string; role: SpendRole; reasonCodes?: readonly string[]; assistantKey?: string; approvalId?: string }
  | { type: "assistant"; assistantKey: string; approvalId?: string }
  | { type: "system"; job: string }
  | { type: "breaker"; kind: BreakerKind | string }
  | { type: "platform_admin"; userId: string }
  | { type: "api"; keyId: string; userId?: string }
  | { type: "external"; source: "meta_ads_manager" | "meta_spend_cap" | string };

export type SpendActorType = SpendActor["type"];
export type SpendUserActor = Extract<SpendActor, { type: "user" }>;

/** Reason code a confirmed Eddy action carries on every ledger row (Phase 0 4.15). */
export const VIA_EDDY = "via_eddy";

// ===== Intents (4.6, 4.8, 4.9) =====

export type AdsActivateSet = {
  adSetId: string;
  metaAdSetId: string;
  dailyBudgetMinor?: bigint;
  lifetimeBudgetMinor?: bigint;
  endsAt?: Date;
};

/** Every raising ads intent goes through reserveAds. `create_live` is always refused in Phase 0. */
export type AdsRaiseIntent =
  | { kind: "activate"; campaignId: string; sets: AdsActivateSet[] }
  | { kind: "raise_budget"; adSetId: string; metaAdSetId: string; toMinor: bigint; shiftFromAdSetId?: string }
  | { kind: "resume_ad"; adId: string; metaAdId: string }
  | { kind: "resume_adset"; adSetId: string; metaAdSetId: string }
  | { kind: "extend_end"; campaignId: string; endsAt: Date }
  | { kind: "create_live" };
export type AdsRaiseKind = AdsRaiseIntent["kind"];

/** Lowering an ads object (recordLowering): never locked, never refused, works while frozen (I2). */
export type AdsLoweringIntent = {
  kind: "pause" | "archive" | "cut_budget" | "end_earlier";
  metaObjectId: string;
  toMinor?: bigint;
  endsAt?: Date;
};
export type AdsLoweringKind = AdsLoweringIntent["kind"];

/** Lowering on the messaging side: stopping or pausing a broadcast, releasing a bulk hold. Never refused. */
export type MessagingLoweringIntent = {
  kind: "cancel_broadcast" | "pause_broadcast" | "release_hold";
  subjectType: BulkSubjectType;
  subjectId: string;
};

/** Lowering a workspace limit (owner or admin; 8.1). A null field is left as it is. */
export type LimitLoweringIntent = { kind: "lower_limit"; pot: Pot; dailyLimitMinor?: bigint | null; monthlyLimitMinor?: bigint | null };

export type LoweringIntent = AdsLoweringIntent | MessagingLoweringIntent | LimitLoweringIntent;

export type BulkSubjectType = "broadcast" | "automation_run" | "api_batch";
export type ReservationSubjectType = BulkSubjectType | "ai_call";

/** A bulk messaging reservation (reserveBulk, 4.9). */
export type BulkIntent = {
  pot: "messaging";
  estimateMinor: bigint;
  currency: string;
  subject: { type: BulkSubjectType; id: string };
  ttlMs: number;
};

/** The guard every ads client call carries (4.8). Required, so a call without it does not compile. */
export type AdsGuard = { tenantId: string; adAccountAssetId: string; actor: SpendActor; sandbox: boolean };

// ===== Limits and headroom (4.4, 4.6) =====

export type CeilingScope = "platform" | "probation" | "plan" | "tenant";
export type CeilingSource = CeilingScope;
export type LimitBinding = "owner" | CeilingScope;

export type EffectiveLimits = {
  pot: Pot;
  currency: string;
  /** min(owner, ceiling); null = no limit from either source (see 4.4 for what null means per pot). */
  daily: bigint | null;
  monthly: bigint | null;
  owner: { daily: bigint | null; monthly: bigint | null };
  ceiling: { daily: bigint | null; monthly: bigint | null; source: CeilingSource | null; expiresAt: Date | null };
  binding: LimitBinding;
  /** No ceiling row in this currency and no fresh FX rate: raises are refused for assistants and on probation. */
  unknownCeiling: boolean;
  /** AI only: the plan's monthly credits, which the AI monthly limit never exceeds. */
  planCapMonthly?: bigint | null;
};

export type PeriodFigures = {
  spent: bigint;
  /** Ads: worst case of running ads (remainingMonth / dayRisk). Messaging and AI: 0. */
  committed: bigint;
  /** Messaging and AI: reserved but not yet spent. Ads: 0. */
  held: bigint;
  /** limit - (spent + committed + held), floored at 0; null when the limit is not set. */
  left: bigint | null;
};

export type FreezeState = {
  workspace: FreezeLevel;
  platform: FreezeLevel;
  /** The stricter of the two. */
  effective: FreezeLevel;
  frozenAt: Date | null;
  frozenByKind: FrozenByKind | null;
  frozenByUserId: string | null;
  reason: string | null;
};

export type OpenBreakerRef = { id: string; kind: string; scopeType: BreakerScopeType; scopeId: string; effect: BreakerEffect };

export type Headroom = {
  tenantId: string;
  pot: Pot;
  currency: string;
  limits: EffectiveLimits;
  month: PeriodFigures;
  today: PeriodFigures;
  /** Ads only: spend from outside Edwyz, counted only when Meta's limit is managed (decision 2.3.4). Always an estimate. */
  external: { counted: boolean; spentMonth: bigint; riskMonth: bigint; estimated: true };
  freeze: FreezeState;
  breakers: OpenBreakerRef[];
  probation: boolean;
  metaLimit: { managed: boolean; mode: MetaSpendLimitMode | null; roomMinor: bigint | null } | null;
  /** Ads only: no fast sync for 60 minutes, so today's spend is treated as the worst case. */
  stale: boolean;
  computedAt: Date;
};

// ===== Permits (4.6, 4.7, 4.9, 5.5) =====

declare const PERMIT_BRAND: unique symbol;
/** A permit value that only src/lib/spend/permit.ts mintPermit() can produce (bypass rule B8). */
export type Minted<T extends { type: string }> = Readonly<T> & { readonly [PERMIT_BRAND]: T["type"] };

type PermitCommon = {
  correlationId: string;
  tenantId: string;
  /** Graph paths this permit covers, for example "act_123/campaigns" or "<metaAdSetId>". */
  paths: readonly string[];
  maxUses: number;
  issuedAt: Date;
  expiresAt: Date;
};

export type AdsPermitObject = { maxDailyMinor?: bigint; maxLifetimeMinor?: bigint; status?: "ACTIVE"; endsAt?: Date };

export type AdsPermitData = PermitCommon & {
  type: "ads";
  kind: AdsRaiseKind;
  adAccountAssetId: string;
  accountExternalId: string;
  objects: Readonly<Record<string, AdsPermitObject>>;
};
export type LoweringPermitData = PermitCommon & {
  type: "lowering";
  kind: AdsLoweringKind;
  metaObjectIds: readonly string[];
  /** cut_budget: the budget it was minted for (minor units). The transport refuses a budget above it, so a "cut" can never raise. */
  maxBudgetMinor?: bigint;
  /** end_earlier: the end it was minted for. The transport refuses a later end. */
  endsAt?: Date;
};
export type CreatePermitData = PermitCommon & { type: "create"; adAccountExternalId: string; objectCount: number };
export type MsgPermitData = PermitCommon & { type: "msg"; phoneNumberId: string; messageId?: string; reservationId?: string };
export type MetaCapPermitData = PermitCommon & {
  type: "meta_cap";
  kind: "write" | "delete";
  adAccountAssetId: string;
  accountExternalId: string;
  /** For writes: the cap in minor units this permit allows. */
  capMinor?: bigint;
  priority: MetaCapPriority;
};

export type PermitData = AdsPermitData | LoweringPermitData | CreatePermitData | MsgPermitData | MetaCapPermitData;
export type AdsPermit = Minted<AdsPermitData>;
export type LoweringPermit = Minted<LoweringPermitData>;
export type CreatePermit = Minted<CreatePermitData>;
export type MsgPermit = Minted<MsgPermitData>;
export type MetaCapPermit = Minted<MetaCapPermitData>;
export type SpendPermit = AdsPermit | LoweringPermit | CreatePermit | MsgPermit | MetaCapPermit;
export type PermitType = PermitData["type"];
export type MintedFor<D extends PermitData> = D extends AdsPermitData
  ? AdsPermit
  : D extends LoweringPermitData
    ? LoweringPermit
    : D extends CreatePermitData
      ? CreatePermit
      : D extends MsgPermitData
        ? MsgPermit
        : MetaCapPermit;

/** Validity of the permits the book mints (4.6, 4.9, 4.6 permitForPausedCreate). */
export const PERMIT_TTL_MS = { ads: 10 * 60_000, lowering: 2 * 60_000, create: 10 * 60_000, msg: 2 * 60_000, meta_cap: 2 * 60_000 } as const;

/** What the transport tripwire classifies a Graph request as (4.7). */
export type GraphSpendClass = "not_spend" | "ads_raise_or_unknown" | "ads_lowering" | "ads_create" | "meta_cap" | "msg_send";

// ===== Ledger (3.2, 9.1) =====

export type LedgerPhase = "requested" | "applied" | "failed" | "unconfirmed" | "refused" | "shadow" | "reconciled" | "info";
export type OutcomePhase = "applied" | "failed" | "unconfirmed" | "refused" | "reconciled";
export type StandalonePhase = "refused" | "shadow" | "info" | "reconciled";
export const LEDGER_PHASES: readonly LedgerPhase[] = ["requested", "applied", "failed", "unconfirmed", "refused", "shadow", "reconciled", "info"];

/** The action vocabulary of 9.1 (plus 4.6.1's ads.external_change). Other strings are allowed for actions added later. */
export const KNOWN_LEDGER_ACTIONS = [
  "ads.campaign.activate",
  "ads.campaign.pause",
  "ads.campaign.archive",
  "ads.adset.budget_raise",
  "ads.adset.budget_cut",
  "ads.adset.pause",
  "ads.adset.resume",
  "ads.ad.pause",
  "ads.ad.resume",
  "ads.commitment.reconciled",
  "ads.external_change",
  "meta.spend_cap.write",
  "meta.spend_cap.read_drift",
  "meta.spend_cap.observe",
  "allowance.change",
  "ceiling.change",
  "probation.change",
  "kill.workspace",
  "kill.platform",
  "breaker.trip",
  "breaker.clear",
  "mandate.change",
  "approval.create",
  "approval.approve",
  "approval.decline",
  "approval.expire",
  "approval.supersede",
  "approval.apply",
  "messaging.bulk_hold",
  "messaging.bulk_release",
  "messaging.settlement",
  "messaging.blocked",
  "ai.settlement",
  "consent.meta_cap",
  "consent.owner_whatsapp",
  "notify.digest",
  "notify.alert",
  "notify.approval",
  "tripwire.bypass",
] as const;
export type KnownLedgerAction = (typeof KNOWN_LEDGER_ACTIONS)[number];
export type LedgerAction = KnownLedgerAction | (string & {});

/** A ledger row as the single writer (ledger.ts) accepts it. Money fields are bigint; JSON fields may hold bigint too. */
export type LedgerRowInput = {
  tenantId: string;
  pot: LedgerPot;
  action: LedgerAction;
  actor: SpendActor;
  /** Plain-language why (required, shown in the activity table). */
  reason: string;
  reasonCodes?: readonly string[];
  autonomyLevel?: AutonomyLevel | null;
  targetType?: string | null;
  targetId?: string | null;
  metaObjectId?: string | null;
  currency?: string | null;
  amountMinor?: bigint | null;
  forecastTodayMinor?: bigint | null;
  forecastMonthMinor?: bigint | null;
  before?: unknown;
  after?: unknown;
  snapshot?: unknown;
  approvalId?: string | null;
  undo?: UndoRecipe | null;
  /** Generated when absent. An outcome uses its request's correlationId. */
  correlationId?: string;
  /** Unique per (tenant, key, phase): a retried job writes nothing twice. */
  idempotencyKey?: string | null;
  observe?: boolean;
  sandbox?: boolean;
};

/** An executable undo recipe (9.1): amounts as decimal strings of minor units. */
export type UndoRecipe = { action: string } & Record<string, unknown>;

export type LedgerRecord = {
  id: string;
  seq: bigint;
  tenantId: string;
  pot: LedgerPot;
  action: string;
  phase: LedgerPhase;
  actorType: SpendActorType;
  actorId: string | null;
  assistantKey: string | null;
  autonomyLevel: number | null;
  targetType: string | null;
  targetId: string | null;
  metaObjectId: string | null;
  currency: string | null;
  amountMinor: bigint | null;
  forecastTodayMinor: bigint | null;
  forecastMonthMinor: bigint | null;
  before: unknown;
  after: unknown;
  snapshot: unknown;
  reason: string;
  reasonCodes: string[];
  approvalId: string | null;
  undo: unknown;
  correlationId: string;
  idempotencyKey: string | null;
  observe: boolean;
  sandbox: boolean;
  createdAt: Date;
};

// ===== Meta spending limit (5) =====

export type MetaSpendLimitMode =
  | "off"
  | "pending_owner"
  | "managed"
  | "withdrawn"
  | "unavailable_prepaid"
  | "no_permission"
  | "currency_mismatch"
  | "sandbox"
  | "error"
  | "other_workspace";
export type MetaCapUnitMode = "unverified" | "major_write" | "minor_write";
export type MetaCapSemantics = "unverified" | "cumulative" | "resets_on_write";
export type MetaCapPriority = "P0_stop" | "P0_restore" | "P1_lower" | "P2_rollover" | "P3_raise" | "offboard";
/** The 5.8 choices when Meta's limit is turned off or the account leaves Edwyz. */
export type MetaOffboardChoice = "keep" | "restore" | "remove";

// ===== Breakers (6) =====

export type BreakerKind =
  | "pacing"
  | "efficiency"
  | "spend_jump"
  | "cpm_ctr_anomaly"
  | "account_spike"
  | "daily_limit"
  | "monthly_limit"
  | "budget_change_quota"
  | "sync_stale"
  | "meta_cap_units"
  | "meta_cap_unreachable"
  | "meta_cap_stale_high"
  | "external_edit"
  | "wa_quality_yellow"
  | "wa_quality_red"
  | "wa_restricted"
  | "waba_disabled";
export type BreakerScopeType = "workspace" | "ad_account" | "campaign" | "adset" | "phone" | "template" | "waba" | "assistant";
export type BreakerEffect = "pause_scope" | "block_raises" | "block_marketing" | "block_automated" | "block_all_outbound" | "notify_only";
export type BreakerState = "tripped" | "cleared";

// ===== Approvals, mandates and shadow (7) =====

export type SpendApprovalStatus = "pending" | "approved" | "declined" | "expired" | "applied" | "failed" | "superseded";
export type SpendApprovalVia = "app" | "link" | "whatsapp" | "system";
export type ApprovalDirection = "raise" | "lower";
export type PolicyVerdict = "auto" | "needs_approval" | "refuse" | "shadow";
export type ShadowDecision = "auto" | "needs_approval" | "refuse";

// ===== Queues (worker jobs named by the spend controls) =====

export const SPEND_QUEUES = {
  /** Kill switch propagation (4.11): pause what a freeze covers. */
  stop: "spend.stop",
  /** Recompute Meta's limit target after a limit change (WP-16, 5.4 P1/P3). */
  metacapReplan: "spend.metacap.replan",
  /** Emergency write after a failed or unreachable pause (5.4 P0). */
  metacapP0: "spend.metacap.p0",
  /** Apply the 5.8 offboarding choice (close, erase, suspend, account change, disconnect). */
  metacapOffboard: "spend.metacap.offboard",
  /** Run the breakers for one workspace now (after a sync or a limit change). */
  breakersRun: "spend.breakers.run",
} as const;
export type SpendQueueName = (typeof SPEND_QUEUES)[keyof typeof SPEND_QUEUES];

/** Job payloads carry ids and codes only; amounts as decimal strings of minor units. */
export type SpendStopJob = {
  tenantId: string | "*";
  level: Exclude<FreezeLevel, "none">;
  /** Which campaigns: only assistant-launched ones (freeze assistants) or every platform campaign. */
  origin: "assistant" | "all";
  adAccountAssetId?: string;
  reason: string;
  actor: SpendActor;
  correlationId?: string;
};
export type MetacapReplanJob = { tenantId: string; adAccountAssetId?: string; reason: string; correlationId?: string };
export type MetacapP0Job = { tenantId: string; adAccountAssetId: string; reason: string; correlationId: string; failedObjectIds?: string[] };
export type MetacapOffboardJob = {
  tenantId: string;
  adAccountAssetId: string;
  choice: MetaOffboardChoice;
  trigger: "turn_off" | "account_change" | "close" | "erase" | "suspend" | "disconnect";
  actor: SpendActor;
  reason: string;
};
export type BreakersRunJob = { tenantId: string; reason: string };
export type SpendJobPayloads = {
  "spend.stop": SpendStopJob;
  "spend.metacap.replan": MetacapReplanJob;
  "spend.metacap.p0": MetacapP0Job;
  "spend.metacap.offboard": MetacapOffboardJob;
  "spend.breakers.run": BreakersRunJob;
};

// ===== Notifications (7.4, 9.3) =====

export type SpendNoticeKind =
  | "approval_waiting"
  | "approval_decided"
  | "breaker_tripped"
  | "breaker_cleared"
  | "limit_reached"
  | "ai_limit_80"
  | "ai_limit_100"
  | "spending_stopped"
  | "spending_resumed"
  | "meta_limit"
  | "probation"
  | "digest"
  | "optin";
export type SpendNoticeSeverity = "action_needed" | "heads_up" | "fyi";
export type SpendNoticeAudience = "owner" | "approvers" | "admins" | "members" | "platform_admins";
export type NotifyChannelKind = "whatsapp" | "email" | "in_app";

/**
 * One notice for the notifier (WP-15). Payloads carry ids, codes, campaign names and formatted amounts only, never customer
 * contact data. `dedupeKey` makes a retried notice a no-op (claimOnce).
 */
export type SpendNotice = {
  tenantId: string;
  kind: SpendNoticeKind;
  severity: SpendNoticeSeverity;
  audience: SpendNoticeAudience;
  dedupeKey: string;
  /** Plain-language text in the product's voice, already formatted with the currency exponent. */
  title: string;
  body: string;
  /** Allowlisted /app path the notice opens. */
  link?: string;
  subjectType?: string;
  subjectId?: string;
  approvalId?: string;
  correlationId?: string;
  params?: Record<string, string | number>;
};

export type NotifyResult = {
  delivered: NotifyChannelKind[];
  skipped: { channel: NotifyChannelKind; reason: string }[];
  deduplicated: boolean;
};

/**
 * What the book and the breakers call to tell people. Stubbed as in-app only until WP-15 ships the WhatsApp sender. There is
 * no email path (12.1a decision 2: no SMTP; the email fallback ships switched off and the UI says so), so no copy may say
 * "we emailed you".
 */
export interface NotifyPort {
  notify(notice: SpendNotice): Promise<NotifyResult>;
  /** Erasure duty (3.5): remove the owner's data held in the notifier workspace for this workspace. */
  eraseOwnerData(tenantId: string): Promise<void>;
}

// ===== New-workspace (probation) ceilings seeded by 0009 (12.1a decision 3) =====

export const PROBATION_CEILING_DEFAULTS: Readonly<Record<Pot, { currency: string; dailyMinor: bigint | null; monthlyMinor: bigint | null }>> = {
  ads: { currency: "INR", dailyMinor: 200_000n, monthlyMinor: 2_000_000n },
  messaging: { currency: "INR", dailyMinor: 50_000n, monthlyMinor: 500_000n },
  ai: { currency: "CRD", dailyMinor: null, monthlyMinor: 500n },
};

// =====================================================================================================================
// DTOs. Amounts are MoneyDTO (decimal string of minor units, currency and formatted text). Dates are ISO strings.
// Every role gets the Spending limits page (8.1); what differs per role is in SpendCapabilities and in which fields exist.
// =====================================================================================================================

/** What the caller may do on the Spending limits page (8.1 role table). The server enforces the same rules. */
export type SpendCapabilities = {
  role: SpendRole;
  canSeeActivity: boolean;
  canExportActivity: boolean;
  /** Lower a limit that already has a number. */
  canLowerLimits: boolean;
  /** Raise a limit, clear one to Not set, or set a number where it was Not set (decision 2.3.8). Owner only. */
  canRaiseLimits: boolean;
  canStopSpending: boolean;
  canResumeSpending: boolean;
  canChooseSpendingAccount: boolean;
  canManageMetaLimit: boolean;
  canRaiseAssistants: boolean;
  canLowerAssistants: boolean;
  canApproveRaises: boolean;
  /** Decline requests and decide lowering suggestions. */
  canDecide: boolean;
  canEditControlSettings: boolean;
  canSetOwnAlertsNumber: boolean;
  canUndoRaises: boolean;
  canUndoLowerings: boolean;
};

export type WorkspaceSpendState = "active" | "locked" | "suspended";

export type FreezeDTO = {
  workspace: FreezeLevel;
  platform: FreezeLevel;
  effective: FreezeLevel;
  since: string | null;
  byKind: FrozenByKind | null;
  /** Display name of who stopped it ("Priya", "Edwyz support"). */
  byName: string | null;
  reason: string | null;
  /** Plain status line for the strip (8.1 KillSwitch). */
  text: string;
};

export type ProbationDTO = {
  /** On = the new-workspace limits apply now. */
  on: boolean;
  setting: ProbationSetting;
  /** Why it is on or off, in plain words ("2 payments made", "Marked verified by Edwyz"). */
  why: string;
  paidInvoices: number;
  verifiedAt: string | null;
  ceilings: { pot: Pot; daily: MoneyDTO | null; monthly: MoneyDTO | null }[];
  /** The new-workspace note (8.1), or null when it is off. */
  note: string | null;
};

export type TimezonesDTO = {
  /** SpendControl.timezone: messaging and AI days, and the digest. */
  workspace: string;
  /** The spending ad account's zone: ads days and weeks. Null with no ad account. */
  ads: string | null;
  differs: boolean;
  /** The time zone line of 8.1, naming both zones when they differ. */
  text: string;
};

export type PotStatus = "ok" | "near_limit" | "limit_reached" | "not_set" | "currency_mismatch" | "not_connected";

export type PotPeriodDTO = {
  spent: MoneyDTO;
  /** Ads: "Set aside for running ads" (worst case). */
  committed: MoneyDTO;
  /** Messaging: "Set aside for broadcasts in progress". AI: calls in flight. */
  held: MoneyDTO;
  /** Null when the limit for this period is not set. */
  left: MoneyDTO | null;
  /** Whole percent of the effective limit used (spent + set aside), or null when not set. */
  usedPct: number | null;
};

export type PotLimitsDTO = {
  /** The owner's own limits. Null = "Not set". */
  daily: MoneyDTO | null;
  monthly: MoneyDTO | null;
  /** min(owner, ceiling): what actually applies. */
  effectiveDaily: MoneyDTO | null;
  effectiveMonthly: MoneyDTO | null;
  ceiling: { daily: MoneyDTO | null; monthly: MoneyDTO | null; source: CeilingSource | null; expiresAt: string | null; unknown: boolean };
  binding: LimitBinding;
  /** Migrated workspaces: the old CapPanel cap C (now ceil(1.75 C)). */
  migratedFromCap: MoneyDTO | null;
  /** AI: the plan's monthly credits ("Your plan allows up to 500 credits a month"). */
  planCapMonthly: MoneyDTO | null;
  /** Optimistic version for PUT /api/spend/allowances (0 when no row exists yet). */
  version: number;
};

/** Per-field editing rules for the inputs of one pot card (8.1). */
export type PotEditDTO = {
  editable: boolean;
  /** Admins: the input max is the current value. Null = no max (owner). */
  maxDaily: MoneyDTO | null;
  maxMonthly: MoneyDTO | null;
  canChangeCurrency: boolean;
  currencyOptions: string[];
};

export type PotDTO = {
  pot: Pot;
  /** Card title: "Ads on Facebook and Instagram" | "WhatsApp messages" | "AI usage". */
  title: string;
  currency: string;
  status: PotStatus;
  limits: PotLimitsDTO;
  month: PotPeriodDTO;
  today: PotPeriodDTO;
  edit: PotEditDTO;
  /** Ads only: spend from outside Edwyz on the account (an estimate; counted only when Meta's limit is managed). */
  external: { counted: boolean; spentMonth: MoneyDTO; riskMonth: MoneyDTO; estimated: true } | null;
  /** Ads only: grandfathered campaigns on another ad account in another currency, listed but not counted (3.1). */
  otherCurrency: { accountName: string; currency: string; couldAddThisMonth: MoneyDTO }[];
  /** Ads only: today's spend counted at its worst case because data is more than 60 minutes old. */
  stale: boolean;
  /** Something is connected for this pot (ad account, WhatsApp number). AI is always true. */
  connected: boolean;
  /** Demo workspace: figures are seeded sample data. */
  sampleData: boolean;
  /** Plain help and state lines for the card, in order (8.1 copy). */
  notes: string[];
};

export type AdAccountDTO = { assetId: string; externalId: string; name: string | null; currency: string | null; timezone: string | null; sandbox: boolean; demo: boolean };

export type SpendingAccountDTO = {
  chosen: AdAccountDTO | null;
  accounts: AdAccountDTO[];
  /** Several ad accounts and none chosen: new ads can't start until the owner chooses. */
  needsChoice: boolean;
};

export type MetaLimitState =
  | "managed"
  | "ready"
  | "off"
  | "pending_owner"
  | "withdrawn"
  | "unavailable_prepaid"
  | "no_permission"
  | "currency_mismatch"
  | "other_workspace"
  | "sandbox"
  | "demo"
  | "error"
  | "deferred"
  | "loose"
  | "needs_monthly_limit"
  | "kept_while_paused";

/** The "Spending limit on Meta" card (8.1 MetaLimitCard): every state the card can show. */
export type MetaLimitDTO = {
  adAccountAssetId: string;
  accountName: string | null;
  accountExternalId: string;
  currency: string | null;
  mode: MetaSpendLimitMode;
  state: MetaLimitState;
  /** The 5.1 definition: mode managed, SPEND_CAP_MODE=enforce, a verified unit mode and a verified last write. */
  managed: boolean;
  /** The card's state line, verbatim from 8.1 ("Managed by Edwyz. Meta will stop this account after ₹6,800 more this month."). */
  text: string;
  cap: MoneyDTO | null;
  amountSpent: MoneyDTO | null;
  /** How much more Meta will let the account spend this month (cap - amount spent). */
  roomLeft: MoneyDTO | null;
  target: MoneyDTO | null;
  looseBy: MoneyDTO | null;
  /** "Put back my old limit (₹X)" in the turn-off dialog; null when there was none. */
  previousCap: MoneyDTO | null;
  deferredUntil: string | null;
  lastReadAt: string | null;
  canTurnOn: boolean;
  canTurnOff: boolean;
  offboardChoices: MetaOffboardChoice[];
  /** In-app next step, such as [Connect again with an admin account] (5.7); never a link to Meta Ads Manager. */
  action: { kind: "connect_again" | "turn_on" | "set_monthly_limit"; label: string } | null;
};

export type BreakerDTO = {
  id: string;
  kind: BreakerKind | string;
  /** Plain name: "Safety stop: spending too fast". */
  label: string;
  scopeType: BreakerScopeType;
  scopeId: string;
  scopeName: string | null;
  state: BreakerState;
  effect: BreakerEffect;
  reason: string;
  trippedAt: string;
  clearedAt: string | null;
  autoClearAt: string | null;
  /** Clearing one that paused something is a raise: owner or approver, through the checks (6). */
  canClear: boolean;
  clearIsRaise: boolean;
};

export type ApprovalDTO = {
  id: string;
  assistantKey: string;
  /** "Ad assistant" (7.1). */
  assistantLabel: string;
  pot: Pot;
  actionKind: string;
  direction: ApprovalDirection;
  /** "Raise the daily budget of 'Diwali leads - Delhi' from ₹800 to ₹1,000". */
  summary: string;
  /** "Why: cost per lead is ₹62, well below your ₹100 target". */
  reason: string;
  forecastToday: MoneyDTO | null;
  forecastMonth: MoneyDTO | null;
  /** "Could add up to ₹4,550 this month (worst case)". */
  forecastText: string | null;
  status: SpendApprovalStatus;
  createdAt: string;
  expiresAt: string;
  /** "Declined automatically in 11 hours" / "Declined automatically (no answer in 12 hours)." */
  expiryText: string;
  decidedAt: string | null;
  decidedByName: string | null;
  decidedVia: SpendApprovalVia | null;
  failureReason: string | null;
  canApprove: boolean;
  canDecline: boolean;
};

export type MandateDTO = {
  assistantKey: string;
  enabled: boolean;
  level: AutonomyLevel;
  /** 0 while ASSISTANT_SPEND_ENABLED=false or during shadow, whatever the configured level. */
  effectiveLevel: AutonomyLevel;
  allowedOps: string[];
  maxDaily: MoneyDTO | null;
  maxMonthly: MoneyDTO | null;
  currency: string | null;
  targetCostPerLead: MoneyDTO | null;
  raiseStepPct: number;
  approvalSharePct: number;
  shadowStartedAt: string | null;
  shadowUntil: string | null;
  sandboxOnly: boolean;
  version: number;
  updatedAt: string | null;
};

export type ShadowSummaryDTO = {
  learning: boolean;
  until: string | null;
  /** "Learning: suggests only until 11 Nov. So far it would have made 12 changes (9 cuts, 3 raises worth up to ₹4,200)." */
  text: string | null;
  wouldHaveMade: number;
  cuts: number;
  raises: number;
  raisesWorthUpTo: MoneyDTO | null;
  wouldExceedAllowance: number;
  /** Share of suggestions owners agreed with, 0-100, or null before any were decided. */
  agreedPct: number | null;
};

export type AssistantLevelOptionDTO = { level: AutonomyLevel; label: string; description: string };

export type AssistantDTO = {
  assistantKey: string;
  label: string;
  pots: Pot[];
  /** live: exists today; planned: a Phase 1 consumer. */
  phase: "live" | "planned";
  /** Null when no AssistantMandate row exists: suggestions only (7.2). */
  mandate: MandateDTO | null;
  shadow: ShadowSummaryDTO;
  levelOptions: AssistantLevelOptionDTO[];
  canRaise: boolean;
  canLower: boolean;
};

export type LedgerActorDTO = {
  type: SpendActorType;
  id: string | null;
  /** "Priya", "Priya (with Eddy)", "Ad assistant", "Safety stop", "Edwyz support", "Changed in Meta Ads Manager". */
  label: string;
  viaEddy: boolean;
};

export type LedgerRowDTO = {
  id: string;
  /** Cursor value (decimal string of the bigint seq). */
  seq: string;
  createdAt: string;
  pot: LedgerPot;
  action: string;
  phase: LedgerPhase;
  actor: LedgerActorDTO;
  assistantKey: string | null;
  autonomyLevel: number | null;
  targetType: string | null;
  targetId: string | null;
  metaObjectId: string | null;
  /** "What" column, for example "Raised daily budget ₹800 -> ₹1,000". */
  summary: string;
  amount: MoneyDTO | null;
  /** "Could add (worst case)" column. */
  forecastToday: MoneyDTO | null;
  forecastMonth: MoneyDTO | null;
  reason: string;
  reasonCodes: string[];
  approvalId: string | null;
  correlationId: string;
  observe: boolean;
  sandbox: boolean;
  /** Undo is offered only when a recipe exists, within 14 days, and the caller's role allows it (9.2). */
  undo: { available: boolean; isRaise: boolean; until: string | null };
};

export type LedgerPageDTO = { rows: LedgerRowDTO[]; nextCursor: string | null };

export type NotifyChannelStatus = "pending" | "verified" | "opted_out";

export type NotifyChannelDTO = {
  id: string;
  userId: string;
  /** Masked unless it is the caller's own number. */
  phone: string;
  status: NotifyChannelStatus;
  optInAt: string | null;
  verifiedAt: string | null;
  optOutAt: string | null;
  lastSentAt: string | null;
  /** The platform sender shown in the pending text ("+1 711-268-5789"). */
  senderDisplay: string;
};

export type NotifySettingsDTO = {
  /** The caller's own channel, if any. */
  own: NotifyChannelDTO | null;
  /** Email fallback state; off until SMTP exists (12.1a decision 2), and the UI says so. */
  emailFallback: "on" | "off";
  emailFallbackText: string | null;
  digestEnabled: boolean;
};

export type ControlSettingsDTO = {
  approverUserIds: string[];
  approvers: { userId: string; name: string }[];
  approvalTtlHours: number;
  timezone: string;
  targetCostPerLead: MoneyDTO | null;
  breakersMayPauseHumanCampaigns: boolean;
  digestEnabled: boolean;
  version: number;
};

export type PausedByStopDTO = { campaignId: string; name: string; adAccountName: string | null; pausedAt: string; canResume: boolean };

export type SpendBannerKind =
  | "platform_frozen"
  | "workspace_stopped"
  | "limit_reached"
  | "approvals_waiting"
  | "meta_limit_attention"
  | "new_workspace"
  | "choose_spending_account"
  | "meta_limit_waiting_owner";

/** The single banner the AppShell shows, highest priority first (8.2). */
export type SpendBannerDTO = { kind: SpendBannerKind; text: string; link: string; dismissible: boolean; tone: "danger" | "warning" | "info" };

type SpendSummaryCommon = {
  tenantId: string;
  generatedAt: string;
  capabilities: SpendCapabilities;
  /** observe: new checks only write would-refuse rows (I12). */
  enforce: EnforceMode;
  workspaceState: WorkspaceSpendState;
  demo: boolean;
  freeze: FreezeDTO;
  probation: ProbationDTO;
  timezones: TimezonesDTO;
  pots: { ads: PotDTO; messaging: PotDTO; ai: PotDTO };
  spendingAccount: SpendingAccountDTO;
  /** Null with no ad account connected (no Meta card, 8.4). */
  metaLimit: MetaLimitDTO | null;
  assistants: AssistantDTO[];
  /** False: "Assistants only make suggestions for now." */
  assistantSpendEnabled: boolean;
  breakers: BreakerDTO[];
  approvalsWaiting: number;
  /** Campaigns a stop paused, for the guarded [Resume] list (decision 2.3.13). */
  pausedByStop: PausedByStopDTO[];
  banner: SpendBannerDTO | null;
};

/** Owner: everything, every control editable. */
export type OwnerSpendSummaryDTO = SpendSummaryCommon & {
  role: "owner";
  approvals: ApprovalDTO[];
  controlSettings: ControlSettingsDTO;
  notify: NotifySettingsDTO;
  /** Stored digest for the "Yesterday" strip. */
  yesterday: string | null;
};

/** Admin: sees everything; lowers and stops; approves only when named an approver. */
export type AdminSpendSummaryDTO = SpendSummaryCommon & {
  role: "admin";
  approvals: ApprovalDTO[];
  controlSettings: ControlSettingsDTO;
  notify: NotifySettingsDTO;
  yesterday: string | null;
};

/** Team member: read-only status, pots, limits, Meta state, assistants and probation note; no activity rows, no approvals list. */
export type MemberSpendSummaryDTO = SpendSummaryCommon & { role: "agent" };

export type SpendSummaryDTO = OwnerSpendSummaryDTO | AdminSpendSummaryDTO | MemberSpendSummaryDTO;

/** Result of a stop toggle that paused inline (4.11): "Paused 4 of 6; the rest will follow within a minute." */
export type StopResultDTO = { level: FreezeLevel; paused: number; total: number; pending: number; failed: number; text: string };

// ===== Platform admin panel (8.3) =====

export type AdminSpendState = "on" | "assistants_stopped" | "stopped";

export type AdminPeriodCellDTO = { spent: MoneyDTO; setAside: MoneyDTO; limit: MoneyDTO | null };

/** One row of /admin/spending, built from the spend:summary:<tenantId> cache; amounts in the workspace's own currency. */
export type AdminSpendRowDTO = {
  tenantId: string;
  name: string;
  slug: string;
  plan: string | null;
  demo: boolean;
  newWorkspaceLimits: "on" | "lifted" | "forced";
  adsToday: AdminPeriodCellDTO | null;
  adsMonth: AdminPeriodCellDTO | null;
  whatsappMonth: AdminPeriodCellDTO | null;
  aiMonth: { used: MoneyDTO; limit: MoneyDTO | null };
  /** "Managed ₹X" / "Off" / "Waiting for owner" / "Prepaid" / "No permission" / "Out of date" / "Loose by ₹Y" / "No ad account". */
  metaLimit: { state: MetaLimitState | "no_ad_account"; label: string };
  breakersOpen: number;
  requestsWaiting: number;
  state: AdminSpendState;
  /** (spent + set aside) / limit, 0-100+, for the risk sort; null for demo or when nothing has a limit. */
  riskPct: number | null;
  /** When the cached summary was written ("as of 14:05"); null for workspaces with no summary yet (shown with defaults). */
  asOf: string | null;
  noAdAccount: boolean;
  noWhatsApp: boolean;
};

export type AdminSpendListDTO = { rows: AdminSpendRowDTO[]; total: number; page: number; pageSize: number; platformFreeze: FreezeLevel };
