# App Review status (checked 2026-10-30 against the Meta App Dashboard and the repo)

## Where the submission stands

- **Nothing is in review.** The App Review request is an unsubmitted **draft**: submission id 1799953447868194 (App Dashboard > App Review > Requests), app "Edwyz API" (App ID 1799953191201553). It holds 22 items.
- **Owner decision (2026-10-30): keep all 22 items** ("do not remove, we need all of them"). Each must be backed by a built feature, a screencast and API test calls before Submit. Meta keeps Submit disabled until every item has its description, screencast, test calls and ticked agreement, so one unfinished item holds back the whole draft, including the two WhatsApp items that are ready.
- **Done on the draft (2026-10-30):** `whatsapp_business_messaging` and `whatsapp_business_management`: description and business description filled, screencasts recorded (with ffmpeg) and uploaded, API test calls completed. Meta suggests the screencast also shows the OAuth (Embedded Signup) flow; an extra clip was offered.
- **Done on the draft later that day (part 1):** descriptions written for the nine ads and Pages items (eight are named in the table below; the record does not name the ninth, so check it in the dashboard). Data handling filled in, except question requests-4 (the owner's policies). Reviewer instructions written, with `[OWNER: ADD REVIEWER EMAIL/PASSWORD]` placeholders where the login goes. Site URL changed to https. The 10 items with no feature yet have no description.
- **Left on the draft for the owner:** tick "I agree" on each item. Data handling: one answer left (requests-4, the owner's policies; draft answers in `data-handling.md`). Reviewer instructions: replace the `[OWNER: ADD REVIEWER EMAIL/PASSWORD]` placeholders with the review user's login (no 2FA). The OAuth (Embedded Signup) clip for the WhatsApp items. One screencast for the nine ads and Pages items, which needs a daily ads limit set, an ad account with a payment method that is not read-only, an Instant Form and a test lead. The 10 items with no feature yet.
- **Not in the draft, but used by the code:** `pages_manage_posts` and `instagram_content_publish` (the content calendar, `src/lib/content`). Meta offers them only once they are added to the app's Page and Instagram use cases (and to the Login for Business configuration); until then the connect dialog cannot grant them, so the content calendar cannot publish. Add them there, then to the draft.
- **Separate from App Review:** Tech Provider access verification shows "In review" (since 27 October); Business Verification is approved.
- **Effect until advanced access is granted:** only Facebook accounts with a role on the app (admin, developer, tester) can connect a WhatsApp number. Anyone else gets "Feature unavailable" from Embedded Signup, so no paying customer can onboard yet. Add people who must connect before then as app testers in Meta Business Suite.

The full list of the 22 items is kept in the dashboard, not in this repo. In the "In the draft" column, "Yes" is confirmed by the 2026-10-30 record, "No" means the code uses the permission but the draft does not request it, and "Check" means the record does not name the item: look it up in the dashboard and copy the full list here at the next check.

## Per-item readiness

"Built" means the feature is in the repo with unit tests and reachable in the app at the route named; it does not mean it was exercised against live Meta with the review user, which every item still needs before its screencast. "Not built" items have no code at all: per the owner's decision they stay in the draft and are built before Submit.

| Item | In the draft | Built | Screencast and test calls | Next step |
|---|---|---|---|---|
| whatsapp_business_messaging | Yes | Yes: inbox (/app/inbox), broadcasts, chatbots, rules, API | Uploaded; test calls completed | Tick "I agree". Package: `whatsapp-production-readiness.md` |
| whatsapp_business_management | Yes | Yes: Embedded Signup and reconnect (/app/settings/connect), templates (/app/templates) | Uploaded; test calls completed | Tick "I agree" |
| business_management | Yes (description written) | Yes: Connections (/app/settings/connections): connect, asset discovery, disconnect | Not yet (one video covers the nine ads and Pages items) | Live test with the review user, screencast, test calls |
| pages_show_list | Yes (description written) | Yes: Page list in asset discovery (Connections) | Not yet | Same |
| pages_read_engagement | Yes (description written) | Yes: Page details, Instagram account lookup, post picker in the campaign wizard (/app/ads/new) | Not yet | Same |
| pages_manage_metadata | Yes (description written) | Yes: lead alerts (`{page}/subscribed_apps`, shown as "Lead alerts on" in Connections) | Not yet | Verify the Page webhook subscription live, screencast |
| pages_manage_ads | Yes (description written) | Yes: Campaign Launcher (/app/ads/new), lead forms (/app/leads/forms) | Not yet | Live test, screencast |
| ads_management | Yes (description written) | Yes: campaigns created paused, explicit Launch, budget caps (/app/ads) | Not yet | Live test with a test ad account (payment method, not read-only, daily ads limit set), screencast |
| ads_read | Yes (description written) | Yes: ad account insights (/app/ads/insights) and the Optimiser (/app/ads/optimizer) | Not yet | Live test, screencast |
| leads_retrieval | Yes (description written) | Yes: Lead Hub (/app/leads), leadgen webhook, follow-ups (/app/leads/sequences) | Not yet | Live test with an Instant Form and a test lead, screencast |
| pages_manage_posts | No: used by `src/lib/content` but not requested; add to the draft | Yes: content calendar and publisher (/app/content) | Not yet | Add it to the app's Page use case, then to the draft; live test, screencast |
| instagram_content_publish (+ instagram_basic) | No: used by `src/lib/content` but not requested; add to the draft | Yes: content calendar (/app/content) | Not yet | Choose the Facebook or Instagram Login family, add it to the app's Instagram use case, then to the draft (check `instagram_basic` there too); live test |
| Conversions API for messaging | Check | Yes: /app/conversions (`src/lib/conversions`) | Not yet | Live test with a dataset; no doc file yet |
| pages_messaging | Check | Not built | Not possible yet | Build the Messenger inbox channel |
| instagram_manage_messages | Check | Not built | Not possible yet | Build the Instagram inbox channel |
| instagram_manage_comments | Check | Not built | Not possible yet | Build comment moderation |
| catalog_management | Check | Not built as a Meta catalog feature (the Shopify catalog sync in `src/lib/commerce` uses no Meta catalog scope) | Not possible yet | Build Meta catalog management and add the scope to `scopes.ts` |
| threads_basic / threads_content_publish | Check | Not built | Not possible yet | Build Threads publishing; no doc file yet |
| Live Video API | Yes | Not built | Not possible yet | Build; no doc file yet |
| Fundraisers | Yes | Not built | Not possible yet | Build; no doc file yet |
| Branded content (partnership ads) | Yes | Not built | Not possible yet | Build; no doc file yet |
| Ads MCP | Yes | Not built | Not possible yet | Build; no doc file yet |
| read_insights, instagram_manage_insights, pages_manage_engagement | Not requested | No code reads Page or Instagram insights and there is no comment moderation, so they are not in `scopes.ts` | | Add each with its feature and review document (`instagram_manage_insights.md` stays a plan) |

The Login for Business configuration "Edwyz Connect Pages IG Ads" (META_LOGIN_CONFIG_ID) still carries extra permissions beyond `scopes.ts`; trim them in the dashboard before the Pages, Instagram and ads items are recorded, or the Connections page flags them as "not used".

## Data governance (done 2026-10-27)

- Privacy policy (v1.1, 27 October 2026) and terms cover Facebook Page, Instagram, ad account, lead-ad, ad performance, AI processing (Anthropic), Shopify data and the retention periods.
- `src/lib/lifecycle/personal-data.ts` lists every table that holds tenant data, with retention and erasure rules; a unit test fails when a model with a `tenantId` column is not listed.
- Workspace erasure (`eraseWorkspaceData`) exists and is available to platform admins in the console (type the workspace slug).
- The Meta data-deletion callback erases the Facebook user's Meta connection and what came only from it, and completes the request; a worker sweep retries failures.
- Retention jobs exist for insights, conversion events, approvals, finished chatbot sessions, usage records, leads, abandoned carts and webhook deliveries, plus orphan creative file cleanup.

## Cross-cutting gaps

1. Hosting region and grievance officer not set in `src/lib/legal.ts`; lawyer review of the updated pages pending.
2. A data processing agreement with Anthropic (and named hosting and email providers) is not on file; the policy names Anthropic.
3. Review user and test assets (Page, ad account, lead form, catalog) still to be seeded, and the live end-to-end runs and screencasts recorded.
4. Invoice and payment record retention period not confirmed with an accountant (kept, no deletion job).
5. Pending owner decision: one app or two.
6. Erasure leaves the Meta Page webhook subscription as is (the token is revoked, so Meta stops delivering); unsubscribe explicitly if Meta asks for it.

## Permission versus code alignment (2026-10-27, growth-limits pass)

Rule: `src/lib/meta-connect/scopes.ts` lists a permission only when code calls an API that needs it. Checked by `tests/usage-scopes-alignment.test.ts`.

| Permission | Code that needs it |
|---|---|
| business_management | `me/businesses`, `owned_product_catalogs` (asset discovery) |
| ads_management | campaign, ad set, creative and ad creation and status changes (`src/lib/ads`) |
| ads_read | `act_*/insights`, `me/adaccounts`, `adspixels` |
| pages_show_list, pages_read_engagement | `me/accounts` with `instagram_business_account` (asset discovery) |
| pages_manage_ads | ads and lead forms run from a Page |
| pages_manage_metadata | `{page}/subscribed_apps` (leadgen) |
| leads_retrieval | `GET {leadgen_id}` (`src/lib/leads/ingest.ts`) |
| pages_manage_posts | Page publishing (`src/lib/content/publishers.ts`) |
| instagram_basic, instagram_content_publish | `{ig}/media`, `media_publish`, `content_publishing_limit` |

Removed from the request list in that pass: `read_insights` and `instagram_manage_insights` (no call uses them). The permissions a token carries come from the Login for Business configuration in the Meta dashboard, not from this file: an operator must also remove these two there, then reconnect. The Connections page flags them as "not used" until that is done.
