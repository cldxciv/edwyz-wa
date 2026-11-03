-- 0015_studio_canva. Apply with: psql -v ON_ERROR_STOP=1 -1 -f migration.sql (deploy/README-deploy.md A step 5).
-- Additive only: four new tables and six new Brand columns with defaults. No existing row changes meaning.
-- Spec: docs/specs/ADS-MCP-CANVA-CREATIVE-SPEC.md section 4. 0012 and 0013 belong to docs/IG-PAGE-ADS-SPEC.md; 0014 and 0018
-- stay unused, and 0016, 0017 and 0019 to 0022 belong to the inbox, publishing, partnership and catalog specs. This file touches
-- none of their tables, so they apply in any order. Safe to run again (IF NOT EXISTS, guarded constraints).
SET LOCAL lock_timeout = '5s';

-- ===== Brand: what the image maker needs =====
ALTER TABLE "Brand"
  ADD COLUMN IF NOT EXISTS "logoMediaKey"    TEXT,
  ADD COLUMN IF NOT EXISTS "fontStyle"       TEXT    NOT NULL DEFAULT 'simple',
  ADD COLUMN IF NOT EXISTS "defaultLanguage" TEXT    NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS "tagline"         TEXT,
  ADD COLUMN IF NOT EXISTS "contactLine"     TEXT,
  ADD COLUMN IF NOT EXISTS "isDefault"       BOOLEAN NOT NULL DEFAULT false;

DO $$ BEGIN
  ALTER TABLE "Brand" ADD CONSTRAINT "Brand_fontStyle_check" CHECK ("fontStyle" IN ('simple','festive','modern')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Brand" ADD CONSTRAINT "Brand_defaultLanguage_check" CHECK ("defaultLanguage" IN ('en','hi','both')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Brand" ADD CONSTRAINT "Brand_logoMediaKey_check" CHECK ("logoMediaKey" IS NULL OR "logoMediaKey" ~ '^[a-f0-9]{32}\.(jpg|png)$') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Brand" ADD CONSTRAINT "Brand_text_len_check" CHECK (coalesce(length("tagline"),0) <= 80 AND coalesce(length("contactLine"),0) <= 60) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE "Brand" VALIDATE CONSTRAINT "Brand_fontStyle_check";
ALTER TABLE "Brand" VALIDATE CONSTRAINT "Brand_defaultLanguage_check";
ALTER TABLE "Brand" VALIDATE CONSTRAINT "Brand_logoMediaKey_check";
ALTER TABLE "Brand" VALIDATE CONSTRAINT "Brand_text_len_check";
-- At most one default brand per workspace (raw SQL only: Prisma cannot express a partial unique index). Brand is small, so
-- the plain (non-concurrent) build inside the transaction is fine.
CREATE UNIQUE INDEX IF NOT EXISTS "Brand_tenant_default_key" ON "Brand"("tenantId") WHERE "isDefault";

-- ===== StudioItem: metadata for Library files made or imported by Studio =====
CREATE TABLE IF NOT EXISTS "StudioItem" (
  "id"              TEXT         NOT NULL,
  "tenantId"        TEXT         NOT NULL,
  "mediaKey"        TEXT         NOT NULL,
  "kind"            TEXT         NOT NULL,
  "source"          TEXT         NOT NULL,
  "title"           TEXT,
  "templateId"      TEXT,
  "templateVersion" INTEGER,
  "size"            TEXT,
  "format"          TEXT         NOT NULL,
  "width"           INTEGER,
  "height"          INTEGER,
  "bytes"           INTEGER      NOT NULL,
  "sha256"          CHAR(64)     NOT NULL,
  "inputs"          JSONB,
  "brandId"         TEXT,
  "canvaDesignId"   TEXT,
  "canvaPage"       INTEGER,
  "canvaUserId"     TEXT,
  "parentItemId"    TEXT,
  "createdByUserId" TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StudioItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StudioItem_kind_check"     CHECK ("kind" IN ('image','video')),
  CONSTRAINT "StudioItem_source_check"   CHECK ("source" IN ('render','canva','logo')),
  CONSTRAINT "StudioItem_size_check"     CHECK ("size" IS NULL OR "size" IN ('square','feed','story','original')),
  CONSTRAINT "StudioItem_format_check"   CHECK ("format" IN ('jpg','png','mp4')),
  CONSTRAINT "StudioItem_mediaKey_check" CHECK ("mediaKey" ~ '^[a-f0-9]{32}\.(jpg|png|mp4)$'),
  CONSTRAINT "StudioItem_canva_check"    CHECK ("source" <> 'canva' OR "canvaDesignId" IS NOT NULL),
  CONSTRAINT "StudioItem_bytes_check"    CHECK ("bytes" > 0 AND "bytes" <= 104857600),
  CONSTRAINT "StudioItem_brandId_fkey"   FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "StudioItem_tenantId_mediaKey_key"     ON "StudioItem"("tenantId","mediaKey");
CREATE INDEX        IF NOT EXISTS "StudioItem_tenantId_createdAt_idx"     ON "StudioItem"("tenantId","createdAt");
CREATE INDEX        IF NOT EXISTS "StudioItem_tenantId_canvaDesignId_idx" ON "StudioItem"("tenantId","canvaDesignId");

-- ===== StudioJob: Canva imports, autofills and returns run by the worker =====
CREATE TABLE IF NOT EXISTS "StudioJob" (
  "id"            TEXT         NOT NULL,
  "tenantId"      TEXT         NOT NULL,
  "userId"        TEXT         NOT NULL,
  "kind"          TEXT         NOT NULL,
  "state"         TEXT         NOT NULL DEFAULT 'queued',
  "input"         JSONB        NOT NULL,
  "progress"      JSONB,
  "resultItemIds" TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  "error"         TEXT,
  "attempts"      INTEGER      NOT NULL DEFAULT 0,
  "nextPollAt"    TIMESTAMP(3),
  "finishedAt"    TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StudioJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StudioJob_kind_check"  CHECK ("kind" IN ('canva_import','canva_autofill','canva_return')),
  CONSTRAINT "StudioJob_state_check" CHECK ("state" IN ('queued','uploading','filling','exporting','downloading','done','failed')),
  CONSTRAINT "StudioJob_attempts_check" CHECK ("attempts" BETWEEN 0 AND 60)
);
CREATE INDEX IF NOT EXISTS "StudioJob_tenantId_createdAt_idx" ON "StudioJob"("tenantId","createdAt");
CREATE INDEX IF NOT EXISTS "StudioJob_state_nextPollAt_idx"   ON "StudioJob"("state","nextPollAt");

-- ===== CanvaConnection: one Canva account per member per workspace =====
CREATE TABLE IF NOT EXISTS "CanvaConnection" (
  "id"              TEXT         NOT NULL,
  "tenantId"        TEXT         NOT NULL,
  "userId"          TEXT         NOT NULL,
  "canvaUserId"     TEXT         NOT NULL,
  "canvaTeamId"     TEXT,
  "displayName"     TEXT,
  "scopes"          TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  "accessTokenEnc"  TEXT,
  "refreshTokenEnc" TEXT,
  "accessExpiresAt" TIMESTAMP(3),
  "refreshingUntil" TIMESTAMP(3),
  "status"          TEXT         NOT NULL DEFAULT 'active',
  "lastError"       TEXT,
  "lastUsedAt"      TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CanvaConnection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CanvaConnection_status_check" CHECK ("status" IN ('active','expired','revoked','error'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "CanvaConnection_tenantId_userId_key" ON "CanvaConnection"("tenantId","userId");
CREATE INDEX        IF NOT EXISTS "CanvaConnection_tenantId_status_idx" ON "CanvaConnection"("tenantId","status");

-- ===== CanvaReturnState: correlation ids for Canva's Return button =====
CREATE TABLE IF NOT EXISTS "CanvaReturnState" (
  "id"           TEXT         NOT NULL,
  "tenantId"     TEXT         NOT NULL,
  "userId"       TEXT         NOT NULL,
  "connectionId" TEXT         NOT NULL,
  "designId"     TEXT         NOT NULL,
  "purpose"      TEXT         NOT NULL,
  "itemId"       TEXT,
  "exportSpec"   JSONB        NOT NULL,
  "returnPath"   TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"    TIMESTAMP(3) NOT NULL,
  "usedAt"       TIMESTAMP(3),
  CONSTRAINT "CanvaReturnState_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CanvaReturnState_id_check"      CHECK ("id" ~ '^[A-Za-z0-9_-]{22}$'),
  CONSTRAINT "CanvaReturnState_purpose_check" CHECK ("purpose" IN ('edit','new_design','autofill')),
  CONSTRAINT "CanvaReturnState_path_check"    CHECK ("returnPath" IS NULL OR "returnPath" ~ '^/app/[A-Za-z0-9/_?=&.-]{0,200}$')
);
CREATE INDEX IF NOT EXISTS "CanvaReturnState_tenantId_userId_idx" ON "CanvaReturnState"("tenantId","userId");
CREATE INDEX IF NOT EXISTS "CanvaReturnState_expiresAt_idx"       ON "CanvaReturnState"("expiresAt");
