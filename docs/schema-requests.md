# Agent coordination: schema change requests (append only)

## api-compat: optional Message.localMessageId (not blocking)

The compatibility API (`/api/ext/v3`) dedupes sends by caller-supplied `local_message_id` for 24 h using AuditLog rows (action `compat.send`, target `<keyId>:<local_message_id>`), which needs no schema change but is not atomic across processes. If strict exactly-once is wanted: add `localMessageId String?` to Message with `@@unique([tenantId, localMessageId])` and have `queueOutbound` accept it. The compat layer would then switch to a unique-violation catch.

## content-calendar: ScheduledPost / PostTarget columns (not blocking)

The publisher works without schema changes by encoding state in existing columns: the attempt count lives in `PostTarget.error` as `#n|message`, an Instagram media container id is kept in `PostTarget.externalId` while status is `container` (replaced by the media id on `published`), and a link post takes the first URL in the body. If wanted, add: `PostTarget.attempts Int @default(0)`, `PostTarget.containerId String?`, `PostTarget.nextAttemptAt DateTime?`, `ScheduledPost.lockedAt DateTime?` (to recover posts stranded in `publishing` if a worker dies between claim and enqueue), `ScheduledPost.linkUrl String?`, `ScheduledPost.approvalId String?`.

## ai-agent
- AiAgent has no column for the "no human reply for N minutes" threshold. It is stored inside AiAgent.activation as "no_human_reply_minutes:<n>". Wanted: AiAgent.noHumanReplyMinutes Int?.
- Per-conversation AI replies are counted from UsageLedger (refType "ai_reply", refId conversationId) because Message has no AI marker. Wanted: Message.sentByAi Boolean @default(false) (optional).

## production-hardening: RateLimitBucket (not blocking)

`src/lib/ratelimit` works today on `PlatformSetting` rows keyed `rl:<name>:<sha256(key)>` (value `{count, exp}`), which needs no schema change but mixes rate-limit churn into the settings table and uses a `LIKE` scan for its sweep. For heavier traffic add a dedicated table and set `RATELIMIT_BACKEND=table` (the code for it is already in place):

```prisma
model RateLimitBucket {
  key       String   @id
  count     Int
  expiresAt DateTime @db.Timestamptz(3)

  @@index([expiresAt])
}
```

Recommended in the migration SQL after the `CREATE TABLE`: `ALTER TABLE "RateLimitBucket" SET UNLOGGED;` (rate-limit counts are disposable and unlogged writes avoid WAL; the table is empty after a crash, which only resets windows). Under the RLS plan grant `edwyz_app` full access and enable no tenant policy (no `tenantId`; keys are hashed).

## auth-keys (P3-16): contact lookup indexes (not blocking)

`GET /api/ext/v3/contacts` `search` is `ILIKE %q%` on `Contact.name` and `contains` on `Contact.phone`, and `findContact` for `external_id:<value>` filters on `attributes->>'external_id'`; both seq-scan a tenant's contacts. The offset window cap (page_number x page_size <= 10000) bounds only the skip. Wanted (raw SQL migration, Prisma cannot declare them): `CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE INDEX contact_name_trgm ON "Contact" USING gin (name gin_trgm_ops); CREATE INDEX contact_phone_trgm ON "Contact" USING gin (phone gin_trgm_ops); CREATE INDEX contact_external_id ON "Contact" ("tenantId", (attributes->>'external_id'));`.

## compat-api / auth-keys: attribute and search indexes (note only, not blocking)

Follow-up to the auth-keys (P3-16) note above, with the same raw-SQL migration caveat (Prisma cannot declare expression or GIN indexes). The paging cap of 10,000 rows (400 beyond it, no cursors yet) keeps deep skips bounded but does not make the filters themselves cheap:

- `external_id` lookups (`attributes->>'external_id'`) seq-scan a tenant's contacts. Idea: `CREATE INDEX contact_external_id ON "Contact" ("tenantId", (attributes->>'external_id'));` or, if more attribute keys become searchable, `CREATE INDEX contact_attributes_gin ON "Contact" USING gin (attributes jsonb_path_ops);` (supports `@>` containment only, so the query would have to change from `->>` to `attributes @> '{"external_id": "..."}'`).
- Contact `search` (`ILIKE %q%` on name and phone) needs `pg_trgm` GIN indexes on `Contact.name` and `Contact.phone` (see the statements above).
- Keyset cursors for compat lists (a stable `(createdAt, id)` order and an opaque `cursor` parameter) would remove the 10,000-row window entirely; they need no schema change beyond a `(tenantId, createdAt, id)` index on `Contact`, `Conversation` and `Message` if one does not exist.
- The `compat:idem:*` claims live in `PlatformSetting`; retention now deletes them after 48 hours with `key LIKE 'compat:idem:%' AND "updatedAt" < cutoff`. A partial index `CREATE INDEX platformsetting_compat_idem ON "PlatformSetting" ("updatedAt") WHERE key LIKE 'compat:idem:%';` would keep that scan cheap if the table grows.

## teams-routing: routing and privacy settings stored in PlatformSetting (not blocking)

The RoutingConfig and Membership tables have no columns for the teams-routing settings, so they live in one `PlatformSetting` row per workspace under the key `routing:extra:<tenantId>` (JSON, parsed and defaulted in `src/lib/routing/extra-config.ts`): last-assignee routing, contact-owner routing, owner-on-assign, auto-reassign minutes and cap, view-only-assigned (all agents or a list), phone masking (all agents or a list), team visibility, lead stage names. The workspace erasure job already deletes it (the key contains the workspace id).

Wanted if the settings should move to real columns: `Membership.viewOnlyAssigned Boolean @default(false)`, `Membership.maskPhone Boolean @default(false)` (so the flag is read with the membership the auth layer already loads and needs no extra query per request), `RoutingConfig.autoReassignMinutes Int?`, `RoutingConfig.lastAssigneeHours Int?`, and a `Tenant` relation with `onDelete: Cascade` on `Team` and `TeamMember` (they have none today; erasure covers them through PERSONAL_DATA).

`Conversation.lastAgentReplyAt` and `firstAgentReplyAt` are set when a person sends from the inbox (`queueOutbound`). Existing conversations stay null until their next agent reply. An index on `(tenantId, assignedToId, assignedAt)` would help the auto-reassign sweep on very large workspaces.

## inbox: message search index, shared saved views, note mentions (not blocking)

Everything below works today without a schema change; these make it cheaper or richer.

- Message text search (`src/lib/inbox/list.ts`) runs `body ILIKE %q%` for the workspace, newest first, capped at 300 rows and only from three characters. For large workspaces add a trigram index (raw SQL migration, Prisma cannot declare it): `CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE INDEX message_body_trgm ON "Message" USING gin (body gin_trgm_ops);` and consider `(tenantId, createdAt)` on Message so the newest-first scan can use an index.
- Saved inbox views are personal or shared with the whole workspace. SavedInboxFilter only has `userId`, so a workspace-wide view is stored with `userId = '*'`. Views shared with chosen teammates would need `visibility String @default('me')` and `sharedWith String[]`.
- @mentions in notes are detected when the note is saved and recorded as ConversationMark `mention` rows. The note itself does not store who was mentioned, so a mention made before this release, or in a note that is edited later, has no notice. Wanted if note editing is added: `Note.mentions String[]`.
- Outbound documents show as "Document" in the thread because the file name is only sent to WhatsApp (Message has no filename column). Wanted: `Message.fileName String?`.
- The "New" label and tab rely on `Conversation.firstAgentReplyAt`, which is only set from the release that added it. The backfill for older chats now ships as the data migration `prisma/migrations/0008_agent_reply_backfill` (idempotent), so no manual step remains.

## api-roles: API key expiry, rotation and per-plan API quota (not blocking)

Not built because they need columns. Wanted: `ApiKey.expiresAt DateTime?` (optional expiry chosen when the key is created; `authenticateApiKey` refuses an expired key with the same 401 as a revoked one), `ApiKey.rotatedFromId String?` (so a rotate-in-place call can create the successor and revoke the old key after a grace period), and `Plan.apiCallsMonthly Int?` plus a monthly counter (a `UsageLedger` kind `api_calls` would do) for a plan quota with 80 and 100 percent alerts. Plan gating of API keys and webhook endpoints would also read a `Plan.features` flag, which nothing reads today.

## inbox: foreign keys for ConversationMark and SavedInboxFilter (not blocking)

ConversationMark has no foreign key to Conversation (or Tenant/User), so deleting a conversation leaves its marks behind. Readers skip marks whose chat is gone, the startChat undo deletes the marks of the chat it removes, the contact merge moves marks onto the surviving chat, and the daily worker task `inbox-prune-marks` (`src/lib/inbox/worker.ts`) removes any orphans. Wanted if a real constraint is preferred: `conversation Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)` on ConversationMark and a `Tenant` cascade on SavedInboxFilter, after which the prune task can be dropped.

## platform-saas: invoice snapshot columns (not blocking)

The Invoice row has no columns for what was true when it was issued, so the platform-saas group stores a JSON snapshot in `PlatformSetting` under `invoice-meta:<invoice number>` (`src/lib/billing/invoice.ts`: proforma or tax invoice, seller name, address, GSTIN and state code, and the buyer's place of supply). Wanted if it should move onto the row: `Invoice.proforma Boolean @default(false)`, `Invoice.sellerName String?`, `Invoice.sellerAddress String?`, `Invoice.sellerGstin String?`, `Invoice.sellerStateCode String?`, `Invoice.buyerStateCode String?`, plus `Invoice.sequence Int` with a unique `(financialYear, sequence)` so the number no longer has to be parsed back out of the string (the code looks up the highest number exactly once a sequence passes 90000, because string order breaks at 100000).

## platform-saas: webhook order and checkout markers in PlatformSetting (note only)

`billing:last-event:<tenantId>` (newest Razorpay event applied, unix seconds) and `billing:checkout-payment:<tenantId>:<paymentId>` (a checkout confirmation already used) live in `PlatformSetting`. Wanted if columns are preferred: `Subscription.lastEventAt DateTime?` and a `CheckoutPayment` table with a unique payment id.
