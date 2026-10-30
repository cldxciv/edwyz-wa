-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "referral" JSONB;

-- AlterTable
ALTER TABLE "Plan" ADD COLUMN     "adAccountLimit" INTEGER,
ADD COLUMN     "aiCreditsMonthly" INTEGER;

-- CreateTable
CREATE TABLE "MetaConnection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "metaUserId" TEXT NOT NULL,
    "businessId" TEXT,
    "scopes" TEXT[],
    "tokenEnc" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "connectedByUserId" TEXT NOT NULL,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaAsset" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT,
    "tokenEnc" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Brand" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "websiteUrl" TEXT,
    "logoUrl" TEXT,
    "colors" TEXT[],
    "fonts" TEXT[],
    "tone" TEXT,
    "bannedWords" TEXT[],
    "industry" TEXT,
    "specialAdCategory" TEXT NOT NULL DEFAULT 'none',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreativeBrief" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "offer" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "researchSummary" JSONB,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreativeBrief_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreativeAngle" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "briefId" TEXT NOT NULL,
    "hook" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "cta" TEXT NOT NULL,
    "rationale" TEXT,
    "selected" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CreativeAngle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreativeAsset" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "briefId" TEXT NOT NULL,
    "angleId" TEXT,
    "kind" TEXT NOT NULL,
    "placement" TEXT NOT NULL DEFAULT 'feed',
    "headline" TEXT,
    "body" TEXT,
    "storageKey" TEXT,
    "provider" TEXT,
    "aiGenerated" BOOLEAN NOT NULL DEFAULT true,
    "creditCost" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "policyCheck" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreativeAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "comment" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdCampaign" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "adAccountAssetId" TEXT NOT NULL,
    "metaCampaignId" TEXT,
    "name" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "dailyBudgetMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "specialAdCategory" TEXT NOT NULL DEFAULT 'none',
    "createdByUserId" TEXT,
    "launchedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdSet" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "metaAdSetId" TEXT,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "targeting" JSONB NOT NULL,
    "dailyBudgetMinor" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ad" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "adSetId" TEXT NOT NULL,
    "metaAdId" TEXT,
    "creativeAssetId" TEXT,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "creative" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Ad_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InsightSnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityMetaId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "spendMinor" INTEGER NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "results" INTEGER NOT NULL DEFAULT 0,
    "frequency" DOUBLE PRECISION,
    "qualityRanking" TEXT,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InsightSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptimizerProposal" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetMetaId" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "revertPayload" JSONB,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "decidedByUserId" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OptimizerProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadForm" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "pageAssetId" TEXT NOT NULL,
    "metaFormId" TEXT NOT NULL,
    "name" TEXT,
    "consentText" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadForm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "leadFormId" TEXT,
    "leadgenId" TEXT NOT NULL,
    "contactId" TEXT,
    "fields" JSONB NOT NULL,
    "campaignMetaId" TEXT,
    "adMetaId" TEXT,
    "consentText" TEXT,
    "consentAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'new',
    "assignedToId" TEXT,
    "firstResponseAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadSequence" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "steps" JSONB NOT NULL,
    "appliesTo" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadSequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadSequenceRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sequenceId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL DEFAULT 0,
    "nextRunAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadSequenceRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledPost" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "mediaKeys" TEXT[],
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduledPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostTarget" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "externalId" TEXT,
    "error" TEXT,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "PostTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversionEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "leadId" TEXT,
    "contactId" TEXT,
    "datasetId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "eventTime" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "response" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageLedger" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "meter" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiAgent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "phoneNumberId" TEXT,
    "instructions" TEXT NOT NULL,
    "tone" TEXT,
    "language" TEXT NOT NULL DEFAULT 'auto',
    "activation" TEXT NOT NULL DEFAULT 'always',
    "handoffKeywords" TEXT[],
    "maxRepliesPerConversation" INTEGER NOT NULL DEFAULT 10,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiAgent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiKnowledgeSource" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiKnowledgeSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpConnection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "authEnc" TEXT,
    "allowedTools" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyStore" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "tokenEnc" TEXT NOT NULL,
    "webhookSecretEnc" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopifyStore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AbandonedCart" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "contactId" TEXT,
    "phone" TEXT,
    "items" JSONB NOT NULL,
    "totalMinor" INTEGER,
    "currency" TEXT,
    "checkoutUrl" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'checkout',
    "status" TEXT NOT NULL DEFAULT 'open',
    "remindersSent" INTEGER NOT NULL DEFAULT 0,
    "nextReminderAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AbandonedCart_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MetaConnection_tenantId_status_idx" ON "MetaConnection"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MetaConnection_tenantId_metaUserId_key" ON "MetaConnection"("tenantId", "metaUserId");

-- CreateIndex
CREATE INDEX "MetaAsset_tenantId_type_idx" ON "MetaAsset"("tenantId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "MetaAsset_tenantId_type_externalId_key" ON "MetaAsset"("tenantId", "type", "externalId");

-- CreateIndex
CREATE INDEX "Brand_tenantId_idx" ON "Brand"("tenantId");

-- CreateIndex
CREATE INDEX "CreativeBrief_tenantId_status_idx" ON "CreativeBrief"("tenantId", "status");

-- CreateIndex
CREATE INDEX "CreativeAngle_tenantId_briefId_idx" ON "CreativeAngle"("tenantId", "briefId");

-- CreateIndex
CREATE INDEX "CreativeAsset_tenantId_briefId_idx" ON "CreativeAsset"("tenantId", "briefId");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalRequest_tokenHash_key" ON "ApprovalRequest"("tokenHash");

-- CreateIndex
CREATE INDEX "ApprovalRequest_tenantId_status_idx" ON "ApprovalRequest"("tenantId", "status");

-- CreateIndex
CREATE INDEX "AdCampaign_tenantId_status_idx" ON "AdCampaign"("tenantId", "status");

-- CreateIndex
CREATE INDEX "AdSet_tenantId_campaignId_idx" ON "AdSet"("tenantId", "campaignId");

-- CreateIndex
CREATE INDEX "Ad_tenantId_adSetId_idx" ON "Ad"("tenantId", "adSetId");

-- CreateIndex
CREATE INDEX "InsightSnapshot_tenantId_date_idx" ON "InsightSnapshot"("tenantId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "InsightSnapshot_tenantId_entityType_entityMetaId_date_key" ON "InsightSnapshot"("tenantId", "entityType", "entityMetaId", "date");

-- CreateIndex
CREATE INDEX "OptimizerProposal_tenantId_status_idx" ON "OptimizerProposal"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "LeadForm_tenantId_metaFormId_key" ON "LeadForm"("tenantId", "metaFormId");

-- CreateIndex
CREATE INDEX "Lead_tenantId_status_idx" ON "Lead"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_tenantId_leadgenId_key" ON "Lead"("tenantId", "leadgenId");

-- CreateIndex
CREATE INDEX "LeadSequence_tenantId_enabled_idx" ON "LeadSequence"("tenantId", "enabled");

-- CreateIndex
CREATE INDEX "LeadSequenceRun_status_nextRunAt_idx" ON "LeadSequenceRun"("status", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "LeadSequenceRun_sequenceId_leadId_key" ON "LeadSequenceRun"("sequenceId", "leadId");

-- CreateIndex
CREATE INDEX "ScheduledPost_tenantId_scheduledAt_idx" ON "ScheduledPost"("tenantId", "scheduledAt");

-- CreateIndex
CREATE INDEX "ScheduledPost_status_scheduledAt_idx" ON "ScheduledPost"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "PostTarget_tenantId_postId_idx" ON "PostTarget"("tenantId", "postId");

-- CreateIndex
CREATE INDEX "ConversionEvent_tenantId_status_idx" ON "ConversionEvent"("tenantId", "status");

-- CreateIndex
CREATE INDEX "UsageLedger_tenantId_meter_createdAt_idx" ON "UsageLedger"("tenantId", "meter", "createdAt");

-- CreateIndex
CREATE INDEX "AiAgent_tenantId_enabled_idx" ON "AiAgent"("tenantId", "enabled");

-- CreateIndex
CREATE INDEX "AiKnowledgeSource_tenantId_agentId_idx" ON "AiKnowledgeSource"("tenantId", "agentId");

-- CreateIndex
CREATE INDEX "McpConnection_tenantId_enabled_idx" ON "McpConnection"("tenantId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyStore_tenantId_shopDomain_key" ON "ShopifyStore"("tenantId", "shopDomain");

-- CreateIndex
CREATE INDEX "AbandonedCart_status_nextReminderAt_idx" ON "AbandonedCart"("status", "nextReminderAt");

-- CreateIndex
CREATE UNIQUE INDEX "AbandonedCart_storeId_externalId_key" ON "AbandonedCart"("storeId", "externalId");

-- AddForeignKey
ALTER TABLE "MetaAsset" ADD CONSTRAINT "MetaAsset_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "MetaConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeBrief" ADD CONSTRAINT "CreativeBrief_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeAngle" ADD CONSTRAINT "CreativeAngle_briefId_fkey" FOREIGN KEY ("briefId") REFERENCES "CreativeBrief"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeAsset" ADD CONSTRAINT "CreativeAsset_briefId_fkey" FOREIGN KEY ("briefId") REFERENCES "CreativeBrief"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeAsset" ADD CONSTRAINT "CreativeAsset_angleId_fkey" FOREIGN KEY ("angleId") REFERENCES "CreativeAngle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdSet" ADD CONSTRAINT "AdSet_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "AdCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ad" ADD CONSTRAINT "Ad_adSetId_fkey" FOREIGN KEY ("adSetId") REFERENCES "AdSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_leadFormId_fkey" FOREIGN KEY ("leadFormId") REFERENCES "LeadForm"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadSequenceRun" ADD CONSTRAINT "LeadSequenceRun_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "LeadSequence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadSequenceRun" ADD CONSTRAINT "LeadSequenceRun_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostTarget" ADD CONSTRAINT "PostTarget_postId_fkey" FOREIGN KEY ("postId") REFERENCES "ScheduledPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiKnowledgeSource" ADD CONSTRAINT "AiKnowledgeSource_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AiAgent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AbandonedCart" ADD CONSTRAINT "AbandonedCart_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "ShopifyStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;

