# leads_retrieval

Phase: A (draft, not submitted; request 1799953447868194)
Feature built: **Built**: the Leads hub at /app/leads, the leadgen webhook at /webhooks/leads with lead backfill, test leads tagged Test, and the WhatsApp follow-ups at /app/leads/sequences (`src/lib/leads`, `src/lib/promote/test-leads.ts`). Not yet exercised against live Meta with the review user.

> Built; needs the sandbox runbook (`docs/promote-verification-runbook.md`, V-P7), a live test and the screencast below. Before submitting: run the flow with the review user on the test assets, record the screencast, make the API test calls in the App Dashboard, and re-check the text against the final UI. The request is a draft (1799953447868194, not submitted); state in `status.md`.

VERIFY: permission names and the Instagram family (Facebook Login vs Instagram Login) in the App Dashboard permissions list at submission time.

## What it is for, in plain words

Lets the app fetch the answers people submit in the business's instant forms, so each lead shows in Edwyz within seconds and gets a WhatsApp follow-up if they agreed to one.

## Use-case description (paste into the review form)

When a person submits an instant form on a connected Page, Meta sends the leadgen webhook and we fetch that lead's answers with this permission; we also fetch recent leads once after a connection, in case a webhook was missed. We store the name, contact details, answers, consent choice, the ad and platform it came from, and the time, as a lead in the business's workspace. If the person ticked the optional WhatsApp consent box, Edwyz sends the business's follow-up message; otherwise no message is sent. Test leads are tagged Test and get no messages. Only that business's logged-in team sees the lead. Leads are kept until the business deletes them or the workspace, and on a deletion request. Not shared or sold.

Length: 717 characters (limit 1000).

## Screencast script

One short video (spec 8.2: a test lead appearing in the Leads hub, then the WhatsApp follow-up; it also shows a lead arriving in the hub, the `pages_manage_metadata` subscription at work). Record at 1080p with the browser URL bar visible. No narration of secrets. Captions or voice-over naming each step. Start with the shared opening in `00-overview.md`.

1. Settings > Connections: the Page is connected and its lead notifications are on.
2. Leads > Forms: on the form made in `pages_manage_ads.md`, tap **Send a test lead** and confirm.
3. Leads (/app/leads): within seconds the lead appears with its answers, the form, the ad and the platform, tagged **Test**. Open it: no WhatsApp message was sent ("Test leads get no messages").
4. Now a real test submission: on the phone logged in as the tester, open the lead ad's preview from Ads Manager, fill the form and **tick** the WhatsApp consent box. The lead appears in the hub (not tagged Test) and the WhatsApp follow-up arrives on the phone; show it in Edwyz's inbox too.
5. Submit once more without ticking the box: the lead appears and the hub shows it needs opt-in; no WhatsApp message is sent.
6. Delete a lead and show it gone. Disconnect the Page; show /data-deletion.

## What the reviewer needs (put in review notes)

- A test Page with an instant form (made in Edwyz), a lead ad on it, a phone logged in to a tester account and a WhatsApp number that can receive the follow-up.
- Links: https://wa.edwyz.com/privacy , https://wa.edwyz.com/terms , https://wa.edwyz.com/data-deletion

## What NOT to show

- Real leads or phone numbers.
- Env files, terminal windows, server logs, the browser dev tools, other tabs.
