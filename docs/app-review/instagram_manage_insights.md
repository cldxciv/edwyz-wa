# instagram_manage_insights

Phase: B
Feature built: **NOT BUILT. Not requested.**

> DO NOT SUBMIT and do not add to `src/lib/meta-connect/scopes.ts` or the Login for Business configuration until Instagram insights are built: no code calls these APIs. The text below is the plan; re-check against the final UI.

VERIFY: permission names and the Instagram family (Facebook Login vs Instagram Login) in the App Dashboard permissions list at submission time.

## What it is for, in plain words

Lets the app read reach, impressions and engagement for Instagram posts and the account. VERIFY: Instagram Login uses instagram_business_manage_insights.

## Use-case description (paste into the review form)

Edwyz Growth reads Instagram account and media insights (reach, impressions, engagement) for the connected professional account and shows them next to ad results and in best-time-to-post suggestions. We read only. Snapshots are stored per workspace until disconnect plus a short grace period, then deleted (VERIFY retention). Visible to workspace members. Not shared or sold.

Length: 375 characters (limit 1000).

## Screencast script

Record at 1080p with the browser URL bar visible. No narration of secrets. Captions or voice-over naming each step.

1. Sign in; show connect dialog.
2. Open Insights > Organic.
3. Show account metrics and one post's metrics.
4. Show best-time suggestion that uses them.
5. Disconnect; show deletion.

## What the reviewer needs (put in review notes)

- Test Instagram professional account with a few posts.
- Links: https://wa.edwyz.com/privacy , https://wa.edwyz.com/terms , https://wa.edwyz.com/data-deletion

## What NOT to show

- Follower personal data from real accounts.
- Env files, terminal windows, server logs, the browser dev tools, other tabs.
