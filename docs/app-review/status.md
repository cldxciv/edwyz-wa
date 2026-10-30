# App Review readiness status (checked against the repo on 2026-10-27, after the data-governance pass)

Evidence: the growth modules now exist in code. `src/lib/meta-connect` (connect, discovery, token health, `scopes.ts` with the 11 requested scopes), `src/lib/ads` (launcher with caps and confirm, insights), `src/lib/leads`, `src/lib/content`, `src/lib/conversions`, `src/lib/approvals`, `src/lib/creative`, `src/lib/optimizer`, with routes under `src/app/api/{meta-connect,ads,leads,content,conversions,approvals,creative,optimizer}`, the leadgen webhook at `src/app/webhooks/leads`, and app pages under `src/app/(app)/app/{ads,leads,content,creative}` and `settings/connections`. "Code present" below means the code is in the repo with unit tests; it does not mean it was exercised against live Meta with the review user, which still has to be done and screen-recorded before each submission. Re-run this check before each submission.

| Permission | Phase | Built | Missing before submission |
|---|---|---|---|
| whatsapp_business_messaging | A | Yes (inbox, broadcasts, chatbots) | Awaiting review result. Resubmission package, reviewer login steps and screencast script: `whatsapp-production-readiness.md` |
| whatsapp_business_management | A | Yes (embedded signup, reconnect, templates) | Awaiting review result. Same package as above |
| business_management | A | Code present (connect flow, asset discovery, Connections page) | Live test with review user, screencast |
| pages_show_list | A | Code present (asset discovery) | Live test, screencast |
| pages_read_engagement | A | Code present (post picker, engagement reads) | Live test, screencast |
| pages_manage_metadata | A | Code present (leadgen webhook route) | Page webhook subscription verified live, screencast |
| pages_manage_ads | A | Code present (Campaign Launcher, lead form handling) | Live test, screencast |
| ads_management | A | Code present (caps, paused creation, confirm step) | Live test with a test ad account, screencast |
| ads_read | A | Code present (ad account insights `act_*/insights`, the only insights the app reads) | Live test, screencast |
| leads_retrieval | A | Code present (Lead Hub, leadgen ingestion, follow-up) | Live test with a real test lead, screencast |
| pages_manage_posts | B | Code present (content calendar and publisher: `{page}/feed`, `/photos`, `/videos`) | Live test, screencast |
| instagram_content_publish (+ instagram_basic) | B | Code present | Choose Facebook vs Instagram Login family, live test |
| read_insights | B | **Not requested.** No code reads Page insights, so it is not in `scopes.ts` | Add to `scopes.ts` and the Meta configuration in the same change that ships Page insights |
| instagram_manage_insights | B | **Not requested.** No code reads Instagram insights, so it is not in `scopes.ts`. `docs/app-review/instagram_manage_insights.md` stays a plan only | Add with the feature, then live test and screencast |
| pages_manage_engagement | B (spec) | **Not requested.** No comment moderation exists, so it is not in `scopes.ts` | Add with the comment-moderation feature |
| Conversions API for messaging | B | Code present (`src/lib/conversions`) | Live test with a dataset; no doc file yet |
| pages_messaging | C | No | Unified inbox channels. DO NOT SUBMIT until built |
| instagram_manage_messages | C | No | Same. DO NOT SUBMIT until built |
| instagram_manage_comments | C | No | Comment moderation. DO NOT SUBMIT until built |
| catalog_management | C | Partial (Shopify catalog sync in `src/lib/commerce`; not a Meta catalog scope in `scopes.ts`) | Not requested; DO NOT SUBMIT until built and in scopes |
| threads_basic / threads_content_publish | C | No | No doc file; add when planned |

## Data governance (done in this pass)

- Privacy policy (v1.1, 27 October 2026) and terms now cover Facebook Page, Instagram, ad account, lead-ad, ad performance, AI processing (Anthropic), Shopify data and the retention periods.
- `src/lib/lifecycle/personal-data.ts` lists every table that holds tenant data, with retention and erasure rules; a unit test fails when a model with a `tenantId` column is not listed.
- Workspace erasure (`eraseWorkspaceData`) exists and is available to platform admins in the console (type the workspace slug).
- The Meta data-deletion callback now erases the Facebook user's Meta connection and what came only from it, and completes the request; a worker sweep retries failures.
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

Removed from the request list in this pass: `read_insights` and `instagram_manage_insights` (no call uses them). The permissions a token carries come from the Login for Business configuration in the Meta dashboard, not from this file: an operator must also remove these two there, then reconnect. The Connections page flags them as "not used" until that is done.
