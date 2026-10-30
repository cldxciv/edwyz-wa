# Edwyz Growth Platform: product spec

Status: draft v1, 2026-10-27. Extends the WhatsApp platform in `docs/PLATFORM-PLAN.md` (Phases 1 and 2 are built and live on wa.edwyz.com). This document covers the ads, lead, content and AI layer on top of it.

Items marked **VERIFY** depend on Meta's current documentation or policy and must be re-checked in the App Dashboard and the docs at the time of each App Review submission. Permission names and availability change; do not treat this file as the source of truth for Meta.

## 1. Product in one paragraph

One login and one dashboard for small and mid-size businesses and the agencies that serve them. A customer connects their Facebook Page, Instagram account, ad account, WhatsApp number and catalog once. The platform then runs the loop: AI creative, ad launch, lead capture, instant WhatsApp follow-up, human handover in the inbox, sale tracked back to Meta, and the AI learns which creative worked. Few SMB tools close this whole loop.

First customers (known): Avitara (real estate), the hotel and villa clients, Aspire.

## 2. Use cases to add to the Meta app

| Priority | Use case | In the platform |
|---|---|---|
| Core | Connect with customers through WhatsApp | Built: inbox, broadcasts, chatbots, routing, click-to-WhatsApp follow-up |
| Core | Create and manage ads (Marketing API) | Campaign Launcher |
| Core | Measure ad performance (Marketing API) | Insights and Optimiser, custom audiences |
| Core | Capture and manage ad leads | Lead Hub |
| Core | Manage everything on your Page | Content Calendar, comment moderation, Page insights |
| Core | Instagram API | Publishing, DMs, comments |
| Later | Messenger | Unified Inbox |
| Later | Ads MCP server | Optimiser agent (see 6.7 and the risk note) |
| Later | Catalog API | Catalog and product ads |
| Later | Threads API | Extra organic channel |
| Skip | App ads, Audience Network, Fundraiser, Live Video, oEmbed | Do not fit an SMB growth product |

## 3. Modules

Each module lists what it does, the main screens, and what already exists to build on.

### 3.1 Connect
One flow: Facebook Login for Business plus WhatsApp Embedded Signup. After consent the platform discovers and stores, per workspace: business portfolio, Pages, Instagram accounts, ad accounts, datasets (pixel/Conversions), catalogs, WhatsApp accounts and numbers.
- Screens: Connections page with per-asset status (connected, token expiring, permission missing), reconnect, disconnect, "what we can access" list.
- Rules: store only long-lived or system-user tokens, encrypted at rest (existing AES-256-GCM helper); show granted scopes; every asset is tenant-scoped; disconnect revokes and deletes tokens; token health check job.
- Builds on: `src/lib/onboarding`, `src/lib/crypto`, Meta webhook handling.

### 3.2 AI Creative Studio (new service)
Pipeline in section 5. Screens: brand kit, new brief, angle picker, creative grid, variant editor, policy-check results, approval link.
- Output: captions, headlines, descriptions, image and short-video variants sized for Feed, Stories and Reels.
- Text generation uses Claude. Image and video generation use a replaceable provider interface (provider is a business decision; costs are metered as AI credits). Generated assets stored in object storage, not in Postgres.

### 3.3 Campaign Launcher
Templates: lead generation (instant form), click-to-WhatsApp, traffic, boost an existing post. The user sets budget, schedule, audience, location and picks creatives; the platform creates campaign, ad set and ads through the Marketing API.
- Safety rails: nothing spends money without an explicit Launch click by an owner or admin; hard budget caps per workspace; campaigns are created PAUSED first and activated on confirmation; all actions audited.
- Special ad categories (housing, employment, credit and others) are declared at campaign creation; the UI forces the declaration for flagged industries (real estate by default).

### 3.4 Lead Hub
Lead form webhooks (`leadgen`) arrive, are fetched, deduplicated, stored as Contacts with source and campaign attribution, then an automatic WhatsApp template message is sent and a follow-up sequence starts. The lead is assigned to an agent by the existing routing module.
- Screens: leads table with source, campaign, status, response time; sequence builder (reuses chatbot and broadcast machinery); lead export.
- Consent: the lead form's consent text and timestamp are stored on the Contact as opt-in source evidence. WhatsApp marketing sends still require opt-in; utility/first-contact templates follow the template category rules.
- Builds on: contacts, templates, chatbots, routing, automation rules (`broadcast.completed` style events).

### 3.5 Unified Inbox
WhatsApp, Messenger, Instagram DMs and comments in one place. The existing inbox, statuses, routing and SSE stream gain a `channel` field.
- Messenger and Instagram DM windows differ from WhatsApp's 24 hours (**VERIFY**: current messaging windows and human-agent tag rules); the send layer must enforce per-channel rules like the existing window check.
- Comments: list, reply, hide, delete, convert to DM where allowed.

### 3.6 Content Calendar
Schedule organic posts to Facebook Pages and Instagram (and Threads in phase C). Month and list views, per-channel previews, media library, approval states, best-time suggestions from insights.

### 3.7 Insights and Optimiser
- Reads performance (spend, results, cost per result, frequency, quality ranking) on a schedule into `InsightSnapshot`.
- Proposes actions: pause weak ads, shift budget to winners, rotate fatigued creatives, suggest new angles. Default mode is **proposal only**: every change needs a human approve click. A per-workspace "auto-apply within limits" mode (for example pause ads above a cost threshold) can be enabled later, always inside hard budget and percentage-change caps, always audited and reversible.
- Closes the loop with the Conversions API for business messaging (**VERIFY**): when a lead is marked as qualified or sold in the inbox, send the event back so Meta optimises for outcomes, and feed the result to the creative learner.

## 4. Permission list per phase

Request only what the phase ships. Each permission needs a use-case description, a step-by-step screencast, and test credentials for App Review. Business Verification is already approved (see `docs/meta-checklist.md`). Advanced Access is required to serve customers other than app admins and testers.

Names below are the ones I expect; **VERIFY** each against the current permissions reference, because Instagram has two permission families (Facebook Login and Instagram Login) and Meta renames things.

| Phase | Ships | Permissions and features to request |
|---|---|---|
| A (core loop) | WhatsApp (done), Connect, Campaign Launcher (lead gen and click-to-WhatsApp), Lead Hub, Insights read | `whatsapp_business_management`, `whatsapp_business_messaging` (in review now); `business_management`; `ads_management`; `ads_read`; `pages_show_list`; `pages_read_engagement`; `pages_manage_ads`; `pages_manage_metadata` (Page webhooks); `leads_retrieval`; Marketing API access tier upgrade; Facebook Login for Business configuration; webhooks `leadgen` |
| B (create and publish) | AI Creative Studio, Page and Instagram publishing, Optimiser (proposal mode), Conversions API feedback | `pages_manage_posts`; `pages_manage_engagement` (moderation); `read_insights`; Instagram publishing (`instagram_basic` and `instagram_content_publish`, or the `instagram_business_*` family if using Instagram Login); `instagram_manage_insights`; Conversions API for business messaging dataset access |
| C (inbox and catalog) | Messenger and Instagram DMs, comments, catalog, Threads | `pages_messaging`; `instagram_manage_messages`; `instagram_manage_comments`; `catalog_management`; `threads_basic` and `threads_content_publish` |

Submission strategy:
1. Submit Phase A permissions together, after the WhatsApp review result, with one screencast per permission recorded on a working end-to-end flow. Do not submit Phase B or C features that are not yet built; reviewers reject demos of unreleased flows.
2. Submit Phase B when Creative Studio publishing works end to end on a test Page and a test Instagram account.
3. Submit Phase C last.
4. One app or two: keeping everything in "Edwyz API" means one Login for Business configuration and one set of webhooks, but a rejection on any permission slows the others. Option: a second Meta app for ads and Pages, same business portfolio. Recommendation: start with one app; split only if a review is rejected twice. Decision needed from the owner.
5. Marketing API rate limits start at the development tier; apply for standard access once real usage exists.

## 5. AI creative pipeline

1. **Input**: website URL, brand kit (logo, colours, fonts, tone, do and don't words), the offer, the goal (leads, messages, traffic).
2. **Research**:
   - Read the client's website (fetch and summarise; respect robots and rate limits).
   - Pull the client's past ad performance from the Insights API and industry benchmarks.
   - Competitor research is limited: the Ad Library API returns full data only for political and social-issue ads and for ads shown in the EU. For Indian commercial ads use website analysis, search and manual Ad Library checks supplied by the user. Do not scrape Meta.
   - Audience and location context from the client's own data.
3. **Strategy**: Claude writes 3 to 5 angles, each with hook, audience, call to action and a short rationale.
4. **Generate**: captions, headlines, images and short videos per angle, sized for Feed, Stories and Reels.
5. **Checks** (all shown to the user, none silently fixed):
   - Meta ad-policy pre-check (prohibited claims, personal attributes, before-and-after, sensational language). This is a heuristic helper, not a guarantee; Meta's own review is final.
   - Special ad categories: real estate, employment, credit and similar are flagged and the campaign is created with the declaration; targeting options are restricted accordingly (**VERIFY** per country). Avitara falls under housing.
   - AI-generated content labelling where Meta requires it (**VERIFY**).
   - Brand safety: no real people's likenesses or third-party logos generated without the client's own assets.
6. **Approve**: the client approves or edits in the app, or over WhatsApp via an approval link.
7. **Publish**: variants go out as separate ads for A/B testing; the Optimiser takes over.
8. **Learn**: winners and losers are stored per workspace and fed back into step 3 as context for the next brief.

Controls: per-workspace AI credit budget, prompt and output logging with retention limits, no customer data used to train third-party models, user can delete a brand kit and its generated assets.

## 6. Data model additions

Existing tables stay. New tables, all with `tenantId` and indexed on it (same conventions as the current schema):

- **MetaConnection**: id, tenantId, metaUserId, businessId, scopes[], tokenEnc, tokenExpiresAt, status, connectedByUserId, lastCheckedAt.
- **MetaAsset**: id, tenantId, connectionId, type (page, instagram, ad_account, dataset, catalog, waba, threads), externalId, name, tokenEnc (page tokens), status, meta (json).
- **Brand**: id, tenantId, name, websiteUrl, logoAssetId, colors, fonts, tone, bannedWords[], industry, specialAdCategory.
- **CreativeBrief**: id, tenantId, brandId, goal, offer, status, researchSummary (json), createdBy.
- **CreativeAngle**: id, briefId, tenantId, hook, audience, cta, rationale, selected.
- **CreativeAsset**: id, tenantId, briefId, angleId, kind (image, video, copy), storageKey, specs (placement, size), provider, aiGenerated, creditCost.
- **PolicyCheck**: id, tenantId, creativeAssetId, result (pass, warn, block), findings (json), checkedAt.
- **ApprovalRequest**: id, tenantId, subjectType, subjectId, tokenHash, status, decidedAt, comment, channel.
- **AdCampaign / AdSet / Ad**: id, tenantId, metaId, accountAssetId, name, objective, status, budgetPaise or minor units with currency, schedule, specialAdCategory, createdByUserId, launchedAt; Ad links to CreativeAsset.
- **InsightSnapshot**: tenantId, entityType, entityMetaId, date, spend, impressions, clicks, results, costPerResult, frequency, raw (json). Unique on (tenantId, entityMetaId, date).
- **OptimizerProposal**: id, tenantId, kind, target, rationale, payload, status (proposed, approved, applied, rejected, expired), decidedByUserId, appliedAt, revertPayload. Every applied change also writes AuditLog.
- **LeadForm / Lead**: id, tenantId, formMetaId, leadgenId (unique per tenant), fields (json), consentText, consentAt, campaignMetaId, contactId, status, assignedToId, firstResponseAt.
- **LeadSequence / LeadSequenceRun**: steps (template or flow), delays, stop-on-reply, per-lead state.
- **ScheduledPost / PostTarget**: content, media, scheduledAt, status, per-target externalId and error.
- **InboxChannel**: add `channel` to Conversation (whatsapp, messenger, instagram, comment); channel-specific identifiers on Contact (psid, igsid); `ChannelWindow` rules in code.
- **CatalogSync**: catalogAssetId, last run, counts, errors.
- **ConversionEvent**: tenantId, leadId or contactId, eventName, sentAt, datasetId, status, response.
- **UsageLedger**: tenantId, meter (ai_credits, ad_accounts, posts), amount, refId, createdAt. Plan limits extend `Plan` with adAccountLimit, aiCreditsMonthly, scheduledPostLimit, connectedChannelLimit.

Security: Meta tokens encrypted with the existing key; asset tokens never returned by any API; webhook payloads verified with the app secret; leads contain personal data and fall under the privacy policy and deletion flow (extend `docs/legal-review-notes.md` and the data-deletion handler to cover new tables).

## 7. Pricing tiers (structure, no prices)

Prices are not invented here. The super admin creates plans in the existing billing module (INR, Razorpay, GST). This section defines what the tiers should limit so prices can be set against real costs.

| Tier | For | Includes (limits to set) |
|---|---|---|
| Starter | One business | 1 workspace; WhatsApp inbox, broadcasts, chatbots; 1 Page + 1 Instagram + 1 ad account; Lead Hub; small monthly AI credit pool; N scheduled posts |
| Growth | SMB marketing team | More seats; Campaign Launcher with templates; Creative Studio with larger AI credit pool; Optimiser proposals; content calendar; Messenger and Instagram DMs (phase C) |
| Agency | Agencies with several clients | Multiple client workspaces under one agency login (new feature, see risks), per-client billing or pooled credits, white-label approval links, higher limits |

What the customer pays Meta directly, not us: WhatsApp message charges (payment method in WhatsApp Manager) and ad spend (the client's ad account). We never hold or move ad spend.

Cost drivers to price against: AI image and video generation per asset; Claude tokens per brief; storage and bandwidth for media; support load for App Review and onboarding. Meter AI usage in credits through `UsageLedger` and enforce with the existing `assertWithinLimit` pattern. Optional add-ons: extra AI credits, extra ad accounts, done-for-you creative.

## 8. Phasing, sizes and dependencies

Sizes: S up to 3 days, M up to 2 weeks, L up to 5 weeks, XL longer.

| Phase | Scope | Size | Depends on |
|---|---|---|---|
| A | Connect (Login for Business + asset discovery) M; Campaign Launcher (lead gen and click-to-WhatsApp) L; Lead Hub with instant WhatsApp follow-up M; Insights ingestion and dashboards M; Conversions feedback M | XL combined | WhatsApp review result, Meta permissions for A |
| B | Creative Studio L; Page and Instagram publishing and calendar L; Optimiser proposals L; approval links over WhatsApp S | XL combined | Phase A, image and video provider decision |
| C | Messenger and Instagram inbox and comments L; Catalog and product ads L; Threads S; Agency multi-client workspaces L | XL combined | Phase B |

The Phase 3 and 4 items in `PLATFORM-PLAN.md` (tenant MCP server, WhatsApp AI agent, Zapier and Make apps, commerce integrations) continue in parallel on the WhatsApp side. Instagram and Messenger inbox in Phase C replaces the "Instagram and Messenger inbox" line in Phase 4 of that plan.

## 9. Risks and open decisions

1. **App Review is the bottleneck.** Advanced Access for ads and Page permissions needs Business Verification (done), a screencast per permission and working test credentials. Submit in phases.
2. **Ads MCP server.** Meta's ads MCP server is available to us for our own account work. Whether it can act on behalf of many customers' ad accounts with their tokens is **unverified**; the product must work on the Marketing API directly, and treat the MCP server as optional for internal use.
3. **Money safety.** Ad spend is real money. Default to PAUSED campaigns, explicit launch confirmation, hard caps, proposal-only optimiser, full audit log and one-click revert.
4. **Special ad categories and policy.** Real estate (housing) restricts targeting; the policy pre-check can warn but cannot guarantee approval.
5. **AI content.** Labelling rules, likeness and copyright, and customer brand assets; keep the provider interface swappable.
6. **Competitor data limits** as in section 5.
7. **Privacy.** Leads and ad data extend what the privacy policy must cover; update the pages and the deletion callback before submitting Phase A.
8. **Hosting.** Image and video generation, media storage and the Optimiser need more RAM, disk and object storage than the current shared VPS. The move to an independent server should happen before Phase B.
9. **Scope.** This is a large product. Phase A alone is the first real revenue loop (ad, lead, WhatsApp follow-up); do not start B until A is used by a real customer.

Owner decisions needed: one app or two; image and video provider; whether Agency multi-client workspaces are in the first release; price points once costs are known.

## 10. Appendix: App Review package (to draft next)

For each permission in the phase table, prepare:
1. Use-case description (what the user does, why the permission is needed, what data is read or written, what is stored and for how long).
2. Screencast script: login, connect flow with the permission prompt visible, the exact feature using the permission, where the data appears in our UI, how to disconnect and delete.
3. Test user and test assets (Page, Instagram account, ad account, sample leads) and credentials in the review notes.
4. Privacy policy and data-deletion links (already live at https://wa.edwyz.com/privacy and /data-deletion), updated for the new data.
5. A checklist that every screencast shows the permission being used, uses real UI, and is under the platform's time and format rules (**VERIFY**).
