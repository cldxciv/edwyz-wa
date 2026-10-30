-- BSUID phase: a contact may have no phone number (WhatsApp username users).
-- The unique indexes on (tenantId, phone) and (tenantId, bsuid) stay; Postgres treats NULLs as distinct,
-- so any number of phone-less contacts can coexist while phones and BSUIDs stay unique when present.
ALTER TABLE "Contact" ALTER COLUMN "phone" DROP NOT NULL;
