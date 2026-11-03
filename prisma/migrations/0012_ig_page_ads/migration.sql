-- 0012_ig_page_ads. Instagram and Facebook Page ads. See docs/IG-PAGE-ADS-SPEC.md section 5.
-- Apply: psql -1 -v ON_ERROR_STOP=1 -f migration.sql (as edwyz_wa_app), record it in MIGRATIONS-APPLIED, then npx prisma generate.
-- Additive only: no DROP, RENAME, type change or UPDATE of an existing row. New columns are nullable or have constant
-- defaults (metadata-only on PostgreSQL 11+). CHECKs on existing tables are NOT VALID here and validated in 0013,
-- so no existing table is scanned under an exclusive lock. 0013 follows WITHOUT -1, off-peak.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ===== AdCampaign =====
ALTER TABLE "AdCampaign"
  ADD COLUMN "goal" TEXT,
  ADD COLUMN "surface" TEXT NOT NULL DEFAULT 'wizard',
  ADD COLUMN "sourceKind" TEXT,
  ADD COLUMN "sourceRef" TEXT,
  ADD COLUMN "sourcePostTargetId" TEXT,
  ADD COLUMN "placementMode" TEXT NOT NULL DEFAULT 'auto',
  ADD COLUMN "reviewState" TEXT,
  ADD COLUMN "reviewCheckedAt" TIMESTAMP(3),
  ADD COLUMN "advantageState" TEXT,
  ADD COLUMN "discardedAt" TIMESTAMP(3),
  -- (critic) Run length and start mode, so a draft started on a later day keeps its length instead of a stale end date (3.1a).
  ADD COLUMN "runDays" INTEGER,
  ADD COLUMN "startMode" TEXT;
ALTER TABLE "AdCampaign" ADD CONSTRAINT "AdCampaign_runDays_check"
  CHECK ("runDays" IS NULL OR "runDays" BETWEEN 2 AND 90) NOT VALID;
ALTER TABLE "AdCampaign" ADD CONSTRAINT "AdCampaign_startMode_check"
  CHECK ("startMode" IS NULL OR "startMode" IN ('now','at')) NOT VALID;
ALTER TABLE "AdCampaign" ADD CONSTRAINT "AdCampaign_surface_check"
  CHECK ("surface" IN ('wizard','promote','eddy','api')) NOT VALID;
ALTER TABLE "AdCampaign" ADD CONSTRAINT "AdCampaign_sourceKind_check"
  CHECK ("sourceKind" IS NULL OR "sourceKind" IN ('new','fb_post','ig_media')) NOT VALID;
ALTER TABLE "AdCampaign" ADD CONSTRAINT "AdCampaign_placementMode_check"
  CHECK ("placementMode" IN ('auto','instagram','facebook','custom')) NOT VALID;
ALTER TABLE "AdCampaign" ADD CONSTRAINT "AdCampaign_reviewState_check"
  CHECK ("reviewState" IS NULL OR "reviewState" IN ('in_review','approved','partly_rejected','rejected','with_issues')) NOT VALID;
-- Campaigns made in the new flows or by Eddy always end. Mirrors Phase 0's AdCampaign_assistant_end_check.
ALTER TABLE "AdCampaign" ADD CONSTRAINT "AdCampaign_promote_end_check"
  CHECK ("surface" NOT IN ('promote','eddy') OR "endsAt" IS NOT NULL OR "lifetimeBudgetMinor" IS NOT NULL) NOT VALID;

-- ===== AdSet =====
ALTER TABLE "AdSet"
  ADD COLUMN "variantKey" TEXT,
  ADD COLUMN "audienceId" TEXT,
  ADD COLUMN "optimizationGoal" TEXT,
  ADD COLUMN "destinationType" TEXT,
  ADD COLUMN "bidStrategy" TEXT,
  ADD COLUMN "bidAmountMinor" BIGINT,
  ADD COLUMN "schedule" JSONB,
  ADD COLUMN "effectiveStatus" TEXT,
  ADD COLUMN "effectivePlacements" JSONB;
ALTER TABLE "AdSet" ADD CONSTRAINT "AdSet_variantKey_check"
  CHECK ("variantKey" IS NULL OR "variantKey" IN ('A','B','C')) NOT VALID;
ALTER TABLE "AdSet" ADD CONSTRAINT "AdSet_bidStrategy_check"
  CHECK ("bidStrategy" IS NULL OR "bidStrategy" IN ('LOWEST_COST_WITHOUT_CAP','COST_CAP','LOWEST_COST_WITH_BID_CAP')) NOT VALID;
ALTER TABLE "AdSet" ADD CONSTRAINT "AdSet_bidAmount_check"
  CHECK ("bidStrategy" IS NULL OR "bidStrategy" = 'LOWEST_COST_WITHOUT_CAP' OR "bidAmountMinor" IS NOT NULL) NOT VALID;
-- Meta: dayparting (adset_schedule) needs a lifetime budget.
ALTER TABLE "AdSet" ADD CONSTRAINT "AdSet_schedule_check"
  CHECK ("schedule" IS NULL OR "lifetimeBudgetMinor" IS NOT NULL) NOT VALID;

-- ===== Ad =====
ALTER TABLE "Ad"
  ADD COLUMN "format" TEXT NOT NULL DEFAULT 'single_image',
  ADD COLUMN "mediaIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "variantLabel" TEXT,
  ADD COLUMN "sourcePostRef" TEXT,
  ADD COLUMN "effectiveStatus" TEXT,
  ADD COLUMN "reviewFeedback" JSONB,          -- codes and placements only, never ad text
  ADD COLUMN "reviewCheckedAt" TIMESTAMP(3);
ALTER TABLE "Ad" ADD CONSTRAINT "Ad_format_check"
  CHECK ("format" IN ('single_image','single_video','carousel','existing_post')) NOT VALID;
-- Legacy boost_post ads keep the default 'single_image'; code reads them as existing_post from the template (no UPDATE).

-- ===== Lead =====
ALTER TABLE "Lead"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'instant_form',
  ADD COLUMN "platform" TEXT,
  ADD COLUMN "adsetMetaId" TEXT,
  ADD COLUMN "isOrganic" BOOLEAN,
  ADD COLUMN "isTest" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "conversationId" TEXT;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_source_check"
  CHECK ("source" IN ('instant_form','ctwa','ctig','ctm','manual')) NOT VALID;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_platform_check"
  CHECK ("platform" IS NULL OR "platform" IN ('facebook','instagram','messenger','whatsapp','audience_network','unknown')) NOT VALID;
-- (critic) Chat leads use the synthetic leadgenId 'ctwa:<wamid of the referral message>', so @@unique([tenantId, leadgenId])
-- dedupes webhook retries of the same message. The "one per contact per ad per 30 days" rule is a lookup under an advisory
-- lock (3.11), not the key: the earlier key 'ctwa:<conversationId>:<adMetaId>' never changes for a contact's one conversation,
-- so it would have blocked every later lead from the same ad forever.

-- ===== LeadForm =====
ALTER TABLE "LeadForm"
  ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'registered',
  ADD COLUMN "formType" TEXT,
  ADD COLUMN "locale" TEXT,
  ADD COLUMN "spec" JSONB,                    -- what was sent to Meta: questions, privacy link, thank-you, disclaimer. No PII
  ADD COLUMN "metaStatus" TEXT,
  ADD COLUMN "syncedAt" TIMESTAMP(3),
  ADD COLUMN "copiedFromId" TEXT,
  ADD COLUMN "lastBackfillAt" TIMESTAMP(3),
  ADD COLUMN "testLeadUntil" TIMESTAMP(3),
  ADD COLUMN "hiddenAt" TIMESTAMP(3);
ALTER TABLE "LeadForm" ADD CONSTRAINT "LeadForm_origin_check"
  CHECK ("origin" IN ('registered','created','imported')) NOT VALID;
ALTER TABLE "LeadForm" ADD CONSTRAINT "LeadForm_formType_check"
  CHECK ("formType" IS NULL OR "formType" IN ('more_volume','higher_intent')) NOT VALID;

-- ===== InsightSnapshot: extra metrics (all nullable) =====
ALTER TABLE "InsightSnapshot"
  ADD COLUMN "reach" INTEGER,
  ADD COLUMN "linkClicks" INTEGER,
  ADD COLUMN "thruplays" INTEGER,
  ADD COLUMN "videoP25" INTEGER,
  ADD COLUMN "videoP50" INTEGER,
  ADD COLUMN "videoP75" INTEGER,
  ADD COLUMN "videoP100" INTEGER,
  ADD COLUMN "messagingStarts" INTEGER;

-- ===== CreateTable AdMedia (ad media library, one row per file per ad account) =====
CREATE TABLE "AdMedia" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "adAccountAssetId" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "mime" TEXT NOT NULL,
  "bytes" BIGINT NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "width" INTEGER,
  "height" INTEGER,
  "durationMs" INTEGER,
  "videoCodec" TEXT,
  "rotation" INTEGER,
  "ratio" TEXT,
  "fits" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "problems" JSONB,
  "metaImageHash" TEXT,
  "metaVideoId" TEXT,
  "metaThumbHash" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "error" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextCheckAt" TIMESTAMP(3),
  "lastUsedAt" TIMESTAMP(3),
  "adOnly" BOOLEAN NOT NULL DEFAULT false,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdMedia_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AdMedia_source_check" CHECK ("source" IN ('content','creative','ig_copy','crop')),
  CONSTRAINT "AdMedia_kind_check" CHECK ("kind" IN ('image','video')),
  CONSTRAINT "AdMedia_ratio_check" CHECK ("ratio" IS NULL OR "ratio" IN ('1:1','4:5','9:16','1.91:1','other')),
  CONSTRAINT "AdMedia_status_check" CHECK ("status" IN ('pending','uploading','processing','ready','invalid','error')),
  CONSTRAINT "AdMedia_attempts_check" CHECK ("attempts" BETWEEN 0 AND 5)
);
CREATE UNIQUE INDEX "AdMedia_tenant_account_sha_key" ON "AdMedia"("tenantId","adAccountAssetId","sha256");
CREATE INDEX "AdMedia_status_next_idx" ON "AdMedia"("status","nextCheckAt");
CREATE INDEX "AdMedia_tenant_lastUsed_idx" ON "AdMedia"("tenantId","lastUsedAt");

-- ===== CreateTable AdAudience =====
CREATE TABLE "AdAudience" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "adAccountAssetId" TEXT,
  "kind" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "metaAudienceId" TEXT,
  "spec" JSONB NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'draft',
  "sizeLower" BIGINT,
  "sizeUpper" BIGINT,
  "deliveryStatus" TEXT,
  "consentBasis" TEXT,
  "rowsUploaded" INTEGER NOT NULL DEFAULT 0,
  "lastSyncedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "AdAudience_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AdAudience_kind_check" CHECK ("kind" IN ('saved','customer_list','engagement_instagram','engagement_page',
                                                     'engagement_lead_form','website','lookalike')),
  CONSTRAINT "AdAudience_status_check" CHECK ("status" IN ('draft','creating','populating','ready','too_small','error','deleted')),
  CONSTRAINT "AdAudience_consent_check" CHECK ("kind" <> 'customer_list' OR "consentBasis" IN ('marketing_opt_in','customer_relationship')),
  CONSTRAINT "AdAudience_account_check" CHECK ("kind" = 'saved' OR "adAccountAssetId" IS NOT NULL)
);
CREATE UNIQUE INDEX "AdAudience_meta_key" ON "AdAudience"("tenantId","adAccountAssetId","metaAudienceId")
  WHERE "metaAudienceId" IS NOT NULL;
CREATE INDEX "AdAudience_tenant_kind_idx" ON "AdAudience"("tenantId","kind");

-- ===== CreateTable AdAudienceUpload (counts only: no hashes, no identifiers) =====
CREATE TABLE "AdAudienceUpload" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "audienceId" TEXT NOT NULL,
  "sessionId" BIGINT NOT NULL,
  "mode" TEXT NOT NULL,
  "totalRows" INTEGER NOT NULL DEFAULT 0,
  "sentRows" INTEGER NOT NULL DEFAULT 0,
  "batchSeq" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "requestedByUserId" TEXT,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdAudienceUpload_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AdAudienceUpload_mode_check" CHECK ("mode" IN ('add','replace','remove')),
  CONSTRAINT "AdAudienceUpload_status_check" CHECK ("status" IN ('queued','running','done','failed')),
  CONSTRAINT "AdAudienceUpload_audience_fkey" FOREIGN KEY ("audienceId") REFERENCES "AdAudience"("id") ON DELETE CASCADE
);
CREATE INDEX "AdAudienceUpload_tenant_audience_idx" ON "AdAudienceUpload"("tenantId","audienceId","createdAt");

-- ===== CreateTable AdTest (compare versions) =====
CREATE TABLE "AdTest" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'creative',
  "mode" TEXT NOT NULL DEFAULT 'fair_split',
  "metaStudyId" TEXT,
  "metric" TEXT NOT NULL DEFAULT 'cost_per_result',
  "minResults" INTEGER NOT NULL DEFAULT 15,
  "minDays" INTEGER NOT NULL DEFAULT 7,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "winnerAdSetId" TEXT,
  "verdict" JSONB,                             -- the numbers at decision time
  "decidedAt" TIMESTAMP(3),
  "decidedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdTest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AdTest_kind_check" CHECK ("kind" IN ('creative','audience','placement')),
  CONSTRAINT "AdTest_mode_check" CHECK ("mode" IN ('fair_split','meta_study')),
  CONSTRAINT "AdTest_status_check" CHECK ("status" IN ('draft','running','decided','stopped')),
  CONSTRAINT "AdTest_campaign_fkey" FOREIGN KEY ("campaignId") REFERENCES "AdCampaign"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "AdTest_campaign_key" ON "AdTest"("campaignId");

-- ===== CreateTable InsightBreakdown (results by placement, asset, age and gender, region) =====
CREATE TABLE "InsightBreakdown" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityMetaId" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "dimension" TEXT NOT NULL,
  "dimKey" TEXT NOT NULL,                       -- e.g. 'instagram|reels', 'body:<sha1>', 'female|25-34', 'IN-MH'
  "spendMinor" BIGINT NOT NULL DEFAULT 0,
  "impressions" INTEGER NOT NULL DEFAULT 0,
  "reach" INTEGER,
  "clicks" INTEGER NOT NULL DEFAULT 0,
  "results" INTEGER NOT NULL DEFAULT 0,
  "thruplays" INTEGER,
  "raw" JSONB,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InsightBreakdown_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InsightBreakdown_entity_check" CHECK ("entityType" IN ('campaign','adset','ad')),
  CONSTRAINT "InsightBreakdown_dimension_check" CHECK ("dimension" IN ('placement','asset_body','asset_title','asset_image',
                                                                     'asset_video','asset_cta','age_gender','region',
                                                                     'run_total'))   -- (critic) run reach, R3a
);
CREATE UNIQUE INDEX "InsightBreakdown_key" ON "InsightBreakdown"("tenantId","entityType","entityMetaId","date","dimension","dimKey");
CREATE INDEX "InsightBreakdown_tenant_date_idx" ON "InsightBreakdown"("tenantId","date");
