# Postgres row-level security plan (F13)

Status: designed, not applied. Apply when the owner schedules it. The ready SQL is `docs/rls-draft.sql` (kept out of `prisma/migrations` on purpose).

## Goal

A forgotten `where: { tenantId }` must no longer be able to read or write another tenant's rows. The application filters stay (they give better errors and use the indexes); RLS is the backstop.

## Design

1. **Two roles.** `edwyz_owner` owns the tables and runs `prisma migrate`. `edwyz_app` (NOBYPASSRLS) serves request handlers. `edwyz_system` (BYPASSRLS) serves code that legitimately has no tenant yet or spans tenants: login, refresh, invite lookup, email tokens, billing webhooks, the worker, the webhook processor (routes by `phone_number_id`), retention and the super-admin pages.
2. **Tenant context per transaction.** `set_config('app.tenant_id', <id>, true)` is transaction-local, so it cannot leak between pooled connections. Policy on every table with a non-null `tenantId`: `USING ("tenantId" = current_setting('app.tenant_id', true)) WITH CHECK (same)`. With no context the setting is NULL and no row matches, so a mistake gives an empty result, not a leak.
3. **FORCE ROW LEVEL SECURITY** on all of them so the owner role is bound too (the migration role must then use BYPASSRLS or `SET row_security = off`).
4. **Nullable-tenant tables** (`Session`, `WebhookEvent`, `AuditLog`) and global tables (`User`, `Job`, `Plan`, `PaymentEvent`, `PlatformSetting`, `DailyMetric`, `EmailToken`) are system-only for the web role. `AuditLog` is append-only for the web role (INSERT, and SELECT of its own tenant; no UPDATE or DELETE).
5. **AccessToken** can additionally be read only through the `app_get_access_token(tenant)` SECURITY DEFINER function, so a bug in a route cannot dump tokens.
6. **Composite foreign keys** `(tenantId, id)` so a Message cannot reference another tenant's Conversation, and so on (commented block in the SQL; run the checks below first).

## Application changes needed

- `src/lib/db.ts`: export `prisma` (connection string of `edwyz_app`, env `DATABASE_URL`) and `prismaSystem` (connection string of `edwyz_system`, new env `DATABASE_URL_SYSTEM`). Same generated client.
- New `src/lib/db-tenant.ts`:

  ```ts
  export function withTenant<T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`select set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    });
  }
  ```

  Prisma's interactive transaction timeout defaults to 5 s: never call Meta inside `withTenant`.
- Services take a `db` parameter (default: the global client) so route handlers can pass `tx`. Convert module by module, tenant-heavy first: inbox, contacts, broadcasts, templates, then billing, automation, integrations. Routes become `const actor = await getActor(request); return withTenant(actor.tenantId, (tx) => service(tx, actor, ...))`.
- Move to `prismaSystem`: everything under `src/lib/auth/*` (user, session, invite and email-token lookups), the membership read in `getActor` (it runs before the tenant is known), `src/lib/webhooks/*`, `src/worker/*`, `src/lib/queue.ts`, `src/lib/billing/webhook.ts`, `src/lib/lifecycle/*`, `src/lib/admin/*`, `src/lib/storage.ts` and the onboarding run lock.
- Worker per-tenant work (`processSendJob`, `sendOne`, automation runs, outbound webhook delivery) should run inside `withTenant(job.tenantId, ...)` using `prisma` (not system), so a bug there is contained too.
- If PgBouncer is added later it must be in transaction mode (the setting is transaction-local, so that works).

## Rollout order

1. Create the roles and grants (section 1 of the SQL) and deploy both connection strings; no policies yet. Confirm everything works on `edwyz_app`.
2. Introduce `withTenant` and convert modules one at a time behind the existing tests.
3. Run the isolation test below on staging.
4. Enable policies table by table (the SQL loop is idempotent), starting with `Contact`, `Message`, `Conversation`.
5. Add the composite foreign keys after the offender queries return zero rows.

## Checks

Offenders for the composite keys (each must return 0):

```sql
SELECT count(*) FROM "Message" m JOIN "Conversation" c ON c.id = m."conversationId" WHERE c."tenantId" <> m."tenantId";
SELECT count(*) FROM "Conversation" c JOIN "Contact" x ON x.id = c."contactId" WHERE x."tenantId" <> c."tenantId";
SELECT count(*) FROM "BroadcastRecipient" r JOIN "Broadcast" b ON b.id = r."broadcastId" WHERE b."tenantId" <> r."tenantId";
SELECT count(*) FROM "Broadcast" b JOIN "Template" t ON t.id = b."templateId" WHERE t."tenantId" <> b."tenantId";
```

Isolation test (integration, connected as `edwyz_app`): with tenant A set, `select count(*) from "Contact" where "tenantId" = 'B'` returns 0; with no setting, `select count(*) from "Contact"` returns 0; an insert with `tenantId = 'B'` fails the WITH CHECK; `update "AuditLog" ...` fails.

## Risks

- A query that runs outside `withTenant` on `prisma` returns empty results or fails on write. That is the intended failure mode, but test each module's routes after converting it.
- `FORCE` also binds the owner: run migrations as a role with BYPASSRLS.
- One extra statement (`set_config`) per request transaction; acceptable at this scale.
