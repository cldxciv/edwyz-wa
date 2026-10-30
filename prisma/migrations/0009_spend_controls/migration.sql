-- 0009_spend_controls. Phase 0 spend controls. See docs/SPEND-CONTROLS-SPEC.md.
-- Also carries Eddy's tables (docs/EDDY-SPEC.md 8.1, the former 0011_eddy), folded in because their only dependency is the
-- function edwyz_append_only() created below. Everything runs in ONE transaction.
--
-- Apply: psql -1 -v ON_ERROR_STOP=1 -f migration.sql (as edwyz_wa_app), record it in MIGRATIONS-APPLIED, then npx prisma generate.
-- Check SHOW server_version first (11 or later). Additive only (SPEND 3.2.1): no DROP, RENAME, type change or UPDATE of any
-- existing row. 0010_spend_message_indexes follows WITHOUT -1, off-peak; nothing here depends on it.

-- (critic) Fail fast instead of queueing behind long transactions and stalling every request behind this ALTER.
-- psql -1 runs the file in one transaction, so SET LOCAL lasts until COMMIT. If it times out, nothing is applied; retry.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ===== AlterTable: existing tables =====
ALTER TABLE "AdCampaign"
  ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'human',
  ADD COLUMN "assistantKey" TEXT,
  ADD COLUMN "lifetimeBudgetMinor" BIGINT,
  ADD COLUMN "targetCostPerResultMinor" BIGINT,
  ADD COLUMN "sandbox" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AdCampaign" ADD CONSTRAINT "AdCampaign_origin_check" CHECK ("origin" IN ('human','assistant','api'));
ALTER TABLE "AdCampaign" ADD CONSTRAINT "AdCampaign_assistant_end_check"
  CHECK ("origin" <> 'assistant' OR "endsAt" IS NOT NULL OR "lifetimeBudgetMinor" IS NOT NULL);

ALTER TABLE "AdSet" ADD COLUMN "lifetimeBudgetMinor" BIGINT;

ALTER TABLE "MetaAsset" ADD COLUMN "sandbox" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Message"
  ADD COLUMN "origin" TEXT,
  ADD COLUMN "pricingCategory" TEXT,
  ADD COLUMN "estCostMinor" BIGINT,
  ADD COLUMN "costMinor" BIGINT,
  ADD COLUMN "billable" BOOLEAN,
  ADD COLUMN "pricingType" TEXT,
  ADD COLUMN "spendDay" DATE,
  ADD COLUMN "spendState" TEXT,
  ADD COLUMN "reservationId" TEXT,
  ADD COLUMN "pricingSettledAt" TIMESTAMP(3);
-- (critic) NOT VALID: every existing row has spendState NULL, so a validating scan of the whole Message table under an
-- ACCESS EXCLUSIVE lock is pointless. New and updated rows are still checked. VALIDATE runs later in 0010 without blocking writes.
ALTER TABLE "Message" ADD CONSTRAINT "Message_spendState_check"
  CHECK ("spendState" IS NULL OR "spendState" IN ('reserved','settled','released')) NOT VALID;
-- origin: human | api | mcp | assistant | broadcast | automation | chatbot | ai_reply | lead_sequence | commerce | consent | approval | admin_test | system_notify | eddy | unknown
-- (critic) The two Message indexes moved to 0010_spend_message_indexes (CREATE INDEX CONCURRENTLY, which cannot run inside psql -1).
-- A plain CREATE INDEX here would block inbound webhooks and sends for the whole build. See 3.2.1.

ALTER TABLE "UsageLedger" ADD COLUMN "inputTokens" INTEGER, ADD COLUMN "outputTokens" INTEGER, ADD COLUMN "model" TEXT;

-- ===== CreateTable SpendControl (per-workspace switches, probation, approvers) =====
CREATE TABLE "SpendControl" (
  "tenantId" TEXT NOT NULL,
  "freeze" TEXT NOT NULL DEFAULT 'none',
  "frozenByKind" TEXT,
  "frozenByUserId" TEXT,
  "frozenReason" TEXT,
  "frozenAt" TIMESTAMP(3),
  "probation" TEXT NOT NULL DEFAULT 'auto',
  "probationReason" TEXT,
  "probationChangedByUserId" TEXT,
  "verifiedAt" TIMESTAMP(3),
  "spendingAdAccountAssetId" TEXT,
  "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  "approverUserIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "approvalTtlHours" INTEGER NOT NULL DEFAULT 12,
  "targetCostPerLeadMinor" BIGINT,
  "breakersMayPauseHumanCampaigns" BOOLEAN NOT NULL DEFAULT false,
  "digestEnabled" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SpendControl_pkey" PRIMARY KEY ("tenantId"),
  CONSTRAINT "SpendControl_freeze_check" CHECK ("freeze" IN ('none','assistants','all')),
  CONSTRAINT "SpendControl_frozenBy_check" CHECK ("frozenByKind" IS NULL OR "frozenByKind" IN ('owner','admin','platform_admin','breaker')),
  CONSTRAINT "SpendControl_probation_check" CHECK ("probation" IN ('auto','lifted','forced')),
  CONSTRAINT "SpendControl_ttl_check" CHECK ("approvalTtlHours" BETWEEN 1 AND 48)
);

-- ===== CreateTable SpendAllowance (owner limits, one row per pot; NULL = 'Not set') =====
CREATE TABLE "SpendAllowance" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "pot" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "dailyLimitMinor" BIGINT,
  "monthlyLimitMinor" BIGINT,
  "migratedFromCapMinor" BIGINT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SpendAllowance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SpendAllowance_pot_check" CHECK ("pot" IN ('ads','messaging','ai')),
  CONSTRAINT "SpendAllowance_amounts_check" CHECK (
    ("dailyLimitMinor" IS NULL OR "dailyLimitMinor" > 0) AND
    ("monthlyLimitMinor" IS NULL OR "monthlyLimitMinor" > 0) AND
    ("dailyLimitMinor" IS NULL OR "monthlyLimitMinor" IS NULL OR "dailyLimitMinor" <= "monthlyLimitMinor"))
);
CREATE UNIQUE INDEX "SpendAllowance_tenantId_pot_key" ON "SpendAllowance"("tenantId","pot");

-- ===== CreateTable SpendCeiling (platform ceilings; scopeId: '*' for platform/probation, Plan.id for plan, Tenant.id for tenant override) =====
CREATE TABLE "SpendCeiling" (
  "id" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "scopeId" TEXT NOT NULL,
  "pot" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "dailyMinor" BIGINT,
  "monthlyMinor" BIGINT,
  "reason" TEXT,
  "setByUserId" TEXT,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SpendCeiling_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SpendCeiling_scope_check" CHECK ("scope" IN ('platform','probation','plan','tenant')),
  CONSTRAINT "SpendCeiling_pot_check" CHECK ("pot" IN ('ads','messaging','ai')),
  CONSTRAINT "SpendCeiling_amounts_check" CHECK (("dailyMinor" IS NULL OR "dailyMinor" >= 0) AND ("monthlyMinor" IS NULL OR "monthlyMinor" >= 0))
);
CREATE UNIQUE INDEX "SpendCeiling_scope_scopeId_pot_currency_key" ON "SpendCeiling"("scope","scopeId","pot","currency");

-- ===== CreateTable SpendCommitment (live ads reservations; one row per budget-holding Meta object) =====
CREATE TABLE "SpendCommitment" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "adAccountAssetId" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "adSetId" TEXT,
  "metaObjectId" TEXT NOT NULL,
  "objectLevel" TEXT NOT NULL,
  "origin" TEXT NOT NULL,
  "assistantKey" TEXT,
  "currency" TEXT NOT NULL,
  "timezone" TEXT NOT NULL,
  "dailyBudgetMinor" BIGINT,
  "lifetimeBudgetMinor" BIGINT,
  "pendingFromMinor" BIGINT,
  "dayKey" DATE,
  "dayStartBudgetMinor" BIGINT,
  "peakDailyBudgetMinor" BIGINT NOT NULL DEFAULT 0,
  "weekStart" DATE,
  "weekPeakDailyBudgetMinor" BIGINT NOT NULL DEFAULT 0,
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "status" TEXT NOT NULL,
  "reservedUntil" TIMESTAMP(3),
  "correlationId" TEXT,
  "sandbox" BOOLEAN NOT NULL DEFAULT false,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SpendCommitment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SpendCommitment_level_check" CHECK ("objectLevel" IN ('campaign','adset')),
  CONSTRAINT "SpendCommitment_origin_check" CHECK ("origin" IN ('human','assistant','api')),
  CONSTRAINT "SpendCommitment_status_check" CHECK ("status" IN ('reserved','live','unconfirmed','stopped')),
  CONSTRAINT "SpendCommitment_budget_check" CHECK ("dailyBudgetMinor" IS NOT NULL OR "lifetimeBudgetMinor" IS NOT NULL),
  CONSTRAINT "SpendCommitment_assistant_end_check" CHECK ("origin" <> 'assistant' OR "endsAt" IS NOT NULL OR "lifetimeBudgetMinor" IS NOT NULL)
);
CREATE UNIQUE INDEX "SpendCommitment_open_object_key" ON "SpendCommitment"("tenantId","metaObjectId") WHERE "status" <> 'stopped';
CREATE INDEX "SpendCommitment_tenantId_status_idx" ON "SpendCommitment"("tenantId","status");
CREATE INDEX "SpendCommitment_status_reservedUntil_idx" ON "SpendCommitment"("status","reservedUntil");

-- ===== CreateTable SpendCounter (lock-free messaging/AI counters; a cache of row truth, rebuilt every 15 min) =====
CREATE TABLE "SpendCounter" (
  "tenantId" TEXT NOT NULL,
  "pot" TEXT NOT NULL,
  "periodKind" TEXT NOT NULL,
  "periodKey" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "reservedMinor" BIGINT NOT NULL DEFAULT 0,
  "spentMinor" BIGINT NOT NULL DEFAULT 0,
  "reconciledAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SpendCounter_pkey" PRIMARY KEY ("tenantId","pot","periodKind","periodKey"),
  CONSTRAINT "SpendCounter_pot_check" CHECK ("pot" IN ('messaging','ai')),
  CONSTRAINT "SpendCounter_kind_check" CHECK ("periodKind" IN ('day','month')),
  CONSTRAINT "SpendCounter_nonneg_check" CHECK ("reservedMinor" >= 0 AND "spentMinor" >= 0)
);

-- ===== CreateTable SpendReservation (bulk messaging holds and in-flight AI calls) =====
CREATE TABLE "SpendReservation" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "pot" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "subjectType" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "consumedMinor" BIGINT NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'held',
  "dayKey" TEXT NOT NULL,
  "monthKey" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "correlationId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" TIMESTAMP(3),
  CONSTRAINT "SpendReservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SpendReservation_pot_check" CHECK ("pot" IN ('messaging','ai')),
  CONSTRAINT "SpendReservation_subject_check" CHECK ("subjectType" IN ('broadcast','automation_run','api_batch','ai_call')),
  CONSTRAINT "SpendReservation_status_check" CHECK ("status" IN ('held','settled','released','expired')),
  CONSTRAINT "SpendReservation_amount_check" CHECK ("amountMinor" > 0 AND "consumedMinor" >= 0)
);
CREATE UNIQUE INDEX "SpendReservation_open_subject_key" ON "SpendReservation"("tenantId","subjectType","subjectId") WHERE "status" = 'held';
CREATE INDEX "SpendReservation_status_expiresAt_idx" ON "SpendReservation"("status","expiresAt");

-- ===== CreateTable SpendDaily (observed spend per account day; SET, never incremented: Meta revises for up to 28 days) =====
CREATE TABLE "SpendDaily" (
  "tenantId" TEXT NOT NULL,
  "pot" TEXT NOT NULL,
  "scopeType" TEXT NOT NULL,
  "scopeId" TEXT NOT NULL,
  "day" DATE NOT NULL,
  "currency" TEXT NOT NULL,
  "amountMinor" BIGINT NOT NULL DEFAULT 0,
  "origin" TEXT NOT NULL,
  "results" INTEGER,
  "impressions" BIGINT,
  "clicks" BIGINT,
  "source" TEXT NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL,
  -- (critic) origin is part of the key: the account 'all' row and the account 'external' row (6.1 step 3) share scope and day.
  CONSTRAINT "SpendDaily_pkey" PRIMARY KEY ("tenantId","pot","scopeType","scopeId","day","origin"),
  CONSTRAINT "SpendDaily_scope_check" CHECK ("scopeType" IN ('account','campaign','adset','phone')),
  CONSTRAINT "SpendDaily_origin_check" CHECK ("origin" IN ('platform','external','all'))
);
CREATE INDEX "SpendDaily_tenantId_pot_day_idx" ON "SpendDaily"("tenantId","pot","day");

-- ===== CreateTable IntradaySpendSample (15-minute cumulative samples for today; kept 35 days) =====
CREATE TABLE "IntradaySpendSample" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "adAccountAssetId" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityMetaId" TEXT NOT NULL,
  "accountDate" DATE NOT NULL,
  "sampledAt" TIMESTAMP(3) NOT NULL,
  "spendMinor" BIGINT NOT NULL,
  "impressions" BIGINT NOT NULL,
  "clicks" BIGINT NOT NULL,
  "results" INTEGER NOT NULL,
  CONSTRAINT "IntradaySpendSample_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IntradaySpendSample_entity_check" CHECK ("entityType" IN ('account','adset'))
);
CREATE INDEX "IntradaySpendSample_tenantId_entityMetaId_sampledAt_idx" ON "IntradaySpendSample"("tenantId","entityMetaId","sampledAt");

-- ===== CreateTable SpendLedger (R8; append-only by trigger) =====
CREATE TABLE "SpendLedger" (
  "id" TEXT NOT NULL,
  "seq" BIGSERIAL NOT NULL,
  "tenantId" TEXT NOT NULL,
  "pot" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "phase" TEXT NOT NULL,
  "actorType" TEXT NOT NULL,
  "actorId" TEXT,
  "assistantKey" TEXT,
  "autonomyLevel" SMALLINT,
  "targetType" TEXT,
  "targetId" TEXT,
  "metaObjectId" TEXT,
  "currency" TEXT,
  "amountMinor" BIGINT,
  "forecastTodayMinor" BIGINT,
  "forecastMonthMinor" BIGINT,
  "before" JSONB,
  "after" JSONB,
  "snapshot" JSONB,
  "reason" TEXT NOT NULL,
  "reasonCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "approvalId" TEXT,
  "undo" JSONB,
  "correlationId" TEXT NOT NULL,
  "idempotencyKey" TEXT,
  "observe" BOOLEAN NOT NULL DEFAULT false,
  "sandbox" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SpendLedger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SpendLedger_pot_check" CHECK ("pot" IN ('ads','messaging','ai','none')),
  CONSTRAINT "SpendLedger_phase_check" CHECK ("phase" IN ('requested','applied','failed','unconfirmed','refused','shadow','reconciled','info')),
  -- (critic) 'external' = a change Edwyz detected but did not make (Meta Ads Manager edits, a customer's own spend_cap change).
  CONSTRAINT "SpendLedger_actor_check" CHECK ("actorType" IN ('user','assistant','system','breaker','platform_admin','api','external'))
);
CREATE UNIQUE INDEX "SpendLedger_seq_key" ON "SpendLedger"("seq");
CREATE INDEX "SpendLedger_tenantId_createdAt_idx" ON "SpendLedger"("tenantId","createdAt");
CREATE INDEX "SpendLedger_tenantId_seq_idx" ON "SpendLedger"("tenantId","seq");
CREATE INDEX "SpendLedger_targetId_action_createdAt_idx" ON "SpendLedger"("targetId","action","createdAt");
CREATE INDEX "SpendLedger_correlationId_idx" ON "SpendLedger"("correlationId");
CREATE UNIQUE INDEX "SpendLedger_idem_key" ON "SpendLedger"("tenantId","idempotencyKey","phase") WHERE "idempotencyKey" IS NOT NULL;
-- (repair) Exactly one outcome per request, enforced here and not only by ledger.ts's read-then-insert: two concurrent
-- writers (the call site's settle and the reconciler) would otherwise both write, and the append-only trigger would keep
-- both. The only third row is one reconciled row (after unconfirmed). ledger.ts answers a P2002 with the existing row.
CREATE UNIQUE INDEX "SpendLedger_one_outcome_key" ON "SpendLedger"("tenantId","correlationId") WHERE "phase" IN ('applied','failed','unconfirmed','refused');
CREATE UNIQUE INDEX "SpendLedger_one_reconciled_key" ON "SpendLedger"("tenantId","correlationId") WHERE "phase" = 'reconciled';

-- ===== CreateTable MetaSpendLimit (wall (a) state per ad account) =====
CREATE TABLE "MetaSpendLimit" (
  "adAccountAssetId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "accountExternalId" TEXT NOT NULL,          -- (critic) Meta's act_ id, so one manager per real ad account (decision 2.3.14)
  "spentAtLastWriteMinor" BIGINT,             -- (critic) S at the last write; S = this + A under resets_on_write (5.3)
  "mode" TEXT NOT NULL DEFAULT 'off',
  "consentId" TEXT,
  "unitMode" TEXT NOT NULL DEFAULT 'unverified',
  "semantics" TEXT NOT NULL DEFAULT 'unverified',
  "customerCapAtConsentMinor" BIGINT,
  "customerAmountSpentAtConsentMinor" BIGINT,
  "managedCapMinor" BIGINT,
  "targetCapMinor" BIGINT,
  "pendingTargetMinor" BIGINT,
  "lastReadCapMinor" BIGINT,
  "lastReadAmountSpentMinor" BIGINT,
  "lastReadAt" TIMESTAMP(3),
  "monthKey" TEXT,
  "monthStartAmountSpentMinor" BIGINT,
  "loosenessMinor" BIGINT,
  "deferredUntil" TIMESTAMP(3),
  "writesBlockedUntil" TIMESTAMP(3),
  "lastWriteAt" TIMESTAMP(3),
  "lastError" TEXT,
  "currency" TEXT,
  "timezone" TEXT,
  "accountStatus" INTEGER,
  "isPrepay" BOOLEAN,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MetaSpendLimit_pkey" PRIMARY KEY ("adAccountAssetId"),
  CONSTRAINT "MetaSpendLimit_mode_check" CHECK ("mode" IN ('off','pending_owner','managed','withdrawn','unavailable_prepaid','no_permission','currency_mismatch','sandbox','error','other_workspace')),
  CONSTRAINT "MetaSpendLimit_unit_check" CHECK ("unitMode" IN ('unverified','major_write','minor_write')),
  CONSTRAINT "MetaSpendLimit_semantics_check" CHECK ("semantics" IN ('unverified','cumulative','resets_on_write'))
);
CREATE INDEX "MetaSpendLimit_tenantId_idx" ON "MetaSpendLimit"("tenantId");
-- (critic) At most one workspace manages Meta's limit on a real ad account.
-- (repair) Only 'managed' holds the slot. SPEND 12.1a decision 11: the first workspace to TURN ON Meta's limit manages it, and
-- only an owner's consent turns it on. A 'pending_owner' row (an admin connected the account, the owner has not consented)
-- never expires, so letting it hold the slot would let a workspace that never consents keep another owner's wall (a) off.
CREATE UNIQUE INDEX "MetaSpendLimit_one_manager_key" ON "MetaSpendLimit"("accountExternalId") WHERE "mode" = 'managed';

-- ===== CreateTable SpendConsent (append-only; kinds meta_spend_cap | owner_whatsapp) =====
CREATE TABLE "SpendConsent" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "subjectId" TEXT,
  "granted" BOOLEAN NOT NULL,
  "textVersion" TEXT NOT NULL,
  "textSha256" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SpendConsent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SpendConsent_kind_check" CHECK ("kind" IN ('meta_spend_cap','owner_whatsapp'))
);
CREATE INDEX "SpendConsent_tenantId_kind_subjectId_createdAt_idx" ON "SpendConsent"("tenantId","kind","subjectId","createdAt");

-- ===== CreateTable AssistantMandate (wall (c)) =====
CREATE TABLE "AssistantMandate" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "assistantKey" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "level" SMALLINT NOT NULL DEFAULT 0,
  "allowedOps" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "maxDailyMinor" BIGINT,
  "maxMonthlyMinor" BIGINT,
  "currency" TEXT,
  "targetCostPerLeadMinor" BIGINT,
  "raiseStepPct" INTEGER NOT NULL DEFAULT 20,
  "approvalSharePct" INTEGER NOT NULL DEFAULT 25,
  "shadowStartedAt" TIMESTAMP(3),
  "shadowUntil" TIMESTAMP(3),
  "sandboxOnly" BOOLEAN NOT NULL DEFAULT false,
  "updatedByUserId" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantMandate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AssistantMandate_level_check" CHECK ("level" IN (0,1,2)),
  CONSTRAINT "AssistantMandate_pct_check" CHECK ("raiseStepPct" BETWEEN 0 AND 20 AND "approvalSharePct" BETWEEN 1 AND 25)
);
CREATE UNIQUE INDEX "AssistantMandate_tenantId_assistantKey_key" ON "AssistantMandate"("tenantId","assistantKey");

-- ===== CreateTable SpendApproval (owner approval of assistant actions; separate from client ApprovalRequest) =====
CREATE TABLE "SpendApproval" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "assistantKey" TEXT NOT NULL,
  "pot" TEXT NOT NULL,
  "actionKind" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "intent" JSONB NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "forecastTodayMinor" BIGINT,
  "forecastMonthMinor" BIGINT,
  "currency" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "decidedByUserId" TEXT,
  "decidedVia" TEXT,
  "decidedAt" TIMESTAMP(3),
  "appliedAt" TIMESTAMP(3),
  "failureReason" TEXT,
  "proposalId" TEXT,
  "notifiedAt" TIMESTAMP(3),
  "correlationId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SpendApproval_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SpendApproval_direction_check" CHECK ("direction" IN ('raise','lower')),
  CONSTRAINT "SpendApproval_status_check" CHECK ("status" IN ('pending','approved','declined','expired','applied','failed','superseded')),
  CONSTRAINT "SpendApproval_via_check" CHECK ("decidedVia" IS NULL OR "decidedVia" IN ('app','link','whatsapp','system'))
);
CREATE UNIQUE INDEX "SpendApproval_tokenHash_key" ON "SpendApproval"("tokenHash");
CREATE INDEX "SpendApproval_tenantId_status_expiresAt_idx" ON "SpendApproval"("tenantId","status","expiresAt");

-- ===== CreateTable SpendBreaker (R5) =====
CREATE TABLE "SpendBreaker" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "scopeType" TEXT NOT NULL,
  "scopeId" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'tripped',
  "effect" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "details" JSONB,
  "trippedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "clearedAt" TIMESTAMP(3),
  "clearedByUserId" TEXT,
  "autoClearAt" TIMESTAMP(3),
  "notifiedAt" TIMESTAMP(3),
  CONSTRAINT "SpendBreaker_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SpendBreaker_state_check" CHECK ("state" IN ('tripped','cleared')),
  CONSTRAINT "SpendBreaker_scope_check" CHECK ("scopeType" IN ('workspace','ad_account','campaign','adset','phone','template','waba','assistant')),
  CONSTRAINT "SpendBreaker_effect_check" CHECK ("effect" IN ('pause_scope','block_raises','block_marketing','block_automated','block_all_outbound','notify_only'))
);
CREATE UNIQUE INDEX "SpendBreaker_open_key" ON "SpendBreaker"("tenantId","kind","scopeType","scopeId") WHERE "state" = 'tripped';
CREATE INDEX "SpendBreaker_tenantId_state_idx" ON "SpendBreaker"("tenantId","state");

-- ===== CreateTable AssistantShadowRecord (R6) =====
CREATE TABLE "AssistantShadowRecord" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "assistantKey" TEXT NOT NULL,
  "actionKind" TEXT NOT NULL,
  "intent" JSONB NOT NULL,
  "wouldDecision" TEXT NOT NULL,
  "forecastMonthMinor" BIGINT,
  "currency" TEXT,
  "reason" TEXT NOT NULL,
  "baseline" JSONB,
  "outcome" JSONB,
  "evaluatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantShadowRecord_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AssistantShadowRecord_would_check" CHECK ("wouldDecision" IN ('auto','needs_approval','refuse'))
);
CREATE INDEX "AssistantShadowRecord_tenantId_assistantKey_createdAt_idx" ON "AssistantShadowRecord"("tenantId","assistantKey","createdAt");

-- ===== CreateTable OwnerNotifyChannel (owner/approver WhatsApp number; personal data) =====
CREATE TABLE "OwnerNotifyChannel" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "phoneE164" TEXT NOT NULL,
  "optInAt" TIMESTAMP(3),
  "optInTextVersion" TEXT,
  "verifiedAt" TIMESTAMP(3),
  "optOutAt" TIMESTAMP(3),
  "notifierContactId" TEXT,
  "lastSentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OwnerNotifyChannel_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OwnerNotifyChannel_tenantId_userId_key" ON "OwnerNotifyChannel"("tenantId","userId");
CREATE INDEX "OwnerNotifyChannel_phoneE164_idx" ON "OwnerNotifyChannel"("phoneE164");

-- ===== Append-only enforcement (first trigger in this database) =====
-- (repair) The purge exception names ONE workspace: edwyz.purge = '<table>:<tenantId>', compared with the deleted row's own
-- tenantId. An erasure query that lost its WHERE "tenantId" filter therefore fails with 42501 on the first row of another
-- workspace instead of wiping every workspace's ledger. to_jsonb(OLD) reads tenantId without naming a column the table may
-- lack; the purge branch is row-level DELETE only (TRUNCATE is a statement trigger and always refused).
CREATE OR REPLACE FUNCTION edwyz_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND TG_LEVEL = 'ROW' THEN
    IF current_setting('edwyz.purge', true) = TG_TABLE_NAME || ':' || COALESCE(to_jsonb(OLD)->>'tenantId', '') THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION '% is append-only (% refused)', TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
END $$;
CREATE TRIGGER "SpendLedger_append_only" BEFORE UPDATE OR DELETE ON "SpendLedger" FOR EACH ROW EXECUTE FUNCTION edwyz_append_only();
CREATE TRIGGER "SpendLedger_no_truncate" BEFORE TRUNCATE ON "SpendLedger" FOR EACH STATEMENT EXECUTE FUNCTION edwyz_append_only();
CREATE TRIGGER "SpendConsent_append_only" BEFORE UPDATE OR DELETE ON "SpendConsent" FOR EACH ROW EXECUTE FUNCTION edwyz_append_only();
CREATE TRIGGER "SpendConsent_no_truncate" BEFORE TRUNCATE ON "SpendConsent" FOR EACH STATEMENT EXECUTE FUNCTION edwyz_append_only();
-- Workspace erasure, inside ONE transaction: SELECT set_config('edwyz.purge','SpendLedger:<tenantId>',true); then delete that
-- tenant's SpendLedger rows; then the same for SpendConsent. set_config(..., true) is transaction-local
-- (src/lib/lifecycle/erase-workspace.ts).

-- ===== Backfill =====
-- 1. The old daily cap meant "sum of nominal daily budgets <= C". Meta can spend 1.75x that, so the equivalent worst-case daily limit is ceil(1.75 C).
--    Room is unchanged. 'ads:caps:' is 9 characters. The old key is kept and read only as a fallback by the getCaps shim.
--    (repair) C is the cap getCaps enforces today: a cap saved with another currency exponent than the current table gives is
--    rescaled first, floor(C x 10^(current - stored)), exactly as src/lib/ads/caps.ts does, and a cap that rescales to 0 is
--    no cap. The CASE mirrors src/lib/ads/insights-money.ts currencyExponent (0, 3, else 2). Rows without a stored exponent are
--    taken at the current one (unchanged).
INSERT INTO "SpendAllowance" ("id","tenantId","pot","currency","dailyLimitMinor","monthlyLimitMinor","migratedFromCapMinor","updatedAt")
SELECT c."id", c."tenantId", 'ads', c."currency", CEIL(1.75 * c."capMinor")::bigint, NULL, c."capMinor"::bigint, CURRENT_TIMESTAMP
FROM (
  SELECT 'sa_' || md5(substr(p."key",10) || ':ads') AS "id", substr(p."key",10) AS "tenantId", p."value"->>'currency' AS "currency",
         -- The CASE guards the cast: quals may be evaluated in any order, so a non-numeric cap must never reach ::numeric.
         CASE WHEN (p."value"->>'maxDailyBudgetMinor') ~ '^[0-9]+$'
              THEN FLOOR((p."value"->>'maxDailyBudgetMinor')::numeric * power(10::numeric, e."current" - COALESCE(e."stored", e."current"))) END AS "capMinor"
  FROM "PlatformSetting" p
  CROSS JOIN LATERAL (
    SELECT CASE WHEN p."value"->>'currency' IN ('JPY','KRW','VND','CLP','ISK','HUF','UGX','PYG','XAF','XOF','XPF','RWF','KMF','GNF','DJF','VUV') THEN 0
                WHEN p."value"->>'currency' IN ('BHD','JOD','KWD','OMR','TND') THEN 3
                ELSE 2 END AS "current",
           CASE WHEN jsonb_typeof(p."value"->'exponent') = 'number' AND (p."value"->>'exponent') ~ '^[0-3]$' THEN (p."value"->>'exponent')::int END AS "stored"
  ) e
  WHERE p."key" LIKE 'ads:caps:%'
    AND (p."value"->>'currency') ~ '^[A-Z]{3}$'
) c
WHERE c."capMinor" > 0;

-- 2. A SpendControl row for every tenant. The time zone comes from the active ad account. The spending account is set when there is exactly one.
--    (critic) probation is 'auto' for everyone: 4.4 computes it on read (billing-exempt, 2 paid invoices, verifiedAt), so a later
--    void or refund, or a revoked exemption, brings probation back. A stored 'lifted' would make the backfill-time state sticky.
--    (critic) Time zone fallback order: active ad account, then RoutingConfig.timezone, then Asia/Kolkata.
--    Tenants created after this migration get their row lazily on first read (invariant I11).
INSERT INTO "SpendControl" ("tenantId","probation","timezone","spendingAdAccountAssetId","updatedAt")
SELECT t."id",
       'auto',
       COALESCE((SELECT a."meta"->>'timezone' FROM "MetaAsset" a WHERE a."tenantId" = t."id" AND a."type" = 'ad_account' AND a."status" = 'active' ORDER BY a."createdAt" LIMIT 1),
                (SELECT r."timezone" FROM "RoutingConfig" r WHERE r."tenantId" = t."id"), 'Asia/Kolkata'),
       (SELECT min(a."id") FROM "MetaAsset" a WHERE a."tenantId" = t."id" AND a."type" = 'ad_account' AND a."status" = 'active' HAVING count(*) = 1),
       CURRENT_TIMESTAMP
FROM "Tenant" t
ON CONFLICT ("tenantId") DO NOTHING;

-- 3. New-workspace (probation) ceilings (R7). SPEND 12.1a decision 3: CAP ALL THREE POTS, not only ads.
--    Ads: INR 2,000 a day and INR 20,000 a month (worst case, 1.75x; decision 7).
--    WhatsApp messages: INR 500 a day and INR 5,000 a month.
--    AI: the plan's monthly AI credits, never more than the INR 500 a month equivalent: 500 credits a month (EDDY 12.1a decision 2,
--    1 credit is about USD 0.01, so 500 credits sit inside INR 500), and no separate daily ceiling (NULL).
--    No other currency gets an invented value: non-INR workspaces use these rows through a fresh FX rate, or are refused (4.4).
INSERT INTO "SpendCeiling" ("id","scope","scopeId","pot","currency","dailyMinor","monthlyMinor","reason","updatedAt")
VALUES
  ('sc_probation_ads_inr','probation','*','ads','INR',200000,2000000,'Phase 0 default: INR 2,000 a day and INR 20,000 a month on ads for new workspaces',CURRENT_TIMESTAMP),
  ('sc_probation_messaging_inr','probation','*','messaging','INR',50000,500000,'Phase 0 default: INR 500 a day and INR 5,000 a month on WhatsApp messages for new workspaces',CURRENT_TIMESTAMP),
  ('sc_probation_ai_crd','probation','*','ai','CRD',NULL,500,'Phase 0 default: 500 AI credits a month for new workspaces (inside the INR 500 a month equivalent)',CURRENT_TIMESTAMP);

-- 4. Live AdCampaigns become SpendCommitment rows through scripts/spend-backfill-commitments.ts. It needs time zone and exponent
--    logic, so it is not SQL. (critic) It runs right after this migration and BEFORE the train 1 build serves traffic (11, train 1
--    deploy steps), not merely before SPEND_ENFORCE=enforce. Otherwise headroom would see 0 committed and let through activations
--    that today's workspaceActiveBudget refuses. The book also counts any DB-active AdCampaign with no open commitment (4.6), so a
--    late or failed backfill over-counts rather than under-counts.

-- =====================================================================================================================
-- Eddy (in-app AI helper), the shared action layer and in-app notices. See docs/EDDY-SPEC.md 8.1 (formerly 0011_eddy).
-- Folded into 0009: Eddy 8.1 allows the next free number, and its only dependency is edwyz_append_only() created above.
-- New tables only. The lock_timeout and statement_timeout set at the top of this file still apply.
-- =====================================================================================================================

-- ===== Settings =====
CREATE TABLE "EddyWorkspaceSetting" (
  "tenantId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "enabledById" TEXT,
  "enabledAt" TIMESTAMP(3),
  "consentVersion" TEXT,
  "proactiveNotices" BOOLEAN NOT NULL DEFAULT true,
  "dailyTurnCap" INTEGER,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EddyWorkspaceSetting_pkey" PRIMARY KEY ("tenantId"),
  CONSTRAINT "EddyWorkspaceSetting_cap_check" CHECK ("dailyTurnCap" IS NULL OR "dailyTurnCap" > 0)
);

CREATE TABLE "EddyUserPref" (
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "language" TEXT NOT NULL DEFAULT 'auto',
  "proactive" BOOLEAN NOT NULL DEFAULT true,
  "mutedNoticeKinds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "firstUseAckAt" TIMESTAMP(3),             -- (critic) the member saw notice.first_use (6.11)
  "firstUseVersion" TEXT,                   -- (critic) LEGAL.version it was shown for
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EddyUserPref_pkey" PRIMARY KEY ("tenantId", "userId"),
  CONSTRAINT "EddyUserPref_language_check" CHECK ("language" IN ('auto','en','hi','hinglish'))
);

-- ===== Conversations =====
CREATE TABLE "EddyConversation" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "roleAtStart" "Role" NOT NULL,
  "roleClass" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "toolsetVersion" TEXT NOT NULL,
  "promptVersion" TEXT NOT NULL,
  "visibilityHash" TEXT NOT NULL,           -- (critic) role class, teams, teamVisibility, viewOnlyAssigned, maskPhone at start (5.8)
  "language" TEXT NOT NULL DEFAULT 'en',
  "title" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "closedReason" TEXT,
  "turnCount" INTEGER NOT NULL DEFAULT 0,
  "nextSeq" INTEGER NOT NULL DEFAULT 0,
  "lastInputTokens" INTEGER NOT NULL DEFAULT 0,
  "lastCallAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EddyConversation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EddyConversation_status_check" CHECK ("status" IN ('active','closed','erased')),
  CONSTRAINT "EddyConversation_roleClass_check" CHECK ("roleClass" IN ('agent','admin')),
  CONSTRAINT "EddyConversation_language_check" CHECK ("language" IN ('en','hi','hinglish'))
);
CREATE INDEX "EddyConversation_tenantId_userId_lastMessageAt_idx" ON "EddyConversation"("tenantId","userId","lastMessageAt");
CREATE INDEX "EddyConversation_lastMessageAt_idx" ON "EddyConversation"("lastMessageAt");
-- SQL only: one active conversation per member per workspace
CREATE UNIQUE INDEX "EddyConversation_one_active_key" ON "EddyConversation"("tenantId","userId") WHERE "status" = 'active';

CREATE TABLE "EddyMessage" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "turnId" TEXT,
  "seq" INTEGER NOT NULL,
  "role" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  -- (repair) JSON, not JSONB: JSONB re-sorts object keys and normalises the text, so a replayed tool_use.input would no longer
  -- be a byte prefix of the next request (EDDY 5.8): a cache miss on every turn and, with drop_block, silently dropped thinking
  -- blocks. JSON keeps the text exactly as written; Prisma reads it back with JSON.parse, which keeps the key order.
  "content" JSON NOT NULL,                  -- Anthropic content blocks exactly as sent or received (thinking signatures included)
  "display" JSONB,                          -- UI projection: {text, lang, cardIds, quotes}
  "contactIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "conversationIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EddyMessage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EddyMessage_conversation_fkey" FOREIGN KEY ("conversationId") REFERENCES "EddyConversation"("id") ON DELETE CASCADE,
  CONSTRAINT "EddyMessage_role_check" CHECK ("role" IN ('user','assistant','system')),
  CONSTRAINT "EddyMessage_kind_check" CHECK ("kind" IN ('user_text','context_note','assistant','tool_results','placeholder','wrapup_note'))
);
CREATE UNIQUE INDEX "EddyMessage_conversationId_seq_key" ON "EddyMessage"("conversationId","seq");
CREATE INDEX "EddyMessage_tenantId_createdAt_idx" ON "EddyMessage"("tenantId","createdAt");
CREATE INDEX "EddyMessage_contactIds_idx" ON "EddyMessage" USING GIN ("contactIds");
-- Append-only: UPDATE always refused (DELETE stays allowed for retention, member deletion and erasure).
CREATE TRIGGER "EddyMessage_append_only" BEFORE UPDATE ON "EddyMessage" FOR EACH ROW EXECUTE FUNCTION edwyz_append_only();

CREATE TABLE "EddyTurn" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'running',
  "model" TEXT NOT NULL,
  "language" TEXT NOT NULL,
  "rounds" INTEGER NOT NULL DEFAULT 0,
  "toolCalls" INTEGER NOT NULL DEFAULT 0,
  "cardsCreated" INTEGER NOT NULL DEFAULT 0,
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
  "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "costMicroUsd" BIGINT NOT NULL DEFAULT 0,
  "platformMicroUsd" BIGINT NOT NULL DEFAULT 0,   -- (critic) the shared prefix write the platform absorbs (5.10)
  "creditsCharged" INTEGER NOT NULL DEFAULT 0,
  "stopReason" TEXT,
  "refusalCategory" TEXT,
  "errorCode" TEXT,
  "requestIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "firstTokenMs" INTEGER,
  "durationMs" INTEGER,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt" TIMESTAMP(3),
  CONSTRAINT "EddyTurn_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EddyTurn_conversation_fkey" FOREIGN KEY ("conversationId") REFERENCES "EddyConversation"("id") ON DELETE SET NULL,
  CONSTRAINT "EddyTurn_status_check" CHECK ("status" IN ('running','done','error','aborted','refused','limit','truncated'))
);
-- SQL only: one running turn per conversation (the turn lock; a sweeper aborts turns older than 3 minutes)
CREATE UNIQUE INDEX "EddyTurn_one_running_key" ON "EddyTurn"("conversationId") WHERE "status" = 'running';
CREATE INDEX "EddyTurn_tenantId_startedAt_idx" ON "EddyTurn"("tenantId","startedAt");
CREATE INDEX "EddyTurn_tenantId_userId_startedAt_idx" ON "EddyTurn"("tenantId","userId","startedAt");

-- ===== Action layer =====
CREATE TABLE "ActionRecord" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "via" TEXT NOT NULL,
  "principalId" TEXT NOT NULL,
  "conversationId" TEXT,
  "turnId" TEXT,
  "toolUseId" TEXT,
  "action" TEXT NOT NULL,
  "risk" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "args" JSONB NOT NULL,
  "argsHash" TEXT NOT NULL,
  "preview" JSONB,
  "previewHash" TEXT,
  "nonceHash" TEXT,
  "expiresAt" TIMESTAMP(3),
  "decidedAt" TIMESTAMP(3),
  "result" JSONB,
  "error" TEXT,
  "undo" JSONB,
  "undoUntil" TIMESTAMP(3),
  "undoneAt" TIMESTAMP(3),
  "spendPot" TEXT,
  "spendCorrelationId" TEXT,              -- Phase 0 SpendLedger correlationId (v2)
  "spendApprovalId" TEXT,                 -- Phase 0 SpendApproval.id (v2)
  "supersededById" TEXT,
  "contactIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ActionRecord_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ActionRecord_conversation_fkey" FOREIGN KEY ("conversationId") REFERENCES "EddyConversation"("id") ON DELETE SET NULL,
  CONSTRAINT "ActionRecord_via_check" CHECK ("via" IN ('eddy','mcp','api','system')),
  CONSTRAINT "ActionRecord_risk_check" CHECK ("risk" IN ('instant','undoable','confirm')),
  CONSTRAINT "ActionRecord_status_check" CHECK ("status" IN ('pending','running','done','failed','cancelled','expired','superseded','undone','unknown','awaiting_approval','refused')),
  CONSTRAINT "ActionRecord_spendPot_check" CHECK ("spendPot" IS NULL OR "spendPot" IN ('messaging','ads','ai'))
);
CREATE INDEX "ActionRecord_tenantId_userId_status_idx" ON "ActionRecord"("tenantId","userId","status");
CREATE INDEX "ActionRecord_conversationId_createdAt_idx" ON "ActionRecord"("conversationId","createdAt");
CREATE INDEX "ActionRecord_status_expiresAt_idx" ON "ActionRecord"("status","expiresAt");
CREATE INDEX "ActionRecord_tenantId_decidedAt_idx" ON "ActionRecord"("tenantId","decidedAt");
CREATE INDEX "ActionRecord_spendApprovalId_idx" ON "ActionRecord"("spendApprovalId");
CREATE INDEX "ActionRecord_contactIds_idx" ON "ActionRecord" USING GIN ("contactIds");

CREATE TABLE "ActionInvocation" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT,
  "via" TEXT NOT NULL,
  "principalId" TEXT NOT NULL,
  "opId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "risk" TEXT NOT NULL,
  "stage" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "code" TEXT,
  "argsHash" TEXT NOT NULL,
  "argsRedacted" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "resultRef" TEXT,
  "conversationId" TEXT,
  "turnId" TEXT,
  "actionRecordId" TEXT,
  "spendCorrelationId" TEXT,
  "piiItems" INTEGER,
  "durationMs" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ActionInvocation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ActionInvocation_via_check" CHECK ("via" IN ('eddy','mcp','api','system','undo')),
  CONSTRAINT "ActionInvocation_risk_check" CHECK ("risk" IN ('instant','undoable','confirm')),
  CONSTRAINT "ActionInvocation_stage_check" CHECK ("stage" IN ('read','preview','execute','undo','refuse')),
  CONSTRAINT "ActionInvocation_outcome_check" CHECK ("outcome" IN ('started','ok','refused','failed','unknown','needs_confirmation','awaiting_approval'))
);
CREATE INDEX "ActionInvocation_tenantId_createdAt_idx" ON "ActionInvocation"("tenantId","createdAt");
CREATE INDEX "ActionInvocation_tenantId_action_createdAt_idx" ON "ActionInvocation"("tenantId","action","createdAt");
CREATE INDEX "ActionInvocation_opId_idx" ON "ActionInvocation"("opId");

-- Append-only, except that a user's anonymisation may set userId to NULL and change nothing else.
CREATE OR REPLACE FUNCTION edwyz_action_invocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."userId" IS NULL AND OLD."userId" IS NOT NULL
     AND (to_jsonb(NEW) - 'userId') = (to_jsonb(OLD) - 'userId') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only (% refused)', TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
END $$;
CREATE TRIGGER "ActionInvocation_append_only" BEFORE UPDATE ON "ActionInvocation" FOR EACH ROW EXECUTE FUNCTION edwyz_action_invocation_guard();
CREATE TRIGGER "ActionInvocation_no_truncate" BEFORE TRUNCATE ON "ActionInvocation" FOR EACH STATEMENT EXECUTE FUNCTION edwyz_append_only();

-- ===== In-app notices (the product's first notification store; offered to Phase 0 as its in-app channel) =====
CREATE TABLE "Notice" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "audienceUserId" TEXT,
  "audienceMinRole" "Role" NOT NULL DEFAULT 'agent',
  "dedupeKey" TEXT NOT NULL,
  "subjectType" TEXT,
  "subjectId" TEXT,
  "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,   -- ids, counts and codes only; never customer text (tested)
  "actions" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "count" INTEGER NOT NULL DEFAULT 1,
  "source" TEXT NOT NULL DEFAULT 'eddy',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "Notice_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Notice_severity_check" CHECK ("severity" IN ('action_needed','heads_up','fyi')),
  CONSTRAINT "Notice_source_check" CHECK ("source" IN ('eddy','spend','system'))
);
CREATE UNIQUE INDEX "Notice_tenantId_dedupeKey_key" ON "Notice"("tenantId","dedupeKey");
CREATE INDEX "Notice_tenantId_resolvedAt_createdAt_idx" ON "Notice"("tenantId","resolvedAt","createdAt");
CREATE INDEX "Notice_expiresAt_idx" ON "Notice"("expiresAt");

CREATE TABLE "NoticeReceipt" (
  "noticeId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "seenAt" TIMESTAMP(3),
  "dismissedAt" TIMESTAMP(3),
  "toastedAt" TIMESTAMP(3),
  CONSTRAINT "NoticeReceipt_pkey" PRIMARY KEY ("noticeId","userId"),
  CONSTRAINT "NoticeReceipt_notice_fkey" FOREIGN KEY ("noticeId") REFERENCES "Notice"("id") ON DELETE CASCADE
);
CREATE INDEX "NoticeReceipt_tenantId_userId_idx" ON "NoticeReceipt"("tenantId","userId");

CREATE TABLE "NoticeScanState" (
  "tenantId" TEXT NOT NULL,
  "scanner" TEXT NOT NULL,                  -- templates | quality | failures | approvals | token | ai_limit | spending | activity | setup
  "cursor" JSONB NOT NULL,                  -- e.g. {"since":"2026-10-28T08:00:00Z"} or {"ratings":{"<phoneId>":"GREEN"}}
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NoticeScanState_pkey" PRIMARY KEY ("tenantId","scanner")
);
