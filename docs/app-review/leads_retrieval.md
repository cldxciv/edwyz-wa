# leads_retrieval

Phase: A
Feature built: **NOT BUILT**

> DO NOT SUBMIT until built. Phase A routes under /app/ads, /app/leads and /app/settings/connections do not exist in the repo as of 2026-10-27. Reviewers reject demos of flows that do not exist. The text below is the plan; re-check against the final UI.

VERIFY: permission names and the Instagram family (Facebook Login vs Instagram Login) in the App Dashboard permissions list at submission time.

## What it is for, in plain words

Lets the app fetch the answers people submit in Lead Ad forms so the business can follow up quickly.

## Use-case description (paste into the review form)

When a person submits a Lead Ad form on a connected Page, we receive the leadgen webhook and fetch the lead's form answers with this permission. We store name, contact details, answers, consent text and time as a Contact and Lead in the business's workspace, then send an opted-in WhatsApp follow-up. Only that business's logged-in team sees the lead. Leads are kept until the business deletes them or the workspace, and on a deletion request. Not shared or sold.

Length: 463 characters (limit 1000).

## Screencast script

Record at 1080p with the browser URL bar visible. No narration of secrets. Captions or voice-over naming each step.

1. Sign in; open Connections and show the Page connected with the permission shown.
2. Submit a test lead using Meta's Lead Ads Testing Tool.
3. Open Leads (/app/leads); show the lead appears with fields, source and campaign.
4. Show the WhatsApp follow-up in Inbox.
5. Delete the lead and show it gone.
6. Disconnect Page; show /data-deletion.

## What the reviewer needs (put in review notes)

- Test Page, lead form, a test lead via testing tool, a phone number with opt-in for the WhatsApp follow-up.
- Links: https://wa.edwyz.com/privacy , https://wa.edwyz.com/terms , https://wa.edwyz.com/data-deletion

## What NOT to show

- Real leads or phone numbers.
- Env files, terminal windows, server logs, the browser dev tools, other tabs.
