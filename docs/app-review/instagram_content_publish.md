# instagram_content_publish (with instagram_basic)

Phase: B
Feature built: **Built**: the content calendar at /app/content (`{ig}/media`, `media_publish`; `src/lib/content`). Not yet exercised against live Meta with the review user.

> Built; needs a live test and a screencast. Before submitting: run the flow below with the review user on the test assets, record the screencast, make the API test calls in the App Dashboard, and re-check the text against the final UI. The request is a draft (1799953447868194, not submitted) and **does not include this permission yet**: add it to the app's Instagram use case, then to the draft. State in `status.md`.

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
