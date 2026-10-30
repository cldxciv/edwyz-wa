# instagram_content_publish (with instagram_basic)

Phase: B
Feature built: **NOT BUILT**

> DO NOT SUBMIT until built. Phase A routes under /app/ads, /app/leads and /app/settings/connections do not exist in the repo as of 2026-10-27. Reviewers reject demos of flows that do not exist. The text below is the plan; re-check against the final UI.

VERIFY: permission names and the Instagram family (Facebook Login vs Instagram Login) in the App Dashboard permissions list at submission time.

## What it is for, in plain words

Lets the app publish photos and Reels to the business's Instagram professional account. VERIFY: with Instagram Login use instagram_business_basic and instagram_business_content_publish instead.

## Use-case description (paste into the review form)

Edwyz Growth's Content Calendar publishes approved images and Reels to the connected Instagram professional account. We write media containers and publish them, and read the account ID, username and media status. Content and schedule are stored in the workspace until deleted by the business. Visible to workspace editors. Posts go out only after a user schedules or publishes. Not shared or sold.

Length: 397 characters (limit 1000).

## Screencast script

Record at 1080p with the browser URL bar visible. No narration of secrets. Captions or voice-over naming each step.

1. Sign in; show Instagram connect dialog with permission.
2. Content calendar: create an Instagram post with test image.
3. Publish; show it on the Instagram profile.
4. Delete from our UI; disconnect; show deletion.

## What the reviewer needs (put in review notes)

- Test Instagram professional account linked to a test Page (for the Facebook Login family) or testable under Instagram Login.
- Links: https://wa.edwyz.com/privacy , https://wa.edwyz.com/terms , https://wa.edwyz.com/data-deletion

## What NOT to show

- Personal Instagram accounts.
- Env files, terminal windows, server logs, the browser dev tools, other tabs.
