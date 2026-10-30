# wa.edwyz.com — WATI-class platform: development plan

Status date: 2026-10-27. Sources: four research files in `docs/wati/`, a read-only walk through a logged-in WATI trial account (nothing sent, nothing changed), Meta app dashboard review, and the existing `wa/` codebase.

Scope rule: build **feature parity independently**. No copying of WATI branding, copy, assets, templates or code. Names, UI and text are our own.

## 1. What WATI is (observed)

Left navigation of the live app: Campaigns, Team Inbox, Contacts, Astra (AI agents for WhatsApp, web and voice), Automations (Rules, Recommended, Actions Library, Chatbots, Routing, Reply Material), Commerce, Ads, Analytics, Connectors, Developers, Settings, Academy.

- Campaigns: overview with daily Meta messaging limit meter, consecutive-days streak, messaging quality, sent/delivered/read/replied/failed funnel, calendar planner, template messages and library, WhatsApp and SMS, scheduled campaigns.
- Inbox: channels (WhatsApp, Instagram, Messenger, TikTok), chats and groups, filters All/Open/Unread/Pending.
- Automations: event rules (trigger, filters, actions; reorderable; built-in welcome and out-of-office), chatbots, routing, reply material.
- Developers: 5-step setup (connect channel, API key, test message, webhook, connect Claude/ChatGPT via Wati MCP server).
- Onboarding checklist "Setup 0/4", trial banner with days left.

Details of each area are in `docs/wati/*.md`.

## 2. Gap analysis: already built in `wa/` vs. needed

| Area | Status |
|---|---|
| Auth, sessions, TOTP, tenants, roles, invites, API keys | Built |
| Meta Embedded Signup, webhooks, token storage | Built (needs App Review before real customers) |
| Inbox: conversations, messages, notes, quick replies, 24h window | Built (polling every 2s) |
| Contacts: import, attributes, tags | Built |
| Templates: create, sync, status | Built |
| Broadcasts: queue, send, recipient tracking | Built |
| Automation rules (trigger/filter/action) | Built wave 3; wiring pending |
| Billing: Razorpay subscriptions, GST invoices, paywall, trial | Built; keys pending |
| Super admin | Built |
| Reports/dashboard | Built; raw SQL untested on Postgres |
| Webhooks out, API v1 with keys | Built |
| **Chatbot flow builder** (nodes, ask/condition/webhook/delay) | Missing |
| **AI agent (Astra equivalent)** | Missing |
| **Routing** (round robin, load based, skill) | Missing |
| **Multi-channel** (Instagram, Messenger) | Missing |
| **Commerce** (catalog, abandoned cart, Shopify/Woo) | Missing |
| **Click-to-WhatsApp ads and conversion events** | Missing |
| **Integrations** (Zapier/Make, Sheets, HubSpot, Zoho) | Missing |
| Real-time inbox (SSE/WebSocket) | Missing (polling today) |
| Tenant MCP server | Missing |
| Calling API, SMS, coexistence onboarding | Missing |
| Campaign planner calendar, cost estimate before send | Missing |

## 3. Phased roadmap (sizes: S ≤3d, M ≤2w, L ≤5w, XL >5w, one engineer-equivalent)

**Phase 1: launch-ready core (now, 2-3 weeks)**
1. Finish wave-3 wiring (trial start on signup, plan limits in invites/contacts/broadcasts, `broadcast.completed` event, billing link fixes, pricing link) — S
2. Re-run full tests, build, smoke; fix the 4 timeouts; extend smoke for billing/admin/automation — M
3. Cost estimate before broadcast, Meta limit meter, quality indicator — M
4. Onboarding checklist (connect, template, contact, campaign) and trial banner — S
5. Host decision and deploy (see §5) — M
6. Meta App Review submission (trim use cases first, user approval required) — M, mostly waiting

**Phase 2: parity on automation (4-6 weeks)**
- Chatbot flow builder with send/ask/condition/webhook/attribute/tag/assign/status/delay nodes — L
- Routing: round robin and load balance, working hours, assignment limits — M
- Rule actions library and recommended rules — M
- Real-time inbox via SSE — M
- Campaign planner calendar, scheduled campaigns, retries for per-user marketing cap — M
- Chat statuses Open/Pending/Expired/Solved/Blocked and filters — M

**Phase 3: AI and MCP differentiators (4-6 weeks)**
- AI agent builder on Claude with knowledge from website/docs, handoff to human, credit metering — L
- Tenant-scoped MCP server (see §6) — M
- Bring-your-own MCP tools for the agent — M

**Phase 4: channels and commerce (6-10 weeks)**
- Instagram and Messenger inbox — L
- Shopify and WooCommerce, catalog messages, abandoned cart (cart 30min/+6h/+24h; checkout 15min/+1h/+24h) — XL
- Click-to-WhatsApp ads attribution and conversion API events — L
- Zapier/Make app, Google Sheets, HubSpot, Zoho — L
- Coexistence onboarding, Calling API — L each

**Later:** SMS, voice agents, agency/sub-account model, SSO, white-label (WATI has none of these, so they are opportunities).

## 4. Data model additions

Chatbot, ChatbotVersion, ChatbotSession; RoutingRule, AgentAvailability; AiAgent, AiKnowledgeSource, AiConversationLog, AiCreditLedger; Channel (type, externalId) generalising Waba/PhoneNumber; Campaign (planner, schedule, retry policy); CommerceStore, Catalog, AbandonedCart; Integration, IntegrationCredential; McpConnection (tenant tools); ConversionEvent. Contact identity must be **BSUID-first**: phone may be null.

## 5. Architecture and hosting

- The VPS (about 450 MB RAM, 4.5 GB disk free, five other tenants) cannot host this. **Do not disturb the existing tenants.** Recommend a separate VPS (4 GB+ RAM) for wa.edwyz.com with Postgres, the Next app and the worker under pm2; nginx and certbot as already scripted.
- Keep Postgres queue and Next route handlers until load requires more. Add SSE for the inbox. Introduce Redis only when queue throughput or fan-out needs it.
- RLS per `docs/rls-plan.md` before onboarding external tenants at scale.
- Webhook delivery: WATI has no signing and retries every 10 min up to 144 times. We should sign (HMAC), use idempotency keys and exponential backoff, which is a selling point.

## 6. MCP / "new age" features

1. **Tenant MCP server** at `/mcp` per workspace, OAuth, scoped tools (list chats, read thread, send reply within window, send template, search contacts, create broadcast draft, read reports). Destructive and outbound actions need explicit confirmation or a draft-then-approve mode. WATI exposes 58 tools; match the useful subset.
2. **AI agent on Claude** that uses MCP tools (knowledge, CRM, booking, order lookup) with human handoff and per-message credit metering.
3. **Customers' own MCP tools** plugged into their agent (Sheets, CRM, internal APIs).
4. **Ops agents** (the existing proposal-only agents) for platform support: failed-payment follow-up, Meta quality alerts, stuck onboarding.
5. Use Meta's WhatsApp Business Tools MCP and the WAPI connector for our own number/template tasks; nothing is sent without approval.

## 7. Risks

- **Meta App Review / Tech Provider limits:** app unpublished, review not submitted; onboarding capped at 10 customers per rolling 7 days until verified. Trim permissions first.
- **Pricing:** Meta bills per message, customers pay Meta directly, so no prepaid wallet is required; Meta billing changes on 2026-10-01 affect cost estimates.
- **IP and trademark:** feature parity only; no WATI names, copy, screenshots or assets in product or marketing.
- **Compliance:** DPDP and GDPR, opt-in consent, unsubscribe, data-deletion callback (built), lawyer review of privacy and terms pending.
- **Security:** RLS deferred, CSP uses unsafe-inline, 26 findings mostly closed (see `docs/security-review.md`).
- **Scope:** WATI's team is large; Phases 2-3 give the differentiated product, Phase 4 is long.

## 8. Decisions needed from you

1. Hosting: new VPS (recommended) or other.
2. Razorpay test keys (key id, secret, webhook secret) and seller GSTIN/state.
3. `META_APP_SECRET` in the server env; permission to trim the Meta app's use cases and submit App Review; whether to set `META_ES_CONFIG_ID=1456804329669326`.
4. Plan names and prices (created in super admin).
5. Lawyer review of privacy and terms.
6. Go-ahead for Phase 2 agents (chatbot builder, routing, SSE inbox).
