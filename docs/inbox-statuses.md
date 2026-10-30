# Inbox statuses, labels and personal markers

How the inbox decides what to show. Nothing here needs a schema column beyond migration 0006; the labels are derived on read.

## Stored status (Conversation.status)

`open`, `pending`, `solved`, `blocked`. Legacy `resolved` reads as `solved`. An agent sets these; a customer message reopens a solved chat (`reopenOnInbound`). Only admins can block.

## Expired (derived, never stored)

A chat is **Expired** when it is `open` or `pending` and the customer's last message (`lastInboundAt`) is more than 24 hours old.

- A reply from the business never extends the window and never clears Expired. Sending an approved template to an expired chat leaves it Expired until the customer writes back.
- When the customer writes, `lastInboundAt` moves forward and the chat is Open again by itself. No write is needed.
- `solved` and `blocked` chats are never shown as Expired.
- A chat where the customer has never written (`lastInboundAt` is empty), for example one started from the inbox with a template or reached only by a broadcast, is **not** Expired. Expired means a window that opened and then lapsed. These chats stay Open or Pending, the composer already shows that only templates can be sent, and they leave the Active tab (which needs a customer message in the last 24 hours). The Campaign label and tab cover broadcast-only chats. If the customer answers, the normal rules apply from that message on.
- Code: `deriveStatus` (rows) and `expiredWhere` (list filter) in `src/lib/inbox/status-rules.ts` and `status.ts`.

## Labels (derived, shown as small pills in the list)

| Label | Meaning | Derived from |
|---|---|---|
| New | The customer wrote and nobody on the team has replied yet | `firstAgentReplyAt IS NULL`, `lastInboundAt IS NOT NULL`, status `open` or `pending`. `firstAgentReplyAt` is set the first time a signed-in agent sends anything. Bot, AI-agent and automation replies do not count. |
| Campaign | The last thing the customer got was a broadcast and they have not answered | A `Message` that is the `messageId` of a `BroadcastRecipient`, created in the last 30 days, newer than the chat's `lastInboundAt` (or the customer never wrote). Computed by `campaignConversationIds` in `src/lib/inbox/marks.ts`. |

Both have a matching tab (New, Campaigns). Other tabs added to the list: Favorites, Mentioned, Active (the 24-hour window is open), Blocked.

## Personal markers (ConversationMark, one row per agent, kind)

- `favorite`: the agent starred the chat. Favorites tab.
- `unread`: "Mark as unread". Personal: it does not change the shared unread counter. The chat shows as unread for that agent and in the Unread tab until they open it.
- `mention`: another agent wrote `@Name` in an internal note. It is the in-app notice (the Mentions menu and the Mentioned tab). Opening the chat clears it.

Opening a chat (`POST /api/inbox/conversations/:id/read`) resets the shared counter and clears the caller's own `unread` and `mention` markers.

The **unread line** is placed when a chat is opened: above the Nth newest customer message, where N is the shared unread count at that moment (or the last customer message when only the personal flag was set).

## Search

The list search box matches, for the signed-in workspace only: contact name, any part of the phone number (spaces, dashes and a leading plus are ignored, so the last 4 digits work), and message text from three characters. Message search reads the newest 300 matching messages (case-insensitive `ILIKE`) and shows an excerpt on the row. The viewer's visibility scope (teams, view-only-assigned, phone masking) is part of that query, so chats a restricted agent cannot see neither use up the 300 nor leak an excerpt. For large workspaces add the trigram index in `docs/schema-requests.md`; until then the scan is unindexed and bounded only by the cap.

## Consent rules enforced in code

- `sendTemplateMessage` refuses any contact who opted out (HTTP 422) and refuses a MARKETING template for a contact without a recorded opt-in. A template the workspace has no row for is treated as unknown, so only the opt-out applies. That gap is reachable only by callers that pass a raw template name (automation, chatbots, the API); the inbox composer and New chat always pick a template row, so they enforce the marketing rule.
- New chat: an admin may tick "they agreed to marketing". The opt-in is written just before the send (the consent check reads it) and taken back, with no audit entry, if the send is refused. It is not written again for a contact who is already opted in. If the contact already has a chat on that number the caller must be allowed to see it, otherwise the answer is 404.
- Mentions: an @mention only notifies a teammate who may see the chat, and the Mentions menu lists only chats the viewer may see, with the phone masked when theirs is masked.
- STOP: opt-out plus a one-time confirmation message (text in Inbox settings; empty sends nothing). START, UNSTOP or SUBSCRIBE from a contact who is currently opted out: opt-in recorded with source `whatsapp_start`, confirmation sent. Neither message starts a bot, the AI agent or an automation. The opt-out or opt-in is applied before the inbound message row is stored, so a webhook retry after a crash cannot skip it (a lost confirmation reply is the worst case).
