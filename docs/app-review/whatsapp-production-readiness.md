# WhatsApp App Review package: whatsapp_business_messaging and whatsapp_business_management

App: Edwyz API (App ID 1799953191201553). Business Verification: approved. Prepared 2026-10-27. Anything marked VERIFY depends on Meta's dashboard or policy wording and must be re-checked on the day of submission. Nothing in this file is recorded or created yet: the review user, the test number and the screencasts are tasks for the owner (checklist at the end).

The two permissions are submitted together because Embedded Signup asks for both and the screencasts overlap. Only describe features that exist in the repo today (list below). Do not mention Instagram, Messenger, ads or catalog features in these two submissions.

## What the app actually does with each permission (keep the review text to this)

| Permission | Used by | Calls |
|---|---|---|
| whatsapp_business_management | Embedded Signup pipeline (`src/lib/onboarding`), template management (`src/lib/templates`), number details refresh | `{waba}/phone_numbers`, `{waba}/subscribed_apps`, `{phone}/register`, `{phone}?fields=quality_rating,messaging_limit_tier,...`, `{waba}/message_templates` (list, create, delete) |
| whatsapp_business_messaging | Inbox, broadcasts, chatbots, rules, API | `{phone}/messages` (text, media, interactive, template), media download, webhook `messages` and `message_template_status_update` and `account_update` fields |

Features the reviewer can see: connect with Embedded Signup, reconnect with a fresh authorisation when the token expires or a person wants to renew, team inbox with the 24-hour window rule, approved templates outside the window, opted-in broadcasts, STOP handling, contact deletion and workspace deletion request. Not built and not to be shown: Messenger, Instagram messaging, comment moderation, catalog messages as a Meta feature.

## 1. Reviewer account (create before recording; put the details in the review notes only)

1. Sign up at https://wa.edwyz.com/signup with a dedicated mailbox (for example `meta-review@<owner domain>`). The signup creates the workspace and starts the trial; name the workspace "Meta Review".
2. Email verification is required before sends: open the verification mail and confirm, or on the server run `node scripts/verify-user.mjs meta-review@<owner domain>` (it sets `emailVerifiedAt` for that one user).
3. The user is the workspace owner. Do not turn on two-factor sign-in for it (reviewers cannot receive codes). Use a strong generated password, not a reused one; rotate it after the review.
4. Keep the trial or a paid plan active for the whole review period (a lapsed trial makes the workspace read-only and sends fail). Check Billing shows "Trial" with days left, or an active plan.
5. Do not use `scripts/seed-demo.mjs` for this account: its workspace has no WhatsApp token and cannot send. The review workspace must use the real connected test number below.
6. Put in the review notes: login URL https://wa.edwyz.com/login, the email and password, a one-line description ("Owner of workspace Meta Review; WhatsApp test number already connected"), the privacy URL https://wa.edwyz.com/privacy , terms https://wa.edwyz.com/terms and the deletion instructions https://wa.edwyz.com/data-deletion .

## 2. Test number and test contact

Pick one of these (VERIFY the current Meta wording in WhatsApp > API Setup in the app dashboard):

- **Meta test number (simplest for review).** In the app dashboard, WhatsApp > API Setup, use the provided test phone number and add up to five recipient phone numbers (the owner's phone and a second phone for the reviewer notes). This avoids a real customer-facing number. It can send only to those verified recipients and only its sample and your own approved templates.
- **A real spare number** that is not registered in the WhatsApp apps, connected through Embedded Signup by the owner. Better evidence for the screencast because the full signup runs; keep it for the review only.

Steps for either:

1. In Edwyz WA, as the review user, open Settings > Connect WhatsApp (`/app/settings/connect`) and complete Embedded Signup with the test WhatsApp Business Account. Wait for "WhatsApp is connected" and the number appearing with its quality rating and messaging limit. The page will say Meta needs a payment method on the WhatsApp account; for a test number Meta does not charge for test sends (VERIFY), for a real number add the payment method in WhatsApp Manager first or the send in the screencast will fail.
2. Templates (`/app/templates/new`): create one throwaway UTILITY template (for example `review_order_update`, body "Hello {{1}}, your order {{2}} is ready.") and one MARKETING template (`review_offer`, body "Hello {{1}}, we have a new offer for you."). Submit both and wait until their status shows approved. Approval can take minutes to hours; start a day before recording.
3. Contacts (`/app/contacts`): add two test contacts using phones you control. Contact A: opt-in recorded with a source such as "review demo form". Contact B: no opt-in. This shows the opt-in rule (marketing is refused for B). Never use real customers.
4. Phone: keep WhatsApp installed and logged in on the phone that is contact A, and have WhatsApp Web (or a screen recording of the phone) ready to show messages arriving.
5. Check the webhook: send a message from contact A to the connected number and confirm it appears in the inbox within a few seconds. If it does not, fix it before recording (`/health` shows the worker state; the worker daemon polls every 2 seconds, `docs/ops.md` 1.1).

## 3. Use-case text

Paste from `whatsapp_business_messaging.md` and `whatsapp_business_management.md` (each under 1000 characters). They must state: what is read, what is written, where it is stored, who sees it, how long it is kept, how it is deleted, that tokens are encrypted at rest, and that marketing is sent only to contacts who opted in, free-form replies only inside 24 hours, and a STOP reply stops all further messages.

## 4. Screencast script (one video per permission, 1080p, URL bar visible, English, under about three minutes; VERIFY current limits)

Rules: record only the browser window. Start logged out. Pause two seconds on every Meta dialog. Name each step in a caption. Show test data only. Never show tokens, the app secret, Meta's developer tools, a terminal, the API keys page or billing details.

### A. whatsapp_business_management

1. Browser at https://wa.edwyz.com/login. Sign in as the review user.
2. Open Settings > Connect WhatsApp. Caption: "Connect WhatsApp with Embedded Signup". Click Connect WhatsApp. Show the Facebook dialog and its permission list (pause), choose the test business account and number, finish.
3. Show the setup steps completing and the page saying the number is connected. Show the number, its display name, quality rating and messaging limit. Caption: "We read the account, the number, its quality rating and its messaging limit."
4. Reconnect: open "Connect again or use a different number", click Connect WhatsApp again, confirm, finish the dialog, show "WhatsApp is connected" again and the connection unchanged. Caption: "Reconnecting renews the access with a fresh authorisation; the number and chats stay."
5. Open Templates, then New template. Fill in the utility template, submit. Show it listed as pending, then (from the earlier approval) approved. Caption: "We create and list message templates."
6. Delete the throwaway marketing template and show it gone. Caption: "We delete templates the business no longer wants."
7. Show https://wa.edwyz.com/data-deletion and, in Billing, the "Delete your workspace" card (owners only; do not press its button). Caption: "A business can ask for its workspace and data to be deleted."

### B. whatsapp_business_messaging

1. Sign in as the review user (or continue the session).
2. Open Inbox. On the phone (contact A), send "Hi, is my order ready?" to the connected number. Show it arriving in the inbox, with the 24-hour window indicator showing open.
3. Type a reply and send. Show it delivered on the phone, and the sent/delivered ticks in the inbox.
4. Show a conversation whose window has closed (use an older test conversation) and that the free-text box is replaced by "send a template". Send the approved utility template from the template picker. Show it arriving on the phone. Caption: "Outside 24 hours only approved templates are sent."
5. Open Broadcasts > New. Choose the approved marketing template and the audience. Show that contact B (no opt-in) is not in the audience or is skipped, and that contact A is. Send. Show delivery status and the message on the phone. Caption: "Marketing messages go only to contacts who opted in."
6. On the phone reply STOP. Show the contact marked as opted out in Contacts and that a further broadcast skips it. Caption: "A STOP reply stops all further messages."
7. Open Contacts, open a test contact and delete it (confirm). Caption: "Message data can be deleted per contact."
8. Show https://wa.edwyz.com/privacy and /terms briefly.

## 5. What reviewers commonly reject for, and where we stand

| Risk | Our answer |
|---|---|
| Reviewer cannot sign in or the workspace is read-only | Section 1; check Billing shows an active trial or plan on the day |
| Screencast does not show the permission in use | Scripts show the Meta dialog, the API-backed feature, then the result on the phone |
| Message not delivered during the recording | Template approved beforehand; payment method present (real number); recipient verified (test number); rehearse the whole script |
| Messaging that looks like spam | Opt-in gating, STOP honoured, 24-hour rule, template-only outside the window (see `docs/ops.md` section 13) |
| Token or secret visible | Record only the browser; no dev tools |
| Privacy policy or deletion path missing | Pages are public; deletion callback https://wa.edwyz.com/api/meta/data-deletion |
| App not in Live mode | Switch to Live before submitting (VERIFY) |

## 6. Production readiness checklist (owner)

Infrastructure (each item has a script or a section in `docs/ops.md`; none is verified from this repo):

- [ ] Worker daemon running (`pm2 list` shows `edwyz-wa` and `edwyz-wa-worker`, one instance each); `/health` shows a recent `lastTickAgeSeconds`.
- [ ] Tick cron installed as the fallback (`/etc/cron.d/edwyz-wa`).
- [ ] Alert cron installed and `alert-wa.sh --test` logs a line; `ALERT_EMAIL` set if mail is wanted.
- [ ] Nightly backup running; `restore-check-wa.sh` printed PASS in the last month.
- [ ] `.env` and `DATA_DIR` copied off the server (the `ENCRYPTION_KEY` is the only way to read stored tokens).
- [ ] `scripts/check-env.mjs` reports no ERROR; `META_APP_SECRET`, `META_ES_CONFIG_ID` and `WORKER_SECRET` set.

Meta side:

- [ ] Webhook callback https://wa.edwyz.com/webhooks/whatsapp verified, fields subscribed: messages, message_template_status_update, message_template_quality_update (if used), account_update, phone_number_quality_update (VERIFY the field list).
- [ ] Embedded Signup configuration chosen: decide between the 60-day-expiry and non-expiring token; if expiring, owners get reconnect emails at 14 and 3 days (`docs/ops.md` section 12).
- [ ] App icon, category, privacy URL, terms URL, deletion callback and instructions URL set; app in Live mode (VERIFY).
- [ ] Review user created and verified, test number connected, two templates approved, contacts A and B created.
- [ ] Both screencasts recorded from the scripts above and watched once for leaks.
- [ ] Use-case texts pasted and under 1000 characters; review notes contain the login details.
- [ ] `docs/app-review/status.md` updated with the submission date.

Product behaviours the reviewer may probe, all covered by tests: 24-hour window enforced on send; marketing needs opt-in on every send path; STOP sets opt-out and stops sends; reconnect stores a new token; expired or revoked token shows a banner with a one-click reconnect and failed messages explain why.
