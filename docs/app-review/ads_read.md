# ads_read

Phase: A
Feature built: **NOT BUILT**

> DO NOT SUBMIT until built. Phase A routes under /app/ads, /app/leads and /app/settings/connections do not exist in the repo as of 2026-10-27. Reviewers reject demos of flows that do not exist. The text below is the plan; re-check against the final UI.

VERIFY: permission names and the Instagram family (Facebook Login vs Instagram Login) in the App Dashboard permissions list at submission time.

## What it is for, in plain words

Lets the app read ad performance (spend, results, cost per result) to show dashboards and suggest changes.

## Use-case description (paste into the review form)

Edwyz Growth reads campaign, ad set and ad insights (spend, impressions, clicks, results, frequency) for connected ad accounts on a schedule and shows them in the Insights dashboard and to the Optimiser, which only proposes changes for a human to approve. We read; we do not write with this permission. Daily snapshots are stored in the workspace for the life of the connection plus 90 days after disconnect, then deleted (VERIFY: confirm retention value before submission). Visible to workspace members. Not shared or sold.

Length: 524 characters (limit 1000).

## Screencast script

Record at 1080p with the browser URL bar visible. No narration of secrets. Captions or voice-over naming each step.

1. Sign in; show connect dialog earlier.
2. Open Ads > Insights (planned /app/ads/insights).
3. Show the date range, spend, results and per-campaign table loading from the test account.
4. Open the Optimiser page and show a proposal citing the data; do not approve.
5. Disconnect; show data removed or scheduled for deletion.
6. Show /data-deletion.

## What the reviewer needs (put in review notes)

- Test ad account with at least a few days of delivery or sample insights.
- Links: https://wa.edwyz.com/privacy , https://wa.edwyz.com/terms , https://wa.edwyz.com/data-deletion

## What NOT to show

- Other accounts' spend, real client names.
- Env files, terminal windows, server logs, the browser dev tools, other tabs.
