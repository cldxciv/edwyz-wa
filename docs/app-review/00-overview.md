# Meta App Review overview: Edwyz API (App ID 1799953191201553)

Date: 2026-10-27. Status of each permission is in `status.md`. Meta-specific names and rules here are best knowledge; items marked VERIFY must be re-checked in the App Dashboard before each submission.

## Submission order

1. **Phase A part 1 (already submitted, in review):** `whatsapp_business_messaging`, `whatsapp_business_management`. Wait for the result. If Meta asks for more evidence, use `whatsapp-production-readiness.md` (reviewer account, test number, screencast scripts, production checklist).
2. **Phase A part 2:** `business_management`, `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `pages_manage_ads`, `ads_management`, `ads_read`, `leads_retrieval`, plus the Marketing API access tier and the `leadgen` webhook. Submit only after Connect, Campaign Launcher, Lead Hub and Insights work end to end on a test Page and test ad account. **Not built today.**
3. **Phase B:** `pages_manage_posts`, `instagram_content_publish` (with `instagram_basic`), Conversions API access. After Creative Studio and publishing work. `pages_manage_engagement`, `read_insights` and `instagram_manage_insights` are NOT requested: no code uses them (see `status.md`, alignment table). Add each, with its review document, only in the change that ships the feature.
4. **Phase C:** `pages_messaging`, `instagram_manage_messages`, `instagram_manage_comments`, `catalog_management`, Threads permissions. Last.

Never submit a permission whose feature is not live. Do not mix phases in one submission. One app versus two is an open owner decision (spec section 4).

## What Meta checks

- Business Verification approved (done).
- App settings: icon, category, privacy URL https://wa.edwyz.com/privacy , terms https://wa.edwyz.com/terms , deletion callback https://wa.edwyz.com/api/meta/data-deletion , instructions https://wa.edwyz.com/data-deletion . Pages must load without login.
- Per permission: a written use case, a screencast showing the permission actually used, and working test credentials.
- That each requested permission is necessary and the data use matches the stated purpose.
- Data Use Checkup answers (see `data-handling.md`) and that the live privacy policy covers the new data.
- App in Live mode.

## Test account and test asset setup

1. Create a review user in Edwyz WA (owner of a dedicated workspace "Meta Review") with a simple password and no 2FA. Put credentials in the review notes only.
2. Add a Facebook test user (or a real tester added under App roles) who administers: a test Page, a test Instagram professional account linked to it, a test ad account with a payment method and a low cap, a test lead form, and a test catalog.
3. Connect a test WhatsApp number with an approved template and an opted-in test contact.
4. Keep a phone logged in to WhatsApp, Messenger and Instagram test accounts for the receiving side.
5. Seed the workspace with test data only. Confirm no real customer appears.
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
| Feature not available or not built | Do not submit unbuilt phases (see status.md) |
| Asking for more than needed | Only the permissions in the spec; read-only features do not request write permissions |
| Data use not explained | Use-case text states read/write, storage, retention and who sees it |
| Privacy policy or deletion missing or mismatched | Pages live; update them for ads, leads and Page data before Phase A part 2 |
| Broken pages or errors in the demo | Rehearse on the live URL |
| Demo uses real personal data | Test data only |
| Ad spend risk | Campaigns created paused, explicit Launch, cap enforced |
| Hidden behaviour | Show the "what we can access" list and the audit log |

## Pre-submission checklist

- [ ] Feature built and rehearsed end to end on the live URL
- [ ] Permission name confirmed in the dashboard (VERIFY Instagram family)
- [ ] Use-case text pasted and under 1000 characters
- [ ] Screencast recorded, captioned, URL visible, no secrets
- [ ] Test credentials tested from a clean browser
- [ ] Test Page, Instagram account, ad account, lead form, catalog ready and roles granted
- [ ] Privacy policy and terms updated for the phase (`src/lib/legal.ts`, bump version) and lawyer-reviewed (`docs/legal-review-notes.md`)
- [ ] Deletion callback tested; erasure for new tables (leads, assets, tokens) implemented
- [ ] Data Use Checkup answers consistent with `data-handling.md`
- [ ] App is Live; webhook callback URLs verified
- [ ] Submit pressed (drafts are not reviewed)
