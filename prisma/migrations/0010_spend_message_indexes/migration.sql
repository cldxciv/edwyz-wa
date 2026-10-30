-- 0010_spend_message_indexes. Apply with: psql -v ON_ERROR_STOP=1 -f migration.sql (no -1).
-- Apply WITHOUT -1, off-peak, after 0009 (the same day or later). CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
-- Nothing depends on these indexes for correctness: the send gate and settlement work without them, only more slowly.
-- If a concurrent build fails it leaves an INVALID index: drop that one index concurrently, then run this file again
-- (every statement is safe to repeat). See docs/SPEND-CONTROLS-SPEC.md 3.2.1.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_spend_open_idx" ON "Message"("tenantId","spendDay") WHERE "spendState" = 'reserved';
-- Settled messages still waiting for Meta's pricing, including ones that failed after Meta accepted them (4.9 settlement).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_pricing_unsettled_idx" ON "Message"("tenantId","createdAt") WHERE "spendState" = 'settled' AND "pricingSettledAt" IS NULL;
ALTER TABLE "Message" VALIDATE CONSTRAINT "Message_spendState_check";
