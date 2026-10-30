# WATI feature inventory: chatbots, AI (Astra, Wati AI, MCP), calling, groups, WebChat and extra channels

Research date: 2026-10-26. Method: public pages only (support.wati.io, docs.wati.io, wati.io). All descriptions paraphrased. Plan names used by WATI: Growth, Pro, Business, Enterprise (older articles say "Regular" plan, which is roughly the lower tier). Where an article contradicted itself or another, both versions are noted.

Base help URL prefix: https://support.wati.io/en/articles/ (abbreviated below as `SW/`). Docs: https://docs.wati.io/reference/.

---

## 1. No-code chatbot flow builder

Entry: Automation > Chatbots > Add Chatbot (name it, optionally start from a Library template filtered by industry or language). Drag-and-drop canvas with zoom, collapse and a floating overview. Flows are connected by arrows; a start node is triggered by a keyword rule, default action or rule. Source: SW/11462457, SW/13934658.

Two older concepts exist side by side: "Automation reply material" (single static replies) and the Chatbot Builder (multi-step flows). Default Actions (welcome / out-of-hours / no-agent-online / fallback) are called legacy; WATI recommends Rules instead (SW/11463189 via search).

### 1.1 Node catalogue

| Node | What it does / how operated | Plan | Channels | Source |
|---|---|---|---|---|
| Send a message | Sends text, image, video, audio or document (PDF, DOCX). No input expected; often the last node. | All | WhatsApp, Instagram, Messenger | SW/13934658 |
| Ask a question (free text) | Collects any reply and can save it to a `@variable`. Optional validation: number (min/max, custom error), date, date+time, time, regex pattern, media type. Accepts documents, images, videos; audio and voice notes NOT accepted. Media location can be saved to a variable and fetched later with `getMedia`. | All | WA/IG/FB | SW/11463047, SW/13934658 |
| Ask a question (answer variants) | Predefined options each with a number; user replies with the number. Unmatched replies go to a general fallback path. | All | WA/IG/FB | SW/11463047 |
| Buttons (reply buttons) | Max 3 buttons, 20 chars each; optional media header; header text (no markdown), body, footer; answer can be saved to variable. | All | WhatsApp only (IG/FB do not support Button, List, Catalog, Subscribe, Unsubscribe, Trigger chatbot, Template nodes per SW/11462457; yet IG has an "Instagram button template" for comment-to-DM) | SW/11463030 |
| List message | Max 10 rows (24 chars each), sections with titles, button text, header/body/footer; answer to variable. | All | WhatsApp only | SW/11463030 |
| Set a condition | Branch on a variable, contact attribute or reply. Operators: equals, not equals, contains, does not contain, starts with, does not start with, greater than, less than. Max TWO conditions combined with AND/OR per node. TRUE = green path, FALSE = red path. No documented "else" beyond red path. | All (Growth: basic) | WA/IG/FB | SW/11463038, SW/13934658 |
| Template message | Sends an already approved WhatsApp template; can fill variables from earlier captured attributes. Cannot create templates inside the builder. Button routing not documented. Growth can build/save but not use it in Keyword/Default actions (upgrade prompt). | Basic list for IG also names it | WhatsApp | SW/11463028 |
| Webhook | GET or POST to a URL with variable interpolation (`{{name}}`), optional headers, JSON-only body. Response fields mapped into variables or attributes via dot notation or JSONPath-like paths (`Result.QuoteId`, `$.[0].key[0].value`). Test button with test variables. Routes on response status code (success vs failure paths). Timeouts not stated. | Pro, Business | WA/IG/FB/TikTok | SW/11463025 |
| Google Sheets | OAuth to a Google account, pick spreadsheet and worksheet, map variables to columns, insert new row OR update row by reference column. Button/list answers auto-stored. One Google account links to one WATI account at a time. | Pro, Business | WA/IG/TikTok | SW/11463037 |
| Update Attribute | Writes a value to a contact attribute (type "Custom Attribute") from a fixed value or a variable (type "Variable"). | Pro, Business (advanced) | all | SW/11463043 |
| Subscribe / Unsubscribe | Sets contact's "Allow Campaign" attribute to Yes / No (opt-in/out of campaigns). | Pro, Business | WhatsApp | SW/11463027 |
| Set Tags | Tags the chat/contact for filtering in inbox. | Pro, Business | all | SW/11463045 |
| Assign Agent (user) / Assign Team | Routes ticket to an operator or team(s). Assign Team: direct or Round Robin (Business/Enterprise). If operator is not in the ticket's team, their team is added. Ends the flow in the escalation case (see 1.4). | Pro, Business | all | SW/11463034 |
| Update Chat Status | Sets chat to Solved, Pending or Closed. | Pro, Business | all | SW/11463045 |
| Time Delay | Waits 1 second to 10 minutes between steps. Delays beyond the Instagram 24-hour window can block later automated messages. | Pro, Business | all | SW/11463045, SW/11463035 |
| Trigger Chatbot | Jumps to another existing chatbot (cannot pick itself); a flow can hold several. Whether control returns, loop protection and nesting depth are not documented. Import/export does NOT keep trigger targets. | Pro, Business | WhatsApp | SW/11463049 |
| Wati AI Assist | LLM-driven node that collects ONE contact attribute (phone, email or custom variable) conversationally. Fields: what to collect, description (max 200 chars, custom only), prompt (max 500 chars), variable name. Success and Failure outputs; unconnected Failure stops the conversation. Max 2 per chatbot. Can be first node. Credit cost not stated. | Pro, Business | WA/IG/FB | SW/17226918 |
| Astra AI Agent | Hands the conversation to one Astra agent. Terminal node (no outputs), cannot be first. Unlimited count. | All plans (needs Astra account) | WA/IG/FB | SW/15186551 |
| Custom AI Agent | Hands conversation to a bring-your-own agent registered via Connect AI Agents. Same behaviour as above. | All plans with add-on | WA/IG/FB | SW/15186551 |
| Operations / Integrations / Catalog groups | Named as Pro/Business node groups; detail not given in the nodes guide. Catalog node behaviour not documented in any page found. | Pro, Business | n/a | SW/11463029 |

Data needs: Chatbot (name, nodes, edges, channel, version), Node (type, config JSON, outputs), Variable (session scoped), Contact attribute (persistent).

### 1.2 Triggers (how a chatbot starts)

- Keyword rule: trigger "New WhatsApp message received" or "New Instagram message received", filter "incoming message matches keyword rule" with exact match (one article); another article says match types for Facebook comment rules are Fuzzy / Exactly / Contains. Keyword matching is case-insensitive; exact match needs exact spacing (SW/13938150, SW/11463044).
- Rule engine (Automation > Rules) triggers: new WhatsApp message, new Instagram message, new Messenger message, contact attribute created, attribute value changed; filters: keywords (also match captions, voice-note transcripts, button/list reply text), message filters, has/hasn't media; actions: send template, welcome, out-of-office, start chatbot, route chat, update attributes (SW/12321649; MCP article adds "customer has not replied" trigger, SW/17731713).
- Default Action (legacy): first-message welcome, outside hours, no agent online, fallback; priority order in that sequence, only one fires per message; only runs if contact not already in a bot flow and chat not assigned to an agent (SW/11463189).
- Another chatbot via Trigger Chatbot node; Team Inbox manual "Trigger chatbot"; API `Start chatbot` (docs chatbots_startchatbot).
- Ad-click and schedule triggers for chatbots: NOT found as chatbot triggers (see section 13). CTWA ad chats arrive as conversations that rules can react to.
- Conflict rules: one chatbot or AI agent per contact per channel at a time; when several rules match, only the highest-priority one starts a bot (other actions still run); a rule cannot interrupt a running bot; conversation must be assigned to a Bot, not a human; flow needs connected start node plus at least one message node (SW/11463044).

### 1.3 Variables, attributes, scope

- Session variables `@name`: live only in that run, cleared at session end; set via question/list "save answer", used in messages, conditions, Update Attribute.
- Contact attributes `{{name}}`: persistent on the contact, set via Update Attribute; usable for segments, campaigns, personalisation.
- Built-in: `{{phone}}` only when WhatsApp and the user has not hidden the number (username). Recommend a condition fallback.
- Not documented: data types, defaults, count/length limits. Source: SW/17021993.

### 1.4 Session handling, fallback, escalation

- Chatbot Timer (global setting): Timer 1 closes session after inactivity, 1 to 1,440 minutes; Timer 2 sends an editable "exit chatbot" reminder, must be at least 1 minute shorter than Timer 1. Docs inconsistent on when reminder shows (SW/11463040).
- Fallback message (global or per bot): text shown on invalid reply; 1, 2 or 3 retries then session ends. Works on Question (predefined answers only), Buttons, List, Template (multi-button) (SW/11463031).
- Smart Escalation (per chatbot, rolling out): when customer asks for a human or seems frustrated on a fixed-answer node, chat is assigned to chosen team and bot ends. Assignment order: contact's assigned operator if on team and active, else round robin among active operators. If no operator active, chat stays with bot, bot ends, customer-facing result unspecified. Does not apply to free-text, validated-format or media replies. Without Fallback message enabled, non-help unrecognized replies get no response. Channels WA/IG/FB. Detection method and context shown to operator not documented (SW/17224772).
- Why bots stop: unexpected reply with no path, media on a non-media node, timer expiry, misconfigured Webhook/Sheets node, plan restriction, terminal AI node, assign-to-team (SW/11463044).
- Backward navigation is hand-built: default action matches previous-step input and links back (SW/11463048).
- Inbox status chips: Started, Ended, Expired, Blocked (another bot active) (SW/13938981).

### 1.5 Testing, import/export, versioning

- Test: set a test WhatsApp number in the chatbot menu, scan QR / WhatsApp Web, converse with the business number; free (SW/11463032).
- Export/import as JSON (admin). Not carried over: media, team/agent assignments, templates, Google Sheets connections, Trigger Chatbot targets (SW/11463041).
- Versioning: the analytics article implies published versions with a version dropdown; MCP article says every save creates a new version and old versions are retained (SW/15733195, SW/17731713). A human-facing version history UI is not documented.

### 1.6 Analytics per flow (all plans; CSV export Business only)

Metrics: Sessions, Completed (incl. routed to another bot or AI agent), Dropped-off (no reply, timeout, technical failure), Reassigned (to human by Assign node), In Progress; KPIs: completion, drop-off, reassignment rates. Filters: date (7/30/90 days or custom up to 180), chatbot, channel, version. User Journey view (Show performance toggle) gives per-node session count and completion percent plus branch split percentages for Condition/Button/List. Session Logs list status, contact, phone, conversation ID, start time, last node, nodes traversed; filter and export. Source: SW/15733195.

### 1.7 Limits and plans

- Chatbot count: Advanced builder page says "up to 25 chatbots" (vs 10 standard) while its FAQ says unlimited for Pro/Business under 2025 plans and Growth allows 2. Unreconciled (SW/11463045).
- Growth: send, ask, condition only. Pro/Business: operations, integrations, catalog, webhook, sheets, delay, assign, tags, AI Assist.
- Instagram plan matrix confirms basic nodes (Send, Ask, Condition, Template) on all plans and advanced list on Pro/Business only (SW/16979915).

---

## 2. Astra (AI agent platform)

Astra is a separate product with its own login and workspace (help centre also on astra-help.wati.io), sold standalone and bundled with Wati. EU accounts use an EU instance. Positioned for lead qualification, support, booking; marketing claims 30+ languages, one agent across web, WhatsApp, phone, SMS, RCS with shared memory (https://www.wati.io/products/astra/ ; claims unverified, SMS/RCS deployment not seen in help docs).

### 2.1 Creating and configuring an agent ("Astra Vibe")
- Agents > + New agent. Choose role (support, sales, lead qualification, booking), channel (Web, WhatsApp, Instagram), type (text or voice), website URL. Astra crawls the site, applies branding and pre-fills instructions. User edits instructions directly or describes changes in plain language to Astra Vibe, which rewrites instructions; user clicks Approve. Vibe can also attach knowledge bases, add variables and actions. Source: SW/13192821.
- Agent record needs: name, role, channel, instructions (versioned draft vs published), branding (web only), business context, variables (collected fields, can become contact properties), knowledge sources, actions, voice settings, escalation instructions.
- Deep clone: duplicate an agent to another channel (copies training and settings). One agent = one channel and, for WhatsApp, one number; separate copy per number, no sync (SW/13193160, SW/15604047, SW/17634410).
- Branding: customise widget look (SW/11756496).

### 2.2 Knowledge and training (SW/11755911)
Sources: website links (single page or crawl with subpage selection), documents (PDF, DOCX, TXT, MD), Q&A pairs; Notion/Drive/Confluence "coming soon". Auto-processing with progress bar, "retrain" after content changes. Instructions say when each source is used. Size caps are per plan (below), not per file. Knowledge-base automation (feeding good conversations back) is Pro+ (SW/17565154).

### 2.3 Actions / tools (SW/13193207, SW/14167869)
Library of templates, created from the library or by describing in Vibe. Action record: name, intent (what it does and when), template settings, connected account, status (draft vs saved), linked agents, execution count, credits used. Draft actions invisible to agents; actions in use cannot be deleted; accounts in use cannot be disconnected; edits apply immediately to live agents.
Categories:
- Core: web search, REST API action.
- Lead gen: custom forms, lead qualification criteria.
- Wati actions: create/update contact, assign conversation to team/user/bot, send session / template / interactive / booking / sales summary / follow-up message.
- CRM: HubSpot, Salesforce, Zoho, Pipedrive (create/update contact), HubSpot assign to user.
- Slack: send channel message. Google Sheets: add row, update row, search rows.
- Auth: none (web search, forms), OAuth2 (Slack, Sheets, HubSpot), non-OAuth (Wati, REST).
- Online vs offline sync for CRM/Sheets-update: online fires mid-conversation when agent's instruction condition is met; offline queues until conversation ends (text agent: 10 minutes after last message; voice: at call end). Offline cannot be tested in test mode (SW/14468879).
- REST API action events: thumbs up/down (fixed values only), form submitted (dynamic fields matching placeholders), lead captured (fires ~10 minutes after conversation end, fixed payload with name, email, lead level, score, not customisable) (SW/13436585). Setup, auth and troubleshooting articles exist (SW/13436389, SW/13437732, SW/14818881, SW/13436986) but were not read in full.
- Custom forms: fields text, dropdown, attachment, each labelled and required/optional; show whole form at once; trigger = smart timing, conversation start, or after feedback; frequency (responses before showing, 0 = immediately); max attempts; completion forced before chat continues; data mapped to lead/session; draft vs published (SW/14665717).
- Costs: simple text response or action 1 credit; rich response or advanced action (images, PDFs, tables, webhooks) 3 credits; voice 8 credits per minute (SW/12135485).

### 2.4 Lead qualification and leads (SW/11755918)
Default BANT (Budget, Authority, Need, Timeline), per-criterion weights, custom criteria/questions/scoring supported. Output: score plus category (examples high/medium/low/unqualified). Leads viewable as contacts (SW/11757378). Growth gets form-based qualification only; Pro+ gets BANT (SW/17565154). Score formula undisclosed.

### 2.5 Guardrails, evaluation, quality
- Guardrails are instruction-based only: define in-scope topics, refusal conditions, handoff conditions, no-invention rule; test refusals before deploy (SW/15604047). No separate content-filter product documented.
- Automated evaluation: test cases auto-generated from instructions (categories: standard query, implied problem, off-topic), plus CSV upload or manual; run selected or all; per-case pass/fail with explanation; overall Efficiency score, Accuracy, Latency; "Analyse results" then "View recommendation" then "Update instructions" with review; re-run (SW/14532662). Scoring formulas and thresholds undisclosed.
- Playground for testing text and voice before install (SW/15434001).

### 2.6 Handoff to humans
- WhatsApp: add escalation instructions plus an "Assign to team/user/bot" action; escalated chat lands in Wati Team Inbox (SW/13193160). Optional sync of up to 60 days of conversation history on deploy. Context passed to the human is not described beyond that.
- Instagram agent supports only two actions: hand over to human, update phone number (SW/17634410).
- Voice: real-time monitoring, supervisor access, takeover, admin notification when a customer asks for a human (SW/14016307). WhatsApp voice article describes no human transfer (SW/13193217).
- Supported inbound WhatsApp types for Astra: text, buttons/lists replies, images, audio. Video, documents, stickers, location, contacts, orders unsupported (agent says so in user's language) (SW/13193160).

### 2.7 Voice agents (SW/13859342, SW/14016307, SW/13193217)
Pro/Business. Deploy to website or WhatsApp (inbound and outbound calls; "Test outbound call"). Config: voice model, languages and accent, auto language detection, accent adaptation, silence handling (wait time, retries, message), max call length (recommended 300 s). Voice cloning from live recording or MP3/WAV/M4A up to 50 MB; saved with name, language, accent, gender. New languages: Telugu, Gujarati, Marathi, Cantonese. Pro = single language; Business = dynamic switching. Calls handled by Astra voice are NOT recorded or transcribed by Wati (WebRTC stream inaccessible) (SW/14472037). Voice agent shares text agent training data.

### 2.8 Models, BYO
No model/provider named in any Astra page. Wati AI "Agents" let users edit a model setting (SW/16527975) but options are not listed. Bring-your-own agent = "Connect AI Agents", see section 4.

### 2.9 Analytics (SW/15444557 and sibling articles, titles only)
Astra Dashboard (AI performance and ROI), core performance, cross-channel comparison, language and off-hours coverage, AI-generated leads and conversions. Content of these not read.

### 2.10 Plans and credits
Two inconsistent tables:
- Standalone Astra (SW/11757585): Free 1 agent, 1 member, 100 credits, 1 MB; Pro up to 3 agents, 4 members, 5,000 credits, 50 MB per agent; Business unlimited agents, 10 members, 25,000 credits, 100 MB per agent, success manager; Custom negotiated. Rollover: unused subscription credits carry forward capped at 2x monthly allotment; add-on credits expire after one month; consumption uses soonest-expiring first, add-on before subscription (SW/14076302).
- Wati+Astra bundle (SW/17565154, India only): Growth 1 active agent / 5 MB, Pro 2 / 25 MB, Business unlimited / 50 MB, Enterprise unlimited / 500 MB (the search snippet said Business 50? snippet-vs-page text differ: search summary listed "Pro 25 MB, Enterprise 500 MB", page lists Business 50 MB). Extra credits add-on minimum 2,000. Slack summaries Pro+, call recording/transcripts Business+, voice agent Business+ (this conflicts with the voice article saying Pro), multiple WhatsApp accounts add-on for Business, 3 free on Enterprise.
- Dollar prices not on help pages.

### 2.11 Astra APIs and MCP
API keys (server-to-server) and OAuth Apps (user-consented) manage agents, knowledge bases, analytics, webhooks (SW/15529572, SW/15529334, SW/15529413). Endpoint list not published in help; see Astra API docs (not read). Agents manageable via Wati MCP (SW/15899996).

---

## 3. Wati AI co-pilot (inbox AI add-on)

Credits are shared per account; quotas Growth 250, Pro 500, Business 1,500 per month, reset on the 1st; alerts at 75/90/100 percent; at limit AI features pause for all operators; extra credits via "Buy Wati AI Credits"; upgrades prorate immediately (SW/12829730). Costs per use: AI Template Generator 1, AI Translation 1, HubSpot summary sync 1, AI Editor 1 per tool use, CX score 1 (text) or 3 (text and voice). General Conversation Summary cost not stated.

| Feature | Behaviour | Limits / plan | Source |
|---|---|---|---|
| AI Editor | Match Tone (from brand-tone sample), Fix Grammar, Improve Writing, Generate Response (draft from history + saved knowledge + tone). Select up to 10 existing messages as knowledge. | Growth/Pro/Business | SW/13557513 |
| Editor suggestions from past conversations | Weekly job samples high- and low-rated conversations, proposes up to 12 items (5 Q&A, 2 positive patterns, 2 anti-patterns, 3 knowledge gaps) with High/Med/Low confidence, PII excluded; admin approves, edits or skips; account must be 90 days old with 50 rated conversations; Pro/Business. | | SW/16472495 |
| Conversation Summary | Auto on Closed/Expired; manual by operator; needs at least 10 new messages; stored in a tab; Beta. | Growth+ | SW/12866211 |
| AI Translation | Beta. Admin enables and sets one target language for incoming; per chat toggle translates last 5 messages then all new, both directions; view original. Not applied to bot messages, campaigns, templates, AI agent messages. | Growth+ | SW/12232014 |
| CX Score | Beta. Each eligible conversation (closed/resolved/expired, at least 2 customer and 2 business messages) rated 1 to 5 on sentiment, resolution, service quality; headline = share of 4s and 5s. Stored as contact attribute `cx_score_{number}` and `cx_score_latest` for segmentation. | Growth+ | SW/12688612 |
| CX Intelligence: Topic Insights | Clusters closed conversations into topics/subtopics with counts and average CX; no rename yet. Beta, Pro/Business. | | SW/14166489 |
| CX Intelligence: Operator Insights | Weekly AI report per operator (Mon to Sun, updated Mondays): score, positive/negative counts, top strength, improvement area, week over week. | Pro/Business | SW/14166489 |
| AI Template Generator | "Enhance with AI" checks Meta quality guidelines and rewrites; English, Portuguese, Spanish only; Beta. | | SW/12059867 |
| Ask Wati AI | Natural-language assistant across inbox, contacts, campaigns, automations, agents, Instagram, settings; reads run immediately, any change needs approval. Beta. | | SW/16527975 |
| Wati AI Agents (background) | Scheduled analyzers: Automation Health Check (weekly), Campaign Readiness (daily), Segment/Contact Checker (weekly), Campaign Idea Finder (weekly), Spam Watcher (daily), Ready-to-Buy (hourly), Account Health (weekly); custom agents from plain text with editable name, instructions, model, schedule. Propose-only: nothing auto-applied. Limits: 1 active hourly agent, 30 runs per day (UTC reset). | Beta | SW/16527975 |

---

## 4. Connect AI Agents (bring your own agent)

Paid add-on, USD 100 per month (Astra users exempt, need Pro/Business) (SW/12320095). Register under Settings > User Management as a Custom AI Agent; it gets a dedicated access token and appears as an operator in Team Inbox. Inbound: your webhook URL receives Chat Assigned and Assigned Message Received events only for chats assigned to the agent. Outbound endpoints: sendSessionMessage, getContacts, updateContactAttributes, updateChatStatus, assignOperator (handoff), getMessages, getMedia. Gaps: payload schema, signature, retries, rate limits. Routes to it via assign actions, rules or the Custom AI Agent node.

---

## 5. Wati MCP server

- URL: `https://mcp.wati.io/mcp` (global), `https://eu-mcp.wati.io/mcp` (EU). Streamable HTTP, OAuth in browser, no API key; discovery at `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource`. Choose "Wati" or "Astra" at sign-in. Source: SW/14805217, https://docs.wati.io/reference/mcp.md.
- Works in Claude, ChatGPT, Meta Muse, Gemini CLI (SW/17594651). Needs Growth/Pro/Business (trial ok).
- Permissions: no OAuth scopes named; bounded by workspace role and underlying API permissions, plan (segments need Pro/Business), channel permissions, and separate rollout flags for Instagram comment and chatbot tools. 403 = permission issue. Agencies use limited accounts.
- 58 `wati_*` tools: workspaces (list/get/switch tenant); contacts and search (get, count, profile, search, upload, update attributes, assign teams, delete); conversations (get conversations/messages, send message, message status, send file via URL, send interactive, assign operator, update status, tags list/add/remove); templates, campaigns, credits (list/get template, send template dry run, send one/many, template performance, list/get campaign, retry failures, credit balance, estimate send cost); segments (create, list, get, evaluate, members); channels and webhooks (list channels, event types, subscribe, list/get/update/delete webhook); Instagram (list posts, get post, list comments, unread count, check permissions, reply to comment, private reply); chatbot (draft, upsert, create trigger, set trigger status); feedback. Astra tools (agents, knowledge, testing, voice, skills, integrations) appear only when Astra is linked.
- Safety behaviours: new triggers and rules created OFF; deletion not possible via chat; updating a rule re-saves whole rule (run counts may reset); real customer sends need review; rate limit guidance about 10 s wait (SW/17731713, SW/15900022).

---

## 6. WhatsApp Calling

Depends on Meta's WhatsApp Business Calling API (SW/12546668).
- Eligibility: messaging limit of at least 2,000 business-initiated conversations per rolling 24 h (FAQ says 1,000); not for Coexistence-onboarded numbers; business number from supported country. Business-initiated calls (BIC) unavailable in USA, Canada, Egypt, Vietnam, Nigeria; user-initiated calls (UIC) everywhere on Cloud API. Calls placed from Wati web only (mobile app has separate article SW/15518191).
- Permission model: need contact consent before BIC. Request as free-form during open service window or via call-permission template otherwise (utility template billed by Meta). Max 1 request per 24 h and 2 per 7 days (reset by a connected call). Approved permission usable immediately or within 7 days; decline means wait 24 h. Max 5 connected calls per 24 h after grant; 2 consecutive unanswered triggers an automatic reminder message; 4 consecutive unanswered revokes permission. Up to 1,000 concurrent inbound and 1,000 outbound per number. A Wati help article claims an inbound call counts as callback permission (Request Accepted view, SW/13696115) while the limits page says a UIC does NOT grant BIC permission; unresolved.
- Plan: Growth, Pro, Business enable calling; recording/transcripts Pro/Business (bundle table says Business). Enable in Team Inbox settings > Call; toggles "Allow customers to call" and "Allow auto permission requests" (auto request after a missed inbound call) (SW/12546695).
- Inbound UX: popup up to 3 simultaneous, all active operators/admins ring, first to accept connects; an operator on a call cannot take another. Outbound UX: "Call customer" after permission; temporary permission shows days left. Call logs Missed/All in inbox and in the chat. Availability toggle "Available to take calls" plus mute option (SW/13385068).
- Routing (SW/16616379): triggers "Incoming WhatsApp Call" (routing only), "Inbound WhatsApp Call Received", "Outbound WhatsApp Call Received" (post-call; filter Call Status Answered/Unanswered, plus contact attributes; actions include send message, start Astra agent). Targets: specific agent, team (round robin, optionally set contact owner), last assignee. Priority: active conversation assignee, then contact owner (Pro/Business), then rule. Away owner means call unanswered with no fallthrough. No business-hours handling documented. Contact-owner routing: SW/14276824 (unread).
- Billing: inbound free; outbound per connected minute from the Wati wallet; unconnected not charged; minimum balance INR 500 / USD 10 checked at call start; in-progress call can push balance negative (SW/12950760).
- Recording (SW/14472037, SW/15252330): auto-record toggle, manual record with pause/resume (stitched into one file), transcription (3 credits per call), summary (1 credit, requires transcript), 57 languages; storage first 1,000 min/month free, then USD 0.01 per minute. Recording page filters by type, operator, number, date; bulk export max 50; auto-delete retention setting. Meta's Calling API itself gives no recordings; Wati captures audio itself. Consent wording only "inform your contact".
- Analytics: total volume, outbound connected/attempted, inbound answered, missed, average duration, per-agent (SW/12698086).
- Templates: voice-call CTA button in templates; localized permission-request templates for campaigns (SW/13374598, SW/13374456 unread).
- Developer integration (SW/15203965, docs): webhooks New Inbound Call (callId, sdp, businessNumber), Terminate, New Outbound Call (SDP answer), Outbound Status, Call Permission; endpoints under `/api/v1/openapi/whatsapp/calls`: accept, permissions/{waid}, call-permission-request/{waid}, outbound-call/{waid}, terminate. So the customer app does WebRTC/SDP. Webhook must return 200 within 30 s, bearer auth sent. REST: call logs, recording, transcript, summary and batch variants (docs.wati.io calls_*). CRM logging for HubSpot and Zoho (SW/15841175, unread).
- Data: CallPermission (contact, status, expiry, request count windows), Call (id, direction, status, agent, duration, recording, transcript, summary), CallRouting rule.

---

## 7. WhatsApp Groups (Business plan) (SW/15957723, SW/16390325)

Needs OBA with blue badge; not Coexistence. Up to 1,000 groups per number and 7 external participants (operators uncapped). Invite-only: Wati sends an invite link (via group invite template in each contact's 1:1 chat); participants choose to join. Group conversation appears in inbox when an external member writes; 24 h service window applies to the whole group. Supports free-form in window, marketing and utility templates, quick replies, attachments. No authentication templates, no campaigns to groups, no edit/delete, no read marking, no hiding participants, no calls in groups. Billing from 1 Oct 2026: utility and free-form in-window billed per message after 1,000 free service conversations per month per WABA; marketing always billed; per delivered recipient by country rate. Settings: "Enable WhatsApp Groups", "Allow operators to create groups". API v3: POST `/conversations/groups` (channel, name, description, owner_email, operator_emails, contact_targets as phone/BSUID/ContactId, join_approval_mode), DELETE group, POST invites, DELETE participants, POST list (cursor `continuous_token`); 429 on rate limit; BSUID-only contacts fail on invites. No webhook documented.

---

## 8. WebChat (SW/16884887)

Growth/Pro/Business. Install via Channel Status > WebChat, copy script (manual, GTM, Lovable, Webflow, Shopify, WordPress, Trickle), do not host script on a CDN, disable/re-enable to update. Style editor (name, colour, branding, welcome message). Optional pre-chat lead form (title, subtitle, field placeholders, hide fields); submission shown next to the chat. Auto-creates "Default Team WebChat". Visitors become contacts with source WebChat; identity bound to browser/device (new browser or incognito = new conversation). Inbox treats it like any channel: assign, status Solved. Handoff to WhatsApp is NOT documented; message limits not documented. Astra also ships its own web widget with separate install guides (SW/12130596 and siblings) and agents only serve one channel each. Do not confuse the two web products.

---

## 9. WhatsApp usernames and BSUID (SW/15418392, SW/15418393)

- Meta rollout: phased from June 2026; reserve usernames from 29 June 2026 (needs messaging limit 2,000/day and quality). Username rules: 3 to 35 chars, English letters, digits, periods, underscores, at least one letter, no leading/trailing period, no consecutive periods, no "www." start, no domain-extension end, case-insensitive. Usernames not searchable; user must reach the business first.
- BSUID: `CC.` + up to 128 alphanumerics (e.g. `US.1349...`), unique per business portfolio, changes only if the user changes phone number. Use whole string untruncated. Phone number may be absent; previously captured phones remain valid.
- Wati contact model: contact may have no phone; BSUID stored automatically; inbox shows display name, username or BSUID; webhooks "BSUID-first" (`bsuid` always present, `waId` optional) for Message Received, New Contact Message, Session/Template Message Sent v1/v2, Chatbot Triggered, CTA Button Clicked, Call Status; duplicates merged when a phone appears later; returning hidden user after Meta's 30-day window re-linked by BSUID; "Request Contact Info" button in marketing/utility templates yields phone. Campaigns can target BSUID-only contacts; authentication templates (one-tap, zero-tap, copy-code) and SMS/RCS fallback do not work for them; manual import still requires phone; BSUID-only contacts do not sync to external CRMs; mobile app 3.43.0+ needed.

---

## 10. Additional channels

### 10.1 Instagram (SW/11463166 and siblings)
Needs Instagram Professional (Business or Creator) account, admin access; connect via Settings > Channels > Instagram with OAuth; Facebook page linkage not mentioned. One account on all plans, multiple only Business (SW/16979915). Features: DM inbox, comment inbox and replies, rules (first contact, after hours, keyword, chatbot), welcome/OOO, comment-to-DM (trigger new comment, keyword filter, scope all posts or one post/reel, send DM and optionally public reply; chatbot allowed only if it starts with an Instagram button template), story reply/reaction and mention automation (keyword filter only for replies; cannot target a single story), AI Assist to collect WhatsApp numbers into attributes (then WhatsApp campaigns), Astra agent for Instagram. Windows: automated replies within 24 h of last customer message; human operator up to 7 days; each new customer message restarts; expired chats cannot be messaged; blocked chats blocked. API: posts, comments, private reply endpoints (docs). Plans: advanced chatbot nodes and AI Assist Pro+; Topic/Operator insights Pro+.

### 10.2 Facebook Messenger (SW/11463637 and siblings)
Needs a Facebook Page, Messenger enabled, connecting account is Page admin. Inbox, welcome/OOO, keyword rules, chatbots (basic nodes), multiple accounts (SW/16298577, unread), page comment management and comment-to-DM (trigger new Facebook comment; match modes fuzzy / exact / contains; text DM only; optional public reply). Windows and plan: articles conflict (Growth+ vs all plans) and give no window details.

### 10.3 TikTok (SW/15701340, 16002595, 16800491, 13030997, 15700880)
- DM inbox: TikTok Business Account with Advanced Access and "allow everyone to message"; not available for accounts registered in US, EEA, Switzerland, UK, India. Growth+. Text, quick replies, images, shared posts, ad preview. Not supported: video, voice, stickers, interactive buttons (become text), broadcasts, starting a conversation, history import. Windows: first customer message allows up to 10 business messages in 48 h; customer reply reopens 48 h unlimited; if inactive over 48 h, up to 3 more until customer replies.
- Automation: only trigger "New TikTok message received" with at least one filter (working hours, chat status, known contact, keyword, segment); actions send text/image, start chatbot, route, update status, tags, update attribute; chatbots limited to text/images, questions, conditions, tags, assign, status, delay, webhook, Google Sheets. Working hours shared across channels.
- Ads: Click-to-WhatsApp via TikTok (Pro/Business, CTWA-CAPI add-on USD 100 per month, events Qualified Lead and Purchase with value/currency, chats tagged `T-CTWA`, attribute `tiktok_ad_id`); Click-to-TikTok DM ads (Pro/Business; events Lead, High Intent Conversation, Qualified Lead, Spam fired when mapped template is sent or agent marks spam; separate Event Sets; reporting log with Ad ID and Event Set ID). TikTok policy page: content must match ad, no sensitive-data requests, no impersonating TikTok, enforcement by TikTok.

### 10.4 RCS (SW/12538755 and siblings)
Beta; Growth/Pro/Business; enabled by contacting support; register brand (brand, company, compliance incl. privacy policy, contact person), review about 6 to 8 business days. India: Jio and Vi can create senders (Airtel/Jio/Vi reach). US marketing conditional (100k/month minimum noted), Brazil rules. Hard cap 7 RCS messages per contact per month. Template types: text (800 char shown), file, rich card, carousel; basic message 160 chars; rich up to 3,072; max 3 suggested replies per card; one link per message; Android 5+, iOS 18.1+. Campaign send/schedule to contacts or segments. SMS fallback exists per FAQ (not in campaign article). Inbox two-way handling not documented.

---

## 11. Implementation implications (what a clone must build)

Priority order, effort S/M/L/XL:

1. Unified conversation/contact core with channel adapters and BSUID-first identity (L). Entities: Contact(id, phone?, bsuid per WABA portfolio, username?, display_name, source_channel, owner_user_id, attrs jsonb, allow_campaign, merged_into); ContactIdentity(contact_id, channel, external_id, kind phone|bsuid|ig_scoped|fb_psid|tiktok_open_id|webchat_visitor); Conversation(channel, status, assignee_type bot|human|ai_agent, assignee_id, team_ids, window_expires_at, human_window_expires_at); Message. Reuse nothing LLM here. Must merge contacts when a phone appears later.
2. Rules engine + chatbot runtime (XL). Entities: Rule(trigger, filters, actions, priority, enabled), Chatbot(id, status, timer cfg, fallback cfg), ChatbotVersion(chatbot_id, version, graph jsonb, published), ChatbotSession(conversation_id, bot_version, current_node, vars jsonb, state started|ended|expired|blocked|reassigned, retries), SessionLog(node traversal). One-active-bot-per-contact-per-channel lock, priority resolution, timers/delays (needs durable scheduler, e.g. queue with delayed jobs). Interactive nodes need per-channel capability map (buttons 3x20, lists 10x24 on WhatsApp only).
3. Visual flow builder UI (XL): React Flow-style canvas, node config forms, validation (regex, number range, date), test-with-real-number, JSON import/export, per-node analytics overlay.
4. Chatbot analytics (M): derived from session tables (sessions, completed, dropped, reassigned, per-node counts, branch splits).
5. Webhook node, Sheets node, attribute/tag/assign/status nodes (M): outbound HTTP with templated body, JSON path mapper, status-code routing, timeouts (choose 10 to 30 s), SSRF protection.
6. AI Assist node and AI agents (L): LLM call with tool/function schema. Reuse Claude API: one agent loop with tools (send reply, update contact attribute, assign human, run action), knowledge retrieval (embeddings plus chunk store), structured output for lead score. Entities: AiAgent(channel, number, instructions_draft, instructions_published, voice cfg, model), KnowledgeSource(type, url/file, status, bytes), KnowledgeChunk(embedding), Action(template, intent, config, account_id, status), ConnectedAccount(provider, oauth tokens), AgentRun/Credit ledger(account, kind, credits, ts), Lead(score, category, criteria answers), EvalCase/EvalRun(category, expected, result, scores). Claude is directly usable for instruction authoring ("Vibe"), eval case generation, judge scoring, recommendation text.
7. AI credits metering and plans (M): ledger with plan allotment, rollover cap 2x, add-on expiry 1 month, consume expiring-first, alerts at 75/90/100, hard stop. Credit price table (1/3/8 per min) is configurable.
8. Inbox co-pilot features (M each, mostly S with LLM): reply suggestion, tone rewrite, grammar fix, summary (needs 10 message threshold), translation (store original + translated), CX score 1 to 5 stored as attribute, topic clustering (embeddings + LLM labeling), operator weekly report job, template improver. All reusable with Claude; keep PII scrubbing for suggestions.
9. WhatsApp Calling (XL): WebRTC media path, SDP offer/answer handling with Meta Calling API, call permission state machine (request counters per 24 h/7 days, 5-call cap, revocation after 4 unanswered), browser softphone UI, ringing to many operators with first-accept, routing rules, recording with pause/stitch, ASR transcription (any STT) and LLM summary, billing per connected minute with wallet minimum balance. Voice AI agent on calls adds realtime STT/TTS/LLM (XL on top); Meta delivers audio only via WebRTC so recording must be self-built.
10. Instagram and Messenger channels (L): OAuth, webhooks, 24 h vs 7 day window enforcement, comment inbox, comment-to-DM and story automations.
11. TikTok DM + ads events (L): Business Messaging API, the 10/48h-style send budget tracker, conversion event posting (Lead, Qualified Lead, Purchase) and spam events; region gating.
12. RCS (L, partner dependent): needs an RCS aggregator, brand registration workflow, template types, per-contact monthly cap counter.
13. WebChat widget (M): embeddable JS, visitor cookie identity, pre-chat form, routing team; optional WhatsApp handoff is your own design (not specified by WATI).
14. Groups (M, Business tier): Groups API calls plus group conversation model (participants, invite state, 1,000/7 limits, group-level window).
15. MCP server (M): OAuth 2 plus Streamable HTTP MCP exposing contacts/conversations/templates/segments/chatbots/webhooks tools; per-region endpoints; write tools default-off and confirm-first; reuse your internal API. Needs per-tenant authorization mapped to roles.
16. Connect-your-own-agent webhooks + public API with tokens (M).

---

## 12. Details that are easy to get wrong

- Variable syntax differs: `@var` (session, cleared at end) vs `{{attr}}` (persistent). Do not conflate.
- AI agent nodes are terminal; nothing placed after them runs. Return-to-flow is not supported.
- Only one bot per contact per channel; blocking is per channel. Rule priority picks one bot start while other rule actions still run.
- Assigning to a team ends the bot (smart escalation); needs an ACTIVE human, bots do not count.
- Buttons/Lists exist only for WhatsApp interactive messages; Instagram/Messenger lack them, and comment-to-DM chatbots must start with an Instagram button template.
- Question node: answer variants are numbered text replies; media accepts docs/images/videos but not audio/voice notes; Smart Escalation skips free-text and validated nodes.
- Max two conditions per condition node; no explicit else.
- Timer 2 must be at least one minute shorter than Timer 1; docs disagree on when the reminder appears.
- Instagram windows: 24 h automated vs 7 days human; delays longer than 24 h break later bot messages.
- TikTok: 10 messages in first 48 h, unlimited after a reply, only 3 more if inactive; no broadcasts; regional exclusions.
- Calling: BIC needs permission; 1/24h and 2/7d request caps; 5 connected calls/24h; 2 and 4 unanswered rules; BIC banned in US/Canada/Egypt/Vietnam/Nigeria; inbound calls free, outbound billed per connected minute; no Coexistence; Astra voice calls are not recordable.
- Credits: three different credit systems (Wati AI co-pilot credits, Astra credits, calling transcription credits drawn from Wati AI credits plus wallet storage fees). Astra rollover cap 2x allotment; add-on credits expire in a month.
- BSUID: per business portfolio, keep whole string, auth templates still need a phone, SMS/RCS fallback impossible without phone, campaigns can include BSUID-only contacts, CRM sync of BSUID-only contacts missing.
- Groups: max 7 external participants, invite-only, window is group-wide, Business plan, no campaigns, no Coexistence, billing starts 1 Oct 2026.
- RCS hard cap of 7 messages per contact per month during beta.
- Webchat identity is per browser; Astra web widget is a different product with its own install.
- Import/export of chatbots drops media, templates, assignments, Sheets links and Trigger Chatbot targets.
- MCP: new triggers/rules created disabled, no deletes, whole-rule re-save resets run counts.

---

## 13. Unverified or unclear

- Chatbot Catalog node and Forms node behaviour: nodes guide lists "Catalog" as a Pro/Business group but no article describes it (SW/11463029). No "forms" node in the builder; forms exist only in Astra (SW/14665717).
- Ad-click and scheduled-time chatbot triggers: no chatbot-trigger article found; CTWA collection (collection 13040159) was not read.
- Chatbot count limits: SW/11463045 contradicts itself (25 vs unlimited vs 2).
- Chatbot publish/draft model and version history UI: not in SW/13934658 or SW/11463032; versions only implied in analytics and MCP articles.
- Webhook node timeout, retry and size limits: SW/11463025. Trigger Chatbot return/loop behaviour: SW/11463049. Time Delay: SW/11463035 gives no range (1 s to 10 min came from SW/11463045).
- Condition node else-path: SW/11463038.
- Smart Escalation detection method and what context the operator sees: SW/17224772. Handoff-back from AI agent to flow: SW/15186551.
- Custom AI agent webhook payload schema, signature, rate limits: SW/12320095.
- Astra: model/provider, language list, size limits per file, exact eval scoring, scoring formula for leads, Astra API endpoints, dollar prices (SW/11757585, SW/17565154, product page). Voice plan tier conflict (Pro in voice article vs Business in bundle table). Standalone vs bundle plan tables differ. Astra analytics articles (SW/15444557 etc.), REST action setup/auth/payload articles, WhatsApp-specific Astra actions, SMS and RCS deployment claims were not read.
- Wati AI: general Conversation Summary cost, Ask Wati AI credit cost, AI Editor supported languages (SW/12829730, SW/16527975, SW/13557513).
- MCP: OAuth scopes not named (docs.wati.io/reference/mcp.md); rate limits; Astra tool names.
- Calling: eligibility threshold 2,000 vs 1,000; whether inbound call grants callback permission (SW/13696115 vs SW/12546668); per-minute rates; recording consent flow, retention defaults, formats; SW/15518191, SW/16969071, SW/14276824, SW/13374456, SW/15841175 (mobile, contact owner routing, localized permission templates, CRM logging) not read; call webhooks other than inbound payload fields (SW/15203965). Meta's own docs not consulted, so Meta limits are as reported by WATI.
- Groups: webhooks, join_approval_mode values, group invite template content (SW/16390325).
- WebChat: WhatsApp handoff, message limits, behaviour offline (SW/16884887).
- Usernames/BSUID: pilot countries, GA date, webhook payload schema, contact-book detail (SW/15418392).
- Instagram: required permissions list, supported message types (SW/11463169, SW/11463164). Messenger: windows, plan (SW/11463637). RCS: inbox reply handling, SMS fallback in campaigns, pricing (SW/12538755, SW/12538877).
- docs.wati.io sidebar not listable; only llms.txt index and the MCP page read. Chatbot, calls, Instagram, conversation endpoint pages exist by title only (not opened).
- Marketing statistics on wati.io (16,000+ businesses, 99% satisfaction) are unverified claims.
