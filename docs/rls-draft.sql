-- DRAFT, not applied. Do NOT place in prisma/migrations until docs/rls-plan.md rollout steps 1-3 are done.
-- Run as the table owner (edwyz_owner). Replace the passwords with generated secrets.
-- Review against the current prisma/schema.prisma: every model with a non-null "tenantId" must be in the list below.

-- 1. Roles ------------------------------------------------------------------------------------
-- edwyz_app: used by request handlers. Subject to RLS.
-- edwyz_system: used by the worker, webhook processor, auth lookups (login, refresh, invites) and the super admin. Bypasses RLS.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edwyz_app') THEN
    CREATE ROLE edwyz_app LOGIN PASSWORD 'CHANGE_ME_APP' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edwyz_system') THEN
    CREATE ROLE edwyz_system LOGIN PASSWORD 'CHANGE_ME_SYSTEM' NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO edwyz_app, edwyz_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO edwyz_app, edwyz_system;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO edwyz_app, edwyz_system;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO edwyz_app, edwyz_system;

-- 2. Tenant-owned tables with a non-null "tenantId" --------------------------------------------
-- A missing app.tenant_id gives NULL, the comparison is NULL, and no row matches: failure means "empty", never "everything".
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Membership','Invite','Waba','PhoneNumber','AccessToken','OnboardingLog','Contact','Conversation','Message','Note',
    'QuickReply','Template','Broadcast','BroadcastRecipient','WalletTransaction','Subscription','BillingProfile','Invoice',
    'AutomationRule','AutomationRun','ApiKey','WebhookEndpoint','WebhookDelivery'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I TO edwyz_app USING ("tenantId" = current_setting(''app.tenant_id'', true)) WITH CHECK ("tenantId" = current_setting(''app.tenant_id'', true))',
      t
    );
  END LOOP;
END $$;

-- 3. Tenant table itself ---------------------------------------------------------------------
ALTER TABLE "Tenant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Tenant" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Tenant";
CREATE POLICY tenant_isolation ON "Tenant" TO edwyz_app
  USING ("id" = current_setting('app.tenant_id', true))
  WITH CHECK ("id" = current_setting('app.tenant_id', true));

-- 4. Nullable-tenant and global tables: system-only for the web role -----------------------------
-- Session, WebhookEvent, Job, PaymentEvent, EmailToken, PlatformSetting, Plan, DailyMetric and User are used by auth, the worker
-- and the admin pages through edwyz_system. The web role keeps access only where a route needs it (see rls-plan.md).
-- AuditLog: the web role may append and read its own tenant's rows, never edit or delete.
ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_insert ON "AuditLog";
DROP POLICY IF EXISTS audit_select ON "AuditLog";
CREATE POLICY audit_insert ON "AuditLog" FOR INSERT TO edwyz_app
  WITH CHECK ("tenantId" IS NULL OR "tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY audit_select ON "AuditLog" FOR SELECT TO edwyz_app
  USING ("tenantId" = current_setting('app.tenant_id', true));
REVOKE UPDATE, DELETE ON "AuditLog" FROM edwyz_app;

REVOKE ALL ON "WebhookEvent", "Job", "PaymentEvent", "EmailToken", "Session" FROM edwyz_app;

-- 5. Optional: access tokens readable only through a function -----------------------------------
-- The function runs as the owner (bypasses RLS) and enforces the tenant itself.
CREATE OR REPLACE FUNCTION app_get_access_token(p_tenant text)
RETURNS TABLE ("tokenCiphertext" text, "iv" text, "authTag" text, "keyVersion" int, "wabaRefId" text, "expiresAt" timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT a."tokenCiphertext", a."iv", a."authTag", a."keyVersion", a."wabaRefId", a."expiresAt"
  FROM "AccessToken" a
  WHERE a."tenantId" = p_tenant AND p_tenant = current_setting('app.tenant_id', true)
  ORDER BY a."createdAt" DESC LIMIT 20;
$$;
-- To use it: REVOKE SELECT ON "AccessToken" FROM edwyz_app; then change getAccessToken to call the function.

-- 6. Composite keys so a child row can never point at another tenant's parent ---------------------
-- Run the offender queries in docs/rls-plan.md first; each must return 0.
-- ALTER TABLE "Contact"      ADD CONSTRAINT contact_tenant_id_uq      UNIQUE ("tenantId", "id");
-- ALTER TABLE "Conversation" ADD CONSTRAINT conversation_tenant_id_uq UNIQUE ("tenantId", "id");
-- ALTER TABLE "Template"     ADD CONSTRAINT template_tenant_id_uq     UNIQUE ("tenantId", "id");
-- ALTER TABLE "PhoneNumber"  ADD CONSTRAINT phone_tenant_id_uq        UNIQUE ("tenantId", "id");
-- ALTER TABLE "Broadcast"    ADD CONSTRAINT broadcast_tenant_id_uq    UNIQUE ("tenantId", "id");
-- ALTER TABLE "Conversation" ADD CONSTRAINT conversation_contact_tenant_fk FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact" ("tenantId", "id");
-- ALTER TABLE "Message"      ADD CONSTRAINT message_conversation_tenant_fk FOREIGN KEY ("tenantId", "conversationId") REFERENCES "Conversation" ("tenantId", "id");
-- ALTER TABLE "BroadcastRecipient" ADD CONSTRAINT recipient_broadcast_tenant_fk FOREIGN KEY ("tenantId", "broadcastId") REFERENCES "Broadcast" ("tenantId", "id");
-- ALTER TABLE "Broadcast"    ADD CONSTRAINT broadcast_template_tenant_fk FOREIGN KEY ("tenantId", "templateId") REFERENCES "Template" ("tenantId", "id");

-- 7. Rollback (per table) ------------------------------------------------------------------------
-- ALTER TABLE "<table>" NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE "<table>" DISABLE ROW LEVEL SECURITY;
