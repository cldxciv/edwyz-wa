# Phase 2 contracts (read with docs/AGENT-BRIEF.md and docs/PLATFORM-PLAN.md)

Schema is already migrated (0004_phase2) and the client generated: Chatbot, ChatbotSession, RoutingConfig, AgentAvailability, Conversation.assignedAt/statusChangedAt, Broadcast.retryDays, BroadcastRecipient.attempts/retryAfter. Do not edit the schema; request changes in `docs/schema-requests.md`.

Rules added for this phase: functional parity with commercial WhatsApp inbox tools is the goal, but write everything independently. No copied names, text, icons or screenshots from any competitor.

## Conversation statuses (owner: inbox agent)

`Conversation.status` is one of `open | pending | solved | expired | blocked` (string). `open` = being handled, `pending` = waiting on the customer or on an agent, `solved` = closed by an agent, `expired` = the 24h window lapsed with no agent reply (derived, never stored unless the worker sets it), `blocked` = contact blocked. Set `statusChangedAt` whenever the status changes. A new inbound message on a `solved` conversation reopens it (`open`).

## Chatbot flow JSON (owner: chatbot-engine agent; builder UI consumes it)

```
{ "version": 1, "start": "<nodeId>", "nodes": [Node], "edges": [{ "id": "...", "from": "<nodeId>", "to": "<nodeId>", "label"?: "<handle>" }] }
```
Node = `{ id, type, position: {x, y}, data }`. Types and `data`:
- `send_text`: `{ text }` ({{variable}} placeholders allowed)
- `send_buttons`: `{ text, buttons: [{ id, title }] }` (max 3, title max 20). Outgoing edges use `label` = button id.
- `send_list`: `{ text, buttonLabel, rows: [{ id, title, description? }] }` (max 10 rows). Edges labelled by row id.
- `send_template`: `{ templateId, variables: { "1": "..." } }`
- `ask`: `{ text, variable, validate: "text"|"number"|"email"|"phone"|"choice", retryText?, maxRetries }` waits for the customer's reply, stores it in `variables[variable]`.
- `condition`: `{ variable, operator: "equals"|"contains"|"not_equals"|"exists"|"gt"|"lt", value }` with edges labelled `yes` and `no`.
- `set_attribute`: `{ attribute, value }` (writes Contact.attributes)
- `add_tag` / `remove_tag`: `{ tag }`
- `delay`: `{ minutes }` (1 to 10080)
- `webhook`: `{ url, method: "GET"|"POST", bodyTemplate?, saveAs? }` server-side call; SSRF-safe (use `src/lib/net` helpers), 5 s timeout, response stored in `variables[saveAs]`.
- `assign`: `{ userId | "round_robin" }`
- `set_status`: `{ status: "open"|"pending"|"solved" }`
- `handoff`: `{ message? }` ends the bot, sets status `open`, triggers routing.
- `end`: `{}`

Limits: max 100 nodes, 200 edges, text 1024 chars, one `start` node. Validation lives in `src/lib/chatbots/flow.ts` (engine agent) and the builder UI imports the exported types and `validateFlow` from there.

## Engine hook points

- `src/lib/chatbots/index.ts` exports `handleInboundForChatbots(input: { tenantId, phoneNumberId, conversationId, contactId, text, receivedAt }): Promise<boolean>`. Returns true when a bot consumed the message (the automation engine must then skip its auto-replies). Resumes a `waiting` session first; otherwise starts a published chatbot whose trigger matches. The coordinator wires this into `src/lib/webhooks/processor.ts`; the engine agent must not edit that file.
- `startChatbot(actor | {tenantId}, chatbotId, conversationId)` for manual starts and rule actions.
- Free-form bot messages only inside the 24h window (use `src/lib/inbox` send functions, which already enforce it). Loop guard: at most 20 outbound bot messages per session per minute.

## Routing hook points (owner: routing agent)

- `src/lib/routing/index.ts` exports `assignConversation(tenantId: string, conversationId: string): Promise<{ assignedToId: string | null; reason: string }>` (no-op when `autoAssign` is false or the conversation is already assigned), `isWithinWorkingHours(config, at)`, `pickAgent(...)` (pure, unit-tested). Coordinator wires `assignConversation` on new/reopened conversations and on bot handoff.

## Realtime (owner: inbox agent)

`GET /api/inbox/stream` Server-Sent Events: authenticated through `getActor`; sends `event: update` with `{ conversationIds: [...] }` when conversations or messages change for the tenant (poll the database every 2 s server-side, per connection, tenant-scoped, with a hard cap on connections per tenant and a max connection lifetime of 5 minutes so the client reconnects). The client falls back to polling when SSE fails.

## Ownership (no overlaps)

| Agent | Owns |
|---|---|
| chatbot-engine | `src/lib/chatbots/**`, `src/app/api/chatbots/**`, `tests/chatbots*.test.ts` |
| chatbot-builder-ui | `src/components/chatbots/**`, `src/app/(app)/app/automation/chatbots/**`, `tests/chatbot-builder*.test.ts` |
| routing | `src/lib/routing/**`, `src/app/api/routing/**`, `src/components/routing/**`, `src/app/(app)/app/settings/routing/**`, `tests/routing*.test.ts` |
| inbox-realtime | `src/app/api/inbox/**` (new routes: stream, status), `src/lib/inbox/status.ts`, `src/lib/inbox/stream.ts`, `src/components/inbox/**`, `tests/inbox-*.test.ts` |
| campaigns | `src/lib/broadcasts/**`, `src/app/api/broadcasts/**`, `src/components/broadcasts/**`, `src/app/(app)/app/broadcasts/**`, `tests/broadcasts*.test.ts`, `tests/campaign*.test.ts` |
| legal-pages | `src/app/(site)/privacy/**`, `terms/**`, `data-deletion/**`, `src/lib/legal.ts`, `tests/legal*.test.ts` |

Nav links, webhook wiring, worker registration in `src/worker/registry.ts` and migrations are done by the coordinator after the agents report. Each agent exports `worker` from its own `src/lib/<area>/worker.ts` where it needs background work.
