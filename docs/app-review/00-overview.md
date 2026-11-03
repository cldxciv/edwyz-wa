# Meta App Review overview: Edwyz API (App ID 1799953191201553)

Date: 2026-10-27, state updated 2026-10-30, Instagram and Facebook Page ads added 2026-10-31 (docs/IG-PAGE-ADS-SPEC.md 8.1, 8.2, 8.5, 11.1a decision 4; PRM-16). Status of each permission is in `status.md`. Meta-specific names and rules here are best knowledge; items marked VERIFY must be re-checked in the App Dashboard before each submission.

**Current state (2026-10-31): draft, not submitted.** Nothing is in review. The App Review request is a draft (submission id 1799953447868194) with 22 items; the owner chose to keep all 22 in one request, so each item needs its built feature, screencast, API test calls and agreement before Submit can be pressed. Per-item readiness: `status.md`. The phase order below is the plan the draft departs from: it is kept as the order in which to finish the items.

## Submission order

1. **Phase A part 1 (draft, not submitted; the two items are filled in the draft):** `whatsapp_business_messaging`, `whatsapp_business_management`. These come from the Embedded Signup configuration, not from the Connect configuration. Description, screencasts and test calls are done; the "I agree" boxes are not ticked, and Meta suggests one more clip showing the Embedded Signup (OAuth) flow. If Meta asks for more evidence, use `whatsapp-production-readiness.md` (reviewer account, test number, screencast scripts, production checklist).
2. **Phase A part 2:** `business_management`, `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `pages_manage_ads`, `ads_management`, `ads_read`, `leads_retrieval`, `instagram_basic`, plus the Marketing API access tier and the `leadgen` webhook. The features are built: Connections with the Facebook Login popup, Boost a post, New ad by goal (WhatsApp chats, lead forms, website, Instagram Direct, Messenger), lead forms made in Edwyz, audiences, results by placement and the review timeline, the Leads hub (routes in `status.md`). Their descriptions are written in the draft; the screencast scripts for the ads flows are in the per-permission files (matrix below). Each still needs the sandbox runbook (`docs/promote-verification-runbook.md`, V-P0 to V-P7 at least), then a live end-to-end run on the test Page and test ad account, then the screencast and test calls.
3. **Phase B:** `pages_manage_posts`, `instagram_content_publish` (with `instagram_basic`), Conversions API access. The content calendar that uses the first two is built (/app/content, `src/lib/content`), but **the draft does not request them**: add them to the app's Page and Instagram use cases and the Login for Business configuration, then to the draft. `pages_manage_engagement`, `read_insights` and `instagram_manage_insights` are NOT requested: no code uses them (see `status.md`, alignment table). Add each, with its review document, only in the change that ships the feature.
4. **Phase C (in the draft, not requested by any feature yet):** `pages_messaging` and `instagram_manage_messages` are the next workstream (11.1a decision 4): their use-case and App Review material is ready in `pages_messaging.md` and `instagram_manage_messages.md`, both marked NEXT WORKSTREAM, and they are not requested until that feature ships. `instagram_manage_comments`, `catalog_management`, Threads permissions and the other items the draft holds (Live Video, fundraisers, branded content, ads MCP) are not requested by any built feature either; each is built before the draft is submitted, or taken out of the draft.

Never submit a permission whose feature is not live: Meta rejects a demo of a flow that does not exist. The owner's single 22-item draft replaces the earlier rule of one phase per submission. One app versus two is an open owner decision (spec section 4).

## Instagram and Facebook Page ads: which video shows which permission (spec 8.2)

The Facebook Login for Business configuration "Edwyz Connect Pages IG Ads" (`META_LOGIN_CONFIG_ID`) requests the permissions in `META_CONNECT_SCOPES` (`src/lib/meta-connect/scopes.ts`), and nothing else. `tests/usage-scopes-alignment.test.ts` fails when the list and the code disagree; request only what it allows, because extra permissions are a common reason for rejection.

| Permission | Used for (code reason in `scopes.ts`) | Screencast | Script in |
|---|---|---|---|
| `business_management` | Find the business and its assets | Connect with the popup; the assets found | This file, "The shared opening" |
| `pages_show_list` | List the Pages the person manages | Connect | This file, "The shared opening" |
| `ads_management` | Create PAUSED campaigns, ad sets, creatives and ads; start them through the limits; upload images and videos; audiences; previews | Boost an Instagram reel; a Click-to-WhatsApp ad; a customer-list audience with the consent screen | `ads_management.md` |
| `ads_read` | Results by placement and creative, review status, reach estimates, minimum budgets, previews, account health | Results by placement; the review status timeline | `ads_read.md` |
| `pages_read_engagement` | Page posts for the boost picker; Page fields (Lead Ads terms, picture) | The post picker with eligibility | `pages_read_engagement.md` |
| `instagram_basic` | Instagram profile, media, reels and stories for the picker and previews | The Instagram tab of the picker | `pages_read_engagement.md`, step 4 |
| `pages_manage_ads` | Ads for the Page, Click-to-Message, instant forms, test leads, the Page-backed Instagram identity | Create a form in Edwyz, launch a lead ad, send a test lead | `pages_manage_ads.md` |
| `pages_manage_metadata` | Subscribe the Page to the `leadgen` webhook | A lead arriving in the hub | `pages_manage_metadata.md` (the lead itself: `leads_retrieval.md`) |
| `leads_retrieval` | Read leads (webhook fetch and backfill) | A test lead in the Leads hub, then the WhatsApp follow-up | `leads_retrieval.md` |
| `pages_manage_posts`, `instagram_content_publish` | Content publishing (another workstream) | Content workstream | `pages_manage_posts.md`, `instagram_content_publish.md` |

### The shared opening (every ads video starts here; it is the `business_management` and `pages_show_list` video)

1. Start logged out at https://wa.edwyz.com/login. Sign in as the review user.
2. Open Settings > Connections and press **Connect with Facebook**. A small Facebook window opens over Edwyz (the page says "Finish in the Facebook window. This page updates by itself when you're done.").
3. In the Facebook window, show the consent screen with the permission list readable, and pause two seconds on it. Choose the test business, the test Page, the Instagram account and the test ad account, then continue.
4. The window closes by itself and Connections lists the business, the Page, the Instagram account and the ad account ("Connected. Your assets are listed below."). Point at the permission list on the page, which says what each permission is used for.
5. If the browser blocks the window, Edwyz moves the whole page to Facebook instead and comes back to Connections: that is expected, keep recording.

End every video with Settings > Connections > Disconnect, then the data deletion page (https://wa.edwyz.com/data-deletion).

### When to record the ads videos

- After the sandbox runbook's V-P0 to V-P7 have passed, and with the flows live for the review user: after train P3 (`PROMOTE_ENABLED=on`, `deploy/README-deploy.md` D.2). Do not add the review user to the platform admin list to see the flows during P2.
- Use the test assets of the runbook (`docs/promote-verification-runbook.md` section 1). A Meta sandbox ad account accepts Start but delivers nothing, so the Start step costs nothing; results and review screens need the owner-present live check (V-P17) or Meta's test data, so record those on the real test account with the owner's say-so and the lowest budget.
- The review workspace has daily and monthly ads limits set (Settings > Spending limits), so the card's "At most ₹..." line and the limit checks show on camera.

## Permissions not requested (spec 8.5)

Each of these needs a use case, a configuration edit and App Review before its feature, and none is requested now:

- `instagram_manage_messages`, `pages_messaging`: Instagram Direct and Messenger chats from Click-to-Instagram and Click-to-Messenger ads landing in the inbox and the Leads hub. Next workstream; material prepared, not requested.
- `instagram_branded_content_ads_brand`: partnership and creator ads (open question 6). Not requested.
- `catalog_management`: catalog and dynamic product ads. Not requested.
- `read_insights`, `instagram_manage_insights`: organic numbers and "paid vs organic". Not requested; the scope test bans them.

## What Meta checks

- Business Verification approved (done).
- App settings: icon, category, privacy URL https://wa.edwyz.com/privacy , terms https://wa.edwyz.com/terms , deletion callback https://wa.edwyz.com/api/meta/data-deletion , instructions https://wa.edwyz.com/data-deletion . Pages must load without login.
- Per permission: a written use case, a screencast showing the permission actually used, and working test credentials.
- That each requested permission is necessary and the data use matches the stated purpose.
- Data Use Checkup answers (see `data-handling.md`) and that the live privacy policy covers the new data.
- App in Live mode.
- For the ads permissions: the Marketing API access tier. Full access needs 500 calls in 15 days with an error rate under 15% (spec 8.1 item 4); until then the Limited quotas apply and `leads_retrieval` depends on the higher tier.

## Test account and test asset setup

1. Create a review user in Edwyz WA (owner of a dedicated workspace "Meta Review") with a simple password and no 2FA. Put credentials in the review notes only.
2. Add a Facebook test user (or a real tester added under App roles) who administers: a test Page, a test Instagram professional account linked to it, a test ad account with a payment method and a low cap, a test lead form, and a test catalog.
3. Connect a test WhatsApp number with an approved template and an opted-in test contact, linked to the test Page (Click-to-WhatsApp needs the link).
4. Keep a phone logged in to WhatsApp, Messenger and Instagram test accounts for the receiving side.
5. Seed the workspace with test data only. Confirm no real customer appears. For the customer-list video, the contacts are test contacts with a recorded marketing opt-in (at least 100, or the card says the list is too small).
6. Reviewers cannot use 2FA codes or email links: disable them for the review user, make sure the email is verified (emailVerifiedAt set) and the plan or trial is active so the workspace is not read-only.

## How to record screencasts

- One video per permission. Chrome, 1080p, browser URL bar visible, English UI.
- Start logged out. Show login, then the connect flow with the Meta permission dialog readable (pause two seconds on it).
- Show the exact feature using the permission, the result in our UI, then the result in Meta (Ads Manager, the Page, the phone).
- End with how a user disconnects and the data deletion page.
- Add captions naming each step. Keep each video short (under about three minutes; VERIFY current size and length limits).
- Record only the browser window so notifications do not leak.

## Common rejection reasons and how our flows avoid them

| Reason | How we avoid it |
|---|---|
| Screencast does not show the permission being used | One video per permission; script shows dialog, feature, result |
| Reviewer cannot log in | Dedicated review user, no 2FA, active plan, credentials in notes |
| Feature not available or not built | Build every item of the draft before Submit (see status.md) |
| Asking for more than needed | Only the permissions in `META_CONNECT_SCOPES`; read-only features do not request write permissions; `tests/usage-scopes-alignment.test.ts` |
| Data use not explained | Use-case text states read/write, storage, retention and who sees it |
| Privacy policy or deletion missing or mismatched | Pages live; update them for ads, leads, audiences and Page data before Phase A part 2 |
| Broken pages or errors in the demo | Rehearse on the live URL |
| Demo uses real personal data | Test data only |
| Ad spend risk | Every object created paused; Start only on a card that shows the most it can spend; the owner's daily and monthly limits enforced before anything turns on |
| Hidden behaviour | Show the "what we can access" list and the audit log |

## Pre-submission checklist

- [ ] Feature built and rehearsed end to end on the live URL
- [ ] Sandbox runbook V-P0 to V-P7 passed and recorded (`docs/promote-verification-runbook.md`) before the ads videos
- [ ] Permission name confirmed in the dashboard (VERIFY Instagram family)
- [ ] Use-case text pasted and under 1000 characters
- [ ] Screencast recorded, captioned, URL visible, no secrets
- [ ] Test credentials tested from a clean browser
- [ ] Test Page, Instagram account, ad account, lead form, catalog ready and roles granted
- [ ] Privacy policy and terms updated for the phase (`src/lib/legal.ts`, bump version) and lawyer-reviewed (`docs/legal-review-notes.md`)
- [ ] Deletion callback tested; erasure for new tables (leads, assets, tokens, audiences, ad media) implemented
- [ ] Data Use Checkup answers consistent with `data-handling.md`; the Meta app secret reset (spec 8.1 item 7)
- [ ] App is Live; webhook callback URLs verified
- [ ] Submit pressed (drafts are not reviewed)
