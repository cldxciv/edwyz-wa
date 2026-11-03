-- 0013_ig_page_ads_indexes. Apply with: psql -v ON_ERROR_STOP=1 -f migration.sql (NO -1), off-peak, after 0012.
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block. Every statement is safe to repeat. If a concurrent
-- build fails it leaves an INVALID index: drop that one index CONCURRENTLY, then run this file again.
-- VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE, so reads and writes continue while it scans.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Lead_tenant_source_created_idx" ON "Lead"("tenantId","source","createdAt");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Lead_tenant_ad_idx" ON "Lead"("tenantId","adMetaId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Lead_tenant_conversation_idx" ON "Lead"("tenantId","conversationId")
  WHERE "conversationId" IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "AdCampaign_tenant_surface_idx" ON "AdCampaign"("tenantId","surface","status");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Ad_review_open_idx" ON "Ad"("tenantId","reviewCheckedAt")
  WHERE "effectiveStatus" IN ('PENDING_REVIEW','IN_PROCESS','WITH_ISSUES','DISAPPROVED');
ALTER TABLE "AdCampaign" VALIDATE CONSTRAINT "AdCampaign_surface_check";
ALTER TABLE "AdCampaign" VALIDATE CONSTRAINT "AdCampaign_sourceKind_check";
ALTER TABLE "AdCampaign" VALIDATE CONSTRAINT "AdCampaign_placementMode_check";
ALTER TABLE "AdCampaign" VALIDATE CONSTRAINT "AdCampaign_reviewState_check";
ALTER TABLE "AdCampaign" VALIDATE CONSTRAINT "AdCampaign_promote_end_check";
ALTER TABLE "AdCampaign" VALIDATE CONSTRAINT "AdCampaign_runDays_check";      -- (critic)
ALTER TABLE "AdCampaign" VALIDATE CONSTRAINT "AdCampaign_startMode_check";    -- (critic)
ALTER TABLE "AdSet" VALIDATE CONSTRAINT "AdSet_variantKey_check";
ALTER TABLE "AdSet" VALIDATE CONSTRAINT "AdSet_bidStrategy_check";
ALTER TABLE "AdSet" VALIDATE CONSTRAINT "AdSet_bidAmount_check";
ALTER TABLE "AdSet" VALIDATE CONSTRAINT "AdSet_schedule_check";
ALTER TABLE "Ad" VALIDATE CONSTRAINT "Ad_format_check";
ALTER TABLE "Lead" VALIDATE CONSTRAINT "Lead_source_check";
ALTER TABLE "Lead" VALIDATE CONSTRAINT "Lead_platform_check";
ALTER TABLE "LeadForm" VALIDATE CONSTRAINT "LeadForm_origin_check";
ALTER TABLE "LeadForm" VALIDATE CONSTRAINT "LeadForm_formType_check";
