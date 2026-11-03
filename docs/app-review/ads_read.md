# ads_read

Phase: A (draft, not submitted; request 1799953447868194)
Feature built: **Built**: results by placement, by version and by creative on the campaign page at /app/ads/[id], the review status timeline on the same page, Insights at /app/ads/insights and the Optimiser at /app/ads/optimizer (`src/lib/ads/insights-fetch.ts`, `act_*/insights`; `src/lib/promote/breakdowns.ts`, `src/lib/promote/review.ts`). Not yet exercised against live Meta with the review user.

> Built; needs a live test and the screencasts below. Before submitting: run the flows with the review user on the test assets, record the screencasts, make the API test calls in the App Dashboard, and re-check the text against the final UI. The request is a draft (1799953447868194, not submitted); state in `status.md`.

VERIFY: permission names and the Instagram family (Facebook Login vs Instagram Login) in the App Dashboard permissions list at submission time.

## What it is for, in plain words

Lets the app read how the business's ads are doing (spend, results, where they ran) and whether Meta approved them, so the owner sees it in plain words in Edwyz.

## Use-case description (paste into the review form)

Edwyz reads the results of the ads a business runs from its connected ad account and shows them in plain words: spend, results and cost per result for each campaign, split by where the ad ran (Instagram Reels, Instagram feed, Facebook feed and so on) and by version, plus leads per platform. We also read each ad's review status and Meta's feedback, so the owner sees "Meta is reviewing", "Running" or why an ad was not approved, and read reach estimates, minimum budgets, ad previews and the account's health (whether a payment method exists, never its details). We only read with this permission. Daily results are stored in the workspace for the life of the connection plus 90 days after disconnect, then deleted (VERIFY: confirm retention value before submission). Visible to workspace members. Not shared or sold.

Length: 818 characters (limit 1000).

## Screencast scripts

Two short videos (spec 8.2). Record at 1080p with the browser URL bar visible. No narration of secrets. Captions or voice-over naming each step. Each starts with the shared opening in `00-overview.md` and ends with Disconnect and the data deletion page.

### Video 1: results by placement

1. Ads: open a campaign that has run for a few days on the test account.
2. The **Results** section shows chats (or leads) and the cost per result for the chosen dates, then **Where it ran**: bars for Instagram Reels, Instagram feed, Instagram Stories, Facebook feed, with the cost per result of each. Point at the bar Meta spent most on.
3. **Leads by platform** (for a lead ad): Instagram and Facebook counts, and organic leads apart.
4. If the campaign compares versions, the **Compare versions** card shows each version's cost per result and whether it is too early to tell.
5. Open Ads > Insights (/app/ads/insights): the same account's totals by campaign. Show the Optimiser (/app/ads/optimizer) proposing a change citing these numbers; do not approve it.

### Video 2: the review status timeline

1. Start a boost (as in `ads_management.md` video 1). The campaign page shows the timeline: "Getting ready", then "Meta is reviewing".
2. Refresh after Meta's review: "Running" with the time Meta approved it.
3. Show a campaign with an ad Meta did not approve (on the test account, an ad whose text breaks a policy on purpose): the timeline says "Not approved: {Meta's reason in plain words}", with **Fix the ad**, **Ask Meta to review again** (it opens Meta's Account Quality, labelled "Opens Meta") and **Pause and free ₹...** to release the money set aside for it.
4. Tap **Pause and free ₹...**; the limit line shows the money back.

## What the reviewer needs (put in review notes)

- A test ad account with at least a few days of delivery or sample insights, one approved ad and one not approved.
- Links: https://wa.edwyz.com/privacy , https://wa.edwyz.com/terms , https://wa.edwyz.com/data-deletion

## What NOT to show

- Other accounts' spend, real client names.
- Env files, terminal windows, server logs, the browser dev tools, other tabs.
