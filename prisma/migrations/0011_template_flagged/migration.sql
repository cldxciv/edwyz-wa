-- 0011_template_flagged. Apply with: psql -v ON_ERROR_STOP=1 -1 -f migration.sql (the normal loop, docs: deploy/README-deploy.md A step 5).
-- Additive only: one new enum value, no row is touched. Meta's FLAGGED template event now maps to `flagged` instead of `paused`
-- (docs/SPEND-CONTROLS-SPEC.md 6.3): marketing broadcasts and assistants stop using the template, other senders may continue.
-- PostgreSQL 12 and later accept ADD VALUE inside a transaction block as long as nothing uses the new value in the same
-- transaction (this server runs 17). On 11 run it without -1. Safe to run again (IF NOT EXISTS).
-- Until this is applied the webhook stores a FLAGGED template as `paused`, the stricter state, so deploy order does not matter.
ALTER TYPE "TemplateStatus" ADD VALUE IF NOT EXISTS 'flagged';
