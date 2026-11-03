# pages_manage_metadata

Phase: A
Feature built: **Built**: lead alerts: the Page is subscribed with `{page}/subscribed_apps` and Connections shows "Lead alerts on" (/app/settings/connections). Not yet exercised against live Meta with the review user.

> Built; needs a live test and a screencast. Before submitting: run the flow below with the review user on the test assets, record the screencast, make the API test calls in the App Dashboard, and re-check the text against the final UI. The request is a draft (1799953447868194, not submitted); state in `status.md`.

VERIFY: permission names and the Instagram family (Facebook Login vs Instagram Login) in the App Dashboard permissions list at submission time.

## What it is for, in plain words

Lets the app subscribe the Page to webhooks so new leads reach the business immediately.

## Use-case description (paste into the review form)

When a business connects a Page, Edwyz Growth subscribes the Page to the leadgen webhook field so new lead form submissions are delivered to us in real time. We write a webhook subscription on the Page and read nothing else with this permission. On disconnect we remove the subscription. Webhook payload IDs are stored for 30 days, then deleted; the resulting lead is stored per the Lead Hub rules. Visible to workspace members only.

Length: 433 characters (limit 1000).

## Screencast script

Record at 1080p with the browser URL bar visible. No narration of secrets. Captions or voice-over naming each step.

1. Sign in; open Connections.
2. Connect the Page; show the permission dialog.
3. Show the Page marked 'receiving leads'.
4. Submit a test lead via the Meta Lead Ads testing tool; show the webhook delivery logged (Lead Hub /app/leads).
5. Disconnect the Page; show subscription removed (status changes).
6. Show /data-deletion.

## What the reviewer needs (put in review notes)

- Test Page and an existing test lead form; the Lead Ads Testing Tool link.
- Links: https://wa.edwyz.com/privacy , https://wa.edwyz.com/terms , https://wa.edwyz.com/data-deletion

## What NOT to show

- Raw webhook payloads containing real personal data.
- Env files, terminal windows, server logs, the browser dev tools, other tabs.
