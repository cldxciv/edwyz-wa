# Feature completeness audit

Generated 2026-10-27 from seven read-only audits plus a skeptical re-check of every "built" claim. Status is the final status after corrections.

| Area | Built | Partial | Missing |
|---|---|---|---|
| brief-and-prod | 29 | 23 | 3 |
| campaigns-templates-commerce | 10 | 22 | 20 |
| chatbots-ai-channels | 11 | 28 | 22 |
| growth-spec | 28 | 18 | 17 |
| inbox-contacts-automation | 14 | 31 | 23 |
| integrations-api-onboarding | 14 | 27 | 30 |
| platform-saas | 31 | 20 | 8 |

## brief-and-prod
Audited about 55 requirements from AGENT-BRIEF.md, meta-checklist.md and ops.md against src/**, prisma, scripts, deploy and tests. The core platform is genuinely built and wired: Embedded Signup v4 launcher and pipeline, webhook signature check, durable webhook inbox and idempotent processor, 24-hour window enforcement, STOP handling, AES-GCM token encryption, broadcasts, templates, inbox, billing, admin, the data-deletion callback and the legal pages. Ops tooling is largely present: health, ready, metrics, env validation, shared rate limiter, CSP builder, backup script and runbook.

Gaps to fix before real customers, most important first:
1. Reconnecting the same WABA and number skips every onboarding step, including the code exchange, so a new token is never stored (src/lib/onboarding/index.ts isDone).
2. Nothing watches or refreshes the WhatsApp business token expiry. This matters if the 60-day-expiry Embedded Signup configuration is used.
3. The tier throttle (src/lib/broadcasts/throttle.ts) knows only four tier names plus 'UNLIMITED'. The 2,000 tier and Meta's TIER_UNLIMITED spelling fall back to 250 per day. It is also counted per phone number and ignores non-broadcast sends.
4. Opt-in is checked by each caller rather than centrally. Chatbot template nodes do not check marketing opt-in. There is no re-opt-in path after STOP.
5. The worker is driven by a 1-minute cron tick, so inbound messages and outbound sends can lag by up to about 60 seconds.
6. Alerting is documented but not installed. Structured logging and the error reporter are barely adopted.
7. CSP is still report-only, and RLS is designed but not applied.
8. Backups cover only the database. .env and DATA_DIR are manual copies, and there is no CI.
9. Most webhook fields beyond messages, template status and quality are only audit-logged.
10. The rate card is a hard-coded empty constant and always assumes India.
11. Templates with media headers can be created but not sent.
12. Signup has no abuse limit, and email verification is not enforced.
13. Customers have no change-password, 2FA or self-serve deletion.

Owner-side items that cannot be verified from the repo: Meta dashboard settings, screencasts and reviewer account, lawyer review, hosting location, named grievance officer, and Razorpay keys and GSTIN.

### MUST gaps
- **Reconnect / re-authorise with a fresh code and token for the same WABA and number** (partial): On reconnecting the same WABA and number every step including exchange_code is skipped as already done, so the new code is never exchanged and no new token is stored. After a token expires (getAccessToken ignores expired rows) the workspace cannot recover by reconnecting. Needs a fresh-run mode that re-runs exchange_code (and optionally subscribe) and a test for it.
- **Business token expiry handling for expiring Embedded Signup tokens (checklist recommends the 60-day-expiry configuration)** (missing): No warning, email, banner or refresh before the WhatsApp token expires; sends then fail with 'No valid WhatsApp access token'. Needs a periodic check (debug_token or expiresAt), owner email at T-14/T-3 days and a visible reconnect prompt.
- **Near-real-time processing of webhooks and outbound sends (worker cadence)** (partial): Inbound messages, status ticks and every queued reply wait up to about 60 s, which undermines the 'realtime inbox' (SSE only polls the DB). Needs a pm2 worker process (loop already written) or a faster tick; startWorker also does not write the worker:heartbeat row that /health reads.
- **Opt-in recorded with source and timestamp; marketing sends gated on opt-in** (partial): Gate is per caller, not central: sendTemplateMessage in src/lib/inbox/service.ts is documented as 'does not check opt-in', and the chatbot send_template node (src/lib/chatbots/engine.ts sendTemplateNode) only checks opt-out, so a marketing template can go to a contact with no opt-in. Opt-in is one boolean, not per message category; no stored consent text or proof; no public opt-in capture form/widget.
- **Broadcast tier throttling (messaging limit) with 24 h rolling window** (partial): TIER_LIMITS knows only TIER_250, TIER_1K, TIER_10K, TIER_100K and the key 'UNLIMITED'; anything else (the 2,000 tier from meta-checklist section 5, Meta's TIER_UNLIMITED spelling, TIER_50) silently falls back to 250/day. Limit is counted per phone number although Meta now applies it per business portfolio, and only broadcast recipients are counted (not API, chatbot or automation templates). Tier is read from deprecated messaging_limit_tier, not whatsapp_business_manager_messaging_limit.
- **Privacy policy, Terms, data-deletion instructions, honest homepage and Meta non-affiliation notice** (partial): Not yet lawyer-reviewed (docs/legal-review-notes.md); LEGAL.hostingLocation is empty; grievance contact is a generic mailbox with no named officer; no DPA on file with Anthropic or hosting/email vendors.
- **Meta app domain, redirect URIs and dashboard settings (Privacy/Terms URLs, App Domains, OAuth redirect /oauth/callback, webhook callback and fields, Live mode)** (partial): Dashboard configuration is an owner task and cannot be verified from the repo: webhook field subscriptions, Login for Business config id, valid redirect URIs, app icon, Live mode. Checklist steps 1-6 remain unticked.
- **App Review packages for whatsapp_business_messaging and whatsapp_business_management (written descriptions, screencast scripts, reviewer login)** (partial): Screencasts and a seeded reviewer demo account are not recorded or created; text must be re-checked to describe only built features; Phase C permissions (pages_messaging, instagram_manage_messages, instagram_manage_comments, catalog_management) are explicitly not built and must not be submitted.
- **Alerting on health, queue age, failed jobs, backups, TLS** (partial): All alerts are guidance only: nothing is installed or shipped (no cron/monitor files for queue age, failed jobs, stuck running, backup age or cert expiry).
- **Database backups and restore** (partial): Backs up the database only; .env (holding ENCRYPTION_KEY) and DATA_DIR need separate manual copies; no automatic off-server copy or retention policy; no evidence the monthly restore check (8.5) has been run; backup alerts are guidance only.

### SHOULD gaps
- **Postgres row-level security as backstop for a forgotten tenantId filter** (partial): Plan is 'designed, not applied': no edwyz_app/edwyz_system roles, no policies, no set_config per transaction, no app_get_access_token SECURITY DEFINER function. Every query still depends on handler discipline.
- **Remaining subscribed fields acted on: message_template_quality_update, template_category_update, account_alerts, business_capability_update, account_review_update, phone_number_name_update, account_update violations/offboarding** (partial): Nothing is applied or surfaced: no template quality score or category change on Template, no portfolio messaging-limit update from business_capability_update, no phone/WABA status change on offboarding or restriction, no alert to the owner. The Template model has no quality field.
- **Re-opt-in after STOP (user messages a start keyword)** (missing): An opted-out contact can never be re-enabled, even if they ask to resubscribe. Needs a start keyword handler (or an audited admin override) in processor.ts and tests.
- **Phone number quality, messaging limit and status kept current** (partial): No periodic Graph refresh (lifecycle worker only syncs templates), so missed webhooks leave stale quality, tier and connection status; no handling of number disconnect/ban from account_update.
- **Per-user marketing cap (131049) retry and failed-recipient reconciliation** (partial): None.
- **Broadcast cost estimate with no invented prices (configurable rate card)** (partial): Rate card is a hard-coded empty constant in source, not editable in admin settings or PlatformSetting, so 'configurable' means a code change and redeploy. startBroadcast always estimates with country 'IN' regardless of recipient country codes.
- **Sending templates that have media headers, header variables or URL button variables** (partial): Templates can be created and approved but not sent from inbox, broadcast, compat API or MCP, which is a visible parity gap for image-header marketing templates.
- **Signup abuse protection and email-verification enforcement** (partial): Unlimited anonymous signups each cost an scrypt hash plus a trial, and unverified emails can run broadcasts. Signup also reveals whether an email exists (409). Add per-IP limiter via src/lib/ratelimit and require verified email before connecting a number or broadcasting.
- **Customer self-service account and workspace controls: change password, workspace profile, 2FA for users, self-serve workspace deletion** (missing): Customers cannot change a password while signed in, enable 2FA, rename the workspace or request deletion in-product (privacy policy promises deletion by request within 30 days via email/admin). Workspace JSON/CSV export exists under Reports.
- **Structured JSON logging with redaction, request ids and error-reporter hook** (partial): About 37 source files, including the webhook route, onboarding and billing, still use bare console.*; API routes do not call requestLogger so request ids are not in their logs; no error reporter is registered anywhere (no instrumentation vendor), so exceptions are not aggregated. pm2-logrotate is a manual step.
- **Shared rate limiting for auth, API keys, MCP, uploads, approvals and CSP reports; nginx rate zones** (partial): No limiter on signup or on the webhook endpoint in-app, none on ordinary session-authenticated writes (inbox send, template submit); RateLimitBucket table not created (settings backend only, fine to roughly 50 req/s); replay sets (usedNonces, usedTokens) and SSE connection counts are still per process.
- **Content-Security-Policy and security headers** (partial): Default CSP_MODE is report-only: the enforced policy still allows 'unsafe-inline' scripts. Enforcing needs the root layout made dynamic (documented precondition in ops.md section 6, not done: src/app/layout.tsx has no connection()), a week of violation review, then CSP_MODE=enforce. CSP_MODE, ENV_STRICT, LOG_LEVEL and RATELIMIT_BACKEND are absent from .env.example.
- **Migrations and release process** (partial): Migrations are applied by hand with no _prisma_migrations ledger, no package.json script for migrate or smoke, and no automated rollback; releases are tarballs built locally.
- **Automated tests and CI** (partial): No CI pipeline or pre-deploy gate in the repo (no .github), smoke.mjs is not wired to an npm script, and nothing runs against a real Meta test number. The new gaps found here (reconnect skipping the token exchange, tier table, chatbot opt-in) have no failing tests.

### COULD gaps
- **Hosted Embedded Signup path (account_update PARTNER_ADDED, system user token fetch, phone number lookup)** (partial): No token retrieval (appsecret_proof, System User Access Tokens API), no tenant binding, no phone lookup. Only the JS SDK path works. Acceptable if hosted link is never offered, but then the UI/docs must not mention it.
- **Single-instance constraint and horizontal scaling** (partial): Remaining in-memory state (approval nonce set, MCP confirm-token replay set, compat idempotency map, AI in-flight guard, SSE gauge) means the web tier must stay at one pm2 instance; no downtime-free deploy.

## campaigns-templates-commerce
Audit of docs/wati/campaigns-templates-commerce.md against wa/. Built: a tag-audience broadcast engine with worker, tier throttle and quality auto-pause; scheduling, a calendar, a funnel, the per-user-cap retry, STOP opt-out, template create/submit/sync/delete/status webhook, and Shopify abandoned cart/checkout recovery. The two weakest areas are commerce and money. Nothing was built for the WhatsApp catalog, product messages, orders, or WooCommerce: catalog.ts only has pure payload builders with no caller, route or UI. There is no wallet, rate card or ledger, so cost estimates always return "not configured". Other major gaps: segments (tags only, no filters or profile signals), media-header and button-variable templates (blocked from broadcast), drip campaigns, click tracking, and carousel, limited-time-offer and authentication templates. Several built items are partial because they lack a wiring step, for example template pause does not stop a running broadcast, and a failed status arriving after sent skips retry bookkeeping. Tests are mostly unit/service level; there is no end-to-end Meta test. This was a read-only audit: no builds or tests were run, and statuses come from reading code.

### MUST gaps
- **Audience: all contacts or filter stacks on attributes** (partial): Only opted-in contacts, optionally filtered by ANY of a set of tags. No attribute filters, no AND/OR groups, no 'Add another filter'.
- **Template variable mapping from contact attributes with missing-value failure** (partial): Only numbered body variables, filled from attributes keyed by digit. No named variables, no mapping UI, and no check for newlines/tabs/4+ spaces in values. A missing value fails that recipient silently and the wizard does not flag this before sending.
- **Personalized media headers and header/URL-button variables in campaigns** (missing): Any template with an image/video/document header or dynamic URL button cannot be broadcast. Wati supports these as a core use case.
- **Throttling: Meta tier limit (rolling 24h unique recipients)** (partial): Counts messages (broadcast recipients) per phone number, not unique recipients per business portfolio. Other business-initiated sends (automations, API, commerce reminders) are not counted. Tier ladder lacks the 2K tier (TIER_2K) and unknown tiers fall back to 250. Fixed batch of 20 per pass with no per-second rate cap.
- **Pre-send cost estimate** (partial): RATE_CARD is an empty object, so the estimate always returns configured:false. Country is hard-coded 'IN' (not each recipient's calling code). No wallet balance comparison or insufficient-credit check.
- **Wallet, credits, rate card, ledger, charge on SENT and top-up** (missing): No wallet balance, welcome credit, minimum balance, reserve/charge/release, rate-change dates or auto-recharge. The only quota is plan broadcastContacts per month (src/lib/billing/limits.ts).
- **Template pacing/pause handling (stop campaign, retry with new template)** (partial): processBroadcast never re-checks template status after start, so a paused template does not stop the campaign. No error 132015 detection, no admin email, no 'retry with new template' action.
- **Auto-retry of per-user-cap failures (retryDays 1-7)** (partial): A failure that arrives via the status webhook after the recipient is already 'sent' goes through webhooks/processor.ts updateRecipientStatus, which sets failed without attempts/retryAfter, so no retry is scheduled in that path. No retryUntil date and no 15-day new-account guard. Retry is daily only.
- **Opt-in consent record (source, timestamp)** (partial): Only the latest source and time are kept. There is no ConsentEvent history (type, channel, evidence), and opt-in forms are not tied to a consent record.
- **Media header upload (image/video/document) in the template editor** (partial): The API requires a Meta media handle. No resumable-upload or media-handle code (grep for header_handle/resumable finds only the validator), and the editor appears to offer text headers only. Media-header templates also cannot be broadcast.

### SHOULD gaps
- **Audience: CSV import with country code and column mapping** (partial): The CSV import is in the Contacts area, not the campaign flow. No UI column-mapping step (columns are matched by header name), and no choice to leave existing contacts untouched (it always merges). No per-row error export.
- **Segments: predefined (Highly Engaged, Winback, At Risk, All Valid)** (missing): No predefined segments and no engagement signals to compute them from.
- **Segments: custom active/static with preview, profile signals, async compute, clone** (missing): No segment entity, saved filters, static vs dynamic, preview, profile-signal fields (last read, 7/30/90-day counts), 20-segment cap or automation use.
- **Quick-reply campaign reply actions (button leads to rule, message or chatbot)** (missing): No QuickReplyBinding, no campaign reply action selection, and no precedence over rules.
- **Public API: schedule template send, cancel scheduled, send to many recipients** (partial): Sends immediately and creates no broadcast record (broadcast_id is null). No schedule endpoint, no cancel-scheduled, limit 100 instead of 10,000, no CSV send endpoint, no estimate-cost, auto-retry or segments endpoint. Read-only broadcasts list/get/recipients exist.
- **Number quality auto-pause** (partial): No email or notification to admins when the broadcast pauses; no flagged-number logic.
- **Per-user marketing cap (131049) handling and exclusion** (partial): The failure is treated as an ordinary failed recipient plus retry. Recipients about to hit the cap are not excluded or uncharged. No handling of 130472 (experiment) or 130497 (cross-country) as distinct reasons.
- **Funnel and overview dashboard (sent/delivered/read/replied, date range)** (partial): No spend, no engagement (clicks), no category filter (marketing/utility), no failure-reason breakdown chart, no retarget actions.
- **Campaign CSV export and failure report** (partial): Export is a tenant-level broadcasts CSV; there is no per-campaign recipient/failure export with failure codes and attribution.
- **Failure reason text and codes** (partial): Not verified to cover the full code catalog (131049, 130472, 132001/5/12, 131053, tier limit). No media-rule validation before send.
- **Drip campaigns / sequences** (missing): No multi-step campaigns with delays, stop-on-reply, enrolment or per-step stats for broadcast audiences.
- **Template delete, copy, JSON import/export, search/filter** (partial): No duplicate/copy, no JSON export/import, no per-name 30-day reuse note.
- **Template categories and recategorization tracking** (partial): Only one category stored, so requested vs effective category is not tracked, no category-update webhook, no appeal, and pricing cannot be adjusted.
- **Buttons: quick reply, URL (static/dynamic), phone** (partial): No Copy Offer Code, Flow, WhatsApp voice-call buttons; allows 10 buttons with no per-type or combination limits (3 quick replies, 2 CTAs); button text limit 25 rather than 20 for quick replies. Dynamic URL buttons cannot be broadcast.
- **Authentication (OTP) templates and send API** (missing): No locked auth format (code placeholder, expiry, one-tap/copy-code button), no OTP send endpoint, no SMS fallback.
- **Click tracking on URL buttons** (missing): No link rewriting, click events, per-contact clicks or click-based segments.
- **Catalog connect and sync (Commerce Manager catalog ID)** (missing): No catalog connection, sync, product or set storage. The nav item 'Shopify recovery' (/app/commerce) is only cart recovery.
- **Product and multi-product messages, catalog templates** (partial): Pure payload builders only: no caller in src, no API route, no UI, no chatbot node, no catalog template or campaign. Tested but not reachable.
- **Shopify automated messages beyond abandoned cart (order confirmation, shipping, COD)** (missing): No order confirmation, shipping/tracking, fulfilled, refund or COD confirm/cancel messages and no variable set for them.

### COULD gaps
- **Segments public API (list, get, evaluate, create)** (missing): No segments API.
- **Campaign calendar (monthly view of scheduled and sent)** (partial): View only. No click-a-date-to-create, no inline edit or remove from the calendar, no AI-recommended slots.
- **Retargeting (Opened/Replied/Ignored/Clicked follow-up campaign)** (missing): Cannot launch a follow-up campaign from a campaign's recipients by outcome.
- **Fallback channel (SMS/RCS) on failure** (missing): No Twilio/SMS integration, fallback template mapping or OTP SMS fallback.
- **Role restriction on campaigns** (partial): No separate 'campaign manager' role.
- **Carousel templates** (missing): No carousel component support at all.
- **Limited-time-offer template** (missing): Not supported.
- **Template library (Meta prebuilt templates)** (missing): Cannot browse or create from Meta's template library.
- **Template quality score and per-template analytics** (missing): No quality score, template-level send/read stats, or pause/unpause flow.
- **Cart/order ingest from WhatsApp, orders page, checkout and payments** (missing): No inbound cart ('order') messages, orders list, address collection, payment config or order status messages.
- **Shopify customer sync, segment sync and ROI tracking** (missing): No two-way customer/tag sync, Shopify segments, historical import or order-to-message ROI (2-10 day window).
- **WooCommerce connector** (missing): No plugin or webhook handler.
- **Click-to-WhatsApp attribution capture** (partial): Outside the campaigns/templates/commerce focus; capture exists but was not audited for CAPI conversion triggers or the free-window clock.

## chatbots-ai-channels
The WhatsApp-only chatbot runtime, the AI agent and click-to-WhatsApp ad creation and attribution are real and wired end to end. Most of the rest of the source document is missing. Almost nothing outside WhatsApp exists.

I read the source document and traced the code (read-only, no builds or tests run). That gives 58 items: 14 built, 22 partial, 21 missing and 1 not applicable.

**What is built and wired**
- **Chatbots:** the builder UI and API. The runtime is called from `src/lib/webhooks/processor.ts`, and delay resume and session expiry are registered in `src/worker/loop.ts`.
- **AI agent:** it replies with Claude, uses knowledge sources, hands off to a human, and meters credits. It is reachable at `/app/automation/ai-agent` and in the inbox suggest button.
- **Click-to-WhatsApp ads:** campaign creation (CTWA ad wizard), referral capture on the first message, and the "Came from an ad" side panel.

**Biggest gaps against the source**
- **Interactive messages:** buttons and lists are sent as numbered plain text. No real WhatsApp interactive messages are sent.
- **Manual chatbots:** nothing in the UI, API or rules starts one. Only lead sequences can.
- **Rules engine:** only three canned auto-reply types. There are no attribute triggers and no actions such as start a chatbot or route a chat.
- **Flow nodes:** Google Sheets, Subscribe/Unsubscribe, Trigger Chatbot, Wati AI Assist and the AI-agent hand-off node are missing. The Ask node has no date, regex or media validation, and conditions are single-clause only.
- **Escalation and timers:** Smart Escalation is missing. The session timeout is fixed at 24 hours with no reminder.
- **Chatbot analytics and inbox visibility:** session analytics exist only as a raw API, with no UI or aggregates. There are no bot status chips in the inbox.
- **AI agent:**
  - Knowledge is limited to text, FAQ and single URLs, with no document upload, crawl or embeddings.
  - There are no built-in actions; tools come only from the customer's own MCP server.
  - There is no lead qualification, evaluation suite or voice.
  - Credits have no rollover, add-ons or alerts, and the reservation is held in per-process memory.
- **Identity:** `Contact.phone` is required and inbound messages with no `from` are dropped. This breaks for WhatsApp username (BSUID) contacts, which Meta started rolling out in June 2026.
- **Channels:** Instagram DM and comments, Messenger, web chat, WhatsApp Calling, Groups, TikTok and RCS have no code. There is also no channel abstraction, which every one of them needs first.
- **Conversion events:** the conversion queue and worker are wired, but there is no UI. Events fire only from lead status changes. The payload code carries a "VERIFY every field name" warning, and the ad builders have similar VERIFY notes. The per-ad conversation API also has no UI.

**Tests:** there are unit tests for chatbot flow and engine (`chatbots-engine.test.ts`, `chatbots-flow.test.ts`), routes, the builder, the AI agent, `byo-mcp`, conversions and ads. `scripts/smoke.mjs` covers chatbot create, publish and keyword start.

**Must-fix before launch (in order):**
1. BSUID-safe contact identity.
2. Real interactive buttons and lists.
3. A way to start manual chatbots.
4. Smart Escalation.
5. A conversion events UI, with the Meta payload verified live.

### MUST gaps
- **Node: Send a message (text)** (partial): Text only. No image, video, audio or document message node. Interpolation uses {{var}} in one namespace.
- **Node: Buttons (reply buttons, max 3 x 20 chars) and List message (max 10 rows x 24 chars)** (partial): Never sends real WhatsApp interactive reply-button or list messages; customers must type the option. No header/footer, no media header, no header text. Tapped-button replies from real interactive messages are only handled as body text. Answer is not saved to a named variable (only last_choice/last_choice_title).
- **Node: Template message (send an approved template with variables)** (partial): Body text parameters only: no header/media/button/CTA parameters, no button-reply routing. Silently skips when template is missing/unapproved or contact opted out (no error path or log). Window-closed errors end the session as expired.
- **Nodes: Assign agent / team (direct or round robin), Update chat status, Handoff to team** (partial): No team concept (users only); 'closed' status absent; assign to an offline/inactive operator is not checked; handoff does not pass any bot-collected context or summary to the human other than variables saved to attributes.
- **Chatbot triggers: keyword, first message, any message, per phone number, priority** (partial): Keyword match is contains only (no exact/fuzzy choice). Priority is creation order, not a user-set priority. No trigger on contact-attribute change, no 'customer has not replied' trigger, no instagram/messenger triggers.
- **Manual start of a chatbot (inbox 'Trigger chatbot', API start, rule action)** (partial): No API route (api/chatbots/[id] has no start), no inbox button, and the automation rule engine has no start-chatbot action, so a 'manual' bot can only be started from a lead sequence. UI copy promises a capability that is not reachable.
- **Rules engine: triggers, filters, actions, priority (Automation > Rules)** (partial): Only three canned auto-reply rule types sending static text. No attribute-created/changed or no-reply triggers, no message/media filters, no actions for send template, start chatbot, route chat, update attributes, tags or status; no reorderable priority; no Instagram/Messenger triggers.
- **Conflict rules: one bot or AI agent per contact at a time, bot cannot start on human-assigned chat** (partial): Chatbot start does not check whether the conversation is assigned to a human, so a published any_message/keyword bot can fire on an agent-handled chat. Not per-channel (single channel).
- **Smart Escalation (detect human request or frustration on a bot node and assign to team)** (missing): A customer typing 'agent' in a flow just gets retries; they must hit an explicit handoff edge. Suggest reusing asksForHuman and handing off with assignment.
- **AI agent: create and configure (instructions, tone, language, model, WhatsApp number, activation rules, enable switch)** (partial): No role/use-case templates, no website-crawl pre-fill, no 'Vibe' natural-language instruction rewriting, no draft vs published instructions, no branding. Single channel (WhatsApp).
- **AI knowledge base: text, FAQ, website page sources with retrieval** (partial): No document upload (PDF, DOCX, TXT, MD), no site crawl or subpage selection, no retrain/refresh of URL sources (fetched once), no embeddings (keyword scoring only), no per-plan storage caps (50 sources and 100k chars each fixed), no knowledge-base automation from good conversations.
- **AI credits metering, plan allotment and alerts** (partial): No rollover (2x cap), add-on credit purchase or expiry, no expiring-first consumption, no 75/90/100% alerts, no admin top-up. Reservation is per-process memory so multiple worker processes can overshoot. Rich-response and voice pricing tiers not applied.
- **BSUID-first contact identity (usernames, contacts without phone)** (missing): Inbound messages from username users without a phone number are dropped; no merge-on-phone logic or Request Contact Info flow. Meta rollout began June 2026.
- **Conversion events back to Meta (Lead, Qualified Lead, Purchase) with ctwa_clid via Conversions API** (partial): No UI for dataset selection, enable switch, or delivery log (no component calls /api/conversions). Events only fire from Lead status qualified/won; chatbot completion, 'Contact', first reply or manual inbox marking cannot trigger them. payload.ts carries a 'VERIFY every field name' warning (action_source/messaging_channel/event naming unproven). Plain WABA id never sent.

### SHOULD gaps
- **Node: Ask a question, free text with save to variable and validation** (partial): Missing date, date+time, time, regex pattern, min/max for numbers, and media-type validation. Cannot accept documents/images/videos or save media location; non-text replies are dropped to empty text and treated as invalid. No custom error message per validation type beyond retryText.
- **Node: Set a condition (branch on variable/attribute with operators, true/false paths)** (partial): Missing operators does-not-contain, starts-with, does-not-start-with; only one condition per node (no AND/OR of two). Otherwise parity (variable or contact attribute lookup).
- **Node: Webhook (GET/POST with variable interpolation, response mapping, success/failure routing)** (partial): No custom headers or auth, JSON body only via template, no dot-path/JSONPath mapping of response fields into separate variables or contact attributes (whole response stored in one variable), no test button with sample variables in the builder, no status-code-specific routing, HTTPS only (acceptable), not plan-gated.
- **Nodes: Subscribe / Unsubscribe (campaign opt-in/out)** (missing): Flows cannot flip the contact's campaign consent. Could be added as two nodes writing Contact.optIn/optedOutAt with an audit row.
- **Node: Time Delay** (partial): Minutes granularity only (no seconds). Delays above 24 h cross the WhatsApp service window: the next sendText throws (requireOpenWindow in src/lib/inbox/service.ts) and the whole session silently ends as expired; no warning in the builder or validator.
- **Node: Wati AI Assist (LLM collects one attribute conversationally)** (missing): No node that calls Claude to collect a phone/email/custom value with success/failure outputs.
- **Nodes: Astra AI Agent / Custom AI Agent (hand conversation from flow to an AI agent)** (missing): A flow cannot route a conversation into the AI agent (or to an external agent). Only fallthrough when no bot matches.
- **Default actions: welcome, out-of-hours, no-agent-online, fallback** (partial): No 'no agent online' or fallback (unrecognised message) default; welcome fires on cooldown/silence not strictly first message; automations are skipped whenever a chatbot or AI agent consumed the message (by design).
- **Session timers: inactivity timeout (Timer 1) and exit reminder (Timer 2); STOP ends the bot** (partial): Timeout is a hard-coded 24 h, not configurable (WATI: 1 to 1440 min). No exit-chatbot reminder message.
- **Fallback message and retries on invalid reply** (partial): No global or per-bot fallback message setting; option nodes' retry count and text are not configurable (generic 'Please reply with one of the options.').
- **Session status chips in inbox (Started, Ended, Expired, Blocked)** (missing): Agents cannot see whether a bot is running or has ended on a conversation, or stop it from the inbox.
- **Testing a chatbot (simulator or real number)** (partial): No test-with-real-WhatsApp-number mode; webhook, template, assign and delay behaviour are not exercised in preview.
- **Per-flow analytics: sessions, completion, drop-off, reassignment, user journey, session logs, CSV export** (partial): No UI page, no aggregate metrics or rates, no date/channel filters, no per-node counts or branch percentages (visited nodes are not recorded), no CSV export.
- **AI agent actions/tools (library, CRM, Sheets, Slack, create/update contact, send template, REST action)** (partial): No built-in actions: nothing to update contacts/attributes, assign to team, send template or booking summary, call HubSpot/Salesforce/Zoho/Slack/Sheets, or a configurable REST action, and no online/offline sync or action execution/credit counts. Everything depends on the customer running an MCP server.
- **Lead qualification and scoring (BANT, score + category, leads as contacts)** (missing): AI agent does not collect criteria, score, or create Lead rows; no AI-generated lead view.
- **AI agent on other channels (web widget, Instagram) and branding** (missing): WhatsApp only; no channel field, no widget.
- **Channel abstraction (ContactIdentity / Channel per conversation)** (missing): All inbox, chatbot, AI and automation code assumes WhatsApp. Prerequisite for every other channel.
- **Instagram DM inbox, comment inbox and replies, welcome/keyword rules, chatbot and AI on Instagram** (missing): No Instagram messaging at all: no webhook subscription, 24 h/7-day window logic, inbound or outbound DM, comment management.
- **Instagram/Facebook comment-to-DM, story reply and mention automation** (missing): Entire feature absent (webhooks for comments, private-reply endpoint, filters by post).
- **Facebook Messenger channel (inbox, rules, chatbots, comment-to-DM)** (missing): No Messenger messaging integration.
- **Web chat widget (embeddable script, pre-chat form, routing team, visitor identity)** (missing): Not built; needs the channel abstraction plus an embeddable JS client and visitor sessions.
- **CTWA reporting: conversations per ad source and ad insights with conversations started** (partial): The per-ad conversation-source API has no UI caller (nothing in src/components references /api/conversions). No cost-per-conversation join of insights with real inbound conversations.

### COULD gaps
- **Node: Google Sheets (OAuth, insert/update row)** (missing): Whole feature absent. Workaround is the webhook node.
- **Node: Trigger Chatbot (jump to another chatbot)** (missing): No chained-bot node, no loop/depth protection design.
- **Import/export chatbot as JSON; duplicate; archive** (partial): No JSON export or import in UI or API.
- **Chatbot versioning and draft/published model** (partial): Old published versions are not retained, no version history UI or restore, sessions not pinned to a version.
- **Plan limits on chatbots and node types** (partial): No plan-based gating of chatbot count or advanced nodes; no entitlement check.
- **AI agent custom forms (in-chat structured data capture)** (missing): Not applicable to chat in current agent; a chatbot ask-flow is the only structured capture.
- **Agent evaluation: auto-generated test cases, pass/fail, scores, recommendations** (missing): No test-case generation, batch run, scoring, or instruction-improvement flow. The single-message playground is text only.
- **Voice AI agents (web and WhatsApp calls)** (missing): No voice agent, voice cloning, silence handling or call-length settings.
- **Inbox AI co-pilot: tone/grammar rewrite, summaries, translation, CX score, topic and operator insights, template generator, Ask-AI assistant, scheduled AI analysers** (missing): None of these Wati AI features exist. Most valuable first: conversation summary and message rewrite.
- **Connect your own AI agent (agent as operator with token, assigned-chat webhooks, handoff endpoint)** (partial): No custom-agent identity in team/operator list, no events scoped to chats assigned to that agent, no assign-to-agent path in bots/rules, no documented payload/signature contract for this use.
- **MCP server for the workspace** (partial): Roughly 13 tools vs 58; no chatbot, rule, segment, webhook, campaign-performance or AI-agent tools; OAuth browser flow not present (API key bearer instead); no EU endpoint.
- **WhatsApp Calling (permissions, softphone, routing, recording, billing) and call-permission templates** (missing): Entirely absent, including call webhooks, permission state machine and call logs.
- **WhatsApp Groups, TikTok DM and ads events, RCS** (missing): Not started. Groups needs Business-tier Cloud API groups endpoints; TikTok and RCS are partner dependent.
- **Ad-click and scheduled chatbot triggers (start a bot for ad-sourced chats)** (missing): Source doc notes WATI has no such trigger either, but a CTWA bot trigger (referral source id) is the natural parity-plus feature.

## growth-spec
Audit of docs/PRODUCT-SPEC-GROWTH.md sections 3.1-3.7, 4, 5, 6 and 7 against the code in wa (read-only; nothing was built or run, so every status below comes from reading the code and the test file names, not from running the tests). The Phase A and B core loop is real and wired end to end: Connect, Campaign Launcher with money-safety rails, Lead Hub with sequences, Content Calendar publishing, Insights ingestion, the proposal-only Optimiser, approval links, and the data-deletion registry. These all have worker registration in src/worker/loop.ts or an API route plus a nav-linked page.

Biggest gaps against production readiness:
1. Creative Studio has no real image provider (an SVG placeholder only) and no video provider.
2. A generated image never reaches an ad. The wizard copies only text from a saved creative, and the picture must be pasted as an https URL. It builds one ad per campaign, although the API accepts up to 10.
3. Section 7 plan limits are largely unenforced. adAccountLimit is stored but never checked. aiCreditsMonthly is enforced only for the inbox AI agent and suggestions, not Creative Studio. There is no scheduledPostLimit or connectedChannelLimit, and the posts and ad_accounts meters are never written.
4. The Optimiser "learn" loop is missing, and so are past-performance inputs to briefs, Page and Instagram insights, and best-time suggestions.
5. Phase C is entirely absent: Unified Inbox (no channel field), Messenger and Instagram DMs, comments, Catalog sync, Threads publishing, and Agency multi-client workspaces.
6. The scope list requests read_insights and instagram_manage_insights, but no code calls those APIs, which contradicts the spec's "request only what the phase ships".
7. Conversions feedback has an API but no UI, and its payload is marked VERIFY. The extended smoke script scripts/smoke.mjs only exercises the lead webhook handshake (about lines 252-258) among the growth modules.

### MUST gaps
- **3.2 / 5.4 Image generation through a replaceable provider interface** (partial): No real image-generation provider is implemented (CREATIVE_IMAGE_PROVIDER for anything else returns 501). SVG output is not accepted by Meta ads or by Instagram, so generated pictures cannot be used as real creatives. Owner decision on the provider is pending.
- **5.7 Publish: variants go out as separate ads for A/B testing; creative flows into the ad** (partial): The generated image never reaches the ad: no code maps CreativeAsset.storageKey to a URL or image hash for the ad (the ads code never reads storageKey), so the picture must be pasted as an https URL. No multi-variant selection in the UI, no 'use in campaign' button from the brief page, and no A/B experiment wiring.
- **5 Controls: per-workspace AI credit budget enforced for Creative Studio** (partial): Creative Studio never checks Plan.aiCreditsMonthly before spending, so a workspace can exceed its credits. usage.ts itself says enforcement is 'added by the coordinator', which is not done for the creative routes.
- **3.4 Assign the lead to an agent via the routing module** (partial): Assignment happens only after a sequence step is actually sent. A lead with no matching sequence, no phone, or a skipped send is never auto-assigned.
- **3.7 Optimiser proposals: pause weak ads, shift budget, rotate fatigued creatives, suggest new angles** (partial): Only pause_ad and shift_budget change anything. approveProposal for rotate_creative and new_angle just marks the proposal applied (applyKind returns revertPayload null): advisory text with no link to Creative Studio and no creative swap.
- **3.7 Conversions API feedback to Meta when a lead is qualified or sold, with ctwa_clid** (partial): No UI anywhere calls the conversions settings/list routes (no dataset picker or enable toggle; it defaults to enabled with the first dataset). The 'Lead' event is never queued at ingest. QualifiedLead maps to a custom event whose name and the payload fields are marked VERIFY. Triggered only from lead status changes on the Leads page, not from the inbox itself. Results are not fed to any creative learner.
- **4 Permissions requested match what the code uses, per phase** (partial): read_insights and instagram_manage_insights have no code use. docs/app-review also contains pages_messaging, instagram_manage_messages, instagram_manage_comments and catalog_management documents for unbuilt features. WhatsApp scopes are handled in the separate signup flow. Actual granted permissions depend on the dashboard configuration.
- **6 Data model: new tables with tenantId and indexes** (partial): Not present: CatalogSync, Conversation.channel, Contact.psid/igsid, Plan.scheduledPostLimit and connectedChannelLimit, ApprovalRequest.channel, Brand.logoAssetId, a separate PolicyCheck table, InsightSnapshot.costPerResult, ConversionEvent.sentAt, MetaAsset type waba. Some tables lack tenant-leading indexes (for example Lead.tenantId+leadgenId is covered by the unique key; AdSet/Ad are indexed).
- **7 Plan limit: connected ad accounts (adAccountLimit) enforced** (missing): No enforcement; the pricing page deliberately avoids advertising the number because it is not enforced.
- **7 Plan limits: AI credits (aiCreditsMonthly) enforced across Creative Studio and the AI agent** (partial): No enforcement in creative research, angles, copy or media routes, so the largest AI cost driver is unmetered against the plan.
- **7 Plan limits: scheduled posts and connected channels (scheduledPostLimit, connectedChannelLimit)** (missing): Neither limit exists nor is enforced; the content media quota is the only cap.
- **Operational: end-to-end smoke test and automated tests for the growth flow** (partial): No smoke or integration check covers Connect callback, campaign draft to launch, lead ingest to sequence send, post scheduling or the optimizer. All Meta calls are mocked and many request shapes are marked VERIFY. I did not run the tests.

### SHOULD gaps
- **3.1 One flow that also covers WhatsApp Embedded Signup and stores WABA assets** (partial): The spec's single connect flow and the MetaAsset type waba are not implemented. WABA and numbers live in the older Waba/PhoneNumber tables, and the Connections page's 'what we can access' list does not show them.
- **3.2 Brand kit: name, website, logo, colours, fonts, tone, banned words, industry, special category; delete brand and its generated assets** (partial): The logo is only a URL string (Brand.logoUrl), not an uploaded stored asset (spec: logoAssetId). Fonts and logo are stored but never used by the placeholder image renderer (only colours are used).
- **5.2 Research: past ad performance from Insights and industry benchmarks as brief input** (missing): The creative research step does not use the workspace's insight data or any benchmarks. Briefs only get the website text and manually typed competitor notes.
- **3.2 / 5.4 Short video generation (Reels/Stories)** (missing): No video provider or pipeline.
- **5.5 AI-generated content labelling where Meta requires it** (partial): Only an advisory finding is shown. Nothing sets an AI label or flag when the creative is sent to Meta, and no user acknowledgement is required.
- **5.5 Brand safety: no real people's likenesses or third-party logos** (missing): Nothing prevents or flags likeness or logo generation once a real image provider exists. The current placeholder provider cannot generate any. A prompt/provider guard must be added with the real provider.
- **5.8 Learn: winners and losers stored per workspace and fed back into the next brief** (missing): No learner storage and no use of winner data in generateAngles or generateCopy; the conversion feedback does not feed anything creative either.
- **5 Controls: prompt and output logging with retention limits; no customer data to third-party training** (missing): Neither the prompt/output log nor its retention is implemented. 'Not used for training' is only a policy statement and is not documented in code or the UI.
- **3.2 / 6 Generated assets stored in object storage, not Postgres** (partial): No S3-compatible implementation. The storage depends on the single server's disk, which the spec's risk 8 says is insufficient before Phase B scale. Files are kept out of Postgres, which meets the main intent.
- **3.3 Audience, location and schedule inputs, custom audiences** (partial): The UI sends geo.cities as an empty list (no city/radius picker), interests are limited, and no custom or saved audience support exists, although 'custom audiences' is listed as a Core use case.
- **3.4 Lead form management (register forms, set consent wording)** (partial): Forms are registered by typing an existing Meta form ID. The platform cannot create or edit instant forms through the Marketing API, so the launcher depends on forms made manually in Meta.
- **3.5 Unified Inbox: channel field on Conversation (whatsapp, messenger, instagram, comment) and psid/igsid on Contact** (missing): Entire Phase C inbox is unbuilt. The schema and the inbox send/stream/routing layers are WhatsApp-only.
- **3.5 Messenger and Instagram DM send/receive with per-channel messaging-window rules** (missing): Not built (Phase C, correctly excluded from META_CONNECT_SCOPES).
- **3.5 Comments: list, reply, hide, delete, convert to DM** (missing): Not built; comment moderation is also listed under Phase B 'pages_manage_engagement' in the spec.
- **3.6 Approval states for scheduled posts** (partial): None significant.
- **3.7 / 4 Page and Instagram organic insights (read_insights, instagram_manage_insights)** (missing): Both permissions are listed in META_CONNECT_SCOPES and docs/app-review/instagram_manage_insights.md, but no feature uses them, which violates the spec's rule to request only what ships and risks review rejection.
- **7 UsageLedger metering (ai_credits, ad_accounts, posts)** (partial): The posts and ad_accounts meters are never recorded. Usage for the new meters has no report view (reports/usage.ts covers older usage only, not verified).
- **7 Tier structure (Starter/Growth/Agency) with feature gating of Launcher, Creative Studio, Optimiser, calendar** (missing): Growth-tier modules are available to every plan, so tiers cannot be differentiated except by numeric limits.

### COULD gaps
- **3.6 Best-time-to-post suggestions from insights** (missing): Not implemented. This needs Page/IG insights ingestion, which also does not exist.
- **3.6 Threads publishing (Phase C)** (missing): Stub only; threads_basic/threads_content_publish not requested.
- **3.7 Per-workspace 'auto-apply within limits' mode** (missing): Spec says it can be enabled later; not built.
- **6 Catalog sync and product ads (CatalogSync)** (missing): Phase C catalog and product ads are not built.
- **7 / 8 Agency multi-client workspaces (one login, several client workspaces, pooled credits, white-label approval links)** (missing): Not built; flagged as an owner decision for the first release.

## inbox-contacts-automation
Audit of the WhatsApp inbox, contacts, automation and BSUID features in C:\Users\ADMIN\projects\edwyz\wa against docs/wati/inbox-contacts-automation.md. 63 items were checked. The WhatsApp-only core is built and wired: inbox thread and list, 24-hour window and template-only mode, statuses with reopen on inbound, shared unread, manual and round-robin or least-busy assignment with availability and a worker sweep, bulk actions, tags, notes, quick replies, inbound media, delivery states, realtime via a polled SSE stream, contacts CRUD, import, export and opt-in, welcome, away and keyword replies, and STOP opt-out. It is only partly complete against the spec, and I did not run builds, tests or typecheck.

BSUID-first identity is entirely absent, and this is the most serious gap. The string "bsuid" appears nowhere in src, prisma, tests or scripts. Contact.phone is required and unique, and handleInboundMessage in src/lib/webhooks/processor.ts returns early when `message.from` is missing. A username user who messages without a phone would have their message silently dropped. Sending also always addresses the recipient by phone. The must-fix BSUID work is the data model, inbound ingest, outbound send and new chat, and merge on later phone.

Other must-priority items that are partial:
- Starting a new chat has no inbox UI.
- Automation is a fixed three-type rule (welcome, away, keyword) with a single text reply. It has no trigger, filter and action model, no suppression when a human owns the chat or the conversation is blocked, and no non-text actions.
- Outbound attachments use social-post size limits and accept only image and video, so documents, audio and stickers cannot be uploaded from the UI.
- Opt-out has no confirmation message and no resubscribe path.
- Search covers contact name and phone only, not message text.
- The expired status is derived and ignores the rule that a business reply never extends the window.

Missing but lower priority: teams and default team, last-assignee routing, auto-reassign on no response, saved filters, favorites, mark as unread and the unread line, @mentions, quick-reply variables, segments and profile signals, contact owner and lead stage, holiday mode, default actions and timers, reply materials, trigger quota metering, phone masking, view-only-assigned, typing indicator, agent name, audio transcription, interactive sends, multi-channel and WebChat, operator-performance analytics, per-chat export and deep links.

### MUST gaps
- **BSUID-first contact identity model (bsuid, username, nullable phone, per-identifier table)** (missing): Add Contact.bsuid (and a username/contact_identifier table), make phone nullable, unique on (tenantId, bsuid), add a migration, and store the BSUID per business portfolio. Today a user who messages via a WhatsApp username cannot be represented at all.
- **BSUID-first inbound webhook ingest (message from a username user with no phone)** (missing): A message from a BSUID-only user is silently dropped (no message, no conversation, no automation or routing). Must read the BSUID from the webhook, upsert the contact by BSUID or phone, and keep going when the phone is absent. Also handle status webhooks that identify the recipient by BSUID.
- **Outbound send, new chat and broadcasts to BSUID-only recipients** (missing): Sending must address a recipient by BSUID when no phone is stored, the audience must include BSUID-only contacts (excluding authentication templates and SMS fallback), and the new-chat entry must accept a phone or a BSUID. None of this exists.
- **BSUID and phone dedupe/merge, keep first-seen phone, per-portfolio handling** (missing): Need a merge routine (move conversations and messages, union tags and attributes) when a phone later arrives for a BSUID contact, re-link returning users by BSUID, and handle the BSUID regenerating when the user changes number.
- **Start a new chat from the inbox (phone, BSUID or existing contact, choose template)** (partial): No UI path for an agent to message a contact or number that has no open conversation (only broadcasts or the external API). Also no auto-assign to the sending operator and no opt-in check in sendTemplateMessage itself (the caller must do it).
- **Conversation statuses: open, pending, solved, expired, blocked, plus Campaign and New** (partial): No Campaign status (broadcast sends do not mark chats), no New view. Expired is derived only and is suppressed if the business replied after the customer's last message (deriveStatus `repliedAfter`), which contradicts the rule that a business reply never extends the window and that Pending chats expire. Expired is not persisted and does not appear in analytics. A customer reply does not move an Expired chat to Open as a stored change.
- **Inbox search (name, phone, message text, last-4 digits)** (partial): Message body search is not implemented (field selector missing), no phone last-4 search mode, no Instagram username. Search runs as unindexed ILIKE on contact only.
- **Outbound attachments from the inbox (image, video, document, audio, sticker) with WhatsApp size limits** (partial): No document, audio or sticker upload in the UI (the messages API only accepts them by https URL or Meta media id). Limits are not the WhatsApp ones (image 5 MB, video 16 MB, document 100 MB, audio 16 MB) so a valid-looking upload can be rejected by Meta. MOV and 100 MB video are not valid WhatsApp inputs.
- **Rule triggers (new WhatsApp message, attribute added or changed, no customer response, schedule, etc.)** (partial): No attribute-added or attribute-changed trigger, no no-response trigger, no scheduled trigger, no Instagram or Messenger trigger. There is no trigger/filter/action rule model (AutomationRule is a fixed welcome, away or keyword shape).
- **Rule filters (keyword, new chat, timestamp, contact attribute, segment, media/message type) with AND/OR groups** (partial): No fuzzy mode, no message-type or media filter, no contact-attribute, segment or contact-exists filter, no combining of conditions, no nested AND/OR groups. Non-text inbound messages are passed as empty text so media never matches anything.
- **Rule actions (send template, send media/text, route chat, start chatbot, start AI agent, send catalog, update attribute, start sequence, notify)** (partial): No template, media, sticker, catalog, route, attribute update, sequence or notification actions, no variable placeholders in the reply, no action list per rule. Chatbots and AI agent have their own independent triggers instead of being rule actions.
- **Rule execution model: ordering, all-matching-rules, suppression conditions** (partial): No drag-reorder or position, only one rule fires, no skip when the chat is assigned to a human, no skip for blocked conversations, no execution settings (prioritize quick reply, stop after buttons).
- **Keyword auto-replies (contains and exact modes, per-number scope)** (partial): No fuzzy matching, no priority tiers (exact over contains), no keyword from voice-note transcript.
- **Contact CSV import with validation, preview and consent** (partial): Column must literally be named phone (no CountryCode split and no mapping step), no choice between Update records and Skip records (existing contacts are always merged), no contact_owner, no BSUID column, imports cannot set Allow SMS.
- **Unsubscribe via STOP keyword and resubscribe** (partial): No confirmation message is sent to the customer, the keyword list is fixed (not configurable), and there is no resubscribe path: nothing ever clears optedOutAt (updateContact rejects opt-in after opt-out with 409 and no inbound START handler exists). No subscribe or unsubscribe chatbot nodes, no Stop quick-reply button helper for templates.

### SHOULD gaps
- **BSUID in public API and outbound webhook payloads, contact search, export and UI display** (missing): Add bsuid (always present) and optional waId to webhook payloads, accept BSUID as the {target} in ext v3 routes, include BSUID in the contact export, and show display name, username or BSUID in the inbox when the phone is hidden.
- **Multi-channel inbox shell (Instagram, Messenger, WebChat, RCS tabs, linked chats)** (missing): Everything: channel column, Instagram and Messenger Graph messaging ingest and send, WebChat widget plus visitor model, linked-contact merge, per-channel tabs.
- **Block / unblock conversation (spam)** (partial): src/lib/automation/engine.ts runAutomationsForInbound does not check blocked, so welcome, away and keyword rules still reply to blocked chats. No Blocked list tab in src/components/inbox/helpers.ts FILTER_TABS. Unread counts still increase and there is no notification muting. Broadcast audience (src/lib/broadcasts/audience.ts) does not exclude blocked contacts.
- **Conversation list views, quick filters and sort** (partial): Missing views: Campaigns, Last 24 Hours, Favorites, Blocked, Active, New. No sort selector (always lastMessageAt desc). Opening a conversation filtered to one view is fine, but there is no per-channel or per-number filter.
- **Advanced inbox filters (assignee multi-select, team, multi-tag, campaign, date range, reply status, attributes, mentioned)** (partial): No assignee picker in the UI, no multi-tag AND/OR, no date range, no Replied/Unreplied filter (needs a rule that bot replies do not count), no campaign, team, attribute or Mentioned filter.
- **Teams and a default team (team membership, chats visible per team, assign to team)** (missing): No teams, no default team fallback visibility, no assign-to-team in bulk, rules or chatbot assign node (src/components/chatbots/catalog.ts assign takes a user id or round_robin).
- **Auto-reassign when the assignee does not respond** (missing): No timer, no next-eligible-member logic.
- **Last-assignee routing for returning customers** (missing): No stored last assignee, no rule action, no 24h condition or fallback.
- **Keyword/rule routing actions (send notification, assign to operator or team)** (partial): Routing exists only inside chatbot flows. No keyword rule can notify operators, assign to a named operator or team, or run alongside an auto-reply. No operator notification mechanism exists.
- **Bulk actions on selected conversations** (partial): No bulk Add Notes, no Download Chats, no remove-tag control in the UI (API supports it), no assign-to-team. Cap is 100 (doc says 15), which is a deliberate difference.
- **Conversation tags (create, add/remove, filter, bulk)** (partial): Tags are free-text, created by any agent (no admin-managed tag registry or settings page, no colors), the filter takes one exact tag, there is no ext API for conversation tags (only contact tags), and no top-tags analytics.
- **Private internal notes with @mentions** (partial): No @mention parsing, no mention filter, no notifications, no read-only access for mentioned out-of-team operators, no edit or delete of notes.
- **Quick replies (canned replies) with slash insertion** (partial): No variables ({{name}}, {{phone}}, {{operator.first_name}}) substitution, no attached media, no copy action. Shared tenant-wide with no per-user personal replies, and delete is not role-restricted in the UI.
- **Unread logic (shared read state, unread line, mark as unread)** (partial): No red unread-line marker in the thread, no Mark as unread action, replying does not explicitly clear unread. Count is per conversation not per message.
- **Handling of received message types (text, media, location, contact card, order, button/list reply, reaction)** (partial): Contact cards and catalog orders become a bare '[contacts]' or '[order]' placeholder with no data; location is not rendered as a map pin; reactions are stored as normal inbound messages (they bump unread, reopen solved chats and trigger routing, where the spec says reactions never run rules); no reply/quoted-message (context) support; no voice-note transcript.
- **Response timers and default actions (customer waited too long, follow-up before 24h expiry, nudge and close inactive, no-agent-online reply)** (missing): No timers, no SLA settings, no auto-close, no follow-up before the window expires. Only a median first-response figure exists in src/lib/reports/metrics.ts.
- **Working hours configuration (per-day ranges, per number, shared across features)** (partial): Two unrelated schedules. No per-WhatsApp-number hours, no single Settings > Working hours source of truth, no overlap validation message.
- **Sequences and no-reply follow-ups** (partial): Sequences run only for Meta lead-form leads, not for arbitrary contacts, cannot be started by a rule or keyword, and there is no WhatsApp Customer No Response follow-up trigger.
- **Start a chatbot from keyword or first message** (partial): Not selectable as a rule action and not subject to rule ordering. Only the first matching published bot is started. No smart escalation, no chatbot analytics export.
- **Contact record with custom attributes and attribute management** (partial): No attribute definitions (names, types, admin management page), no per-plan attribute cap, no 256-character value limit enforced server side, no Allow SMS flag, no source field, attribute changes do not emit events or triggers.
- **Segments: custom (static and dynamic), predefined (Highly Engaged, Winback, At Risk) and profile signals** (missing): No filter-tree segments over attributes, no profile-signal rollups (last inbound, campaigns read/replied counts, link clicks), no preview, no use as a rule filter.
- **Operator roles, invitations and seat limits** (partial): Three fixed roles instead of the specialised set (Campaign, Template, Contact, Automation Manager etc.), no per-user phone masking, no view-only-assigned toggle, no display name editor for agent-name feature, no admin force-logout of another user's sessions, no teams tab.
- **Inbox analytics (status over time, operator performance, tag counts, weekly CSV email)** (partial): No operator performance table (assigned, solved, expired, missed, FRT per operator, resolution time), no ticket status breakdown or solved-by-bot split, no top-tags chart, no scheduled weekly email.
- **Public API and webhooks for inbox and contacts** (partial): No endpoints to change conversation status, assign, tag a conversation, send media or interactive messages, or send a typing indicator. No events for conversation status change, assignment, contact created, or attribute change.

### COULD gaps
- **Request Contact Info template button / collecting a phone number for hidden-phone users** (missing): No template button support and no mapping of a returned number onto a BSUID contact.
- **Saved custom filters with visibility (me, selected agents, all)** (missing): Entire feature.
- **Restrict operators to view only their assigned conversations** (missing): Per-user flag, list and detail enforcement, interaction with contact visibility.
- **Favorites (star a chat, favorites-only view)** (missing): Entire feature.
- **Typing indicator to customers and agent-name display on replies** (missing): Settings toggles, Graph typing indicator call, per-user display name prefix.
- **Interactive messages from the inbox (reply buttons, list)** (missing): No composer UI and no API for buttons or list.
- **Audio transcription of voice notes** (missing): Entire feature, including making transcripts available to keyword rules.
- **Chat export / transcripts and conversation deep link** (partial): No per-conversation Download Chat (.txt), no ZIP per-contact export by email, no Copy conversation link and InboxApp does not read a conversation id from the URL.
- **Holiday mode (auto OOO for every inbound)** (missing): Entire feature.
- **Reply materials library** (missing): Entire feature.
- **Automation trigger quota metering per plan** (missing): No count of automation fires, no per-plan limits, no 80/90/100% alerts, no billing-cycle reset.
- **Contact owner and lead stage** (missing): No contact-level owner or configurable stage list, no owner-based routing.
- **Contact deletion (soft delete with history restore) and merging** (partial): No soft delete or resurrection on re-message, no manual or automatic merge of duplicate contacts.
- **Phone number masking per operator** (missing): Per-user toggle and enforcement in inbox, search, templates, exports.
- **Click-to-WhatsApp ad referral capture and UTM attribution** (partial): Referral is not written to contact attributes (source_url, source_id), so no 'attribute added' automation and no segmenting; no click-to-chat widget with UTM context id and no Collect UTM / Update Attribute flow.

## integrations-api-onboarding
Audit of Edwyz WA against docs/wati/integrations-api-onboarding.md (read-only; 60 requirements extracted). The platform is solid on its own core: scoped API keys, a Wati-shaped v3 compat API with idempotency and paging, signed SSRF-safe outbound webhooks, a tenant MCP server with confirm-token sends, Embedded Signup, Razorpay subscriptions with GST invoices, grace and lock handling, data export and erasure, and basic role gating are all real, wired and tested. Counts: 18 built, 20 partial, 22 missing.

The biggest gaps against the source doc:
- **No native integrations.** There is no integration framework or HubSpot, Salesforce, Zoho, WooCommerce, Sheets, Zapier, Make or n8n connector. Shopify covers only abandoned-checkout recovery, with manual token paste.
- **Public API surface.** It is read-heavy for broadcasts, has no legacy V1 adapter (so existing Zapier and Make recipes break), caps template sends at 100 recipients processed sequentially, and has no channels, segments, calls or assignment endpoints. Only 5 webhook events exist, versus about 20 in the source.
- **Onboarding.** Coexistence has no history sync or message-echo handling. BSP migration relies on the generic flow. Business verification status, display-name guidance and a per-portfolio messaging limit are missing.
- **Number status.** Ban, restriction and account events are only audit-logged, so a banned number still shows as connected.
- **Throttle bug.** `src/lib/broadcasts/throttle.ts` has no `TIER_UNLIMITED` or 2,000 tier, so those numbers fall back to a 250-per-day cap. This is a real defect.
- **Billing.** There is no plan switching or proration, no add-ons or trigger metering, no API quota, no referral programme, and no plan feature gating (`Plan.features` is never read). The wallet tables (`walletPaise`, `WalletTransaction`) are dead schema.
- **Security.**
  - 2FA exists only for the platform admin, not workspace users.
  - No IP allow-list, number masking, tenant-visible audit log or chat auto-delete.
  - Roles are the 3 fixed ones, agents see all conversations, and there is no Team entity.
  - Tenant isolation is application-level only; row-level security is drafted in docs but not applied.

The MCP server has 12 tools and API-key auth only. It needs OAuth for hosted assistants such as claude.ai.

### MUST gaps
- **Scoped authorization (any-of scopes, 403 on missing scope, plan/role/tenant checks)** (partial): Scope set is coarser than Wati's (no conversations:write, payment, per-resource write scopes); no OIDC token acceptance (not needed).
- **Public REST API v3 contacts endpoints (list, get, create, update, tags, attributes)** (partial): No DELETE contact, no GET /contacts/count, no PUT /contacts/teams (no Team entity exists), no bulk attribute update across many contacts, no BSUID/username fields.
- **Public API conversations and session messaging (list conversations, message history, send text inside 24 h window)** (partial): Missing: send file / file-by-URL, interactive buttons/list/CTA messages, typing indicator, media download by message id, assign operator, change status, add/remove conversation tag (all exist in the app/MCP but not exposed on the public API). Contact-level history only (no conversation-id addressing).
- **Template listing and bulk template send via API (accepted-not-delivered semantics, per-recipient results)** (partial): Limit is 100 recipients (Wati 10,000) and recipients are sent sequentially inside the request (not queued), so large calls will time out; no get-template-by-id, no schedule endpoint, no broadcast record is created (broadcast_id is always null), only BODY variables supported (no header/button parameters), no create-template endpoint.
- **Messaging limits modelled per business portfolio with correct tier names** (partial): Real defect: Meta reports TIER_UNLIMITED (the admin helper src/components/admin/helpers.ts knows it) and the newer 2,000 tier, but neither is in TIER_LIMITS, so such numbers are throttled to 250 recipients a day in broadcasts. Limit is per number, not per portfolio (Oct 2025 rule); tests only cover 'UNLIMITED' (tests/broadcasts.test.ts).
- **Free trial with limits, reminders and read-only lock after expiry** (partial): Trial does not replicate Wati's technical restrictions (own-number only, no template approval); not needed. Trial length is a platform setting.
- **Roles and permissions (owner, admin, agent) with invites, role changes and enforcement** (partial): Only three fixed roles. No Campaign/Template/Contact/Billing manager or Developer roles, no granular permission matrix, and agents are not limited to their assigned conversations (src/lib/inbox/service.ts lists all workspace conversations regardless of role).
- **Tenant isolation and baseline application security (tenantId scoping, CSRF, CSP, SSRF guards, encrypted secrets, rate-limited auth)** (partial): Isolation is application-level only: docs/rls-draft.sql and docs/rls-plan.md are drafts and no Row Level Security is applied in prisma/migrations (grep finds no ENABLE ROW LEVEL SECURITY outside docs). One missed tenantId filter is a cross-tenant leak.

### SHOULD gaps
- **Native app-style integration framework (Integrations page, per-provider connection records with encrypted credentials, status, sync cursors)** (missing): No generic connector registry, installer UI, credential vault per provider, sync cursor tables, or plan-based integration counts. Every native integration would need this built first.
- **HubSpot native integration: two-way contact and owner sync, WhatsApp send action, conversation logging to timeline** (missing): No OAuth connect, property mapping, owner mapping, loop prevention, webhook subscription, workflow action, or timeline logging.
- **Shopify abandoned cart and checkout recovery via WhatsApp (webhooks, scheduled reminders, stop on order or opt-out)** (partial): Customer pastes an Admin API token and webhook secret by hand (src/lib/commerce/stores.ts) instead of a Shopify app install. One template with 3 fixed positional variables (first name, total, checkout URL). No RCS or SMS fallback, no per-user 4 per 24 h / 10 per 7 d marketing caps, no 'stop on customer reply', no Shopify plugin billing.
- **Shopify order lifecycle messages (order confirmation, shipped with tracking, fulfilled, COD confirm/cancel, post-order follow-up, return/exchange) and variable set** (missing): No handlers for orders/paid, fulfillments/create, tracking data, COD flow, refunds/returns; no per-event template mapping or variable catalogue (shop_name, order_number, tracking_url, etc.).
- **Meta Click-to-WhatsApp ad attribution and Conversions API feedback (Qualified Lead, Purchase)** (partial): No UI anywhere for conversion settings, dataset choice or the event log (grep for 'api/conversions' in src/components and src/app/(app) is empty), so it can only be driven by API. Conversions fire only from Lead pipeline status changes, not from 'template sent = Purchase/Qualified Lead' mapping, no purchase value for ROAS.
- **API/webhook glue recipes for Zapier, Make, n8n, Pabbly, Klaviyo and similar (documentation and compatible endpoints)** (partial): No recipe guides for any named tool. The compat API only mirrors the V3 shape; the Zapier/Make/Klaviyo recipes that Wati documents all call the legacy V1 path /api/v1/sendTemplateMessage/{number} with camelCase fields, which does not exist here, so docs/page.tsx's claim that existing recipes 'need only a new base URL and token' is not true for V1 recipes.
- **Official Zapier app, Make module, n8n community node (triggers and actions over the public API)** (missing): No app with triggers (new message, status events) or actions (send template, upsert contact); users must hand-build HTTP steps.
- **Broadcast reporting API (list, get, recipients) plus estimate-cost, overview, auto-retry, create/schedule** (partial): Public API is read-only. No POST estimate-cost, overview, enable auto-retry, or create/schedule/cancel broadcast endpoints on the public surface.
- **Legacy V1 compatibility layer (/api/v1/sendTemplateMessage/{number}, sendSessionMessage, addContact, getContacts, camelCase, tenant-in-path) so existing Zapier/Make recipes keep working** (missing): No adapter for the widely used V1 paths and camelCase fields; docs claim recipe compatibility but only V3 shape is mirrored.
- **Recipient addressing by target (phone, contact id, external_id) and BSUID/username-based identity** (partial): No channel:phone / channel:bsuid / conversation-id target forms; no bsuid, parent_bsuid or username columns; inbound webhook handler (src/lib/webhooks/processor.ts handleInboundMessage) keys everything on wa_id/phone, so username-only contacts cannot be created or messaged. Meta is rolling BSUIDs out, so this is a forward risk.
- **Webhook retry policy and failure alerting** (partial): Roughly 30 minutes of retrying then the event is dropped (Wati: every 10 min for about 24 h, 144 attempts). No email to workspace owners when an endpoint is auto-disabled; no manual 'redeliver' for failed deliveries; WebhookDelivery has no retention in RETENTION_DEFAULTS beyond webhookDeliveryDays.
- **Webhook event catalogue breadth** (partial): Missing events: new contact message, session/template message sent, template quality/category update, WABA review status, phone number quality update, account deleted/updated, chatbot triggered, CTA URL clicked, call status, contact created/updated, conversation assigned/status changed, lead created. message.received payload lacks referral/ad source and assignee; no _bsuid variants.
- **Plan-based gating of API, webhooks and integrations (Growth no webhooks, integration counts per plan)** (missing): Any plan, including trial, can create keys, webhooks and MCP access without limit; no feature-flag helper; no integration-count enforcement.
- **MCP browser OAuth sign-in (so assistants can connect without pasting an API key)** (missing): Hosted assistants that require OAuth (claude.ai custom connectors) cannot connect; API key must be pasted. Needs protected-resource metadata, dynamic client registration or fixed client, consent screen, token issuance.
- **Coexistence onboarding (WhatsApp Business app plus Cloud API) with history sync and echo handling** (partial): Only the register step is skipped. No handling of Meta's smb_app_state_sync (contacts) or history webhooks, no import of 6 months of chats, no smb_message_echoes so messages sent from the phone app never appear in the inbox, no coexistence flag on PhoneNumber, no user-facing limitation notes (no Calling/Catalog, broadcast lists read-only, display name under review).
- **Migration from another BSP / on-premises API to Cloud API** (partial): No guided migration flow (disable 2FA at old provider, same display name, expect 'registered with another BSP'), no warning that templates do not transfer, no template re-create/re-submit helper, no on-prem migration guide.
- **Meta business verification status, reminders and Simplified Partner-Led Business Verification** (missing): No verification status field, no reminder on dashboard/templates/connect pages, no explanation of the 250 unique contacts per 24 h unverified cap, no SPLBV hand-off.
- **Number connection status and quality dashboard (Connected, Flagged, Restricted, Banned) with alerts** (partial): PhoneNumber.status is only 'pending'/'connected'; account_update, ban, restriction and phone-deleted events are just audit-logged (processor.ts processAccountEvent), so a banned or restricted number still shows connected. No dedicated Channel Status page, no number rename, no QR/click-to-chat link generator, no quality or limit-change webhook to customers.
- **Multiple WhatsApp numbers in one workspace (default number, per-number scoping, add-on cap)** (partial): No numbers management page (list, set default, rename, disconnect); API without 'channel' silently uses the first number; no per-plan or add-on limit on numbers; Shopify and templates are not explicitly bound to a default number.
- **Plan upgrade/downgrade, proration and cycle switching** (missing): Customers cannot move to a larger plan mid-period; no proration, scheduled downgrade, or annual switch.
- **Two-factor authentication and new-device login checks for workspace users** (partial): Workspace owners, admins and agents cannot enable 2FA; no authenticator or email-code flow, no new-IP/device OTP, no workspace-wide 2FA enforcement.
- **Teams and routing (team entity, assign to team, round robin, availability)** (partial): Round-robin and least-busy among individual agents with working hours exist, but no teams to group agents, no team assignment on conversations/contacts/bots, no team-level routing rules.
- **Tenant-visible audit log (logins, failed logins, role and key changes, exports)** (partial): Workspace owners have no page or API to see their own audit trail; no filtering/export; failed-login rows carry no tenantId so they never appear per workspace.
- **Data retention controls: automatic purge of operational data and optional chat auto-deletion** (partial): Messages and conversations are 'kept while the workspace exists' (personal-data.ts); no per-workspace chat auto-delete setting; retention is platform-wide, not customer-configurable; backups are once nightly (Wati twice daily, 365 days) and retention length is not stated in the repo.

### COULD gaps
- **Salesforce native integration (Contacts and Leads sync, phone match key)** (missing): Entire feature absent: OAuth, field mapping wizard, Apex or Flow deployment guide, phone-keyed upsert.
- **Zoho CRM extension, LeadSquared, Kylas, Bitrix24 and other CRM connectors** (missing): No connectors, no Zoho marketplace extension, no owner-based chat routing recipe. Pipedrive-via-Zapier is only possible if a Zapier app exists (it does not).
- **Shopify customer profile sync (bidirectional, tags to shopify_<tag> attributes, historical import) and segment sync** (missing): No customer webhook subscription, historical import, tag mapping, consent mapping, or read-only segment audiences.
- **WooCommerce plugin and store events** (missing): No plugin, no plugin API key flow, no event endpoints.
- **Payments in chat: WhatsApp Pay (Razorpay/PayU), payment links in templates, payment-status webhook** (missing): No order_details/order_status/checkout_button message support, no payment configuration, no customer-facing payment-link feature, no payment events in the webhook catalogue.
- **Google Click-to-Message ads attribution and conversion upload** (missing): Whole feature absent (also needs Google whitelisting, so low priority).
- **TikTok CTWA ad connection and conversions** (missing): Absent.
- **Google Sheets integration (send templates from sheet rows, scheduled sends, automation triggers on row changes)** (missing): No add-on, no Sheets connector, no row-trigger automation, no cost preview from a sheet.
- **Calendar/booking reminders (Google Calendar, Calendly) and loyalty (Eber) recipes** (missing): Only possible via raw API; no guides or connectors.
- **Token expiry, rotation endpoint, and invalidation on password change** (missing): Keys live until manually revoked; no optional expiry, no rotate-in-place, no rotation reminders.
- **Other V3 API groups: channels list, account credits, calls, chatbots list/start, segments, sales pipeline analytics, Instagram** (missing): No /channels (needed to discover valid 'channel' phone_number_id values), no /chatbots/start, no segments/pipeline endpoints, no calls or Instagram. Leads, routing, ads, content have no public API.
- **Monthly API call quota per plan, usage meter and quota add-on** (missing): No API call counting, no plan quota, no exhaustion behaviour, no alerts.
- **Machine-readable API spec and client tooling (OpenAPI file, Postman collection, SDK)** (missing): Add an /openapi.json route generated from ENDPOINTS and a Postman export; no SDKs.
- **MCP tool breadth (workspaces list/switch, channels, webhooks, segments, template create/campaign tools, Instagram, EU endpoint)** (partial): No template creation, campaign scheduling/reporting beyond draft, webhook management, channel/number status, lead tools, workspace switching, or regional endpoint.
- **Display name guidelines and review status** (partial): No tenant-facing display-name rules, no status banner (pending review/declined), no display-name change flow, nameStatus not refreshed after onboarding.
- **Add-ons (extra seats, automation-trigger packs, AI credit packs, extra numbers, throughput) and automation trigger metering with 80/90/100% alerts** (missing): No purchasable extras, no trigger counter or overage control, no usage alert emails (AI credits do have a monthly plan allowance via aiCreditsMonthly).
- **Prepaid wallet, top-up, auto-recharge, rate card and per-message charging on SENT** (missing): No wallet, no message-cost charging, no rate card, no cost display from wallet; broadcast cost estimate exists in src/lib/broadcasts/cost.ts but is informational. Decide the billing model; if customers keep paying Meta directly, remove the dead tables.
- **Payment methods beyond card/UPI via Razorpay (PayPal, bank transfer, USD)** (missing): No PayPal, bank transfer, or USD-denominated billing for non-India customers.
- **Referral programme (credits for referrer and referee)** (missing): Absent.
- **SSO / OIDC login for the dashboard** (missing): Absent.
- **IP allow-listing for workspace logins and API keys** (missing): Absent.
- **Phone number masking per operator** (missing): Absent: no per-user toggle, no masked rendering, no last-4 search.
- **Compliance posture: privacy policy, terms, DPA, sub-processor list, trust center, pen test** (partial): No DPA download, sub-processor page, trust center or published pen test; legal text still flagged for review in docs/legal-review-notes.md.
- **Agency and multi-workspace model (one user across workspaces, parent billing, client-owned workspaces, partner portal)** (partial): No agency console, sub-account creation, parent-pays billing, partner/reseller tracking, or commissions; each workspace bills independently.
- **White-label and custom domain** (missing): Absent (Wati itself offers only subdomain/custom domain add-on).

## platform-saas
Audit of docs/PLATFORM-PLAN.md against wa/src (read-only; no tests, builds or smoke were run, so "built" means code and wiring were traced, not executed). The plan's gap table is out of date: the plan marks chatbot builder, AI agent, routing, SSE inbox, tenant MCP, commerce, CTWA ads and the campaign planner as Missing, but all of them now exist and are wired into the worker, the webhook processor or the nav. Core SaaS essentials (signup with trial, paywall, Razorpay subscriptions and webhooks, GST invoices, super admin, plan limits, API keys, signed outgoing webhooks, lifecycle emails) are built. The real gaps are:
1. Tenant users have no email-verification prompt or resend UI, no TOTP, no change-password, and no in-app audit log.
2. Two lifecycle emails (payment received, workspace suspended) have templates but no callers.
3. The ad-account plan limit is not enforced.
4. The broadcast cost estimate has an empty rate card.
5. Automation rules are only welcome, away and keyword auto-replies, with no actions library or recommended rules.
6. Not started: Instagram and Messenger, WooCommerce, Sheets, HubSpot and Zoho, a native Zapier or Make app, coexistence, the Calling API, SMS, and BSUID-first contacts.
7. Row-level security is not applied.
8. The catalog-message builders have no caller.
9. The smoke test does not cover billing, admin, automation, reports, invites or the Razorpay webhook.
10. Reports raw SQL has only mocked tests.
11. Deployment and Razorpay, Meta and GSTIN settings cannot be verified from code. The deploy docs still describe the shared VPS that the plan says is unsuitable.

### MUST gaps
- **Email verification** (partial): /api/auth/resend-verification has no UI caller. There is no in-app banner or prompt for unverified users. Nothing in the app is gated on emailVerifiedAt, so verification has no effect. A user who never received the mail has no self-serve path.
- **Razorpay subscriptions (plan sync, checkout, signature verify, cancel, reconcile)** (partial): Code is complete but untested against live or test Razorpay: keys and webhook secret are still pending, so end-to-end payment has never run. No plan upgrade/downgrade or proration path (an active subscription blocks choosing another plan until it ends).
- **GST invoices (numbering, CGST/SGST vs IGST, proforma, print view)** (partial): Invoices are HTML print only: no server-generated PDF and no emailing of the invoice. paymentReceivedTemplate exists but is never sent. Seller GSTIN and state code must be set by the owner or invoices stay proforma. No credit notes or refunds.
- **Lifecycle emails (trial 3d, 1d, ended; payment failed; quality dropped; invite; verify; reset; password changed)** (partial): paymentReceivedTemplate and workspaceSuspendedTemplate are defined and unit-tested but have no caller anywhere. Email goes nowhere until SMTP_USER and credentials are set in the environment.
- **Reports and dashboard (KPIs, charts, usage meter, CSV and JSON exports)** (partial): Raw SQL in lib/reports/metrics.ts, snapshot.ts and broadcasts/overview.ts is only tested with mocked queryRaw, never against Postgres. Smoke does not hit reports or the dashboard.
- **Cost estimate before broadcast** (partial): RATE_CARD in lib/broadcasts/cost.ts is an empty object, so the UI always shows 'rate card not configured'. The Meta price list (including the 2026-10-01 pricing change) must be entered.
- **Automation rules (trigger, filters, actions)** (partial): Only auto-reply text rules with a fixed type priority order. No general trigger/filter/action model, no actions library (tag, assign, status, webhook) and no reordering. Event triggers such as new contact or tag added are absent.
- **Compliance: data-deletion callback, retention, personal-data export, legal pages** (partial): Lawyer review of privacy and terms is still pending (Decisions item 5). No self-service account or workspace deletion by the customer.
- **Extended smoke test (billing, admin, automation, invites, reports)** (partial): Phase 1 item 2 asked for billing, admin and automation coverage. None of these appear in the smoke script, nor do reports, the Razorpay webhook, invites, forgot or reset password, or outgoing-webhook delivery.
- **Deployment on a dedicated host (separate VPS, Postgres, pm2, nginx, certbot)** (partial): Deploy scripts exist but the host decision (new VPS vs shared) is open, and actual production state, env values (Razorpay, Meta secrets, SMTP) and the passing of typecheck, tests, build and smoke could not be verified by this read-only audit.
- **Meta App Review submission readiness** (partial): Documents are prepared but the plan says the app is unpublished and the review is not submitted; use cases still need trimming and owner approval.

### SHOULD gaps
- **TOTP / two-factor authentication** (partial): Gap table lists TOTP as Built, but ordinary workspace users have no 2FA enrollment or login challenge.
- **Usage limits: AI credits and ad accounts** (partial): Plan.adAccountLimit is only listed (billing/service.ts listActivePlans, pricing) and never enforced when connecting Meta ad accounts. The 'posts' meter has no enforcement in billing/limits.ts.
- **Super admin: users (disable, enable, force sign-out, resend verification, reset link, mark verified)** (partial): No admin action to delete or anonymise a single user. anonymiseUser (lib/lifecycle/erasure.ts) is only reachable through whole-workspace erasure. No self-service account deletion either.
- **Audit log (write path and workspace-facing view)** (partial): No workspace-facing audit log page or API, so owners cannot see who did what in their own workspace.
- **Routing (round robin, least busy, working hours, per-agent caps, availability)** (partial): Plan names skill-based routing in the gap table; there is no skill or tag-based assignment. Otherwise complete.
- **Tenant-scoped MCP server** (partial): Authenticates with a wak_ API key bearer only. The plan calls for per-workspace OAuth, so connector flows that require OAuth discovery will not work. Path is /api/mcp, not /mcp. Far fewer than 58 tools. Sends need MCP_CONFIRM_SECRET set.
- **Multi-channel inbox (Instagram DMs, Messenger) and generalised Channel model** (missing): No DM ingestion, send or inbox support for Instagram or Messenger.
- **BSUID-first contact identity (phone may be null)** (missing): Contacts cannot exist without a phone number, which the plan flags as a must-fix for Meta usernames. Needs a schema migration and processor changes.
- **Click-to-WhatsApp ads attribution and Conversions API events** (partial): queueConversion is called only from lead status changes (qualified or won). No events are fired from WhatsApp conversations or purchases. There is no UI for conversion settings or event log (nothing in components or app pages references /api/conversions). Requires a connected Meta dataset.
- **Row-level security for tenant isolation** (missing): RLS is not applied. The plan requires it before onboarding external tenants at scale.

### COULD gaps
- **Recommended rules gallery** (missing): Nothing equivalent for rules.
- **WooCommerce integration** (missing): No webhook receiver or connector.
- **Catalog and product messages** (partial): The builders have no callers: not exposed in the inbox, chatbot nodes, automation or an API route, and there is no catalog sync or selection UI.
- **Native integrations: Zapier/Make app, Google Sheets, HubSpot, Zoho** (partial): No published Zapier or Make app and no Google Sheets, HubSpot or Zoho connectors; no Integration or IntegrationCredential models.
- **Coexistence onboarding** (missing): Not started.
- **WhatsApp Calling API** (missing): Not started.
- **SMS channel** (missing): Not started (listed under Later).
