# Data handling answers for Data Use Checkup and review forms

Answers reflect the code as of 2026-10-27 (privacy policy v1.1). The full per-table inventory is `src/lib/lifecycle/personal-data.ts`; this page summarises it. Items marked GAP are not done and must be fixed, or answered honestly, before submission.

## What is stored

- WhatsApp: account and phone number identifiers, contacts (phone, name, attributes, opt-in records), conversations, message content and delivery status, templates, broadcasts, chatbot sessions, workspace users, billing records.
- Meta connection (only if a customer connects it): app-scoped Facebook user id of the person who connected, granted scopes, encrypted tokens; Page, Instagram, ad account, dataset and catalog ids and names.
- Ads: campaigns, ad sets, ads, daily performance snapshots (spend, impressions, clicks, results; no individual people), optimizer suggestions, approval requests (token stored as hash only).
- Leads: lead-form answers (name, email, phone, free text), consent text and time, status, follow-up sequence runs, conversion events (event name and time; email and phone are sent to Meta only as SHA-256 hashes and are not kept in the event row).
- Publishing and creative: scheduled posts and media files (`DATA_DIR/content`), brands, briefs, angles, generated assets and files (`DATA_DIR/creative`).
- AI: agent instructions, knowledge sources, MCP connection URLs with encrypted tokens, AI credit usage records.
- Shopify: shop domain, encrypted token and webhook secret, abandoned carts (shopper phone, items, total, checkout link).
- Not stored: ad payment details, Facebook passwords, card or UPI details.

## Tokens and secrets

- Meta, Shopify, WhatsApp, MCP and webhook secrets are encrypted with AES-256-GCM (`src/lib/crypto/tokens.ts`, `secrets.ts`), key from `ENCRYPTION_KEY` (32 bytes), authenticated with the tenant id so a value cannot be moved between workspaces. Never returned by an API or logged.
- Passwords use scrypt. Webhooks are verified with the app secret.
- On disconnect the token is revoked at Meta (best effort) and deleted. On workspace erasure secrets are overwritten before rows are deleted.

## Retention

Fixed periods (`FIXED_RETENTION_DAYS`) and configurable defaults (`RETENTION_DEFAULTS`, override in PlatformSetting key `retention:config`, bounded by `RETENTION_LIMITS`) are in `src/lib/lifecycle/personal-data.ts`; jobs are in `src/lib/lifecycle/retention.ts` (`runRetention`, `runPersonalDataRetention`, daily). All deletes are batched and logged as counts only.

| Data | Period |
|---|---|
| Webhook events (processed) | 30 days; unprocessed older than 30 days have payload cleared |
| Completed jobs | 7 days |
| Sessions | 30 days after expiry or revocation |
| Email tokens | 7 days after use or expiry |
| Automation runs | 90 days |
| Insight snapshots; finished optimizer proposals | 400 days |
| Conversion events | 90 days |
| Approval requests | 90 days after decision (undecided: 90 days after expiry) |
| Finished chatbot sessions (completed, expired, handed off) | 90 days |
| AI credit and usage records | 400 days |
| Leads | 24 months after last activity (later of creation, first response, last message with the lead's contact); leads in an active sequence stay; the customer can delete earlier |
| Abandoned carts | 90 days |
| Outbound webhook deliveries | 30 days |
| Creative files with no matching row | deleted after 24 hours |
| Messages, contacts, templates, ad structures, posts | until the business deletes them, disconnects, or the workspace is erased |
| Invoices, payment events | kept as tax law requires; no deletion job (period to be confirmed by an accountant) |
| Audit logs | kept while the workspace exists; deleted with it; no age-based job |

## Deletion

- Meta callback: `POST https://wa.edwyz.com/api/meta/data-deletion` verifies `signed_request` (HMAC-SHA256 with the app secret), records a request, returns `{url, confirmation_code}` and starts erasure in the background; a worker task (`lifecycle.deletion-requests`, every 5 minutes) retries failures. Status at `/data-deletion/status?code=`.
- What the callback erases (`src/lib/lifecycle/erase-meta.ts`): every workspace MetaConnection whose `metaUserId` equals the signed request's `user_id`: token revoked at Meta (best effort), then the connection, its assets (Pages, Instagram, ad accounts, datasets, catalogs) with tokens, and data derived only from those assets: lead forms and leads from its Pages with their sequence runs and conversion events, contacts created only by those leads (opt-in source lead_form, no conversations, no broadcasts), campaigns, ad sets, ads, insight snapshots, optimizer proposals, approval requests for those campaigns, post targets, conversion events for its datasets. The rest of the workspace stays: WhatsApp contacts, conversations, messages, billing and members belong to the business, not the Facebook user. The request is then marked completed and the stored Facebook user id is replaced by a short hash. A user id with no matching connection completes with zero connections, because nothing is stored under it.
- Workspace erasure (`eraseWorkspaceData` in `src/lib/lifecycle/erase-workspace.ts`), triggered by a platform admin in the console (workspace page, "Erase workspace data", slug must be typed, TOTP step-up, reason recorded): revokes Meta connections, overwrites sealed secrets, deletes every table listed in the registry in batches (children first), WebhookEvents carrying only the workspace's WhatsApp ids, PlatformSetting rows and Jobs naming the workspace, the media directories under `DATA_DIR/creative/<tenant>` and `DATA_DIR/content/<tenant>` (path checks, inside DATA_DIR only), the workspace row, and writes a tombstone `erasure:tenant:<sha256(tenant id)>` with the date. Users left with no workspace are anonymised (platform admins excepted). Refused while a Razorpay subscription is active unless the operator confirms it was cancelled. Invoices and payment events are kept.
- Per contact (`deleteContactData`) and per user (`anonymiseUser`) erasure exist in `src/lib/lifecycle/erasure.ts`.
- GAP: the Meta Page webhook subscription is not explicitly removed on erasure (the revoked token stops delivery).

## Who can see data

Only members of the owning workspace by role (owner, admin, agent), and Edwyz platform admins (allowlisted, verified email, TOTP step-up) for support as stated in the privacy policy. Every tenant query filters by `tenantId`.

## Subprocessors

Hosting (VPS provider; region not yet set in `src/lib/legal.ts`, GAP), email delivery, Razorpay (payments), Meta (platform), Shopify (only for connected stores), Anthropic (AI text, only when the customer turns AI features on). The policy names Anthropic and Shopify and lists the others by category; owner to decide whether to name all vendors and sign DPAs (GAP: none on file).

## AI processing (what is sent to Anthropic)

Only when the customer enables the feature. AI agent: business instructions, matching knowledge text, contact name if known, the last up to 10 text messages (about 4,000 characters), results of the customer's own connected tools. Creative studio: brand name, colours, tone, industry, offer, goal, text fetched from the website the customer gave, competitor notes the customer typed. Never sent: tokens, passwords, API keys, payment details, other workspaces' data. Prompts and answers are not logged. Credit use is recorded (400 days).

## Sharing and selling

No sale of data, no advertising use, no data brokers. Data goes to Meta only as part of the user's own requested actions (sending messages, creating ads, publishing, sending hashed conversion events). No customer data is used to train third-party models.

## Other answers

- Purposes: provide the messaging, ads, lead, publishing, AI and commerce features the business requests; billing; security.
- Users: businesses and their staff, 18 and over.
- Privacy contact: hello@edwyz.com (a named grievance officer may be required, legal-review-notes item 3).
- Data location: hosting country to be confirmed (GAP).
- Cookies: only `wa_access` and `wa_refresh`; no analytics.
