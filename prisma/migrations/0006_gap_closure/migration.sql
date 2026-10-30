-- AlterTable
ALTER TABLE "AutomationRule" ADD COLUMN     "actions" JSONB,
ADD COLUMN     "filters" JSONB,
ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stopAfterMatch" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "trigger" JSONB,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Broadcast" ADD COLUMN     "audienceFilter" JSONB,
ADD COLUMN     "missingValuePolicy" TEXT NOT NULL DEFAULT 'skip',
ADD COLUMN     "variableMap" JSONB;

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "bsuid" TEXT,
ADD COLUMN     "leadStage" TEXT,
ADD COLUMN     "ownerUserId" TEXT,
ADD COLUMN     "username" TEXT,
ADD COLUMN     "waId" TEXT;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "firstAgentReplyAt" TIMESTAMP(3),
ADD COLUMN     "lastAgentReplyAt" TIMESTAMP(3),
ADD COLUMN     "teamId" TEXT;

-- AlterTable
ALTER TABLE "Plan" ADD COLUMN     "connectedChannelLimit" INTEGER,
ADD COLUMN     "scheduledPostLimit" INTEGER;

-- AlterTable
ALTER TABLE "Template" ADD COLUMN     "headerMedia" JSONB;

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMember" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Segment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filter" JSONB NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Segment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationMark" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationMark_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedInboxFilter" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "query" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedInboxFilter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplyMaterial" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'text',
    "body" TEXT,
    "mediaKey" TEXT,
    "mediaMime" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReplyMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuleExecution" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "conversationId" TEXT,
    "contactId" TEXT,
    "outcome" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuleExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Team_tenantId_idx" ON "Team"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Team_tenantId_name_key" ON "Team"("tenantId", "name");

-- CreateIndex
CREATE INDEX "TeamMember_tenantId_userId_idx" ON "TeamMember"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamMember_teamId_userId_key" ON "TeamMember"("teamId", "userId");

-- CreateIndex
CREATE INDEX "Segment_tenantId_idx" ON "Segment"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Segment_tenantId_name_key" ON "Segment"("tenantId", "name");

-- CreateIndex
CREATE INDEX "ConversationMark_tenantId_userId_kind_idx" ON "ConversationMark"("tenantId", "userId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationMark_conversationId_userId_kind_key" ON "ConversationMark"("conversationId", "userId", "kind");

-- CreateIndex
CREATE INDEX "SavedInboxFilter_tenantId_userId_idx" ON "SavedInboxFilter"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ReplyMaterial_tenantId_name_key" ON "ReplyMaterial"("tenantId", "name");

-- CreateIndex
CREATE INDEX "RuleExecution_tenantId_createdAt_idx" ON "RuleExecution"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "RuleExecution_ruleId_createdAt_idx" ON "RuleExecution"("ruleId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_tenantId_bsuid_key" ON "Contact"("tenantId", "bsuid");

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

