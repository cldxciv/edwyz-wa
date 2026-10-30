# pages_read_engagement

Phase: A
Feature built: **NOT BUILT**

> DO NOT SUBMIT until built. Phase A routes under /app/ads, /app/leads and /app/settings/connections do not exist in the repo as of 2026-10-27. Reviewers reject demos of flows that do not exist. The text below is the plan; re-check against the final UI.

VERIFY: permission names and the Instagram family (Facebook Login vs Instagram Login) in the App Dashboard permissions list at submission time.

## What it is for, in plain words

Lets the app read Page details and post data that Page ads, lead forms and the Page webhook rely on.

## Use-case description (paste into the review form)

Edwyz Growth reads the connected Page's basic details and its posts to let the business pick an existing post to promote as an ad and to show Page lead form names. We read Page name, ID, posts and their identifiers; we do not write. Data is cached in the workspace for the display session and the Page ID and name are kept until the user disconnects. Visible to workspace admins only. Not shared or sold.

Length: 404 characters (limit 1000).

## Screencast script

Record at 1080p with the browser URL bar visible. No narration of secrets. Captions or voice-over naming each step.

1. Sign in; open Ads > New campaign (planned /app/ads).
2. Show the Connect dialog earlier (Connections) with the permission visible.
3. Choose 'Boost an existing post'; show the Page's posts loaded.
4. Select a post and show it in the campaign preview.
5. Disconnect the Page; show posts no longer load.
6. Show /data-deletion.

## What the reviewer needs (put in review notes)

- Test Page with two or three public test posts.
- Links: https://wa.edwyz.com/privacy , https://wa.edwyz.com/terms , https://wa.edwyz.com/data-deletion

## What NOT to show

- Private Page content, comments from real users.
- Env files, terminal windows, server logs, the browser dev tools, other tabs.
