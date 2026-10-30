# catalog_management

Phase: C
Feature built: **NOT BUILT**

> DO NOT SUBMIT until built. Phase A routes under /app/ads, /app/leads and /app/settings/connections do not exist in the repo as of 2026-10-27. Reviewers reject demos of flows that do not exist. The text below is the plan; re-check against the final UI.

VERIFY: permission names and the Instagram family (Facebook Login vs Instagram Login) in the App Dashboard permissions list at submission time.

## What it is for, in plain words

Lets the app read and update the business's product catalog for product ads.

## Use-case description (paste into the review form)

Edwyz Growth reads the connected catalog's products and sets, syncs product data from the business's store, and uses a product set in dynamic product ads. We read and write products and sets in the customer's catalog. Product data is stored in the workspace until disconnect or deletion, visible to workspace admins. Not shared or sold.

Length: 336 characters (limit 1000).

## Screencast script

Record at 1080p with the browser URL bar visible. No narration of secrets. Captions or voice-over naming each step.

1. Sign in; show connect dialog.
2. Open Catalog; show products loaded.
3. Edit one product and sync; show it changed in Commerce Manager.
4. Create a product set and use it in a campaign draft.
5. Disconnect; show deletion.

## What the reviewer needs (put in review notes)

- Test catalog with a few test products.
- Links: https://wa.edwyz.com/privacy , https://wa.edwyz.com/terms , https://wa.edwyz.com/data-deletion

## What NOT to show

- Real inventory or prices.
- Env files, terminal windows, server logs, the browser dev tools, other tabs.
