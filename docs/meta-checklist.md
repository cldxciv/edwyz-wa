# Meta / WhatsApp compliance checklist for Edwyz WA

Research date: 2026-10-26. Sources are Meta developer pages fetched on this date. Most Meta pages show no "last updated" date; where a date is visible it is quoted. Anything not stated by a fetched page is listed under "Unverified" and was not guessed.

## Do this now, in order (owner, in the browser)

1. Confirm the app is published, in Live mode (App Dashboard top bar toggle). In Development mode Meta delivers test and role-user events only, so production webhooks (WhatsApp messages from real customers, `account_update`, Page `leadgen`) do not arrive until the app is Live. This needs the privacy policy URL, terms URL and app icon from step 2 first.
2. App Dashboard > App settings > Basic: set App icon (1024x1024), Privacy Policy URL `https://wa.edwyz.com/privacy`, Terms URL `https://wa.edwyz.com/terms`, App Domains `wa.edwyz.com`, Category, and Data Deletion: either the callback `https://wa.edwyz.com/api/meta/data-deletion` or the instructions URL `https://wa.edwyz.com/data-deletion` (one is required; having both is fine).
3. Facebook Login for Business > Settings > Client OAuth settings: set to Yes: Client OAuth login, Web OAuth login, Enforce HTTPS, Embedded Browser OAuth Login, Use Strict Mode for redirect URIs, Login with the JavaScript SDK. Allowed domains for the JavaScript SDK: `https://wa.edwyz.com` (full origin with scheme). Valid OAuth redirect URIs: both `https://wa.edwyz.com/oauth/callback` (Embedded Signup landing page) and `https://wa.edwyz.com/api/meta-connect/callback` (Meta Connect for Pages, Instagram and ads; this is the redirect that fails under strict mode if it is missing).
   - Deauthorize callback URL: `https://wa.edwyz.com/api/meta/deauthorize`. The route exists in code (POST only, signed_request verified with the app secret). It revokes the Meta connections of the user who removed the app and wipes their stored tokens. Never point this field at a URL that does not exist.
   - Data deletion request URL (callback): `https://wa.edwyz.com/api/meta/data-deletion`. Data deletion instructions URL (alternative or additional): `https://wa.edwyz.com/data-deletion`. Both are set in App settings > Basic (step 2); keep them in sync with this list.
4. Facebook Login for Business > Configurations: create a configuration (template "WhatsApp Embedded Signup Configuration With 60 Expiration Token", or custom with login variation "WhatsApp Embedded Signup"). Select only the assets and permissions you need (whatsapp_business_management, whatsapp_business_messaging). Save the configuration ID (config_id). Selecting products sets the integration to Embedded Signup v4.
5. WhatsApp > Configuration: set the callback URL `https://wa.edwyz.com/webhooks/whatsapp` and verify token; subscribe the fields in section 4 below. Use the dashboard "Test" button to confirm delivery.
5a. Webhooks > product Page (lead ads): callback URL `https://wa.edwyz.com/webhooks/leads` with the same verify token as the WhatsApp webhook, subscribe the field `leadgen`. Per-Page subscription is done by the app when a workspace connects Meta (Connections > Connect Meta); the dashboard entry is only the app-level callback. Needs `leads_retrieval` and `pages_manage_metadata` and a Live app.
5b. App settings > Advanced > Security > **Require App Secret**: leave **Off** until a release that sends `appsecret_proof` on every Graph call is deployed (`graphFetch`, `graphFetchAs`, `graphUpload` and the template sample upload in `src/lib/graph/index.ts` and `src/lib/templates/upload.ts`) and `META_APP_SECRET` is set in the server `.env`. After that deploy, check one send, one template sync and one Meta Connect refresh, then it may be turned **On**. If it is turned On before the deploy, every server call fails with error 100 "Invalid appsecret_proof". Leave the IP allowlist empty, or make sure it contains the VPS address.
6. Make sure the deployed site shows the real privacy, terms and deletion pages before submitting (reviewers open them).
7. Record two separate screencasts (section 2), then submit App Review for Advanced access to `whatsapp_business_messaging` and `whatsapp_business_management`. Drafts are not reviewed; you must press Submit. Meta states average turnaround is about 24 hours.
8. After approval: complete Tech Provider steps in WhatsApp > Quickstart, and test Embedded Signup end to end with a real second business.
9. Before Dec 31, 2026: if Meta bills your entity as Sold-To country India, plan INR billing migration (section 5).
10. Have a lawyer review the legal pages (section 7) before App Review is submitted.

## 1. Embedded Signup for Tech Providers

Source: https://developers.facebook.com/docs/whatsapp/embedded-signup/implementation (no visible date; uses Graph v26.0).

Key facts
- Embedded Signup v2 and v3 are deprecated on **October 15, 2026** (already past as of today). Build on **v4** only. Verified on the implementation, overview and version-4 pages.
- Prerequisites: be a Solution Partner or Tech Provider; subscribe to `account_update`; valid SSL host.
- Dashboard steps (Step 1 and 2 above). Only HTTPS domains are supported.
- JS SDK: load `https://connect.facebook.net/en_US/sdk.js`; `FB.init({appId, autoLogAppEvents:true, xfbml:true, version:'v26.0'})`; `FB.login(cb, {config_id, response_type:'code', override_default_response_type:true, extras:{setup:{}}})`, triggered from a button click.
- Callback: `response.authResponse.code`. This code has a **30 second time to live**; exchange immediately on the server.
- Session event: a `window` message listener; check `event.origin` ends with `facebook.com`, parse JSON, `type === 'WA_EMBEDDED_SIGNUP'`. Finish events (`FINISH`, `FINISH_ONLY_WABA`, `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`, `FINISH_OBO_MIGRATION`, `FINISH_GRANT_ONLY_API_ACCESS`) carry `phone_number_id`, `waba_id`, `business_id` (and optionally ad/page/dataset/catalog/Instagram ids). `CANCEL` carries `current_step` or `error_message`, `error_code`, `session_id`, `timestamp`. Send these to your server; do not trust them without cross-checking via the API.
- Token exchange (server to server), from the Tech Provider onboarding page (https://developers.facebook.com/docs/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider):
  `GET https://graph.facebook.com/<version>/oauth/access_token?client_id=<APP_ID>&client_secret=<APP_SECRET>&code=<CODE>` (that page's example shows v21.0; use your pinned version). Returns the business token.
- Post-signup, same page:
  1. `POST https://graph.facebook.com/<version>/<WABA_ID>/subscribed_apps` with `Authorization: Bearer <BUSINESS_TOKEN>` (returns `{"success":true}`).
  2. `POST https://graph.facebook.com/<version>/<PHONE_NUMBER_ID>/register` with body `{"messaging_product":"whatsapp","pin":"<6 digit PIN>"}`. The PIN becomes the number's two-step verification PIN. Overview page says registration is skipped for coexistence onboarding.
  3. Payment method: the customer must add one in WhatsApp Manager (Overview panel > Add payment method, https://business.facebook.com/wa/manage/home/) before they can message. "Once your customer adds a payment method, they are fully onboarded." Credit-line sharing is for Solution Partners, not Tech Providers.
- Tech Providers use business tokens for everything. You cannot onboard customers until the app has Advanced access for each required permission.
- Onboarding limit: 10 new customers per rolling 7 days by default; completing Business Verification, App Review and Access Verification raises it to 200 (overview page).

Hosted link vs JS SDK (https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/hosted-es.md)
- Hosted: WhatsApp > Quickstart > View onboarding > copy the URL from the "Zero integration onboarding" card; open in a new window from a button. "The flow cannot be customized." Cloud API only.
- No redirect payload: Meta sends an `account_update` webhook with `event: PARTNER_ADDED`; read `waba_id` and `waba_info.owner_business_id`. Then compute `appsecret_proof` (HMAC-SHA256 of the system token with the app secret), call the System User Access Tokens API on the customer's business portfolio with `fetch_only=true` to get the business token, then call the Phone Numbers API on the WABA for the phone number id.
- JS SDK: you get a `code` plus the WA_EMBEDDED_SIGNUP message event, and exchange the code yourself.
- Your `/oauth/callback` redirect URI matters for the JS SDK flow; the hosted link relies on webhooks. You therefore must have the `account_update` subscription working for either path.
- `sessionInfoVersion`: **not found on any fetched page**. I cannot state what version 3 means or how it differs from the hosted link. See Unverified. The client sends `extras: { setup: {}, sessionInfoVersion: "3" }` (as in Meta's current snippet) and loads the SDK and the signup state before the click so `FB.login` runs synchronously from the click; confirm with one real signup that the `WA_EMBEDDED_SIGNUP` finish event carries `waba_id` and `phone_number_id`.

## 2. App Review

Sources: https://developers.facebook.com/docs/whatsapp/solution-providers/app-review ; https://developers.facebook.com/docs/whatsapp/solution-providers/get-started-for-tech-providers ; data deletion callback page https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback

Verified requirements
- Business Verification complete before App Review (done).
- App settings: app icon, privacy policy URL, app category.
- Permissions to request, at **Advanced access** (Standard access is automatic and only covers your own business). Request only what you need; unnecessary permissions is a stated rejection reason.
- Separate screen recording per permission. Screenshots are not accepted. Written description plus video for each.
  - `whatsapp_business_messaging`: written description of the messaging features offered to onboarded clients and how they use them. Video: your app sending a message to a WhatsApp number and the WhatsApp client (web or mobile) receiving it. A cURL from App Dashboard > WhatsApp > API Setup is acceptable as a substitute per the Tech Provider page.
  - `whatsapp_business_management`: written explanation of how you use it to access clients' business assets. Video: your app (or WhatsApp Manager) creating a message template.
- Test users need a developer or admin role on the app (the only credential statement found).
- Data deletion: either a callback URL (HTTPS, verifies `signed_request` with HMAC-SHA256 and app secret, returns JSON `{url, confirmation_code}`) or a deletion instructions URL. The privacy policy must explain how users can request deletion. Meta sends alerts every 21 days; no proof of deletion needs to be submitted.
- Webhook note: partners need advanced access via App Review before customers can grant these permissions.

Checklist
- [ ] Business Verification approved (done)
- [ ] App icon 1024x1024, category set, privacy policy URL, terms URL, deletion callback and instructions URL set
- [ ] App in Live mode; pages publicly reachable over HTTPS with no login
- [ ] Two screencasts, narrated or captioned, each showing the live URL bar
- [ ] Screencast 1: sending a message from the app UI (or cURL) and the phone receiving it
- [ ] Screencast 2: creating a template and seeing it submitted
- [ ] Written descriptions below, matching what the videos show
- [ ] Reviewer instructions: how to log in (create a demo account with a password, give credentials in the submission), which menu to click, which test number to use
- [ ] Only the two permissions requested

Use-case text templates (edit to match what exists on the day you record; do not describe features not yet built)

whatsapp_business_messaging:
> Edwyz WA is a web application that lets a business send and receive WhatsApp messages from its own WhatsApp Business number using the WhatsApp Cloud API. A business connects its number with Embedded Signup. The user can [reply to a customer message inside the 24-hour customer service window] and [send an approved message template to a contact who has opted in]. The screencast shows a user signing in, selecting a connected number, sending a message to a test phone, and the message arriving in the WhatsApp client. We use the permission only to send messages on behalf of businesses that have connected their own account to our app. We do not message anyone who has not opted in.

whatsapp_business_management:
> Edwyz WA uses this permission to read and manage the WhatsApp Business Account of the business that connected to our app: to subscribe our app to the account's webhooks, to read the connected phone number and its quality rating and messaging limit, and to create message templates and read their approval status. The screencast shows a user creating a template in Edwyz WA, submitting it to Meta, and viewing its status. We access only the accounts that a business shares with us through Embedded Signup.

Replace the bracketed items with only what is demonstrably working. If broadcasts are not built at recording time, omit that sentence.

Common rejection reasons
- Verified from fetched pages: requesting unnecessary permissions; combining permissions in one video; screenshots instead of video; submitting a draft. Also, privacy policy and deletion must exist and the deletion callback must work (failure can disable the app).
- Other reasons commonly reported (video not showing the real flow, reviewer cannot log in, mismatch between text and video, privacy policy not reachable) are **not stated** in the pages I fetched and are marked unverified.

## 3. Graph API version and deprecation

Source: https://developers.facebook.com/docs/graph-api/changelog/versions

| Version | Released | Expires |
|---|---|---|
| v26.0 | July 29, 2026 | TBD |
| v25.0 | Feb 18, 2026 | July 29, 2028 |
| v24.0 | Oct 8, 2025 | Feb 18, 2028 |
| v23.0 | May 29, 2025 | Oct 8, 2027 |

- Current latest: **v26.0**. Recommendation: pin `GRAPH_API_VERSION=v26.0` (the Embedded Signup page itself uses v26.0), or v25.0 if you want a version with a published expiry. Make the version one config variable used everywhere, including `FB.init`.
- The page states no formal policy text. The dates show roughly two years of availability after release; treat that as an observation, not a promise. Unversioned calls default to the app's oldest available version behaviour, which I did not verify; always send the version.
- Docs examples still show v21.0 in places; do not copy those.

## 4. Webhooks

Sources: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks ; webhooks overview and create-endpoint pages under https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/

Subscribe in App Dashboard > WhatsApp > Configuration (or Use cases > Customize > Configuration):
- Messages and message statuses (sent/delivered/read/failed): `messages`
- Template approval changes: `message_template_status_update`
- Template quality: `message_template_quality_update`
- Template category changes: `template_category_update`
- Phone number quality / throughput: `phone_number_quality_update`
- Account events (partner added via hosted link, violations, offboarding, deletion): `account_update`
- Messaging limit, profile, OBA changes: `account_alerts`; and `business_capability_update` for limit changes
- Also worth considering: `account_review_update`, `phone_number_name_update`.
Full list of subscribable fields (verified): account_alerts, account_review_update, account_update, automatic_events, business_capability_update, calls, history, message_template_components_update, message_template_quality_update, message_template_status_update, messages, partner_solutions, payment_configuration_update, phone_number_name_update, phone_number_quality_update, security, smb_app_state_sync, smb_message_echoes, template_category_update, user_preferences.

Permissions: `whatsapp_business_messaging` for `messages` and `calls`; `whatsapp_business_management` for the rest.

Mechanics
- Verification: GET with `hub.mode=subscribe`, `hub.challenge`, `hub.verify_token`; return 200 with the challenge as body when the token matches.
- Signature: every POST has `X-Hub-Signature-256: sha256=<hmac>`; HMAC-SHA256 over the raw body bytes with the app secret.
- Return 200 quickly. Non-200 or failures are retried with decreasing frequency for up to 7 days; duplicates are possible, so deduplicate. Batches may hold up to 1,000 updates; payload up to 3 MB. No API to fetch historical webhooks, so store them. mTLS is supported and preferred over IP allowlists.
- Confirm delivery: send the test payload from the dashboard, check the app is Live, confirm your endpoint returns 200. No dedicated delivery-confirmation mechanism is documented.
- Per-customer subscription: `POST /<WABA_ID>/subscribed_apps` after every Embedded Signup (section 1).

## 5. Messaging rules

Pricing (https://developers.facebook.com/docs/whatsapp/pricing)
- Since July 1, 2025, **per-message pricing** for messages the business sends; conversation-based pricing is deprecated. Charged only for delivered messages; rate depends on category and recipient country code. User-to-business messages are free.
- Template categories: Marketing, Utility, Authentication. Non-template messages (service, and Meta Business Agent) only inside an open customer service window.
- Customer service window: 24 hours, opens when the user messages or calls, resets on each new user message. Outside it, templates only.
- Free service messages: 1,000 per business phone number per month, no rollover. **Changes on October 1, 2026 (already in effect today):** service messages beyond the free tier and utility messages sent inside an open window become chargeable. Recheck exactly what is free; the page text is ambiguous about whether the 1,000 free tier remains, so confirm on the rate-card page.
- Free entry point windows: user messages from a Click to WhatsApp ad; if you reply within the service window, your first marketing/utility/authentication/service message is free and opens an FEP window of up to 7 days in which those types are free (Meta Business Agent messages still charged).
- Rate card: interactive at https://business.whatsapp.com/products/platform-pricing#rates , plus the "Rate cards and volume tiers" section of the pricing page. India (+91) is a standalone market. Do not copy numbers into our UI from this document. Pricing changes only on Jan 1, Apr 1, Jul 1, Oct 1; rate cards need at least one month's notice.
- India billing localisation: eligible customers (Sold-To India) must migrate all accounts to INR by December 31, 2026, or messages from non-INR accounts stop delivering from January 1, 2027. Check whether this applies to your customers and to you.

Messaging limits (https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits.md and .../upcoming-messaging-limits-changes.md)
- The limit is the number of unique users you can message outside a service window in a moving 24 hours, **per business portfolio**, shared by all numbers (changed from per-number on October 7, 2025).
- New portfolios start at 250. Scaling path (verify business, or 2,000 delivered messages to unique numbers in 30 days with high quality templates) moves it to 2,000. Automatic scaling then goes 10,000, 100,000, unlimited; increase applies within 6 hours (was 24) if high quality across all numbers and templates and at least half the limit used in the last 7 days.
- The "Flagged" quality state no longer exists; a quality drop no longer lowers the messaging limit. Check via WhatsApp Manager or the API field `whatsapp_business_manager_messaging_limit`; `messaging_limit_tier` is deprecated.
- Quality: template ratings GREEN/YELLOW/RED/UNKNOWN; low quality can lead to pacing or pausing and a non-APPROVED template cannot be sent. Phone number quality rating behaviour and exact thresholds were **not** in the fetched pages. Enforcement (https://developers.facebook.com/documentation/business-messaging/whatsapp/policy-enforcement.md): warnings, then 1 or 3 day blocks on marketing/utility/authentication templates, 5/7/30 day blocks on all messages, account lock, disablement; severe harm leads to immediate offboarding. Appeals via Business Support Home, typically 24 to 48 hours.

Opt-in (https://developers.facebook.com/documentation/business-messaging/whatsapp/getting-opt-in.md)
- Must clearly state the person is opting in to receive messages from the business, name the business, and comply with law. Method is your choice (website, SMS, IVR, paper). Best practice: opt-in per message category; explain how to opt out and honour it.

Business Messaging Policy (https://whatsappbusiness.com/hi/policy/, page shows last update 23 September 2026; fetched via a redirect from business.whatsapp.com/policy, content summarised from a Hindi-language page)
- Contact only people who opted in; separate opt-in by category; templates outside the 24-hour window.
- Must honour requests to stop, block or be removed from lists, on or off WhatsApp; give clear opt-out instructions per category.
- Prohibited goods/services (weapons, drugs, alcohol, tobacco, real-money gambling, adult, dating, MLM, payday loans, etc.), no sensitive identifiers such as full card numbers, no impersonation.
- Automation is allowed in the window but there must be a clear path to a human.
- No dedicated broadcast section, but unauthorised large-scale messaging is an enforcement target, and blocks and reports can limit how many people you can message. Implication for our product: opt-in records per contact and category, STOP handling, per-tenant rate limits, template-quality monitoring, and customer terms that pass these duties on (our terms do).

## 6. Tech Provider and Tech Partner

Sources: Tech Provider page and https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/upgrade-to-tech-partner.md

- Tech Provider (what you are applying for): Business Verification, App Review with Advanced access, then onboard customers via Embedded Signup; customers add their own payment method. Sandbox WABA valid 30 days for testing. No volume thresholds are required to be a Tech Provider.
- Tech Partner is a later upgrade, requiring all of: Tech Provider steps complete; **at least 2,500 average daily messages (sent or received) over the last 7 days** (or 200 daily calls); **at least 10 active clients** (an active client sent at least one message through your app in the last 30 days); business phone number quality rating of **90% or better**. Process: dashboard "Become a Partner", apply for Meta Business Partner with WhatsApp specialty, Partner Portal signup, Business Messaging Accelerate enrollment; approval often takes weeks.
- Correction to the owner's plan: those three numbers are the **Tech Partner** gate, not Tech Provider and not an App Review requirement. They are not needed to go live. Also, a related but different number is the onboarding cap: 10 new customers per rolling 7 days until Business Verification, App Review and Access Verification are complete (then 200). Do not confuse "10 active clients" with "10 customers onboarded per week". The page does not say how "90%" is measured or what the "quality rating" maps to given the removal of the Flagged state; treat that as unverified.
- Correction on the "independent" model: as a Tech Provider you use customer business tokens and customers pay Meta directly. Credit-line sharing is only for Solution Partners.
- Access Verification is mentioned on the overview page but not described on any fetched page; see Unverified.

## 6a. Dashboard settings that must match the code

Production values for the Edwyz API app. Each line names where the code expects it.

| Dashboard field | Value | Code |
|---|---|---|
| Valid OAuth redirect URIs | `https://wa.edwyz.com/oauth/callback` and `https://wa.edwyz.com/api/meta-connect/callback` | `src/app/(site)/oauth/callback`, `src/app/api/meta-connect/callback` |
| Allowed domains for the JavaScript SDK | `https://wa.edwyz.com` | `ConnectWhatsApp.tsx` |
| Deauthorize callback URL | `https://wa.edwyz.com/api/meta/deauthorize` | `src/app/api/meta/deauthorize/route.ts` |
| Data deletion request URL | `https://wa.edwyz.com/api/meta/data-deletion` | `src/app/api/meta/data-deletion/route.ts` |
| Data deletion instructions URL | `https://wa.edwyz.com/data-deletion` | `src/app/(site)/data-deletion/page.tsx` |
| WhatsApp webhook callback | `https://wa.edwyz.com/webhooks/whatsapp` | `src/app/webhooks/whatsapp` |
| Page webhook (`leadgen`) | `https://wa.edwyz.com/webhooks/leads` | `src/app/webhooks/leads` |
| Require App Secret | Off until `appsecret_proof` is deployed, then may be On | `src/lib/graph/index.ts` |
| App mode | Live (published) | Meta delivers production webhooks only to a Live app |

Notes
- The deauthorize and data-deletion callbacks are public routes: no session, authenticated by the HMAC-SHA256 `signed_request`. They are rate limited per address (in the app and by the `wa_meta` zone in `deploy/nginx-wa-zones.conf`). Install the updated zones file and reload nginx before relying on the Meta location block.
- Test the deauthorize callback from App Dashboard > Facebook Login for Business > Settings after deploy. Meta marks a callback as failing when it answers anything other than 200.
- `STATE_SECRET` must be 32 or more characters in production. `scripts/check-env.mjs <file>` now fails the deploy for a shorter value.

## 7. Review of our public pages (local source)

Files reviewed: src/app/page.tsx, privacy/page.tsx, terms/page.tsx, data-deletion/page.tsx, api/meta/data-deletion/route.ts. I did not read src/lib/meta.ts, src/lib/config.ts, the shared LegalPage component, the status page or the webhook route, so claims about them are unverified.

What matches Meta's requirements
- Privacy policy exists, names the company, address and email, explains deletion and links to the deletion page.
- The deletion callback returns `{url, confirmation_code}` and rejects bad signatures with 400; instructions page exists. Good.
- The homepage presents the product honestly as "building the first release" with "Planned" features.

Gaps and exact fixes

Homepage
1. "Built around WhatsApp's rules" lists "STOP requests are respected" and "The estimated cost is shown before a broadcast is sent" in present tense. Reviewers click through; if not built, this is a misrepresentation. Change heading to "How we plan to follow WhatsApp's rules" and start items with "Will": "Marketing messages will go only to contacts who have opted in, and STOP requests will be respected." Same for the cost line, or delete it.
2. Add a visible line: "Edwyz WA is operated by Edwyz Technologies Private Limited, India. It is an independent product and is not affiliated with or endorsed by Meta or WhatsApp." Also show the legal name, address and links to Privacy, Terms and Data deletion in the footer (not checked in the shared shell).
3. Add one sentence describing exactly what a business does in the app (sign in, connect number, send template), so the reviewer can map the screencast to the site.

Privacy
4. Add Embedded Signup data: "When you connect WhatsApp through Meta's Embedded Signup we receive your Meta business portfolio ID, WhatsApp Business Account ID, phone number ID and an access token that you authorise. We use them only to operate your connected number."
5. Section 2 says nothing about data received from Meta about the person who completes signup (Facebook user ID). Add "Meta user identifier supplied during sign-up".
6. Section 8 claims "verification of the signature on every webhook" and "encrypted storage of access tokens". Only keep these if the code does it (webhook route and token storage not reviewed here); otherwise change to "we are building".
7. Section 7 retention has no periods. State concrete ones, for example "Message data is deleted within 30 days after you close the workspace unless you ask otherwise" only if you will do it.
8. Section 4 mixes DPDP "consent" and GDPR; say whether you serve EU/UK users. If not, remove GDPR language to avoid commitments you cannot meet. Add a grievance officer name and email, which India's rules expect.
9. Confirm the page displays an effective date; the text refers to "the effective date above" (depends on LegalPage).

Data deletion page
10. "If you signed in with Facebook" is inaccurate: accounts use email and password, and Facebook is used only for connecting. Reword: "If you connected your WhatsApp account through Meta".
11. "Remove the Edwyz app from your Facebook account" should use the exact name shown in Meta's settings: **Edwyz API** (the app name). Also state the path: Settings > Apps and Websites (Meta's UI labels change; check).
12. The callback only appends a JSON line with status "received". The page promises deletion and a status. Make sure a real job deletes or anonymises data and that the status page reports progress, otherwise the commitment is false.
13. The route stores the raw Meta user id in a file; document this in the privacy policy and delete the record after the retention period.

Terms
14. Add: "Edwyz is not affiliated with Meta or WhatsApp" and "You must be 18 or older and the business must be lawfully registered".
15. Section 5 Fees: say explicitly that Meta bills message charges directly to the customer's payment method in WhatsApp Manager (true for the Tech Provider model) so there is no ambiguity about who charges.
16. Section 3: add that messaging limits and quality are governed by Meta and Edwyz can suspend broadcast features on a quality drop.

Statements for lawyer review (do not rely on this document)
- Data deletion "aim to finish within 30 days": a self-imposed commitment; verify it against DPDP Act 2023 and the Rules, and against what your backups can actually do.
- The "controller / processor" split in the privacy policy, the DPDP "consent or lawful use" basis, GDPR mentions, international transfers and the absence of a named grievance officer.
- Terms section 8: exclusion of indirect loss and cap at 12 months of fees (with early-release free usage the cap is effectively zero; may be unenforceable or unfair in some places).
- Terms section 10: Indian law and exclusive courts at Shimla; check against your registered office and enforceability against foreign customers; consider arbitration.
- "We do not sell personal data" and "will tell affected parties about a breach as the law requires" (CERT-In six hour reporting obligation for certain incidents applies in India).
- The suspension right ("if your use puts other customers at risk") and the "reasonable notice" promise.

## Verified facts

- ES v2/v3 deprecated Oct 15, 2026; v4 uses config_id, `response_type: code`, 30 second code TTL.
- Token exchange, subscribed_apps and register calls and payload (sources in section 1).
- Graph API v26.0 released July 29, 2026; table in section 3.
- Webhook field names and retry behaviour; handshake and signature.
- Per-message pricing since July 1, 2025; Oct 1, 2026 changes; FEP behaviour; rate card URL; India INR deadline.
- Portfolio-level limits since Oct 7, 2025; tier steps; Flagged removed.
- Tech Partner thresholds (2,500/day, 10 active clients, 90% quality).
- Advanced access, separate videos, no screenshots, data deletion callback format.
- Business Messaging Policy last update 23 Sept 2026 (from the Hindi-language page).

## Unverified (not stated by any page I could fetch)

- `sessionInfoVersion` (v3 or otherwise) and differences vs the hosted link beyond what is in section 1.
- Access Verification process and its requirements.
- Exact App Review requirements for test credentials, reviewer instructions, app icon size, category choice, and the full list of common rejection reasons. Pages 404 for https://developers.facebook.com/docs/development/release/app-review-guidelines and https://developers.facebook.com/docs/whatsapp/embedded-signup/hosted-embedded-signup.
- Phone number quality rating thresholds and the basis for the "90%" Tech Partner measure.
- Whether the 1,000 free service messages per month remain after October 1, 2026 (page wording unclear).
- Whether `/oauth/callback` needs a `redirect_uri` parameter on the token exchange for your flow (not shown on the fetched pages).
- Content of the code in src/lib/*, the webhook route, LegalPage and status page.
- English text of the Business Messaging Policy (fetched page was Hindi; summary is machine-translated).
- Anything about Meta's WebFetch summaries: pages were summarised by a small model; confirm exact wording in the browser before relying on it for submission.
