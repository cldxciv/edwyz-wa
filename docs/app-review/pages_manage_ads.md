# pages_manage_ads

Phase: A
Feature built: **NOT BUILT**

> DO NOT SUBMIT until built. Phase A routes under /app/ads, /app/leads and /app/settings/connections do not exist in the repo as of 2026-10-27. Reviewers reject demos of flows that do not exist. The text below is the plan; re-check against the final UI.

VERIFY: permission names and the Instagram family (Facebook Login vs Instagram Login) in the App Dashboard permissions list at submission time.

## What it is for, in plain words

Lets the app run ads from the business's Page, which Page-based ad creatives and lead forms require.

## Use-case description (paste into the review form)

Edwyz Growth creates ads that run as the connected Page and creates lead generation forms on that Page. We write ad creatives and lead forms linked to the Page, and read the form list. Created objects live on the customer's Meta account; we store their IDs in the workspace until the user disconnects or deletes the workspace. Ads are created paused and go live only after an owner or admin clicks Launch. Visible to workspace admins. Not shared or sold.

Length: 454 characters (limit 1000).

## Screencast script

Record at 1080p with the browser URL bar visible. No narration of secrets. Captions or voice-over naming each step.

1. Sign in; open Ads > New campaign.
2. Pick template Lead generation, choose the test Page and show the connection dialog earlier.
3. Create or choose a lead form for the Page.
4. Build the creative as the Page; click Create (paused). Show the PAUSED campaign in the list and in Meta Ads Manager.
5. Click Launch confirmation and show the audit entry.
6. Disconnect; show data deletion.

## What the reviewer needs (put in review notes)

- Test Page, test ad account with a payment method set up and a low daily cap.
- Links: https://wa.edwyz.com/privacy , https://wa.edwyz.com/terms , https://wa.edwyz.com/data-deletion

## What NOT to show

- Real ad spend over the cap, real customers' Pages.
- Env files, terminal windows, server logs, the browser dev tools, other tabs.
