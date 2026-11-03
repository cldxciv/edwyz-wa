# pages_messaging

Phase: NEXT WORKSTREAM (not requested; docs/IG-PAGE-ADS-SPEC.md 8.5 and 11.1a decision 4)
Feature built: **Next workstream**: Messenger chats inside Edwyz. Today, Click-to-Messenger ads send people to Messenger; the goal cards say "Replies happen in Messenger for now", and those chats count in the ad's results only.

> NEXT WORKSTREAM, NOT REQUESTED. This file is the use-case and App Review material prepared in advance, because the owner wants every chat inside the platform. Do not add this permission to the app's use cases, the "Edwyz Connect Pages IG Ads" configuration, `META_CONNECT_SCOPES` or the App Review request until the inbox feature below ships; `tests/usage-scopes-alignment.test.ts` keeps the scope list to what the code uses. The steps to switch it on are at the end.

VERIFY: the permission's name and its use case in the App Dashboard at the time.

## What it will be for, in plain words

People who tap a Click-to-Messenger ad, or message the business's Facebook Page, will get their replies from the business inside Edwyz's inbox, next to WhatsApp, and each new chat from an ad will show in the Leads hub.

## What has to be built first (the next workstream)

- A Messenger channel in the inbox: receive messages through the Page `messages` webhook (with `messaging_postbacks`, `messaging_referrals` for the ad that started the chat, and `message_echoes` so replies sent from Meta Business Suite show too), store them as conversations, and send replies through the Send API inside Messenger's 24-hour standard window (the `HUMAN_AGENT` tag, up to 7 days, only once the Human Agent feature is approved).
- Chat leads from Click-to-Messenger ads: the referral's ad id makes one Lead per person per ad per 30 days, like Click-to-WhatsApp leads today (`src/lib/leads`).
- The Page's subscription to the messaging fields (`POST {page}/subscribed_apps` with them), next to today's `leadgen` subscription, re-checked every 24 hours like today's.
- Erasure and retention for Messenger messages and Page-scoped ids, the same as WhatsApp messages.
- The goal cards drop "Replies happen in Messenger for now" for Messenger chats once this ships (spec D15).

## Use-case and configuration (when the feature ships)

1. App Dashboard > Use cases: add the Messenger use case ("Engage with customers on Messenger from Meta"; VERIFY the current name), which carries this permission.
2. Webhooks > Page: keep `https://wa.edwyz.com/webhooks/leads` for `leadgen`; add the messaging fields on the new route `https://wa.edwyz.com/webhooks/messenger` (VERIFY whether one Page callback must serve both, in which case the existing route dispatches by field).
3. Edit the "Edwyz Connect Pages IG Ads" configuration to add it, then add it to `META_CONNECT_SCOPES` with its purpose ("Read and reply to Messenger chats in the inbox.") and its code reason in `tests/usage-scopes-alignment.test.ts`.
4. Then App Review for Advanced Access, with the material below.

## Use-case description (draft, paste when the feature ships)

Edwyz's shared inbox lets a business read and reply to Messenger messages sent to its connected Facebook Page, including chats started from its Click-to-Messenger ads, next to its WhatsApp chats. We receive messages through the webhook and read the message content, the sender's Page-scoped id and name; we send the replies the business's team writes, only inside Messenger's messaging window. A chat started from an ad is shown as a lead in the business's Leads hub. Messages are stored in the workspace until the business deletes them, the contact or the workspace, and are visible only to that business's team. Not shared or sold.

Length: 633 characters (limit 1000).

## Screencast script (draft)

Record at 1080p with the browser URL bar visible. Captions naming each step. Start with the shared opening in `00-overview.md` (the consent screen will list this permission).

1. On a phone logged in as a Messenger tester, open the test business's Click-to-Messenger ad preview from Ads Manager and send a message.
2. In Edwyz, the chat arrives in the inbox marked Messenger, and the Leads hub shows a chat lead from that ad.
3. Reply from Edwyz; show the reply arriving in Messenger.
4. Delete the contact in Edwyz; disconnect in Settings > Connections; show /data-deletion.

## What the reviewer will need

- The test Page and a Messenger user with a tester role on the app.
- Links: https://wa.edwyz.com/privacy , https://wa.edwyz.com/terms , https://wa.edwyz.com/data-deletion

## What NOT to show

- Real customer messages.
- Env files, terminal windows, server logs, the browser dev tools, other tabs.

## Switching it from next workstream to requested

- [ ] The inbox channel, chat leads, Page subscription and erasure above are built and tested end to end.
- [ ] The use case, webhook fields and configuration edit are done (above).
- [ ] `META_CONNECT_SCOPES`, `SCOPE_PURPOSES` and `tests/usage-scopes-alignment.test.ts` updated in the same change.
- [ ] This file's header changes to "Phase: C (draft, not submitted)" and "Feature built: **Built**", and `status.md` and `00-overview.md` say so.
