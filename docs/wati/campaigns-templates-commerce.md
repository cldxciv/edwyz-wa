# Wati: Campaigns, Templates, Flows, CTWA Ads, Catalog/Commerce, Pricing - Feature Inventory

Research date: 2026-10-26. Method: public pages only (support.wati.io, docs.wati.io, wati.io/pricing) via WebFetch/WebSearch. Descriptions are paraphrased. Note that "Broadcasts" were renamed "Campaigns" in the UI; old URLs/endpoints still say "broadcast". Several help articles are partial or contradict each other; those points are flagged in section 9.

Source key: SC = https://support.wati.io/en/articles/ (append the id-slug), DOC = https://docs.wati.io/reference/.

---------------------------------------------------------------------------------------------------

## 1. Plans and quotas (as published)

From https://www.wati.io/pricing/ (prices per month billed quarterly, INR shown on the fetched page):

| Item | Growth | Pro | Business |
|---|---|---|---|
| Price | 2,699 INR | 5,799 INR | 16,799 INR |
| Users included | 3 (no extra) | 5 (+1,299/user) | 5 (+2,199/user) |
| Campaign (broadcast) volume | 15k/month, standard rates | Unlimited, standard rates | Unlimited, volume discounts |
| Free automation triggers | 1,000 | 2,000 | 5,000 |
| API calls/month | 10k, no webhooks | 200k, limited webhooks | 20M, extensive webhooks |
| Throughput | not stated | not stated | 4k msgs/min; "Blitz" add-on 12k msgs/min |
| Astra AI agents / AI credits | 1 / 2,000 | 2 / 5,000 | unlimited / 20,000 |

Add-ons: automation triggers 1,000 INR/mo (1k-1M selectable); AI co-pilot credits 1,600 INR/mo; Shopify integration $4.99/mo; extra WhatsApp number 2,499 INR/mo each. Message fees are pass-through per message, vary by marketing/utility/authentication and recipient country code; full rate card is a linked file (not scraped).

Feature-to-plan placement collected from help articles (the "Compare plans in detail" matrix itself could not be fetched; see section 9):

| Feature | Plan stated |
|---|---|
| Single-send campaigns | Growth, Pro, Business |
| Drip campaigns | all plans |
| Auto-retry (campaign) | Growth, Pro, Business (pricing page lists "smart retries" under Pro) |
| Predefined + custom segments | Pro, Business |
| Campaign Calendar | Pro, Business |
| Click tracking on URL button | Pro, Business |
| Limited-time-offer template | Pro, Business |
| Carousel / "advanced templates" | Pro (pricing page) |
| WhatsApp Flows | Growth 0, Pro up to 2, Business up to 10 flows |
| Funnel + Replied/Ignored/Clicked retarget | Pro, Business (Growth gets Opened only) |
| Authentication templates | Growth, Pro, Business |
| CTWA conversion tracking + Ads analytics | Business, or Ads add-on for Growth/Pro |
| Auto follow-ups for CTWA leads | Ads add-on, Business |
| TikTok CTWA | Pro, Business |
| Meta and Google ad account connection | Business |
| SMS fallback (Twilio) | Business |
| RCS fallback | beta, selected Business customers |
| Shopify ROI tracking, Cart/Checkout recovery rule | Business (Shopify) |
| Shopify segment sync | Pro, Business |
| Catalog auto-checkout / WhatsApp Pay (India beta) | Pro, Business |
| Campaign API cancel scheduled | Pro, Business, Enterprise |

---------------------------------------------------------------------------------------------------

## 2. Campaign (broadcast) lifecycle

### 2.1 Create campaign form
- What it does: One wizard under Campaigns > Create New Campaign. Fields in order: campaign name; type (Single send or Drip); message template; optional reply handling; audience; send now or schedule; Publish.
- Operation: choose an approved template, define audience, publish. A "guided setup" variant adds a CSV import step and a recommended starter template, and lets the campaign be prepared while the template is still awaiting Meta approval (it auto-sends once approved).
- Data: campaign {id, name, type, channel_id, template_id, fallback_templates[], status, scheduled_at, created, last_updated}; statistics counters (below).
- Meta/Cloud API: sends template messages via the /messages endpoint, one per recipient; business-initiated, so needs an approved template and an opt-in.
- Plan: all (see section 1 for segments).
- Sources: SC 11462957-how-to-send-your-first-campaign; SC 15165095-send-your-first-whatsapp-campaign-with-guided-setup; DOC campaigns_getbroadcast.md.

### 2.2 Audience selection
Sources of audience, per the create article:
- Import new list (CSV): drag-drop, choose whether existing contacts are updated or left alone, map CSV columns to contact attributes, confirm. Country codes are mandatory or delivery fails ("Insufficient credits"/invalid number errors).
- All Contacts.
- Filters: stack "Contact Attributes" filters ("Add another filter +").
- Segments: predefined and custom (Pro/Business).
- Shopify segments synced from Shopify (read-only) with a "Send campaign" shortcut that pre-selects members.
- Drip audiences: filters, an existing segment, a custom segment or CSV; static segments do not enrol contacts added after launch, dynamic ones do.
- API: recipients array (1 to 10,000 per request) with phone_number, optional local_message_id, custom_params[{name,value}]; also a CSV endpoint (sendTemplateMessageCSV) where template and broadcast name go in the query string.
- Data: Contact {id, wa_id, name, phone, opted_in, allow_broadcast (the "Allow Campaign" attribute), allow_sms, segments[], custom_params{}, channel_type}.
- Sources: same SC article; SC 11660835 predefined segments; DOC messagetemplate_scheduletemplatemessages.md; DOC evaluatesegment.md.

### 2.3 Segments
- Predefined (Pro/Business): Highly Engaged (3+ campaigns interacted with in last 90 days via read, click or quick reply), Winback (last WhatsApp message to business 30-90 days ago), At Risk (no message to business in 90 days), All Valid Contacts (valid phone number). Note "last message to the business" is the definition given for winback/at risk.
- Custom segments: Active (dynamic, recomputed as data changes) or Static (snapshot). Filter on contact attributes and "profile signals". Max 20 custom segments per account. "Preview contacts" before saving. Large segments compute asynchronously and email the user with a launch link. Segments are also usable as a filter in automation rules. Can be cloned, renamed, edited.
- Profile signals (auto-tracked engagement fields): contact info (last updated, source, channel type, first conversation date); messages (last from contact, last read by contact, last reply, last from business); campaigns (last received, plus counts received/read/replied over 7/30/90 days); links (last clicked, counts over 7/30/90 days); calls (last inbound/outbound, last answered); templates (last template used, type, sent date); CTWA (last ad source URL, first business reply to last CTWA message, last CTWA message date). Operators depend on signal type: date (before/after/on, day-in-last, day/month recurring) and numeric comparisons. Signals can be compared to each other.
- API: list/get segments, evaluate filters without saving (POST /api/ext/v3/segments/evaluate with groups[], pageNumber, pageSize<=100; the group schema is not documented), create custom segment (v1, Pro/Business).
- Sources: SC 14192386, 11660835, 15374013, 16097214 (compare signals), 15165886 (API); DOC evaluatesegment.md, listsegments.md.

### 2.4 Template selection and variable mapping
- Placeholders in the body (`{{name}}` or numbered `{{1}}`) are filled per recipient from the matching contact attribute; for API sends from custom_params. Missing attributes produce errors "Missing customer attributes" or "Missing information" (dynamic header needs a value). Parameters must not contain newlines, tabs or 4+ consecutive spaces.
- Personalized media: a template with "different header" ticked takes a URL variable (e.g. `{{qr_url}}`); each contact needs its own URL value set manually or via bulk import. Text stays the same, only the media varies. URL must be publicly fetchable and crawler-accessible.
- Reply actions at campaign creation: for each Quick Reply button on the template, pick an action: an automation rule, a "send message" action or a chatbot flow (or create new). When a button is tapped, only that action runs; Rules, Keyword Actions and Default Actions are skipped for that message. Replies are tracked in analytics against the action.
- Sources: SC 11463450, 14119674, 11463486, 11463447.

### 2.5 Scheduling and time zones
- UI: choose "send immediately" or pick date/time; Scheduled Campaigns tab lists pending ones; can edit (the article says message content; the calendar article says name and date/time) or delete before send (delete is permanent). No documented time-zone selector in the UI (one search snippet said GMT+7 for a legacy article; unverified).
- Campaign Calendar (Pro/Business): monthly view, click a date or "+", statuses Sent (read-only), Scheduled (edit name/time, remove), Wati Recommended (AI-suggested, max 1 per day, needs a business website configured, up to 2 URLs). "Build with AI" costs 1 AI credit and returns 3 generated templates.
- API: `POST /api/ext/v3/messageTemplates/schedule` with template_name, broadcast_name, scheduled_at (ISO 8601 in UTC), recipients (1-10,000), optional channel (sender number). Legacy v1: scheduleBroadcast and DELETE deleteScheduledBroadcast/{id}. 200 means accepted, not delivered; delivery is learned from webhooks (Template Message Failed, Delivered, Read, Reply).
- Recurring broadcasts: NOT supported. The FAQ says use single scheduling, auto-retry, or Sequences/drips instead.
- Sources: SC 11463443, 15562690, 11883362; DOC messagetemplate_scheduletemplatemessages.md.

### 2.6 Throttling, tier limits, and quotas
- Meta messaging limit (tier) = unique customers you may start business-initiated conversations with in a rolling 24h: 250 (new), 2,000 (verified business or high-quality 2,000 uniques in 30 days), 10,000, 100,000, unlimited. Tier-up rules (quality-dependent): 1,000 uniques in 7 days to 10k, 5,000 in 7 days to 100k, 500,000 in 14 days to unlimited. Limits are per business portfolio (shared across numbers) since Oct 7, 2025; replies inside a customer-initiated 24h window do not count. Meta sets it; viewable in Settings > Channels > Messaging limit.
- Per-user marketing cap: Meta restricts marketing templates to a given user (FAQ says max 2 marketing messages per user per 24h from one business without a reply; a separate undisclosed cross-business cap applies; the FAQ says Meta has relaxed this). Contacts hit by it fail with "Message undeliverable as Meta has restricted it for higher quality messaging - retry again in a few days"; Wati excludes users already at the limit and does not charge for them. About 1% of users sit in a Meta experiment that blocks marketing templates (code 130472).
- Wati-side: Growth 15k marketing campaign messages per calendar month (resets monthly); Business throughput 4k msg/min (12k with Blitz). Per-second sending rate/queueing internals are not documented. Campaigns need a minimum credit balance ($10 on USD plans per the FAQ).
- Cross-country restriction (code 130497) for Brazil/Indonesia: needs a 2K tier and 30 days high quality.
- Sources: SC 11463452, 11938457, 11463455, 11463447, 15932753; pricing page.

### 2.7 Cost estimate before send
- API `POST /api/ext/v3/broadcasts/estimate-cost` takes {templateId, contactIds[]} (min 1) and returns {estimatedCost, currentCredit, currentWelcomeCredit, result, isRequestSucceeded, failedDetail}. Welcome credit (free trial credit) is tracked separately from paid credit. The formula is not published; it is evidently sum over recipients of (rate for template category x recipient country calling code) in wallet currency, compared against wallet balance. The UI "insufficient credits" error is the same check.
- Wati charges when status is SENT, not on delivery; failed messages are not charged; in drips, credits are charged only after a message is successfully sent.
- Sources: DOC estimatebroadcastcost.md; SC 11883362; SC 11561662; SC 14734248.

### 2.8 Tracking: delivery, read, reply, click, failure
- Per-campaign counters: total_recipients, pending, queued, sending, sent, delivered, read, replied, failed, stopped.
- Per-recipient (API): id, contact_id, contact_name, contact_phone, status, failed_code, local_message_id, message_id (Meta wamid), custom_params, created. Statuses are not enumerated in the docs; page size max 100.
- Dashboard (Campaigns > Overview): Spend, Audience size, Delivered, Read, Engagements (replies + link clicks); filters by date range and by category (Marketing/Utility/Authentication); toggle metrics. Funnel (Pro/Business): total audience (includes failures) > sent > delivered > read > engagements; counts per delivery in range, so a contact in 3 campaigns counts 3 times. Delivery-failure breakdown + failure report export. Per-campaign CSV export including attribution data.
- Campaign list statuses (UI filter): Pending, Processing, Completed, Stopped.
- Reads/clicks depend on WhatsApp read receipts (users can disable them, so read counts under-report) and click tracking redirect (2.9).
- Sources: SC 11463454, 11463453, 11463448 (history); DOC campaigns_getbroadcast.md, campaigns_getbroadcastrecipients.md.

### 2.9 Retargeting
From any campaign's insights or the funnel: Opened (all plans), Replied / Ignored / Clicked (Pro/Business) segments to launch a follow-up campaign. "Ignored" is defined inconsistently (did not engage vs. did not open).
- Source: SC 11463454.

### 2.10 Failed message handling, pausing, and template pacing
- Common failure causes and their text/codes (see SC 11463447, 11938457): invalid number/no country code; restricted for higher quality (131049 family); experiment (130472); spam rate limit hit; account locked/restricted; template content errors; payment-method error (incomplete onboarding); template not found/paused/disabled (new templates may need 15-30 min to sync); 132001 translation missing; 132005 translated text too long; 132012 parameter format mismatch; 131053 media upload error; generic user error; insufficient credits; "Tier limit reached". Media rules: 8-bit RGB(A) images, H.264+AAC video with one audio stream, PDF only for document headers.
- Template pacing (Meta slows/pauses new or unrated templates): triggered by template paused or error 132015. Wati automatically sets the campaign to Stopped, shows a banner, a Delivery Status column, and emails admins/campaign managers. Recovery: "Retry with new template" creates `<name>_retry` with only the failed contacts as audience; or "Improve template quality with AI" duplicates and rewrites the template for resubmission.
- Sources: SC 11463447, 11938457, 14119866.

### 2.11 Auto-retry ("smart retries")
- What: a campaign toggle "Auto-retry campaigns" plus an end date; it resends only marketing-template messages that failed on the first attempt because of Meta's per-user marketing limit. Retries stop after the end date. Growth/Pro/Business. New accounts must wait 15 days before using retry. The API sets either `retryDays` (integer 1-7, counted from broadcast end) or `retryUntil` (UTC ISO date), never both: `POST /{tenantId}/api/v1/{broadcastId}/retry`.
- A Wati blog claims retries run every 24h up to 7 days (secondary; the 24h cadence is not confirmed in help docs). Drip step retries: up to 7 days per step, inter-step delays preserved, advised off for time-sensitive sends.
- Data: Campaign.autoRetry {enabled, until}; per-recipient attempt count/last attempt timestamp (inferred).
- Sources: SC 11462957-how-to-send-your-first-campaign; SC 11883362; DOC enable-auto-retry.md; SC 14734248.

### 2.12 Fallback channel (RCS/SMS)
- "Enable Fallback" on a campaign: if WhatsApp delivery fails, send via an RCS template (beta, select Business customers) or an SMS template (needs Twilio integration, Business plan). For OTPs, a WhatsApp OTP template is mapped to an SMS OTP template and SMS is sent when WhatsApp fails. API exposes fallback_templates[{templateId,type,providerType}].
- Source: SC 11462957-how-to-send-your-first-campaign; SC 11463224; DOC campaigns_getbroadcast.md.

### 2.13 Drip campaigns / sequences
- A series of template messages with a delay between steps (e.g. one day after previous). Audience: filter, segment, or CSV. Start now or at a chosen date/time. Option "Stop campaign on customer reply". Contacts who opt out or leave a segment stop receiving. Static segment: no late enrolment. Dynamic segment: new matches enter unless the drip has finished all steps. Created from the Campaigns page or the Automations Action Library ("Sequences" are the automation-triggered variant; drips are not started by rules). Tracked: list with status, progress, next send date; per-step Read, Ignored, Replied, Failed, Clicked; delivery logs with failure reasons.
- Data: Drip {steps[{template_id, delay}], audience_ref, stop_on_reply, auto_retry}; Enrollment {contact_id, drip_id, current_step, next_send_at, state}.
- Source: SC 14734248-how-to-create-drip-campaigns-in-wati.

### 2.14 Opt-in and opt-out
- Opt-in methods recommended (chat button, website form, SMS, missed call, IVR, in-person, checkout) and keep a record of when/how. Shopify opt-in popups exist in the Shopify app. No evidence Wati stores an explicit consent log beyond contact fields (`opted_in` field exists in the contact DTO).
- Opt-out: add a "Stop" quick-reply and/or footer text. Reply keyword STOP/Unsubscribe sets contact attribute `allowCampaign` (UI "Allow Campaign") to FALSE and sends a confirmation; START sets it TRUE. Implemented as an automation rule "Unsubscribe from campaign" (trigger: new message; filter: exact keyword match; action: update contact attribute) - built in for new accounts, manual for old ones. Template keyword and rule keyword must match.
- Sources: SC 11463444, 11463449.

### 2.15 Other campaign features
- Catalog messages as campaigns (SC 11463493, see section 6).
- Shopify audience and ROI tracking (section 7).
- Role restriction: only Administrators and Campaign Managers access campaigns.
- Search/filter/history (SC 11463453, 11463448).
- Session vs template message difference (SC 11463456): templates required outside the 24h customer window; session (free-form/interactive) messages only inside it.
- Meta country restriction pages (SC 15932753), best practices: delivery rate (SC 16644842): 100% delivery is unrealistic; quality High/Medium/Low (Wati shows Green/Yellow/Red); "Flagged" number has 7 days to recover before limits drop.

---------------------------------------------------------------------------------------------------

## 3. Template management

### 3.1 Creation form
- Fields: name (lowercase letters, digits, underscore; unique; deleted name not reusable for 30 days; guideline says up to 512 chars); category (Marketing/Utility/Authentication); language (one language per template; each translation submitted separately with matching placeholders); type (text-only or rich); header (none / text / media image-JPEG-PNG, video-MP4, document-PDF; media hosted at URL, optionally a variable for per-send media); body (max 1024 chars including substituted values; variables `{{1}}` numbered or named `{{customer_name}}`; cannot start/end with a variable or be too variable-heavy; no newlines/tabs/4+ spaces inside parameter values); footer optional (about 60 chars); buttons; sample values required for variables.
- Save as Draft (editable) or Save & Submit. Approved templates cannot be edited; make a new one. Changing parameter count in WhatsApp Manager breaks sends. Submit only through Wati (WM-created templates do not appear in Wati). Limits: 100 template creations per hour per account; 250 templates per WABA (unverified parent) or 6,000 (verified).
- Rich limits: images 5 MB or less; carousel images JPG/PNG. Header/footer 60 chars; "Visit Website" dynamic URL button 2000 chars.
- Creation can be AI-assisted ("Enhance with AI"/"Fix with AI", beta, English/Portuguese/Spanish). API creates via `POST /{tenantId}/api/v1/whatsApp/templates` with type, category, subCategory, buttonsType, buttons[], header, body, footer, elementName, language, customParams, creationMethod (0 human, 1 AI, 2 both).
- Sources: SC 11463495, 11463458, 11463469, 11463461, 12033067, 12059867; DOC createwhatsapptemplatev1.md.

### 3.2 Template statuses
Wati UI: Draft, Pending (read-only, 30 min to 24h), Approved, Rejected, Deleted, Pending Internal (trial accounts, awaiting admin approval). Webhook `message_template_status_update` carries Meta status changes. Actions: View, Edit (drafts), Submit, Delete (name unusable), Copy. Export/import as JSON between Wati accounts (imports arrive as Draft, must be resubmitted). Templates can be searched and filtered by status. Meta statuses you also need to model: PAUSED, DISABLED, IN_APPEAL, REJECTED (not all surfaced in Wati docs).
- Sources: SC 11463482, 11463480, 11463460.

### 3.3 Categories and recategorization
- Utility: transactional, tied to a specific customer action/order; no promotion. Authentication: OTP only. Marketing: everything else; recommended opt-out quick reply.
- Meta may change category on review (from 9 April 2025 category check precedes content review); the template may be billed at the new category rate. Appeal within 60 days of creation or category-update date. Reclassification triggers: promotional wording, mixed operational + promotional, generic surveys, promotional variable values, periodic re-reviews. Misusing Marketing/Utility for identity verification risks a 7-day then 30-day Utility restriction.
- Sources: SC 11463465, 11463498, 12320234, 15932488, 11463458.

### 3.4 Buttons
- Call-to-action: up to 2 types: Visit Website (static or dynamic URL; only the final path segment may be a variable), Call Phone (number without +), WhatsApp Voice Call.
- Quick Reply: up to 3, each 20 chars max; payload is the keyword text, which fires rules, keyword actions or chatbots (case-insensitive match) or a direct campaign reply action.
- Copy Offer Code (coupon): marketing only; code is copied/pasted at checkout; whether per-contact codes are possible is not documented.
- Flow button: opens a WhatsApp Flow (section 4).
- Combination rules between button kinds are not documented in Wati articles.
- Sources: SC 11463467, 11463491, 11463486.

### 3.5 Header media and dynamic media
JPEG/PNG image, MP4 video, PDF document. Per-send URL variable allowed. URL must be public and crawlable. Common failure: Meta cannot download media. No file size stated except images 5 MB.
- Source: SC 11463469, 11463450.

### 3.6 Carousel
Marketing template type "Carousel": a body message plus scrollable media cards, each with a media header and URL button. Card count is contradictory (intro says up to 10; steps and FAQ say 5; Meta allows up to 10). Other providers state card body 160 chars and 2 buttons per card (not verified for Wati). "Sample cards" preview switch.
- Source: https://support.wati.io/l/en/article/6ev6vk1gfu-how-to-create-a-carousel-template-message

### 3.7 Limited-time-offer (LTO) template
Pro/Business. Fields: image or video header, body up to 600 chars, offer text up to 16 chars, expiry date/time, coupon code, website link (click tracking optional). Expiry fixed after send; reuse the template to update expiry per send. No auto expiry reminder. Meta capability: LIMITED_TIME_OFFER template component.
- Source: SC 11463477.

### 3.8 Authentication (OTP) templates
Preset body containing the verification code placeholder, optional security disclaimer, optional expiry line (minutes), required button either Copy Code or One-Tap Autofill; no URLs, media or emojis; parameter 15 chars max; locked format; cannot be edited. Sent via `POST /api/v1/sendTemplateMessage`. Requires an approved scaling path and a daily limit of at least 2,000 business-initiated conversations (per messaging-limit article). Optional SMS fallback via Twilio (Business). Growth/Pro/Business.
- Sources: SC 11463224, 11463452, 11463458.

### 3.9 Click tracking (link tracking)
Toggle on a Visit Website button (Pro/Business). The link is rewritten to a Wati tracking domain (default https://whatsapp.wati.io, or a custom subdomain such as company.whatsapp.wati.io), recording clicks per contact; results appear in Campaign Overview and "View insights"; feed segments ("Clicked", profile signal "last link clicked" and 7/30/90-day click counts). Shopify buttons use partial URL variables prefixed with `https://s.wati.io/`.
- Sources: SC 11463471, 15374013, 11463118.

### 3.10 Library templates, quality score, pausing, analytics
- Library templates: no Wati help article found; Meta's template-library capability exists (see WAPI/Meta docs), but Wati's own coverage is unverified.
- Quality: number-level quality (High/Medium/Low shown as Green/Yellow/Red) and template pacing/pausing handled as in 2.10. No template-level quality score or per-template analytics columns are documented (the template list shows name, category, language, last updated, status only). Template performance is derived from campaign analytics (including category filter and coupon template analytics).
- Sources: SC 11463482, 11463455, 14119866.

---------------------------------------------------------------------------------------------------

## 4. WhatsApp Flows (in-chat forms)

- What: custom input forms inside WhatsApp for lead capture, surveys, feedback, bookings. Builder under Automation > WhatsApp Flows with two starters (Lead Generation, Feedback Form), blank, or duplicate; drag-and-drop; multiple screens (add/reorder/delete); dropdown with up to 200 options, single select, optional required; Date Picker (Pro/Business). Draft or Publish; published flows cannot be edited.
- Sending: as a template (select published flow, set button text, submit for approval; usable in campaigns and Template API) or in a chatbot via the WhatsApp Flow node (header, body, button text).
- Data captured: a contact attribute `<FlowName>_content` with all submitted data as JSON, plus one attribute per field. Visible in Team Inbox custom parameters and the Chatbot Builder. Mapping into other contact attributes is not documented.
- Requirements: verified business portfolio, messaging limit of at least 2,000, high quality (display name approval no longer needed). Quotas: Growth 0, Pro 2, Business 10.
- Meta capability: WhatsApp Flows (Flow JSON, flow button in template or interactive message, nfm_reply webhook response).
- Source: SC 11463180-how-to-create-and-use-whatsapp-flows-in-wati (plus the older/newer variants, which disagree on the messaging-limit requirement).

---------------------------------------------------------------------------------------------------

## 5. Click-to-WhatsApp (CTWA) ads and attribution

### 5.1 Identification
- CTWA conversations get a CTWA tag in Team Inbox (G-CTWA for Google, T-CTWA for TikTok), a CTWA inbox filter, and contact attributes `source_id` (ad ID) and `source_url`. Google adds `google_ad`, `google_ad_qualified_lead`, `google_ad_purchased`; TikTok adds `tiktok_ad_id`, `tiktok_ad_qualified_lead`. Segment filter example `source = CTWA`.
- Meta capability: referral object on the first inbound message (source_id, source_url, ctwa_clid) - Wati docs do not mention ctwa_clid.
- Sources: SC 11463601, 15969878, 11462076, 15970572.

### 5.2 Connecting ad accounts
Ads tab > Connect to Facebook (choose page and ad accounts); accounts from multiple Business Managers can be connected (SC 14284454). Business plan connects Meta and Google ad accounts. Campaign objective must be Engagement with Messaging Apps > WhatsApp; page WhatsApp number must match Wati's. New ads can take 24h to sync. CTWA vs CTWP (click-to-WhatsApp posts) is explained in SC 14515725 (not read).

### 5.3 Conversion events
- Meta: Wati sends events through the Conversions API (server-to-server): Purchase (with optional value for ROAS) and Qualified Lead. Triggered not by keywords but by sending a chosen template to a contact whose conversation began from a CTWA ad ("Track Purchases"/"Track Leads" select the template). Best practice: reuse the order-confirmation template; send at least 10 purchase signals to Meta.
- Google CTM: whitelisted Google Ads account (about 1 week), same conversion templates, events sent to Google Ads as conversion actions; GCLID not mentioned.
- TikTok: ad group optimization goal Conversations plus a Message Event Set; qualified lead via the "Track qualified leads" template; events appear in TikTok Events Manager within about 30 minutes; Wati does not yet show TikTok messaging ad reporting.
- Sources: SC 11463598, 11865448, 11462076, 15970572.

### 5.4 Ads analytics (Business, or add-on)
Ads > Click to WhatsApp Ads > Ads analytics: ad spend, CPC, qualified leads, purchases, cost per qualified lead (CQL), cost per purchase (CPP), ROAS, carts received (if catalog used); channel comparison across Facebook, Google, TikTok; funnel conversion rate, average time to convert; export (names and phone numbers of converted leads).
- Source: SC 11463601.

### 5.5 Auto follow-ups
Ads > Conversation Events > "Boost conversations with auto follow-ups": one template for all follow-ups, set interval, up to 3 follow-ups per unresponsive lead, stops on reply, qualified lead or purchase. Ads add-on or Business.
- Source: SC 11823189.

### 5.6 Free window for ad leads
Entry-point rule: if the business replies within 24h of the first message, template and service messages are free for 72 hours (changing to 7 days effective 28 Sept 2026); chatbot sessions triggered by CTWA messages are still billed. Wati notifies when the window opens and nears expiry.
- Sources: SC 11463597, 11561654.

---------------------------------------------------------------------------------------------------

## 6. Catalog and commerce

### 6.1 Catalog setup and sync
- Prereq: Meta Commerce Manager catalog (sources: Google Sheets or Shopify), connected to the WABA, Wati's Business ID assigned as partner with Manage Catalog permission, Catalog ID pasted into Wati's Commerce page. India sellers need origin_country, importer_name, importer_address; all items need an image; Sheets need google_product_category.
- Sync: manual "Sync" button only pulls newly added products and sets (existing items unchanged); 5-minute cooldown between syncs. Shopify-managed catalogs update automatically on the Shopify side.
- Variants: grouped under one listing (Google Sheets grouping by group id; Wati docs do not name the field). Sets are product groups created in Commerce Manager, usable as messages.
- Sources: SC 11463056, 11463057, 11463059, 11463063, 11463062, 11463052.

### 6.2 Sending catalog content
- Catalog template (Marketing category, type Catalog; "Sync catalog" refreshes the image) usable in campaigns; in chatbots via Catalog > Sets node and Products node; via keyword actions. Content comes straight from the WhatsApp catalog and is not editable in Wati. Counts of products per message are not stated by Wati (Meta caps multi-product at 30 items across 10 sections for session messages, and 5 items in a template per Meta docs, unverified here).
- Customer cart: "View sent cart" message can trigger an automated reply (SC 11463051).
- Sources: SC 11463493, 11463053, 11463064, 11463051.

### 6.3 Orders and checkout
- Orders page (real-time): customer name, WhatsApp number, cart date/time, items, cart value; orders are not editable; no statuses documented. Order details can be pushed to Google Sheets (SC 11463054).
- Auto checkout (Beta, India, Pro/Business): each cart message triggers automated address collection (WhatsApp address form) and payment; gateways Razorpay and PayU configured through a WhatsApp Manager payment configuration (WABA ID, config name, industry/purpose codes); methods include UPI and cards. Chatbot-built checkout also exists (SC 11463060). Shopify catalog checkout variants: WhatsApp Pay and KPay; orders paid via WhatsApp Pay are not auto-synced to Shopify.
- Meta capability: Order messages / payment configuration (India only, Razorpay/PayU, order_details and order_status messages).
- Sources: SC 11463058, 11463061, 11463050, 12606453, 11463126, 15942608.

---------------------------------------------------------------------------------------------------

## 7. Shopify and WooCommerce

### 7.1 Shopify automated messages
- Variables available in approved templates: shop_name; first_name, last_name; order_number, total_price, discount_code, order_status_url; abandoned_checkout_url (body) and abandoned_checkout_url_partial_variable (button); tracking_url/company/number; cod_confirm_url, cod_cancel_url (and partial variants); product_image_url (order confirmation, abandoned cart, COD only). Scenarios: abandoned cart, order confirmation, shipping update, COD confirm/cancel (24h without reply counts as unconfirmed). Also coupons and opt-in popups.
- Sources: SC 11463118, 11463114, 11463120, 11463119, 11463123, 11463116.

### 7.2 Abandoned cart / checkout recovery timing logic
Two built-in automation rules (Shopify advanced automations, Business):
- Add-to-cart (Cart Recovery): cart activity within 30 minutes is grouped into one cart; if no checkout starts in that 30-minute inactivity window it is abandoned. Message 1 at 30 min after last cart update, message 2 six hours after message 1, message 3 twenty-four hours after message 2 (default 3, configurable to 18). Shopper must be identifiable (logged in, opted in this session, or cookie-recognised). Template variables: names, up to 3 cart items (then "+X more"), item count, total, cart URL, images.
- Abandoned checkout (Checkout Recovery with WhatsApp): message 1 at 15 minutes after abandonment, message 2 one hour after message 1, message 3 24 hours after message 2; duplicate events for the same checkout ID processed once per 5 minutes. Eligibility: reached Shopify checkout, entered email and phone, has Shopify email marketing consent, did not pay. Another article's example uses a 5-minute delay (configurable).
- Common: stops on checkout completion, purchase or optional reply; remaining messages cancelled on purchase. Channel order WhatsApp, then RCS, then SMS fallback (apply to failed message only or all remaining). Separate rules by customer country. Counts toward marketing limits of 4 per rolling 24h and 10 per rolling 7 days. Advanced Automations take priority over simple Automated Messages; one active flow per user. Triggers also include order confirmation, shipment, fulfilled, returned, page viewed, product viewed, customer created.
- Legacy "automated message" abandoned cart: cart recovery fires 30 minutes (marketing page).
- Metrics: Abandoned Carts, Messages Sent, Carts Recovered, Recovery Rate, Order Value Recovered.
- Sources: SC 15129431, 15129235, 15846612, 14014202, 11463128, https://www.wati.io/en/shopify/.

### 7.3 Shopify data sync
- Customer profile sync: phone (customer.phone, then default address phone, then first address; order phone not used), email, email marketing consent mapped to Wati "Allow campaign", Shopify tags become boolean attributes prefixed `shopify_` and sync back. Real time both ways; historical import of all or last 1/3/6 months; Wati to Shopify creates/enriches customers on new inbound contacts, matching phone then email.
- Segment sync (Pro/Business): Shopify segments read-only in Wati, near real time, with member list and synced attributes and "Send campaign".
- Customer Intelligence segments, analytics dashboard, "Ask Wati" AI queries, Product Viewed / Page Viewed triggers exist (titles only).
- ROI tracking (Shopify Business plan): attribution window default 2 days, extendable to 10 days, from message receipt or click; metrics spend, recipients, orders, CTA clicks, revenue, ROI %; export has order numbers, items, dates, discount codes; at least 2 contacts needed; per-template toggle.
- Sources: SC 12750471, 12750482, 11463115, 15798460, 11463451 (manual Shopify Flow to POST /api/v1/addContact).

### 7.4 WooCommerce
Plugin with API key from Wati Integrations. Triggers: abandoned cart (minutes delay configurable), order confirmation (incl. COD), order fulfillment (marked Completed), post-purchase follow-up (set days after), return/exchange. Default template names woocommerce_default_abandoned_recovery_v1, _order_complete_v1, _order_fulfilled_v1, _follow_up_v1, _refund_v1. Fixed and predefined variables lists exist (SC 11463109, 11463111).
- Source: SC 11463110.

---------------------------------------------------------------------------------------------------

## 8. Message pricing

- Model: per-message pricing since 1 July 2025 (replaced 24h conversations). Each marketing, utility, authentication template is billed separately; free-form service messages inside the 24h window are free until 1 Oct 2026, after which they become billable per message with 1,000 free service conversations per WABA per month; utility templates inside the window were free until 30 Sep 2026 and become billable again 1 Oct 2026. Volume tiers (utility/authentication) kick in above country thresholds (e.g. 25M/month India, 80k North America/Other) - requires contacting support.
- Rate changes occur on quarter start dates (examples: 1 Oct 2025, 1 Jan 2026). Rates depend on recipient country calling code and category.
- Wallet: "Wallet" icon > Buy Credits; minimum balance 500 INR on INR plans, $10 on USD plans; campaigns and automations stop at zero credits; rate card in Wallet > Pricing Overview; credit history separates conversation vs message credits; auto-recharge is a separate article (not read); wallet hidden while a cancellation is pending. Welcome credit is tracked separately. Third-party sources claim Wati adds roughly 20% on Meta rates (unverified).
- Charged on SENT, not on delivery; blocked per-user-limit messages are not charged.
- Sources: SC 11561662, 11561654, 11660815, 11462999, 11883362.

---------------------------------------------------------------------------------------------------

## 9. Unverified or unclear (with page missing it)

1. Full "Compare plans in detail" matrix: wati.io/pricing links to it, the fetched page did not include it and the wati.io/?p=49786 copy returned 404. Plan placement of carousel, sequences, smart retries is inferred.
2. Cost formula and its UI display: DOC estimatebroadcastcost.md lists only the response fields; no help article shows the estimate screen or breakdown; rate card is a Google Drive file (not read).
3. Time zone behavior of scheduled campaigns: SC 11463443 and SC 15562690 do not mention it; API is UTC; one stale snippet says GMT+7.
4. What can be edited on a scheduled campaign: SC 11463443 (content only) vs SC 15562690 (name, date/time).
5. Auto-retry cadence (24h) and per-attempt rules: DOC enable-auto-retry.md only gives retryDays (1-7) / retryUntil; cadence claim is from a wati.io blog snippet.
6. Per-user marketing cap: "2 per 24h" in SC 11938457 / 11463455 but the same pages say it is being relaxed; no 7-day number given.
7. Exact queue/throttle rate per second, batch sizes, retry backoff: no page.
8. Recipient status enum and failed_code catalog: DOC campaigns_getbroadcastrecipients.md.
9. Template quality score per template, pause/unpause flow, library templates, template analytics: SC 12033067 and SC 11463482 contain none; no Wati library article found.
10. Carousel card count (10 vs 5), card body/button limits, plan: carousel article inconsistent.
11. Button combination rules, Flow button, per-contact coupon codes: SC 11463467, 11463491.
12. Segment filter operators/AND-OR schema and evaluate API group schema: SC 14192386, DOC evaluatesegment.md.
13. WhatsApp Flows to contact-attribute mapping and requirement conflicts (1,000 vs 2,000 limit): SC 11463180.
14. Catalog: item count limits per message, MPM naming, order statuses, payment status webhooks, WhatsApp Pay countries: SC 11463053, 11463058, 12606453; Razorpay article is video-only.
15. Cart-recovery template categories and number of reminders in SC 15846612; plan requirement beyond "Business".
16. Exact opt-in consent storage: SC 11463444 does not describe opted_in.
17. Currency handling beyond INR/USD wallets; tax; auto-recharge: SC 11462999.
18. Articles not read: RCS campaigns (12538877), CTWP vs CTWA (14515725), Google CTM creation (16109223), ad accounts from other BMs (14284454), COD setup (11463119), third-party checkout fix (11463112), interactive messages (11463463), session expiry (11463459), supported languages (11463484), custom segments API (15165886), compare signals (16097214).
19. Third-party mirrors (withone.ai) were seen only in search snippets; their paths were not treated as authoritative.

---------------------------------------------------------------------------------------------------

## 10. Implementation implications (prioritised)

Effort: S under 1 week, M 1-3 weeks, L 3-8 weeks, XL over 2 months, for one engineer.

1. Template CRUD + Meta sync (L). Form for name/category/language/header/body/footer/buttons/variables with sample values; create/list/delete via Cloud API; webhook `message_template_status_update` and quality/category change webhooks; statuses Draft/Pending/Approved/Rejected/Paused/Disabled/Deleted; import/export JSON; hourly creation limit guard. Data: Template {id, waba_id, wa_template_id, name, language, category, sub_category, status, rejected_reason, quality, components JSON, variables[{index|name, example, source_attr}], created_by, parent_template_id, last_synced_at}.
2. Contacts, attributes, consent (M). Contact {phone_e164, wa_id, bsuid, name, attributes JSON, opted_in, allow_campaign, source, created}; ConsentEvent {contact_id, type, channel, evidence, at}; STOP/START keyword rule that flips allow_campaign. Country-code validation on import.
3. Campaign engine (XL). Campaign {id, name, type single|drip, template_id, audience_ref, scheduled_at (UTC), tz, status pending|processing|completed|stopped, auto_retry_until, fallback, cost_estimate, created_by}; CampaignRecipient {campaign_id, contact_id, params JSON, status queued|sent|delivered|read|failed|stopped, wamid, error_code, attempts, next_retry_at, sent_at, delivered_at, read_at, replied_at}; queue workers honoring per-phone throughput, tier limit (rolling 24h unique count), per-user marketing cap handling, template-paused stop (error 132015), insufficient balance check, pacing. Webhook consumer updating statuses and idempotent counters.
4. Wallet and message billing ledger (L). Wallet {currency, balance, welcome_credit, min_balance, auto_recharge}; RateCard {country_code, category, rate, effective_from, currency, version}; LedgerEntry {wallet_id, campaign_id|message_id, category, country, amount, state reserved|charged|released}. Estimate = sum of rates; reserve at publish, charge on SENT, release on failed/excluded; handle quarterly rate changes and volume tiers; payment gateway for top-ups.
5. Segments (M). Segment {id, name, type static|active, filter JSON (groups with AND/OR), member snapshot, size, status}; ProfileSignal materialized fields (last_message_from_contact, campaigns_received_7/30/90, links_clicked_7/30/90, etc.) updated from webhooks; predefined segments as saved filters.
6. Scheduling, calendar, drip/sequence (L). DripStep {drip_id, order, template_id, delay_seconds}; Enrollment {drip_id, contact_id, step, next_send_at, state, stop_on_reply}; scheduler with cancel/edit; Campaign Calendar UI (M). Recurring broadcasts are not even in Wati, so optional.
7. Analytics and link tracking (M). Funnel counts, failure breakdown, CSV exports, retargeting segments; redirect service (short URL per recipient/campaign: LinkClick {link_id, campaign_id, contact_id, at, ua}); per-campaign category filter.
8. Auto-retry (S-M). Re-queue per-user-limit failures once per 24h until retry_until (cap 7 days); respect 15-day new-account guard if desired.
9. Reply actions and automation hooks (M). QuickReplyBinding {campaign_id, button_payload, action_type rule|message|chatbot, action_id}; skip other automation layers.
10. Fallback channels (M). SMS provider integration and template pairing; RCS optional.
11. Template extras (M each): carousel, LTO, coupon/copy-code, auth OTP with send API (S), media header validation, AI template improvement (M).
12. WhatsApp Flows (L). Flow {id, name, json, status draft|published, screens}; FlowResponse {flow_id, contact_id, answers JSON, at}; auto-created attributes `<flow>_content` and per-field; Flow-button in templates; nfm_reply webhook; per-plan quota.
13. Commerce (L-XL). Catalog connect + sync (Catalog {id, waba_id, status}, Product, ProductSet, Variant group), catalog templates, multi-product messages, cart/order webhook ingest (Order {id, contact_id, items[], total, currency, payment_status, address}), payment config (India-only, gateway-dependent), Shopify/WooCommerce connectors (L each): customer sync, event triggers, recovery sequences.
14. Abandoned-cart/order notification engine (M after connectors): Trigger {source, event, delay_sequence[], stop_events[], channel_fallbacks[], per-country conditions}; marketing frequency guard (4/24h, 10/7d); ROI attribution window (2-10 days) via order-to-message join.
15. CTWA attribution and conversion APIs (L). Persist referral (source_id, source_url, ctwa_clid, headline) from first inbound message; conversion events via Meta CAPI (Purchase/Lead tied to template-sent triggers), Google CTM, TikTok event set; follow-up scheduler (3 max, interval, stop on reply); free-entry-window clock (24h reply -> 72h/7d).
16. Public API and webhooks (M): endpoints mirroring estimate-cost, schedule, send, recipients, auto-retry, segments evaluate; scoped tokens; 429 with Retry-After; max 10,000 recipients per request.

---------------------------------------------------------------------------------------------------

## 11. Details that are easy to get wrong

- Messaging tier counts unique recipients in a rolling 24h and is shared across the whole business portfolio since 7 Oct 2025; replies in an open customer window are exempt. Do not count messages.
- Charge on SENT, not delivered; do not bill per-user-limit exclusions or failures; drips charge per step on success. Estimates must use each recipient's country calling code and the template's final category (Meta may recategorize after approval, changing price).
- Category can change at review or later: store both requested and effective category and re-price accordingly; appeal window is 60 days.
- Pricing change dates are hard-coded in policy: 1 Oct 2026 free utility-in-window and service-window messaging end; CTWA free window moves 72h to 7 days around 28 Sep 2026; quarterly rate updates.
- Per-user marketing frequency cap is Meta-side and silent in advance: the failure appears at send time. Auto-retry only for that failure, with a ~24h wait; do not hammer.
- Template parameters: no newlines, tabs, 4+ spaces; named variables lowercase/underscore; template cannot start or end with a variable; changing parameter counts after approval breaks sends; send-time param count must match exactly.
- Newly approved templates take time to sync (15-30 min); editing is impossible after approval; deleted names are blocked 30 days.
- Authentication templates are locked format with strict rules (no URL/media/emoji) and require a 2,000 daily limit path.
- Quick-reply handling precedence: campaign-level reply action overrides rules/keywords/default actions.
- Opt-out keyword must match the keyword text used in the quick reply; allowCampaign false excludes from future campaigns only.
- Phone numbers must be E.164 with country code; Brazil/Indonesia cross-country messaging has special requirements.
- A 200 from a send/schedule API means accepted, not delivered; final state arrives via webhooks. Scheduling in UTC; display in the user's zone.
- Segment semantics: static vs active; dynamic drips enrol new matches only until the drip completes; Shopify segments are read-only mirrors.
- Funnel counts per delivery, not per unique contact; the "Ignored" retarget definition differs between views, so pick one.
- Click tracking changes the URL, which can make Meta classify or the user distrust the link; use a branded domain.
- Abandoned cart: cart events within 30 minutes merge into one cart; checkout events dedupe per checkout ID every 5 minutes; consent used is Shopify email marketing consent, not WhatsApp consent; the shared marketing cap (4 per 24h, 10 per 7 days) applies across automations.
- Read receipts can be disabled by users, so read rates under-report.
- Meta experiment (about 1% of users) blocks marketing templates with code 130472; not a bug.
- Orders paid via WhatsApp Pay do not sync to Shopify automatically.
