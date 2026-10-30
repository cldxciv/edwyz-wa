# Wati: integrations, public API, onboarding, billing, security, partners

Research date: 2026-10-26. Sources: public pages on support.wati.io, docs.wati.io, www.wati.io/pricing and /partners. All descriptions are paraphrased. Where a figure comes from a marketing or pricing page it is flagged. Wati's own pages disagree with each other in several places; those are listed in the last section.

Currency note: the pricing page was fetched in INR view (India). USD view and exact USD prices were not seen.

---

## 1. Integration catalogue

The Wati Integrations help collection has 85 articles: 32 ungrouped/top-level plus Shopify 31, Zoho 10, HubSpot 3, WooCommerce 3, Salesforce 2, LeadSquared 2, Klaviyo 2. Collection: https://support.wati.io/en/collections/13040201-wati-integrations

Plan gating (pricing page, https://www.wati.io/pricing/): Growth has 2 integrations from a select Commerce/CRM set; Pro has 5 including HubSpot; Business is unlimited including Salesforce. A plan-comparison page (https://www.wati.io/?p=43792) says Google Sheets, Zapier, Shopify, WooCommerce and Zoho are allowed on all plans; HubSpot and Pabbly are Pro and up; Salesforce, Twilio and "Schedule Reminders" are Business only.

Two integration architectures exist and a clone must support both:
- Native, app-style (Shopify, WooCommerce, HubSpot, Salesforce, Zoho, LeadSquared, Google Ads/Meta CAPI, Google Sheets add-on): Wati hosts the connector, there is an Integrations page in the dashboard.
- API/webhook glue (Klaviyo, Zapier, Make, n8n, Pabbly, payment gateways, calendars, Twilio, Yotpo, ActiveCampaign, Eber etc.): the customer's tool calls the Wati REST API with a bearer token, and/or Wati webhooks call the other tool. Wati documents these as recipes, not products.

### 1.1 CRM

| Integration | Data flow | Auth | Source |
|---|---|---|---|
| HubSpot (native) | Two-way contact/property sync, owner sync, WhatsApp send action inside HubSpot workflows, AI conversation logging into HubSpot timeline | Install App and Connect App flow from Wati Integrations page (method not named; HubSpot shows it under Connected Apps) | https://support.wati.io/en/articles/11463089-integrating-wati-with-hubspot |
| Salesforce (native) | Salesforce Contacts/Leads to Wati and Wati to Salesforce Contacts | OAuth plus admin-deployed Apex class, Remote Site, 2 Custom Labels, 2 record-triggered Flows | https://support.wati.io/en/articles/15552384-how-to-integrate-salesforce-to-wati-and-automatically-sync-contacts-and-leads |
| Zoho CRM (native extension) | WhatsApp send from leads/contacts/deals, workflows, two-way chats panel, auto-create CRM records on first inbound | Marketplace extension using Wati API endpoint URL plus bearer token; separate "Connect With Zoho CRM" OAuth for lead/contact automation | https://support.wati.io/en/articles/11463098-integrating-wati-with-zoho-crm-a-step-by-step-guide |
| LeadSquared | Outbound via Converse, inbound replies create leads and activities | Wati API endpoint as "username", access token as "password" in LeadSquared connector | https://support.wati.io/en/articles/11463079-integrating-wati-with-leadsquared |
| Kylas CRM, Bitrix24, Superleap CRM | Guides exist (contents not read) | not read | https://support.wati.io/en/articles/11660678-how-to-integrate-wati-with-kylas-crm , https://support.wati.io/en/articles/11463087-how-to-integrate-wati-with-bitrix24 , https://support.wati.io/en/articles/17060189-how-to-integrate-wati-with-superleap-crm |
| Pipedrive | Via Zapier only | Zapier | https://support.wati.io/en/articles/12381748-general-faqs-wati-integrations |
| Zendesk, Freshdesk | No native integration; use Pabbly or Zapier | n/a | same FAQ |

### 1.2 E-commerce

| Integration | Data flow | Auth | Source |
|---|---|---|---|
| Shopify (native app) | Store events to automated WhatsApp messages; customer profile sync both ways; segment sync into Wati; catalog checkout; analytics | Enter store domain and install the Shopify app; extra $4.99/month billed by Shopify | https://support.wati.io/en/collections/15693016-integrating-shopify |
| WooCommerce (WordPress plugin) | Store events to messages (one-way) | Plugin API Key from Wati dashboard pasted in plugin | https://support.wati.io/en/articles/11463110-how-to-integrate-wati-with-woocommerce |
| AiTrillion | Guide exists, not read | not read | https://support.wati.io/en/articles/11823126-integrating-wati-with-aitrillion |
| Meta/WhatsApp Catalog | Catalog collection (14 articles), auto checkout | WABA catalog | https://support.wati.io/en/collections/13040183-catalog |

### 1.3 Payments

| Integration | Data flow | Auth | Source |
|---|---|---|---|
| WhatsApp Pay via Razorpay or PayU (India only) | Customer pays catalog order inside WhatsApp; Wati has order_details, order_status, checkout_button template APIs (Private Beta) | Payment configuration created in Meta WhatsApp Manager, gateway account authorised there, config name pasted into Wati | https://support.wati.io/en/articles/11463135-how-to-integrate-a-payment-gateway-with-wati |
| Razorpay via Pabbly | Payment link creation then Wati template with link; "payment captured" triggers confirmation template | Pabbly connections; Wati endpoint plus token | https://support.wati.io/en/articles/11463136-integrating-wati-with-razorpay-via-pabbly |
| KPay, PayTabs, Swipe | Guides exist (not read); KPay also used for Shopify catalog orders | not read | https://support.wati.io/en/articles/12254650-how-to-integrate-wati-with-kpay , https://support.wati.io/en/articles/11463134-integrating-wati-with-paytabs , https://support.wati.io/en/articles/12129863-integrating-wati-with-swipe |
| Payment status webhook | Wati webhook to check payment status | bearer | https://support.wati.io/en/articles/11822291-how-to-use-webhook-to-check-payment-status |

### 1.4 Ads

| Integration | Data flow | Auth | Source |
|---|---|---|---|
| Meta Click-to-WhatsApp (CTWA) ads | Ad-originated conversations are tagged; Wati sends Purchase and Qualified Lead conversions back to Meta via Conversions API | Facebook Page and ad accounts connected in Ads tab (accounts from different Business Managers supported) | https://support.wati.io/en/articles/11463598-how-to-track-ctwa-ad-conversions-in-wati |
| Google Click-to-Message (CTM) ads (beta) | Conversations tagged `G-CTWA`, attributes `google_ad`, `google_ad_qualified_lead`, `google_ad_purchased`; selected conversion events sent to Google Ads | Google Ads account must be whitelisted by Google (about 1 week) and Wati support must enable beta | https://support.wati.io/en/articles/11462076-google-ctm-ads-all-you-need-to-know |
| TikTok CTWA | Ad account connection with conversion events (pricing page); guide exists | not read | https://support.wati.io/en/articles/15970572-qualify-and-route-leads-from-tiktok-click-to-whatsapp-ads |
| Facebook Messenger, Instagram, TikTok, RCS, Webchat | Omnichannel inbox channels (separate collections) | channel OAuth | https://support.wati.io/en/collections/13040187-fb-messenger-wati |

### 1.5 Marketing automation and email/SMS

| Integration | Data flow | Auth | Source |
|---|---|---|---|
| Klaviyo | Klaviyo Flow webhook calls Wati send-template API; Wati chatbot webhook node calls Klaviyo Update Profile / Create Event; Klaviyo form to Wati contact needs a Napkin.io serverless function | Wati bearer token in Klaviyo webhook header | https://support.wati.io/en/articles/11463082-integrating-wati-with-klaviyo |
| ActiveCampaign, Yotpo SMS and Email, Twilio | Guides exist (not read) | not read | https://support.wati.io/en/articles/11463069-integrating-wati-with-activecampaign-active-campaign , https://support.wati.io/en/articles/11694899-integrating-wati-with-yotpo-sms-email-app , https://support.wati.io/en/articles/11694867-how-to-integrate-wati-with-twilio |
| Eber (loyalty) | Eber member registrations and reward claims create/update Wati contacts and send WhatsApp messages | Wati Contact Management API | https://support.wati.io/en/articles/11463131-wati-eber-integration-overview |

### 1.6 Automation platforms

| Integration | Data flow | Auth | Source |
|---|---|---|---|
| Zapier | Official Wati Zapier app exists (triggers/actions not documented in help centre); documented route is "Webhooks by Zapier" POST to `/api/v1/sendTemplateMessage/{number}` | `Authorization: Bearer <token>` | https://support.wati.io/en/articles/11463107-how-to-send-whatsapp-messages-using-zapier-webhooks-and-wati |
| Make.com | Google Sheets Watch Rows then HTTP module POST to send-template | Bearer header | https://support.wati.io/en/articles/11463104-how-to-send-whatsapp-messages-via-wati-using-make-com-formerly-integromat |
| n8n | Community node `n8n-nodes-wati`: 9 triggers (all events, received, new contact, session sent, template sent, delivered, read, replied, template failed), actions for messages, templates, contacts | Wati API credential (endpoint + token); n8n webhook URL registered in Wati Webhooks | https://support.wati.io/en/articles/14638718-how-to-integrate-use-wati-with-n8n |
| Pabbly Connect, viaSocket | Used heavily as the middle layer (Calendly, Google Calendar, Razorpay) | endpoint + token | https://support.wati.io/en/articles/11937854-how-to-connect-wati-with-viasocket |
| Wati MCP server | Remote MCP, 58 tools | Browser OAuth | https://docs.wati.io/reference/mcp.md |

### 1.7 Google Sheets, calendars, other

| Integration | Data flow | Auth | Source |
|---|---|---|---|
| Google Sheets add-on ("WhatsApp Message Sender") | Sheet rows to template sends, immediate or scheduled, with cost preview; automation extension with triggers new row / column update / row update plus AND/OR filters | API endpoint + access token in sidebar fields | https://support.wati.io/en/articles/11463141-how-to-install-and-use-the-wati-whatsapp-message-sender-add-on-for-google-sheets |
| Google Sheets via Wati integration (no add-on) | Newer route | not read | https://support.wati.io/en/articles/16961365-how-to-send-whatsapp-template-messages-from-google-sheets-using-the-wati-integration-without-the-add-on |
| Google Sheets plugin in chatbot | Pro and up | n/a | plan comparison page |
| Google Calendar, Calendly | Via Pabbly: event created sends confirmation, delayed reminder re-checks event status first | Pabbly + Wati token | https://support.wati.io/en/articles/11462478-integrating-wati-with-google-calendar |
| Instagram comments/DMs, Messenger | Native channels | OAuth | collections linked above |

No ERP integration, no Stripe/PayPal checkout integration for customer payments, and no helpdesk (Zendesk/Freshdesk) native integration were found.

### 1.8 Ten important integrations: exact behaviour

**Shopify** (https://support.wati.io/en/articles/11463127-..., https://support.wati.io/en/articles/12750471-how-customer-profile-sync-works-between-shopify-and-wati)
- Install: Integration page, Shopify tile, enter store domain, Install. Message saving is blocked until the Shopify plugin charge ($4.99/month, charged by Shopify) is paid.
- Automated message events: abandoned checkout, order confirmation, order shipped (tracking URL), order fulfilled, COD order placed (confirm/cancel links), follow-up N days after order, return/exchange request.
- Variables: shop_name, first_name, last_name, order_number, total_price, discount_code, order_status_url, abandoned_checkout_url (+ partial variant for button URL suffix), tracking_url/company/number, cod_confirm_url, cod_cancel_url (+ partial), product_image_url.
- Profile sync (Growth and up): Shopify to Wati realtime for new/updated customers; one-time historical import (all, or last 1/3/6 months). Mapping: phone to phone, email to email, email marketing consent to "allow campaign", each Shopify tag to a boolean attribute named `shopify_<tag>`; the reverse works (Wati attribute `shopify_x` writes tag `x`). Phone resolution order: customer phone, default address phone, first address phone; order/checkout phone is never used. Wati to Shopify: when an unsynced contact messages in, Wati looks up by phone then email, fills gaps if found, otherwise creates a Shopify customer (marked email subscribed). Conflict resolution is not documented.
- Segment sync (Pro and Business): Shopify segments appear read-only in Wati, membership updates near real time via Shopify events, "Send campaign" from a segment preselects the audience. Requires profile sync.
- Recovery eligibility: abandoned-checkout messages need valid email, email consent and valid phone.
- Advanced automations (Business): triggers abandoned checkout, add to cart, order confirmation, shipment, fulfilment, return. Checkout recovery default: message 1 at 15 min, message 2 +1 h, message 3 +24 h; repeated events for the same checkout ID processed once per 5 min. Cart recovery default: 30 min inactivity, then +6 h, +24 h. Up to 18 messages configurable. Platform caps 4 marketing messages per rolling 24 h and 10 per rolling 7 days. Channel WhatsApp primary, RCS fallback, optional SMS second fallback; fallback can apply to one message or all remaining; per-country channel rules (RCS for US). Stop on checkout started/completed or customer reply. One active flow per user; advanced automation overrides the basic automated message if both target the same trigger. Sources: https://support.wati.io/en/articles/15129431-... , https://support.wati.io/en/articles/15129235-...
- Also: Shopify Customer Intelligence segments, Page Viewed / Product Viewed / Customer Created triggers, analytics dashboard with "Ask Wati" AI, opt-in popups, ROI tracking, COD analytics (titles only; contents not read).

**WooCommerce** (https://support.wati.io/en/articles/11463110-how-to-integrate-wati-with-woocommerce)
- Download plugin from Wati Integrations, upload/activate in WordPress, confirm Plugin API Key in plugin settings, click "Go to Wati Settings".
- One-way (store to Wati) events: abandoned cart (delay in minutes), order confirmation after payment incl. COD, order fulfilled (when admin sets Completed), post-purchase follow-up after N days, return/exchange request. Each maps to a default template such as `woocommerce_default_order_complete_v1`. No data returns to WooCommerce. Fixed variable list: https://support.wati.io/en/articles/11463111-list-of-available-fixed-woocommerce-variables-in-wati

**HubSpot** (https://support.wati.io/en/articles/11463089-..., https://support.wati.io/en/articles/12000468-..., https://support.wati.io/en/articles/12459128-...)
- Requires HubSpot Professional or above; Wati account with API access (not trial).
- Part 1: HubSpot workflow action "Send WhatsApp Message", enrolment by any contact property, personalisation tokens, template parameters comma+space separated.
- Part 2 (two-way sync): realtime once Automatic Data Sync is on; contacts created on either side appear on the other; one-time import (all or recent) via Sync Now. Fixed mapped fields: Email, First Name, Last Name, Company Name; extra properties selectable; unmatched ones create a Wati attribute of the same name; Contact Owner maps to `contact_owner` always. Custom properties need a HubSpot webhook subscription on "Property changed". Wati full name goes into HubSpot First Name unless separate attributes are mapped. Users matched by email; a default Wati user is mandatory for ownerless contacts. Owner change in Wati writes back to HubSpot. Multiple HubSpot accounts allowed, one default. Matching rule for contacts is not documented.
- Lead routing: chatbot "Assign Team" node with Round Robin plus "Direct lead to the contact owner" (Business plan); a rule on `contact_owner` change re-runs the bot; only works inside the 24 h window.
- Conversation logging (beta, Business): conversations logged to HubSpot timeline when resolved or 24 h window expires, active ones refreshed about every 3 h; AI summary, link to inbox, optional Tasks from detected action items; only post-enablement conversations.

**Salesforce** (https://support.wati.io/en/articles/15552384-..., https://support.wati.io/en/articles/16553156-understanding-wati-salesforce-synchronization)
- Business plan only; downgrade disconnects. One Salesforce org per Wati account (new connection replaces old); sandbox only after support enablement.
- Wati-side wizard: choose fields, review mapping, enable auto sync, one-time import. Salesforce-side (admin): Remote Site, 2 Custom Labels, Apex class, 2 record-triggered Flows. Standard users cannot finish it. The green "Connected" tick only proves OAuth.
- Objects: Contact and Lead. Default fields: Contact (Business Phone, Contact ID, Email, First/Last Name, Owner ID), Lead (Email, names, Lead ID, Owner ID, Phone, Status). Contact ID / Lead ID mandatory; custom `__c` fields supported.
- Salesforce to Wati: record-triggered Flow + Apex + Wati webhook on create/update. Wati to Salesforce: realtime webhook via integration gateway, no polling. Match key is phone number (update if found, else create a Contact, never a Lead; no phone means no sync). If a linked Lead is converted, Wati re-finds the Contact by phone and remaps without a duplicate. Conflict rule not documented.

**Zoho CRM** (10 articles: https://support.wati.io/en/collections/15692496-integrating-zoho)
- Zoho Marketplace extension "WhatsApp Business for Zoho CRM" (Zoho Professional or higher). Credentials: Wati API endpoint + bearer token pasted in Zoho settings. Only one active Wati integration per Zoho CRM.
- Contacts added to Wati (manual, import, campaign upload) are pushed to Zoho as Leads or Contacts per settings; Lead Source "Wati" for auto-created first-time visitors. Initial import is blocked if Zoho already has Leads/Contacts.
- Extras: workflow-triggered templates, team inbox widget inside Zoho (multiple WhatsApp lines supported), Wati-attribute sync to Zoho via Zoho Flow (webhook "New Contact Message" to Create or Update Contact on phone), chat routing by Zoho lead owner implemented as a chatbot that calls Zoho Search Records by phone: 200 returns owner then Assign Agent; 204 treated as new; 401 refreshes token (stored in a contact custom attribute).

**Zapier** (https://support.wati.io/en/articles/11463106-..., https://support.wati.io/en/articles/11463107-...)
- Pure API usage: Webhooks by Zapier POST to send-template with phone in path, JSON body with `template_name`, `broadcast_name`, `parameters[{name,value}]`; Bearer header. Parameter count must equal template variable count; names case-sensitive. An official Zapier app is mentioned but its triggers/actions are not documented publicly.

**Google Sheets** (add-on articles above)
- Sidebar add-on; auth by endpoint + token (trial users get a $0.50 wallet credit); pick phone range and map columns to template variables; send now or schedule; preview shows recipient count and cost; results visible under Campaigns. Automation extension: triggers (column update, row update, new row with all required columns filled), optional AND/OR filters (text/number/date/exists), saved as rules. Status write-back to the sheet is not described.

**Razorpay / payment gateways**
- Two models. (a) Native WhatsApp Pay (India, Razorpay or PayU): customer pays an order inside the WhatsApp chat; setup is a Meta-side payment configuration; Wati offers order_details, order_status, checkout_button template endpoints and a payment-status lookup (Private Beta). Requires catalog + auto checkout. (b) Link-based via Pabbly: webhook creates a Razorpay payment link (amount x100, expiry, callback URL), the short-link suffix goes into a template with a dynamic URL button `https://rzp.io/{{pay_link}}`; a Razorpay "Payment Captured" webhook triggers a confirmation template.

**Klaviyo** (https://support.wati.io/en/articles/11463082-..., https://support.wati.io/en/articles/11463088-...)
- Klaviyo to Wati: Flow trigger then Webhook action POSTing to Wati send-templates with `whatsappNumber` and `customParams`. Header `Authorization: <Wati token>`.
- Wati to Klaviyo: chatbot Webhook node calling Klaviyo Update Profile or Create Event (Pro/Business chatbots). Klaviyo form to Wati contact needs a serverless relay (Napkin.io) because there is no native pull.

**Google Ads (Click-to-Message)** (https://support.wati.io/en/articles/11462076-..., https://support.wati.io/en/articles/16109223-...)
- Beta, invite only. Google whitelists the Ads account (about a week); Wati supplies a technical onboarding guide and a URL to place in the CTM campaign. Conversations get tag `G-CTWA` and attributes `google_ad`, `google_ad_qualified_lead`, `google_ad_purchased`. Selected conversion events (Conversation Started, qualified lead, purchase) are returned to Google Ads; reuses the same "template sent = conversion" mapping as Meta CTWA. Click-ID handling is not described.
- Meta CTWA equivalent: in Ads tab choose the template whose sending marks a Purchase and one marking a Qualified Lead; if the conversation originated from an ad, Wati posts the event via Conversions API; optional purchase value for ROAS.

---

## 2. Public API

Docs: https://docs.wati.io/ . Each page also exists as `.md` (for example https://docs.wati.io/reference/authentication.md). Plan availability page: https://docs.wati.io/reference/endpoint-availability-by-plan.md . Public roadmap is only a link to https://feedback.wati.io/board-1/feedback (no items on the page).

### 2.1 Versions, base URL, tenant

- Host `https://live-mt-server.wati.io`.
- V3 (recommended for all new work): `/api/ext/v3/...`, no tenant ID in the path.
- V1 (legacy): `/{tenantId}/api/v1/...`; some "V2" paths `/{tenantId}/api/v2/...` are just updated variants inside V1. `tenantId` is the workspace, not a phone number.
- Differences visible in the docs: V3 uses snake_case fields and `target` addressing, 1-based `page_number`/`page_size` (max 100) and has per-endpoint scopes; V1 uses camelCase (`whatsappNumber`, `customParams`, `messageText`), phone numbers in the path, and the tenant in the path.
- Documented error envelope for V3 is claimed to be `{"ok": false, "error": {"code","message"}}`, but the per-endpoint schemas show `{code, message, timestamp}`: inconsistent.

### 2.2 Authentication and scopes

- Bearer token created in dashboard Connector > API > Create API Token. Header `Authorization: Bearer <token>`. Shown once, optional expiry, recommended rotation every 6 months, invalidated when the account password changes. `POST /api/v1/rotateToken` exists. Wati rotated its signing keys in Feb 2026; tokens of integrations idle during the "recording phase" were expired (401 until regenerated).
- Also accepted: OIDC tokens (issuance not described) which are checked against scope claims; "legacy JWT" skips scope checks.
- Scope strings seen: `api` (umbrella, accepted nearly everywhere), `contacts:read`, `contacts:write`, `contactsv3:read`, `messagetemplate:read`, `messagetemplatev3:write`, `wati_integration:write`, `conversations:write`, `payment:read`, `webhooks:read`, `webhooks:create`, `webhooks:write`. Endpoints accept "any of" a set (OR logic). Role, tenant and plan/feature checks still apply, so 403 is not always a missing scope. 403 may have an empty body.
- OpenAPI security scheme is plain HTTP Bearer; scopes are documented in prose and an `x-wati-permissions` extension. No public OpenAPI file was found.

### 2.3 Endpoint groups (V3 unless marked)

| Group | Method and path | Purpose |
|---|---|---|
| Channels | GET `/api/ext/v3/channels` | list connected channels/numbers |
| Conversations | GET `/conversations/{target}/messages` | message history |
| | POST send text / typing indicator / file (upload) / file via URL / interactive message (paths not shown) | session replies |
| | GET `/conversations/messages/file/{message_id}` | media download |
| | PUT `/conversations/{target}/operator`, PUT `/conversations/{target}/status` | assign / change status |
| | add / remove conversation tag | tags |
| Contacts | POST `/contacts`, GET `/contacts`, PUT `/contacts`, GET `/contacts/{target}`, GET `/contacts/count`, PUT `/contacts/teams`, DELETE contact | CRUD, team assignment |
| Templates | GET `/messageTemplates`, GET `/messageTemplates/{template_id}`, POST `/messageTemplates/send`, schedule endpoint | list, send bulk, schedule |
| Broadcasts (campaigns) | GET `/broadcasts`, `/broadcasts/{id}`, `/broadcasts/{id}/recipients`, `/broadcasts/overview`, POST `/broadcasts/estimate-cost`, enable auto-retry | campaign reporting and cost |
| Calls | GET `/calls`, `/calls/{id}/recording|transcript|summary`, POST `/calls/batch/recordings|transcripts|summaries` | WhatsApp Calling data |
| Chatbots (Pro+) | GET `/chatbots`, POST `/chatbots/start` | list/start flows |
| Sales analytics | get sales pipeline, get lead stages | |
| Segments | GET `/segments`, GET `/segments/{id}`, evaluate filters | |
| Instagram | GET `/posts`, `/posts/{id}`, `/posts/{id}/comments`, `/unreadCount`, `/channels/{channel}/permissions`, POST `/comments/{id}/replies`, `/comments/{id}/privateReply` | |
| Account | GET `/account/credits` | wallet balance |
| Webhooks | GET `/webhooks`, GET/PUT/DELETE `/webhooks/{id}`, GET `/webhooks/event-types` | manage subscriptions |
| V1 legacy | getMessages/{target}, getMessageTemplates, sendSessionMessage/{number} (`messageText`), sendSessionFile(+ViaUrl), sendTemplateMessage, sendTemplateMessages, sendTemplateMessageCSV, sendInteractiveButtonsMessage, sendInteractiveListMessage, sendInteractiveCtaUrlMessage, sendDirectSendMessage(s), getContacts, addContact/{number}, updateContactAttributes, updateContactAttributesForMultiContacts (Business), getMedia, rotateToken, assignOperator, assignTeam (Pro), updateChatStatus (Pro), createCustomSegment (Pro), scheduleBroadcast / deleteScheduledBroadcast, `/whatsApp/templates` create/delete, `/api/v2/webhookEndpoints` create, `/whatsApp/phoneNumbers`, `/whatsApp/businessAccounts`, `/whatsApp/messages/{phone}/{localMessageId}`, WhatsApp Pay order endpoints (Private Beta) | |

Plan gating per docs availability page: all basic send/contact/media endpoints on every plan; assignTeam, updateChatStatus, chatbots, createCustomSegment from Pro; bulk contact attribute update from Business.

### 2.4 Conventions

- Recipient addressing (BSUID doc, https://docs.wati.io/reference/bsuid-target-format.md): a `target` string whose pattern is auto-detected: phone, contact ID, BSUID, `channel:phone`, `channel:contactId`, `channel:bsuid`, or conversation ID (conversation endpoints). Path/query/body endpoints make `whatsappNumber` optional when `target` is present.
- BSUID (Business-Scoped User ID) is a stable cross-channel identifier tied to WhatsApp usernames; `phone` can now be null; contacts also carry `parentBsuid`, `username`, `contactId`.
- Pagination: V3 contacts `page_number` (1-based) and `page_size` (max 100); response `{contact_list, page_number, page_size}`. Other endpoints' pagination not documented.
- Bulk template send V3: POST `/messageTemplates/send`, body `template_name`, `broadcast_name`, optional `channel`, `recipients[]` (1 to 10,000) each `{phone_number, local_message_id?, custom_params[{name,value}]}`; response `{success, broadcast_id, error, recipients[{local_message_id, phone_number, errors}]}`. HTTP 200 means accepted into a queue, not delivered; final state comes via webhooks. V1 `sendTemplateMessages` accepts up to 1,000 contacts per call.
- Idempotency: `local_message_id` is accepted and echoed, and appears in webhooks, but docs do not say it deduplicates. No idempotency-key header documented.
- Session messages only within 24 h of the contact's last inbound message; templates required outside.

### 2.5 Rate limits and quotas

- Rate limit per 10 s (https://docs.wati.io/reference/errors.md): addContact, getContacts, getMessages 10 on all plans; sendTemplateMessage(s) 30 Growth, 60 Pro, 100 Business. Exceeding returns 429; message sends are queued after being accepted. Higher limits on request. `Retry-After` header on 429 is claimed on one page; the errors page lists no headers.
- Monthly API call quota (https://support.wati.io/en/articles/11823158-understanding-wati-apis-and-their-usage-limits): Growth 10,000, Pro 200,000, Business 20 million; resets on the 1st, no rollover; payment APIs uncapped; overage behaviour not documented; Business can buy an API quota add-on.
- Messaging throughput: Business 4k messages/min, Blitz add-on 12k/min (pricing page).

### 2.6 Error codes

200, 400 (invalid request with `code/message/timestamp`), 401 (missing/expired token, or missing "Bearer"), 403 (scope, role, tenant or plan), 404, 405, 429, 5xx (retry). Text "No Access Token provided" for a missing header.

### 2.7 Webhooks

- Subscription (dashboard): Connectors > Webhooks > Add Webhook, full URL, status Enabled, pick events, "Trigger sample callback" to test. Via API: V3 `/webhooks`, legacy POST `/{tenantId}/api/v2/webhookEndpoints` takes an array of `{phoneNumber, status (0 Disabled, 1 Enabled, 2 Defective), url, eventTypes[]}` (so subscriptions are per channel phone number). V3 update takes `{url, eventTypes, status}`. Event list is tenant-dependent: `GET /webhooks/event-types` returns strings.
- Plan limits on webhook count: Growth none, Pro 2, Business 4 (plan comparison page); pricing page says Pro "limited", Business "extensive".
- Delivery: must return HTTP 200; failures retried every 10 minutes up to 144 attempts (about 24 h); more than 100 consecutive failed jobs sets status Defective and sends an email; after the last attempt the event is dropped; retries can produce duplicates.
- Signing: none documented. No secret field, no signature header. Wati only advises validating the origin and logging payloads. A clone should add HMAC signing as an improvement.
- Event catalogue (from docs sidebar): message received, new contact message, session message sent (v1/v2), template message sent (v1/v2), sent message delivered, read, replied, template message failed, template status update, template quality update, template category update, WABA status review update, phone number quality update, WABA account deleted / content updated, phone number deleted, chatbot triggered, CTA URL clicked, call status; plus `_bsuid` variants of the first nine where `bsuid` is mandatory and `waId` optional. Event type strings seen: `message`, `newContactMessageReceived`, `templateMessageSent_v2`, `sentMessageDELIVERED_v2`, `templateReviewed`, `wabaStatusReviewUpdate`, `accountDeleted`, `accountUpdated`, `PhoneNumberQualityUpdatedEvent`, `phoneNumberDeleted`.

Payload fields of the key events:

- Message received (`eventType: "message"`): `id`, `whatsappMessageId`, `conversationId`, `ticketId`, `waId`, `bsuid`, `parentBsuid`, `assignedId`, `text`, `type`, `data`, `messageContact`, `listReply`, `interactiveButtonReply`, `buttonReply`, `replyContextId`, `senderName`, `username`, `avatarUrl`, `sourceId`, `sourceUrl`, `sourceType` (int), `channelId`, `channelPhoneNumber`, `owner` (bool), `forwarded`, `frequentlyForwarded`, `statusString`, `created` (ISO), `timestamp` (Unix), `operatorName`, `operatorEmail`.
- New contact message (`newContactMessageReceived`): `id`, `created`, `waId`, `senderName`, `sourceId`, `sourceUrl`, `sourceType`, `bsuid`, `parentBsuid`, `username`. Not fired for blocked contacts on whitelisted accounts.
- Template message sent (`templateMessageSent_v2`): `localMessageId`, `id`, `whatsappMessageId`, `templateId`, `templateName`, `created`, `conversationId`, `ticketId`, `text`, `operatorEmail`, `waId`, `type`, `statusString` (SENT), `sourceType`, `headerLink`, `headerType`, `templateContent{headerText,footerText,buttons[{index,cardIndex,type(quick_reply|url|call),text,url,targetUrl,originalUrl,phoneNumber}]}`, `channelId`, `channelPhoneNumber`, `bsuid`, `parentBsuid`, `username`.
- Delivered (`sentMessageDELIVERED_v2`): `eventType`, `statusString`, `localMessageId`, `id`, `whatsappMessageId`, `conversationId`, `ticketId`, `text` (null for templates), `type`, `timestamp`, `assigneeId`, `operatorEmail`, `channelId`, `channelPhoneNumber`.
- Template status (`templateReviewed`): `wabaId`, `templateName`, `templateId` (Meta), `watiTemplateId`, `oldTemplateStatus`, `newTemplateStatus` (0 DRAFT, 1 PENDING, 2 APPROVED, 3 REJECTED, 4 DELETED, 5 PENDING_INTERNAL, 6 DISABLED, 7 PAUSED), `channelId`, `channelPhoneNumber`.
- WABA/number events: `wabaStatusReviewUpdate{accountReviewStatus APPROVED|REJECTED|PENDING|DEFERRED, wabaId}`, `PhoneNumberQualityUpdatedEvent{phoneNumber, event, currentLimit, oldLimit (TIER_50..TIER_UNLIMITED)}`, `accountUpdated{violationInfo, banInfo, restriction_info[]}`.

### 2.8 Client libraries and tooling

No official SDK. Third-party: PyPI `wati-api` 0.2.0, Packagist `phpjuice/wati-http-client`, n8n community node `n8n-nodes-wati`. Postman collection referenced from the docs navigation (not read). Wati MCP server (https://docs.wati.io/reference/mcp.md): Streamable HTTP at `https://mcp.wati.io/mcp` (EU: `https://eu-mcp.wati.io/mcp`), browser OAuth, 58 tools grouped as workspaces (list/switch), contacts, conversations/messages/tags, templates/campaigns/credits, segments (Pro+), channels/webhooks, Instagram, chatbot drafting (rollout gated).

Other API docs help articles: https://support.wati.io/en/articles/11462487-wati-apis-overview , OTP sending recipe https://support.wati.io/en/articles/11463224-how-to-send-otp-on-whatsapp-using-wati-api , multi-number API https://support.wati.io/en/articles/11968977-wati-s-api-support-for-multiple-whatsapp-numbers (not read).

---

## 3. Onboarding

### 3.1 Prerequisites and first-run checklist (https://support.wati.io/en/articles/11462428-prerequisites-before-you-get-started-with-wati)

Before signup: a number not currently registered on WhatsApp, a display name tied to the brand, a Meta Business Manager/Portfolio (gives a BM ID), a public website showing name, offerings, contact and address (needed for verification). Checklist: choose plan, pay, receive login by email, sign in, run initial account configuration, connect number, then Meta business verification (about a week typical). Without verification: business-initiated messages to 250 unique contacts per 24 h.

Free trial: 7 days, no card; messaging only to your own number; templates cannot be submitted for approval; chatbots cannot be saved; no user management or webhooks; extensions case by case.

### 3.2 Embedded Signup (Cloud API) (https://support.wati.io/en/articles/11463151-how-to-connect-your-whatsapp-number-to-wati-via-embedded-signup-cloud-api)

Growth, Pro, Business. Needs paid plan, Meta Business Manager admin, a number not on an active WhatsApp account, ability to receive SMS/call code, desktop Chrome with no translation, and no personal payment method on the WABA (Wati bills through its own credit line).
Flow: Wati "Connect" screen collects number, display name, website (can skip), category; Facebook login; Meta dialog to enter number and choose own number versus display-name-with-virtual-number; OTP by SMS or call; choose or create business portfolio and WABA (new WABA recommended; reusing one linked elsewhere causes billing/messaging conflicts); permission grant; finish. Then business verification must complete before messaging; Wati emails on completion. Free Meta-provided numbers and skipping the website are covered in https://support.wati.io/en/articles/12332675-onboarding-with-embedded-signup-using-free-number-or-skipping-website . If OTP requests are blocked wait 12 to 24 h; IVR on the number must be off.

### 3.3 Coexistence (WhatsApp Business app + Cloud API) (https://support.wati.io/en/articles/11822421-... , https://support.wati.io/en/articles/11822402-introducing-whatsapp-coexistence , https://support.wati.io/en/articles/14818473-understanding-whatsapp-coexistence-coex-limitations)

- Requirements: number active on WhatsApp Business app v2.24.17+, Facebook Business Page admin, supported country; Growth/Pro/Business. Enabled on request through support.
- Flow: choose "Connect your WhatsApp Business app", Facebook login, enter exact number, confirm business details, choose portfolio, open Business app, tap the "Facebook Business" message, "Connect to the Business Platform", scan QR code shown in Wati, choose whether to sync past chats, grant permissions, Finish. Display name status shows "Under Review" by design.
- Sync: contacts imported (tagged "WhatsApp Business App"), 1:1 chats up to 6 months, media up to 2 weeks, last 24 h realtime, 90 days and 6 months in background (10 minutes to 6 to 8 hours). Skipping history sync cannot be undone without offboarding. Groups are not synced. Contacts sync one-way (app to Wati). Up to 4 companion devices (not Windows app or Wear OS).
- Limits: no WhatsApp Calling or Catalog; disappearing and view-once messages and live location disabled; existing broadcast lists become read-only and new lists cannot be created; connecting can remove paid Meta Verified badge. Messages sent from the app stay free; messages through Wati follow Cloud API pricing. Turn off app greeting/away messages to avoid duplicates; never add a payment method to the WABA.

### 3.4 Migrating from another provider (https://support.wati.io/en/articles/11463157-how-to-migrate-your-whatsapp-business-account-from-another-bsp-to-wati)

Disable two-step verification on the number at the old provider, start onboarding in Wati choosing new WhatsApp account, enter the same display name and number, wait for the "registered with another BSP" notice, request OTP by SMS/voice, finish. Usually minutes. Display name, quality rating, OBA status and messaging limits carry over. Templates do not transfer and must be re-created and re-approved. Eligible only if the number is on an official Meta BSP or own API integration. On-premises to Cloud API: https://support.wati.io/en/articles/11864686-migrating-from-on-premise-whatsapp-business-api-to-whatsapp-cloud-api (not read).

### 3.5 Display name and business verification

- Display name rules (https://support.wati.io/en/articles/11462959-guidelines-for-choosing-your-display-name): must represent the business/brand and match website, not a personal name, generic term, slogan, URL, emoji or extra punctuation; min 3 characters; country/department qualifiers allowed; "by Company" form for unrelated brand; every new or changed name goes through Meta review, "several days".
- Business verification (https://support.wati.io/en/articles/11462440-meta-business-verification-a-step-by-step-guide): in Meta Business Settings > Security Centre; registered versus unregistered flows; accepted documents differ by country; review from 10 minutes to 14 working days. Verification is no longer required to raise limits (see below) but still gates authentication templates, OBA and some features.
- Simplified Partner-Led Business Verification (SPLBV) (https://support.wati.io/en/articles/12554259-...): Wati submits verification to Meta on the customer's behalf; must be enabled in step 1 of Embedded Signup; customer books a call and supplies Business Info screenshot, description and documents; WABA stays on hold, no templates or campaigns, until Meta clears it.
- What Wati does for the customer: guides signup, requests permissions, creates/links the WABA under Wati's credit line, shows reminders on Quick Start/Channel Status/Templates pages, offers expert calls, SPLBV, ban appeals guidance (collection https://support.wati.io/en/collections/13040083-meta-business-verification).

### 3.6 Messaging limits (https://support.wati.io/en/articles/12458014-messaging-limit-updates-effective-oct-7-2025)

From 7 Oct 2025 limits are per business portfolio, not per number: new portfolio 250; verified with approved display name 2,000; portfolio takes the highest limit of any of its numbers; upgrades within 6 h; "Flagged" quality state removed. To scale: message 2,000 unique contacts in a rolling 30 days at High quality and use at least half the current limit in the last 7 days; from 100K to unlimited needs 500,000 unique contacts in 14 days. Authentication templates need a scaling path (verification or Quality Messaging) and a 2,000/day cap. This conflicts with the older number-status article below.

### 3.7 Number and quality management screens

- Channel Status / Settings > Channels > WhatsApp: connection status values (https://support.wati.io/en/articles/11463154-understanding-your-whatsapp-phone-number-connection-status): Connected, Flagged (quality dropped; recover to medium/high within 7 days), Offline, Pending, Restricted (limit reached; 24 h reply-only), Banned (appeal to Meta).
- Settings > WhatsApp numbers: rename, per-number message limit info and quality; webhooks for WABA events (`account_update`) and Wati's own `wabaStatusReviewUpdate`, `PhoneNumberQualityUpdatedEvent`, etc.
- Change connected number or portfolio: https://support.wati.io/en/articles/11463150-... ; click-to-chat link and QR: https://support.wati.io/en/articles/11463156-... ; link number to Facebook/Instagram pages: https://support.wati.io/en/articles/11463158-... .
- Multiple numbers (https://support.wati.io/en/articles/11561205-manage-multiple-whatsapp-numbers-in-a-single-wati-account): Business plan only, add-on per number (INR 2,499/month per pricing page), up to 25 numbers including default, all share plan limits (users, sessions, teams, credits). Templates are submitted to all numbers; campaigns/analytics per selected number; default actions, keywords, routing, chatbots apply to all unless a Rule targets a number; contacts have `whatsapp_phno` attribute; Catalog and Integrations only on the default number; users are one shared pool. Switching default number only for the default one; removing numbers or merging subscriptions needs support. User access article: https://support.wati.io/en/articles/13867076-... (not read).
- Other onboarding items: Business profile update, Quick Start page reminders, MM Lite (Marketing Messages Lite) article set, auto replies/OOO, timezone, language, notification settings, rate-card currency switch USD to INR.

---

## 4. Billing

### 4.1 Plans (pricing page; INR view; per-month amounts shown for quarterly billing)

| | Growth | Pro | Business |
|---|---|---|---|
| Price | INR 2,699 | INR 5,799 | INR 16,799 |
| Users included / extra | 3 / none | 5 / INR 1,299 per user per month | 5 / INR 2,199 per user per month |
| Astra AI agents | 1 | 2 | unlimited |
| Wati AI credits per month | 2,000 | 5,000 | 20,000 |
| Broadcasts | 15,000 per month | unlimited | unlimited, volume discounts |
| Free automation triggers per month | 1,000 | 2,000 | 5,000 |
| Integrations | 2 | 5 | unlimited |
| API calls per month | 10,000, no webhooks | 200,000, limited webhooks | 20M |
| Support | email, 24x5 | email+chat 24x7 | plus dedicated CSM |

Other capacity (plan comparison page): teams 0/10/20; forms 0/2/10; chatbots 2 on Growth, unlimited above.
Add-ons: automation triggers INR 1,000/month default (1,000 to 1,000,000), AI credits INR 1,600/month default (2,000 to 100,000), Shopify $4.99/month (billed by Shopify), extra WhatsApp number INR 2,499/month, custom domain free on Business and one-time $50 otherwise, dedicated hosting $1,000/month billed annually, API quota add-on (Business), Blitz throughput add-on. Services: dedicated onboarding (one-time, included with annual), TAM (Business annual), professional services (hourly).
A separate India-only "Wati + Astra bundle" exists with Enterprise tier, shared AI credit pool, training-data caps 5/25/50/500 MB, credits expire at renewal (https://support.wati.io/en/articles/17565154-...).

### 4.2 Mechanics

- Cycles: monthly, quarterly, annual; "save up to 10%" for longer. Billing date fixed at signup or reactivation (reactivation resets it). https://support.wati.io/en/articles/11463409-...
- Plan change: Account Details > Billing Details > Your Plan > Switch Plan; new charges effective immediately; help article says no refunds for plan changes and does not mention proration; the pricing page says upgrades and switching to annual are prorated and downgrades apply at end of cycle (conflict).
- Seats: Pro/Business only, bought in Your Plan > User add-on, billed on the plan cycle, reductions effective next cycle (https://support.wati.io/en/articles/11463415-...).
- Automation triggers: every automation run counts (keyword that starts a bot = 1, a later bot trigger in the same conversation = another); all inbound message types count; operator-started bots and API-sent templates do not; counter resets on renewal date; email alerts at 80/90/100%; when exhausted, automations stop (an "enable/disable overages" control exists but is unexplained); no per-trigger overage price published. Add-on bought by slider, billed on the base-plan frequency, but pricing page says monthly purchase is possible on annual plans (https://support.wati.io/en/articles/11462996-...).
- AI credits: shared pool, renew and expire at billing date, min purchase 2,000.
- Wallet and message charges (https://support.wati.io/en/articles/11462993-... , https://support.wati.io/en/articles/11562999 equivalents): separate prepaid credits wallet in INR (India) or USD (everyone else); minimum wallet balance INR 500 / USD 10; top up via Wallet > Buy Credits; auto recharge only in USD (not INR, RBI rules) with "balance below X add Y"; when empty, campaigns and automations stop. Charges follow Meta's per-message pricing: marketing, utility, authentication by destination country; only messages in SENT status are charged. Service (free-form) messages: free until 30 Sep 2026, then billable per message from 1 Oct 2026 with 1,000 free service conversations per WABA per month; utility templates free in-window until then, billable again from 1 Oct 2026; volume tiers for utility/authentication by country. Rate card under Wallet > Pricing Overview; usage history separates conversation-era and message-era credits. No Wati markup is stated.
- Payment methods (https://support.wati.io/en/articles/11463403-...): credit card (USD, INR; Visa/MasterCard advised in India), PayPal (USD only), bank transfer (USD, annual plans or top-ups of $1,000+), debit cards unreliable for recurring. Card is stored and auto-charged. RBI e-mandate article for India exists.
- Invoices: Billing History list with download, visible to Admin and Billing Manager only; tax treatment (GST/VAT) not documented.
- Failed payments and pause: account may be disabled (loses access to bots, templates, contacts) until payment resolved; unpaid past due date pauses automatically; reactivation manual after payment verification; retry schedule/grace period undocumented. Taking a break and reactivation articles exist (not read).
- Refunds (https://support.wati.io/en/articles/11463404-...): non-refundable except where law or written agreement requires; no credit for partial periods or plan changes; requests by email with Client ID; processed in 5 to 10 business days.
- Cancellation: no fee, no refund; pending cancellation blocks credit purchases.
- Referral programme (beta, https://support.wati.io/en/articles/13348737-...): referrer gets INR 1,500 or $25 credit per month up to three installments (cap INR 4,500 or $75 per referral); referee gets 40% off first 3 months.

---

## 5. Security and compliance

| Feature | Finding | Source |
|---|---|---|
| 2FA | Authenticator app (Google Authenticator/Authy) or emailed code; once enabled applies to all users; without it, OTP by email on login from a new IP/device, last 10 IPs remembered; recovery by password reset | https://support.wati.io/en/articles/11463220-... |
| SSO / OIDC for dashboard login | Not found. OIDC tokens are accepted by the API but issuance undocumented | docs authentication page |
| Roles | Administrator, Campaign Manager, Template Manager, Operator, Developer, Contact Manager, Dashboard Viewer, Automation Manager, Billing Manager, Trial; "Granular Roles" Pro and up; operators can be limited to their assigned conversations | https://support.wati.io/en/articles/11463020-... |
| Teams | 10 on Pro, 20 on Business | plan comparison |
| IP whitelisting | Business plan; only a feature-table entry, no setup article found | pricing page, plan comparison |
| Number masking | Business plan; per-operator toggle in User Management; shows first 3 and last 4 digits; applies in inbox, new chat picker, templates/quick replies; last-4 search still works | https://support.wati.io/en/articles/11463006-... |
| Audit logs | Logins, logoffs and failed logins, read-only; no user-facing activity log found | security overview |
| Data retention | Chats auto-deletion is a Business feature; backups twice daily kept 365 days in GCP buckets across regions; after account termination data kept up to 90 days then erased | security overview; https://support.wati.io/en/articles/13697710-... |
| Isolation and hosting | Separate database per customer, each instance in own Docker container on dedicated network; dedicated hosting with chosen location $1,000/month | security overview |
| Regional hosting | Only via dedicated hosting; MCP server has an EU endpoint | pricing, MCP doc |
| Certifications | Pen test completed Oct 2024; GDPR-compliance claim; ISO/SOC not stated on the pages read; a Trust Center at trust.wati.io is referenced (not fetched) | https://support.wati.io/en/articles/11462490-... |
| API token security | one-time display, expiry option, password change invalidates tokens, Feb 2026 key rotation | docs authentication; https://support.wati.io/en/articles/13670122-... |

---

## 6. Partner, reseller and agency features

- Partner page (https://www.wati.io/partners/): three types. Value-Added Reseller (sells and implements; lifetime commissions or discounts; PRM, certifications, priority support, MDF, free demo account, co-branded assets). Technology Partner (builds integrations; early API access and sandbox, solution architect support, co-marketing, badge tiers). Affiliate (limited-time commissions, no selling). Billing and operations managed by Wati or the partner. No commission percentages, tier thresholds, eligibility, payout schedule or white-label terms are published.
- White label: no evidence. Custom subdomain exists (https://support.wati.io/en/articles/11462978-how-to-customize-your-wati-subdomain) and custom domain is an add-on, but no brand removal or reseller-branded console was found.
- Multi-workspace: the MCP server and docs mention "workspaces" with list and switch tools, and Wati marketing pages describe agencies using multiple numbers in a single account. No agency console, sub-account billing or client-owned-workspace model is documented publicly. The roles list includes a "Tenants" menu for Administrators, whose content was not seen.
- Wati's own referral programme is covered in section 4.2.

---

## 7. Implementation implications (prioritised)

Effort: S under 1 week, M 1 to 3 weeks, L 1 to 2 months, XL over 2 months (one engineer).

1. WhatsApp Cloud API core as a Tech Provider/BSP: Embedded Signup, WABA and number lifecycle, webhook ingestion from Meta, message send/receive, 24 h window logic, template CRUD and status sync. XL. Data model: Workspace(tenant), Waba, PhoneNumber(status, quality, tier, display_name_status, coexistence flag), Template(+status history, category, quality), Message(local_message_id, wamid, status timeline, conversation_id, direction, source), Conversation(window_expires_at, assigned operator/team, status, tags), Contact(phone nullable, bsuid, parent_bsuid, username, channel_id, consent flags, custom attributes, segments).
2. Team inbox with operators, teams, assignment, roles and routing. L. Tables: User, Role(+permissions), Team, Assignment, Tag, chat visibility flag, mask_phone flag.
3. Public REST API v3 with scoped tokens, per-plan rate limiting and monthly quota. M. Tables: ApiToken(hash, scopes[], expires_at, last_used), UsageCounter(period, calls), RateLimitConfig per plan. Include `target` addressing, `local_message_id` idempotency (enforce uniqueness, which Wati does not document), page-based pagination, 429 with Retry-After.
4. Outbound webhooks. M. Tables: WebhookEndpoint(channel/number, url, status, events[], secret, failed_count), WebhookDelivery(event_id, attempts, next_attempt_at). Retry every 10 min up to 144, mark defective after more than 100 consecutive failures with email; add HMAC signature.
5. Campaigns/broadcasts with templates, scheduling, estimate-cost, auto-retry, CSV send. L. Tables: Campaign, CampaignRecipient(status), Segment(filter json), Schedule.
6. Billing: plans, subscriptions (monthly/quarterly/annual), add-ons, seats, trial, payment gateway, invoices, wallet ledger with per-message charge. L to XL. Tables: Plan, Subscription(cycle, renews_on, status), AddOn, SubscriptionItem, Invoice, PaymentMethod, WalletAccount(currency), WalletTransaction(type, message_id, rate_card_id), RateCard(country, category, effective_from), UsageMeter(automation_triggers, ai_credits, api_calls). Charge only on SENT status.
7. Automation engine: keyword rules, chatbot flow builder, sequences, trigger metering, webhook node. XL. Tables: Rule, Flow(versions), FlowRun, TriggerEvent(count source).
8. Native commerce integrations: Shopify (L), WooCommerce plugin (M). Tables: IntegrationConnection(provider, tenant, credentials encrypted, status), ExternalCustomerLink, SyncCursor, AutomationRule with delays/stop conditions/channel fallback. Shopify needs an app listing, webhooks (checkouts, orders, customers, segments) and a billing hook.
9. CRM integrations: HubSpot (L), Salesforce (L), Zoho (M). Two-way sync needs field-mapping tables, owner mapping, loop prevention and a match-key policy.
10. Ads attribution: store CTWA referral fields on first message; Meta CAPI sender; Google CTM later. M. Tables: ConversationOrigin(source_id, ctwa_clid, ad ids), ConversionEvent(sent_at, status).
11. Ecosystem glue: Zapier/Make/n8n apps and Google Sheets add-on. M each. Reuses the public API.
12. Security: 2FA (S), roles/granular permissions (M), IP allow-list (S), number masking (S), audit log (M), chat auto-delete (S), SSO (M, Wati lacks it, so optional differentiator), data export/termination flow (S).
13. Number quality and limits dashboards: tier, quality, restrictions webhooks. S to M.
14. Coexistence and BSP migration flows. M. Mostly Meta flows plus history-sync ingestion.
15. Partner/reseller: referral credits (S), agency workspaces with sub-accounts and parent billing (L), partner portal (L). Wati offers little here, so scope is your choice.
16. MCP server on top of the API. S to M.
17. Wati AI/Astra equivalent (agents, credit pool, voice). XL; defer.

---

## 8. Details that are easy to get wrong

- Session versus template: free-form only inside 24 h of the last inbound; never count template sends as session. Template send HTTP 200 means queued, not delivered.
- Messaging limit is per portfolio since Oct 2025, shared by all numbers, and "Flagged" no longer lowers the tier; older help pages still describe per-number tiers and Flagged. Do not model limit per number only.
- Billing under Wati's WABA credit line: customer must not attach their own payment method in Meta (double charging); charge wallet only for SENT messages; prices change on 1 Oct 2026 (service messages and in-window utility become billable; 1,000 free service conversations per WABA per month).
- Wallet currency is fixed by region (INR for India, USD otherwise); auto-recharge is USD only because of RBI e-mandate rules.
- Coexistence: history sync is a one-shot choice at onboarding; groups, Calling and Catalog are unsupported; broadcast lists become read-only; contact sync is one-way; verified badge can be lost.
- Migration: templates do not move; 2FA must be off; display name must match.
- BSUID: phone can be null, so every foreign key and send path must work with bsuid-only contacts; run `_bsuid` and legacy webhook versions in parallel during migration.
- Legacy versus V3 field names differ (camelCase vs snake_case); keep an adapter if you want compatibility with existing Zapier/Make recipes that call `/api/v1/sendTemplateMessage/{number}`.
- Template variable counts must exactly equal the template's placeholders; names are case-sensitive.
- Webhooks: retries mean duplicates, delivery events can arrive before the "sent" event, no signature exists upstream, and status field `0` means Disabled in requests but "active" in one response description.
- Trigger metering: all inbound media types count; API-sent templates and manually started bots do not; reset on the renewal date, not calendar month.
- Salesforce match key is phone only; inconsistent phone formats create duplicates. Normalise to E.164 everywhere.
- Shopify tag sync is bidirectional through a `shopify_` prefix; phone from orders is ignored; recovery messages need email consent as well as phone.
- Multi-number accounts share users, credits and bot limits; integrations and catalog bind to the default number only.
- Token invalidation on password change and silent expiry after key rotation caused real outages for customers.

---

## 9. Unverified or unclear

| Item | Page missing it |
|---|---|
| Official Zapier app triggers/actions and auth | https://support.wati.io/en/articles/11463106-... (high level only) |
| Whether `local_message_id` deduplicates sends; any idempotency key | https://docs.wati.io/reference/messagetemplate_sendtemplatemessages.md |
| Webhook signing or secret | https://docs.wati.io/reference/introduction-1.md , updatewebhook.md , createwebhookendpointv2.md |
| Pagination on endpoints other than contacts; cursor support | https://docs.wati.io/reference/introduction.md |
| `Retry-After` and rate-limit headers; behaviour when monthly quota is exhausted | https://docs.wati.io/reference/errors.md , https://support.wati.io/en/articles/11823158-... |
| Complete webhook event-type strings and a few payload schemas (chatbot triggered, CTA clicked, call status, template quality/category) | docs.wati.io webhook pages not individually read; `listwebhookeventtypes` returns tenant-specific list |
| OIDC token issuance; full scope list | https://docs.wati.io/reference/authentication.md |
| OpenAPI file and Postman collection contents | docs.wati.io (not fetched) |
| Official SDKs | none found |
| Public roadmap items | https://docs.wati.io/reference/public-roadmap.md (only links to feedback.wati.io) |
| Proration rules for upgrades, seats, add-ons | https://support.wati.io/en/articles/11463420-... (silent) versus pricing page (says upgrades prorated) |
| Taxes (GST/VAT) on subscriptions and wallet; invoice line items; payment processor name | https://support.wati.io/en/articles/11463410-... , 11463404 |
| Failed-payment retries, grace period, dunning cadence | https://support.wati.io/en/articles/11463417-... |
| USD plan prices and monthly/annual price points; trial credit amount | https://www.wati.io/pricing/ (INR quarterly only; Google Sheets article says $0.50 wallet credit) |
| Automation trigger overage price and overage-disable control | https://support.wati.io/en/articles/11462996-... |
| Dedicated server availability (Growth/Pro vs Business only) | https://support.wati.io/en/articles/11462992-... (self-contradictory) |
| SSO, audit log UI, IP whitelisting setup, encryption, ISO/SOC certifications, data-residency regions, DPA, sub-processors, retention for live chats | https://support.wati.io/en/articles/11463219-... , 13570880, 11462490; trust.wati.io not fetched |
| Partner commissions, tiers, eligibility, payouts, white-label | https://www.wati.io/partners/ |
| Agency / sub-account model, "Tenants" admin menu | no page found |
| Message markup over Meta rates | https://support.wati.io/en/articles/11561662-... |
| Shopify/HubSpot/Salesforce conflict resolution when both sides change a field; sync latency SLAs | respective sync articles |
| Contents of 50+ articles only seen as titles (Shopify automation/analytics/Customer Intelligence set, Kylas, Bitrix24, Superleap, AiTrillion, KPay, PayTabs, Swipe, Twilio, Yotpo, ActiveCampaign, Calendly, Eber detail, LeadSquared templates), plus Campaigns (57), Chatbots (27), Automation (18), Astra (70), WhatsApp Calling (18), Catalog (14), Team Inbox (29) collections | not in this brief's scope or not read |
| Google CTM click-ID (gclid) handling | https://support.wati.io/en/articles/11462076-... |
