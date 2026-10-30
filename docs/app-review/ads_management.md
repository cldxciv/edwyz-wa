# ads_management

Phase: A
Feature built: **NOT BUILT**

> DO NOT SUBMIT until built. Phase A routes under /app/ads, /app/leads and /app/settings/connections do not exist in the repo as of 2026-10-27. Reviewers reject demos of flows that do not exist. The text below is the plan; re-check against the final UI.

VERIFY: permission names and the Instagram family (Facebook Login vs Instagram Login) in the App Dashboard permissions list at submission time.

## What it is for, in plain words

Lets the app create and change campaigns, ad sets and ads in the customer's ad account.

## Use-case description (paste into the review form)

Edwyz Growth's Campaign Launcher creates campaigns, ad sets and ads in the ad account the business connects, pauses and resumes them, and changes budgets after a human approves. We read and write campaign objects and write audit entries. Campaigns are created paused; nothing spends until an owner or admin confirms Launch, and a hard daily budget cap is enforced. Object IDs and settings are stored in the workspace until disconnect or deletion and shown to workspace admins. Not shared or sold.

Length: 496 characters (limit 1000).

## Screencast script

Record at 1080p with the browser URL bar visible. No narration of secrets. Captions or voice-over naming each step.

1. Sign in; open Connections and show the connect dialog with ads_management listed.
2. Open Ads > New campaign; choose Lead generation; set budget below the shown cap.
3. Create; show the campaign PAUSED in our UI and in Ads Manager.
4. Click Launch, confirm; show status ACTIVE then pause it again from our UI.
5. Show the audit log entries.
6. Disconnect the ad account; show deletion of stored IDs.

## What the reviewer needs (put in review notes)

- Test ad account (sandbox or low-spend real), test Page and a creative image.
- Links: https://wa.edwyz.com/privacy , https://wa.edwyz.com/terms , https://wa.edwyz.com/data-deletion

## What NOT to show

- Any real customer's account, payment details, spend above test cap.
- Env files, terminal windows, server logs, the browser dev tools, other tabs.
