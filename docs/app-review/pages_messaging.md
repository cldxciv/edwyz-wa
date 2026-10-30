# pages_messaging

Phase: C
Feature built: **NOT BUILT**

> DO NOT SUBMIT until built. Phase A routes under /app/ads, /app/leads and /app/settings/connections do not exist in the repo as of 2026-10-27. Reviewers reject demos of flows that do not exist. The text below is the plan; re-check against the final UI.

VERIFY: permission names and the Instagram family (Facebook Login vs Instagram Login) in the App Dashboard permissions list at submission time.

## What it is for, in plain words

Lets the app receive and reply to Messenger conversations with the Page in the shared inbox.

## Use-case description (paste into the review form)

The Unified Inbox lets a business read and reply to Messenger messages sent to its connected Page. We read message content, sender PSID and name, and write replies, only within Messenger's allowed messaging window. Messages are stored in the workspace until the business deletes the contact or workspace and are visible to its team. Not shared or sold.

Length: 352 characters (limit 1000).

## Screencast script

Record at 1080p with the browser URL bar visible. No narration of secrets. Captions or voice-over naming each step.

1. Sign in; show connect dialog.
2. Message the test Page from a test Messenger account.
3. Show it arrive in Inbox with channel Messenger.
4. Reply and show it received.
5. Delete the contact; disconnect; show deletion.

## What the reviewer needs (put in review notes)

- Test Page, test Messenger user with a tester role.
- Links: https://wa.edwyz.com/privacy , https://wa.edwyz.com/terms , https://wa.edwyz.com/data-deletion

## What NOT to show

- Real customer messages.
- Env files, terminal windows, server logs, the browser dev tools, other tabs.
