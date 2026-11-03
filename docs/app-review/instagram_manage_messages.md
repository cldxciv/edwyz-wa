# instagram_manage_messages

Phase: NEXT WORKSTREAM (not requested; docs/IG-PAGE-ADS-SPEC.md 8.5 and 11.1a decision 4)
Feature built: **Next workstream**: Instagram Direct chats inside Edwyz. Today, Click-to-Instagram ads send people to the Instagram app; the goal cards say "Replies happen in the Instagram app for now", and those chats count in the ad's results only.

> NEXT WORKSTREAM, NOT REQUESTED. This file is the use-case and App Review material prepared in advance, because the owner wants every chat inside the platform. Do not add this permission to the app's use cases, the "Edwyz Connect Pages IG Ads" configuration, `META_CONNECT_SCOPES` or the App Review request until the inbox feature below ships; `tests/usage-scopes-alignment.test.ts` keeps the scope list to what the code uses. The steps to switch it on are at the end.

VERIFY: the permission's name in the App Dashboard. With Facebook Login (which Edwyz uses) it is `instagram_manage_messages`; Instagram Login names it `instagram_business_manage_messages`. Edwyz stays on Facebook Login.

## What it will be for, in plain words

People who tap a Click-to-Instagram ad, or message the business on Instagram, will get their replies from the business inside Edwyz's inbox, next to WhatsApp, and each new chat from an ad will show in the Leads hub.

## What has to be built first (the next workstream)

- An Instagram channel in the inbox: receive messages through the Instagram `messages` webhook (with `messaging_postbacks`, `messaging_referral` for the ad that started the chat, `message_reactions` and `messaging_seen` as needed), store them as conversations, and send replies through the Instagram Messaging API inside Meta's 24-hour window (the `HUMAN_AGENT` tag only where the human agent feature is approved).
- Chat leads from Click-to-Instagram ads: the referral's ad id makes one Lead per person per ad per 30 days, like Click-to-WhatsApp leads today (`src/lib/leads`).
- The owner's Instagram setting "Allow access to messages" (Instagram app > Settings > Messages and story replies > Message controls > Connected tools) must be on, or Meta delivers nothing. Readiness gets a row for it, with plain words and the place in the Instagram app (it has no API).
- Erasure and retention for Instagram messages and identities, the same as WhatsApp messages.
- The goal cards drop "Replies happen in the Instagram app for now" for Instagram Direct once this ships (spec D15).

## Use-case and configuration (when the feature ships)

1. App Dashboard > Use cases: add the Instagram messaging use case for Facebook Login ("Manage messaging and content on Instagram"; VERIFY the current name), which carries this permission.
2. Webhooks > Instagram: callback URL `https://wa.edwyz.com/webhooks/instagram` (the new route), verify token = `META_VERIFY_TOKEN`, fields `messages`, `messaging_postbacks`, `messaging_referral`. Per account, subscribe the app with `POST {page}/subscribed_apps` and the Instagram fields.
3. Edit the "Edwyz Connect Pages IG Ads" configuration to add it, then add it to `META_CONNECT_SCOPES` with its purpose ("Read and reply to Instagram messages in the inbox.") and its code reason in `tests/usage-scopes-alignment.test.ts`.
4. Then App Review for Advanced Access, with the material below.

## Use-case description (draft, paste when the feature ships)

Edwyz's shared inbox lets a business read and reply to Instagram direct messages sent to its connected professional account, including chats started from its Click-to-Instagram ads, next to its WhatsApp chats. We receive messages through the webhook and read the message content, the sender's Instagram-scoped id and name; we send the replies the business's team writes, only inside Meta's messaging window. A chat started from an ad is shown as a lead in the business's Leads hub. Messages are stored in the workspace until the business deletes them, the contact or the workspace, and are visible only to that business's team. Not shared or sold.

Length: 647 characters (limit 1000).

## Screencast script (draft)

Record at 1080p with the browser URL bar visible. Captions naming each step. Start with the shared opening in `00-overview.md` (the consent screen will list this permission).

1. On a phone logged in as an Instagram tester, open the test business's Click-to-Instagram ad preview from Ads Manager and send a message.
2. In Edwyz, the chat arrives in the inbox marked Instagram, and the Leads hub shows a chat lead from that ad.
3. Reply from Edwyz; show the reply arriving on the phone.
4. Delete the contact in Edwyz; disconnect in Settings > Connections; show /data-deletion.

## What the reviewer will need

- A test Instagram professional account linked to the test Page, with "Allow access to messages" on, and a second Instagram tester account to send from.
- Links: https://wa.edwyz.com/privacy , https://wa.edwyz.com/terms , https://wa.edwyz.com/data-deletion

## What NOT to show

- Real direct messages or real customers' accounts.
- Env files, terminal windows, server logs, the browser dev tools, other tabs.

## Switching it from next workstream to requested

- [ ] The inbox channel, chat leads, readiness row and erasure above are built and tested end to end.
- [ ] The use case, webhook fields and configuration edit are done (above).
- [ ] `META_CONNECT_SCOPES`, `SCOPE_PURPOSES` and `tests/usage-scopes-alignment.test.ts` updated in the same change.
- [ ] This file's header changes to "Phase: C (draft, not submitted)" and "Feature built: **Built**", and `status.md` and `00-overview.md` say so.
