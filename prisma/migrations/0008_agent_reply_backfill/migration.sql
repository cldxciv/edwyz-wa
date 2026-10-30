-- Data only. 0006_gap_closure added Conversation.firstAgentReplyAt and lastAgentReplyAt, which are only maintained from the
-- release that added them. Without this, every chat a person had already answered counts as "New" in the inbox.
-- Safe to run again: it only touches rows whose firstAgentReplyAt is still empty.
UPDATE "Conversation" c
SET "firstAgentReplyAt" = m.first_at,
    "lastAgentReplyAt" = COALESCE(c."lastAgentReplyAt", m.last_at)
FROM (
  SELECT "conversationId", MIN("createdAt") AS first_at, MAX("createdAt") AS last_at
  FROM "Message"
  WHERE direction = 'outbound' AND "sentByUserId" IS NOT NULL
  GROUP BY "conversationId"
) m
WHERE m."conversationId" = c.id AND c."firstAgentReplyAt" IS NULL;
