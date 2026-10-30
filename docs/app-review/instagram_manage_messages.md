# instagram_manage_messages

Phase: C
Feature built: **NOT BUILT**

> DO NOT SUBMIT until built. Phase A routes under /app/ads, /app/leads and /app/settings/connections do not exist in the repo as of 2026-10-27. Reviewers reject demos of flows that do not exist. The text below is the plan; re-check against the final UI.

VERIFY: permission names and the Instagram family (Facebook Login vs Instagram Login) in the App Dashboard permissions list at submission time.

## What it is for, in plain words

Lets the app read and reply to Instagram DMs in the shared inbox. VERIFY: Instagram Login uses instagram_business_manage_messages.

## Use-case description (paste into the review form)

The Unified Inbox lets a business read and reply to Instagram direct messages to its professional account. We read message content and sender ID and write replies within the allowed messaging window. Messages are stored in the workspace until the business deletes them or the workspace, visible to its team. Not shared or sold.

Length: 327 characters (limit 1000).

## Screencast script

Record at 1080p with the browser URL bar visible. No narration of secrets. Captions or voice-over naming each step.

1. Sign in; show connect dialog.
2. Send a DM to the test account.
3. Show it in Inbox, reply, show received.
4. Delete contact; disconnect; show deletion.

## What the reviewer needs (put in review notes)

- Test Instagram professional account and a second test account.
- Links: https://wa.edwyz.com/privacy , https://wa.edwyz.com/terms , https://wa.edwyz.com/data-deletion

## What NOT to show

- Real DMs.
- Env files, terminal windows, server logs, the browser dev tools, other tabs.
