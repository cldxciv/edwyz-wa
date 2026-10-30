# business_management

Phase: A
Feature built: **NOT BUILT**

> DO NOT SUBMIT until built. Phase A routes under /app/ads, /app/leads and /app/settings/connections do not exist in the repo as of 2026-10-27. Reviewers reject demos of flows that do not exist. The text below is the plan; re-check against the final UI.

VERIFY: permission names and the Instagram family (Facebook Login vs Instagram Login) in the App Dashboard permissions list at submission time.

## What it is for, in plain words

Lets the app see which business portfolio, Pages, ad accounts, catalogs and datasets the customer owns, so the customer can pick what to connect.

## Use-case description (paste into the review form)

Edwyz Growth lets a business connect its Meta assets in one flow. After Facebook Login for Business, we call the Business API to list the business portfolios the user belongs to and the Pages, ad accounts, datasets and catalogs inside them, so the user can choose which to connect. We read asset IDs and names; we write nothing. IDs and names are stored in the workspace until the user disconnects, then deleted. Only the workspace's admins see them. We do not use this data for any other purpose.

Length: 497 characters (limit 1000).

## Screencast script

Record at 1080p with the browser URL bar visible. No narration of secrets. Captions or voice-over naming each step.

1. Sign in at https://wa.edwyz.com/login.
2. Open Settings > Connections (planned route /app/settings/connections). Click Connect with Facebook.
3. Show the Login for Business dialog with the business portfolio and asset selection and the permission list visible.
4. After redirect, show the discovered assets list: portfolio, Pages, ad accounts, datasets.
5. Select assets and save; show 'what we can access' list.
6. Click Disconnect, confirm, show assets gone. Show /data-deletion.

## What the reviewer needs (put in review notes)

- Test Facebook user with a business portfolio containing a test Page and test ad account, added as app tester/role.
- Business Verification already approved.
- Links: https://wa.edwyz.com/privacy , https://wa.edwyz.com/terms , https://wa.edwyz.com/data-deletion

## What NOT to show

- Other portfolios of the reviewer's account, real ad accounts, tokens.
- Env files, terminal windows, server logs, the browser dev tools, other tabs.
