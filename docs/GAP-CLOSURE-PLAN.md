# Gap closure plan (from docs/FEATURE-AUDIT.md)

Date: 2026-10-27. Goal: close every MUST gap from the completeness audit and the feasible SHOULD gaps, then verify with Playwright UAT and redeploy.

## Decisions

- **No prepaid wallet.** Customers pay Meta for WhatsApp messages directly (their payment method in WhatsApp Manager). Wallet, ledger and top-up items from the competitor research are deliberately out of scope. Cost estimates use a configurable rate card (super admin), never invented prices.
- **BSUID (WhatsApp usernames)** changes the contact model (phone becomes optional) and touches many files. It runs as its own phase AFTER the parallel groups, as a single owner, then is reviewed.
- **Instagram, Messenger and web chat channels** need Meta App Review for new permissions and a nullable conversation number model. They are Phase C after launch and are not part of this closure.
- **Schema** for this program is already migrated (0006_gap_closure): Team, TeamMember, Segment, ConversationMark, SavedInboxFilter, ReplyMaterial, RuleExecution, Contact.bsuid/username/waId/ownerUserId/leadStage, Conversation.teamId/lastAgentReplyAt/firstAgentReplyAt, AutomationRule v2 columns (version, priority, trigger, filters, actions, stopAfterMatch), Broadcast.audienceFilter/variableMap/missingValuePolicy, Plan.scheduledPostLimit/connectedChannelLimit, Template.headerMedia. Agents do not edit the schema; extra needs go to docs/schema-requests.md.

## Groups (parallel), each reviewed by two skeptics then repaired

| Group | Scope |
|---|---|
| inbox | New chat from the inbox (phone or contact, template picker), message-text search with last-4 digits, outbound document/audio/sticker attachments via Meta media upload with WhatsApp size limits, STOP confirmation and START resubscribe, mark as unread and unread line, favourites, saved filters, quick-reply variables, @mentions in notes, per-chat export, deep links, agent signature option, status model (New, Campaign labels) |
| teams-routing | Teams and default team, team-based assignment, last-assignee routing, auto-reassign on no agent response, view-only-assigned permission, phone masking option, conversation firstAgentReplyAt and response-time metrics |
| automation-v2 | Rules v2: triggers (message received, no customer response, schedule, contact created, tag or attribute changed), filters with AND/OR groups, actions (send text/template/media/reply material, assign/route, start chatbot, start AI agent, update attribute, tag, set status, notify, start lead sequence), priority, all-matching mode, suppression, holiday mode, execution log and metering, reply materials, a plain When-If-Then builder, migration of old three-type rules |
| campaigns | Audience filter stacks and segments, template variable mapping from attributes with missing-value policy, personalised media headers and URL-button variables, template header media upload, tier throttling per business portfolio on a rolling 24 h window, cost estimate from a configurable rate card with super admin editor, template pause handling, retry caps, consent records |
| chatbots | Real WhatsApp interactive messages for buttons and lists, template node, assign/status/handoff nodes with teams, triggers with priority per number, manual start from the inbox, one bot or AI agent per contact and no bot on human-assigned chats, smart escalation, builder additions |
| growth-limits | AI credit metering with plan allotment and alerts, enforce AI credits for Creative Studio, enforce ad account, scheduled post and channel limits through billing limits, image provider adapter, use creatives as multiple ads for A/B tests, optimiser approved to applied flow, lead routing, conversions with ctwa_clid, permission-versus-code alignment |
| api-roles | Compat API parity gaps, any-of scopes, OpenAPI document, role change UI and API, messaging limit tiers per business portfolio, trial reminders and read-only lock checks |
| platform-saas | Email verification completeness, Razorpay subscription flow completeness, GST invoices and print view, lifecycle emails, reports and exports (CSV and JSON), personal-data export, extended smoke test |
| prod-ops | Reconnect and re-authorise flow, business token expiry handling, near-real-time worker daemon with pm2 definition, opt-in gating everywhere marketing is sent, alerting scripts, backup restore verification, App Review and dashboard readiness docs |

## After the groups

1. BSUID phase (single owner): nullable phone, bsuid identity, inbound ingest, outbound addressing, merge, API and export, display.
2. Rebuild, Playwright UAT round 2 (all seven areas), developer fixes, retest.
3. Release (script: scratchpad deploy_wa_release.py; migrations 0005 and 0006 by marker), seed demo workspace, live verification.
