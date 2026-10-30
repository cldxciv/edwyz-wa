# instagram_manage_comments

Phase: C
Feature built: **NOT BUILT**

> DO NOT SUBMIT until built. Phase A routes under /app/ads, /app/leads and /app/settings/connections do not exist in the repo as of 2026-10-27. Reviewers reject demos of flows that do not exist. The text below is the plan; re-check against the final UI.

VERIFY: permission names and the Instagram family (Facebook Login vs Instagram Login) in the App Dashboard permissions list at submission time.

## What it is for, in plain words

Lets the app read, reply to, hide and delete comments on the business's Instagram posts. VERIFY: Instagram Login uses instagram_business_manage_comments.

## Use-case description (paste into the review form)

The Unified Inbox shows comments on the connected Instagram account's posts so the team can reply, hide or delete them. We read comment text, author handle and post ID, and write replies and hide or delete actions. Comments are stored in the workspace until the business deletes them or the workspace. Visible to its team. Not shared or sold.

Length: 342 characters (limit 1000).

## Screencast script

Record at 1080p with the browser URL bar visible. No narration of secrets. Captions or voice-over naming each step.

1. Sign in; show connect dialog.
2. Comment on a test post from a test account.
3. Show it in the Inbox comments view; reply; hide.
4. Show the result on Instagram.
5. Disconnect; show deletion.

## What the reviewer needs (put in review notes)

- Test Instagram account with a test post.
- Links: https://wa.edwyz.com/privacy , https://wa.edwyz.com/terms , https://wa.edwyz.com/data-deletion

## What NOT to show

- Real commenters.
- Env files, terminal windows, server logs, the browser dev tools, other tabs.
