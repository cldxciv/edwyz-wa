# WATI feature inventory: inbox, contacts, automation, analytics, security

Research date: 2026-10-26. Method: public help-center pages (support.wati.io), API docs (docs.wati.io), product pages. Read-only; no login. All descriptions are paraphrased. "Plan" fields reflect what each page states; where silent, marked "not stated". Plans currently named: Growth, Pro, Business (Enterprise appears as a legacy name; some pages say "Business and Enterprise").

Base URL for articles: https://support.wati.io/en/articles/<id>. IDs are given as `[id]`.

---

## 1. Shared inbox ("Team Inbox")

### 1.1 Multi-channel inbox shell
- What: one inbox with an "All Channels" tab plus per-channel tabs. Channels: WhatsApp, WhatsApp calls, RCS, Instagram, Facebook Messenger, WebChat. A channel icon sits beside each conversation. Replies are documented only for WhatsApp and Instagram (+ WebChat); Messenger/RCS reply not stated.
- Linked chats: when a phone number is added to an Instagram contact, Wati looks for a WhatsApp contact with the same number and merges them into one profile (shown with a linked-contact icon in the All tab). User toggles between the WhatsApp and Instagram thread inside the linked chat. Manual linking not described.
- Plan: multi-channel inbox is Pro and Business.
- Data: conversation(channel, contact), contact link group.
- Meta dependency: WhatsApp Cloud API webhooks; Instagram/Messenger Graph messaging.
- Source: https://support.wati.io/en/articles/11463002-how-to-use-the-multi-channel-team-inbox-in-wati

### 1.2 Start a new chat
- Only on the WhatsApp tab (the "+" is hidden in All Channels). Enter a phone number or BSUID, or pick an existing contact; then pick an approved template (search, or create new inline), fill variables, send.
- Unknown number becomes a contact only after the message is sent. The conversation is auto-assigned to the sending operator.
- Opt-in checking is not described on this page.
- Meta: business-initiated conversation requires an approved template (outside 24h window).
- Source: https://support.wati.io/en/articles/11463018-how-to-start-a-new-chat-in-wati

### 1.3 Chat statuses
| Status | Meaning | Set by |
|---|---|---|
| Open | Active two-way chat; both sides can message freely | Auto when customer replies or starts a chat (also from Expired, Solved, Campaign) |
| Pending | Business is waiting for the customer | Manual (Open to Pending) |
| Expired | 24h with no customer reply; WhatsApp window closed | Auto |
| Solved | Issue resolved | Manual (from any status); auto-reopens to Open if customer writes before expiry |
| Campaign | Chat began from a bulk template send | Auto on campaign send |
| Blocked | Contact blocked (UI wording "Spam & Block") | Manual |
- A "New" view exists in the saved-views list (New, Open, Pending, Solved, Expired, Blocked); "New" is not defined on the status page.
- 24h window: inside it (Open/Pending/Solved-not-expired) free-form is allowed; outside it only approved templates. A customer reply moves any of Expired/Solved/Campaign back to Open.
- API accepts `open`, `solved`, `pending`, `block` via PUT /api/ext/v3/conversations/{target}/status; `target` = conversation id, phone, or `Channel:phone`.
- Sources: https://support.wati.io/en/articles/11463004-understanding-chat-statuses-in-team-inbox , https://docs.wati.io/reference/conversations_updateconversationstatus.md

### 1.4 Conversation list: views, search, filters, sort, saved filters
- Saved views (General): All Chats, Active Chats (New/Open/Pending), Campaigns, Unassigned, Unread, Last 24 Hours, Assigned to Me, Favorite Only. Status views: New, Open, Pending, Solved, Expired, Blocked.
- Sort: Newest first / Oldest first.
- Search field selector: All (messages, names, phones), Phone or Name, Messages. In All Channels: Messages, Name, Phone, Instagram Username. In WhatsApp tab: Name or Phone, Messages.
- Advanced filters: Attributes (Status, Allow Campaign, Allow SMS, name, phone), Custom Attribute, Assignee (multi), Status, Team (multi), Tag (multi), Campaign name, Date range, Reply status (Replied / Unreplied).
- "Unreplied" rules: shows chats awaiting a human; bot replies do not count; manually sent template counts as reply; solved chats drop off; team-assigned operators see only their teams' unreplied chats.
- "Save as custom filter" with visibility: Visible to me / Visible to selected agents / Visible to all. Admins cannot see another user's "me" filters in their sidebar.
- Mentioned filter: operators can filter to chats where they were @mentioned (differs from Groups "Mentions").
- AND/OR combination of multiple filters and tag multi-select semantics: not stated.
- Source: https://support.wati.io/en/articles/11463016-how-to-search-or-filter-conversations-in-team-inbox

### 1.5 Assignment: operators, teams, default team
- Every chat is handled by a bot, AI agent, an operator, or a team. New inbound messages go to any matching automation AND to the Default Team (members + admins can see and reply). Without routing rules chats stay with Default Team.
- One Default Team per workspace (exactly one flag). An operator can be in several teams (implied; the "operators" article says so explicitly).
- A chat has "only one operator or one team assigned" in the routing article, but Assign Team node and Round Robin pages say chats can have multiple teams (and Round Robin skips multi-team chats). Treat as: team list on ticket, single operator.
- Assign User node: if operator's team is not on the ticket, that team is added to the ticket's team list.
- Manual assign by admins/agents to anyone, including operators in Away.
- Operator seats: Growth 3 default, Pro 5, Business 5; extra seats via add-on (price not stated).
- Sources: https://support.wati.io/en/articles/15458153-understanding-operators-teams-and-chat-assignment-in-wati , https://support.wati.io/en/articles/11463021-how-to-create-and-manage-teams-in-wati , https://support.wati.io/en/articles/11463034-understanding-the-assign-user-and-assign-team-chatbot-nodes

### 1.6 Routing (rules/keywords)
- Three routing actions: Send Notification (alert a list of operators, no assignment), Assign to Operator, Assign to Team. Keyword-triggered; each keyword added individually; can run alongside an auto-reply.
- If the assigned operator is offline the chat stays with them until they return (manual reassign needed).
- Source: https://support.wati.io/en/articles/11463190-how-to-set-up-routing

### 1.7 Round robin and load-based routing
- Plan: Business and Enterprise only.
- Configurable three ways: (a) legacy Default Actions "Assign new chats in round robin order" (only for Default Team inbound); (b) Chatbot flow Assign Team node with Round Robin; (c) Rules: action "Route chat" > To Team > checkbox "Assign to users of the team in round-robin".
- Pool settings: Assign chats to admins (off by default means admins excluded); Skip users that are offline; Assign chats outside working hours; Direct lead to contact owner (HubSpot integration).
- Load-based routing: pick the eligible online member with fewest open tickets; if everyone is at max capacity, chat goes to the bot. "Maximum capacity" value not documented.
- Auto reassign with no response: timer starts at RR assignment; on timeout moves to next eligible member. Range/default not given.
- Not redistributed: manually assigned chats; chats assigned to multiple teams.
- Expired/closed chats: "Keep last assignee" (legacy default action) or "Use round robin for expired chats".
- Source: https://support.wati.io/en/articles/14270796-how-to-use-round-robin-assignment-for-chats-in-wati

### 1.8 Last-assignee routing
- Rule: trigger "New WhatsApp message is received", filters "Contact initiates a new chat" + "No keyword(s) matches", action Route chat > last assignee (non-Bot). Only within the 24h window. Fallback when last agent unavailable: not described.
- Source: https://support.wati.io/en/articles/11463192-how-to-automatically-assign-a-chat-to-the-last-assignee

### 1.9 Away mode
- Operator (or admin on their behalf) sets status Away from the profile menu. Away operators are skipped by RR, load-based, and other automatic assignment. Rules/flows that target a specific user who is Away fall back to the bot. Contact-owner routing ignores Away. Manual assignment and WhatsApp calls still reach Away users. No timer/expiry. Unknown whether existing chats are reassigned.
- Source: https://support.wati.io/en/articles/16843441-how-away-mode-works-in-wati

### 1.10 Chat visibility restriction ("View only assigned conversations")
- Per-user checkbox (User Management > add/edit). Business plan. Operator role only; admins always see all. WhatsApp only (Instagram/Messenger unaffected). Operator sees only chats assigned directly to them (not team-mates'), but can still reassign their own chats. Operators also holding Contact Manager role then see only contacts assigned to them ("Operator Privacy" wording).
- Source: https://support.wati.io/en/articles/11865694-how-to-restrict-operators-to-view-only-their-assigned-conversations

### 1.11 Bulk actions
- Select up to 15 conversations. Actions: Solve, Reopen, Move to Pending, Assign to Operator, Assign to Team, Unassign, Add Tags & Notes, Download Chats. Each chat evaluated independently; ineligible ones skipped silently (e.g. Expired cannot be solved/pended; Unassign skipped if assigned to a bot; Reopen applies to Solved or Pending). Plan: Pro, Business, Enterprise.
- Source: https://support.wati.io/en/articles/16798280-how-to-perform-bulk-actions-on-multiple-conversations

### 1.12 Tags
- Conversation-level only (not contacts; cannot segment contacts or target campaigns). Created by typing a name and pressing Enter, but only Admins may create new tags; others pick existing. Admin management page: Settings > Tags and Attributes > Tags (search, edit, delete, add). Filterable in inbox; used in analytics (top 20 tags chart). API: add/remove tag on a conversation applies existing tags only (does not create).
- Limits (count, length, color), removal UX: not stated.
- Source: https://support.wati.io/en/articles/11463012-how-to-add-and-use-tags-in-wati-conversations , https://docs.wati.io/reference/addconversationtag.md

### 1.13 Private (internal) notes and @mentions
- Notes are invisible to customers. `@` picks one or more operators, even outside the assigned team. A mentioned operator from another team can view the chat but can only reply with private notes. Mentioned operators find chats via "Mentioned" filter; push notification behaviour not described. Edit/delete not described. Plan: Pro, Business, Enterprise.
- Source: https://support.wati.io/en/articles/16798275-how-to-use-private-notes-to-collaborate-with-your-team

### 1.14 Quick replies (canned replies)
- Created from the inbox: name, message text, optional single media (image/video/document). Insert via Quick Reply icon list or by typing `/` in composer and picking/typing name. Copy, edit, delete (permanent).
- Variables: `{{name}}`, `{{phone}}`, `{{city}}`, `{{operator.first_name}}` (phone shows masked when masking is on).
- Whether shared or personal, count limits, plan: not stated.
- Distinct from "Reply Materials" (automation library, see 3.9).
- Source: https://support.wati.io/en/articles/11463011-how-to-create-and-use-quick-replies-in-wati

### 1.15 Unread logic
- Read state is shared across all users (opening a chat marks it read for everyone). A red line marks where unread messages begin; it clears on opening another chat, scrolling to top/bottom, or sending a reply. Replying auto-marks read.
- "Mark as unread" (Admin/Operator, all plans): only on an incoming customer message below the red line with no reply; chat must be assigned to a human (not Bot/AI agent); team and system messages not eligible.
- Unread-count formula not documented.
- Source: https://support.wati.io/en/articles/11823176-how-to-mark-customer-messages-as-unread-in-wati

### 1.16 Favorites, block/unblock
- Favorites: star icon; filter "Favorite only". Global (per-user vs shared not stated).
- Block: set status "Spam & Block" and confirm. Blocked chats move to "Blocked Chats"; inbound messages are STILL received and stored; notifications suppressed. Unblock via status "Unblock" and notifications resume. Rules do not run for blocked conversations. Campaign exclusion and outbound behaviour not stated.
- Sources: https://support.wati.io/en/articles/11463017-how-to-mark-contacts-as-favorites-in-wati , https://support.wati.io/en/articles/11463005-how-to-block-and-unblock-contacts-in-wati

### 1.17 Typing indicator and agent name
- Typing indicator: toggle "Show typing indicator to customers" (Settings > Team Inbox > General). Shown when an operator is typing or when an Astra AI agent is generating. All plans. Also a public API endpoint (conversations_sendtypingindicator). Meta basis: WhatsApp Cloud API typing-indicator on the read receipt; timeout/limits not stated.
- Agent name display: toggle "Show agent name" (Pro, Business). Operator name is added to outgoing replies; edit display name in User Management; applies to future messages only; exact format not documented.
- Sources: https://support.wati.io/en/articles/14753951-how-to-enable-typing-indicator-in-wati , https://support.wati.io/en/articles/12264892-how-to-display-agent-names-in-whatsapp-conversations , https://docs.wati.io/reference/conversations_sendtypingindicator.md

### 1.18 Media types and sizes (inbox, bots, templates)
| Type | Formats | Max |
|---|---|---|
| Audio | AAC, MP4 audio, MPEG, AMR, OGG (Opus only) | 16 MB (inbox/bots only, not templates/reply material) |
| Document | txt, pdf, doc/docx, xls/xlsx, ppt/pptx | 100 MB (templates: PDF only). Reply Material page says 75 MB |
| Image | JPEG, PNG (8-bit RGB/RGBA) | 5 MB |
| Video | MP4, 3GP | 16 MB |
| Sticker | WebP 512x512 | static 100 KB, animated 500 KB |
- Image header ratio beyond 1.91:1 may crop. Headers supported only for image/video/document.
- Source: https://support.wati.io/en/articles/11463010-supported-media-types-and-sizes-in-wati

### 1.19 Message types received (as seen in automation triggers)
- Text; image/video/document (with or without caption); sticker; voice note/audio (transcribed for keyword filters); location pin; contact card; catalog order; button/list reply (filter reads reply text); emoji reaction (received but never runs rules). Replies/quoted messages, reactions rendering in UI, and outbound location/contact sends: not documented on pages read.
- Source: https://support.wati.io/en/articles/12321649-how-to-set-up-triggers-in-rules

### 1.20 Interactive messages sent from inbox/API
- API v3 supports `buttons` and `list` only (no CTA URL in that endpoint). Buttons: header (text max 60, or media), body max 1024, footer max 60, button text max 20, 3 buttons max (help article). List: header 60, body 1024, footer 60, section/row title 24, row description 72, up to 10 rows per help article. 200 response means accepted, not delivered; failure arrives via "Session Message Failed" webhook.
- CTA URL buttons and URL buttons with click tracking exist in templates (see 5.6).
- Sources: https://docs.wati.io/reference/conversations_sendinteractivemessage.md , https://support.wati.io/en/articles/11463030-how-to-create-list-message-message-with-reply-button

### 1.21 Templates inside inbox
- Used to open a new chat and to re-engage after 24h (expired chat: templates only). Template variables filled at send. Inline "+ New Template".
- Source: 1.2 and 1.3.

### 1.22 Delivery states
- Webhook categories: messages received, messages sent (template and session), status updates (Sent, Delivered, Read). Analytics has a "Message delivery status" chart. Failed state surfaces as "Session Message Failed" webhook. API message `status` example `delivered`; enum not published.
- Source: https://docs.wati.io/reference/introduction-1.md , https://docs.wati.io/reference/conversations_getmessagesbyconversationid.md

### 1.23 Audio transcription
- "Transcribe Audio" under an audio message; first use shows an opt-in intro; result expandable and downloadable .txt. WhatsApp, Instagram, Messenger. Pro and Business. Languages/credits not stated. Rule filters also read a transcript.
- Source: https://support.wati.io/en/articles/11463014-how-to-use-audio-transcription-in-wati-team-inbox

### 1.24 Chat export and transcripts; conversation URL
- Single chat: ⋮ > Download Chat, .txt, line per message with timestamp and sender, admin-only.
- Full export: Settings > Import/Export Chats; ZIP of .txt files, one per contact, named by phone; always full history, no date range; delivered by email link. Growth/Pro/Business. Import not supported (only a one-time sync during WhatsApp Coexistence onboarding).
- Copy conversation URL: ⋮ > Copy Link; access rules/format undocumented.
- Sources: https://support.wati.io/en/articles/11463003-how-to-download-chat-transcripts-in-wati , https://support.wati.io/en/articles/11874200-how-to-export-chat-history-from-wati , https://support.wati.io/en/articles/11463015-how-to-copy-a-conversation-url-in-wati

### 1.25 SLA / response timers
- No configurable SLA product found. Related automatic timers: Default Action "reply when customer has waited too long" (N minutes, working hours), "auto-reassign when agent does not respond", "nudge and close inactive chats", "follow up before 24h window expires" (not sent if Solved). FRT/ART appear in reports only.
- Ticketing: the inbox calls conversations "tickets" in analytics (each ticket has opened/resolved/expired timestamps, FRT, resolution time) but there is no separate ticket entity/priority/category documented.

### 1.26 Away/Offline presence
- "Skip offline users" implies presence tracking (online = logged in on web or mobile). Operator Availability metric is total online time across web and mobile app.

---

## 2. Operators, roles, permissions, teams

### 2.1 Roles (fixed list of 10, no custom roles documented)
Administrator (Inbox, Contacts, Campaign, Automation, Dashboard, API Docs, Settings, User Mgmt, Tenants, Integration, Webhooks, Billing); Campaign Manager (campaigns, buy credits); Template Manager; Operator (Team Inbox); Developer (API Docs + Webhooks); Contact Manager (Contacts; default-team members see all contacts, others only their teams' contacts); Dashboard Viewer (analytics); Automation Manager; Billing Manager; Trial (Inbox + Contacts only until payment). A user can hold multiple roles (e.g. Operator + Contact Manager) per the visibility article. Menu-level permissions only; no field/action-level matrix.
- Source: https://support.wati.io/en/articles/11463020-understanding-different-roles-and-permissions-in-wati

### 2.2 User management
- Settings > User Management: Add user (name, email, role; invite email carries login link and a "client ID" needed to log in), view/search/delete users, edit display name, per-user toggles (View only assigned conversations, Mask contact phone number), Teams tab (Add Team, name, default flag, pencil to add members), admin "Logout from active sessions" per user.
- Sources: https://support.wati.io/en/articles/11462456-how-to-invite-your-team-members-to-wati , https://support.wati.io/en/articles/11463019-how-to-view-search-and-delete-users-in-wati , https://support.wati.io/en/articles/11463022-how-to-log-out-a-user-from-active-sessions-in-wati

### 2.3 Contact owner
- Contact field assigning a user as owner (manual, or setting "Make assignee as contact owner" in Team Inbox settings, or `contact_owner` column on import matched by exact user name). Pro and Business. Feeds Sales Analytics and "direct lead to contact owner" routing.
- Source: https://support.wati.io/en/articles/12264879-understanding-contact-owner-and-lead-stage-attributes

---

## 3. Automation

### 3.1 Taxonomy (WATI's own)
- **Rules** (current): Trigger > optional Filters > Actions. Recommended.
- **Keyword Actions** (legacy, Business up to 300): keyword > reply materials.
- **Default Actions** (legacy): welcome / OOO / no-agent / fallback / chat-handling toggles, configured per channel (WhatsApp, Instagram, Messenger, TikTok).
- **Chatbots**: visual flow builder (separate collection, 27 articles) with nodes (Send message, Ask question, Condition, Operations, Integrations, Catalog, Assign User/Team, Template, List/Buttons, Webhook, Time delay, Timer, Subscribe/Unsubscribe, Google Sheets, AI Assist, Astra AI Agent, Custom AI Agent, WhatsApp Flow, Collect UTM, Update Attribute, Trigger Chatbot).
- **Sequences**, **Reply Materials**, **WhatsApp Flows** (Meta forms). "Workflows" is used loosely in docs (e.g. "Workflows support BSUID-only contacts"); no separate product called Workflows was found. Practical split: Rules decide WHEN and WHO; Chatbots are multi-step conversations that rules start.
- Sources: https://support.wati.io/en/articles/11463193-understanding-rule-based-automation-in-wati , https://support.wati.io/en/articles/11463029-guide-to-chatbot-nodes-in-wati

### 3.2 Rule triggers
1. New WhatsApp message is received (all inbound types except emoji reaction). 2. New Instagram message. 3. New Facebook Messenger message. 4. New attribute added to a contact (from inbox, contact page, `updateContactAttributes` API, integrations; e.g. CTWA adds `source_url`, `source_id`). 5. Attribute value changed. Other triggers exist (Shopify events, schedules, missed calls, WhatsApp Customer No Response, per other articles) but were not itemised.
- Source: https://support.wati.io/en/articles/12321649-how-to-set-up-triggers-in-rules

### 3.3 Rule filters (9)
Incoming message matches keyword(s); Contact initiates a new chat; Timestamp (working-hours style); No keyword rule(s) matches; Contact (exists / does not exist); Contact attributes (operators seen: contains, is, is true); Custom Segment (is / is not); Incoming message contains media (WhatsApp); Message type (Text, Image, Video, Audio file, Voice note, Document, Sticker, Location, Contact card, Order; any-of).
- Logic: AND, OR, nested groups ((A AND B) OR C). Keyword filter cannot share a group with "No keyword matches".
- Keyword modes: Fuzzy (legacy default threshold 80%), Exactly matches (whole message), Contains. Case-insensitive. Legacy priority: Exact > Contains > Fuzzy; ties broken by earliest created.
- Sources: https://support.wati.io/en/articles/11463196-how-to-set-up-filters-in-rules , https://support.wati.io/en/articles/11463194-how-to-create-keyword-based-rules , https://support.wati.io/en/articles/11463179-how-to-create-and-manage-keyword-actions

### 3.4 Rule actions (8)
Send template message (any time); Send message (text/document/image/sticker/video; needs open 24h window else fails); Route chat (operator / team / last assignee); Start chatbot (needs window); Start Astra AI agent (needs window); Send catalog (needs window); Update contact attribute; Start sequence (needs window unless first step is a template). Notification action also exists (named in overview). "Update chat status" is NOT a rule action; only a chatbot node.
- Source: https://support.wati.io/en/articles/11463197-how-to-set-up-actions-in-rules

### 3.5 Execution model
- Rules evaluated top to bottom; ALL matching rules run, except only the highest matching rule may start a chatbot / AI agent (lower ones still run other actions). New rules go on top. Drag reorder. Time-based rules have no order.
- Execution settings (all default off, event-based tab): Prioritize Quick-Reply First; Stop After Button Interactions; Prioritize Rules Over Keyword Actions. Default Actions always last.
- Rules do NOT run when: contact is in an active chatbot; rule off; trigger not in plan; chat assigned to human/AI agent and rule is message-triggered; conversation blocked; trigger is a reaction. Attribute/Shopify/schedule/missed-call rules can still run during agent handling; if they send a message or start a chatbot, the chat flips back to the bot (use Route/Update attribute/Notification actions to avoid this).
- Only Admin and Automation Manager can edit execution settings.

### 3.6 Built-in Welcome and Out-of-Office rules
- Free, ship Off, trigger "New WhatsApp message is received". Welcome: inside working hours + new chat + no keyword match. OOO: outside working hours + new chat + no keyword match. Only message content editable; cannot delete; can reorder. 30-minute per-conversation throttle on repeat OOO replies. Custom variants are billable triggers; legacy Default Action welcome/OOO are also billable.
- Source: https://support.wati.io/en/articles/11561609-understanding-built-in-automation-rules-out-of-office-ooo-and-welcome-message , https://support.wati.io/en/articles/16186424-answer-customers-instantly-after-hours-with-out-of-office-automation

### 3.7 Working hours and holiday mode
- Settings > General > Working hours. Account timezone; per-day open/close, closed days; 24h clock; start != end; no overlaps; overnight must be split into two ranges; only last entry per day counts. Working hours can be set per WhatsApp number (Instagram/Messenger use the default WhatsApp number's). Holiday Mode: one switch, auto-OOO to every inbound message; no date-specific holiday calendar. Rules ignore working hours unless a Timestamp filter is added. Effect on routing not stated.
- Source: https://support.wati.io/en/articles/11463178-how-to-set-up-working-hours-in-wati

### 3.8 Default Actions (legacy)
Message-based, first match wins: welcome (new chat, no keyword), outside hours, no agent online in hours, fallback (no keyword; max once per 30 min). Scheduled: customer waited too long (N min), follow-up before 24h expiry. Chat-handling: always send OOO even if keyword matches (disables keyword/routing/bots after hours), auto-reassign on no response, nudge and close inactive chats, keep last assignee for expired chats, round robin for expired chats, round robin for new chats (skip offline / allow outside hours). Do not run when contact in a chatbot, chat is assigned to an agent, or an earlier default action already replied.
- Source: https://support.wati.io/en/articles/11463189-how-to-configure-default-actions-in-wati

### 3.9 Reply Materials
- Library of reusable automation payloads: Text, Document, Image, Video, Stickers, Chatbots, Sequence, Contact Attributes (set attribute = value), Templates, Catalog; plus Routing (notification, assign operator, assign team). Media limits on that page: image 5 MB, video 16 MB, audio 16 MB, document 75 MB, sticker 100 KB. No variable/placeholder support described there.
- Source: https://support.wati.io/en/articles/11463188-how-to-create-and-manage-reply-materials-in-wati

### 3.10 Sequences and follow-ups
- Sequence = ordered messages (text, template, sticker) with per-step delay (minutes/hours; first delay from trigger, later from previous send) and optional send windows (hours + weekdays). Started only by a rule/keyword action. "Stop sequence on customer reply" toggle; deleting a sequence cancels scheduled sends. Pro, Business.
- No-reply follow-ups: rule trigger "WhatsApp Customer No Response" with message-type scope (template / non-template / all), optional chat-status filter, per-message interval, stop on reply and stop on view/click. WhatsApp only, Pro and Business.
- Sources: https://support.wati.io/en/articles/11463186-how-to-use-the-sequence-feature , https://support.wati.io/en/articles/12992047-how-to-configure-follow-ups-when-a-customer-doesn-t-reply

### 3.11 WhatsApp Flows
- Meta-hosted in-chat forms; builder with templates (Lead Gen, Feedback), multi-screen, dropdown (up to 200 options), date picker; drafts editable, published flows are immutable. Sent via template (campaigns/API) or chatbot Flow node. Responses saved as contact attributes: one `<FlowName>_content` JSON attribute plus one per field. Plan limits: Growth 0, Pro 2, Business 10 flows. Meta prerequisites: verified business, messaging limit >= 2,000, high quality.
- Sources: https://support.wati.io/en/articles/11463180-how-to-create-and-use-whatsapp-flows-in-wati , https://support.wati.io/en/articles/11463191-understanding-custom-attributes-generated-by-whatsapp-flows

### 3.12 Chatbot sessions and Smart Escalation
- Statuses on a chat: Started, Ended, Expired (timeout inactivity), Blocked (a second bot cannot start while one is active). Only one bot/AI agent per conversation.
- Smart Escalation (per bot toggle): when customer replying to fixed-answer nodes (buttons, list, predefined question) asks for a human or shows frustration, transfer to a chosen team (current operator if on team and active, else round robin among active operators; none active = stays with bot and bot ends); otherwise fallback message.
- Chatbot analytics: Sessions, Completed, Dropped-off, Reassigned, In Progress, Completion/Drop-off/Reassignment rates; filters date (7/30/90 or custom up to 180 days), chatbot, channel, version; per-node User Journey and Session Logs; CSV export Business only; every save creates a version.
- Sources: https://support.wati.io/en/articles/17224772-how-smart-escalation-works-in-chatbot-flows , https://support.wati.io/en/articles/13938981-understanding-chatbot-status-updates-in-the-team-inbox , https://support.wati.io/en/articles/15733195-understand-chatbot-performance-with-chatbot-analytics

### 3.13 Quotas and what counts
- Automation triggers per month (reset on billing renewal date, not the 1st): Growth 1,000; Pro 2,000; Business 5,000. Chatbot sessions: same numbers per plan (separate counters on older plans; on newer plans the trigger add-on covers chatbot sessions and keyword actions).
- Counts as 1: each time an automation fires (any message type, including images/voice). Keyword reply then later separate chatbot trigger = 2. Keyword that starts a bot in the same flow = 1.
- Does NOT count: operator manually starting a chatbot in inbox, template messages sent via API, chatbots started via API, built-in Welcome/OOO rules.
- At limit: automations stop until upgrade, add-on, or reset. Alerts at 80/90/100%. Add-on price not published on these pages.
- Sources: https://support.wati.io/en/articles/11462996-understanding-automation-triggers-and-their-cost , https://support.wati.io/en/articles/11462994-understanding-monthly-chatbot-sessions , https://support.wati.io/en/articles/11462993-understanding-wati-s-pricing-structure

---

## 4. Contacts

### 4.1 Contact record, attributes
- Fields: Name, Phone (with CountryCode), Allow Campaign (opt-in flag), Allow SMS (not on Growth/Pro), source (e.g. WebChat, CTWA), contact owner, lead stage, custom attributes. Custom attributes: name unique; value max 256 chars; HTTP links clickable; per-workspace caps Growth 50, Pro 100, Business 500. Admin-managed at Settings > Tags and Attributes > Attributes. Attribute types (string/number/date) are not documented; reusing a name overwrites.
- Lead stage defaults: New lead, Contacted, Qualified, Proposal sent, Deal won, Deal lost. New lead / Deal won / Deal lost cannot be deleted (can be renamed); first stage in order is initial; customizable and reorderable. Pro, Business.
- Sources: https://support.wati.io/en/articles/11463439-how-to-add-and-use-contact-attributes-in-wati , https://support.wati.io/en/articles/12264879-understanding-contact-owner-and-lead-stage-attributes , https://support.wati.io/en/articles/11463438-how-to-add-a-single-contact-in-wati

### 4.2 Import / export / bulk update
- Import CSV <= 1 MB. Headers exactly `Name`, `CountryCode`, `Phone` in that order; CountryCode without "+", Phone without code/spaces/dashes; no formulas, no duplicates or empty cells; column mapping step then Confirm Import. Optional columns: Allow Campaign, Allow SMS, custom attributes from column F, `contact_owner`.
- Export to CSV gives the full list with attributes; re-import with "Update records" (overwrite) or "Skip records". Export includes BSUID field.
- API: v3 add/get/update/detail/count/delete contact; assign contact to teams; v1 update attributes (bulk for many contacts is Business).
- Sources: https://support.wati.io/en/articles/11463441-how-to-import-contacts-in-wati , https://support.wati.io/en/articles/11463442-how-to-bulk-update-contact-attributes , https://docs.wati.io/ (Contacts v3)

### 4.3 Segments
- Predefined (Pro, Business, auto-updating): Highly Engaged (read/clicked/quick-replied >= 3 campaigns in 90 days); Winback (last inbound message 30 to 90 days ago); At Risk (no inbound in 90 days); All Valid Contacts.
- Custom: Pro and Business, max 20 per account. Types Active (dynamic, re-evaluated) and Static (snapshot at save). Fields: contact attributes + "profile signals". Preview before save. Used as campaign audience and as a rule filter. Clone/rename/delete; large segments email when ready.
- Profile signals (32, system-computed): Contact last updated, Contact source, Channel type, First conversation date; Last message from contact / read by contact / reply from contact / from business; Last campaign received; campaigns received / read / replied counts for 7, 30, 90 days; Last link clicked; links clicked 7/30/90 days; Last inbound/outbound call and last answered inbound/outbound call; Last template used / type / sent date; Last CTWA ad source URL; First business reply to last CTWA message; Last CTWA message date.
- Operators: dates: Before, After, On, Day is in the last, Day is in this month, Day is in the month of, Is in the last; counts: numeric (>= shown, full set not listed). Text operators for attributes not listed on the segment page (rules use contains/is/is true).
- API: POST /api/v1/createCustomSegment {name, refreshType 1=static 2=dynamic, groups[].conditions[{attribute, operator ("==" shown), value}], contactIds[], useUploadedContact}. Errors: missing name, bad refreshType, dynamic without groups, feature not enabled, segment limit reached.
- Sources: https://support.wati.io/en/articles/14192386-how-to-create-and-use-custom-segments-in-wati , https://support.wati.io/en/articles/15374013-how-to-use-profile-signals-in-custom-segments , https://support.wati.io/en/articles/11660835-how-to-use-predefined-segments-in-campaigns , https://support.wati.io/en/articles/15165886-how-to-create-custom-segments-using-wati-api

### 4.4 Opt-in / unsubscribe
- Opt-in = per-contact `Allow Campaign` boolean (and `Allow SMS`). Campaigns use it. Collection of opt-ins is covered in a Campaigns article (not read).
- Unsubscribe: add a quick-reply "Stop" button (and footer hint) to marketing templates; built-in rule "Unsubscribe from campaign" (new accounts only; older accounts must create it) matches Stop/Unsubscribe and sets Allow Campaign to FALSE; confirmation message sent; chatbot Subscribe/Unsubscribe nodes do the same. Resubscribe flow exists in the older article.
- Sources: https://support.wati.io/en/articles/11463449-how-to-allow-users-to-opt-out-or-unsubscribe-from-campaigns , https://support.wati.io/en/articles/11463027-how-to-use-subscribe-and-unsubscribe-nodes-in-chatbot-builder

### 4.5 Deletion, merging
- Contact delete is a soft delete: chats and attributes are restored if the number is re-added or the contact messages again (block article, API doc "soft delete"). No physical GDPR erasure described.
- Merging: only automatic (Instagram + WhatsApp by phone; BSUID-only contact merged into phone contact when a number appears). No manual merge feature found.
- Delete attribute for all contacts: permanent, one at a time.

### 4.6 BSUID and WhatsApp usernames
- BSUID format `CC.<up to 128 alphanumerics>` (e.g. US.1349...). Per business portfolio; same user gets different values across portfolios; regenerates if the user changes phone number; username change does not change it. Arrives in webhooks when a user messages via a username; users cannot be found by searching a username. Username eligibility for businesses: messaging limit >= 2,000/day plus quality. Rollout: phased from June 2026; reserved usernames claimable from 29 June 2026 (article dated Aug 2026). Parent BSUID not mentioned.
- Wati behaviour: contacts may exist without a phone; BSUID stored automatically; duplicates merge when a phone arrives; manual import still needs phone; BSUID-only contacts do not sync to CRMs; Meta may stop returning the hidden phone after 30 days of no interaction (Wati permanently keeps any number it captured); returning users re-linked by BSUID. Campaigns reach BSUID-only contacts (country derived from BSUID prefix) but not authentication templates. SMS/RCS fallback skipped; contact search does not work for BSUID-only; calls and CTWA flows work. "Request Contact Info" button in utility/marketing templates collects the number and maps it. Inbox shows display name, username or BSUID when phone hidden. Webhooks are BSUID-first (`bsuid` always present, `waId` optional): Message Received, New Contact Message, Session Message Sent v1/v2, Template Message Sent v1/v2, Chatbot Triggered, CTA Button Clicked, Call Status. New chat form accepts phone or BSUID.
- Sources: https://support.wati.io/en/articles/15418392-whatsapp-usernames-are-coming-a-guide-to-bsuid-and-what-it-means-for-your-business , https://support.wati.io/en/articles/15418393-whatsapp-username-support-changes-in-wati

### 4.7 UTM / attribution
- WhatsApp click-to-chat widget script puts UTM/custom values into a compressed `[ContextId: ...]` in the prefilled message; keyword rule starts a chatbot with Collect UTM node then Update Attribute. Final attribute name not stated. WhatsApp only.
- Source: https://support.wati.io/en/articles/15097391-how-to-capture-and-store-utm-parameters-in-wati

---

## 5. Analytics and reporting

### 5.1 Team Inbox analytics (Analytics > Inbox Analytics)
- All plans; roles Administrator or Dashboard Viewer; WhatsApp only (not Instagram/Messenger); per-number dropdown; default last 7 days (inclusive range); legend toggle; zoom/pan; "Preview with sample data"; per-chart export via ⋮ (formats unspecified).
- Ten charts: Overview; Ticket status over time; Total ticket count by status; Operator performance; Count of tags (top 20); Ticket duration vs count; Sent vs received messages; Sent messages by type; Message delivery status; Total messages by type (primary number only).
- Overview cards: Open and Pending (live, ignore date range); Solved (split Solved by Bot / by Operator, determined by who owned the ticket at solve time); Expired (no solve within 24h of last customer message); Missed Chats (expired that were assigned to an operator/bot and got no response, subset of Expired). Cards drill down to the chat list showing current (not historical) status.
- Sources: https://support.wati.io/en/articles/11463148-how-to-use-team-inbox-analytics-in-wati , https://support.wati.io/en/articles/11463146-understanding-the-overview-section-in-team-inbox-analytics

### 5.2 Operator Performance report
- Columns: Operator (name+email), Current Open, Current Pending, Tickets Assigned (Pro/Business), Tickets Solved, Tickets Expired (Pro/Business), Missed Chats, Average First Response Time (from assignment to first reply), Average Resolution Time (excludes Pending time), Operator Availability (online time over web+mobile; Pro/Business). Search operators, sort any column (default Current Open desc), manual refresh once per 5 min, CSV export containing period, export date, timezone.
- Source: https://support.wati.io/en/articles/11463147-understanding-the-operator-performance-report

### 5.3 Scheduled Team Inbox report
- Weekly email, chosen weekday, 9:00 in chosen timezone, multiple recipients, subject "Your Weekly Team Inbox Analytics Report", body with week-over-week % changes, CSV attachment: Contact Name, Team(s), Operator Name (Bot for bots), Ticket Status, Tags, Ticket Link, Ticket Opened At, Ticket FRT, Resolved At, Ticket Resolution Time, Expired At. Statuses include Solved by Bot/Operator and Expired split into missed / pending-on-customer / other (pending-on-customer split Business only). Campaign chats excluded. Pro and Business. Download Sample available.
- Source: https://support.wati.io/en/articles/11463143-how-to-schedule-and-use-the-team-inbox-report

### 5.4 Sales Analytics (beta)
- Pro/Business, by request. Needs Contact Owner + Lead Stage. Metrics: deals won/lost, lead conversion rate, avg first response time, avg response time (all messages). Views: overview, Sales Pipeline chart, operator performance. Downloads: operator performance, pipeline. Filters: operator, date range.
- Source: https://support.wati.io/en/articles/12688877-understanding-sales-analytics-in-wati

### 5.5 Other
- Chatbot analytics: see 3.12. Campaign analytics: click counts on Campaigns Overview, "View Insights", filter recipients who clicked a given link / any link for retargeting (not fully read). CTWA tracking article exists.
- 5.6 Click tracking: tracked "Visit Website" template buttons use a Wati redirect domain (default whatsapp.wati.io, optional custom subdomain); Pro and Business; segment signals "Last link clicked / total links clicked". Sources: https://support.wati.io/en/articles/11463471-how-to-enable-click-tracking-for-my-template-messages , https://support.wati.io/en/articles/11463454-how-to-view-campaign-analytics

---

## 6. WebChat widget
- Growth, Pro, Business. Style editor: display name, colour theme, branding, welcome message. Optional pre-chat Lead Generation Form (title, subtitle, placeholders, hide fields); answers appear next to the conversation. Install by script before `</body>`, Google Tag Manager, Lovable, Webflow, Shopify, WordPress, Trickle; disable-edit-enable cycle for changes; do not serve the script from a CDN. Installing auto-creates "Default Team WebChat"; more teams can be granted access. Chats appear under the WebChat channel; assign/reassign, close by setting Solved. Visitors become contacts with source WebChat. History is tied to browser/device (new browser = new conversation).
- Not documented: offline behaviour, domain allow-list, attachments, rate limits, identity verification, business hours.
- Source: https://support.wati.io/en/articles/16884887-how-to-set-up-and-manage-webchat-in-wati

---

## 7. Privacy and security
- Phone masking (Business): per-operator toggle "Mask contact phone number for this user", default off; shows first 3 and last 4 digits; applies in inbox contact info, system messages, new-chat picker, `{{phone}}` in quick replies/templates; search by last 4 digits. Effect on exports/contacts page/API unconfirmed. Source: https://support.wati.io/en/articles/11463006-how-to-hide-or-mask-customer-phone-numbers-in-wati
- Chat privacy: view-only-assigned (1.10); private notes (1.13).
- 2FA: authenticator app (Google Authenticator/Authy) or emailed code; once on, enforced for all users; non-2FA accounts get an adaptive email OTP on a new device/IP (last 10 IPs remembered). Recovery: reset password and re-enrol. Source: https://support.wati.io/en/articles/11463220-how-to-enable-two-factor-authentication-2fa-in-wati
- Admin force-logout of a user (all sessions). No documented idle timeout.
- Audit: logs login success/failure and logoff; read-only files; retention unspecified; no in-app audit trail of data/config changes documented. Security best-practice page does NOT mention IP whitelisting, SSO or audit logs.
- Hosting/data: each instance in its own Docker container/network; separate database per customer; backups twice daily, kept 365 days in GCP buckets across regions; dedicated hosting with chosen location is a paid option (USD 1,000/month); default region not named; pen test last Oct 2024; encryption not described; trust centre trust.wati.io.
- Compliance claims: GDPR "fully compliant" (general statement; no DPA or subject-request procedure on the page); no SOC 2/ISO claim found on the pages read. Account termination: data retained up to 90 days then permanently deleted incl. backups; export only via support.
- API security: bearer tokens, scopes such as `api`, `conversationsv3:write`; key-rotation notice exists. Webhooks retry up to 144 times at 10-minute batches; flagged defective after >100 consecutive failures.
- Sources: https://support.wati.io/en/articles/11463219-wati-security-overview-data-protection-backups-and-hosting , https://support.wati.io/en/articles/11462490-is-wati-gdpr-general-data-protection-regulation-compliant , https://support.wati.io/en/articles/13570880-security-best-practices-to-safeguard-your-wati-account , https://support.wati.io/en/articles/13697710-wati-account-termination-everything-you-need-to-know

---

## 8. Pricing facts that shape behaviour
- Meta: 1,000 free service conversations per WhatsApp number per month on legacy plans; page says service messages in the 24h window were free until 30 Sep 2026 and Meta charges from 1 Oct 2026 (WATI pages: .../16954666-... and 11462997). Message-based pricing articles exist (11561662) but not read in detail. Prepaid credits are needed for messages not covered by allowances.

---

# Implementation implications (prioritised)

| # | Item | Size | Data model additions |
|---|---|---|---|
| 1 | Core inbox: conversation list, thread view, composer, realtime updates, statuses with 24h timer engine, template-only mode when expired | XL | `conversation(id, channel, contact_id, status, assignee_user_id, team_ids[], last_customer_msg_at, window_expires_at, is_new, favorite, unread_marker_msg_id, last_assignee_id)`, `message(id, conv_id, direction, type, body, media_id, wa_message_id, status sent/delivered/read/failed, author_type user/bot/ai/system, author_id, reply_to, created_at)`, `status_event(conv_id, from, to, actor, at)` |
| 2 | WhatsApp Cloud API plumbing: webhook ingest (messages, statuses, calls), media download/upload with size limits, template send, interactive buttons/list, typing indicator, BSUID-first identifiers | XL | `wa_number`, `webhook_event_log`, `media`, `contact_identifier(contact_id, type phone/bsuid/username, value)` |
| 3 | Users, roles, teams, default team, seats, presence/away | L | `user(role[], seat, away, online_at, view_only_assigned, mask_phone, display_name)`, `team`, `team_member`, `role_grant` |
| 4 | Assignment engine: manual, last assignee, round robin, load-based, skip offline/away, auto-reassign on no-response, bot-vs-human ownership | L | `routing_config(team_id, mode, include_admins, skip_offline, outside_hours, reassign_after_sec, max_open)`, `assignment_event` |
| 5 | Contacts: attributes with caps, CSV import/export/update, opt-in flags, block, soft delete, owner, lead stage, identity merge | L | `contact(name, allow_campaign, allow_sms, owner_id, lead_stage_id, source, deleted_at)`, `attribute_def(name, type, plan_cap)`, `contact_attribute(value<=256)`, `lead_stage(order, locked)` |
| 6 | Rules engine (trigger/filter/action, AND/OR groups, ordering, one-bot-wins, suppression conditions, quota metering) | XL | `rule(trigger, position, enabled, filter_tree json)`, `rule_action`, `rule_execution`, `trigger_usage(period_start, count)`, `reply_material` |
| 7 | Working hours, holiday mode, welcome/OOO built-ins with 30-min throttle | M | `working_hours(number_id, tz, day, ranges[])`, `holiday_mode` |
| 8 | Quick replies, private notes with mentions, tags, favorites, unread, bulk actions (cap 15), saved filters | L | `quick_reply`, `note(conv_id, mentions[])`, `tag`, `conv_tag`, `saved_filter(visibility, user_ids[])`, `mention` |
| 9 | Segments (static/active), profile-signal computation, predefined segments | L | `segment(type, filter_tree)`, `segment_member`, `contact_signal` (rollups: last_inbound_at, campaigns_received_7/30/90, links_clicked_...) |
| 10 | Analytics: inbox overview, operator performance, scheduled weekly CSV email, tag counts | L | `ticket` view/materialised over conversation episodes (opened_at, first_response_at, resolved_at, expired_at, pending_duration, solved_by), `operator_presence_session` |
| 11 | Chatbot builder + sequences + Flows + smart escalation + chatbot analytics | XL | `chatbot`, `chatbot_version`, `chatbot_session(status, last_node)`, `sequence`, `sequence_run` |
| 12 | WebChat widget + inbox channel | M | `webchat_widget(theme, form_schema)`, `visitor(browser_id)`, `webchat_form_submission` |
| 13 | Security: 2FA, session revoke, adaptive OTP, masking, audit log, data export/delete | M | `login_audit`, `user_session`, `known_ip` |
| 14 | Chat export/transcripts, conversation deep links | S | export job table |
| 15 | Public API and webhooks (v3 conversations/contacts, scopes, retries) | L | `api_token(scopes)`, `webhook_subscription`, `webhook_delivery(attempt)` |

# Details that are easy to get wrong
1. Expiry is customer-silence based, not business-silence: 24h from the last INBOUND message. Pending chats also expire. A business reply never extends the window.
2. Solved is not terminal: a customer message reopens it (to Open). Same for Expired and Campaign. Expired chats cannot be bulk-solved or pended.
3. Statuses mix different axes (state, origin = Campaign, moderation = Blocked). Analytics counts "Solved by Bot/Operator" by who owned the ticket at solve time.
4. Read state is shared across all users, not per-user; "mark unread" works only on a specific unreplied inbound message in a human-assigned chat.
5. Bot replies never count as "replied"; a manually sent template does.
6. Blocking does not stop inbound delivery; messages are stored, notifications muted, and rules skip.
7. Rules: all matching rules fire, but only the top matching one may start a bot/AI agent; message-triggered rules are suppressed when a bot is active or a human/AI agent owns the chat; non-message triggers can steal the chat back to a bot unless the action is route/update attribute/notification. Reactions never trigger.
8. Trigger metering counts every fire, including on non-text media (surprise cost); API and manual bot starts are free; billing-cycle reset, not calendar month.
9. Free-form rule actions fail outside the 24h window; template actions do not. Sequences need a template first step to start outside the window.
10. Round robin applies only to chats with exactly one team; manual assignments are not redistributed; Away users are skipped except for contact-owner routing and calls; specific-user routing to an Away user goes to the bot rather than the next person.
11. Working hours: no overnight ranges (split in two), no overlaps, only the last row per day applies, per-number hours, rules ignore hours without an explicit Timestamp filter, and OOO is throttled to once per 30 min per conversation.
12. Tags are admin-created and conversation-scoped; they cannot target campaigns. Segments are the contact-level equivalent and need attributes.
13. Phone import format is split (CountryCode and Phone separately, no "+"); import file capped at 1 MB; duplicate numbers in file not allowed.
14. Contact deletion is soft and resurrects history when the number reappears.
15. BSUID-only contacts: no search, no SMS/RCS fallback, no authentication templates, not imported manually, not synced to CRMs; the phone number may stop being returned after 30 days, so store it when first seen; merge profiles when a phone later appears; identifiers are per business portfolio.
16. Masking shows first 3 + last 4 digits and must also apply to template/quick-reply variables and to search (last 4 only).
17. Operator visibility: restriction is per user, Business plan, WhatsApp only, and interacts with the Contact Manager role. Mentioned operators from other teams are read plus notes-only.
18. Analytics: Open/Pending cards are live and ignore the date range; drill-down shows current status, not historical. ART excludes Pending time; FRT starts at assignment, not at message arrival.
19. Default Team is mandatory and singular; deleting or renaming interacts with fallback visibility.
20. Plan gating is pervasive (Pro/Business/Enterprise) and per-feature; model entitlements as data, not code.

# Unverified or unclear
- Public roadmap: web search found nothing for WATI; no roadmap page located. (support.wati.io home and wati.io pages not exhaustively crawled.)
- SLA/response-time targets and breach alerts: no feature found; only reply-timer default actions (11463189).
- Ticket entity (priority, category, ID format): not documented; "ticket" used as a synonym for conversation episode in analytics (11463146).
- Filter AND/OR across inbox filters and tag multi-select semantics (11463016, 11463012).
- Unread count formula; favorites scope (11823176, 11463017).
- Outbound location/contact/reaction/reply (quote) messaging in inbox UI; incoming reaction display; CTA URL send from inbox (only templates; API v3 interactive = buttons and list) (11463010, docs conversations_sendinteractivemessage).
- Canned-reply visibility (personal vs shared), caps, plan (11463011). Private-note edit/delete and mention notifications (16798275).
- Max capacity for load-based routing, auto-reassign timer values, whether chats are reassigned when an operator turns Away (14270796, 16843441).
- Complete rule trigger list (schedule, Shopify, missed call, customer no response described elsewhere), full text-operator list for attribute filters and segments, segment AND/OR UI (12321649, 14192386, 15165886).
- Blocked contacts and campaigns; who may block (11463005).
- Roles: custom roles, action-level permission matrix, Automation/Billing Manager menus (11463020).
- Manual contact merge feature, dashboard contact delete UI, contact-level GDPR erasure (no article found; only API soft delete).
- Message delivery status enum, message `type` enum, `owner` meaning (docs conversations_getmessagesbyconversationid).
- Webhook event names and payload schemas (docs introduction-1 only names categories; sample callbacks require dashboard access).
- Masking effect on exports/API; encryption at rest/in transit; IP whitelisting, SSO, audit logs of config changes, data residency regions (13570880, 11463219); SOC 2/ISO/HIPAA claims (only trust.wati.io referenced, not fetched).
- Per-plan pricing, seat add-on prices, trigger add-on price (11462993, 11462997 point to wati.io/pricing).
- WebChat offline behaviour, domain allow-list, limits (16884887).
- Campaign analytics page, opt-in collection article, message-based pricing, CTWA tracking, chatbot node details beyond the guide, Instagram/Messenger-specific inbox behaviour were not read in depth (out of assigned scope).
- Attribute data types and the final attribute name used by UTM capture (11463439, 15097391).
