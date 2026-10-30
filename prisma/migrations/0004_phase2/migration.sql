-- CreateEnum
CREATE TYPE "ChatbotStatus" AS ENUM ('draft', 'published', 'archived');

-- CreateEnum
CREATE TYPE "ChatbotSessionStatus" AS ENUM ('active', 'waiting', 'completed', 'handed_off', 'expired');

-- AlterTable
ALTER TABLE "Broadcast" ADD COLUMN     "retryDays" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "BroadcastRecipient" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "retryAfter" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "assignedAt" TIMESTAMP(3),
ADD COLUMN     "statusChangedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Chatbot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "phoneNumberId" TEXT,
    "name" TEXT NOT NULL,
    "status" "ChatbotStatus" NOT NULL DEFAULT 'draft',
    "triggerType" TEXT NOT NULL DEFAULT 'keyword',
    "triggerKeywords" TEXT[],
    "flow" JSONB NOT NULL,
    "publishedFlow" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Chatbot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatbotSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "chatbotId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "status" "ChatbotSessionStatus" NOT NULL DEFAULT 'active',
    "currentNodeId" TEXT,
    "waitingNodeId" TEXT,
    "wakeAt" TIMESTAMP(3),
    "variables" JSONB NOT NULL DEFAULT '{}',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "ChatbotSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutingConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "autoAssign" BOOLEAN NOT NULL DEFAULT false,
    "mode" TEXT NOT NULL DEFAULT 'round_robin',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "workingHours" JSONB,
    "maxOpenPerAgent" INTEGER,
    "fallbackUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoutingConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentAvailability" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "maxOpen" INTEGER,
    "lastAssignedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Chatbot_tenantId_status_idx" ON "Chatbot"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ChatbotSession_tenantId_conversationId_status_idx" ON "ChatbotSession"("tenantId", "conversationId", "status");

-- CreateIndex
CREATE INDEX "ChatbotSession_status_wakeAt_idx" ON "ChatbotSession"("status", "wakeAt");

-- CreateIndex
CREATE UNIQUE INDEX "RoutingConfig_tenantId_key" ON "RoutingConfig"("tenantId");

-- CreateIndex
CREATE INDEX "AgentAvailability_tenantId_available_idx" ON "AgentAvailability"("tenantId", "available");

-- CreateIndex
CREATE UNIQUE INDEX "AgentAvailability_tenantId_userId_key" ON "AgentAvailability"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "Conversation_tenantId_status_idx" ON "Conversation"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Conversation_tenantId_assignedToId_idx" ON "Conversation"("tenantId", "assignedToId");

-- AddForeignKey
ALTER TABLE "ChatbotSession" ADD CONSTRAINT "ChatbotSession_chatbotId_fkey" FOREIGN KEY ("chatbotId") REFERENCES "Chatbot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

